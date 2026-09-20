import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBuiltinModules } from './builtin-modules.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builtins = path.join(repository, 'runtime', 'node')
const facades = path.join(builtins, 'generated', 'facades')

test('checked-in builtin sources deterministically override generated facades', () => {
  const modules = resolveBuiltinModules(builtins, facades)
  assert.equal(modules.get('diagnostics_channel'), path.join(builtins, 'diagnostics_channel.ts'))
  assert.equal(modules.get('zlib'), path.join(builtins, 'zlib.ts'))
  assert.equal(modules.get('assert'), path.join(facades, 'assert.ts'))
  assert.equal([...modules.keys()].some((name) => name.startsWith('generated/')), false)
  for (const internal of ['globals', 'standard-library', 'not-implemented', 'node-globals', 'buffer-types', 'hono-node-server', 'whatwg-url']) {
    assert.equal(modules.has(internal), false)
  }
})
