import EventEmitterDefault, {
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  EventEmitter,
  EventEmitterAsyncResource,
  on,
  prototype
} from 'node:events'

class FakeSignal {
  aborted: boolean
  private listener_: any

  constructor() {
    this.aborted = false
    this.listener_ = undefined
  }

  addEventListener(_name: string, listener: any, _options?: unknown): void {
    this.listener_ = listener
  }

  removeEventListener(_name: string, listener: any): void {
    if (this.listener_ === listener) this.listener_ = undefined
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    if (this.listener_ !== undefined) this.listener_({ type: 'abort', target: this })
  }
}

const emitter = new EventEmitterDefault()
const eventSymbol = Symbol('work')
emitter.on(eventSymbol, (value?: any) => console.log(`symbol:${value}`))
emitter.emit(eventSymbol, 'value')

const errorOrder: string[] = []
emitter.on(errorMonitor, () => errorOrder.push('monitor'))
emitter.on('error', () => errorOrder.push('handler'))
emitter.emit('error', new Error('handled'))
console.log(`error-order:${errorOrder.join(',')}`)
console.log(
  `statics:${EventEmitter.captureRejectionSymbol === captureRejectionSymbol},${EventEmitter.errorMonitor === errorMonitor},${prototype !== undefined}`
)

const resource = new EventEmitterAsyncResource({ name: 'advanced', triggerAsyncId: 7 })
const asyncResource: any = resource.asyncResource
console.log(`resource:${resource.asyncId > 0},${resource.triggerAsyncId},${asyncResource.name}`)
resource.emitDestroy()
console.log(`destroyed:${asyncResource.destroyed}`)

const signal = new FakeSignal()
let aborts = 0
const disposable = addAbortListener(signal as any, () => aborts++)
signal.abort()
signal.abort()
console.log(`abort:${aborts}`)
;(disposable as any).dispose()

const iterator = on(emitter, 'item')
const iteratorNext: Promise<any> = iterator.next()
iteratorNext.then((result: any) => {
  console.log(`iterator:${result.done},${result.value!.join(',')}`)
  const iteratorReturn: Promise<any> = iterator.return!()
  iteratorReturn.then((returnResult: any) => console.log(`iterator-return:${returnResult.done}`))
})
emitter.emit('item', 'first', 2)

const closing = on(emitter, 'never', { close: ['closed'] })
emitter.emit('closed')
const closingNext: Promise<any> = closing.next()
closingNext.then((result: any) => console.log(`iterator-close:${result.done}`))

const rejecting = new EventEmitter({ captureRejections: true })
rejecting.on('error', (error?: any) => console.log(`capture:${error.message}`))
rejecting.on('task', () => ({
  then: (_resolve: any, reject: any): void => reject(new Error('rejected'))
}))
rejecting.emit('task')
