import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// node:zlib's codecs over every InputType Node accepts (views with offsets, ArrayBuffer, string, Buffer), byte-identical to Node.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/hono-mongodb-todo/dist')
const source = resolve(root, 'apps/hono-mongodb-todo/correctness/native/zlib-view-inputs.ts')
const executable = resolve(output, 'zlib-view-inputs') + (process.platform === 'win32' ? '.exe' : '')
const options = { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: output } }

// The caller owns the shared compiler build window; this never rebuilds dist.
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable, '--globals'], {
  ...options,
  stdio: 'inherit',
})
const expected = execFileSync(process.execPath, [source], options)
const actual = execFileSync(executable, [], { ...options, timeout: 15000 })
assert.equal(actual, expected)
console.log('ZLIB_VIEW_INPUTS_PARITY_OK')
