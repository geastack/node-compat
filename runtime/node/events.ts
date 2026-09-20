// geatsc-compiled `node:events` — EventEmitter for the node-compat runtime.
//
// Listener signatures are heterogeneous, so handlers live behind the dynamic
// value boundary (a genuine dynamic surface -- arbitrary arity, arbitrary arg types).
//
// Storage is FLAT parallel arrays — one entry per (event, listener) pair —
// mutated only through direct field methods (push/splice). Nested arrays
// (`listeners[i].push(fn)`) are avoided on purpose: element access on a
// nested vector yields a value copy in the emitted C++, so mutations through
// it are silently lost.

export type EventArgs = readonly unknown[]
/** What `emit` applies: a callable handed a positional list it cannot type in advance. */
export type Listener<A extends EventArgs = EventArgs, R = unknown> = (...args: A) => R
/**
 * What a caller may register: a callable that accepts any positional list, so
 * every concrete handler is assignable to it -- `net.ts`'s `(socket: Socket)
 * => void` included. `Listener`'s `unknown` parameter list is the bottom: it
 * accepts only handlers that themselves declare `unknown` parameters, which
 * refused every real handler in this target. The two meet once, in `addEntry`,
 * where a registration crosses into storage shared by every event -- never in
 * `emit`'s dispatch loop, whose shape the native lowering depends on.
 *
 * `any[]` and NOT `never[]`, even though `never[]` is the top of the function
 * lattice and reads as the more precise answer. A `(...args: never[]) => R` is
 * spelled the same way geatsc spells a callable that carries IDENTITY ONLY:
 * its carrier is `callable-identity`, which states no calling convention, so
 * the ABI projection refuses the function and lowering then refuses its body
 * ("reads ABI position 0, which this body's calling convention does not
 * declare"). On `apps/raw-http-hello` that one spelling cost the certificate
 * outright -- 1 ABI blocker at `stream.ts`'s `onError`, 1 lowering blocker
 * behind it, and 5 `no runtime conversion is installed from callable-identity`
 * certification refusals. `any[]` keeps the same assignability and lowers to a
 * real `function-value-dispatch` convention.
 */
export type EventHandler = Listener<readonly any[]>
export type EventName = string | symbol

/**
 * A subclass with statically known events types its OWN `on`/`once`/`emit`
 * with concrete overloads -- see `http.ts`'s `Server`, which spells
 * `on(name: 'upgrade', fn: (req: IncomingMessage, socket: Duplex, head:
 * Buffer) => void): this` next to the inherited catch-all, so
 * `server.on('upgrade', (req, socket, head) => ...)` still types `req` for
 * real.
 *
 * Deliberately NOT a type argument on `EventEmitter` (an
 * `EventEmitter<TEvents>` whose members read `TEvents[K]` was measured on
 * 2026-09-15 and reverted). An indexed access over a type parameter has no
 * member set until the class is monomorphized, and this class never is: the
 * generic version cost 30 blocking diagnostics on `hono-hello` -- every
 * listener array and dispatch signature in `addEntry`/`emitDispatch` picked
 * up a carrier containing `unresolved(an indexed access whose object type is
 * still a type parameter has no member set to resolve)`. Concrete per-class
 * overloads buy the same inline-listener typing with a carrier the
 * representation layer can name.
 */

export interface EventEmitterOptions {
  captureRejections?: boolean
}

// A rest parameter widens each argument to `unknown` at the call boundary --
// the same mechanism `emit(name, ...args: readonly unknown[])` already relies
// on. A bare array literal like `[name, fn]` infers a tagged union of its two
// concrete element types instead, and passing that tagged-union array where
// `emitDispatch` wants a uniformly-dynamic `unknown[]` is a conversion the
// certifier won't install. Routing every `emitDispatch(...)` call's argument
// list through this function gets the same widening `emit` gets for free.
function pack(...values: unknown[]): unknown[] {
  return values
}

export let defaultMaxListeners = 10
export let captureRejections = false
export const captureRejectionSymbol = Symbol('nodejs.rejection')
export const errorMonitor = Symbol('events.errorMonitor')
const captureRejectionSymbolValue = captureRejectionSymbol
const errorMonitorValue = errorMonitor

// `AbortSignal` and `AbortEventListener` are read from GLOBAL scope, not
// imported: `globals.ts` is a script, so its top-level declarations land in
// real global scope, which is the whole mechanism that keeps the WHATWG
// classes out of an ambient host claim. Naming them here costs nothing and
// gives `this.signal_.removeEventListener(...)` below a receiver the
// host-mutation census can type -- as `any` it read as an opaque receiver and
// stamped a wildcard over the entire host surface.
// A plain record, not a class. TypeScript's built-in `Disposable` interface
// (from `lib.esnext.disposable.d.ts`) is structural -- `[Symbol.dispose]()`
// -- and the certificate is minted for `apps/raw-http-hello` only once this
// value is native-record end-to-end: as a `class`, the constructed instance
// (a class-ref) and the structural `Disposable` shape it satisfies (a
// native-record-ref) were two distinct carriers, and every crossing between
// "this is an AbortDisposable" and "this is a Disposable" needed a runtime
// conversion the certifier refuses to install. Ten `certify`-stage refusals,
// gone by never having two identities to begin with.
export interface AbortDisposable {
  dispose(): void
  [Symbol.dispose](): void
}

function makeAbortDisposable(signal: AbortSignal, listener: AbortEventListener): AbortDisposable {
  let disposed = false
  const disposable: AbortDisposable = {
    dispose(): void {
      if (disposed) return
      disposed = true
      signal.removeEventListener('abort', listener)
    },
    [Symbol.dispose](): void {
      disposable.dispose()
    }
  }
  return disposable
}

export function addAbortListener(signal: AbortSignal, resource: (event?: Event) => void): AbortDisposable {
  let active = true
  const listener: AbortEventListener = (event?: Event) => {
    if (!active) return
    active = false
    resource(event)
  }
  const disposable = makeAbortDisposable(signal, listener)
  if (signal.aborted === true) {
    queueMicrotask((): void => {
      // A REAL `Event`, and `.call` so the listener sees the signal as its
      // receiver -- both of which `any` was hiding. The already-aborted path
      // used to synthesize `{ type: 'abort', target: signal }`, an object
      // literal that is not an `Event` at all (`Event` carries private state),
      // so a listener reaching any other member of the event it was handed
      // would have found it missing. The live path below dispatches a genuine
      // `Event`; this makes the two agree.
      const event = new Event('abort')
      event.target = signal
      listener.call(signal, event)
    })
  } else {
    signal.addEventListener('abort', listener, { once: true })
  }
  return disposable
}

export class EventEmitter {
  private entryNames_: EventName[] | undefined
  private entryOnce_: boolean[] | undefined
  // Listener identity is observable (`on(name, fn); off(name, fn)`). A native
  // `std::function` array cannot implement that contract because every insert
  // and read copies the callable into a distinct C++ function object. Keep the
  // original JS function objects at this deliberately dynamic boundary instead:
  // copying a gea_cpp_value preserves its shared callable identity.
  private entryFns_: Listener[] | undefined
  private maxListeners_: number
  private captureRejections_: boolean

  constructor(options?: EventEmitterOptions) {
    this.entryNames_ = undefined
    this.entryOnce_ = undefined
    this.entryFns_ = undefined
    this.maxListeners_ = -1
    this.captureRejections_ = options === undefined ? captureRejections : (options.captureRejections ?? captureRejections)
  }

  static captureRejectionSymbol = captureRejectionSymbolValue
  static errorMonitor = errorMonitorValue

  static addAbortListener(signal: AbortSignal, resource: (event?: Event) => void): AbortDisposable {
    return addAbortListener(signal, resource)
  }

  static get defaultMaxListeners(): number {
    return defaultMaxListeners
  }

  static set defaultMaxListeners(value: number) {
    validateMaxListeners(value)
    defaultMaxListeners = value
  }

  static get captureRejections(): boolean {
    return captureRejections
  }

  static set captureRejections(value: boolean) {
    captureRejections = value
  }

  static listenerCount(emitter: EventEmitter, name: EventName): number {
    return emitter.listenerCount(name)
  }

  static getEventListeners(emitter: EventEmitter, name: EventName): Listener[] {
    return emitter.listeners(name)
  }

  static getMaxListeners(emitter: EventEmitter): number {
    return emitter.getMaxListeners()
  }

  static setMaxListeners(n: number = 10, ...emitters: EventEmitter[]): void {
    validateMaxListeners(n)
    if (emitters.length === 0) {
      defaultMaxListeners = n
      return
    }
    for (let index = 0; index < emitters.length; index += 1) {
      emitters[index].setMaxListeners(n)
    }
  }

  static once(emitter: EventEmitter, name: EventName): Promise<unknown[]> {
    return once(emitter, name)
  }

  static on(emitter: EventEmitter, name: EventName, options: StaticEventEmitterIteratorOptions = {}): EventIterator {
    return on(emitter, name, options)
  }

  // Subclass hook (IncomingMessage uses it to start body delivery when a
  // 'data'/'end' listener shows up after dispatch).
  protected newListenerAdded(_name: EventName): void {}

  // Internal lifecycle emitters can avoid constructing event-name unions and
  // rest-argument arrays when this instance has never had a listener.
  protected hasAnyListeners(): boolean {
    const names = this.entryNames_
    return names !== undefined && names.length > 0
  }

  private addEntry(name: EventName, fn: EventHandler, once: boolean, prepend: boolean): void {
    this.emitDispatch('newListener', pack(name, fn))
    // The single widening in this file. A registered handler declares the
    // arguments it wants; storage is shared by every event on this emitter and
    // is applied to a list only `emit` knows. Node's own types spell this with
    // a fully permissive rest parameter; keeping it to one conversion on a
    // typed callable keeps the dispatch loop's carrier native.
    const stored = fn as Listener
    let names = this.entryNames_
    let onceEntries = this.entryOnce_
    let fns = this.entryFns_
    if (names === undefined || onceEntries === undefined || fns === undefined) {
      names = []
      onceEntries = []
      fns = []
      this.entryNames_ = names
      this.entryOnce_ = onceEntries
      this.entryFns_ = fns
    }
    if (prepend) {
      names.unshift(name)
      onceEntries.unshift(once)
      fns.unshift(stored)
    } else {
      names.push(name)
      onceEntries.push(once)
      fns.push(stored)
    }
    this.newListenerAdded(name)
  }

  // One plain signature per method, NOT a generic one and NOT an overload
  // pair on this class. A subclass that wants its own events typed adds
  // concrete overloads of its own (see `http.ts`'s `Server`); this base stays
  // at the catch-all, which is the only shape whose carrier the
  // representation layer can name.
  //
  // Two designs were tried here and both failed, in opposite directions:
  //
  //  - An overload PAIR on this class (a `K extends keyof TEvents & EventName`
  //    signature ahead of an `EventHandler` fallback) broke every
  //    `this.on('finish', ...)` / `this.emit('close', ...)` literal call in
  //    `http.ts`, `net.ts` and `stream.ts`: TypeScript infers `K` from the
  //    literal first, and when that candidate fails the constraint it
  //    substitutes the constraint (`never`) and reports against that overload
  //    rather than retrying the fallback.
  //  - A single GENERIC signature per method, conditional on a `TEvents` type
  //    argument (mirroring @types/node's own `EventEmitter<T>`), typechecked
  //    but cost 30 blocking diagnostics: `TEvents[K]` has no member set until
  //    the class is monomorphized, which never happens, so the listener array
  //    in `addEntry` and the dispatch signature in `emitDispatch` both took an
  //    `unresolved` carrier. Measured on `hono-hello`, 2026-09-15.
  //
  // Return type `this`, not `EventEmitter`, so a subclass's `.on(...)` chain
  // keeps the subclass type.
  on(name: EventName, fn: EventHandler): this {
    this.addEntry(name, fn, false, false)
    return this
  }

  addListener(name: EventName, fn: EventHandler): this {
    this.addEntry(name, fn, false, false)
    return this
  }

  prependListener(name: EventName, fn: EventHandler): this {
    this.addEntry(name, fn, false, true)
    return this
  }

  once(name: EventName, fn: EventHandler): this {
    this.addEntry(name, fn, true, false)
    return this
  }

  prependOnceListener(name: EventName, fn: EventHandler): this {
    this.addEntry(name, fn, true, true)
    return this
  }

  off(name: EventName, fn: unknown): this {
    this.removeEntry(name, fn)
    return this
  }

  removeListener(name: EventName, fn: unknown): this {
    this.removeEntry(name, fn)
    return this
  }

  private removeEntry(name: EventName, fn: unknown): void {
    const names = this.entryNames_
    const onceEntries = this.entryOnce_
    const fns = this.entryFns_
    if (names === undefined || onceEntries === undefined || fns === undefined) return
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i] === name && fns[i] === fn) {
        names.splice(i, 1)
        onceEntries.splice(i, 1)
        fns.splice(i, 1)
        this.emitDispatch('removeListener', pack(name, fn))
        return
      }
    }
  }

  removeAllListeners(name: EventName | undefined = undefined): this {
    const names = this.entryNames_
    const onceEntries = this.entryOnce_
    const fns = this.entryFns_
    if (names === undefined || onceEntries === undefined || fns === undefined) return this
    if (name === undefined) {
      for (let i = names.length - 1; i >= 0; i--) {
        const removedName: EventName = names[i]
        const removedFn: Listener = fns[i]
        names.splice(i, 1)
        onceEntries.splice(i, 1)
        fns.splice(i, 1)
        if (removedName !== 'removeListener') this.emitDispatch('removeListener', pack(removedName, removedFn))
      }
      return this
    }
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i] === name) {
        const removedFn: Listener = fns[i]
        names.splice(i, 1)
        onceEntries.splice(i, 1)
        fns.splice(i, 1)
        this.emitDispatch('removeListener', pack(name, removedFn))
      }
    }
    return this
  }

  // Same single-generic-signature reasoning as the registration methods
  // above (see the comment on `on`). Delegates to the private
  // `emitDispatch`, never recurses through `this.emit` itself.
  emit(name: EventName, ...args: readonly unknown[]): boolean {
    return this.emitDispatch(name, args as unknown[])
  }

  private emitDispatch(name: EventName, args: unknown[]): boolean {
    if (name === 'error' && this.listenerCount(errorMonitor) > 0) this.emitDispatch(errorMonitor, args)
    const names = this.entryNames_
    const onceEntries = this.entryOnce_
    const fns = this.entryFns_
    if (names === undefined || onceEntries === undefined || fns === undefined || names.length === 0) {
      if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error('Unhandled error event')
      return false
    }
    // Snapshot matching listeners first: a listener may add/remove listeners
    // while running, and `once` entries are removed BEFORE they run (Node
    // semantics — a once listener re-registering itself works).
    const toRun: Listener[] = []
    for (let i = 0; i < names.length; i++) {
      if (names[i] === name) toRun.push(fns[i])
    }
    if (toRun.length === 0) {
      if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error('Unhandled error event')
      return false
    }
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i] === name && onceEntries[i]) {
        const removedFn: Listener = fns[i]
        names.splice(i, 1)
        onceEntries.splice(i, 1)
        fns.splice(i, 1)
        this.emitDispatch('removeListener', pack(name, removedFn))
      }
    }
    for (let i = 0; i < toRun.length; i++) {
      const fn: Listener = toRun[i]
      // `instanceof Promise` rather than a structural `.then` probe: a hand-rolled
      // thenable interface has no native representation, so the receiver reads as
      // opaque and the compiler marks a globalThis-mutation wildcard that
      // invalidates every authenticated host global in the program.
      const result: unknown = fn.apply(this, args)
      if (this.captureRejections_) this.captureRejection(result, name, args)
    }
    return true
  }

  // `await` rather than `.then`: awaiting is the effectful assimilation protocol
  // the compiler implements, while `Promise.resolve`/`.then` on a listener's
  // dynamic return asks a pure conversion to assimilate (refused at certify) or
  // leaves an opaque receiver that marks a globalThis-mutation wildcard --
  // which invalidates every authenticated host global in the program.
  private async captureRejection(result: unknown, name: EventName, args: EventArgs): Promise<void> {
    try {
      await result
    } catch (error) {
      this.handleCapturedRejection(error, name, ...args)
    }
  }

  listenerCount(name: EventName, listener?: unknown): number {
    const names = this.entryNames_
    const fns = this.entryFns_
    if (names === undefined || fns === undefined) return 0
    let count = 0
    for (let i = 0; i < names.length; i++) {
      if (names[i] === name && (listener === undefined || fns[i] === listener)) {
        count++
      }
    }
    return count
  }

  listeners(name: EventName): Listener[] {
    const out: Listener[] = []
    const names = this.entryNames_
    const fns = this.entryFns_
    if (names === undefined || fns === undefined) return out
    for (let i = 0; i < names.length; i++) {
      if (names[i] === name) out.push(fns[i])
    }
    return out
  }

  rawListeners(name: EventName): Listener[] {
    return this.listeners(name)
  }

  setMaxListeners(n: number): this {
    validateMaxListeners(n)
    this.maxListeners_ = n
    return this
  }

  getMaxListeners(): number {
    return this.maxListeners_ < 0 ? defaultMaxListeners : this.maxListeners_
  }

  eventNames(): EventName[] {
    const out: EventName[] = []
    const names = this.entryNames_
    if (names === undefined) return out
    for (let i = 0; i < names.length; i++) {
      let seen = false
      for (let j = 0; j < out.length; j++) {
        if (out[j] === names[i]) {
          seen = true
          break
        }
      }
      if (!seen) out.push(names[i])
    }
    return out
  }

  [captureRejectionSymbol](error: unknown, event: EventName, ...args: unknown[]): void {
    this.handleCapturedRejection(error, event, ...args)
  }

  private handleCapturedRejection(error: unknown, _event: EventName, ..._args: unknown[]): void {
    this.emitDispatch('error', pack(error))
  }
}

export interface EventEmitterAsyncResourceOptions extends EventEmitterOptions {
  name?: string
  triggerAsyncId?: number
  requireManualDestroy?: boolean
}

/** The shape `AsyncResource`'s constructor stores -- a plain data record, never a receiver. */
export interface AsyncResourceMetadata {
  asyncId: number
  destroyed: boolean
  name: string
  triggerAsyncId: number
}

let nextAsyncResourceId = 1

export class EventEmitterAsyncResource extends EventEmitter {
  asyncId: number
  triggerAsyncId: number
  asyncResource: AsyncResourceMetadata

  constructor(options: EventEmitterAsyncResourceOptions = {}) {
    super(options)
    this.asyncId = nextAsyncResourceId++
    this.triggerAsyncId = options.triggerAsyncId ?? 0
    this.asyncResource = {
      asyncId: this.asyncId,
      destroyed: false,
      name: options.name ?? 'EventEmitterAsyncResource',
      triggerAsyncId: this.triggerAsyncId
    }
  }

  emitDestroy(): void {
    this.asyncResource.destroyed = true
  }
}

export interface StaticEventEmitterIteratorOptions {
  close?: EventName[]
  highWaterMark?: number
  lowWaterMark?: number
  signal?: AbortSignal
}

export interface EventIteratorResult {
  done: boolean
  value: unknown[] | undefined
}

// `on()` only ever calls `.pause()`/`.resume()` behind a `typeof ... ===
// 'function'` probe -- neither is an `EventEmitter` member, it's a Readable
// stream convention this file doesn't otherwise know about.
//
// This used to be captured by typing `emitter_` itself as a `PausableEmitter
// extends EventEmitter` interface -- structurally correct, but it meant every
// real `EventEmitter` value handed to `EventIterator` carried TWO identities:
// a `class-ref` (the actual emitter) and a `native-record-ref` (the
// structural interface), and the certifier refuses to install a runtime
// conversion between them. `.on`/`.removeListener` are genuine `EventEmitter`
// members, called repeatedly (once per registered name); each call needed the
// record-typed receiver converted back to the class to dispatch the real
// method -- 6 refusals, plus one more converting the class argument to the
// record parameter at construction. `pause`/`resume` are the only genuinely
// structural part (not `EventEmitter` members at all). Keeping `emitter_`
// class-typed removes the class/record ambiguity everywhere `.on` and
// `.removeListener` are called, and reading the two optional methods into
// plain fields once, at construction, confines the one unavoidable
// structural read to a single place instead of two call sites re-probing it.
interface PausableEmitterMethods {
  pause?: () => void
  resume?: () => void
}

export class EventIterator {
  private emitter_: EventEmitter
  private pause_: (() => void) | undefined
  private resume_: (() => void) | undefined
  private eventName_: EventName
  private options_: StaticEventEmitterIteratorOptions
  private queue_: unknown[][]
  private done_: boolean
  private nextResolve_: ((value: EventIteratorResult) => void) | undefined
  private nextReject_: ((reason?: unknown) => void) | undefined
  private eventListener_: EventHandler
  private errorListener_: EventHandler
  private closeListener_: () => void

  constructor(emitter: EventEmitter, eventName: EventName, options: StaticEventEmitterIteratorOptions = {}) {
    this.emitter_ = emitter
    const pausable = emitter as unknown as PausableEmitterMethods
    const pauseFn = pausable.pause
    this.pause_ = typeof pauseFn === 'function' ? pauseFn : undefined
    const resumeFn = pausable.resume
    this.resume_ = typeof resumeFn === 'function' ? resumeFn : undefined
    this.eventName_ = eventName
    this.options_ = options
    this.queue_ = []
    this.done_ = false
    this.nextResolve_ = undefined
    this.nextReject_ = undefined
    this.eventListener_ = (...args: unknown[]) => this.pushEvent(args)
    this.errorListener_ = (error?: unknown) => this.fail(error)
    this.closeListener_ = () => this.finish()
    emitter.on(eventName, this.eventListener_)
    if (eventName !== 'error') emitter.on('error', this.errorListener_)
    const close = options.close ?? []
    for (let index = 0; index < close.length; index++) emitter.on(close[index], this.closeListener_)
    if (options.signal !== undefined) {
      if (options.signal.aborted === true) this.fail(new Error('The operation was aborted'))
      else
        options.signal.addEventListener('abort', this.closeListener_, {
          once: true
        })
    }
  }

  private cleanup(): void {
    this.emitter_.removeListener(this.eventName_, this.eventListener_)
    if (this.eventName_ !== 'error') this.emitter_.removeListener('error', this.errorListener_)
    const close = this.options_.close ?? []
    for (let index = 0; index < close.length; index++) this.emitter_.removeListener(close[index], this.closeListener_)
    if (this.options_.signal !== undefined) this.options_.signal.removeEventListener('abort', this.closeListener_)
  }

  private pushEvent(values: unknown[]): void {
    if (this.done_) return
    if (this.nextResolve_ !== undefined) {
      const resolve = this.nextResolve_
      this.nextResolve_ = undefined
      this.nextReject_ = undefined
      resolve({ done: false, value: values })
      return
    }
    this.queue_.push(values)
    const highWaterMark = this.options_.highWaterMark ?? Number.POSITIVE_INFINITY
    const pause = this.pause_
    if (this.queue_.length > highWaterMark && pause !== undefined) pause.call(this.emitter_)
  }

  private finish(): void {
    if (this.done_) return
    this.done_ = true
    this.cleanup()
    if (this.nextResolve_ !== undefined) {
      const resolve = this.nextResolve_
      this.nextResolve_ = undefined
      this.nextReject_ = undefined
      resolve({ done: true, value: undefined })
    }
  }

  private fail(error?: unknown): void {
    if (this.done_) return
    this.done_ = true
    this.cleanup()
    if (this.nextReject_ !== undefined) {
      const reject = this.nextReject_
      this.nextResolve_ = undefined
      this.nextReject_ = undefined
      reject(error)
    }
  }

  next(): Promise<EventIteratorResult> {
    if (this.queue_.length > 0) {
      const value = this.queue_.shift()
      const lowWaterMark = this.options_.lowWaterMark ?? 1
      const resume = this.resume_
      if (this.queue_.length < lowWaterMark && resume !== undefined) resume.call(this.emitter_)
      const result: EventIteratorResult = { done: false, value }
      return Promise.resolve(result)
    }
    if (this.done_) {
      const result: EventIteratorResult = { done: true, value: undefined }
      return Promise.resolve(result)
    }
    return new Promise<EventIteratorResult>((resolve, reject) => {
      this.nextResolve_ = resolve
      this.nextReject_ = reject
    })
  }

  return(): Promise<EventIteratorResult> {
    this.finish()
    const result: EventIteratorResult = { done: true, value: undefined }
    return Promise.resolve(result)
  }

  throw(error?: unknown): Promise<EventIteratorResult> {
    this.fail(error)
    return Promise.reject(error)
  }

  [Symbol.asyncIterator](): EventIterator {
    return this
  }
}

function validateMaxListeners(n: number): void {
  if (!Number.isFinite(n) || n < 0) {
    const error = new RangeError('The value of "n" is out of range. It must be a non-negative number.') as RangeError & {
      code: string
    }
    error.code = 'ERR_OUT_OF_RANGE'
    throw error
  }
}

export function listenerCount(emitter: EventEmitter, name: EventName): number {
  return emitter.listenerCount(name)
}

export function getEventListeners(emitter: EventEmitter, name: EventName): Listener[] {
  return emitter.listeners(name)
}

export function getMaxListeners(emitter: EventEmitter): number {
  return emitter.getMaxListeners()
}

export function setMaxListeners(n: number = 10, ...emitters: EventEmitter[]): void {
  validateMaxListeners(n)
  if (emitters.length === 0) {
    defaultMaxListeners = n
    return
  }
  for (let index = 0; index < emitters.length; index += 1) {
    emitters[index].setMaxListeners(n)
  }
}

export function once(emitter: EventEmitter, name: EventName): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const onEvent: Listener = (...values: unknown[]) => {
      if (name !== 'error') emitter.removeListener('error', onError)
      resolve(values)
    }
    const onError: Listener = (error?: unknown) => {
      emitter.removeListener(name, onEvent)
      reject(error)
    }
    emitter.once(name, onEvent)
    if (name !== 'error') emitter.once('error', onError)
  })
}

export function on(emitter: EventEmitter, name: EventName, options: StaticEventEmitterIteratorOptions = {}): EventIterator {
  return new EventIterator(emitter, name, options)
}

export const prototype: EventEmitter = EventEmitter.prototype

const eventsDefault = {
  addAbortListener,
  EventEmitter,
  EventEmitterAsyncResource,
  captureRejections,
  captureRejectionSymbol,
  defaultMaxListeners,
  errorMonitor,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  on,
  once,
  prototype,
  setMaxListeners
}

export default eventsDefault
