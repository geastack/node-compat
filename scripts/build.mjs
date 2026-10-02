// Build driver for node-compat apps, through geatsc.
//
// The v1 driver that used to sit beside this one handed geatsc a
// `nodeResolution` option describing how `node:http` finds
// `runtime/node/http.ts`. geatsc has no such option and should not grow one:
// "which file is `node:http`" is a question about a build, not about
// TypeScript, and every other toolchain answers it in a project's `paths`.
// So this driver writes the project instead
// of extending the compiler -- the same answer, stated where tsc, the editor,
// and the compiler all already read it. (That v1 driver held this file's name
// and is gone: it resolved `compiler-legacy/`, which no longer builds.)
//
// Usage: node scripts/build.mjs <entry.ts> [--out <dir>] [--exe <path>]
//                                  [--debug] [--emit-only] [--globals] [--verbose]
//                                  [--source-project <tsconfig>]
//                                  [--dynamic-fallback] [--javascript-sources]
//                                  [--translation-units single|per-file]
//                                  [--report <file.json>] [--paths <file.json>]
//                                  [--package-root <source-checkout>] [--link-only]
//                                  [--pgo] [--pgo-train <shell command>] [--bolt]
//
// --link-only compiles and links the units an earlier build (normally
// `--emit-only --report`) wrote to --out, skipping the TypeScript compile.
// Several .cpp units compile concurrently (GEA_JOBS, default every core, memory permitting)
// and link once; one unit is one command.
//
// --pgo builds the executable profile-guided, in one invocation: an
// instrumented link, a training run, and the optimized link from that profile
// (see `buildExecutable`). The training run is the program itself with no
// arguments, or --pgo-train's shell command (which implies --pgo), run with
// GEA_PGO_EXE naming the instrumented executable -- a server needs a client to
// drive it, a benchmark may need its database reset first.
//
// Source checkout callers supply --package-root; the compiler discovers its
// implementations through package/build metadata. --paths remains an explicit
// project override, and is never required for automatic package discovery.
//
// `--report` writes the outcome as DATA -- the same columns the compiler's own
// corpus harness records (boxed, unresolved, missing predicates, blockers,
// refusals, root diagnostics, withheld, emitted lines) plus the link result --
// so a caller such as the corpus sweep never parses this script's stderr.
// Written at every stage, so a compile that throws or a link that fails still
// leaves a record. Exit codes: 1 nothing emitted, 2 link failed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { geatscNodePlugin } from '../plugin/index.mjs'
import { resolveBuiltinModules, runtimeRootsForReachableGlobalNeeds } from './builtin-modules.mjs'
import { displayPathFrom } from './path-display.mjs'
import { compile } from '@geastack/compiler'
import { preparePackageSources } from '@geastack/compiler/preparation'

// The compile runs in this process and allocates hard: on the mongodb driver
// the default young generation made V8 GC 28% of the emission (24.8k
// scavenges). A 128 MB semi-space took emit-only from 4:22 to 3:12 on the
// 8-thread box (peak RSS 5.0 -> 7.6 GB), and it needs a larger old space or
// the heap runs out. Heap flags only take effect at process start, so a run
// without them re-executes itself once with them; GEA_BUILD_NODE_FLAGS=0
// keeps the default heap, and a caller's own --max-semi-space-size wins.
if (
  process.env.GEA_BUILD_NODE_FLAGS !== '0' &&
  !process.env.GEA_BUILD_REEXECUTED &&
  ![...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].some((flag) => flag.startsWith('--max-semi-space-size'))
) {
  const oldSpace = Math.min(16000, Math.floor((os.totalmem() / 2 ** 20) * 0.6))
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, '--max-semi-space-size=128', `--max-old-space-size=${oldSpace}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, GEA_BUILD_REEXECUTED: '1' } }
  )
  process.exit(child.status ?? 1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const packageRequire = createRequire(import.meta.url)
const compilerManifest = packageRequire.resolve('@geastack/compiler/package.json')
const compilerRoot = path.dirname(compilerManifest)
const compilerRequire = createRequire(compilerManifest)
const ts = compilerRequire('typescript')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const entryArg = process.argv[2]
if (!entryArg || entryArg.startsWith('--')) {
  console.error(
    'usage: node scripts/build.mjs <entry.ts> [--out <dir>] [--exe <path>] [--debug] [--emit-only] [--globals] [--verbose] [--source-project <tsconfig>] [--dynamic-fallback] [--javascript-sources] [--translation-units single|per-file] [--report <file.json>] [--link-only]'
  )
  process.exit(1)
}
const entry = path.resolve(entryArg)
const outDir = path.resolve(arg('--out', path.join(path.dirname(entry), 'dist')))
const exePath = path.resolve(arg('--exe', path.join(outDir, 'server')))
const optimize = !process.argv.includes('--debug')
const bolt = process.argv.includes('--bolt')
// gold aborts (`internal error in do_layout`) linking a ThinLTO program with
// `--emit-relocs`, which --bolt needs; lld links it.
if (bolt && process.platform === 'linux' && !process.env.GEA_LD) process.env.GEA_LD = 'lld'
const emitOnly = process.argv.includes('--emit-only')
// `--link-only`: skip the TypeScript compile and emission, and compile + link
// the units an earlier `--emit-only` (or full) build already wrote to `--out`.
// The unit list is that build's report (`generatedFiles`), so a C++ flag or
// runtime-header change is retried without paying for the compile again.
const linkOnly = process.argv.includes('--link-only')
const verbose = process.argv.includes('--verbose')
const translationUnits = arg('--translation-units', 'single')
if (translationUnits !== 'single' && translationUnits !== 'per-file') {
  throw new Error(`Invalid translation-unit layout: ${translationUnits}`)
}
const sourceProject = arg('--source-project', null)
const reportPath = arg('--report', null)
const extraPathsFile = arg('--paths', null)
const packageRoot = arg('--package-root', null)
const executableName = path.basename(exePath)
const unitBaseName = process.platform === 'win32' && executableName.endsWith('.exe') ? executableName.slice(0, -4) : executableName
const previousGeneratedFiles = (() => {
  if (!reportPath || !fs.existsSync(reportPath)) return []
  try {
    const value = JSON.parse(fs.readFileSync(reportPath, 'utf8')).generatedFiles
    return Array.isArray(value) ? value.filter((file) => typeof file === 'string' && path.basename(file) === file) : []
  } catch {
    return []
  }
})()
const report = { stage: 'compile', threw: null }
const writeReport = (fields) => {
  Object.assign(report, fields)
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true })
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
}
// Anything that throws before or beside `compile` -- reading the source
// project, writing the generated one -- still leaves a record naming it.
process.on('uncaughtException', (error) => {
  writeReport({ threw: `${error?.stack ?? error}` })
  console.error(error?.stack ?? error)
  process.exit(1)
})

if (linkOnly) {
  // Read from `--report` when given, else from `<out>/report.json`: an
  // emit-only build is normally run with `--report` beside its units.
  const emittedReport = path.resolve(reportPath ?? path.join(outDir, 'report.json'))
  let generated = null
  if (fs.existsSync(emittedReport)) {
    const previous = JSON.parse(fs.readFileSync(emittedReport, 'utf8'))
    if (Array.isArray(previous.generatedFiles)) {
      generated = previous.generatedFiles.filter((file) => typeof file === 'string' && path.basename(file) === file)
      // Keep the emission's columns; the link stage adds to them.
      if (reportPath) Object.assign(report, previous, { threw: null })
    }
  }
  if (!generated) {
    throw new Error(`--link-only: no generatedFiles in ${emittedReport}; run the build with --emit-only --report first`)
  }
  const units = generated.map((fileName) => {
    const file = path.join(outDir, fileName)
    if (!fs.existsSync(file)) throw new Error(`--link-only: ${file} (listed in ${emittedReport}) does not exist`)
    return { fileName, source: fs.readFileSync(file, 'utf8') }
  })
  console.error(`[build] link-only: ${units.length} unit(s) from ${displayPathFrom(process.cwd(), emittedReport)}`)
  await buildExecutable(units, (file) => displayPathFrom(process.cwd(), file))
  process.exit(0)
}

function sourceLanguageOptions() {
  if (sourceProject === null) return {}
  const selectedProject = sourceProject
  const file = path.resolve(selectedProject)
  const config = ts.readConfigFile(file, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file))
  // Only the options lifted below matter here; an option this TypeScript
  // does not know (`stableTypeOrdering`, from a newer one -- typescript-estree),
  // an empty `files` list, or a `references` quirk is the source project's
  // business, not a reason to refuse the build. Real read failures still throw.
  const errors = parsed.errors.filter((error) => ![18003, 5023, 5024, 5025, 5053, 6046, 6053].includes(error.code))
  if (errors.length > 0) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  // Preserve source-level semantics without importing the source project's
  // module resolution, ambient platform declarations, or output directories.
  // The source project's own strictness, INCLUDING its absence: a library
  // written without `strict` types its catch variables `any` and its
  // uninitialised fields loosely, and checking it under this driver's
  // default `strict: true` reports errors its own tsc never would.
  const options = { strict: parsed.options.strict === true }
  for (const name of [
    'useUnknownInCatchVariables',
    'useDefineForClassFields',
    'strictNullChecks',
    'exactOptionalPropertyTypes',
    'noUncheckedIndexedAccess',
    'allowImportingTsExtensions',
    'verbatimModuleSyntax',
    'strictFunctionTypes',
    'strictPropertyInitialization',
    'noImplicitAny',
    'noImplicitThis',
    'alwaysStrict',
    'experimentalDecorators',
    'emitDecoratorMetadata',
    'customConditions',
    'resolveJsonModule',
    'baseUrl'
  ]) {
    if (parsed.options[name] !== undefined) options[name] = parsed.options[name]
  }
  // `allowImportingTsExtensions` is only legal in a project that never emits
  // JavaScript. This one never does -- geatsc reads it, tsc never runs emit
  // on it -- so state that, or the checker rejects the option itself.
  if (options.allowImportingTsExtensions) options.noEmit = true
  // The generated application project owns its module format and resolver.
  // A source checkout's tsconfig describes how that library publishes its own
  // JavaScript; importing CommonJS here would redefine an ESNext application
  // entry and reject valid top-level await before geatsc sees the program.
  if (parsed.options.paths) {
    const base = parsed.options.baseUrl ?? parsed.options.pathsBasePath ?? path.dirname(file)
    options.paths = Object.fromEntries(
      Object.entries(parsed.options.paths).map(([name, targets]) => [name, targets.map((target) => path.resolve(base, target))])
    )
  }
  return options
}

function entryPackageDirectory() {
  let directory = path.dirname(entry)
  while (true) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}
// The WHATWG globals (`Response`, `Headers`, `URL`) are what a library builds
// its replies out of; a raw `node:http` app never names one. They are pulled in
// only when the reachable graph needs one; this flag is the explicit override.
// An unreferenced class still has to certify, so a program should not be
// blocked by a capability it does not use.
const withGlobals = process.argv.includes('--globals')

// ---------------------------------------------------------------------------
// Compile-from-source.
//
// A published library ships compiled `.js` with every type parameter ERASED,
// so a generic value -- hono's `Context<E>`, its router's `T` -- arrives with
// nothing to monomorphize against and lowers to a box. Compiling the library's
// own typed `.ts` instead is what makes the hot path native, which is the
// whole reason to compile a framework at all.
//
// This is not a flag and not a checked-in copy. The compiler acquires the
// typed source for the exact version the application installed and caches it
// under `node_modules/.cache/geatsc/sources` (`preparePackageSources` below).
// A vendored checkout pinned to one version compiled something other than what
// the application resolved, and went on compiling it after the dependency
// moved; nothing here selects sources by name any more.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The project.
//
// A generated file rather than one checked in, because its `files` list names
// the app being built. It is written into the build directory (gitignored) and
// is a normal `tsconfig.json` in every other respect -- readable by tsc, by an
// editor, and by anyone asking what this program is.
// ---------------------------------------------------------------------------

const builtinsDir = path.join(repo, 'runtime', 'node')
const facadesDir = path.join(builtinsDir, 'generated', 'facades')

/** Every module name this target answers, to the file that implements it. */
function builtinModules() {
  return resolveBuiltinModules(builtinsDir, facadesDir)
}

// `whatwg-url` is the one npm package this target answers. Its published
// JavaScript has no type declarations, so a library importing it gets an error
// type for `URL`, and the driver's ConnectionString loses inherited members.
// `@hono/node-server` is answered by this target's own adapter rather than
// compiled from the package: the package builds a node:http IncomingMessage /
// ServerResponse pair per request only to wrap them back into a Request and
// unwrap the Response, and on this target that pair is itself compiled
// TypeScript. `hono-node-server.ts` goes from the reactor's dispatch to a
// `Request` and from the `Response` to the wire directly -- twice the
// throughput of the compiled package on the same compiler, runtime and Hono.
// `GEA_NODE_COMPAT_PACKAGE_ADAPTER=1` compiles the package instead, so the
// two adapters can be measured against each other on one compiler.
const answeredPackages = () =>
  new Map([
    ['whatwg-url', path.join(builtinsDir, 'whatwg-url.ts')],
    ...(process.env.GEA_NODE_COMPAT_PACKAGE_ADAPTER === '1' ? [] : [['@hono/node-server', path.join(builtinsDir, 'hono-node-server.ts')]])
  ])
const whatwgGlobalNames = new Set(['Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'FormData'])
const targetModulePathKeys = new Set([
  ...[...builtinModules().keys()].flatMap((name) => [`node:${name}`, name]),
  ...answeredPackages().keys()
])

function retainUsedBuiltinPaths(projectFile, sourceFileNames) {
  const used = new Set()
  for (const file of new Set([entry, ...sourceFileNames.values()])) {
    if (!fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (targetModulePathKeys.has(imported.fileName)) used.add(imported.fileName)
    }
  }
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
  for (const key of targetModulePathKeys) if (!used.has(key)) delete project.compilerOptions.paths[key]
  if (Object.keys(project.compilerOptions.paths).length === 0) delete project.compilerOptions.paths
  fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`)
}

function writeProject() {
  const modules = builtinModules()
  // The library sources first, so a `node:` builtin below always wins: a
  // package that ships its own `http` shim must not answer for this target's.
  const languageOptions = sourceLanguageOptions()
  const paths = { ...languageOptions.paths }
  if (extraPathsFile !== null) {
    const extra = JSON.parse(fs.readFileSync(extraPathsFile, 'utf8'))
    for (const [specifier, files] of Object.entries(extra)) {
      paths[specifier] = (Array.isArray(files) ? files : [files]).map((file) => path.resolve(file))
    }
  }
  // Ordinary dependencies retain Node's nested package/version lookup.
  for (const [name, file] of modules) {
    const relative = path.resolve(file)
    // Both spellings, because both are legal in Node and libraries use both.
    paths[`node:${name}`] = [relative]
    paths[name] = [relative]
  }
  // After the builtins, so a package this target answers wins over a `node:`
  // module of the same name -- and only under its own specifier, never a
  // `node:` one.
  for (const [name, file] of answeredPackages()) paths[name] = [path.resolve(file)]
  // `standard-library.ts` is unconditional: node-compat's own builtins
  // (`http.ts`, `events.ts`, `net.ts`, `crypto.ts`) call `queueMicrotask` and
  // `console.log` regardless of whether this program ever asks for the
  // WHATWG fetch/URL classes, so the ambient names those calls need must be
  // in every project, not only a `--globals` one. See that file's header,
  // and `globals.ts`'s, for why this is two files rather than one.
  //
  // The real TypeScript lib files (`lib.es2022.d.ts` and friends) are listed
  // here EXPLICITLY, by resolved path, rather than through
  // `compilerOptions.lib` -- because `standard-library.ts` carries `///
  // <reference no-default-lib="true"/>` (see its header) and IS a root file
  // (below), and TypeScript's own rule is: once ANY root file declares
  // `hasNoDefaultLib`, the checker stops auto-including ANYTHING from
  // `compilerOptions.lib` for the WHOLE program -- silently discarding the
  // entry entirely, not merely deferring to the custom file. Verified with a
  // bare `tsc --noEmit`: keeping `lib: ['ES2022', ...]` alongside
  // `standard-library.ts` in `files` produced `error TS2318: Cannot find
  // global type 'Array'`/`'Object'`/`'String'`/... -- the ENTIRE standard
  // library gone, not just `'DOM'`. Passing the real lib files as explicit
  // roots instead sidesteps the suppression rule (it only fires for the
  // AUTOMATIC inclusion) and reproduces exactly what `compilerOptions.lib`
  // would have pulled in, `'DOM'` excluded -- lib.es2022.d.ts's own
  // `/// <reference lib="..."/>` chain pulls in es2021 down through es5,
  // which is the entire non-DOM portion of what was requested.
  const libDir = path.dirname(compilerRequire.resolve('typescript/lib/lib.es2022.d.ts'))
  const libFiles = ['lib.es2022.d.ts', 'lib.es2018.asynciterable.d.ts', 'lib.es2018.asyncgenerator.d.ts', 'lib.esnext.disposable.d.ts'].map(
    (name) => `./${path.relative(outDir, path.join(libDir, name)).replace(/\\/g, '/')}`
  )
  // These are the `files` entries below with no `.d.ts` extension: ambient
  // `declare global` scripts nothing in the program ever `import`s, kept in
  // scope today only by being named in the staged project's own file list.
  // `statedModuleSet: true` (see `compileSources`, below) makes `program.ts`
  // filter that list down to declarations, exactly because a project's file
  // list is not this application's module set -- but these files are real
  // roots the caller intends unconditionally, not wildcard `include` noise,
  // so `compileSources` also hands them to `compile()` as `rootFileNames`,
  // which the filter never touches.
  const unconditionalAmbientRoots = [
    path.join(builtinsDir, 'standard-library.ts'),
    path.join(builtinsDir, 'node-globals.ts'),
    path.join(builtinsDir, 'whatwg-streams.ts'),
    path.join(builtinsDir, 'abort-events.ts'),
    path.join(builtinsDir, 'global-timers.ts'),
    path.join(builtinsDir, 'native-addons.ts')
  ]
  const files = [
    ...libFiles,
    path.relative(outDir, entry).replace(/\\/g, '/'),
    `./${path.relative(outDir, path.join(builtinsDir, 'standard-library.ts')).replace(/\\/g, '/')}`,
    // Unconditional, like `standard-library.ts` and for the same reason: a
    // node global is one library code names with no import, so it has to be
    // in scope whether or not this program asked for the WHATWG classes.
    `./${path.relative(outDir, path.join(builtinsDir, 'node-globals.ts')).replace(/\\/g, '/')}`,
    // Unconditional too, and for a third variation of the same reason: the
    // WHATWG stream classes are globals in Node, `@hono/node-server` writes
    // `new ReadableStream(...)` with no import, and -- unlike `globals.ts`'s
    // fetch classes -- this target's OWN `node:stream` builtin needs them
    // (`readableToWeb`) whether or not the application ever names one.
    // Unreached declarations are pruned like any other root, so a program that
    // touches no stream pays for none of it.
    `./${path.relative(outDir, path.join(builtinsDir, 'whatwg-streams.ts')).replace(/\\/g, '/')}`,
    // Unconditional for the same reason again: `events.ts`'s
    // `addAbortListener` and `stream.ts`'s `signal?: AbortSignal` are this
    // target's own builtins naming `Event`/`AbortSignal` with no import, so
    // the declarations have to be in every program and not only a `--globals`
    // one. See that file's header.
    `./${path.relative(outDir, path.join(builtinsDir, 'abort-events.ts')).replace(/\\/g, '/')}`,
    // Unconditional for the same reason once more: `setTimeout`/`clearTimeout`
    // are Node globals that `@hono/node-server`'s `listener.ts` and hono's own
    // `timeout` middleware name with no import, and this target's own `net.ts`
    // schedules socket timeouts through them. See that file's header for why
    // the implementations are a script rather than the ambient `const` over
    // `timers.ts` they used to be.
    `./${path.relative(outDir, path.join(builtinsDir, 'global-timers.ts')).replace(/\\/g, '/')}`,
    // The target of `nativeAddonRequireTransform` (the plugin's source
    // transform): a `require('<path>.node')` becomes a call of the function this
    // script declares, so it has to be in scope in every program. Unreached, it
    // is pruned like any other root.
    `./${path.relative(outDir, path.join(builtinsDir, 'native-addons.ts')).replace(/\\/g, '/')}`
  ]
  const globalsFile = path.join(builtinsDir, 'globals.ts')
  // The target's own `node:*` sources are part of the runtime graph: `fs.ts` names `URL`, so an entry that
  // only imports `node:fs` still needs the declaration provider.
  const reachableGlobals = runtimeRootsForReachableGlobalNeeds({
    entryFiles: [entry],
    moduleOverrides: new Map([
      ...[...builtinModules()].flatMap(([name, file]) => [
        [`node:${name}`, file],
        [name, file]
      ]),
      ...answeredPackages()
    ]),
    providers: [{ file: globalsFile, names: whatwgGlobalNames }],
    ts
  })
  if (withGlobals || reachableGlobals.roots.has(globalsFile)) {
    files.push(`./${path.relative(outDir, globalsFile).replace(/\\/g, '/')}`)
    unconditionalAmbientRoots.push(globalsFile)
  }
  const project = {
    // A generated project. `files` names the program's roots (including,
    // now, the real lib files themselves -- see the comment above); `paths`
    // is how this target answers `node:*`.
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      ...languageOptions,
      customConditions: [...new Set(['node', ...(languageOptions.customConditions ?? [])])],
      skipLibCheck: true,
      // No `lib` option: it would be silently ignored (see the comment on
      // `libFiles`, above) now that the equivalent files are explicit roots.
      // What an earlier plugin passed as `compilerOptions.lib` was
      // `['ES2022', 'ES2018.AsyncIterable', 'ES2018.AsyncGenerator',
      // 'ESNext.Disposable', 'DOM']` -- everything but `'DOM'` is now
      // `libFiles`, above. `'DOM'` is gone on purpose: this target is not a
      // browser, and it supplied unimplemented ambient `Response`/`Headers`/
      // `Request`/`URL`/`URLSearchParams`/`FormData` interfaces that
      // silently outranked `globals.ts`'s real, compiled classes of the same
      // name (every library construction of one lowered to an opaque native
      // handle instead). What node-compat's own builtins genuinely need from
      // the browser standard library (`console`, `TextEncoder`/`TextDecoder`,
      // `btoa`/`atob`, `queueMicrotask`) now comes from
      // `standard-library.ts`, always in `files` below -- see its header.
      //
      // `noLib` is left at its default (`false`): the automatic-inclusion
      // suppression that motivated explicit `libFiles` is a SIDE EFFECT of
      // `standard-library.ts`'s pragma, not something this option needs to
      // restate, and setting `noLib: true` here changes nothing further --
      // `hasNoDefaultLib` on that root file already produces the identical
      // effect for this program.
      // Invariant: node-compat's target declarations are self-contained.
      // `@types/node` is not this program's authority on either global Process
      // or what `node:http` is; loading it would merge a wider, incompatible
      // host surface into the exact declaration identities the plugin claims.
      types: [],
      paths
    },
    files: files.map((file) => (file.startsWith('.') ? file : `./${file}`))
  }
  fs.mkdirSync(outDir, { recursive: true })
  const projectFile = path.join(outDir, 'tsconfig.json')
  fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`)
  return { projectFile, unconditionalAmbientRoots }
}

// ---------------------------------------------------------------------------
// Compile.
// ---------------------------------------------------------------------------

const packageDirectory = entryPackageDirectory()
const displayRoot = packageDirectory ?? process.cwd()
const displayPath = (file) => displayPathFrom(displayRoot, file)

// A package's typed source comes from the package the application installed,
// acquired by `preparePackageSources` against that exact published version.
// There is no bundled substitute checked in beside it: a vendored copy pinned
// to one version compiles something other than what the application resolves,
// and silently keeps compiling it after the dependency moves.
const acquiredSources = (packageRoot ?? packageDirectory) ? await preparePackageSources(path.resolve(packageRoot ?? packageDirectory)) : []
const dynamicFallback = process.argv.includes('--dynamic-fallback')
const sourceName = (source) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')).name ?? source.root
  } catch {
    return source.root
  }
}
// A package this target answers (`answeredPackages`) is not compiled from its
// own source as well: its specifier already resolves to the target's file, so
// the acquired copy would enter the program as a second, unreferenced module
// -- one that, for `@hono/node-server`, redefines the WHATWG globals.
const answered = answeredPackages()
const preparedSources = acquiredSources.filter((source) => !answered.has(sourceName(source)))
if (preparedSources.length > 0) console.error(`[build] compile-from-source: ${[...new Set(preparedSources.map(sourceName))].join(', ')}`)
const packageSources = [...preparedSources, ...(packageRoot ? [{ root: path.resolve(packageRoot) }] : [])]

// The application's devDependencies are installed for the build -- for their
// TYPES, as the MongoDB driver's optional peers (`kerberos`, `gcp-metadata`,
// `mongodb-client-encryption`) are -- and are absent from the production
// install a deployed server runs from (`npm install --omit=dev`). The binary
// answers a runtime `require` of one the way that install does: MODULE_NOT_FOUND.
const typesOnlyPackages = (() => {
  if (!packageDirectory) return new Set()
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  } catch {
    return new Set()
  }
  const shipped = new Set(
    ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}))
  )
  return new Set(Object.keys(manifest.devDependencies ?? {}).filter((name) => !shipped.has(name)))
})()

const { projectFile, unconditionalAmbientRoots } = writeProject()
writeReport({ packageSources })
console.error(`[build] compiling ${displayPath(entry)} -> ${displayPath(outDir)}`)

/** Where a diagnostic is, when it names a place rather than a component. */
const where = (diagnostic) =>
  diagnostic.location
    ? `${displayPath(diagnostic.location.file)}:${diagnostic.location.line}:${diagnostic.location.column}`
    : diagnostic.component

// A lowering owner is an identity (`fn|decl|f62|2324`, `fn|decl|f90|905@0`,
// `region|node|f70|SourceFile|0|module-body`), unreadable without the file
// map and a node walk; the compile result already knows both, so print the
// declaration's file:line where it has one and the file alone for a region.
const ownerLocation = (owner) => {
  const declaration = owner.match(/^fn\|(decl\|f\d+\|\d+)/)?.[1]
  const location = declaration ? result.locationOfDeclaration(declaration) : null
  if (location) return `${displayPath(location.file)}:${location.line}`
  // An `op|node|...` owner names the node it normalized from, and the result
  // resolves that through the same index a declaration owner goes through.
  // Without this an operation refusal printed its file alone, and the number in
  // the identity is a node ORDINAL, so a reader had nothing to open.
  const node = owner.match(/^op\|(node\|f\d+\|[A-Za-z]+\|\d+(?:@[\d,]+)?)\|/)?.[1]
  const nodeLocation = node ? result.locationOfNode(node) : null
  if (nodeLocation) return `${displayPath(nodeLocation.file)}:${nodeLocation.line}`
  const fileIdentity = owner.match(/\|(f\d+)\|/)?.[1]
  return fileIdentity ? displayPath(result.sourceFileNames.get(fileIdentity) ?? fileIdentity) : '<unlocated>'
}

const compileStarted = process.hrtime.bigint()
const requestedJavaScriptSources = process.argv.includes('--javascript-sources')
const compileSources = (sources, javaScriptSources) =>
  compile({
    // `entry` alone is the application's real module graph, but this
    // target's ambient `declare global` scripts (`standard-library.ts`,
    // `node-globals.ts`, `whatwg-streams.ts`, `abort-events.ts`,
    // `global-timers.ts`, conditionally `globals.ts`) are genuine roots too
    // -- named unconditionally in the staged project's own `files` -- that
    // nothing ever `import`s, so `statedModuleSet: true` below (which makes
    // `program.ts` stop trusting the staged project's file list beyond its
    // `.d.ts` entries) would silently drop them if they were not also handed
    // here, where `rootFileNames` is added unconditionally regardless of the
    // module-set filter. See `writeProject`'s own comment on
    // `unconditionalAmbientRoots`.
    rootFileNames: [entry, ...unconditionalAmbientRoots],
    packageSources: sources,
    typesOnlyPackages,
    dynamicFallback,
    javaScriptSources,
    projectFileName: projectFile,
    plugins: [geatscNodePlugin()],
    // `entry` plus its resolved dependency graph (npm packages included via
    // `packageSources`) IS the whole application -- the same
    // `compile-module-graph` shape `cli-emit.ts`'s `runModuleGraph` states for
    // every real app build ("The graph is the module set; the staged project
    // beside the entry is not."). Without this, `export-importers.ts`'s
    // `inProgramImportReferencesOf` has no module set to close an export's
    // importers against and refuses every exported callable's parameter
    // (`function-escapes:exported`) regardless of whether this program's own
    // import graph actually closes -- the single largest reason group
    // blocking `hono-bridge` (26 of 149 refusals, `node:stream`'s own
    // re-export facade among them) traced to exactly this missing flag, not
    // to a compiler proof gap.
    statedModuleSet: true,
    // The unit is linked against this target's own `main`, which calls it. The
    // default (`__gea_top_level`) is the gea engine's entry name and means the
    // same thing here: run the program's module bodies once.
    entrySymbol: '__gea_top_level',
    translationUnits,
    unitBaseName
  })
let result
try {
  result = compileSources(packageSources, requestedJavaScriptSources || dynamicFallback)
  writeReport({ packageSources })
} catch (error) {
  writeReport({
    threw: `${error?.stack ?? error}`,
    compileMs: Number((process.hrtime.bigint() - compileStarted) / 1000000n)
  })
  throw error
}
retainUsedBuiltinPaths(projectFile, result.sourceFileNames)
// The boxed population in the goal's own units (`scripts/boxed-cells.mjs`).
// The representation plan exists before certify, so this also reports on a
// build that stops there.
if (process.env.GEA_BOXED_CELLS) {
  const { reportBoxedCells } = await import('./boxed-cells.mjs')
  reportBoxedCells({
    result,
    displayPath,
    ownerLocation,
    mode: process.env.GEA_BOXED_CELLS
  })
}
// Identities carry a file INDEX, not a name, so a symbol or a refusal naming
// `f66` is unreadable without this table. Printed on demand rather than always
// because a real Node program has well over a hundred files.
if (process.env.GEA_FILE_MAP) {
  for (const [identity, name] of [...result.sourceFileNames].sort((left, right) => Number(left[0].slice(1)) - Number(right[0].slice(1))))
    if (!/node_modules\/typescript\/lib\//.test(name))
      console.error(`  file  ${identity} ${name.replace(/^.*\/(node-compat|compiler)\//, '')}`)
}
{
  const missing = result.preflight.obligations.filter(
    (row) => !row.optional && (row.localStatus === 'missing' || row.localStatus === 'unsupported')
  )
  const selected = [...result.representations.plan.selected.values()]
  writeReport({
    projectFile,
    compileMs: Number((process.hrtime.bigint() - compileStarted) / 1000000n),
    operations: result.graph.operations.size,
    selected: selected.length,
    boxed: selected.filter((carrier) => carrier.kind === 'dynamic').length,
    unresolved: selected.filter((carrier) => carrier.kind === 'unresolved').length,
    violations: result.representations.violations.length,
    missingRows: missing.length,
    missingPredicates: [...new Set(missing.map((row) => row.predicate.id))].sort(),
    certificate: result.certificate ? result.certificate.id : null,
    loweringBlockers: result.loweringBlockers.map((blocker) => `${blocker.owner}: ${blocker.reason}`),
    loweringBlockerLocations: result.loweringBlockers.map((blocker) => ownerLocation(blocker.owner)),
    // `AbiProjectionBlocker` has no `owner` -- it carries `functionId` plus a
    // `location` (`compiler/src/projection/abi.ts`), the same DiagnosticLocation
    // shape a root diagnostic carries. `blocker.owner` was always `undefined`
    // here, so every ABI blocker read "undefined: <reason>". Reuse `where()`,
    // the one owner authority every other row in this report already goes
    // through, rather than inventing a second rendering just for this list.
    abiBlockers: result.abiBlockers.map(
      (blocker) => `${where({ location: blocker.location, component: blocker.functionId })}: ${blocker.reason}`
    ),
    emissionRefusals: result.emissionRefusals.map((refusal) => `${refusal.owner}: ${refusal.reason}`),
    roots: result.diagnostics.diagnostics.filter((row) => row.severity === 'root').map((row) => `${where(row)}: ${row.message}`),
    // TypeScript's own errors, separately: they are `checker/<code>/<n>` rows,
    // and a program the checker rejects is not a program the compiler failed on.
    checkerErrors: result.diagnostics.diagnostics
      .filter((row) => typeof row.id === 'string' && row.id.startsWith('checker/'))
      .map((row) => ({
        code: `TS${row.id.split('/')[1]}`,
        where: where(row),
        message: row.message
      })),
    withheld: result.diagnostics.diagnostics.filter((row) => row.message.startsWith('withheld:')).map((row) => row.message),
    // Certify-stage refusals are not diagnostics. Without this column a
    // program can fail with certificate=null, missingPredicates=[], roots=[]
    // and the corpus ladder reports `certify:unknown` with an empty reason.
    refusals: result.refusals
      .filter((row) => row.stage === 'certify')
      .slice(0, 20)
      .map((row) => `${row.key}: ${row.reason}`),
    slotDrift: result.slotDrift.slice(0, 10).map((row) => row.reason ?? `${row.source} -> ${row.slot}`),
    diagnostics: result.diagnostics.diagnostics.slice(0, 40).map((row) => `${row.severity} ${where(row)}: ${row.message}`),
    sourcePreparations: result.sourcePreparations,
    emittedLines: result.units.reduce((total, unit) => total + unit.source.split('\n').length, 0),
    emittedUnits: result.units.length,
    layout: translationUnits,
    emitted: result.units.length > 0
  })
}

if (result.units.length === 0) {
  console.error(
    result.certificate === null
      ? `[build] no certificate; ${result.preflight.totals.mandatory.missing} mandatory obligation(s) unmet`
      : `[build] certified but nothing emitted; ${result.loweringBlockers.length} lowering blocker(s), ` +
          `${result.emissionRefusals.length} emission refusal(s)`
  )
  for (const blocker of result.loweringBlockers)
    console.error(`  lowering  ${ownerLocation(blocker.owner)} ${blocker.owner}: ${blocker.reason}`)
  for (const refusal of result.emissionRefusals)
    console.error(`  emission  ${ownerLocation(refusal.owner)} ${refusal.owner}: ${refusal.reason}`)
  if (process.env.GEA_BLOCKER_SOURCES) {
    const callableSources = new Map()
    for (const operation of result.graph.operations.values()) {
      if (operation.family === 'allocation' && operation.callable && operation.functionSource) {
        callableSources.set(operation.callable, operation.functionSource)
      }
    }
    for (const row of [...result.loweringBlockers, ...result.emissionRefusals]) {
      const fileIdentity = row.owner.match(/\|(f\d+)\|/)?.[1]
      if (fileIdentity) {
        console.error(`  file    ${row.owner}: ${result.sourceFileNames.get(fileIdentity) ?? '<unavailable>'}`)
      }
      console.error(`  source  ${row.owner}: ${callableSources.get(row.owner)?.slice(0, 800) ?? '<unavailable>'}`)
    }
  }
  const roots = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  for (const diagnostic of roots) console.error(`  root  ${where(diagnostic)}: ${diagnostic.message}`)
  if (roots.length === 0) {
    for (const diagnostic of result.diagnostics.diagnostics.slice(0, 20)) {
      console.error(`  ${diagnostic.severity}  ${where(diagnostic)}: ${diagnostic.message}`)
    }
  }
  // Refusals are certified off the IR and are deliberately NOT diagnostics, so a
  // program can refuse to emit with an empty diagnostic report. Printing the
  // stage verdicts here is what distinguishes "nothing was wrong" from "the
  // reason is not a diagnostic" -- without them this branch is silent.
  console.error(
    `[build] planClean=${result.diagnostics.planClean} clean=${result.diagnostics.clean} ` +
      `diagnostics=${result.diagnostics.diagnostics.length} ` +
      `irBodies=${result.irBodies === null ? 'null' : result.irBodies.length} ` +
      `certification=${result.certification === null ? 'null' : 'present'} ` +
      `refusals=${result.refusals.length} abiBlockers=${result.abiBlockers.length} ` +
      `slotDrift=${result.slotDrift.length} printerDrift=${result.printerDrift.length}`
  )
  // Grouped first, then the rows. A certification refusal census runs to
  // hundreds of rows on a real Node program and they are overwhelmingly a
  // handful of REASONS repeated per parameter, so a truncated row list ranks
  // nothing: `raw-http-hello` printed 25 of 151 and every one of them was the
  // same `function-escapes` reason, hiding the other families entirely.
  const refusalFamilies = new Map()
  for (const refusal of result.refusals) {
    const family = `${refusal.stage}/${refusal.key}: ${refusal.reason}`
    refusalFamilies.set(family, (refusalFamilies.get(family) ?? 0) + 1)
  }
  for (const [family, count] of [...refusalFamilies].sort((left, right) => right[1] - left[1]))
    console.error(`  refusals ${String(count).padStart(4)}  ${family}`)
  // `certify` rows first and in full: `certifyIr` mints only when its OWN
  // refusal list is empty (`ir/certify.ts`'s `certified`), so those are the
  // rows that decide whether anything is emitted at all. Census rows are
  // reported too -- they explain a pessimistic carrier -- but they do not gate.
  for (const refusal of result.refusals.filter((row) => row.stage === 'certify')) {
    // The number in a `fn|decl|<file>|<n>` owner is a NODE ORDINAL, not a
    // character offset -- `request.ts`'s body readers printed as `:36`, the
    // middle of a comment, when this slice()d the file by it. The compile
    // result's own `locationOfDeclaration` is the one authority that resolves a
    // declaration owner to a line, and `ownerLocation` above already asks it;
    // an `op|node|...` owner has no location and prints its file alone.
    console.error(`  certify  ${ownerLocation(refusal.owner)} ${refusal.owner}: ${refusal.reason}`)
  }
  // A `print` refusal names identities and nothing else -- `decl|f74|400`,
  // `node|f72|Identifier|58` -- and an identity carries no file name, so the
  // row on its own cannot be read back to a source location. Every `fNN` that
  // appears anywhere in the row resolves through the same table the certify
  // rows use, which is the difference between "some file" and the file to open.
  for (const refusal of result.refusals.filter((row) => row.stage === 'print')) {
    const row = JSON.stringify(refusal)
    const files = [...new Set(row.match(/f\d+/g) ?? [])]
      .map((identity) => `${identity}=${(result.sourceFileNames.get(identity) ?? '<unavailable>').replace(/^.*\/node-compat\//, '')}`)
      .join(' ')
    console.error(`  print    ${files}`)
  }
  // Raised from 25: a program the size of hono-bridge spreads its census
  // refusals over 20+ owners, and the family rollup above already ranks the
  // reasons -- what a truncated row list was hiding was WHICH declarations
  // carry each reason, needed to group refusals by (file, function, reason).
  for (const refusal of result.refusals.filter((row) => row.stage !== 'certify').slice(0, 250))
    console.error(`  refusal  ${JSON.stringify(refusal).slice(0, 400)}`)
  // A drift row names its operation and block by identity only; the file and
  // the reason are what make it readable, so each row leads with the file its
  // operation sits in and keeps the reason whole, eliding the long carriers.
  for (const drift of result.slotDrift.slice(0, 15)) {
    const file = String(drift.operation ?? '').match(/\|(f\d+)\|/)?.[1]
    const name = file ? (result.sourceFileNames.get(file) ?? '<unavailable>').replace(/^.*\/node-compat\//, '') : '<no file>'
    const { source, slot, ...rest } = drift
    console.error(`  drift    ${name} ${JSON.stringify(rest).slice(0, 1200)}`)
    console.error(`           slot=${String(slot).slice(0, 300)} source=${String(source).slice(0, 300)}`)
    console.error(`           reason ends: ${String(drift.reason ?? '').slice(-900)}`)
  }
  for (const blocker of result.abiBlockers.slice(0, 10)) console.error(`  abi      ${JSON.stringify(blocker).slice(0, 400)}`)
  process.exit(1)
}

// Angle brackets are deliberate: a quoted include searches the generated
// source's own directory before every `-I` path, allowing a runtime header
// copied there by an older build to shadow the current host ABI.
const entrySource = `#include <gea_node.hpp>
int main(int argc, char **argv) {
return gea::node::run_compiled_program(argc, argv, __gea_top_level);
}`
const emittedUnits = result.units.map((unit) => ({
  ...unit,
  source:
    unit.role === 'unit' || unit.role === 'program'
      ? `#define GEA_NODE_IMPLEMENTATION 1\n${unit.source.trimEnd()}\n${entrySource}\n`
      : `${unit.source.trimEnd()}\n`
}))
for (const unit of emittedUnits) fs.writeFileSync(path.join(outDir, unit.fileName), unit.source)
const generatedFiles = emittedUnits.map((unit) => unit.fileName)
for (const staleName of [
  ...previousGeneratedFiles,
  'server.cpp',
  'main.cpp',
  'gea_runtime.h',
  'gea_dynamic_proxy.h',
  'gea_eval.h',
  // Older builders copied this source-owned host header into the output
  // directory. The emitted host preamble uses a quoted include, whose first
  // lookup is that directory, so remove the obsolete copy before linking.
  'gea_node.hpp'
]) {
  const stalePath = path.join(outDir, staleName)
  if (!generatedFiles.includes(staleName) && fs.existsSync(stalePath)) fs.rmSync(stalePath)
}
writeReport({
  units: emittedUnits.map(({ role, fileName, sourceFile }) => ({
    role,
    fileName,
    sourceFile
  })),
  generatedFiles
})
if (emittedUnits.length === 1) {
  console.error(
    `[build] emitted ${displayPath(path.join(outDir, emittedUnits[0].fileName))} (${emittedUnits[0].source.split('\n').length} lines)`
  )
} else {
  console.error(`[build] emitted ${emittedUnits.length} C++ files in ${displayPath(outDir)}`)
}

if (emitOnly) process.exit(0)

await buildExecutable(emittedUnits, displayPath)

// ---------------------------------------------------------------------------
// Link.
// ---------------------------------------------------------------------------

// The C++ command lines, built in one place for every layout. `phase` is
// `'all'` for the one-command single-unit build (compile + link, the historical
// command, unchanged), `'compile'` for one unit's `-c` of a per-unit build, and
// `'link'` for the final link of that build's objects. A flag belongs to the
// phases that read it; the single command carries every one of them, in the
// order the pipeline always passed them.
//
// `'pch'` builds the precompiled prefix header of a split build (see
// `precompiledPrefix`): exactly the compile phase's flags -- a PCH is rejected,
// or worse silently mis-read, by a unit compiled with a different language
// dialect, optimization level or visibility -- with `-x c++-header` in place of
// `-c`. `pch` on a compile phase is that PCH's `{ file, codegen }`.
function cxxFlags({ phase, cxxIsClang, inputs, output, needsCrypto, needsZlib, pch = null }) {
  const compiling = phase !== 'link'
  const linking = phase === 'all' || phase === 'link'
  const runtimeDir = path.join(repo, 'runtime')
  const compilerRuntimeDir = path.join(compilerRoot, 'src/targets/cpp/runtime')
  // The optimization level depends on the compiler, because the answer does
  // (bench host, 2026-09-22, four pinned workers, same emitted source). clang 18:
  // `-Os -flto` is the fastest AND the smallest -- level with `-O2 -flto` on the
  // raw server (316k vs 313k req/s) and +5% on the compiled Hono app (150k vs
  // 144k; +10% at one worker), at 30% smaller binaries (1.82 MB / 5.47 MB) and
  // less memory. Hono executes more instructions at -Os but fewer cycles: the
  // hot path is instruction-cache bound, and smaller code wins. `-O3` bought
  // nothing on either compiler. g++ 13 is the opposite: `-Os` costs 25%, so it
  // keeps `-O2`. LTO helps both (clang: +3% and -4% size over plain `-O2`).
  // clang on Linux needs the gold plugin for LTO (ld.bfd has no LLVM plugin and
  // lld is not installed everywhere). GEA_OPT_LEVEL overrides the level,
  // GEA_LTO=0 drops the LTO, for a profile or a bisect; GEA_LTO=thin selects
  // ThinLTO (see `ltoMode`). Under LTO a per-unit
  // `-c` writes bitcode, so the link step passes the level and `-flto` again:
  // that is where the code is generated.
  const lto = phase === 'pch' ? null : ltoMode(phase, cxxIsClang)
  return [
    ...(compiling ? ['-std=c++20'] : []),
    // The reactor is one thread and the DNS lookup thread touches no runtime
    // object, so the runtime's per-thread state (pool free lists, collector
    // buffer, safepoint flag) can be plain statics: on macOS each
    // `thread_local` read was a `_tlv_get_addr` call, two per allocation.
    ...(compiling ? ['-DGEA_RUNTIME_SINGLE_THREADED=1'] : []),
    // Extra preprocessor definitions for a measurement build (for example
    // `GEA_CXX_DEFINES=-DGEA_MEASURE_NEVER_FREE`, the upper bound on what any
    // collector could save); never set for a shipping build.
    ...(compiling && process.env.GEA_CXX_DEFINES ? process.env.GEA_CXX_DEFINES.split(' ').filter(Boolean) : []),
    // The instrumented PGO phase only has to run the training workload, and the
    // counters are inserted by the front end before any optimization, so the
    // profile does not depend on the level (GEA_PGO_GENERATE_OPT overrides).
    // mongodb driver on the 8-thread box: the heaviest unit (records.part-3)
    // compiles in 50 s at -O0 against 110 s at -O1, the whole -O1 phase took
    // 15.5 min, and training at -O1 took 80 s -- the slower -O0 binary costs
    // far less than the compile it saves.
    optimize
      ? process.env.GEA_PGO_GENERATE && cxxIsClang
        ? (process.env.GEA_PGO_GENERATE_OPT ?? '-O0')
        : (process.env.GEA_OPT_LEVEL ?? (cxxIsClang ? '-Os' : '-O2'))
      : '-O0',
    ...(lto === 'full' ? ['-flto', ...(linking && process.platform === 'linux' && cxxIsClang ? ['-fuse-ld=gold'] : [])] : []),
    ...(lto === 'thin' ? ['-flto=thin', ...(linking ? thinLtoLinkFlags() : [])] : []),
    ...(!optimize ? ['-g'] : []),
    // Symbols are for a profile, and a profile builds with -O0 -g above. An
    // optimized binary ships stripped: on the raw server the symbol table was
    // 1.16 MB of a 3.87 MB file.
    // GEA_SYMBOLS=1 keeps the symbol table on an optimized binary so `sample` /
    // `perf` can name the hot functions of a release-shaped build.
    // --bolt rewrites the linked executable from a sampled profile, and needs
    // both the symbol table and the relocations (`--emit-relocs`) to move whole
    // functions rather than only the blocks inside them; it strips afterwards.
    ...(linking && optimize && !process.env.GEA_SYMBOLS && !bolt ? (process.platform === 'darwin' ? ['-Wl,-S,-x'] : ['-s']) : []),
    ...(linking && bolt ? ['-Wl,--emit-relocs'] : []),
    // A symbols build is a profile build, and ld64 folds identical functions
    // by default: every `RefOperationsFor<X>::destroy` with the same body
    // becomes one `<deduplicated_symbol>` frame, 3% of the driver's samples
    // that no source can be found for. Keep every function under its own name.
    ...(linking && optimize && process.env.GEA_SYMBOLS && process.platform === 'darwin' ? ['-Wl,-no_deduplicate'] : []),
    // Size: the unit is one whole program, so nothing outside it may bind to
    // its symbols. Hidden visibility says so to the compiler and lets the
    // linker drop every function and constant the program never reaches
    // (the runtime header compiles in far more than one server uses). Measured
    // on the raw server: 963 KB -> 729 KB at -O2 with identical codegen for the
    // reached code; `-Os` would take another ~22% but is a throughput question,
    // so it stays behind `GEA_OPT_LEVEL`.
    ...(compiling ? ['-fvisibility=hidden', '-fvisibility-inlines-hidden'] : []),
    ...(process.platform === 'darwin'
      ? linking
        ? ['-Wl,-dead_strip']
        : []
      : [...(compiling ? ['-ffunction-sections', '-fdata-sections'] : []), ...(linking ? ['-Wl,--gc-sections'] : [])]),
    // Runtime headers are authoritative source inputs. Build directories can
    // contain headers copied by an older toolchain run, so searching `outDir`
    // first can silently compile current C++ against a stale host ABI. Keep the
    // generated-unit directory available for generated support headers, after
    // the compiler and node-compat runtime roots.
    ...(compiling ? [`-I${compilerRuntimeDir}`, `-I${runtimeDir}`, `-I${path.join(runtimeDir, 'node')}`, `-I${outDir}`] : []),
    // Escape hatch for one-off builds that need a flag the pipeline does not
    // model -- `-g` for a profile or an allocation census, `-fsanitize=...` for
    // a leak hunt. Whitespace-separated, appended last so it can override an
    // earlier flag. Not for anything a build should depend on. Passed to every
    // phase: a sanitizer needs both the compile and the link.
    // Profile-guided optimization, clang's instrumentation form. Two builds
    // of one emission: GEA_PGO_GENERATE=<dir> instruments (run the binary
    // with `LLVM_PROFILE_FILE=<dir>/%p.profraw`, then `xcrun llvm-profdata
    // merge -output=<dir>/merged.profdata <dir>/*.profraw`); GEA_PGO_USE=
    // <merged.profdata> optimizes with the result. `--link-only` makes the
    // second build skip the emission. Measured on the mongodb driver
    // benchmark (2026-09-26, clang 21, -O2 -flto, same emission): 22% less
    // client CPU, min-of-3 11.74 s against 15.13 s -- the emitted code is
    // branchy and instruction-cache bound, which is exactly what layout and
    // inlining from a real profile fix. Both phases get the flags: under LTO
    // the code is generated at the link. The `unprofiled`/`out-of-date`
    // warnings are per function and would drown a build whose profile came
    // from a workload that never reached some of it.
    // The PCH is parsed source, not code: profile flags change nothing it holds,
    // so it is built without them and one PCH serves the instrumented, the
    // optimized and the plain build (a cache miss between phases was 28 s).
    ...(process.env.GEA_PGO_GENERATE && phase !== 'pch'
      ? [`-fprofile-instr-generate=${path.join(path.resolve(process.env.GEA_PGO_GENERATE), '%p.profraw')}`]
      : []),
    ...(process.env.GEA_PGO_USE && phase !== 'pch'
      ? [`-fprofile-instr-use=${path.resolve(process.env.GEA_PGO_USE)}`, '-Wno-profile-instr-unprofiled', '-Wno-profile-instr-out-of-date']
      : []),
    // With a profile, lay basic blocks out by ext-TSP (fall-through and
    // instruction-cache locality weighted by the profile's edge counts)
    // rather than the default chain placement. The driver is front-end bound
    // (~60% of its cycles are instruction delivery), and under full LTO block
    // placement runs at the link. Mongodb driver benchmark, same emission and
    // profile, 3 interleaved pairs on a loaded box: fewer cycles in every
    // pair, instructions unchanged.
    ...(process.env.GEA_PGO_USE && linking && lto !== null && cxxIsClang && process.platform === 'darwin'
      ? ['-Wl,-mllvm,-enable-ext-tsp-block-placement=true']
      : []),
    ...(process.env.GEA_CXX_EXTRA ? process.env.GEA_CXX_EXTRA.trim().split(/\s+/) : []),
    // The same escape hatch for the link alone -- a linker flag such as
    // `-Wl,-order_file,<file>` is an error on a `-c` or PCH compile.
    ...(linking && process.env.GEA_LINK_EXTRA ? process.env.GEA_LINK_EXTRA.trim().split(/\s+/) : []),
    // A re-emission rewrites server.hpp with the same bytes and a new mtime;
    // clang's default mtime check would then reject a PCH whose content cache
    // key (`precompiledPrefix`) says it is current. Validate by content instead.
    // `-fno-pch-timestamp` keeps the PCH bytes reproducible (ccache hashes them).
    ...(phase === 'pch' || pch ? ['-fpch-validate-input-files-content', '-Xclang', '-fno-pch-timestamp'] : []),
    ...(phase === 'pch'
      ? [
          '-fpch-instantiate-templates',
          ...(pch?.codegen ? ['-fpch-codegen', '-fpch-debuginfo'] : []),
          '-MD',
          '-MF',
          `${output}.d`,
          '-x',
          'c++-header'
        ]
      : []),
    ...(pch?.file && phase === 'compile' ? ['-include-pch', pch.file] : []),
    ...(phase === 'compile' ? ['-c'] : []),
    ...inputs,
    // node:net's lookup resolves on a detached pthread (`net_resolve_native`);
    // glibc before 2.34 keeps pthread_create out of libc.
    ...(process.platform === 'linux' ? ['-pthread'] : []),
    ...(linking && process.platform === 'linux' && needsCrypto ? ['-lcrypto'] : []),
    ...(linking && needsZlib ? ['-lz'] : []),
    '-o',
    output
  ]
}

// The LTO flavour of one phase: null (none), 'full' or 'thin'. GEA_LTO=0 drops
// LTO, GEA_LTO=full|1 and GEA_LTO=thin force a flavour; unset, the default is
// `splitDefault` below for the phases of a split (per-unit) build and full LTO
// for the one-command single-unit build. ThinLTO is clang-only.
//
// Why ThinLTO for a split build: full LTO merges every unit's bitcode into one
// module and optimizes and code-generates it on ONE thread, so the link of a
// many-unit program is a serial wall however many cores the per-unit compiles
// had. ThinLTO keeps the units separate, imports across them from a summary,
// and runs the backends in parallel (and caches them, see `thinLtoLinkFlags`).
// A single unit has nothing to parallelize, so it keeps full LTO.
//
// It is NOT the default, from measurements (Apple clang 21, ld-1267, 16 cores,
// 2026-09-24; the box was shared, load 16-110, so walls are noisy):
// - mongodb driver probe, 273 units, PCH, cold: final link full 470/737/752 s
//   vs thin 316/632/786 s -- no clear win. Thin's critical path is ONE module,
//   the program unit server.cpp (40 MB of bitcode, 15 MB of native code), whose
//   backend is serial like the full-LTO link. Thin costs more total CPU (build
//   user 4.1-4.6k s vs 3.2-3.6k s) but a quarter of the link memory (peak RSS
//   7.2 GB vs 24.5 GB).
// - size: thin is larger, 80.1 MB vs 75.8 MB (+5.6%) on the probe, 2.33 MB vs
//   2.17 MB (+7.7%) on apps/http-parity. Both print PING:1; http-parity passes
//   38/38 either way, and wrk (8 alternating rounds, /plain) cannot tell their
//   throughput apart (paired mean -2%, noise +-40%).
// - relink: where thin wins outright. With the cache warm, relinking unchanged
//   objects takes 6.5 s, and after a change to one unit 111 s (6 backends
//   re-ran, server.cpp's among them) -- a full-LTO relink is the whole
//   470+ s every time. So GEA_LTO=thin is the setting for an edit-relink loop.
// (A function-local constant: `--link-only` runs before any top-level `let` or
// `const` this far down is initialized.)
function ltoMode(phase, cxxIsClang) {
  const splitDefault = 'full'
  if (!optimize) return null
  const requested = process.env.GEA_LTO
  if (requested === '0') return null
  if (requested === 'thin') return cxxIsClang ? 'thin' : 'full'
  if (requested === 'full' || requested === '1') return 'full'
  if (requested) throw new Error(`GEA_LTO must be 0, full or thin (got ${requested})`)
  if (phase === 'all' || !cxxIsClang) return 'full'
  // --pgo builds of a split program. The instrumented executable only has to
  // run the training workload: instrumentation is inserted by the front end
  // (before any optimization), so the profile it writes is valid for the
  // optimized build whatever this build's LTO was, and the instrumented phase
  // needs no LTO at all -- each unit is code-generated in its own parallel
  // compile and the link is a plain link (it was the serial full-LTO link, 500 s
  // on the bench box). GEA_PGO_GENERATE_LTO=1 keeps the old shape.
  if (process.env.GEA_PGO_GENERATE && process.env.GEA_PGO_GENERATE_LTO !== '1') return null
  // The optimized phase defaults to ThinLTO: the full-LTO link is one thread
  // (~11 min on the bench box), the ThinLTO backends run on every core.
  // GEA_LTO=full restores full LTO for a final release build.
  if (process.env.GEA_PGO_USE) return 'thin'
  return splitDefault
}

// ThinLTO link flags: backend parallelism (GEA_LTO_JOBS, default every core)
// and an incremental cache in `<out>/lto-cache`, so a relink after a change to
// a few units re-runs only the backends whose inputs (the module and what it
// imported) moved. macOS ld64 hands both to libLTO (`-mllvm -threads`,
// `-cache_path_lto`); Linux clang links through the gold plugin as the full-LTO
// path does (`-plugin-opt`), or through lld with GEA_LD=lld.
function thinLtoLinkFlags() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  const jobs = Math.max(1, Number.parseInt(process.env.GEA_LTO_JOBS ?? '', 10) || cores)
  const cache = path.join(outDir, 'lto-cache')
  if (process.platform === 'darwin') return [`-Wl,-mllvm,-threads=${jobs}`, `-Wl,-cache_path_lto,${cache}`]
  if (process.env.GEA_LD === 'lld') return ['-fuse-ld=lld', `-Wl,--thinlto-jobs=${jobs}`, `-Wl,--thinlto-cache-dir=${cache}`]
  return ['-fuse-ld=gold', `-Wl,-plugin-opt,jobs=${jobs}`, `-Wl,-plugin-opt,cache-dir=${cache}`]
}

// Runs `cxx` with `flags`, resolving to { ok, ms, stderr }. Asynchronous so
// the per-unit compiles of a split build run side by side. Under ccache
// (`ccacheCommand`) the command is `ccache <cxx> <flags>`.
function runCxx(cxx, flags) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const ccache = ccacheCommand()
    const child = ccache
      ? spawn(ccache.file, [cxx, ...flags], {
          stdio: ['ignore', 'inherit', 'pipe'],
          env: ccache.env
        })
      : spawn(cxx, flags, { stdio: ['ignore', 'inherit', 'pipe'] })
    const chunks = []
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    const done = (ok, extra = '') =>
      resolve({
        ok,
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
        stderr: Buffer.concat(chunks).toString() + extra
      })
    child.on('error', (error) => done(false, `${error}`))
    child.on('close', (code, signal) => done(code === 0, signal ? `killed by ${signal}` : ''))
  })
}

// ccache, opt-in: GEA_CCACHE=1 wraps every C++ command in the `ccache` found on
// PATH (a build fails loudly if there is none; nothing is installed). It pays
// only when a unit's exact inputs recur -- a `--link-only` retried with no
// change, or the units of a re-emission whose bytes did not move -- because
// every unit includes the emitted server.hpp, and a program change rewrites it.
// A PCH-using compile is only cacheable with the sloppiness ccache documents
// for precompiled headers; the PCH itself is keyed by its content, and
// `-fno-pch-timestamp` (see `cxxFlags`) keeps that content reproducible.
// (Memoized on the function itself: `--link-only` runs before any top-level
// `let` below this point is initialized.)
function ccacheCommand() {
  if (ccacheCommand.resolved !== undefined) return ccacheCommand.resolved
  ccacheCommand.resolved = null
  if (process.env.GEA_CCACHE !== '1') return null
  const file = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, 'ccache'))
    .find((candidate) => fs.existsSync(candidate))
  if (!file) throw new Error('GEA_CCACHE=1 but no ccache on PATH')
  const sloppiness = new Set(
    [...(process.env.CCACHE_SLOPPINESS ?? '').split(','), 'pch_defines', 'time_macros', 'include_file_mtime', 'include_file_ctime'].filter(
      Boolean
    )
  )
  ccacheCommand.resolved = {
    file,
    env: { ...process.env, CCACHE_SLOPPINESS: [...sloppiness].join(',') }
  }
  return ccacheCommand.resolved
}

// The precompiled prefix of a split build. Every emitted unit but the program
// unit starts with the same line, `#include "server.hpp"`, and that header is
// the whole common prefix: the runtime headers (gea_node.hpp and the compiler's
// gea_runtime.h, which the program pulls in through server.runtime.hpp) plus
// the program's own declarations -- 8 MB on the mongodb driver. Parsing it was
// 2-3 s and most of the ~800 MB of every unit, however small the unit.
//
// So the header named by that shared first line is compiled once into
// `<out>/<header>.pch`, and every unit that begins with exactly that line is
// compiled with `-include-pch`; its own `#include` is then a no-op (the header
// is `#pragma once`). A unit that begins differently -- the program unit opens
// with `#define GEA_NODE_IMPLEMENTATION 1`, which changes what gea_node.hpp
// defines -- compiles without it, as before.
//
// The PCH survives across builds (`--link-only` above all) while its inputs do
// not move: `<pch>.key` records a hash of the exact PCH command, the compiler's
// identity, and the CONTENT of every file the PCH read (clang's own `-MD` list),
// so a re-emission that rewrites server.hpp with the same bytes reuses it and
// one that changes a byte of any runtime header rebuilds it.
//
// `codegen`: clang's modular codegen (`-fpch-codegen -fpch-debuginfo`) emits
// the header's inline functions and pre-instantiated templates ONCE, into
// `<pch>.o`, instead of in every unit that uses them. It is the larger half of
// the saving at -O0, and is on for `--debug` builds. An optimized build keeps
// it off by default: without LTO, a unit could no longer inline a runtime
// function whose body lives in another object. GEA_PCH_CODEGEN=0|1 overrides;
// GEA_PCH=0 disables the PCH entirely.
function precompiledPrefix(sources, cxxIsClang) {
  if (process.env.GEA_PCH === '0' || !cxxIsClang || sources.length < 2) return null
  const firstLines = new Map()
  for (const source of sources) {
    const text = fs.readFileSync(source, 'utf8')
    const end = text.indexOf('\n')
    const line = end < 0 ? text : text.slice(0, end)
    if (!firstLines.has(line)) firstLines.set(line, [])
    firstLines.get(line).push(source)
  }
  const [line, users] = [...firstLines].sort((a, b) => b[1].length - a[1].length)[0]
  const header = /^#include "([^"/]+\.hpp)"\s*$/.exec(line)?.[1]
  if (!header || users.length < 2 || !fs.existsSync(path.join(outDir, header))) return null
  const codegen = process.env.GEA_PCH_CODEGEN ? process.env.GEA_PCH_CODEGEN === '1' : !optimize
  const file = path.join(outDir, `${header}.pch`)
  return {
    header: path.join(outDir, header),
    file,
    object: codegen ? `${file}.o` : null,
    codegen,
    users: new Set(users)
  }
}

// Unchanged units are free. A unit's object is reused when the exact command,
// the compiler's identity, the profile (if any) and the CONTENT of every file
// the previous compile read (clang's `-MD` list, plus the PCH) are the same as
// when that object was made -- the same content key the PCH uses, per unit, with
// no ccache needed. `<obj>.key` holds it; GEA_UNIT_CACHE=0 turns it off.
// (The cache is a property of the function: this build runs at module top level
// before any `const` this far down is initialized.)
function fileContentHash(file) {
  const fileContentHashes = (fileContentHash.cache ??= new Map())
  let hash = fileContentHashes.get(file)
  if (hash === undefined) {
    hash = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
    fileContentHashes.set(file, hash)
  }
  return hash
}
function unitKey(identity, inputs) {
  const hash = crypto.createHash('sha256').update(identity)
  for (const file of [...inputs].sort()) {
    const content = fileContentHash(file)
    if (content === null) return null
    hash.update(`\0${file}\0${content}`)
  }
  return hash.digest('hex')
}
async function compileUnitCached(cxx, flags, object, pchFile) {
  if (process.env.GEA_UNIT_CACHE === '0') return runCxx(cxx, flags)
  if (compileUnitCached.version === undefined) compileUnitCached.version = spawnSync(cxx, ['--version'], { encoding: 'utf8' }).stdout ?? ''
  const identity = JSON.stringify({
    cxx,
    version: compileUnitCached.version,
    flags,
    profile: process.env.GEA_PGO_USE ? fileContentHash(path.resolve(process.env.GEA_PGO_USE)) : null
  })
  const keyFile = `${object}.key`
  try {
    const recorded = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
    if (fs.existsSync(object) && recorded.key === unitKey(identity, recorded.inputs)) return { ok: true, ms: 0, stderr: '', cached: true }
  } catch {}
  fs.rmSync(keyFile, { force: true })
  const depFile = `${object}.d`
  const outcome = await runCxx(cxx, [...flags, '-MD', '-MF', depFile])
  if (outcome.ok) {
    try {
      const inputs = dependencyFileInputs(depFile).map((file) => path.resolve(file))
      if (pchFile) inputs.push(pchFile)
      const key = unitKey(identity, inputs)
      if (key) fs.writeFileSync(keyFile, `${JSON.stringify({ key, inputs })}\n`)
    } catch {}
  }
  return outcome
}

function contentHashOfInputs(identity, files) {
  const hash = crypto.createHash('sha256').update(identity)
  for (const file of [...files].sort()) {
    if (!fs.existsSync(file)) return null
    hash.update(`\0${file}\0`).update(fs.readFileSync(file))
  }
  return hash.digest('hex')
}

// Paths from a make-style dependency file (`-MD`), unescaping `\ `.
function dependencyFileInputs(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ')
  const body = text.slice(text.indexOf(': ') + 2)
  return (body.match(/(?:\\ |[^\s])+/g) ?? []).map((entry) => entry.replace(/\\ /g, ' '))
}

// Builds `prefix` (from `precompiledPrefix`) unless its recorded key says the
// PCH on disk is current. Resolves to { ok, reused, ms, stderr }.
async function buildPrecompiledPrefix(prefix, cxx, common) {
  const started = process.hrtime.bigint()
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1000000n)
  const flags = cxxFlags({
    ...common,
    phase: 'pch',
    inputs: [prefix.header],
    output: prefix.file,
    pch: { codegen: prefix.codegen }
  })
  const objectFlags = prefix.codegen
    ? cxxFlags({
        ...common,
        phase: 'compile',
        inputs: [prefix.file],
        output: prefix.object,
        pch: { codegen: true }
      })
    : null
  const version = spawnSync(cxx, ['--version'], { encoding: 'utf8' }).stdout ?? ''
  const identity = JSON.stringify({
    cxx,
    version,
    flags,
    objectFlags,
    extra: process.env.GEA_CXX_EXTRA ?? ''
  })
  const keyFile = `${prefix.file}.key`
  const outputs = [prefix.file, ...(prefix.object ? [prefix.object] : [])]
  try {
    const recorded = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
    if (outputs.every((file) => fs.existsSync(file)) && recorded.key === contentHashOfInputs(identity, recorded.inputs)) {
      return { ok: true, reused: true, ms: elapsed(), stderr: '' }
    }
  } catch {}
  fs.rmSync(keyFile, { force: true })
  if (verbose) console.error(`[build] ${cxx} ${flags.join(' ')}`)
  const built = await runCxx(cxx, flags)
  if (!built.ok) return { ok: false, reused: false, ms: elapsed(), stderr: built.stderr }
  if (objectFlags) {
    if (verbose) console.error(`[build] ${cxx} ${objectFlags.join(' ')}`)
    const object = await runCxx(cxx, objectFlags)
    if (!object.ok)
      return {
        ok: false,
        reused: false,
        ms: elapsed(),
        stderr: built.stderr + object.stderr
      }
  }
  const inputs = dependencyFileInputs(`${prefix.file}.d`).map((file) => path.resolve(outDir, file))
  fs.writeFileSync(keyFile, `${JSON.stringify({ key: contentHashOfInputs(identity, inputs), inputs })}\n`)
  return { ok: true, reused: false, ms: elapsed(), stderr: built.stderr }
}

// Compiles and links `units` ({ fileName, source }) from `outDir` into
// `exePath`. One `.cpp` unit is one command, as it always was. Several are
// compiled concurrently -- one `-c` per unit, objects beside the units, at
// most GEA_JOBS at once (default: every core, memory permitting) -- and then linked once.
// Links `units` into `--exe`, profile-guided when `--pgo`/`--pgo-train` asks.
//
// PGO is the largest single lever the emitted code has: on the mongodb driver
// benchmark it removed 22% of the client CPU on macOS and ~26% of the cycles on
// the Haswell bench host, and it does it through block layout rather than
// inlining (an -inline-threshold=1000 build without a profile recovered none of
// it). The emitted program is large and branchy and bound by instruction
// delivery; only a profile says which side of each branch is the hot one. Doing
// the three steps here rather than in a per-app script means every node-compat
// build gets it by one flag, and the profile can never come from an emission
// other than the one it optimizes: all three steps read the same units.
//
// The instrumented executable writes `<out>/pgo/<pid>.profraw` (clang's
// `%p`, one file per process, so a training command that starts the program
// several times -- or a multi-worker server -- accumulates rather than
// overwrites); `llvm-profdata merge` folds them into `<out>/pgo/merged.profdata`,
// and the final link compiles every unit again with `-fprofile-instr-use`.
// Instrumentation is inserted by the front end, so no object is shared between
// the two links; under full LTO the code is generated at the link either way.
async function buildExecutable(units, displayPath) {
  const trainCommand = arg('--pgo-train', null)
  if (!trainCommand && !process.argv.includes('--pgo')) {
    const linked = await linkUnits(units, displayPath, exePath)
    if (bolt) boltExecutable(trainCommand, displayPath)
    return linked
  }
  if (!optimize) throw new Error('--pgo needs an optimized build (drop --debug)')
  if (process.env.GEA_PGO_GENERATE || process.env.GEA_PGO_USE)
    throw new Error('--pgo runs both PGO phases; unset GEA_PGO_GENERATE/GEA_PGO_USE')
  const cxx = process.env.CXX ?? 'clang++'
  const profdata = llvmProfdataCommand(cxx)
  const profileDir = path.join(outDir, 'pgo')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const instrumented = `${exePath}-instrumented`
  const started = process.hrtime.bigint()
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1000000n)

  console.error('[build] pgo 1/3: instrumented link')
  process.env.GEA_PGO_GENERATE = profileDir
  await linkUnits(units, displayPath, instrumented)
  delete process.env.GEA_PGO_GENERATE

  console.error(`[build] pgo 2/3: training ${trainCommand ? `with \`${trainCommand}\`` : `by running ${displayPath(instrumented)}`}`)
  const trainEnv = {
    ...process.env,
    GEA_PGO_EXE: instrumented,
    LLVM_PROFILE_FILE: path.join(profileDir, '%p.profraw')
  }
  const training = trainCommand
    ? spawnSync(trainCommand, {
        shell: true,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: trainEnv
      })
    : spawnSync(instrumented, [], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: trainEnv
      })
  const raws = fs.readdirSync(profileDir).filter((file) => file.endsWith('.profraw'))
  // A training run that fails still leaves a usable profile of what it did
  // reach; one that wrote nothing would silently optimize for nothing.
  if (training.error) throw new Error(`--pgo training could not start: ${training.error.message}`)
  if (training.status !== 0)
    console.error(`[build] WARNING: pgo training exited ${training.status ?? training.signal}; using its partial profile`)
  if (raws.length === 0) throw new Error(`--pgo training wrote no profile to ${displayPath(profileDir)}`)
  const merged = path.join(profileDir, 'merged.profdata')
  const merge = spawnSync(
    profdata[0],
    [...profdata.slice(1), 'merge', `-output=${merged}`, ...raws.map((file) => path.join(profileDir, file))],
    {
      encoding: 'utf8'
    }
  )
  if (merge.status !== 0) throw new Error(`llvm-profdata merge failed:\n${merge.stderr ?? merge.error?.message}`)

  console.error(`[build] pgo 3/3: optimized link from ${raws.length} profile(s)`)
  process.env.GEA_PGO_USE = merged
  await linkUnits(units, displayPath, exePath)
  delete process.env.GEA_PGO_USE
  fs.rmSync(instrumented, { force: true })
  if (bolt) boltExecutable(trainCommand, displayPath)
  writeReport({
    pgo: {
      profiles: raws.length,
      profile: merged,
      trainCommand,
      trainingStatus: training.status,
      totalMs: elapsed()
    }
  })
}

// --bolt: after the (profile-guided) link, run the training workload once
// more under `perf record` with last-branch records, and let llvm-bolt lay the
// executable out again from what the hardware actually executed -- functions
// reordered by call-graph locality, hot and cold blocks split apart. PGO chose
// block order per function at compile time; BOLT sees the final machine code
// of the whole 28 MB image, which is what an instruction-delivery-bound
// program (the mongodb driver loses most of its cycles waiting on the front
// end) is limited by. Linux x86-64 only: it needs `perf` with LBR and
// llvm-bolt/perf2bolt (GEA_LLVM_BOLT names the llvm-bolt to use; perf2bolt is
// looked up beside it).
function boltExecutable(trainCommand, displayPath) {
  if (process.platform !== 'linux') throw new Error('--bolt needs Linux (perf LBR + llvm-bolt)')
  const boltTool = boltCommand()
  const perf2bolt = path.join(path.dirname(boltTool), 'perf2bolt')
  const boltDir = path.join(outDir, 'bolt')
  fs.rmSync(boltDir, { recursive: true, force: true })
  fs.mkdirSync(boltDir, { recursive: true })
  const perfData = path.join(boltDir, 'perf.data')
  const fdata = path.join(boltDir, 'profile.fdata')
  const bolted = `${exePath}.bolt`
  console.error(`[build] bolt 1/3: sampling ${trainCommand ? `\`${trainCommand}\`` : displayPath(exePath)}`)
  // A cycles period rather than perf's default 4 kHz: llvm-bolt asked for ~17x
  // more samples than the default gave on the driver's one-minute run.
  const record = ['record', '-q', '-e', 'cycles:u', '-c', '200003', '-j', 'any,u', '-o', perfData, '--']
  const training = trainCommand
    ? spawnSync('perf', [...record, 'sh', '-c', trainCommand], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, GEA_PGO_EXE: exePath }
      })
    : spawnSync('perf', [...record, exePath], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (training.error) throw new Error(`--bolt: perf record could not start: ${training.error.message}`)
  if (training.status !== 0) console.error(`[build] WARNING: bolt training exited ${training.status ?? training.signal}; using its partial profile`)
  console.error('[build] bolt 2/3: converting the profile')
  // Both tools print a warning per oddly shaped function -- megabytes on a
  // 28 MB program, past spawnSync's 1 MB default buffer, which kills the child.
  const boltOutput = { encoding: 'utf8', maxBuffer: 1 << 30 }
  const convert = spawnSync(perf2bolt, ['-p', perfData, '-o', fdata, exePath], boltOutput)
  if (convert.status !== 0) throw new Error(`perf2bolt failed:\n${boltTail(convert)}`)
  console.error('[build] bolt 3/3: rewriting the executable')
  const rewrite = spawnSync(
    boltTool,
    [
      exePath,
      '-o',
      bolted,
      `-data=${fdata}`,
      '-reorder-blocks=ext-tsp',
      '-reorder-functions=cdsort',
      '-split-functions',
      '-split-all-cold',
      '-split-eh',
      '-icf=1',
      '-use-gnu-stack',
      // The hot text is a few MB of a 55 MB image; with 4 KB pages every op
      // walks hundreds of iTLB entries. -hugify links BOLT's runtime that
      // remaps the hot section onto 2 MB pages at startup (needs THP madvise).
      ...(process.env.GEA_BOLT_HUGIFY === '0' ? [] : ['-hugify']),
      '-dyno-stats'
    ],
    boltOutput
  )
  if (rewrite.status !== 0) throw new Error(`llvm-bolt failed:\n${boltTail(rewrite)}`)
  if (!process.env.GEA_SYMBOLS) {
    const strip = spawnSync('strip', [bolted], { encoding: 'utf8' })
    if (strip.status !== 0) throw new Error(`strip failed:\n${strip.stderr ?? strip.error?.message}`)
  }
  // Keep the input image beside its profile: a later re-layout (other BOLT
  // flags) reruns llvm-bolt alone instead of the whole build.
  fs.renameSync(exePath, path.join(boltDir, 'input'))
  fs.renameSync(bolted, exePath)
  fs.rmSync(perfData, { force: true })
}

function boltTail(result) {
  if (result.error) return result.error.message
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => !line.startsWith('BOLT-WARNING'))
  return lines.slice(-20).join('\n')
}

function boltCommand() {
  if (process.env.GEA_LLVM_BOLT) return process.env.GEA_LLVM_BOLT
  const candidates = ['llvm-bolt']
  for (const dir of fs.existsSync('/usr/lib') ? fs.readdirSync('/usr/lib') : []) {
    if (/^llvm-\d+$/.test(dir)) candidates.push(path.join('/usr/lib', dir, 'bin', 'llvm-bolt'))
  }
  for (const candidate of candidates.reverse()) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate
  }
  throw new Error(`--bolt: no llvm-bolt (tried ${candidates.join(', ')}); set GEA_LLVM_BOLT`)
}

// `llvm-profdata` of the same LLVM as `cxx`: the raw profile format is
// versioned per release, so a merge by another release's tool is rejected (or
// worse, misread). macOS reaches it through xcrun; Linux distributions install
// it suffixed with the major version beside `clang++-N`.
function llvmProfdataCommand(cxx) {
  if (process.env.GEA_LLVM_PROFDATA) return [process.env.GEA_LLVM_PROFDATA]
  if (process.platform === 'darwin' && !cxx.includes('/')) return ['xcrun', 'llvm-profdata']
  const version = spawnSync(cxx, ['--version'], { encoding: 'utf8' }).stdout ?? ''
  const major = /clang version (\d+)/.exec(version)?.[1]
  const beside = cxx.includes('/') ? path.dirname(cxx) : null
  const candidates = [
    ...(beside ? [path.join(beside, 'llvm-profdata')] : []),
    ...(major ? [`llvm-profdata-${major}`] : []),
    'llvm-profdata'
  ]
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return [candidate]
  }
  throw new Error(`--pgo: no llvm-profdata for ${cxx} (tried ${candidates.join(', ')}); set GEA_LLVM_PROFDATA`)
}

// Per-file emission gives a program one unit per source module -- 218 for the
// mongodb driver -- and each unit instantiates and optimizes its own copy of
// every runtime template and inline function it touches: on the box ~65% of a
// unit's time was the optimizer on that linkonce code, over a ~1.3 s floor an
// empty unit pays. Compiling the units in a few larger groups (a generated
// unit that includes its members) pays for each shared instantiation once per
// group instead of once per module, and the link sees as many fewer modules.
// The emitted units are external-linkage definitions under one header, so
// concatenating them is the same program. Groups stay a few per job so the
// scheduler can still balance them. Only units that start with the shared
// header line join (the program unit, which defines GEA_NODE_IMPLEMENTATION
// before it, stays alone). GEA_UNIT_GROUPS=<n> sets the count, 0 turns it off.
function groupedUnits(sources, jobs) {
  const requested = process.env.GEA_UNIT_GROUPS === undefined ? jobs * 3 : Number.parseInt(process.env.GEA_UNIT_GROUPS, 10)
  if (!(requested > 0) || sources.length <= requested * 2) return sources
  const firstLine = (source) => {
    const text = fs.readFileSync(source, 'utf8')
    const end = text.indexOf('\n')
    return end < 0 ? text : text.slice(0, end)
  }
  const byLine = new Map()
  for (const source of sources) {
    const line = firstLine(source)
    if (!line.startsWith('#include "') || !line.endsWith('.hpp"')) continue
    if (!byLine.has(line)) byLine.set(line, [])
    byLine.get(line).push(source)
  }
  if (byLine.size === 0) return sources
  const [line, members] = [...byLine].sort((a, b) => b[1].length - a[1].length)[0]
  if (members.length <= requested * 2) return sources
  const stem = line.slice('#include "'.length, -'.hpp"'.length)
  // Longest first onto the lightest group: source size stands in for compile cost.
  const sized = members.map((source) => ({ source, size: fs.statSync(source).size }))
  sized.sort((a, b) => b.size - a.size || (a.source < b.source ? -1 : 1))
  const groups = Array.from({ length: requested }, () => ({ size: 0, members: [] }))
  for (const entry of sized) {
    const lightest = groups.reduce((best, group) => (group.size < best.size ? group : best))
    lightest.size += entry.size
    lightest.members.push(entry.source)
  }
  const grouped = new Set(members)
  const result = sources.filter((source) => !grouped.has(source))
  groups.forEach((group, index) => {
    if (group.members.length === 0) return
    const file = path.join(outDir, `${stem}.group-${index}.cpp`)
    const text = [line, ...group.members.sort().map((member) => `#include "${path.basename(member)}"`), ''].join('\n')
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text)
    result.push(file)
  })
  console.error(`[build] grouped ${members.length} units into ${result.length - (sources.length - members.length)} compile units`)
  return result
}

async function linkUnits(units, displayPath, exePath) {
  // `gea_node.cpp` is deliberately NOT a source of its own: `gea_node.hpp`
  // includes it, because `__gea_http_serve` is a template that has to be visible
  // where the emitted unit calls it -- that is what keeps the per-request
  // dispatch a direct inlinable call rather than a boxed one. Compiling it here
  // as well would define every reactor symbol twice.
  let sources = units.filter((unit) => unit.fileName.endsWith('.cpp')).map((unit) => path.join(outDir, unit.fileName))
  // OpenSSL is linked only when the program reaches node:crypto. The plugin
  // includes gea_node_crypto.hpp into a unit exactly when a gea::node::crypto::
  // spelling is emitted, so the include line is the reachability answer; an
  // unconditional -lcrypto mapped a 4.5 MB library into every server that never
  // hashed anything. macOS uses CommonCrypto and needs no library either way.
  const needsCrypto = units.some((unit) => unit.source.includes('#include "gea_node_crypto.hpp"'))
  // zlib the same way, on every platform: node:zlib's codecs are the system
  // libz, which macOS ships too but does not link by default.
  const needsZlib = units.some((unit) => unit.source.includes('#include "gea_node_zlib.hpp"'))
  // The C++ compiler is the caller's; the default is clang++, which is what the
  // published benchmarks were built with (clang 18 on the Ubuntu bench host;
  // g++ 13 there is 4-10% slower on the same emitted source).
  const cxx = process.env.CXX ?? 'clang++'
  const cxxIsClang = /clang/.test(path.basename(cxx)) || (!/g\+\+|gcc/.test(path.basename(cxx)) && process.platform === 'darwin')
  const common = { cxxIsClang, needsCrypto, needsZlib }

  const linkStarted = process.hrtime.bigint()
  const fail = (stderr, fields = {}) => {
    if (reportPath) process.stderr.write(stderr.slice(-8000))
    writeReport({
      stage: 'link',
      linkMs: Number((process.hrtime.bigint() - linkStarted) / 1000000n),
      linked: false,
      linkErrors: stderr
        .split('\n')
        .filter((line) => /error:|Undefined symbols|undefined reference|^\s+"_?\w+", referenced from|ld: /.test(line))
        .slice(0, 20),
      linkStderr: stderr.slice(-8000),
      ...fields
    })
    process.exit(2)
  }

  let linkInputs = sources
  let unitCompiles
  let pchReport = null
  if (sources.length > 1) {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
    // Every core, unless memory says otherwise: a unit compile is ~1-1.5 GB and
    // the program unit several times that, so budget 2.5 GB a job.
    const byMemory = Math.floor(os.totalmem() / 2.5 / 1024 ** 3)
    const jobs = Math.max(1, Number.parseInt(process.env.GEA_JOBS ?? '', 10) || Math.min(cores, byMemory) || 1)
    sources = groupedUnits(sources, jobs)
    // Instrumented objects are a different program: their own file names, so a
    // PGO build does not evict the plain objects (and both stay cacheable).
    const objectOf = (source) => source.replace(/\.cpp$/, process.env.GEA_PGO_GENERATE ? '.pgo-gen.o' : '.o')
    console.error(`[build] compiling ${sources.length} units, ${Math.min(jobs, sources.length)} at a time`)
    unitCompiles = new Array(sources.length)
    // The PCH builds while the units that cannot use it compile; the units
    // that can wait for it. A failed PCH is a slower build, not a failed one.
    const prefix = precompiledPrefix(sources, cxxIsClang)
    const prefixReady = prefix
      ? buildPrecompiledPrefix(prefix, cxx, common).then((outcome) => {
          pchReport = {
            header: path.basename(prefix.header),
            units: prefix.users.size,
            codegen: prefix.codegen,
            reused: outcome.reused,
            ok: outcome.ok,
            ms: outcome.ms
          }
          if (outcome.ok) {
            console.error(
              `[build] precompiled ${path.basename(prefix.header)} for ${prefix.users.size} units (${outcome.reused ? 'cached' : `${outcome.ms} ms`})`
            )
          } else {
            console.error(
              `[build] WARNING: precompiling ${path.basename(prefix.header)} failed; compiling every unit without it\n${outcome.stderr.slice(-4000)}`
            )
          }
          return outcome.ok
        })
      : Promise.resolve(false)
    const order = sources.map((_, index) => index)
    if (prefix) order.sort((a, b) => Number(prefix.users.has(sources[a])) - Number(prefix.users.has(sources[b])))
    let next = 0
    let cachedUnits = 0
    const worker = async () => {
      while (next < order.length) {
        const index = order[next++]
        const source = sources[index]
        const usesPrefix = prefix?.users.has(source) && (await prefixReady)
        const flags = cxxFlags({
          ...common,
          phase: 'compile',
          inputs: [source],
          output: objectOf(source),
          pch: usesPrefix ? { file: prefix.file, codegen: prefix.codegen } : null
        })
        if (verbose) console.error(`[build] ${cxx} ${flags.join(' ')}`)
        const outcome = await compileUnitCached(cxx, flags, objectOf(source), usesPrefix ? prefix.file : null)
        if (outcome.cached) cachedUnits++
        unitCompiles[index] = {
          unit: path.basename(source),
          ok: outcome.ok,
          ms: outcome.ms
        }
        // Warnings stream in an interactive build; a failure is reported below.
        if (!reportPath && outcome.stderr) process.stderr.write(outcome.stderr)
        if (verbose || !outcome.ok)
          console.error(`[build]   ${outcome.ok ? 'compiled' : 'FAILED'} ${displayPath(source)} (${outcome.ms} ms)`)
        if (!outcome.ok) unitCompiles[index].stderr = outcome.stderr
      }
    }
    await Promise.all(Array.from({ length: Math.min(jobs, sources.length) }, worker))
    if (cachedUnits > 0) console.error(`[build] ${cachedUnits} of ${sources.length} units unchanged (object reused)`)
    const failed = unitCompiles.filter((row) => !row.ok)
    const compileRows = unitCompiles.map(({ unit, ok, ms }) => ({
      unit,
      ok,
      ms
    }))
    if (failed.length > 0) {
      fail(failed.map((row) => `--- ${row.unit}\n${row.stderr}`).join('\n'), {
        unitCompiles: compileRows,
        pch: pchReport
      })
    }
    unitCompiles = compileRows
    linkInputs = sources.map(objectOf)
    // Modular codegen put the header's inline functions in the PCH's object.
    if (pchReport?.ok && pchReport.codegen) linkInputs.push(prefix.object)
  }

  const flags = cxxFlags({
    ...common,
    phase: sources.length > 1 ? 'link' : 'all',
    inputs: linkInputs,
    output: exePath
  })
  if (verbose) console.error(`[build] ${cxx} ${flags.join(' ')}`)
  const outcome = await runCxx(cxx, flags)
  if (!reportPath && outcome.stderr) process.stderr.write(outcome.stderr)
  if (!outcome.ok) fail(outcome.stderr, unitCompiles ? { unitCompiles, pch: pchReport } : {})
  if (unitCompiles) console.error(`[build] linked ${sources.length} units in ${outcome.ms} ms (${ltoMode('link', cxxIsClang) ?? 'no'} LTO)`)
  writeReport({
    stage: 'link',
    linkMs: Number((process.hrtime.bigint() - linkStarted) / 1000000n),
    ...(unitCompiles ? { unitCompiles, finalLinkMs: outcome.ms, pch: pchReport } : {}),
    linked: true,
    exe: exePath,
    linkStderr: outcome.stderr.slice(-4000)
  })
  if (optimize && process.platform === 'darwin') {
    const debugSymbols = `${exePath}.dSYM`
    if (fs.existsSync(debugSymbols)) fs.rmSync(debugSymbols, { recursive: true })
  }
  console.error(`[build] built ${displayPath(exePath)}`)
}
