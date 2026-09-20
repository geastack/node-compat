import { EventEmitter } from 'events'

function runProbe(): void {
  // A local callable passed back to off by the same reference must disappear.
  const sameEmitter = new EventEmitter()
  let sameCount = 0
  const sameListener = (): void => {
    sameCount++
  }
  sameEmitter.on('same', sameListener)
  sameEmitter.off('same', sameListener)
  if (sameEmitter.emit('same')) throw new Error('same local listener reference was not removed')
  if (sameCount !== 0) throw new Error('removed local listener still ran')

  const emitter = new EventEmitter()
  let removedCount = 0
  let retainedCount = 0
  let onceCount = 0

  const removed = (value?: unknown): void => {
    if (value !== 'payload') throw new Error('removed listener received the wrong payload')
    removedCount++
  }
  const removedAlias = removed
  if (removedAlias !== removed) throw new Error('listener alias lost function identity')

  const retained = (value?: unknown): void => {
    if (value !== 'payload') throw new Error('retained listener received the wrong payload')
    retainedCount++
  }
  const once = (value?: unknown): void => {
    if (value !== 'payload') throw new Error('once listener received the wrong payload')
    onceCount++
  }

  emitter.on('tick', removed)
  emitter.on('tick', retained)
  emitter.once('tick', once)
  if (emitter.listenerCount('tick') !== 3) throw new Error('listener registration count is wrong')
  const registered = emitter.listeners('tick')
  if (registered[0] !== removed || registered[1] !== retained || registered[2] !== once) {
    throw new Error('listeners did not preserve their original function identities')
  }

  emitter.off('tick', removedAlias)
  if (emitter.listenerCount('tick') !== 2) throw new Error('off did not remove exactly one aliased listener')

  if (!emitter.emit('tick', 'payload')) throw new Error('first emit reported no listeners')
  if (!emitter.emit('tick', 'payload')) throw new Error('second emit reported no listeners')

  if (removedCount !== 0) throw new Error('removed listener still ran')
  if (retainedCount !== 2) throw new Error('retained listener did not run twice')
  if (onceCount !== 1) throw new Error('once listener did not run exactly once')
  if (emitter.listenerCount('tick') !== 1) throw new Error('once listener was not removed before dispatch')

  emitter.removeListener('tick', retained)
  if (emitter.emit('tick', 'payload')) throw new Error('emit reported a removed listener')
  if (emitter.listenerCount('tick') !== 0) throw new Error('removeListener did not remove the original reference')

  // Two inline function expressions are distinct identities even when their
  // temporary C++ storage is reused. Removing the first must leave the second.
  const inlineEmitter = new EventEmitter()
  let firstInlineCount = 0
  let secondInlineCount = 0
  inlineEmitter.on('inline', (): void => {
    firstInlineCount++
  })
  inlineEmitter.on('inline', (): void => {
    secondInlineCount++
  })
  const inlineListeners = inlineEmitter.listeners('inline')
  const firstInline: any = inlineListeners[0]
  const secondInline: any = inlineListeners[1]
  if (firstInline === secondInline) throw new Error('distinct rvalue listeners collided')
  inlineEmitter.off('inline', firstInline)
  inlineEmitter.emit('inline')
  if (firstInlineCount !== 0 || secondInlineCount !== 1) {
    throw new Error('removing one rvalue listener affected the other')
  }
}

runProbe()
console.log('event-listener-identity-ok')
