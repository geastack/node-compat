import assert from 'node:assert/strict'
import { accessSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const modulePath = new URL('../runtime/node/fs.ts', import.meta.url)
// Strip whole import STATEMENTS, multi-line ones included, then evaluate the
// real dependency chain into one shared scope. `fs.ts` gained
// `import { Readable } from './stream'` when `createReadStream` became real,
// and this harness used to drop imports line-by-line and load `fs.ts` alone --
// which left `Readable` undefined at `class ReadStream extends Readable`.
// Loading the actual sources keeps the test honest: it exercises the same
// `Readable` the runtime ships, not a stand-in written for the test.
// Line-based rather than a regex: an import statement here may span several
// lines, and a lazy multi-line pattern silently leaves the tail of one behind
// as a syntax error that looks like a source bug rather than a harness bug.
const flatten = (name) => {
  const lines = readFileSync(new URL(`../runtime/node/${name}.ts`, import.meta.url), 'utf8').split('\n')
  const kept = []
  let clause = null
  // A brace clause -- `import {...}`, `export {...}`, `export type {...} from` --
  // names bindings the concatenation already has in scope, so the whole statement
  // goes, not just its `export` keyword. Dropping only the keyword is what left a
  // bare `{ Buffer } from './buffer-types'` behind as a syntax error. A RENAMED
  // binding (`import { on as eventsOn }`) is the exception: the local name exists
  // only because of the import, so it is re-declared as a plain alias.
  const closeClause = (text) => {
    // Only `import` clauses: a re-export renames a binding for consumers, and
    // re-declaring that name here collides with the module that declared it.
    if (!/^import\b/.test(text) || /^import\s+type\b/.test(text)) return void (clause = null)
    for (const entry of (text.match(/\{([\s\S]*)\}/)?.[1] ?? '').split(',')) {
      const renamed = entry.match(/^\s*(\w+)\s+as\s+(\w+)\s*$/)
      if (renamed) kept.push(`const ${renamed[2]} = ${renamed[1]}`)
    }
    clause = null
  }
  for (const line of lines) {
    if (clause !== null) {
      clause += `\n${line}`
      if (/\}/.test(line)) closeClause(clause)
      continue
    }
    if (/^export default\b/.test(line)) continue
    if (/^import\b/.test(line) || /^export\s+(type\s+)?\{/.test(line)) {
      if (/\}/.test(line)) closeClause(line)
      else clause = line
      continue
    }
    kept.push(line.replace(/^export type /, 'type ').replace(/^export /, ''))
  }
  // `events.ts` and `stream.ts` both export a CJS-interop `const prototype`.
  // Separate modules, so no conflict in the real runtime; one shared scope here,
  // so give each its own name and fix up the shorthand that reads it back.
  const alias = `prototype_${name.replace(/\W/g, '_')}`
  return kept
    .join('\n')
    .replace(/^const prototype\b/m, `const ${alias}`)
    .replace(/^(\s+)prototype,$/m, `$1prototype: ${alias},`)
}
// `stream/web` is deliberately absent: it only re-aliases the classes
// `whatwg-streams` declares, and `stream.ts`'s own renamed import clause
// (`ReadableStream as WebReadableStream`) reconstructs those aliases here.
const source = ['not-implemented', 'buffer-types', 'buffer', 'events', 'whatwg-streams', 'stream', 'fs']
  .map(flatten)
  .join('\n')
const code = stripTypeScriptTypes(source, { mode: 'strip', disableExperimentalWarning: true })
const context = vm.createContext({
  URL, Buffer, queueMicrotask, TextEncoder, TextDecoder, console, setTimeout, clearTimeout, process,
  __gea_node_fs_access(path, mode) { try { accessSync(path, mode); return true } catch { return false } },
  __gea_node_fs_read_file: readFileSync
})
const fs = vm.runInContext(`${code}\nnodeFsPromises`, context)
const file = fileURLToPath(modulePath)
for (const path of [file, pathToFileURL(file)]) {
  await fs.access(path)
  assert.deepEqual(await fs.readFile(path), await readFile(path))
  assert.equal(await fs.readFile(path, 'utf8'), await readFile(path, 'utf8'))
  assert.equal(await fs.readFile(path, 'base64'), await readFile(path, 'base64'))
  assert.deepEqual(await fs.readFile(path, null), await readFile(path))
}
await assert.rejects(fs.readFile(`${file}.nonexistent`), /ENOENT/)
await assert.rejects(fs.readFile(new URL('https://example.com/test')), /scheme file/)
await assert.rejects(fs.readFile(new URL('file:///tmp/encoded%2Fslash')), /encoded/)
console.log('FS_PROMISES_PARITY_OK')
