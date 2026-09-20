import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

// `abort-events.ts` first: it declares `Event`, which `globals.ts` extends
// (`class MessageEvent extends Event`). Two files rather than one because the
// abort classes load in EVERY program and the fetch surface does not -- see
// `abort-events.ts`'s header. Both are scripts, so concatenating them
// reproduces the one global scope the real build gives them.
const read = (name) => stripTypeScriptTypes(readFileSync(new URL(`../runtime/node/${name}.ts`, import.meta.url), 'utf8'))
const Shim = runInNewContext(`${read('abort-events')}\n${read('globals')}\nURLSearchParams`)
for (const Parameters of [URLSearchParams, Shim]) {
  for (const method of ['keys', 'values', 'entries', Symbol.iterator]) {
    const params = new Parameters('a=1&b=2')
    const iterator = params[method]()
    assert.equal(iterator[Symbol.iterator](), iterator)
    const values = [iterator.next().value]
    params.append('c', '3')
    values.push(...iterator)
    const expected = method === 'keys' ? ['a', 'b', 'c'] : method === 'values' ? ['1', '2', '3'] : [['a', '1'], ['b', '2'], ['c', '3']]
    assert.equal(JSON.stringify(values), JSON.stringify(expected))
    assert.equal(iterator.next().done, true)
  }
}
console.log('PASS: URLSearchParams exposes live iterable cursors matching Node')
