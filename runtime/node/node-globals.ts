// Node's own GLOBALS, as ambient names in the real global scope.
//
// `Buffer` is a global in Node, and library code says `Buffer.from(...)` with
// no import in sight -- mongodb's driver and bson say it in almost every file.
// Nothing in node-compat put that name in global scope: `runtime/node/
// buffer.ts` has top-level `export`s, which makes it a MODULE, so its
// `export declare const Buffer` is module-scoped and invisible to any file
// that does not import it (nothing does). That file's own header claims it is
// "usable as both the forced global provider and the `buffer`/`node:buffer`
// builtin module", and the first half of that has never been true for the
// reason `globals.ts`'s header spells out at length: a script is what reaches
// global scope, and a module is not one.
//
// Explicit global augmentation keeps the bindings visible under NodeNext as
// well as Bundler resolution. Import types keep the runtime modules' identities.
//
// No `/// <reference no-default-lib="true"/>`, deliberately, and that is the
// difference from `standard-library.ts`: that pragma is what makes the
// compiler treat an ambient declaration as its OWN standard library
// (`host-protocols.ts` keys `HostCensus.standardLibrary` off
// `SourceFile.hasNoDefaultLib`), which is right for `console` and
// `TextEncoder` -- names geatsc itself implements -- and wrong for `Buffer`,
// which is this HOST's to provide.
// BOTH halves of the name. `Buffer` is a value AND a type in Node, and
// library code writes each: `Buffer.from(x)` reads the constructor,
// `(b: Buffer)` reads the instance interface. Declaring only the value left 66
// rows of "'Buffer' refers to a value, but is being used as a type here" --
// the same count of files, a different question. `node:buffer` declares the
// pair already, so both sides are aliased to it rather than restated.
//
// The enclosing ambient block makes both halves of each binding ambient;
// neither an alias nor a global declaration allocates a new runtime object.
export {}

// Explicit global scope is required when NodeNext treats .ts files as modules.
declare global {
  /**
   * The Node process surface this target actually implements.  Keeping it
   * narrow is intentional: adding a member here is a runtime protocol claim,
   * not a convenience declaration.
   */
  interface ProcessEnv {
    [key: string]: string | undefined
  }

  interface ProcessWriteStream {
    readonly fd: number
  }

  interface ProcessVersions {
    readonly node: string
  }

  interface HRTime {
    (): [number, number]
    bigint(): bigint
  }

  namespace NodeJS {
    /**
     * The part of Node's builtin-module namespace this target can name with a
     * stable static type.  Other runtime spellings retain the documented
     * `object | undefined` fallback below; declaring a broad index here would
     * pretend every generated facade is an implemented module.
     */
    interface ProcessBuiltinModules {
      readonly diagnostics_channel: typeof import('./diagnostics_channel.js')
      readonly 'node:diagnostics_channel': typeof import('./diagnostics_channel.js')
      readonly v8?: {
        readonly startupSnapshot?: {
          isBuildingSnapshot?(): boolean
          addDeserializeCallback?(callback: () => void): void
        }
      }
      readonly 'node:v8'?: ProcessBuiltinModules['v8']
    }

    /**
     * Keep the primary host type under the namespace Node's global declarations
     * use.  Generated projects intentionally set `types: []`, so this cannot
     * borrow `NodeJS.Process` from an ambient @types package.
     */
    interface Process {
      readonly env: ProcessEnv
      readonly pid: number
      readonly ppid: number
      readonly argv: string[]
      readonly execArgv: string[]
      readonly stdout: ProcessWriteStream
      readonly stderr: ProcessWriteStream
      readonly versions: ProcessVersions
      readonly hrtime: HRTime
      // The literal overload retains the selected builtin's type. The string
      // overload stays dynamic: availability is decided by the native registry
      // at runtime, where unavailable/generated facades answer `undefined`.
      getBuiltinModule<ID extends keyof ProcessBuiltinModules>(id: ID): ProcessBuiltinModules[ID]
      getBuiltinModule(id: string): object | undefined
      nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void
      cwd(): string
      exit(code?: number): never
      on(event: 'exit', listener: (code: number) => void): this
      removeListener(event: 'exit', listener: (code: number) => void): this
    }
  }

  // Node's platform declarations name this type as `NodeJS.Process`; expose
  // the same primary declaration in projects that deliberately exclude
  // @types/node, while preserving the familiar global `Process` spelling.
  interface Process extends NodeJS.Process {}

  var process: NodeJS.Process

  // Same alias `@types/node` publishes. A type only: a value binding here
  // would claim a host cell the plugin does not define.
  interface NodeRequire {
    (specifier: string): any
  }

  // Node's own alias for the object `globalThis` already names -- kept
  // because library code still spells it this way. `@hono/node-server`'s
  // `listener.ts`/`request.ts`/`response.ts` read and
  // `Object.defineProperty(global, 'Request', ...)`-write `global.Request`/
  // `global.Response` at module load, to detect and override the platform's
  // default Request/Response with faster ones -- so this has to be the SAME
  // object `typeof globalThis` describes, not a second, disconnected type.
  var global: typeof globalThis

  // The timer globals are NOT declared here either, and for exactly the reason
  // the WHATWG stream note below gives. They were --
  // `const setTimeout: typeof import('./timers.js').setTimeout` and its
  // `clearTimeout` sibling -- and that ambient `const` over source is a claim
  // of a host binding that does not exist: the unit emitted
  // `extern gea::CallableObject<...> setTimeout;`, a symbol nothing defines.
  // It survived only because node-compat's v1 plugin table separately claimed
  // the bare name as the `__gea_node_set_timeout` intrinsic, whose `double`
  // return and `std::function<void()>` parameter contradict the `Timeout`
  // object and variadic callback this source states -- nine clang errors in
  // hono-hello.
  //
  // The implementations live in `global-timers.ts` instead, a SCRIPT, so the
  // globals are ordinary source declarations resolved by name -- the same
  // mechanism `whatwg-streams.ts` uses. `timers.ts` re-exports them as
  // `node:timers`.

  // WHATWG Streams are NOT declared here. They were, as the same
  // `type X = import(...)` / `const X: typeof import(...)` pair every other
  // global on this page uses, and for these that pair was wrong in a way the
  // others are not: `Buffer` and `setTimeout` name a value some HOST provides,
  // while `ReadableStream`'s only implementation is node-compat's own
  // TypeScript. An ambient `const` over source is a claim of a host binding
  // that does not exist, and the compiler believed it -- every member of the
  // class got a `native-handle` representation demanding a
  // `native-boundary:ReadableStream@1` protocol no table backs, which refused
  // 329 of hono-hello's 823 roots.
  //
  // The classes live in `whatwg-streams.ts` instead, a SCRIPT, so the globals
  // are ordinary source declarations resolved by name -- the same mechanism
  // `globals.ts` uses for `Response`/`Headers`, and for the same reason.
  // `stream/web.ts` re-exports them as `node:stream/web`.

  type Buffer = import('./buffer-types.js').Buffer
  type BufferConstructor = import('./buffer-types.js').BufferConstructor
  const Buffer: import('./buffer-types.js').BufferConstructor
  type BufferEncoding = import('./buffer-types.js').BufferEncoding

  // Type aliases retain the identity of the runtime implementation. Independent
  // ambient classes here would give a timer or stream two incompatible carriers.
  namespace NodeJS {
    // `@types/node` is intentionally shadowed for mapped `node:*` modules:
    // the compiler must type the same source runtime it emits.  Its remaining
    // global declarations still name these NodeJS aliases, so keep those
    // aliases anchored to this runtime rather than reviving the declaration
    // package's unrelated object graph.
    type BufferConstructor = globalThis.BufferConstructor
    type Timeout = import('./timers.js').Timeout
    type WriteStream = import('./process.js').WriteStream
    type Platform = typeof import('./process.js').platform

    // Node's own shape for a system-call error (`errno`/`code`/`syscall`/
    // `path`, layered onto a real `Error`) -- `@hono/node-server`'s own
    // `request.ts` reads `.code` off a caught `IncomingMessage` stream error
    // (`(errored as NodeJS.ErrnoException).code !== 'ECONNRESET'`) to tell a
    // client disconnect from an application-thrown error. A plain `Error`
    // has no `.code` at all, so this has to be a real interface, not an
    // alias to one.
    interface ErrnoException extends Error {
      errno?: number
      code?: string
      path?: string
      syscall?: string
    }
  }

  // `performance`, at the width the program actually reads.
  //
  // No `lib` is set for these projects (`scripts/build.mjs` writes only
  // `target: ES2022`), so `lib.dom.d.ts` is out of scope and this name is
  // undeclared -- while mongodb reads `performance.now()` on the connection
  // path (`cmap/connect.ts`), in every timeout computation (`timeout.ts`) and in
  // `utils.ts`'s `now()`. Node's own `Performance` is a large interface with
  // marks, measures, entry buffers and an event-loop-utilization hook, and
  // declaring the whole of it would be declaring a surface this host does not
  // provide: a claim the plugin cannot back is worse than an absent name,
  // because the program then compiles a call into a symbol nothing defines and
  // the failure moves from the compiler to the linker.
  //
  // So the interface states the one member the libraries read, and
  // `plugin/index.mjs` answers exactly that member. Anything else written against
  // `performance` fails here, in the checker, naming the member.
  //
  // Like `Buffer` above, the VALUE is a namespace and not a cell: see that
  // comment for why, and `plugin/index.mjs`'s `hostNamespaceRootTypes` for the row
  // without which the root falls back to its structural answer.
  interface Performance {
    now(): number
  }

  const performance: Performance
}
