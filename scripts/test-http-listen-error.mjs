import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// http.Server.listen on a held port: the compiled program must emit node's
// EADDRINUSE 'error' instead of reporting 'listening' (see the program's header).
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/http-listen-error.ts')
const executable = resolve(output, 'http-listen-error') + (process.platform === 'win32' ? '.exe' : '')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit'
})
const expected = execFileSync(process.execPath, [source], { ...options, timeout: 15000 })
const actual = execFileSync(executable, [], { ...options, timeout: 15000 })
assert.equal(actual, expected)
console.log('HTTP_LISTEN_ERROR_PARITY_OK')
