import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// node:net happy eyeballs (`autoSelectFamily`), `family`, `lookup`, and the
// ECONNREFUSED / AggregateError shapes: the compiled program must print what
// node prints for the same source. See the program's header for the setup
// (a 127.0.0.1-only server reached through `localhost`).
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/net-auto-select-family.ts')
const executable = resolve(output, 'net-auto-select-family')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit',
})
const expected = execFileSync(process.execPath, [source], { ...options, timeout: 15000 })
const actual = execFileSync(executable, [], { ...options, timeout: 15000 })
assert.equal(actual, expected)
console.log('NET_AUTO_SELECT_FAMILY_PARITY_OK')
