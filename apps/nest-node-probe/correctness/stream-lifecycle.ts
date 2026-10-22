import { Buffer } from 'node:buffer'
import { Duplex, Readable, Writable } from 'node:stream'

const log = (line: string): void => {
  console.log(line)
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

class Source extends Readable {
  override _read(): void {}
}

class Sink extends Writable {
  received: string[] = []
  failWith: Error | null = null

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received.push(Buffer.isBuffer(chunk) ? `buffer ${chunk.toString('hex')}` : `string ${String(chunk)}`)
    callback(this.failWith)
  }
}

class Held extends Writable {
  finalCallback: ((error?: Error | null) => void) | null = null

  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finalCallback = callback
  }
}

class Pair extends Duplex {
  received: string[] = []

  override _read(): void {}

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received.push(Buffer.isBuffer(chunk) ? `buffer ${chunk.toString('hex')}` : `string ${String(chunk)}`)
    callback()
  }
}

function watch(stream: Readable | Writable): string[] {
  const events: string[] = []
  stream.on('error', (error: Error) => events.push(`error ${(error as NodeJS.ErrnoException).code ?? error.message}`))
  stream.on('close', () => events.push('close'))
  return events
}

const code = (error: Error | null | undefined): string => (error ? String((error as NodeJS.ErrnoException).code) : 'none')

async function readableEnd(autoDestroy: boolean): Promise<void> {
  const source = new Source({ autoDestroy })
  const events = watch(source)
  source.on('data', () => {})
  source.on('end', () => events.push('end'))
  source.push('x')
  source.push(null)
  await settle()
  log(`readable autoDestroy ${autoDestroy}: destroyed ${source.destroyed} events ${events.join(',')}`)
}

async function writableFinish(autoDestroy: boolean): Promise<void> {
  const sink = new Sink({ autoDestroy })
  const events = watch(sink)
  sink.on('finish', () => events.push('finish'))
  sink.end('x')
  await settle()
  log(`writable autoDestroy ${autoDestroy}: destroyed ${sink.destroyed} events ${events.join(',')}`)
}

async function writableError(autoDestroy: boolean): Promise<void> {
  const sink = new Sink({ autoDestroy })
  sink.failWith = new Error('boom')
  const events = watch(sink)
  let callbackError = 'pending'
  sink.write('x', (error?: Error | null) => {
    callbackError = error ? error.message : 'none'
  })
  await settle()
  log(`write error autoDestroy ${autoDestroy}: callback ${callbackError} destroyed ${sink.destroyed} errored ${sink.errored?.message ?? 'null'} events ${events.join(',')}`)
}

async function writeAfterEnd(autoDestroy: boolean): Promise<void> {
  const sink = new Sink({ autoDestroy })
  const events = watch(sink)
  sink.end()
  await settle()
  let callbackCode = 'pending'
  const accepted = sink.write('late', (error?: Error | null) => {
    callbackCode = code(error)
  })
  await settle()
  log(`write after end autoDestroy ${autoDestroy}: returned ${accepted} callback ${callbackCode} events ${events.join(',')}`)
}

async function afterDestroy(): Promise<void> {
  const sink = new Sink()
  const events = watch(sink)
  sink.destroy()
  await settle()
  let writeCode = 'pending'
  let endCode = 'pending'
  const accepted = sink.write('late', (error?: Error | null) => {
    writeCode = code(error)
  })
  sink.end((error?: Error | null) => {
    endCode = code(error)
  })
  await settle()
  log(`after destroy: returned ${accepted} write ${writeCode} end ${endCode} events ${events.join(',')}`)
}

async function decodeStrings(decode: boolean): Promise<void> {
  const sink = new Sink({ decodeStrings: decode })
  sink.write('hi')
  sink.write('aGk=', 'base64')
  sink.end()
  const pair = new Pair({ decodeStrings: decode })
  pair.write('hi')
  pair.end()
  await settle()
  log(`decodeStrings ${decode}: writable ${sink.received.join(' | ')} duplex ${pair.received.join(' | ')}`)
}

async function duplexBothSides(): Promise<void> {
  const pair = new Pair()
  const events = watch(pair)
  pair.on('data', () => {})
  pair.push('x')
  pair.push(null)
  await settle()
  const afterRead = pair.destroyed
  pair.end('y')
  await settle()
  log(`duplex: destroyed after readable end ${afterRead} after writable finish ${pair.destroyed} events ${events.join(',')}`)
  const writeFirst = new Pair()
  writeFirst.on('data', () => {})
  writeFirst.end('y')
  await settle()
  const afterWrite = writeFirst.destroyed
  writeFirst.push(null)
  await settle()
  log(`duplex write first: destroyed after writable finish ${afterWrite} after readable end ${writeFirst.destroyed}`)
}

async function endAfter(name: string, stream: Writable, before: () => void): Promise<void> {
  stream.on('error', () => {})
  before()
  await settle()
  let result = 'pending'
  stream.end((error?: Error | null) => {
    result = error ? String((error as NodeJS.ErrnoException).code ?? error.message) : 'null'
  })
  await settle()
  log(`end after ${name}: callback ${result} writableEnded ${stream.writableEnded} destroyed ${stream.destroyed}`)
}

async function endStates(): Promise<void> {
  const destroyed = new Sink()
  await endAfter('destroy()', destroyed, () => destroyed.destroy())
  const failed = new Sink()
  await endAfter('destroy(error)', failed, () => failed.destroy(new Error('x')))
  const finished = new Sink()
  await endAfter('finish', finished, () => finished.end())
  const kept = new Sink({ autoDestroy: false })
  await endAfter('finish without autoDestroy', kept, () => kept.end())
  const ending = new Held()
  await endAfter('ending then destroy()', ending, () => {
    ending.end()
    ending.destroy()
  })
  const errored = new Sink({ autoDestroy: false })
  errored.failWith = new Error('w')
  await endAfter('write error without autoDestroy', errored, () => {
    errored.write('x')
  })
}

async function pendingEnds(): Promise<void> {
  for (const outcome of ['final ok', 'final error', 'destroy']) {
    const held = new Held()
    held.on('error', () => {})
    const order: string[] = []
    held.on('finish', () => order.push('finish'))
    held.end((error?: Error | null) => order.push(`first ${error ? error.message : 'null'}`))
    held.end((error?: Error | null) => order.push(`second ${error ? error.message : 'null'}`))
    await settle()
    order.push('|')
    if (outcome === 'final ok') held.finalCallback?.()
    else if (outcome === 'final error') held.finalCallback?.(new Error('bad'))
    else held.destroy()
    await settle()
    log(`pending ends ${outcome}: ${order.join(' ')}`)
  }
}

async function endWithChunk(): Promise<void> {
  const sink = new Sink()
  let calls = 0
  sink.end('x', () => {
    calls++
  })
  await settle()
  log(`end with chunk: callback calls ${calls} received ${sink.received.join(' | ')}`)
}

async function pushAfterEnd(autoDestroy: boolean): Promise<void> {
  const source = new Source({ autoDestroy })
  const events = watch(source)
  source.on('data', () => {})
  source.push('x')
  source.push(null)
  const accepted = source.push('late')
  source.push(null)
  await settle()
  log(`push after end autoDestroy ${autoDestroy}: returned ${accepted} destroyed ${source.destroyed} events ${events.join(',')}`)
}

async function main(): Promise<void> {
  for (const autoDestroy of [true, false]) await readableEnd(autoDestroy)
  for (const autoDestroy of [true, false]) await writableFinish(autoDestroy)
  for (const autoDestroy of [true, false]) await writableError(autoDestroy)
  for (const autoDestroy of [true, false]) await writeAfterEnd(autoDestroy)
  await afterDestroy()
  for (const decode of [true, false]) await decodeStrings(decode)
  await duplexBothSides()
  await endStates()
  await pendingEnds()
  await endWithChunk()
  for (const autoDestroy of [true, false]) await pushAfterEnd(autoDestroy)
}

void main()
