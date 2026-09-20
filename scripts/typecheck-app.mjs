// Type-check an app the way a native build checks it, in a second rather than
// in the minutes a full compile costs.
//
// The native build's checker errors are the foundation under everything else:
// a type that does not check reaches representation as `unresolved@...`, and
// each one of those mints the missing emitter/verifier/physical-cpp-type
// obligations that refuse the program. Those errors are ordinary TypeScript,
// so they can be reproduced without lowering, emitting or linking -- but only
// against the same file set, which is what makes this more than `tsc -p`:
// a package compiled from source is checked as its own `.ts`, acquired per
// installed version under `node_modules/.cache/geatsc/sources`, and nothing in
// the app's own tsconfig points there.
//
// This writes a project next to the build's generated one, mapping every
// target builtin and every acquired package source, and runs tsc over it.
//
//   node scripts/typecheck-app.mjs apps/hono-hello
//
// It is a diagnostic instrument, not a gate: it is a superset of what the
// build checks, because the build retains only the builtin mappings the
// resolved source graph actually imports. A file it reports clean can still
// refuse to certify for reasons that are not checker errors.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.resolve(process.argv[2] ?? '.')
if (!fs.existsSync(path.join(app, 'package.json'))) throw new Error(`not a package: ${app}`)

const generated = (() => {
  const base = path.join(app, 'dist', '.geatsc')
  if (!fs.existsSync(base)) return null
  for (const name of fs.readdirSync(base)) {
    const candidate = path.join(base, name, 'tsconfig.json')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
})()
if (generated === null) throw new Error(`no generated project under ${app}/dist/.geatsc -- build the app once first`)

/** Every package whose typed source the compiler acquired for this app, by name. */
function acquiredSources() {
  const root = path.join(app, 'node_modules', '.cache', 'geatsc', 'sources')
  const sources = new Map()
  if (!fs.existsSync(root)) return sources
  for (const outer of fs.readdirSync(root)) {
    const outerPath = path.join(root, outer)
    if (!fs.statSync(outerPath).isDirectory()) continue
    for (const inner of fs.readdirSync(outerPath)) {
      const checkout = path.join(outerPath, inner)
      const manifest = path.join(checkout, 'package.json')
      if (!fs.existsSync(manifest)) continue
      try {
        const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name
        if (typeof name === 'string' && fs.existsSync(path.join(checkout, 'src'))) sources.set(name, checkout)
      } catch {}
    }
  }
  return sources
}

const project = JSON.parse(fs.readFileSync(generated, 'utf8'))
const paths = { ...project.compilerOptions.paths }

// A checked-in builtin wins over the generated facade, exactly as
// `resolveBuiltinModules` decides it for the build. Writing the facade first
// and letting the implementation overwrite it keeps that order in one place.
for (const directory of [path.join(repo, 'runtime', 'node', 'generated', 'facades'), path.join(repo, 'runtime', 'node')]) {
  if (!fs.existsSync(directory)) continue
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
    const name = file.slice(0, -'.ts'.length)
    const target = path.join(directory, file)
    paths[`node:${name}`] = [target]
    paths[name] = [target]
  }
}

const files = (project.files ?? []).map((file) => path.resolve(path.dirname(generated), file))
for (const [name, checkout] of acquiredSources()) {
  const source = path.join(checkout, 'src')
  const index = path.join(source, 'index.ts')
  if (fs.existsSync(index)) paths[name] = [index]
  paths[`${name}/*`] = [`${source}/*`]
  // Check the acquired package's own sources, not just the ones the app's
  // entry happens to reach: a member missing from this target's surface is
  // reported at the library file that uses it.
  // A package's own tests are not part of the program the app compiles, and
  // they import a test runner this target never provides -- checking them
  // reports hundreds of errors that no build would ever raise.
  const compiled = (file) => file.endsWith('.ts') && !/\.(?:d|test|spec)\.ts$/.test(file)
  for (const file of fs.readdirSync(source)) if (compiled(file)) files.push(path.join(source, file))
}

const output = path.join(path.dirname(generated), 'typecheck.tsconfig.json')
fs.writeFileSync(output, `${JSON.stringify({ compilerOptions: { ...project.compilerOptions, paths, noEmit: true }, files }, null, 2)}\n`)

const tsc = path.join(repo, '..', 'compiler', 'node_modules', 'typescript', 'bin', 'tsc')
const run = spawnSync(process.execPath, [tsc, '-p', output, '--noEmit'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const lines = `${run.stdout ?? ''}`.split('\n').filter((line) => line.includes('error TS'))
process.stdout.write(`${run.stdout ?? ''}`)
console.error(`[typecheck-app] ${lines.length} checker error(s) over ${files.length} file(s) -- project ${output}`)
process.exit(lines.length > 0 ? 1 : 0)
