import { ServerResponse, type IncomingMessage } from 'node:http'

export type Message = IncomingMessage | ServerResponse
export type FinishedListener<T extends Message> = (err: unknown, msg: T) => void

interface Emitter {
  on(name: string, fn: (...args: unknown[]) => void): unknown
  removeListener(name: string, fn: (...args: unknown[]) => void): unknown
}

class FirstListener {
  private readonly cleanups: { ee: Emitter; event: string; fn: (...args: unknown[]) => void }[] = []
  private done: (err: unknown) => void

  constructor(sources: { ee: Emitter; events: string[] }[], done: (err: unknown) => void) {
    this.done = done
    for (const source of sources) {
      const ee = source.ee
      for (const event of source.events) {
        const fn = (...args: unknown[]) => this.fire(event === 'error' ? args[0] : null)
        ee.on(event, fn)
        this.cleanups.push({ ee, event, fn })
      }
    }
  }

  private fire(err: unknown): void {
    this.cancel()
    this.done(err)
  }

  cancel(): void {
    for (const x of this.cleanups) x.ee.removeListener(x.event, x.fn)
  }
}

interface Attached {
  queue: ((err: unknown) => void)[] | null
}

const attachedListeners = new WeakMap<Message, Attached>()

export function isFinished(msg: Message): boolean | undefined {
  const socket = msg.socket
  if (msg instanceof ServerResponse) {
    return Boolean(msg.finished || (socket && !socket.writable))
  }
  if (typeof msg.complete === 'boolean') {
    return Boolean(!socket || !socket.readable || (msg.complete && !msg.readable))
  }
  return undefined
}

export default function onFinished<T extends Message>(msg: T, listener: FinishedListener<T>): T {
  if (isFinished(msg) !== false) {
    setImmediate(() => listener(null, msg))
    return msg
  }
  attachListener(msg, (err) => listener(err, msg))
  return msg
}

function attachListener(msg: Message, listener: (err: unknown) => void): void {
  let attached = attachedListeners.get(msg)
  if (attached === undefined || attached.queue === null) {
    const created: Attached = { queue: [] }
    attachedListeners.set(msg, created)
    attachFinishedListener(msg, (err) => {
      if (attachedListeners.get(msg) === created) attachedListeners.delete(msg)
      const queue = created.queue
      if (queue === null) return
      created.queue = null
      for (const fn of queue) fn(err)
    })
    attached = created
  }
  attached.queue!.push(listener)
}

function attachFinishedListener(msg: Message, callback: (err: unknown) => void): void {
  let finished = false
  let eeMsg: FirstListener
  let eeSocket: FirstListener
  const onFinish = (error: unknown) => {
    eeMsg.cancel()
    eeSocket.cancel()
    finished = true
    callback(error)
  }
  eeMsg = eeSocket = new FirstListener([{ ee: msg, events: ['end', 'finish'] }], onFinish)
  const onSocket = (...args: unknown[]) => {
    const socket = args[0]
    msg.removeListener('socket', onSocket)
    if (finished) return
    if (eeMsg !== eeSocket) return
    if (socket !== null && typeof socket === 'object') eeSocket = new FirstListener([{ ee: socket as Emitter, events: ['error', 'close'] }], onFinish)
  }
  if (msg.socket) {
    onSocket(msg.socket)
    return
  }
  msg.on('socket', onSocket)
}
