import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// `process.exitCode`: the compiled program must print what node prints AND end
// with the status node ends with, for a natural exit (3), an argument-less
// `process.exit()` (2) and an exit code reset to `undefined` (0).
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/process-exit-code.ts')
const executable = resolve(output, 'process-exit-code')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit'
})
for (const [mode, status] of [
  ['natural', 3],
  ['exit', 2],
  ['reset', 0]
]) {
  const expected = spawnSync(process.execPath, [source, mode], { ...options, timeout: 15000 })
  const actual = spawnSync(executable, [mode], { ...options, timeout: 15000 })
  assert.equal(expected.status, status, `node ${mode}`)
  assert.equal(actual.stdout, expected.stdout, `stdout ${mode}`)
  assert.equal(actual.status, expected.status, `status ${mode}`)
}
console.log('PROCESS_EXIT_CODE_PARITY_OK')
