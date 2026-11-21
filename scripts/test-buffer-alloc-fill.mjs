import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/buffer-alloc-fill.ts')
const executable = resolve(output, 'buffer-alloc-fill')
const options = { cwd: root, encoding: 'utf8', env: process.env }
mkdirSync(output, { recursive: true })

execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  ...options,
  stdio: 'inherit'
})
const expected = spawnSync(process.execPath, ['--experimental-strip-types', source], { ...options, timeout: 15000 })
const actual = spawnSync(executable, [], { ...options, timeout: 15000 })
assert.equal(expected.status, 0, `node status\n${expected.stderr}`)
assert.equal(actual.status, 0, `compiled status\n${actual.stderr}`)
assert.equal(actual.stdout, expected.stdout, `--- node\n${expected.stdout}\n--- compiled\n${actual.stdout}`)
console.log(`BUFFER_ALLOC_FILL_PARITY_OK:${expected.stdout.trim().split('\n').length}`)
