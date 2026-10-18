import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/url-can-parse.ts')
const executable = resolve(output, 'url-can-parse')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }
mkdirSync(output, { recursive: true })

execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  ...options,
  stdio: 'inherit'
})
const expected = execFileSync(process.execPath, [source], options)
const actual = execFileSync(executable, [], { ...options, timeout: 15000 })

const expectedLines = expected.trim().split('\n')
const actualLines = actual.trim().split('\n')
assert.equal(actualLines.length, expectedLines.length, `line count\n--- node\n${expected}\n--- compiled\n${actual}`)
for (let i = 0; i < expectedLines.length; i++) assert.equal(actualLines[i], expectedLines[i], `line ${i + 1}`)
assert.ok(expectedLines.length >= 80, 'the probe printed the whole table')
console.log(`URL_CAN_PARSE_PARITY_OK:${expectedLines.length}`)
