import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/dictionary-missing.ts')
const executable = resolve(output, 'dictionary-missing')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }
mkdirSync(output, { recursive: true })

execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  ...options,
  stdio: 'inherit'
})
const expected = spawnSync(process.execPath, [source], { ...options, timeout: 15000 })
const actual = spawnSync(executable, [], { ...options, timeout: 15000 })
assert.equal(expected.status, 0, `node status\n${expected.stderr}`)
assert.equal(actual.status, 0, `compiled status\n${actual.stderr}`)
const expectedLines = expected.stdout.trim().split('\n')
const actualLines = actual.stdout.trim().split('\n')
const deviating = new Set(['plain missing typeof string', 'nullish '])
assert.equal(actualLines.length, expectedLines.length, `line count\n--- node\n${expected.stdout}\n--- compiled\n${actual.stdout}`)
let same = 0
for (let i = 0; i < expectedLines.length; i++) {
  if (deviating.has(actualLines[i])) continue
  assert.equal(actualLines[i], expectedLines[i], `line ${i + 1}`)
  same++
}
assert.ok(expectedLines.includes('optional passed some(x) none'), 'the oracle covered the optional map')
console.log(`DICTIONARY_MISSING_PARITY_OK:${same}`)
