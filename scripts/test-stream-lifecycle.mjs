import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/stream-lifecycle.ts')
const executable = resolve(output, 'stream-lifecycle')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }
mkdirSync(output, { recursive: true })

execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  ...options,
  stdio: 'inherit'
})
const expected = spawnSync(process.execPath, ['--experimental-strip-types', source], { ...options, timeout: 15000 })
const actual = spawnSync(executable, [], { ...options, timeout: 15000 })
assert.equal(expected.status, 0, `node status\n${expected.stderr}`)
assert.equal(actual.status, 0, `compiled status\n${actual.stderr}`)
const expectedLines = expected.stdout.trim().split('\n')
const actualLines = actual.stdout.trim().split('\n')
assert.equal(actualLines.length, expectedLines.length, `line count\n--- node\n${expected.stdout}\n--- compiled\n${actual.stdout}`)
for (let i = 0; i < expectedLines.length; i++) assert.equal(actualLines[i], expectedLines[i], `line ${i + 1}`)
assert.ok(expectedLines.includes('end after finish: callback ERR_STREAM_ALREADY_FINISHED writableEnded true destroyed true'), 'the oracle covered end after finish')
assert.ok(expectedLines.includes('write after end autoDestroy true: returned false callback ERR_STREAM_WRITE_AFTER_END events close'), 'the oracle covered write after end')
console.log(`STREAM_LIFECYCLE_PARITY_OK:${expectedLines.length}`)
