// Real suspension for `await` against the REAL event loop: node's timers,
// microtasks and await continuations, differentially against node.
//
// The native build used to lower every `await` to `.awaited()` -- a nested
// reactor pump on the C++ stack that returns only when its promise settles.
// Each section below is a shape that model got wrong; the compiler's own
// runtime suite (`compiler/test/runtime/await-*.runtime.ts`) pins the same
// shapes without timers, which that suite's target does not have.
//
// 1. ordering: microtasks drain before the first timer, and again after EACH
//    timer callback, so a microtask queued by the first of two due timers
//    runs before the second. A pump running timers from inside an async
//    function's frame fired them in the middle of its body instead.
// 2. deadlock: `main` awaits a 20ms timer while a 5ms timer starts an async
//    loop awaiting 200ms timers, plus a heartbeat whose promise only an
//    UNREF'D timer would settle. `main` must print first, and the program
//    must exit with the heartbeat still suspended -- the mongodb streaming
//    monitor's shape. Under the pump model, the background loop's pump sat
//    above `main`'s frame and `main` resumed only behind it (never, behind
//    the heartbeat).
// 3. readMany: mongodb's `onData` iterator object -> async generator ->
//    `for await`, two pipelines at once, chunks delivered by timers.
const log: string[] = []

function delay(ms: number, value: string): Promise<string> {
  return new Promise<string>((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

// ---- 1. ordering -----------------------------------------------------------

function ordering(): Promise<void> {
  return new Promise<void>((finish) => {
    setTimeout(() => {
      log.push('timeoutA')
      queueMicrotask(() => log.push('microFromA'))
      Promise.resolve().then(() => log.push('thenFromA'))
    }, 0)
    setTimeout(() => {
      log.push('timeoutB')
    }, 0)

    queueMicrotask(() => log.push('micro1'))
    Promise.resolve()
      .then(() => log.push('then1'))
      .then(() => log.push('then2'))

    const task = async (): Promise<void> => {
      log.push('async:start')
      await undefined
      log.push('async:after1')
      await undefined
      log.push('async:after2')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      log.push('async:after-timer')
    }
    task()

    queueMicrotask(() => log.push('micro2'))
    log.push('sync-end')

    setTimeout(() => {
      console.log(`ordering: ${log.join(' ')}`)
      log.length = 0
      finish()
    }, 20)
  })
}

// ---- 2. deadlock shape -----------------------------------------------------

function neverInTime(): Promise<string> {
  return new Promise<string>((resolve) => {
    const handle = setTimeout(() => resolve('too-late'), 60_000)
    handle.unref()
  })
}

async function heartbeat(): Promise<void> {
  for (;;) {
    log.push('hb:await')
    const reply = await neverInTime()
    log.push(`hb:${reply}`)
  }
}

async function background(): Promise<void> {
  log.push('bg:start')
  for (let round = 1; round <= 2; round++) {
    const value = await delay(200, `late${round}`)
    log.push(`bg:${value}`)
  }
  log.push('bg:end')
}

async function deadlockShape(): Promise<void> {
  let backgroundDone: Promise<void> = Promise.resolve()
  setTimeout(() => {
    backgroundDone = background()
    heartbeat()
    log.push('timer5:returned')
  }, 5)
  const result = await delay(20, 'main-value')
  log.push(`main:${result}`)
  console.log(`deadlock: main:${result}`)
  await delay(10, 'after-main')
  await backgroundDone
  console.log(`deadlock: ${log.join(' ')}`)
  log.length = 0
}

// ---- 3. readMany pipeline --------------------------------------------------

type Listener = (chunk: string) => void

class Emitter {
  private listeners: Listener[] = []

  on(listener: Listener): void {
    this.listeners.push(listener)
  }

  off(listener: Listener): void {
    this.listeners = this.listeners.filter((each) => each !== listener)
  }

  emit(chunk: string): void {
    for (const listener of this.listeners.slice()) listener(chunk)
  }

  count(): number {
    return this.listeners.length
  }
}

type PendingPromise = { resolve: (value: IteratorResult<string>) => void }

function onData(emitter: Emitter, name: string): AsyncGenerator<string> {
  const unconsumedEvents: string[] = []
  const unconsumedPromises: PendingPromise[] = []
  let finished = false

  function eventHandler(value: string): void {
    const pending = unconsumedPromises.shift()
    if (pending != null) pending.resolve({ value, done: false })
    else unconsumedEvents.push(value)
  }

  function closeHandler(): Promise<IteratorResult<string>> {
    log.push(`${name}:events-return`)
    finished = true
    emitter.off(eventHandler)
    const doneResult = { value: undefined, done: true } as const
    for (const pending of unconsumedPromises.splice(0)) pending.resolve(doneResult)
    return Promise.resolve(doneResult)
  }

  const iterator: AsyncGenerator<string> = {
    next() {
      const value = unconsumedEvents.shift()
      if (value != null) return Promise.resolve({ value, done: false })
      if (finished) return closeHandler()
      return new Promise<IteratorResult<string>>((resolve) => {
        unconsumedPromises.push({ resolve })
      })
    },
    return() {
      return closeHandler()
    },
    throw(error: Error) {
      return Promise.reject(error)
    },
    // mongodb's `onData` carries this member too; the native build's lib
    // requires it of an `AsyncGenerator`.
    async [Symbol.asyncDispose]() {
      await closeHandler()
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }

  emitter.on(eventHandler)
  return iterator
}

async function* readMany(emitter: Emitter, name: string): AsyncGenerator<string> {
  try {
    for await (const chunk of onData(emitter, name)) {
      const response = await Promise.resolve(`${name}:${chunk.toUpperCase()}`)
      yield response
      if (chunk.endsWith('!')) return
    }
  } finally {
    log.push(`${name}:readMany-finally`)
  }
}

async function command(emitter: Emitter, name: string): Promise<string[]> {
  const responses: string[] = []
  for await (const response of readMany(emitter, name)) {
    log.push(response)
    responses.push(response)
  }
  log.push(`${name}:done listeners=${emitter.count()}`)
  return responses
}

async function pipeline(): Promise<void> {
  const first = new Emitter()
  const second = new Emitter()
  setTimeout(() => {
    first.emit('a')
    first.emit('b')
  }, 5)
  setTimeout(() => second.emit('x'), 8)
  setTimeout(() => first.emit('c'), 10)
  setTimeout(() => second.emit('y!'), 12)
  setTimeout(() => first.emit('d!'), 15)
  setTimeout(() => first.emit('ignored'), 18)
  const one = command(first, 'one')
  const two = command(second, 'two')
  const oneResult = await one
  const twoResult = await two
  console.log(`readMany: ${log.join(' ')}`)
  console.log(`readMany: one=${oneResult.join(',')} two=${twoResult.join(',')}`)
  log.length = 0
}

async function main(): Promise<void> {
  await ordering()
  await deadlockShape()
  await pipeline()
  console.log('ASYNC_AWAIT_TIMERS:done')
}

main()
