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
//                                  [--package-root <source-checkout>]
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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { geatscNodePlugin } from '../plugin/index.mjs'
import { resolveBuiltinModules, runtimeRootsForReachableGlobalNeeds } from './builtin-modules.mjs'
import { displayPathFrom } from './path-display.mjs'
import { compile } from '@geastack/compiler'
import { preparePackageSources } from '@geastack/compiler/preparation'

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
    'usage: node scripts/build.mjs <entry.ts> [--out <dir>] [--exe <path>] [--debug] [--emit-only] [--globals] [--verbose] [--source-project <tsconfig>] [--dynamic-fallback] [--javascript-sources] [--translation-units single|per-file]'
  )
  process.exit(1)
}
const entry = path.resolve(entryArg)
const outDir = path.resolve(arg('--out', path.join(path.dirname(entry), 'dist')))
const exePath = path.resolve(arg('--exe', path.join(outDir, 'server')))
const optimize = !process.argv.includes('--debug')
const emitOnly = process.argv.includes('--emit-only')
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
    path.join(builtinsDir, 'global-timers.ts')
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
    `./${path.relative(outDir, path.join(builtinsDir, 'global-timers.ts')).replace(/\\/g, '/')}`
  ]
  const globalsFile = path.join(builtinsDir, 'globals.ts')
  const reachableGlobals = runtimeRootsForReachableGlobalNeeds({
    entryFiles: [entry],
    moduleOverrides: answeredPackages(),
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
if (preparedSources.length > 0)
  console.error(`[build] compile-from-source: ${[...new Set(preparedSources.map(sourceName))].join(', ')}`)
const packageSources = [...preparedSources, ...(packageRoot ? [{ root: path.resolve(packageRoot) }] : [])]

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
// Identities carry a file INDEX, not a name, so a symbol or a refusal naming
// `f66` is unreadable without this table. Printed on demand rather than always
// because a real Node program has well over a hundred files.
if (process.env.GEA_FILE_MAP) {
  for (const [identity, name] of [...result.sourceFileNames].sort((left, right) => Number(left[0].slice(1)) - Number(right[0].slice(1))))
    if (!/node_modules\/typescript\/lib\//.test(name)) console.error(`  file  ${identity} ${name.replace(/^.*\/(node-compat|compiler)\//, '')}`)
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
  for (const blocker of result.loweringBlockers) console.error(`  lowering  ${ownerLocation(blocker.owner)} ${blocker.owner}: ${blocker.reason}`)
  for (const refusal of result.emissionRefusals) console.error(`  emission  ${ownerLocation(refusal.owner)} ${refusal.owner}: ${refusal.reason}`)
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
  for (const drift of result.slotDrift.slice(0, 15)) console.error(`  drift    ${JSON.stringify(drift).slice(0, 400)}`)
  for (const blocker of result.abiBlockers.slice(0, 10)) console.error(`  abi      ${JSON.stringify(blocker).slice(0, 400)}`)
  process.exit(1)
}

const compilerRuntimeDir = path.join(compilerRoot, 'src/targets/cpp/runtime')
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

// ---------------------------------------------------------------------------
// Link.
// ---------------------------------------------------------------------------

const runtimeDir = path.join(repo, 'runtime')
// `gea_node.cpp` is deliberately NOT a source of its own: `gea_node.hpp`
// includes it, because `__gea_http_serve` is a template that has to be visible
// where the emitted unit calls it -- that is what keeps the per-request
// dispatch a direct inlinable call rather than a boxed one. Compiling it here
// as well would define every reactor symbol twice.
const sources = emittedUnits.filter((unit) => unit.fileName.endsWith('.cpp')).map((unit) => path.join(outDir, unit.fileName))
// OpenSSL is linked only when the program reaches node:crypto. The plugin
// includes gea_node_crypto.hpp into a unit exactly when a gea::node::crypto::
// spelling is emitted, so the include line is the reachability answer; an
// unconditional -lcrypto mapped a 4.5 MB library into every server that never
// hashed anything. macOS uses CommonCrypto and needs no library either way.
const needsCrypto = emittedUnits.some((unit) => unit.source.includes('#include "gea_node_crypto.hpp"'))
// The C++ compiler is the caller's; the default is clang++, which is what the
// published benchmarks were built with (clang 18 on the Ubuntu bench host;
// g++ 13 there is 4-10% slower on the same emitted source).
const cxx = process.env.CXX ?? 'clang++'
const cxxIsClang = /clang/.test(path.basename(cxx)) || (!/g\+\+|gcc/.test(path.basename(cxx)) && process.platform === 'darwin')
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
// GEA_LTO=0 drops the LTO, for a profile or a bisect.
const lto = optimize && process.env.GEA_LTO !== '0'
const flags = [
  '-std=c++20',
  optimize ? (process.env.GEA_OPT_LEVEL ?? (cxxIsClang ? '-Os' : '-O2')) : '-O0',
  ...(lto ? ['-flto', ...(process.platform === 'linux' && cxxIsClang ? ['-fuse-ld=gold'] : [])] : []),
  ...(!optimize ? ['-g'] : []),
  // Symbols are for a profile, and a profile builds with -O0 -g above. An
  // optimized binary ships stripped: on the raw server the symbol table was
  // 1.16 MB of a 3.87 MB file.
  ...(optimize ? (process.platform === 'darwin' ? ['-Wl,-S,-x'] : ['-s']) : []),
  // Size: the unit is one whole program, so nothing outside it may bind to
  // its symbols. Hidden visibility says so to the compiler and lets the
  // linker drop every function and constant the program never reaches
  // (the runtime header compiles in far more than one server uses). Measured
  // on the raw server: 963 KB -> 729 KB at -O2 with identical codegen for the
  // reached code; `-Os` would take another ~22% but is a throughput question,
  // so it stays behind `GEA_OPT_LEVEL`.
  '-fvisibility=hidden',
  '-fvisibility-inlines-hidden',
  ...(process.platform === 'darwin' ? ['-Wl,-dead_strip'] : ['-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections']),
  // Runtime headers are authoritative source inputs. Build directories can
  // contain headers copied by an older toolchain run, so searching `outDir`
  // first can silently compile current C++ against a stale host ABI. Keep the
  // generated-unit directory available for generated support headers, after
  // the compiler and node-compat runtime roots.
  `-I${compilerRuntimeDir}`,
  `-I${runtimeDir}`,
  `-I${path.join(runtimeDir, 'node')}`,
  `-I${outDir}`,
  // Escape hatch for one-off builds that need a flag the pipeline does not
  // model -- `-g` for a profile or an allocation census, `-fsanitize=...` for
  // a leak hunt. Whitespace-separated, appended last so it can override an
  // earlier flag. Not for anything a build should depend on.
  ...(process.env.GEA_CXX_EXTRA ? process.env.GEA_CXX_EXTRA.trim().split(/\s+/) : []),
  ...sources,
  ...(process.platform === 'linux' && needsCrypto ? ['-lcrypto'] : []),
  '-o',
  exePath
]
if (verbose) console.error(`[build] ${cxx} ${flags.join(' ')}`)
const linkStarted = process.hrtime.bigint()
try {
  // stderr captured only when reporting, so an interactive build still streams it.
  const linkStderr = execFileSync(cxx, flags, {
    stdio: ['ignore', 'inherit', reportPath ? 'pipe' : 'inherit'],
    maxBuffer: 64 * 1024 * 1024
  })
  writeReport({
    stage: 'link',
    linkMs: Number((process.hrtime.bigint() - linkStarted) / 1000000n),
    linked: true,
    exe: exePath,
    linkStderr: linkStderr ? String(linkStderr).slice(-4000) : ''
  })
} catch (error) {
  const stderr = error.stderr ? String(error.stderr) : ''
  if (reportPath) process.stderr.write(stderr.slice(-8000))
  writeReport({
    stage: 'link',
    linkMs: Number((process.hrtime.bigint() - linkStarted) / 1000000n),
    linked: false,
    linkErrors: stderr
      .split('\n')
      .filter((line) => /error:|Undefined symbols|undefined reference|^\s+"_?\w+", referenced from|ld: /.test(line))
      .slice(0, 20),
    linkStderr: stderr.slice(-8000)
  })
  process.exit(2)
}
if (optimize && process.platform === 'darwin') {
  const debugSymbols = `${exePath}.dSYM`
  if (fs.existsSync(debugSymbols)) fs.rmSync(debugSymbols, { recursive: true })
}
console.error(`[build] built ${displayPath(exePath)}`)
