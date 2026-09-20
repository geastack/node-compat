import {
  EventEmitter,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  once,
  setMaxListeners
} from 'node:events'

const emitter = new EventEmitter({ captureRejections: false })
const meta: string[] = []
const order: string[] = []

emitter.on('newListener', (name?: any, _listener?: any, _c?: any) => {
  if (name !== 'newListener' && name !== 'removeListener') meta.push(`add:${name}`)
})
emitter.on('removeListener', (name?: any, _listener?: any, _c?: any) => {
  if (name !== 'newListener' && name !== 'removeListener') meta.push(`remove:${name}`)
})

const regular = () => order.push('regular')
const prepended = () => order.push('prepended')
emitter.on('work', regular)
emitter.prependListener('work', prepended)
emitter.once('work', () => order.push('once'))
emitter.prependOnceListener('work', () => order.push('prepend-once'))

console.log(
  `listeners-before:${listenerCount(emitter, 'work')},${EventEmitter.listenerCount(emitter, 'work')},${getEventListeners(emitter, 'work').length}`
)
emitter.emit('work')
emitter.emit('work')
console.log(`order:${order.join(',')}`)
console.log(`listeners-after:${emitter.listenerCount('work')},${emitter.listenerCount('work', regular)}`)

setMaxListeners(4, emitter)
console.log(`max:${getMaxListeners(emitter)},${EventEmitter.getMaxListeners(emitter)}`)
emitter.setMaxListeners(0)
console.log(`max-instance:${emitter.getMaxListeners()}`)

emitter.removeListener('work', regular)
emitter.removeAllListeners('work')
console.log(`meta:${meta.join(',')}`)
console.log(`events:${emitter.eventNames().join(',')}`)

const waiting = once(emitter, 'ready')
waiting.then((values) => console.log(`once:${values.join(',')}`))
emitter.emit('ready', 'value', 2)

try {
  new EventEmitter().emit('error', new Error('boom'))
} catch (error) {
  console.log(`error:${(error as Error).message}`)
}

try {
  emitter.setMaxListeners(-1)
} catch (error) {
  console.log(`range:${(error as Error & { code: string }).code}`)
}
