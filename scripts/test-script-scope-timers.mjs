import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// A plain SCRIPT entry (no import/export) arming timers from its top level:
// the compiled program must print what node prints and exit as node does. The
// entry used to run before `global-timers.ts` initialized the `Timeout` class,
// and the first `setTimeout` jumped through a null constructor thunk.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/script-scope-timer.ts')
const executable = resolve(output, 'script-scope-timer')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit'
})
const expected = spawnSync(process.execPath, [source], { ...options, timeout: 15000 })
const actual = spawnSync(executable, [], { ...options, timeout: 15000 })
assert.equal(expected.status, 0, 'node status')
assert.equal(actual.stdout, expected.stdout, 'stdout')
assert.equal(actual.status, expected.status, 'status')
console.log('SCRIPT_SCOPE_TIMERS_PARITY_OK')
