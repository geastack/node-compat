// node-compat as a geatsc plugin.
//
// The plugin seam is deliberately narrow: a plugin says which ambient names its
// host owns and what C++ each one is, and the compiler derives everything else
// from the program's own types. That works here because the native layer this
// host exposes was already written in the carriers the compiler emits --
// `gea::node::net_write(double, ...)`, `__gea_http_write(double, std::string)`
// -- so there is nothing to translate between the two sides, only a table
// saying which symbol a name is.
//
// That table lives in `./intrinsics.mjs` rather than here: it is the one
// authority on which C++ symbol each `__gea_node_*` name is, and a second copy
// would be free to drift from the runtime it names. What this file adds on top:
//
//  - `queueMicrotask`. The compiler's runtime has no microtask queue at all --
//    a queue being a host's concern rather than the language's -- so the one
//    the node reactor already owns is the honest thing to point at.
//  - `hostPreambles`. Per-symbol `extern` declarations, asked for by spelling,
//    so one include of the runtime's own header answers all of them.
import { noPluginCapabilities } from '@geastack/compiler/plugin'
import { intrinsics } from './intrinsics.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveBuiltinModules } from '../scripts/builtin-modules.mjs'

/**
 * The header a unit includes before it may name one of these spellings.
 *
 * One line for every host function rather than a per-symbol `extern`: the
 * declarations already exist, written next to the runtime that defines them,
 * and re-deriving them here would be a second declaration of each symbol free
 * to disagree with the first. `hostPreambles` dedupes, so a unit that calls
 * twenty of these carries the include once.
 */
const runtimeHeader = '#include "gea_node.hpp"'

// Buffer's byte storage is Uint8Array's, but its method declarations belong
// to node:buffer. Resolve those declarations so ordinary Uint8Arrays retain
// their own prototype behavior.
const bufferMethods = [
  'toString',
  'write',
  'copy',
  'readUInt8',
  'readInt32LE',
  'readUInt32LE',
  'writeUInt8',
  'writeInt32LE',
  'writeUInt32LE',
  'equals',
  'compare',
  'slice',
  'subarray',
  'swap32'
]
// Buffer's override also implements the inherited zero-argument signature.
// Anchor that coverage to Buffer's own declaration; claiming Uint8Array's
// method globally would incorrectly give every ordinary byte view Node's API.
const compilerRequire = createRequire(import.meta.resolve('@geastack/compiler/plugin'))
const nodeModuleDeclarations = compilerRequire.resolve('@types/node/module.d.ts')
const bufferMethodBinding = (member) => ({
  protocol: 'node:Buffer',
  member,
  ...(member === 'toString'
    ? {
        inheritedDeclarations: [
          { declarationFileName: compilerRequire.resolve('typescript/lib/lib.es5.d.ts'), owner: 'Uint8Array', member }
        ]
      }
    : {})
})
const bufferDeclarations = fileURLToPath(new URL('../runtime/node/buffer-types.ts', import.meta.url))
// BSON describes the subset of Node's Buffer surface it uses as a local
// structural type (`NodeJsBuffer` in `src/utils/node_byte_utils.ts`), which
// used to be bound here so the package could stay unmodified while the host
// boundary remained declaration-owned.
//
// That binding is GONE, and cannot be restored at this layer. The compiler
// matches a binding by the ABSOLUTE file name of the declaration
// (`resolveHostMethod`: `bindings.get(declaration.getSourceFile().fileName)`),
// and the key here was the checked-in `vendored-sources/bson` path. BSON's
// source is now acquired per installed version into
// `node_modules/.cache/geatsc/sources/<hash>/<hash>`, a path that differs per
// application and per version, and this factory takes no arguments, so it
// cannot know it. Restoring it needs the binding table to be keyed by
// something stable -- a package-relative declaration path -- rather than by an
// absolute file name. Until then a BSON/MongoDB program loses these six
// methods' native binding; Hono and raw `node:http` are unaffected.
const bufferMethodBindings = new Map([
  [bufferDeclarations, new Map(bufferMethods.map((member) => [`Buffer.${member}`, bufferMethodBinding(member)]))]
])
const bufferHostMembers = new Map(
  bufferMethods.map((member) => [
    `node:Buffer.${member}`,
    {
      kind: 'method',
      arity: 'pass-through',
      ...(member === 'swap32' ? { receiver: 'raw' } : {}),
      emit: `[&](auto&&... args) { return gea::node::buffer::${member}({receiver}, std::forward<decltype(args)>(args)...); }({args})`
    }
  ])
)

const processCarrier = 'gea::node::Process'
const processHrTimeCarrier = 'gea::node::ProcessHrTime'
const processVersionsCarrier = 'gea::node::ProcessVersions'
const processWriteStreamCarrier = 'gea::node::ProcessWriteStream'
const processDeclarations = fileURLToPath(new URL('../runtime/node/node-globals.ts', import.meta.url))
const runtimeNodeDirectory = fileURLToPath(new URL('../runtime/node', import.meta.url))
const generatedFacadeDirectory = fileURLToPath(new URL('../runtime/node/generated/facades', import.meta.url))

// This is the same source registry the build driver uses to resolve node: imports. It
// supplies canonical names only for modules this target can compile; the
// compiler uses those names to register already-resolved CommonJS records,
// never to turn an arbitrary runtime string into a filesystem lookup.
const builtinModuleSources = () =>
  new Map(
    [...resolveBuiltinModules(runtimeNodeDirectory, generatedFacadeDirectory).entries()]
      // A generated facade is declaration coverage with a throwing body, not a
      // runtime capability. `getBuiltinModule` must report it unavailable.
      .filter(([, source]) => !source.startsWith(`${generatedFacadeDirectory}/`))
  )

const builtinModuleRegistry = (sources = builtinModuleSources()) =>
  new Map(
    [...sources.keys()].flatMap((name) => [
      [name, name],
      [`node:${name}`, name]
    ])
  )

// These rows are deliberately only the process surface Fastify's reachable
// production modules exercise. A missing row is a compiler refusal, not a
// dynamic property fallback or a promise the runtime cannot keep.
const processHostMembers = new Map([
  [`${processCarrier}.env`, { kind: 'property', emit: 'gea::node::process::env()', store: null }],
  [`${processCarrier}.pid`, { kind: 'property', emit: '__gea_node_process_pid()', store: null }],
  [`${processCarrier}.ppid`, { kind: 'property', emit: '__gea_node_process_ppid()', store: null }],
  [`${processCarrier}.argv`, { kind: 'property', emit: 'gea::node::process::argv()', store: null }],
  [`${processCarrier}.execArgv`, { kind: 'property', emit: 'gea::node::process::exec_argv()', store: null }],
  [`${processCarrier}.stdout`, { kind: 'property', emit: 'gea::node::process::stdout', store: null }],
  [`${processCarrier}.stderr`, { kind: 'property', emit: 'gea::node::process::stderr', store: null }],
  [`${processCarrier}.versions`, { kind: 'property', emit: 'gea::node::process::versions', store: null }],
  [
    `${processCarrier}.hrtime`,
    {
      kind: 'property',
      emit: 'gea::node::process::hrtime_facade',
      store: null
    }
  ],
  [
    `${processCarrier}.nextTick`,
    {
      kind: 'method',
      arity: 'pass-through',
      emit: 'gea::node::process::next_tick({args})'
    }
  ],
  [
    `${processCarrier}.getBuiltinModule`,
    {
      kind: 'method',
      arity: 1,
      emit: 'gea::node::process::get_builtin_module({arg0})',
      result: 'dynamic'
    }
  ],
  [`${processCarrier}.cwd`, { kind: 'method', arity: 0, emit: 'gea::node::process::cwd()' }],
  [
    `${processCarrier}.exit`,
    {
      kind: 'method',
      arity: 'pass-through',
      emit: 'gea::node::process::exit({args})'
    }
  ],
  [
    `${processCarrier}.on`,
    {
      kind: 'method',
      arity: 2,
      emit: 'gea::node::process::on({arg0}, {arg1})'
    }
  ],
  [
    `${processCarrier}.removeListener`,
    {
      kind: 'method',
      arity: 2,
      emit: 'gea::node::process::remove_listener({arg0}, {arg1})'
    }
  ],
  [
    `${processHrTimeCarrier}.bigint`,
    {
      kind: 'property',
      emit: 'gea::node::process::hrtime_bigint_callable',
      store: null
    }
  ],
  [
    `${processVersionsCarrier}.node`,
    {
      kind: 'property',
      emit: 'gea::node::process::version_node()',
      store: null
    }
  ],
  [`${processWriteStreamCarrier}.fd`, { kind: 'property', emit: '{receiver}.fd', store: null }]
])

// This row is separate from the generic member table because it authenticates
// the compiler-side retention edge for literal lookups.  It does not turn a
// dynamic string into a source import; C++ still queries the runtime registry.
const processBuiltinModuleMethodBindings = new Map([
  [
    processDeclarations,
    new Map([
      [
        'Process.getBuiltinModule',
        {
          protocol: processCarrier,
          member: 'getBuiltinModule',
          builtinModuleLookup: true
        }
      ]
    ])
  ]
])

const processHostInvocations = new Map([[`${processHrTimeCarrier}.call`, { emit: 'gea::node::process::hrtime()', arity: 0 }]])

/**
 * The microtask queue, which is the reactor's and not the language's.
 *
 * `queueMicrotask` is a global in `lib.dom.d.ts`, so with no claim here v2
 * places it as an ordinary external cell and the unit emits
 * `extern gea::CallableObject<void(...)> queueMicrotask;` -- a symbol nothing
 * defines, and the failure lands in the linker rather than in the compiler.
 * `runtime/node/http.ts` calls it on the request path, so this is not an
 * optional row.
 */
const nodeOnlyHostFunctions = new Map([
  ['queueMicrotask', 'gea::node::queue_microtask'],
  ['__gea_node_crypto_validate', 'gea::node::crypto::validate'],
  ['__gea_node_crypto_digest', 'gea::node::crypto::digest'],
  ['__gea_node_crypto_hmac', 'gea::node::crypto::hmac'],
  ['__gea_node_crypto_pbkdf2', 'gea::node::crypto::pbkdf2'],
  ['__gea_node_crypto_timing_safe_equal', 'gea::node::crypto::timingSafeEqual'],
  ['__gea_node_crypto_get_fips', 'gea::node::crypto::getFips']
])

/**
 * The host's namespace roots: names that are PATHS, not cells.
 *
 * `Buffer` is the case that made the distinction matter. `Buffer` in node is one object that is both callable and a namespace of
 * statics, and only the second half is reachable: `new Buffer(...)` has been
 * deprecated since node 6 and nothing in the libraries this target compiles
 * uses it. So the honest claim is `hostNamespaces` -- which is what the
 * compiler needs anyway, because a namespace is a PATH and a value is a CELL.
 * With no claim at all the constructor object is a value the program holds, and
 * `BufferConstructor`'s eight declared signatures collapse to one callable
 * carrier: reading `.from` off THAT is
 * `property-access:function-value-dispatch:get:false`, which is exactly what
 * every one of these calls refused as (66 rows on the mongodb CMAP probe, and
 * the probe's largest single family).
 *
 * The TYPE `Buffer` is unaffected and stays where it belongs: an interface
 * extending `Uint8Array<ArrayBuffer>` (`runtime/node/buffer-types.ts`), carried
 * as `gea::TypedArray<std::uint8_t>`. Claiming the name as a namespace claims
 * the VALUE only, so the two halves of what node calls `Buffer` are answered by
 * the two mechanisms that fit them.
 *
 * `isBuffer` is stated here like the rest even though its declared form is a
 * type predicate: the predicate is the CHECKER's business (it narrows the
 * argument at the call site and needs no host support to do it), and what the
 * host owes is only the boolean.
 */
const namespaceMethods = {
  Buffer: {
    from: 'gea::node::buffer::from',
    alloc: 'gea::node::buffer::alloc',
    allocUnsafe: 'gea::node::buffer::allocUnsafe',
    concat: 'gea::node::buffer::concat',
    byteLength: 'gea::node::buffer::byteLength',
    isBuffer: 'gea::node::buffer::isBuffer'
  },
  // `performance.now()` and nothing else. `runtime/node/node-globals.ts`
  // declares the interface at exactly this width for the reason stated there:
  // a member declared and not answered here compiles to a symbol nothing
  // defines, so the two tables are written to agree by being the same size.
  performance: {
    now: 'gea::node::performance::now'
  }
}

/**
 * What carries each namespace ROOT.
 *
 * A `hostNamespaces` claim alone is not enough. `semantics/host-protocols.ts`
 * records a root's carrier ONLY from `hostNamespaceRootTypes`, and with no row
 * the root falls through to its structural answer -- for `Buffer` that is
 * `BufferConstructor`, whose eight declared signatures collapse to one callable
 * carrier, and reading a member off THAT is
 * `property-access:function-value-dispatch:get:false`. Measured on the mongodb
 * CMAP probe: the namespace claim without this table moved 66 rows to 53; with
 * it, the receiver is a `native-record-ref` and the access certifies.
 *
 * The facades are empty structs. Nothing is ever read out of the object a
 * namespace root names -- the members are PATHS, resolved at the call -- so the
 * type exists only to give the root a carrier that is not a callable.
 */
const namespaceRootTypes = new Map([
  ['Buffer', 'gea::node::BufferFacade'],
  ['performance', 'gea::node::PerformanceFacade']
])

/**
 * The host's own `[[HasInstance]]` for each namespace root that has one.
 *
 * `Buffer` is a path here, not a materialized constructor object, so 13.10.2
 * has no prototype chain to walk and `x instanceof Buffer` refused by name --
 * in `@hono/node-server`'s `request.ts`, twice, over real live code. Node
 * documents `Buffer.isBuffer` as exactly that test, and the native
 * implementation is a brand read rather than a structural guess: a byte view
 * only answers `true` when a Buffer factory attached the opaque host brand, so
 * a plain `Uint8Array` answers `false` the way the language does. The compiler
 * applies it per leaf carrier, so every overload the runtime declares --
 * including the catch-all that answers `false` for a carrier no Buffer could
 * ever be -- is reachable.
 */
const namespaceInstanceTests = new Map([['gea::node::BufferFacade', 'gea::node::buffer::isBuffer']])

const hostNamespaces = () => ({
  roots: new Set(Object.keys(namespaceMethods)),
  // A namespace path's facade carrier exists only for member resolution, so
  // it cannot answer JavaScript's `typeof`. Buffer's value is also Node's
  // callable constructor object; performance is an ordinary singleton object.
  typeofs: new Map([
    ['Buffer', 'function'],
    ['performance', 'object']
  ]),
  methods: new Map(
    Object.entries(namespaceMethods).flatMap(([root, members]) =>
      Object.entries(members).map(([member, text]) => [`${root}.${member}`, { kind: 'path', text }])
    )
  ),
  // BSON distinguishes Node's native global Buffer from the npm `buffer`
  // polyfill by reading `Buffer.prototype?._isBuffer`. The native facade is a
  // namespace path rather than a materialized constructor object, and its
  // prototype deliberately has no such marker. State the complete leaf path
  // so the compiler keeps `Buffer.prototype` as a namespace segment and
  // publishes the property's real optional-boolean absence directly.
  properties: new Map([['Buffer.prototype._isBuffer', 'gea::Optional<bool>{}']]),
  propertySetters: new Map()
})

/**
 * v1 rows whose NAME is not a host name here.
 *
 * `intrinsics` keys the four bare timer globals -- `setTimeout`,
 * `setInterval`, `clearTimeout`, `clearInterval` -- straight onto
 * `__gea_node_set_timeout`/`__gea_node_clear_timer`, an older protocol in which
 * the global WAS the host call. It is not this one. `runtime/node/timers.ts` is
 * the implementation now -- it returns a real `Timeout` object (Node's
 * `.unref()`/`.hasRef()`, which `@hono/node-server`'s `listener.ts` calls as
 * `timer.unref?.()`), defaults the delay, and wraps the callback so the host
 * symbol keeps its narrow `() => void` arity -- and it reaches the reactor
 * through the `__gea_node_timer_*` names, which stay claimed below.
 *
 * Claiming the bare names as well made the compiler emit the host call for
 * `setTimeout(...)` while TypeScript still typed the expression as
 * `timers.ts`'s `Timeout`: `v13 = __gea_node_set_timeout((b5))` assigned into
 * a `Ref<gea_class_decl_f127_37>`, and `__gea_node_clear_timer` handed a
 * `Timeout | number` union to a `double` parameter -- nine clang errors in
 * hono-hello from one disagreement between the table and the source.
 */
const v1OnlyIntrinsicNames = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'])

const hostFunctions = () =>
  new Map([
    ...Object.entries(intrinsics)
      .filter(([name]) => !v1OnlyIntrinsicNames.has(name))
      .map(([name, spec]) => [name, spec.emit]),
    ...nodeOnlyHostFunctions
  ])

const hostPreambles = () =>
  new Map(
    [
      ...hostFunctions().values(),
      ...[...hostNamespaces().methods.values()].map((spelling) => spelling.text),
      ...[...bufferHostMembers.values()].map((member) => member.emit),
      ...[...processHostMembers.values()].map((member) => member.emit),
      ...[...processHostInvocations.values()].map((invocation) => invocation.emit)
    ].map((spelling) => [
      spelling,
      spelling.startsWith('gea::node::crypto::') ? [runtimeHeader, '#include "gea_node_crypto.hpp"'] : [runtimeHeader]
    ])
  )

/**
 * node-compat's native layer, as a geatsc plugin.
 *
 * Data only. Nothing about `node:http` is a language form: the builtins are
 * ordinary TypeScript (`runtime/node/*.ts`) calling ambient functions, and the
 * core compiles them as such the moment it knows which functions those are. So
 * there is no producer and no lowering here -- adding either would mean this
 * compiler knowing what a socket is, which is exactly what the seam exists to
 * avoid.
 */
export function geatscNodePlugin() {
  return {
    name: 'node-compat',
    instantiate: () => ({
      producers: () => [],
      lower: () => false,
      capabilities: {
        // The compiler's own empty capabilities first, then this host's claims.
        //
        // The contract is the compiler's (`plugins/model.ts`'s
        // `PluginCapabilities`) and every table it names has to be PRESENT --
        // `compile` spreads each one -- so restating the empty ones here
        // spelled that contract a second time, in a file that cannot
        // typecheck against it. Each table the compiler then gained
        // (`hostConstantsByDeclaration`, `hostNamespaceRootsByDeclaration`)
        // broke this host at run time with a `not iterable` from inside
        // `compile`. Spreading `noPluginCapabilities` means this file states
        // only what node-compat actually claims, and the empties it used to
        // list are documented rather than restated:
        //
        //  - `absentGlobals`: nothing this host declares is absent -- every
        //    ambient name it names is one it provides -- so every declaration
        //    stays believed.
        //  - `nativeProtocols`: every protocol a plugin claims is derived
        //    from `nativeTypes`' carriers by `compiler.ts`.
        //  - `nativeTypes`: `Process` and its three concrete child values are
        //    host-owned declared types, carried by the Node runtime below.
        //    `Buffer`, by contrast, remains answered WITHOUT one. v1 carries
        //    it as `gea_node_buffer`, a class deriving from
        //    `gea_cpp_typed_array<uint8_t>`; v2 needs no carrier of its own
        //    because `buffer-types.ts` declares `Buffer` as an interface
        //    extending `Uint8Array<ArrayBuffer>`, which the compiler's own
        //    heritage-closed typed-array rule already carries as
        //    `gea::TypedArray<std::uint8_t>`. Claiming the name here would
        //    give the program a SECOND C++ type for one carrier and put a
        //    slice at every boundary the declarations say is an identity.
        //    What the host does owe is the value half and the members, and
        //    those are `hostNamespaces` and `hostMembers` below.
        //  - `ambientTypeRealizations`: no ambient name this host's programs
        //    use is realized by a concrete class the way
        //    `@geastack/native-webgl-angle` realizes
        //    `WebGLRenderingContext`. `node:http`'s ambient ground stays
        //    exactly that, ambient.
        //  - `hostFunctionsByDeclaration` / `hostConstantsByDeclaration`: no
        //    name in this host is declared twice, so the flat tables answer
        //    everything.
        //  - `runtimeDefinitions`: the reactor calls nothing back into the
        //    compiled program that the program does not already define --
        //    `main` lives in the target's own entry file
        //    (`scripts/build.mjs`), not inside the unit.
        ...noPluginCapabilities,
        // The Node wrapper declarations are exact host identities. A spelling
        // match is insufficient: the compiler verifies the resolved Symbol's
        // full declaration set against this file, so a caller's ambient
        // require/exports/module cannot capture CommonJS semantics.
        commonJsGlobals: new Map([
          [
            'require',
            {
              global: 'require',
              declarationName: 'require',
              declarationFileName: fileURLToPath(new URL('../runtime/node/commonjs-wrapper.d.ts', import.meta.url)),
              compatibleDeclarations: [{ declarationName: 'require', declarationFileName: nodeModuleDeclarations }]
            }
          ],
          [
            'exports',
            {
              global: 'exports',
              declarationName: 'exports',
              declarationFileName: fileURLToPath(new URL('../runtime/node/commonjs-wrapper.d.ts', import.meta.url)),
              compatibleDeclarations: [{ declarationName: 'exports', declarationFileName: nodeModuleDeclarations }]
            }
          ],
          [
            'module',
            {
              global: 'module',
              declarationName: 'module',
              declarationFileName: fileURLToPath(new URL('../runtime/node/commonjs-wrapper.d.ts', import.meta.url)),
              compatibleDeclarations: [{ declarationName: 'module', declarationFileName: nodeModuleDeclarations }]
            }
          ]
        ]),
        commonJsBuiltinModules: builtinModuleRegistry(),
        commonJsBuiltinModuleSources: builtinModuleSources(),
        nativeTypesByDeclaration: new Map([
          ['Process', { declarationName: 'Process', declarationFileName: processDeclarations, native: processCarrier }],
          ['HRTime', { declarationName: 'HRTime', declarationFileName: processDeclarations, native: processHrTimeCarrier }],
          [
            'ProcessVersions',
            { declarationName: 'ProcessVersions', declarationFileName: processDeclarations, native: processVersionsCarrier }
          ],
          [
            'ProcessWriteStream',
            { declarationName: 'ProcessWriteStream', declarationFileName: processDeclarations, native: processWriteStreamCarrier }
          ]
        ]),
        typedArrayDeclarations: [{ declarationName: 'Buffer', declarationFileName: bufferDeclarations }],
        hostMethodBindings: new Map([...bufferMethodBindings, ...processBuiltinModuleMethodBindings]),
        hostMembers: new Map([...bufferHostMembers, ...processHostMembers]),
        hostInvocations: processHostInvocations,
        hostFunctions: hostFunctions(),
        hostNamespaces: hostNamespaces(),
        hostNamespaceRootTypes: namespaceRootTypes,
        hostInstanceTests: namespaceInstanceTests,
        hostNamespaceRootDeclarations: [
          { declarationName: 'Buffer', declarationFileName: bufferDeclarations },
          // BSON's declaration-only local alias for this same host global used
          // to be named here too, for the reason recorded above `bufferMethodBindings`:
          // its identity had to be supplied explicitly, because a name-only
          // Buffer claim would also capture user code. It was keyed by the
          // checked-in `vendored-sources/bson` path, which no longer exists.
          { declarationName: 'Buffer', declarationFileName: processDeclarations }
        ],
        hostSingletonDeclarations: new Map([
          [
            'process',
            {
              declarationName: 'process',
              declarationFileName: processDeclarations
            }
          ]
        ]),
        nativeIncludes: new Map([
          ...[...namespaceRootTypes.values()].map((type) => [type, runtimeHeader]),
          [processCarrier, runtimeHeader],
          [processHrTimeCarrier, runtimeHeader],
          [processVersionsCarrier, runtimeHeader],
          [processWriteStreamCarrier, runtimeHeader]
        ]),
        hostPreambles: hostPreambles()
      }
    })
  }
}

export default geatscNodePlugin
