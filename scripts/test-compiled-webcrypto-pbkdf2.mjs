import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// Web Crypto PBKDF2 (importKey + deriveBits) and the HMAC over its result, as SCRAM authentication calls them, byte-identical to Node.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/webcrypto-pbkdf2.ts')
const executable = resolve(output, 'webcrypto-pbkdf2') + (process.platform === 'win32' ? '.exe' : '')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit',
})
const expected = execFileSync(process.execPath, [source], options)
const actual = execFileSync(executable, [], { ...options, timeout: 15000 })
assert.equal(actual, expected)
console.log('WEBCRYPTO_PBKDF2_PARITY_OK')
