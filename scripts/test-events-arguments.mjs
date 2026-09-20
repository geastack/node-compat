import assert from 'node:assert/strict'
import * as nodeEvents from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../runtime/node/events.ts', import.meta.url), 'utf8')
const shim = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)

for (const events of [nodeEvents, shim]) {
  const emitter = new events.EventEmitter()
  const expected = [undefined, 2, undefined, 4, 5, undefined]
  const received = []
  emitter.on('work', function (...args) {
    assert.equal(this, emitter)
    received.push(args)
  })
  emitter.emit('work')
  emitter.emit('work', ...expected)
  assert.deepEqual(received, [[], expected])

  const once = events.once(emitter, 'once')
  emitter.emit('once', ...expected)
  assert.deepEqual(await once, expected)

  const iterator = events.on(emitter, 'stream')
  emitter.emit('stream', ...expected)
  assert.deepEqual((await iterator.next()).value, expected)
  const pending = iterator.next()
  emitter.emit('stream')
  assert.deepEqual((await pending).value, [])
  await iterator.return()
}

console.log('EVENT_ARGUMENTS_PARITY_OK')
