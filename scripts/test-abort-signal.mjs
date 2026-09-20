import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

// `abort-events.ts` first: it declares `Event`, `AbortSignal`,
// `AbortController` and `DOMException`, which `globals.ts` then builds on
// (`class MessageEvent extends Event`). They are two files rather than one
// because this target's own builtins name the abort classes with no import,
// so those have to load in every program while the fetch surface does not --
// see `abort-events.ts`'s header. Both are SCRIPTS, so concatenating them
// reproduces the single global scope the real build gives them.
const read = (name) => stripTypeScriptTypes(readFileSync(new URL(`../runtime/node/${name}.ts`, import.meta.url), 'utf8'))
const source = `${read('abort-events')}\n${read('globals')}`
const shim = runInNewContext(`${source}\n({ AbortController, AbortSignal, DOMException })`, { queueMicrotask })

for (const runtime of [globalThis, shim]) {
  const controller = new runtime.AbortController()
  const signal = controller.signal
  const reason = { reason: 'cancelled' }
  const calls = []
  const removed = () => calls.push('removed')
  function listener(event) {
    assert.equal(this, signal)
    assert.equal(event.target, signal)
    assert.equal(event.currentTarget, signal)
    assert.equal(signal.aborted, true)
    assert.equal(signal.reason, reason)
    calls.push('listener')
    signal.removeEventListener('abort', removed)
    controller.abort('second reason')
  }
  signal.addEventListener('abort', listener, { once: true })
  signal.addEventListener('abort', listener)
  signal.onabort = () => calls.push('onabort old')
  signal.addEventListener('abort', removed)
  signal.addEventListener('abort', () => calls.push('last'))
  signal.onabort = () => calls.push('onabort')
  assert.equal(signal.reason, undefined)
  signal.throwIfAborted()
  controller.abort(reason)
  assert.deepEqual(calls, ['listener', 'onabort', 'last'])
  assert.throws(
    () => signal.throwIfAborted(),
    (error) => error === reason
  )
  controller.abort()
  signal.addEventListener('abort', () => calls.push('late'))
  assert.deepEqual(calls, ['listener', 'onabort', 'last'])
  assert.equal(signal.reason, reason)

  const defaultSignal = runtime.AbortSignal.abort()
  assert.equal(defaultSignal.reason instanceof runtime.DOMException, true)
  assert.equal(defaultSignal.reason.name, 'AbortError')
  assert.equal(defaultSignal.reason.code, 20)
  assert.equal(runtime.AbortSignal.abort(null).reason, null)
  assert.throws(() => new runtime.AbortSignal(), { name: 'TypeError' })
}
console.log(
  'PASS: AbortSignal reason identity, synchronous dispatch, once, duplicate/removal, reentrancy, onabort order, and default exception match Node'
)
