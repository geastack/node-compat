// geatsc-compiled `node:stream` compatibility runtime.
//
// Stream chunks cross a deliberately dynamic boundary: byte streams carry the
// native Buffer value while object-mode streams may carry arbitrary values.
// State and listener lifecycle remain native fields/EventEmitter operations.

import { Buffer, BufferEncoding } from './buffer'
// The WHATWG stream classes are named DIRECTLY, with no import: they are
// declared by `whatwg-streams.ts`, which is a SCRIPT, so they live in the real
// global scope -- the same place `new ReadableStream(...)` reads them from in
// every other file here.
//
// Not through `./stream/web`, which is the `node:stream/web` MODULE surface
// over those same classes. That file can only re-export a global by binding it
// first (`const ReadableStreamAlias = ReadableStream`), and a generic class's
// bare name denotes no value in this target: there is no single class object
// for `ReadableStream<R>`, only the copy each instantiation names. The module
// body's read of it therefore has no cell to read, and importing from there
// pulled that whole body into every program that uses `node:stream`.
import {
  addAbortListener,
  captureRejections,
  captureRejectionSymbol,
  defaultMaxListeners,
  errorMonitor,
  EventEmitter,
  EventEmitterAsyncResource,
  EventHandler,
  getEventListeners,
  getMaxListeners,
  Listener,
  listenerCount,
  on as eventsOn,
  once as eventsOnce,
  setMaxListeners
} from './events'

export {
  addAbortListener,
  captureRejections,
  captureRejectionSymbol,
  defaultMaxListeners,
  errorMonitor,
  EventEmitter,
  EventEmitterAsyncResource,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  setMaxListeners
}
export { eventsOnce as once }
export { eventsOn as on }

export type TransformCallback = (error?: Error | null, data?: Buffer) => void
export type DestroyCallback = (error?: Error | null) => void
export type StreamCallback = (error?: Error | null) => void

export interface StreamOptions {
  emitClose?: boolean
  highWaterMark?: number
  objectMode?: boolean
  autoDestroy?: boolean
}

export interface ReadableOptions extends StreamOptions {
  encoding?: BufferEncoding
}

export interface WritableOptions extends StreamOptions {
  decodeStrings?: boolean
  defaultEncoding?: BufferEncoding
}

export interface TransformOptions extends ReadableOptions, WritableOptions {
  writableObjectMode?: boolean
  readableObjectMode?: boolean
}

export interface PipeOptions {
  end?: boolean
}

// The write/end/emit/once surface `pipe()` needs from an arbitrary destination. `pipe<T>` accepts
// any T (Node's real signature is exactly this unconstrained), so a cast to this interface at the
// boundary is the honest equivalent of `any` here -- it names every member actually called on the
// destination instead of hiding them.
interface PipeDestination {
  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean
  end?(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): unknown
  emit(name: string, ...args: unknown[]): boolean
  once(name: string, listener: (...args: unknown[]) => void): unknown
}

// Node's real `_writev(chunks, callback)` shape: an array of the queued
// `{chunk, encoding}` pairs a corked Writable batches up. This runtime's own
// `write()`/`uncork()` never call `_writev` (they drive `_write` one entry at
// a time via `performWrite`); it exists only as API surface a subclass may
// override, matching Node's contract.
interface WritevChunk {
  chunk: unknown
  encoding: BufferEncoding
}

let defaultByteHighWaterMark = 65536
let defaultObjectHighWaterMark = 16

function streamChunkLength(chunk: unknown, objectMode: boolean): number {
  if (objectMode) return 1
  if (Buffer.isBuffer(chunk)) return chunk.length
  if (typeof chunk === 'string') return Buffer.byteLength(chunk)
  return 1
}

function streamError(message: string, code: string): Error {
  // Keep `error` declared as plain `Error` (not the `Error & {code}`
  // intersection) so the return still lowers to `gea::runtime::Error`; the
  // intersection type widens to a structural record the moment it names the
  // variable, and geatsc has no conversion back from that record to the
  // native class. Cast only transiently, for the assignment.
  const error = new Error(message)
  ;(error as Error & { code: string }).code = code
  return error
}

function invokeCallback(callback: unknown, error?: Error | null): void {
  if (typeof callback === 'function') (callback as (error?: Error | null) => void)(error)
}

export class Stream extends EventEmitter {
  pipe<T>(destination: T, _options: PipeOptions = {}): T {
    return destination
  }

  compose<T>(stream: T): T {
    this.pipe(stream)
    return stream
  }
}

export class Readable extends Stream {
  private paused_: boolean
  // Allocated on first use, not per stream: an http IncomingMessage is a
  // Readable that most handlers never read or pipe, and each eager `[]` here
  // was one pooled allocation plus one cycle-collector candidate per request.
  private pending_: unknown[] | undefined
  private pendingLength_: number
  private pipeTargets_: PipeDestination[] | undefined
  private pipeDataListeners_: EventHandler[] | undefined
  private pipeEndListeners_: EventHandler[] | undefined
  private endPending_: boolean
  private endEmitted_: boolean
  private encoding_: BufferEncoding | ''
  private webPump_: WebReadablePump | null

  destroyed: boolean
  closed: boolean
  errored: Error | null
  readable: boolean
  readableAborted: boolean
  readableDidRead: boolean
  readableEnded: boolean
  readableFlowing: boolean | null
  readableHighWaterMark: number
  readableObjectMode: boolean

  constructor(options: ReadableOptions = {}) {
    super()
    this.paused_ = true
    this.pending_ = undefined
    this.pendingLength_ = 0
    this.pipeTargets_ = undefined
    this.pipeDataListeners_ = undefined
    this.pipeEndListeners_ = undefined
    this.endPending_ = false
    this.endEmitted_ = false
    this.encoding_ = options.encoding ?? ''
    this.webPump_ = null
    this.destroyed = false
    this.closed = false
    this.errored = null
    this.readable = true
    this.readableAborted = false
    this.readableDidRead = false
    this.readableEnded = false
    this.readableFlowing = null
    this.readableObjectMode = options.objectMode === true
    this.readableHighWaterMark = options.highWaterMark ?? getDefaultHighWaterMark(this.readableObjectMode)
  }

  get readableEncoding(): BufferEncoding | null {
    return this.encoding_ === '' ? null : this.encoding_
  }

  get readableLength(): number {
    return this.pendingLength_
  }

  attachWebPump(pump: WebReadablePump): void {
    this.webPump_ = pump
  }

  protected override newListenerAdded(name: string): void {
    if (name === 'data' && this.readableFlowing !== false) this.resume()
  }

  override on(name: string, listener: EventHandler): this {
    super.on(name, listener)
    return this
  }

  override addListener(name: string, listener: EventHandler): this {
    super.addListener(name, listener)
    return this
  }

  override prependListener(name: string, listener: EventHandler): this {
    super.prependListener(name, listener)
    return this
  }

  override once(name: string, listener: EventHandler): this {
    super.once(name, listener)
    return this
  }

  override prependOnceListener(name: string, listener: EventHandler): this {
    super.prependOnceListener(name, listener)
    return this
  }

  override off(name: string, listener: EventHandler): this {
    super.off(name, listener)
    return this
  }

  override removeListener(name: string, listener: EventHandler): this {
    super.removeListener(name, listener)
    return this
  }

  override emit(name: string, ...args: unknown[]): boolean {
    return super.emit(name, ...args)
  }

  _construct(callback: StreamCallback): void {
    callback(null)
  }

  _read(_size: number): void {}

  protected emittedChunk(chunk: unknown): unknown {
    if (this.encoding_ !== '' && Buffer.isBuffer(chunk)) {
      return chunk.toString(this.encoding_)
    }
    return chunk
  }

  private pendingCount(): number {
    const pending = this.pending_
    return pending === undefined ? 0 : pending.length
  }

  private pendingChunks(): unknown[] {
    let pending = this.pending_
    if (pending === undefined) {
      pending = []
      this.pending_ = pending
    }
    return pending
  }

  // Lifecycle emits below are gated on `hasAnyListeners()`: `emit(name, ...args)`
  // materializes its rest array at the call site, so an ungated emit costs an
  // allocation even when nobody is listening -- and on the server hot path
  // nobody is.
  private maybeEmitEnd(): void {
    if (!this.endPending_ || this.pendingCount() !== 0 || this.endEmitted_) return
    this.endEmitted_ = true
    this.readableEnded = true
    this.readable = false
    if (this.hasAnyListeners()) this.emit('end')
  }

  private drainFlowing(): void {
    const pending = this.pending_
    if (pending !== undefined) {
      while (!this.paused_ && pending.length > 0) {
        const chunk: unknown = pending.shift()
        this.pendingLength_ -= streamChunkLength(chunk, this.readableObjectMode)
        if (this.pendingLength_ < 0) this.pendingLength_ = 0
        this.readableDidRead = true
        this.emit('data', this.emittedChunk(chunk))
      }
    }
    this.maybeEmitEnd()
  }

  pause(): this {
    this.paused_ = true
    this.readableFlowing = false
    if (this.hasAnyListeners()) this.emit('pause')
    return this
  }

  resume(): this {
    if (this.destroyed) return this
    this.paused_ = false
    this.readableFlowing = true
    if (this.hasAnyListeners()) this.emit('resume')
    this.drainFlowing()
    return this
  }

  isPaused(): boolean {
    return this.paused_
  }

  push(chunk: unknown, _encoding: BufferEncoding = 'utf8'): boolean {
    if (this.destroyed || this.endPending_) return false
    if (chunk === null) {
      this.pushEnd()
      return false
    }
    this.pendingChunks().push(chunk)
    this.pendingLength_ += streamChunkLength(chunk, this.readableObjectMode)
    if (this.hasAnyListeners()) this.emit('readable')
    if (!this.paused_) this.drainFlowing()
    return this.pendingLength_ < this.readableHighWaterMark
  }

  // `push(null)`, for a subclass that knows it is ending the stream. `push`
  // takes `unknown`, so its argument is boxed at the call site and unboxed
  // again here to be compared with `null` -- per call, which for
  // `http.IncomingMessage` is per request. Same effect, no carrier.
  protected pushEnd(): void {
    if (this.destroyed || this.endPending_) return
    this.endPending_ = true
    if (this.hasAnyListeners()) this.emit('readable')
    // 'end' belongs to consumption, not to the producer finishing: Node emits
    // it once the stream is flowing or has been read to exhaustion. Emitting it
    // here while still paused marked an EMPTY stream ended before anyone could
    // listen -- a POST with `Content-Length: 0` ends inside the constructor, so
    // the handler's `req.on('end', ...)` never fired and the request hung. A
    // stream with data never showed it, because pending chunks hold 'end' back
    // until `resume()`/`read()` drains them, which is the same rule.
    if (!this.paused_) this.maybeEmitEnd()
  }

  unshift(chunk: unknown, _encoding: BufferEncoding = 'utf8'): void {
    if (chunk === null || this.destroyed) return
    this.pendingChunks().unshift(chunk)
    this.pendingLength_ += streamChunkLength(chunk, this.readableObjectMode)
  }

  read(size: number = 0): unknown {
    const pending = this.pending_
    if (pending === undefined || pending.length === 0) {
      this._read(size > 0 ? size : this.readableHighWaterMark)
      this.maybeEmitEnd()
      return null
    }
    let chunk: unknown = pending.shift()
    if (!this.readableObjectMode && size > 0 && Buffer.isBuffer(chunk) && size < chunk.length) {
      const rest = chunk.subarray(size)
      chunk = chunk.subarray(0, size)
      pending.unshift(rest)
    } else if (!this.readableObjectMode && size > 0 && typeof chunk === 'string' && size < chunk.length) {
      const rest = chunk.substring(size)
      chunk = chunk.substring(0, size)
      pending.unshift(rest)
    }
    this.pendingLength_ -= streamChunkLength(chunk, this.readableObjectMode)
    if (this.pendingLength_ < 0) this.pendingLength_ = 0
    this.readableDidRead = true
    const emitted: unknown = this.emittedChunk(chunk)
    this.emit('data', emitted)
    this.maybeEmitEnd()
    return emitted
  }

  setEncoding(encoding: BufferEncoding): this {
    this.encoding_ = encoding
    return this
  }

  pipe<T>(destination: T, options: PipeOptions = {}): T {
    // `T` is unconstrained (Node's real signature too) -- this cast is the boundary where a
    // caller-supplied destination of any shape becomes the named PipeDestination surface every
    // call below actually uses.
    const target = destination as unknown as PipeDestination
    const onData = (...args: unknown[]): void => {
      const accepted = target.write(args[0])
      if (accepted === false) {
        this.pause()
        target.once('drain', () => this.resume())
      }
    }
    const onEnd = (): void => {
      if (options.end !== false && typeof target.end === 'function') target.end()
    }
    let targets = this.pipeTargets_
    let dataListeners = this.pipeDataListeners_
    let endListeners = this.pipeEndListeners_
    if (targets === undefined || dataListeners === undefined || endListeners === undefined) {
      targets = []
      dataListeners = []
      endListeners = []
      this.pipeTargets_ = targets
      this.pipeDataListeners_ = dataListeners
      this.pipeEndListeners_ = endListeners
    }
    targets.push(target)
    dataListeners.push(onData)
    endListeners.push(onEnd)
    this.once('end', onEnd)
    target.emit('pipe', this)
    this.on('data', onData)
    return destination
  }

  unpipe(destination?: unknown): this {
    const targets = this.pipeTargets_
    const dataListeners = this.pipeDataListeners_
    const endListeners = this.pipeEndListeners_
    if (targets === undefined || dataListeners === undefined || endListeners === undefined) return this
    for (let index = targets.length - 1; index >= 0; index--) {
      if (destination !== undefined && targets[index] !== destination) continue
      const target = targets[index]
      this.removeListener('data', dataListeners[index])
      this.removeListener('end', endListeners[index])
      targets.splice(index, 1)
      dataListeners.splice(index, 1)
      endListeners.splice(index, 1)
      target.emit('unpipe', this)
    }
    return this
  }

  // `oldStream` is a legacy pre-streams2 emitter of unspecified shape -- Node's real `wrap()`
  // takes exactly this genuinely-untyped boundary. `source` below names the one thing actually
  // called on it (`on`); the values it hands back stay `unknown` until push()/destroy() (which
  // already accept unknown/Error|null) decide what to do with them.
  wrap(oldStream: unknown): this {
    const source = oldStream as { on(name: string, listener: (...args: unknown[]) => void): unknown }
    source.on('data', (...args: unknown[]) => this.push(args[0]))
    source.on('end', () => this.push(null))
    source.on('error', (...args: unknown[]) => this.destroy((args[0] as Error | undefined) ?? null))
    return this
  }

  _destroy(error: Error | null, callback: DestroyCallback): void {
    callback(error)
  }

  destroy(error: Error | null = null): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.readableAborted = !this.readableEnded
    this.readable = false
    this.errored = error
    this._destroy(error, destroyError => {
      if (destroyError !== undefined && destroyError !== null) {
        this.errored = destroyError
        this.emit('error', destroyError)
      }
      this.closed = true
      this.emit('close')
    })
    return this
  }

  toArray(): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject) => {
      const values: unknown[] = []
      this.once('end', () => resolve(values))
      this.once('error', (...args: unknown[]) => reject(args[0]))
      this.on('data', (...args: unknown[]) => {
        values.push(args[0])
      })
      if (this.readableEnded) resolve(values)
      else this.resume()
    })
  }

  map(fn: (value: unknown, options?: unknown) => unknown): Readable {
    const output = new Readable({ objectMode: true })
    this.once('end', () => output.push(null))
    this.once('error', (...args: unknown[]) => output.destroy((args[0] as Error | undefined) ?? null))
    this.on('data', (...args: unknown[]) => {
      output.push(fn(args[0]))
    })
    return output
  }

  filter(fn: (value: unknown, options?: unknown) => boolean): Readable {
    const output = new Readable({ objectMode: true })
    this.once('end', () => output.push(null))
    this.once('error', (...args: unknown[]) => output.destroy((args[0] as Error | undefined) ?? null))
    this.on('data', (...args: unknown[]) => {
      if (fn(args[0])) output.push(args[0])
    })
    return output
  }

  flatMap(fn: (value: unknown, options?: unknown) => unknown[]): Readable {
    const output = new Readable({ objectMode: true })
    this.once('end', () => output.push(null))
    this.once('error', (...args: unknown[]) => output.destroy((args[0] as Error | undefined) ?? null))
    this.on('data', (...args: unknown[]) => {
      const values = fn(args[0])
      for (let index = 0; index < values.length; index++) output.push(values[index])
    })
    return output
  }

  drop(limit: number): Readable {
    let seen = 0
    return this.filter(() => {
      seen++
      return seen > limit
    })
  }

  take(limit: number): Readable {
    let seen = 0
    return this.filter(() => {
      seen++
      return seen <= limit
    })
  }

  asIndexedPairs(): Readable {
    let index = 0
    return this.map(value => {
      const pair: unknown[] = [index, value]
      index++
      return pair
    })
  }

  forEach(fn: (value: unknown, options?: unknown) => void): Promise<void> {
    return this.toArray().then(values => {
      for (let index = 0; index < values.length; index++) fn(values[index])
    })
  }

  every(fn: (value: unknown, options?: unknown) => boolean): Promise<boolean> {
    return this.toArray().then(values => {
      for (let index = 0; index < values.length; index++) {
        if (!fn(values[index])) return false
      }
      return true
    })
  }

  some(fn: (value: unknown, options?: unknown) => boolean): Promise<boolean> {
    return this.toArray().then(values => {
      for (let index = 0; index < values.length; index++) {
        if (fn(values[index])) return true
      }
      return false
    })
  }

  find(fn: (value: unknown, options?: unknown) => boolean): Promise<unknown> {
    return this.toArray().then(values => {
      for (let index = 0; index < values.length; index++) {
        if (fn(values[index])) return values[index]
      }
      return undefined
    })
  }

  reduce(fn: (previous: unknown, value: unknown, options?: unknown) => unknown, initial?: unknown): Promise<unknown> {
    return this.toArray().then(values => {
      let index = 0
      let result: unknown = initial
      if (result === undefined && values.length > 0) {
        result = values[0]
        index = 1
      }
      for (; index < values.length; index++) result = fn(result, values[index])
      return result
    })
  }

  iterator(options: { destroyOnReturn?: boolean } = {}): NodeReadableIterator {
    return new NodeReadableIterator(this, options.destroyOnReturn !== false)
  }

  [Symbol.asyncIterator](): NodeReadableIterator {
    return this.iterator()
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.destroy()
    return Promise.resolve()
  }

  static from(iterable: Iterable<unknown>, options: unknown = undefined): Readable {
    // Keep the public options boundary concrete across translation units. The
    // declaration facade supplies the rich ReadableOptions type; the runtime
    // receives its record as gea_cpp_value and projects the fields it supports.
    const runtimeOptions = options as { objectMode?: boolean } | undefined
    const objectMode = runtimeOptions === undefined || runtimeOptions.objectMode !== false
    const readable = new Readable({ objectMode })
    for (const value of iterable) readable.push(value)
    readable.push(null)
    return readable
  }

  static isDisturbed(stream: Readable): boolean {
    return stream.readableDidRead || stream.readableEnded || stream.destroyed
  }

  static fromWeb(readableStream: unknown, options: unknown = undefined): Readable {
    return readableFromWeb(readableStream, options)
  }

  static toWeb(streamReadable: Readable, _options: unknown = undefined): ReadableStream {
    return readableToWeb(streamReadable)
  }
}

interface NodeReadableIteratorResult {
  done: boolean
  value: unknown
}

class NodeReadableIterator {
  private stream_: Readable | null
  private destroyOnReturn_: boolean

  constructor(stream: Readable, destroyOnReturn: boolean) {
    this.stream_ = stream
    this.destroyOnReturn_ = destroyOnReturn
  }

  next(): Promise<NodeReadableIteratorResult> {
    if (this.stream_ === null) {
      const result: NodeReadableIteratorResult = { done: true, value: undefined }
      return Promise.resolve(result)
    }
    const stream = this.stream_
    const value: unknown = stream.read()
    if (value !== null) {
      const result: NodeReadableIteratorResult = { done: false, value }
      return Promise.resolve(result)
    }
    if (stream.readableEnded || stream.destroyed) {
      this.stream_ = null
      const result: NodeReadableIteratorResult = { done: true, value: undefined }
      return Promise.resolve(result)
    }
    return new Promise<NodeReadableIteratorResult>((resolve, reject) => {
      const cleanup: Listener = (..._args: unknown[]): void => {
        stream.removeListener('readable', onReadable)
        stream.removeListener('end', onEnd)
        stream.removeListener('error', onError)
      }
      const onReadable: Listener = (..._args: unknown[]): void => {
        const nextValue: unknown = stream.read()
        if (nextValue === null) return
        cleanup()
        resolve({ done: false, value: nextValue })
      }
      const onEnd: Listener = (..._args: unknown[]): void => {
        cleanup()
        this.stream_ = null
        resolve({ done: true, value: undefined })
      }
      const onError: Listener = (...errors: unknown[]): void => {
        cleanup()
        this.stream_ = null
        reject(errors[0])
      }
      stream.once('readable', onReadable)
      stream.once('end', onEnd)
      stream.once('error', onError)
    })
  }

  return(): Promise<NodeReadableIteratorResult> {
    if (this.stream_ !== null && this.destroyOnReturn_) this.stream_.destroy()
    this.stream_ = null
    const result: NodeReadableIteratorResult = { done: true, value: undefined }
    return Promise.resolve(result)
  }

  [Symbol.asyncIterator](): NodeReadableIterator {
    return this
  }
}

// Writable extends Stream directly -- Node's real hierarchy (`lib/internal/streams/writable.js`:
// `Writable.prototype` chains to `Stream.prototype`, not `Readable.prototype`). A prior version
// of this runtime had Writable extend Readable for convenience; that put every Readable field
// (paused_/pending_/pipeTargets_/.../readableHighWaterMark -- 20 instance fields plus the whole
// pipe/pause/resume/push/read/map/filter/... method surface) on every Writable instance,
// including ServerResponse, which is allocated once per HTTP request on the hot path. None of it
// was ever read: nothing in this repo passes a plain (non-Duplex) Writable somewhere a Readable
// is expected, or calls a Readable-only member (push/read/pipe/setEncoding/readable*) on one --
// verified by grepping runtime/ and apps/ before making this change. Writable now carries only
// its own state.
//
// Duplex needs both sides. Node gets this via a prototype mixin (`Object.setPrototypeOf(Duplex.prototype,
// Readable.prototype)` then copying Writable.prototype's own methods onto Duplex.prototype) --
// `Duplex.prototype instanceof Writable` is actually FALSE in real Node, matching what this class
// hierarchy now does too. TypeScript has no prototype-mixin primitive, so Duplex extends Readable
// and declares the writable-side fields/methods directly (duplicated from Writable below, not
// inherited) -- the "honest equivalent" the investigation for this change called for.
export class Writable extends Stream {
  // The cork queue exists only while corked; see Readable's pending_ for why
  // it is not allocated per stream (a ServerResponse is a Writable per request).
  private writeQueue_: unknown[] | undefined
  private writeEncodingQueue_: string[] | undefined
  private writeCallbackQueue_: unknown[] | undefined
  private defaultEncoding_: string

  destroyed: boolean
  closed: boolean
  errored: Error | null
  writable: boolean
  writableAborted: boolean
  writableCorked: number
  writableEnded: boolean
  writableFinished: boolean
  writableHighWaterMark: number
  writableLength: number
  writableNeedDrain: boolean
  writableObjectMode: boolean

  constructor(options: WritableOptions = {}) {
    super()
    this.writeQueue_ = undefined
    this.writeEncodingQueue_ = undefined
    this.writeCallbackQueue_ = undefined
    this.defaultEncoding_ = options.defaultEncoding ?? 'utf8'
    this.destroyed = false
    this.closed = false
    this.errored = null
    this.writable = true
    this.writableAborted = false
    this.writableCorked = 0
    this.writableEnded = false
    this.writableFinished = false
    this.writableObjectMode = options.objectMode === true
    this.writableHighWaterMark = options.highWaterMark ?? getDefaultHighWaterMark(this.writableObjectMode)
    this.writableLength = 0
    this.writableNeedDrain = false
  }

  override on(name: string, listener: EventHandler): this {
    super.on(name, listener)
    return this
  }

  override addListener(name: string, listener: EventHandler): this {
    super.addListener(name, listener)
    return this
  }

  override prependListener(name: string, listener: EventHandler): this {
    super.prependListener(name, listener)
    return this
  }

  override once(name: string, listener: EventHandler): this {
    super.once(name, listener)
    return this
  }

  override prependOnceListener(name: string, listener: EventHandler): this {
    super.prependOnceListener(name, listener)
    return this
  }

  override removeListener(name: string, listener: EventHandler): this {
    super.removeListener(name, listener)
    return this
  }

  override emit(name: string, ...args: unknown[]): boolean {
    return super.emit(name, ...args)
  }

  _write(_chunk: unknown, _encoding: string, callback: StreamCallback): void {
    callback(null)
  }

  _writev(chunks: WritevChunk[], callback: StreamCallback): void {
    for (let index = 0; index < chunks.length; index++) {
      const entry = chunks[index]
      this._write(entry.chunk, entry.encoding, () => {})
    }
    callback(null)
  }

  _final(callback: StreamCallback): void {
    callback(null)
  }

  _destroy(error: Error | null, callback: DestroyCallback): void {
    callback(error)
  }

  private performWrite(chunk: unknown, encoding: string, callback: unknown): void {
    const length = streamChunkLength(chunk, this.writableObjectMode)
    this.writableLength += length
    this._write(chunk, encoding, error => {
      this.writableLength -= length
      if (this.writableLength < 0) this.writableLength = 0
      if (error) {
        this.errored = error
        invokeCallback(callback, error)
        this.emit('error', error)
        return
      }
      invokeCallback(callback, null)
      if (this.writableNeedDrain && this.writableLength < this.writableHighWaterMark) {
        this.writableNeedDrain = false
        this.emit('drain')
      }
    })
  }

  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    if (this.writableEnded || this.destroyed) {
      const error: Error = streamError('write after end', 'ERR_STREAM_WRITE_AFTER_END')
      invokeCallback(typeof encodingOrCallback === 'function' ? encodingOrCallback : callback, error)
      this.emit('error', error)
      return false
    }
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : this.defaultEncoding_
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (this.writableCorked > 0) {
      let queue = this.writeQueue_
      let encodings = this.writeEncodingQueue_
      let callbacks = this.writeCallbackQueue_
      if (queue === undefined || encodings === undefined || callbacks === undefined) {
        queue = []
        encodings = []
        callbacks = []
        this.writeQueue_ = queue
        this.writeEncodingQueue_ = encodings
        this.writeCallbackQueue_ = callbacks
      }
      queue.push(chunk)
      encodings.push(encoding)
      callbacks.push(done)
      this.writableLength += streamChunkLength(chunk, this.writableObjectMode)
    } else {
      this.performWrite(chunk, encoding, done)
    }
    const accepted = this.writableLength < this.writableHighWaterMark
    if (!accepted) this.writableNeedDrain = true
    return accepted
  }

  cork(): void {
    this.writableCorked++
  }

  uncork(): void {
    if (this.writableCorked === 0) return
    this.writableCorked--
    if (this.writableCorked !== 0) return
    const queue = this.writeQueue_
    const encodings = this.writeEncodingQueue_
    const callbacks = this.writeCallbackQueue_
    this.writableLength = 0
    if (queue === undefined || encodings === undefined || callbacks === undefined) return
    this.writeQueue_ = undefined
    this.writeEncodingQueue_ = undefined
    this.writeCallbackQueue_ = undefined
    for (let index = 0; index < queue.length; index++) {
      this.performWrite(queue[index], encodings[index], callbacks[index])
    }
  }

  setDefaultEncoding(encoding: BufferEncoding): this {
    this.defaultEncoding_ = encoding
    return this
  }

  end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): this {
    let done: unknown = callback
    if (typeof encodingOrCallback === 'function') done = encodingOrCallback
    if (typeof chunk === 'function') {
      done = chunk
      chunk = undefined
    }
    if (chunk !== undefined) this.write(chunk, encodingOrCallback)
    while (this.writableCorked > 0) this.uncork()
    if (this.writableEnded) {
      invokeCallback(done, null)
      return this
    }
    this.writableEnded = true
    this.writable = false
    this._final(error => {
      if (error) {
        this.errored = error
        invokeCallback(done, error)
        this.emit('error', error)
        return
      }
      this.writableFinished = true
      this.emit('finish')
      invokeCallback(done, null)
    })
    return this
  }

  destroy(error: Error | null = null): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.writableAborted = !this.writableFinished
    this.writable = false
    this.errored = error
    this._destroy(error, destroyError => {
      if (destroyError !== undefined && destroyError !== null) {
        this.errored = destroyError
        this.emit('error', destroyError)
      }
      this.closed = true
      this.emit('close')
    })
    return this
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.destroy()
    return Promise.resolve()
  }

  static fromWeb(writableStream: unknown, options: unknown = undefined): Writable {
    return new WebWritableAdapter(writableStream, options)
  }

  static toWeb(streamWritable: Writable): WritableStream {
    return writableToWeb(streamWritable)
  }
}

// Duplex extends Readable and declares its own writable-side fields/methods (copied from
// Writable above, not inherited -- see the comment on Writable for why). This is the "honest
// TypeScript equivalent" of Node's Readable+Writable mixin: same field layout Node's real Duplex
// carries (all of Readable's state plus all of Writable's), on the classes that actually need
// both sides, and nowhere else.
export class Duplex extends Readable {
  private writeQueue_: unknown[]
  private writeEncodingQueue_: string[]
  private writeCallbackQueue_: unknown[]
  private defaultEncoding_: string

  allowHalfOpen: boolean
  private peer_: Duplex | null

  writable: boolean
  writableAborted: boolean
  writableCorked: number
  writableEnded: boolean
  writableFinished: boolean
  writableHighWaterMark: number
  writableLength: number
  writableNeedDrain: boolean
  writableObjectMode: boolean

  constructor(options: TransformOptions = {}) {
    super(options)
    this.writeQueue_ = []
    this.writeEncodingQueue_ = []
    this.writeCallbackQueue_ = []
    this.defaultEncoding_ = options.defaultEncoding ?? 'utf8'
    this.allowHalfOpen = true
    this.peer_ = null
    this.writable = true
    this.writableAborted = false
    this.writableCorked = 0
    this.writableEnded = false
    this.writableFinished = false
    this.writableObjectMode = options.objectMode === true
    this.writableHighWaterMark = options.highWaterMark ?? getDefaultHighWaterMark(this.writableObjectMode)
    this.writableLength = 0
    this.writableNeedDrain = false
  }

  override on(name: string, listener: EventHandler): this {
    super.on(name, listener)
    return this
  }

  override addListener(name: string, listener: EventHandler): this {
    super.addListener(name, listener)
    return this
  }

  override prependListener(name: string, listener: EventHandler): this {
    super.prependListener(name, listener)
    return this
  }

  override once(name: string, listener: EventHandler): this {
    super.once(name, listener)
    return this
  }

  override prependOnceListener(name: string, listener: EventHandler): this {
    super.prependOnceListener(name, listener)
    return this
  }

  override removeListener(name: string, listener: EventHandler): this {
    super.removeListener(name, listener)
    return this
  }

  override emit(name: string, ...args: unknown[]): boolean {
    return super.emit(name, ...args)
  }

  attachPeer(peer: Duplex): void {
    this.peer_ = peer
  }

  _write(chunk: unknown, _encoding: string, callback: StreamCallback): void {
    if (this.peer_ !== null) this.peer_.push(chunk)
    callback(null)
  }

  _writev(chunks: WritevChunk[], callback: StreamCallback): void {
    for (let index = 0; index < chunks.length; index++) {
      const entry = chunks[index]
      this._write(entry.chunk, entry.encoding, () => {})
    }
    callback(null)
  }

  _final(callback: StreamCallback): void {
    callback(null)
  }

  private performWrite(chunk: unknown, encoding: string, callback: unknown): void {
    const length = streamChunkLength(chunk, this.writableObjectMode)
    this.writableLength += length
    this._write(chunk, encoding, error => {
      this.writableLength -= length
      if (this.writableLength < 0) this.writableLength = 0
      if (error) {
        this.errored = error
        invokeCallback(callback, error)
        this.emit('error', error)
        return
      }
      invokeCallback(callback, null)
      if (this.writableNeedDrain && this.writableLength < this.writableHighWaterMark) {
        this.writableNeedDrain = false
        this.emit('drain')
      }
    })
  }

  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    if (this.writableEnded || this.destroyed) {
      const error: Error = streamError('write after end', 'ERR_STREAM_WRITE_AFTER_END')
      invokeCallback(typeof encodingOrCallback === 'function' ? encodingOrCallback : callback, error)
      this.emit('error', error)
      return false
    }
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : this.defaultEncoding_
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (this.writableCorked > 0) {
      this.writeQueue_.push(chunk)
      this.writeEncodingQueue_.push(encoding)
      this.writeCallbackQueue_.push(done)
      this.writableLength += streamChunkLength(chunk, this.writableObjectMode)
    } else {
      this.performWrite(chunk, encoding, done)
    }
    const accepted = this.writableLength < this.writableHighWaterMark
    if (!accepted) this.writableNeedDrain = true
    return accepted
  }

  cork(): void {
    this.writableCorked++
  }

  uncork(): void {
    if (this.writableCorked === 0) return
    this.writableCorked--
    if (this.writableCorked !== 0) return
    const queued = this.writeQueue_.length
    this.writableLength = 0
    for (let index = 0; index < queued; index++) {
      this.performWrite(this.writeQueue_[index], this.writeEncodingQueue_[index], this.writeCallbackQueue_[index])
    }
    this.writeQueue_ = []
    this.writeEncodingQueue_ = []
    this.writeCallbackQueue_ = []
  }

  setDefaultEncoding(encoding: BufferEncoding): this {
    this.defaultEncoding_ = encoding
    return this
  }

  end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): this {
    let done: unknown = callback
    if (typeof encodingOrCallback === 'function') done = encodingOrCallback
    if (typeof chunk === 'function') {
      done = chunk
      chunk = undefined
    }
    if (chunk !== undefined) this.write(chunk, encodingOrCallback)
    while (this.writableCorked > 0) this.uncork()
    if (this.writableEnded) {
      invokeCallback(done, null)
      return this
    }
    this.writableEnded = true
    this.writable = false
    this._final(error => {
      if (error) {
        this.errored = error
        invokeCallback(done, error)
        this.emit('error', error)
        return
      }
      this.writableFinished = true
      this.emit('finish')
      invokeCallback(done, null)
    })
    return this
  }

  override destroy(error: Error | null = null): this {
    this.writableAborted = !this.writableFinished
    this.writable = false
    super.destroy(error)
    return this
  }

  static from(body: unknown): Duplex {
    const duplex = new Duplex({ objectMode: true })
    if (
      body !== undefined &&
      body !== null &&
      typeof (body as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
    ) {
      for (const value of body as Iterable<unknown>) duplex.push(value)
      duplex.push(null)
    }
    return duplex
  }

  static fromWeb(pair: unknown, options: unknown = undefined): Duplex {
    return new WebDuplexAdapter(pair, options)
  }
}

// `Duplex.toWeb` is NOT offered, and the gap is stated here rather than
// faked. `Duplex extends Readable`, and Readable already declares a `static
// toWeb` returning a `ReadableStream`; a same-named static returning the
// unrelated `{ readable, writable }` pair is not a valid override, because
// TypeScript checks a subclass's static side against its base's exactly as it
// checks instances. (Node's own type declarations dodge this by never modeling
// Duplex as `extends Readable` in the types, only in the runtime prototype
// chain -- not an option here, since this file IS the runtime.)
//
// The escape this used to take was `(Duplex as unknown as DuplexToWeb).toWeb =
// ...` after the class declaration. That is a real JavaScript operation -- an
// own property on the `Duplex` constructor shadowing the base constructor's --
// but it is one geatsc does not represent: its static-field census
// (`ir/class-static-fields.ts`) gives storage only to a key that names no
// static member along the base chain, so a key whose callable home is an
// INHERITED static method gets none, and the module-body write refuses at
// emission ("a set operation has a receiver carrier of kind
// constructor-family"). Rendering it would need the read side, the call side
// and the census to agree on shadowing; until they do, an attached `toWeb`
// would be an API this target cannot emit.
//
// Nothing in this target or in `@hono/node-server` calls `Duplex.toWeb` --
// only `Readable.toWeb` and `Writable.toWeb`, which are ordinary statics on
// their own classes and work. The bridge itself stays available as a function,
// so restoring the static costs one line once the compiler can carry it. Same
// posture as `TextEncoder.encodeInto` elsewhere in this target: a member with
// no implementation behind it is absent, never fabricated.
export const duplexToWeb = (duplex: Duplex): { readable: ReadableStream; writable: WritableStream } => ({
  readable: readableToWeb(duplex),
  writable: writableToWeb(duplex)
})

export class Transform extends Duplex {
  constructor(options: TransformOptions = {}) {
    super(options)
  }

  _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    callback(null, chunk)
  }

  _flush(callback: TransformCallback): void {
    callback(null)
  }

  override _write(chunk: unknown, encoding: string, callback: StreamCallback): void {
    this._transform(chunk as Buffer, encoding, (error?: Error | null, data?: Buffer) => {
      if (error) {
        callback(error)
        return
      }
      if (data !== undefined) this.push(data)
      callback(null)
    })
  }

  override _final(callback: StreamCallback): void {
    this._flush((error?: Error | null, data?: Buffer) => {
      if (error) {
        callback(error)
        return
      }
      if (data !== undefined) this.push(data)
      this.push(null)
      callback(null)
    })
  }
}

export class PassThrough extends Transform {
  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    callback(null, chunk)
  }
}

class WebReadablePump {
  private reader_: ReadableStreamDefaultReader<unknown>
  private destination_: Readable

  constructor(reader: ReadableStreamDefaultReader<unknown>, destination: Readable) {
    this.reader_ = reader
    this.destination_ = destination
  }

  next(): void {
    const pending = this.reader_.read()
    // One-argument `then` plus `catch`, never the two-argument `then` -- see
    // `_destroy` below for why this backend refuses the second argument. The
    // `settled` binding is not decoration: a discarded `catch` result is
    // refused too ("the two arms have no cell to agree on"), because `catch`
    // renders as a settled/value/reason triple that both arms write into.
    const settled = pending
      .then(result => {
        if (result.done) {
          this.destination_.push(null)
          this.reader_.releaseLock()
          return
        }
        this.destination_.push(result.value)
        this.next()
      })
      // A BLOCK body, not a concise one: `destroy()` returns `this` for
      // chaining, and a concise arrow would make that the handler's result --
      // so 27.2.5.1's own result would carry `void | Readable`, a union whose
      // fulfilled arm has no value to pass through (the receiver fulfills with
      // nothing). Discarding the stream here says what is meant: the handler
      // settles by running.
      .catch((error: unknown) => {
        this.destination_.destroy(error instanceof Error ? error : null)
      })
    void settled
  }
}

function pumpWebReadable(reader: ReadableStreamDefaultReader<unknown>, destination: Readable): void {
  const pump = new WebReadablePump(reader, destination)
  destination.attachWebPump(pump)
  pump.next()
}

function readableFromWeb(readableStream: unknown, options: unknown = undefined): Readable {
  const runtimeOptions = options as { objectMode?: boolean } | undefined
  const output = new Readable({ objectMode: runtimeOptions !== undefined && runtimeOptions.objectMode === true })
  const source = readableStream as ReadableStream<unknown>
  const reader = source.getReader()
  pumpWebReadable(reader, output)
  return output
}

// The controller's real shape (`ReadableStreamDefaultController<unknown>`)
// only exposes `enqueue`/`close`/`error` -- naming it here (instead of the
// underlying-source callback's inferred `any`) is enough to drop the casts
// this block used to need.
// `ReadableStream<R>` defaults to `R = Uint8Array` (matching real Node's
// `Readable.toWeb` typical usage, and what `@hono/node-server` itself
// declares -- `let reader: ReadableStreamDefaultReader<Uint8Array>`). But a
// source `Readable` can be in object mode (`Readable.from(['to-web'])`,
// see apps/stream-adapters), where 'data' hands back a string, not bytes --
// the genuinely dynamic byte-vs-object boundary this file's header comment
// describes. The cast at `enqueue` is that boundary, named instead of
// hidden behind `any`.
function readableToWeb(streamReadable: Readable): ReadableStream {
  return new ReadableStream({
    start(controller): void {
      streamReadable.on('data', (chunk?: unknown) => controller.enqueue(chunk as Uint8Array))
      streamReadable.once('end', () => controller.close())
      streamReadable.once('error', (error?: unknown) => controller.error(error))
      streamReadable.resume()
    },
    cancel(reason?: unknown): void {
      streamReadable.destroy(reason instanceof Error ? reason : null)
    }
  })
}

class WebWritableAdapter extends Writable {
  private writer_: WritableStreamDefaultWriter

  constructor(writableStream: unknown, options: unknown = undefined) {
    const runtimeOptions = options as { objectMode?: boolean } | undefined
    super({ objectMode: runtimeOptions !== undefined && runtimeOptions.objectMode === true })
    const sink = writableStream as WritableStream
    this.writer_ = sink.getWriter()
  }

  override _write(chunk: unknown, _encoding: string, callback: StreamCallback): void {
    // Bytes vs. object mode is a genuinely dynamic boundary here -- see the
    // comment on `readableToWeb`. `WritableStreamDefaultWriter.write` is
    // typed for the byte-mode default; this cast is that boundary, named.
    this.writer_.write(chunk as Uint8Array)
    callback(null)
  }

  override _final(callback: StreamCallback): void {
    this.writer_.close()
    this.writer_.releaseLock()
    callback(null)
  }

  override _destroy(error: Error | null, callback: DestroyCallback): void {
    if (error === null) {
      callback(null)
      return
    }
    const pending = this.writer_.abort(error)
    // `.then(onFulfilled).catch(onRejected)` rather than the two-argument
    // `.then(onFulfilled, onRejected)`: this backend implements `then` for its
    // one fulfillment handler only (ECMA-262 27.2.5.4) and refuses a rejection
    // handler BY NAME rather than dropping it, because its promise carrier
    // holds a fulfilled value and no rejection state. `catch` is implemented.
    // The two spellings differ in one way that does not matter here -- a
    // `catch` also sees a throw from the fulfillment handler, and that handler
    // is `callback(error)`, whose own failure there is no better answer for.
    const settled = pending
      .then(() => callback(error))
      .catch((abortError: unknown) => callback(abortError instanceof Error ? abortError : error))
    void settled
  }
}

// The write/end/destroy shape shared by Writable and Duplex. Duplex no longer extends Writable
// (see the comment on Writable above), so the two are not nominally related -- private fields on
// each make them structurally incompatible too. This interface is what `Duplex.toWeb` actually
// needs to pass a Duplex through the same web-stream bridge Writable.toWeb uses.
//
// `end` and `destroy` are declared `void` rather than `unknown`, deliberately.
// Both really return `this` on the concrete classes, and `writableToWeb` below
// uses neither result -- so `unknown` was asking the view adapter for a class
// instance boxed into the dynamic carrier at every call, a conversion nothing
// installs and which the emitter correctly refuses. A `void` member accepts a
// method returning anything (TypeScript's own return-type bivariance for
// exactly this "I ignore the result" case) and states what the bridge needs.
interface WritableSink {
  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean
  end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): void
  destroy(error?: Error | null): void
}

function writableToWeb(streamWritable: WritableSink): WritableStream {
  return new WritableStream({
    write(chunk: unknown): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        streamWritable.write(chunk, (error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        streamWritable.end((error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    abort(reason?: unknown): void {
      streamWritable.destroy(reason instanceof Error ? reason : null)
    }
  })
}

// `Duplex.fromWeb`'s real Node shape is `{ readable, writable }` -- a plain
// pair, not a class of its own -- so `pair` stays `unknown` at the public
// boundary (matching `fromWeb`'s declared param above) and is named here,
// where it is actually read.
interface WebDuplexPair {
  readable: ReadableStream<unknown>
  writable: WritableStream
}

class WebDuplexAdapter extends Duplex {
  private writer_: WritableStreamDefaultWriter

  constructor(pair: unknown, options: unknown = undefined) {
    const runtimeOptions = options as { objectMode?: boolean } | undefined
    super({ objectMode: runtimeOptions !== undefined && runtimeOptions.objectMode === true })
    const runtimePair = pair as WebDuplexPair
    this.writer_ = runtimePair.writable.getWriter()
    const reader = runtimePair.readable.getReader()
    pumpWebReadable(reader, this)
  }

  override _write(chunk: unknown, _encoding: string, callback: StreamCallback): void {
    // Same dynamic byte-vs-object boundary as WebWritableAdapter._write above.
    this.writer_.write(chunk as Uint8Array)
    callback(null)
  }

  override _final(callback: StreamCallback): void {
    this.writer_.close()
    this.writer_.releaseLock()
    callback(null)
  }
}

export function getDefaultHighWaterMark(objectMode: boolean): number {
  return objectMode ? defaultObjectHighWaterMark : defaultByteHighWaterMark
}

export function setDefaultHighWaterMark(objectMode: boolean, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw streamError('highWaterMark must be a non-negative integer', 'ERR_INVALID_ARG_VALUE')
  }
  if (objectMode) defaultObjectHighWaterMark = value
  else defaultByteHighWaterMark = value
}

// `isErrored`/`isReadable`/`isWritable`/`addAbortSignal`/`finished`/`pipeline` all operate
// polymorphically over whichever of Readable, Writable or Duplex is handed in -- exactly Node's
// own signatures (`NodeJS.ReadableStream | NodeJS.WritableStream`). Since Writable no longer
// extends Readable (see the hierarchy comment above `class Writable`), there is no single class
// that carries every member these functions touch; this interface names exactly the ones they
// read or call, across that union, instead of leaving the receiver untyped.
interface StreamLike {
  readable?: boolean
  writable?: boolean
  destroyed?: boolean
  errored?: Error | null
  readableEnded?: boolean
  writableEnded?: boolean
  writableFinished?: boolean
  once(name: string, listener: EventHandler): unknown
  removeListener(name: string, listener: EventHandler): unknown
  destroy(error?: Error | null): unknown
}

export function isErrored(stream: unknown): boolean {
  const candidate = stream as StreamLike | null | undefined
  return candidate !== undefined && candidate !== null && candidate.errored !== undefined && candidate.errored !== null
}

export function isReadable(stream: unknown): boolean {
  const candidate = stream as StreamLike | null | undefined
  return candidate !== undefined && candidate !== null && candidate.readable === true && candidate.destroyed !== true
}

export function isWritable(stream: unknown): boolean {
  const candidate = stream as StreamLike | null | undefined
  return candidate !== undefined && candidate !== null && candidate.writable === true && candidate.destroyed !== true
}

export function addAbortSignal<S extends StreamLike>(signal: AbortSignal, stream: S): S {
  signal.addEventListener('abort', () => {
    stream.destroy(streamError('The operation was aborted', 'ABORT_ERR'))
  })
  return stream
}

export function finished(
  stream: StreamLike,
  optionsOrCallback: unknown,
  maybeCallback?: (error?: Error | null) => void
): () => void {
  const callback =
    typeof optionsOrCallback === 'function' ? (optionsOrCallback as (error?: Error | null) => void) : maybeCallback
  let called = false
  const done = (error?: Error | null): void => {
    if (called) return
    called = true
    if (callback !== undefined) callback(error)
  }
  const onEnd: EventHandler = (): void => {
    if (stream.writable === undefined || stream.writableFinished === true || stream.writableEnded === true) done(null)
  }
  const onFinish: EventHandler = (): void => {
    if (stream.readable === undefined || stream.readableEnded === true) done(null)
  }
  const onClose: EventHandler = (): void => {
    done(stream.errored)
  }
  const onError: EventHandler = (...args: readonly any[]): void => {
    done((args[0] as Error | undefined) ?? null)
  }
  stream.once('end', onEnd)
  stream.once('finish', onFinish)
  stream.once('close', onClose)
  stream.once('error', onError)
  if (stream.readableEnded === true || stream.writableFinished === true) done(null)
  return () => {
    stream.removeListener('end', onEnd)
    stream.removeListener('finish', onFinish)
    stream.removeListener('close', onClose)
    stream.removeListener('error', onError)
  }
}

function pipelineArray(streamsAndCallback: unknown[], suppliedCallback: ((error?: Error | null) => void) | undefined = undefined): Stream {
  if (streamsAndCallback.length === 0) {
    throw streamError('pipeline requires streams', 'ERR_MISSING_ARGS')
  }
  let callback = suppliedCallback
  if (typeof streamsAndCallback[streamsAndCallback.length - 1] === 'function') {
    callback = streamsAndCallback.pop() as (error?: Error | null) => void
  }
  const streams: Stream[] = (
    streamsAndCallback.length === 1 && Array.isArray(streamsAndCallback[0]) ? streamsAndCallback[0] : streamsAndCallback
  ) as Stream[]
  if (streams.length < 2) throw streamError('pipeline requires at least two streams', 'ERR_MISSING_ARGS')
  // Attach downstream first. A Readable created from an in-memory iterable can
  // drain synchronously as soon as its first `data` listener is installed.
  for (let index = streams.length - 2; index >= 0; index--) streams[index].pipe(streams[index + 1])
  const destination = streams[streams.length - 1]
  if (callback !== undefined) {
    // Route through a local declared `unknown` first. Casting the nominal
    // `Stream` class-ref straight to the structural `StreamLike` asks
    // geatsc to materialize a class-to-record conversion that isn't
    // registered; `finishedPromise` below already hands `finished` a value
    // whose declared type is `unknown` this same way, and that call site
    // certifies fine.
    const destinationLike: unknown = destination
    finished(destinationLike as StreamLike, callback)
  }
  return destination
}

// A fixed concrete ABI avoids exporting a C++ rest-vector function to callers
// whose TypeScript declaration exposes Node's many positional overloads. Ten
// slots cover the longest stable Node 24 pipeline overload and the array form.
export function pipeline(
  first: unknown,
  second?: unknown,
  third?: unknown,
  fourth?: unknown,
  fifth?: unknown,
  sixth?: unknown,
  seventh?: unknown,
  eighth?: unknown,
  ninth?: unknown,
  tenth?: unknown
): Stream {
  const values: unknown[] = [first]
  if (second !== undefined) values.push(second)
  if (third !== undefined) values.push(third)
  if (fourth !== undefined) values.push(fourth)
  if (fifth !== undefined) values.push(fifth)
  if (sixth !== undefined) values.push(sixth)
  if (seventh !== undefined) values.push(seventh)
  if (eighth !== undefined) values.push(eighth)
  if (ninth !== undefined) values.push(ninth)
  if (tenth !== undefined) values.push(tenth)
  return pipelineArray(values)
}

export function duplexPair(options: TransformOptions = {}): Duplex[] {
  const first = new Duplex(options)
  const second = new Duplex(options)
  first.attachPeer(second)
  second.attachPeer(first)
  return [first, second]
}

export function finishedPromise(stream: unknown, options: unknown = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    finished(stream as StreamLike, options, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

export function pipelinePromise(
  first: unknown,
  second?: unknown,
  third?: unknown,
  fourth?: unknown,
  fifth?: unknown,
  sixth?: unknown,
  seventh?: unknown,
  eighth?: unknown,
  ninth?: unknown,
  tenth?: unknown
): Promise<Stream> {
  const streams: unknown[] = [first]
  if (second !== undefined) streams.push(second)
  if (third !== undefined) streams.push(third)
  if (fourth !== undefined) streams.push(fourth)
  if (fifth !== undefined) streams.push(fifth)
  if (sixth !== undefined) streams.push(sixth)
  if (seventh !== undefined) streams.push(seventh)
  if (eighth !== undefined) streams.push(eighth)
  if (ninth !== undefined) streams.push(ninth)
  if (tenth !== undefined) streams.push(tenth)
  return new Promise<Stream>((resolve, reject) => {
    const destination = streams[streams.length - 1] as Stream
    pipelineArray(streams, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(destination)
    })
  })
}

// The dynamic default-export bag geatsc's `node:stream` facade re-exports as
// `import stream from 'node:stream'` -- every member here is already a
// concretely-typed class/function; the bag itself is a plain namespace
// object, honestly `Record<string, unknown>` (the genuinely dynamic
// boundary is the re-export mechanism, not any one member).
type StreamNamespace = Record<string, unknown>

export const promises: StreamNamespace = {
  finished: finishedPromise,
  pipeline: pipelinePromise
}

export const prototype: Stream = new Stream()

const streamDefault: StreamNamespace = {
  addAbortListener,
  addAbortSignal,
  captureRejections,
  captureRejectionSymbol,
  defaultMaxListeners,
  Duplex,
  duplexPair,
  errorMonitor,
  EventEmitter,
  EventEmitterAsyncResource,
  finished,
  getDefaultHighWaterMark,
  getEventListeners,
  getMaxListeners,
  isErrored,
  isReadable,
  isWritable,
  listenerCount,
  on: eventsOn,
  once: eventsOnce,
  PassThrough,
  pipeline,
  promises,
  prototype,
  Readable,
  setDefaultHighWaterMark,
  setMaxListeners,
  Stream,
  Transform,
  Writable
}

export default streamDefault
