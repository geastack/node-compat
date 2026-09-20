import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const surface = JSON.parse(
  fs.readFileSync(path.join(repo, 'runtime', 'node', 'generated', 'node24-surface.json'), 'utf8')
)
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-imports-'))
const entry = path.join(rootDir, 'imports.ts')
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'imports')
const source = [
  '// Every generated Node 24 builtin must initialize without executing a stub.',
  ...Object.keys(surface.modules).map((moduleName) => `import ${JSON.stringify(moduleName)}`),
  `console.log('node24-imports-ok')`,
  ''
].join('\n')
fs.writeFileSync(entry, source)

const build = spawnSync(
  process.execPath,
  [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable, '--debug'],
  { cwd: repo, encoding: 'utf8' }
)
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

const run = spawnSync(executable, [], {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: '1' }
})
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
assert.match(run.stdout, /node24-imports-ok/)
assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
process.stdout.write(`Verified import-safe initialization of all ${Object.keys(surface.modules).length} Node 24 facades\n`)
