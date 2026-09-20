// WHATWG stream primitives for the Node 24 compatibility layer, in the REAL
// global scope.
//
// This file has no top-level `import`/`export`, which is deliberate and
// load-bearing for exactly the reason `globals.ts`'s header spells out for the
// fetch classes: a file with neither is a TypeScript SCRIPT, and a script's
// top-level declarations land in the global scope every other file already
// sees. That is what makes `new ReadableStream(...)` resolve to THIS class in
// library code that imports nothing -- `@hono/node-server`'s `utils/stream.ts`
// constructs it, `utils.ts`/`listener.ts` name `ReadableStreamReadResult`
// bare, `request.ts` names `ReadableStreamDefaultController` bare.
//
// The globals used to be declared instead, in `node-globals.ts`:
//
//   const ReadableStream: typeof import('./stream/web.js').ReadableStream
//
// which reads like a pure alias and is not one. `typeof import(...)` states
// the TYPE; the value half is a bare ambient `const`, i.e. a claim that some
// HOST provides this global. No host does -- the implementation is the
// TypeScript below -- so every member of it was given a `native-handle`
// representation whose `native-boundary:ReadableStream@1` protocol no table
// backs, and the compiler refused 329 of this program's 823 roots on that one
// declaration. A class in a script has no such split: one declaration, one
// implementation, resolved by name.
//
// `node:stream/web` is `stream/web.ts`, which re-exports these names under the
// module surface Node also gives them.
//
// The implementation is intentionally value-oriented: queues carry arbitrary
// chunks while readers, writers, controllers, piping, teeing, and transforms
// preserve the observable Web Streams lifecycle.
//
// `Buffer` and `BufferEncoding` are read from global scope (`node-globals.ts`)
// rather than imported: an import would make this a module and put every name
// below back out of reach of the library code that needs it.

// WHATWG Streams §3.2's `UnderlyingSource` dictionary, narrowed to the
// `start`/`pull`/`cancel` members this implementation actually calls
// (`ReadableStream`'s constructor, below) -- byte-stream-only members
// (`type: 'bytes'`, `autoAllocateChunkSize`) are out of scope, matching
// `ReadableByteStreamController`'s own un-genericized state above.
//
// `start`/`pull` take the REAL `ReadableStreamDefaultController<R>` class,
// not an ad hoc shape: `@hono/node-server`'s own `utils/stream.ts` and
// `request.ts` assign the controller they receive to a variable explicitly
// typed `ReadableStreamDefaultController<Uint8Array>`, which only a genuine
// instance -- never an object literal, since the class has a private field --
// can satisfy. `ReadableStream`'s constructor and `readInternal` (below)
// construct one accordingly, which is why `desiredSize` on it is that
// class's own live getter rather than a value computed once; see the note
// there for what that changes.
interface UnderlyingReadableStreamSource<R> {
  start?(controller: ReadableStreamDefaultController<R>): void
  pull?(controller: ReadableStreamDefaultController<R>): void
  cancel?(reason?: unknown): void
}

// WHATWG Streams §3.13's `QueuingStrategy`, narrowed to the one field this
// implementation reads (`highWaterMark`, in `ReadableStream`'s constructor).
// `size` is part of the real dictionary but nothing here consults it --
// backpressure is a fixed count of queued chunks, not their WHATWG-declared
// "size" -- so it stays out rather than being declared and silently ignored.
interface QueuingStrategyInit {
  highWaterMark?: number
}

// WHATWG Streams §4.4's read-result shape (`{ done: false, value: R } |
// { done: true, value: undefined }`), reused by every reader below.
// `@hono/node-server`'s own `utils.ts`/`listener.ts` name this type bare, with
// no import -- which this file being a script is what makes possible; see the
// header. `node:stream/web` re-exports it too, for the code that does import.
type ReadableStreamReadResult<R> = { done: false; value: R } | { done: true; value: undefined }

// `R` is the chunk type: this class is global at this generic arity
// (`ReadableStream<Uint8Array>`, etc.), and callers -- both
// `stream.ts`'s `readableToWeb` and `@hono/node-server`'s
// `utils/stream.ts#createStreamBody` -- construct against a concrete element
// type, not `unknown`. `stream_`/`enqueue`'s internal wiring is a real
// `ReadableStream<R>` reference now, not an opaque one: a receiver geatsc's
// host-global census cannot type stamps a WILDCARD across the whole host
// surface, which is what made every `Buffer.*` read in `globals.ts`
// unprovable -- narrowing it here is exactly what removes that wildcard,
// not a restatement of `ReadableStream`'s own generic for its own sake.
class ReadableStreamDefaultController<R = Uint8Array> {
  private stream_: ReadableStream<R>

  constructor(stream: ReadableStream<R>) {
    this.stream_ = stream
  }

  get desiredSize(): number | null {
    return this.stream_.desiredSize()
  }

  close(): void {
    this.stream_.closeFromController()
  }

  enqueue(chunk?: R): void {
    this.stream_.enqueueFromController(chunk)
  }

  error(reason?: unknown): void {
    this.stream_.errorFromController(reason)
  }
}

// Non-standard bookkeeping: `respond()` records the byte count on the request
// itself rather than through the side channel real implementations use.
// Nothing in this codebase ever constructs a BYOB request (every
// `byobRequest` field below stays `null`) and nothing reads the count back.
// It used to be written onto the VIEW, typed `Uint8Array & { bytesWritten?:
// number }` -- an intersection the emitter cannot honour: a typed array has
// no ordinary-property table, so that store refused emission the moment the
// body became reachable (`property-access:typed-array:set`).
type BYOBRequestView = Uint8Array

class ReadableStreamBYOBRequest {
  view: BYOBRequestView | null | undefined
  private responded_: boolean
  private bytesWritten_: number

  constructor(view: BYOBRequestView | null | undefined = undefined) {
    this.view = view
    this.responded_ = false
    this.bytesWritten_ = 0
  }

  respond(bytesWritten: number): void {
    this.responded_ = true
    this.bytesWritten_ = bytesWritten
  }

  respondWithNewView(view: BYOBRequestView): void {
    this.view = view
    this.responded_ = true
  }
}

// Byte streams are not generic in the spec either (`ReadableByteStreamController`
// always hands out `Uint8Array` views), so this stays un-parameterized -- the
// base class's `R` defaults to `Uint8Array` here rather than being restated.
class ReadableByteStreamController extends ReadableStreamDefaultController {
  byobRequest: ReadableStreamBYOBRequest | null

  constructor(stream: ReadableStream<Uint8Array>) {
    super(stream)
    this.byobRequest = null
  }
}

class ReadableStreamIterator<R = Uint8Array> {
  private reader_: ReadableStreamDefaultReader<R>
  private preventCancel_: boolean

  constructor(stream: ReadableStream<R>, preventCancel: boolean) {
    this.reader_ = stream.getReader()
    this.preventCancel_ = preventCancel
  }

  next(): Promise<ReadableStreamReadResult<R>> {
    return this.reader_.read()
  }

  return(): Promise<ReadableStreamReadResult<R>> {
    if (!this.preventCancel_) return this.reader_.cancelAndRelease()
    this.reader_.releaseLock()
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): ReadableStreamIterator<R> {
    return this
  }
}

// `R` is the element type a consumer reads out (`getReader().read()`) and a
// producer enqueues (`controller.enqueue(chunk)`).
//
// It DEFAULTS TO `Uint8Array`, and that default is load-bearing rather than a
// convenience. `lib.dom.d.ts` and `@types/node` both write `ReadableStream<R =
// any>`, and library code leans on it in both directions at once:
// `@hono/node-server`'s `writeFromReadableStream` takes
// `ReadableStream<Uint8Array>` while hono's own `Data` union and
// `ClientResponse#body` spell the name BARE, and `any` is what lets one flow
// into the other. `unknown` does not -- the parameter is invariant, so
// `ReadableStream<unknown>` and `ReadableStream<Uint8Array>` are mutually
// unassignable and the bare spellings become checker errors at every seam.
// `any` is not an option in this codebase, and would poison inference through
// every chunk anyway. `Uint8Array` is the honest third answer: every stream
// that crosses this target's fetch/HTTP surface IS a byte stream (that is what
// `Response.body` is in WHATWG Fetch), so the default states the fact rather
// than erasing it, and a caller who wants another element type writes it --
// `new ReadableStream<string>(...)` -- and is checked against it.
//
// The class is in bare global scope at this generic arity --
// `@hono/node-server`'s `utils/stream.ts` writes `new ReadableStream<Uint8Array>(...)`
// with no import in sight, and expects that call to be checked against a real
// chunk type, not `unknown`.
//
// Widening the DEFAULT to a top type to match `lib.dom`'s `R = any` was tried
// on 2026-09-15 and is a MEASURED DEAD END: this class holds `R` in private
// mutable state (`queue_: R[]`, `reader_`), which makes it INVARIANT, so
// `ReadableStream<unknown>` and `ReadableStream<Uint8Array>` stop being
// assignable to each other in either direction. It fixed one third-party
// checker error and manufactured five more (`hono-base.ts:38`,
// `context.ts:638`, `client/utils.ts:113`, `listener.ts:202`/`247`), taking
// blocking diagnostics 15 -> 20. `lib.dom` gets away with it because its
// `ReadableStream` is an INTERFACE with no `R`-typed storage.
class ReadableStream<R = Uint8Array> {
  // Initialized here, as a field initializer, rather than by a constructor
  // assignment (`this.queue_ = []`): an empty array LITERAL has no elements
  // to carry evidence of `R`, and as a constructor-body assignment geatsc
  // lowered it as a dynamic/untyped array-object needing a runtime
  // conversion into the specialized `R[]` (a typed-array-of-`Uint8Array`
  // array-object at this class's `R = Uint8Array` instantiation) that the
  // target installs no conversion for. As a class-field initializer, the
  // slot's own declared type `R[]` is what allocates it, so there is no
  // separate literal value to convert.
  private queue_: R[] = []
  private state_: string
  private error_: unknown
  private reader_: ReadableStreamDefaultReader<R> | null
  private source_: UnderlyingReadableStreamSource<R>
  private highWaterMark_: number
  // Split into a value- and a done-resolver rather than one
  // `((result: ReadableStreamReadResult<R>) => void) | undefined` field: the
  // single-field shape reads back out through the same `!== undefined`
  // narrowing pattern used everywhere else in this file, but the union
  // parameter (`ReadableStreamReadResult<R>`) it carries gets a different
  // provenance at the read site than at the field's own declaration --
  // structurally identical, not identical to the target's runtime conversion
  // table, which is exactly the "no runtime conversion installed" refusal.
  // `unknown` rather than `R`, deliberately. This ONE field declaration is
  // shared structurally across every specialization of `ReadableStream<R>`,
  // and at the `R = unknown` instantiation `TransformStream` builds
  // internally its `R`-ary signature hash stopped matching what that
  // specialization's call site expects -- a cross-specialization identity
  // collision that refused certification with "no runtime conversion is
  // installed from optional(function-value-dispatch...)". Spelling the stored
  // signature in the one type every specialization agrees on removes the
  // disagreement; the cast at the call below is where `R` is restored, and it
  // is sound because the only writer (`readInternal`) constructs the wrapper
  // from this same instance's own `R`.
  private waitingResolveValue_: ((value: unknown) => void) | undefined
  private waitingResolveDone_: (() => void) | undefined
  private waitingReject_: ((reason?: unknown) => void) | undefined
  // WHATWG Streams §4.2's `closed` promise, settled exactly once, on the
  // STREAM rather than per-reader-acquisition (this implementation only ever
  // has one reader locked at a time, so there is no second acquisition for a
  // per-reader promise to distinguish). `@hono/node-server`'s own `utils.ts`
  // (`writeFromReadableStreamDefaultReader`) awaits `reader.closed` to know
  // when to stop listening for `close`/`error` on the destination `Writable`.
  private closedResolve_!: () => void
  private closedReject_!: (reason?: unknown) => void
  private closedPromise_: Promise<void>

  locked: boolean

  constructor(underlyingSource: UnderlyingReadableStreamSource<R> = {}, strategy: QueuingStrategyInit = {}) {
    this.state_ = 'readable'
    this.error_ = undefined
    this.reader_ = null
    this.source_ = underlyingSource
    this.highWaterMark_ = strategy.highWaterMark ?? 1
    this.waitingResolveValue_ = undefined
    this.waitingResolveDone_ = undefined
    this.waitingReject_ = undefined
    this.locked = false
    this.closedPromise_ = new Promise<void>((resolve, reject) => {
      // Not `this.closedResolve_ = resolve` directly: a `Promise<void>`
      // executor's `resolve` accepts `void | PromiseLike<void>`, one
      // parameter wider than the field's declared `() => void` -- storing it
      // as-is carries that wider calling convention, which the target
      // installs no conversion for. Wrapping constructs a function of the
      // field's own exact niladic shape.
      this.closedResolve_ = (): void => resolve()
      this.closedReject_ = reject
    })
    // A stream nobody ever reads to completion, or that nobody awaits
    // `.closed` on, must not raise Node's unhandled-rejection warning if it
    // errors -- this pre-attaches a silent listener; it does not consume the
    // promise, so `closedSignal()`'s own callers still see the real outcome.
    this.closedPromise_.catch(() => {})
    // A real instance, not a literal: `desiredSize` on it is therefore a
    // live getter (`ReadableStreamDefaultController#desiredSize` reads
    // `this.stream_.desiredSize()` on every access) rather than a value
    // frozen at construction time. That is a behavior change from this
    // file's previous ad hoc controller literal, forced by an external
    // constraint (see `UnderlyingReadableStreamSource`'s comment) rather
    // than chosen for its own sake -- and it is arguably a fix, not a
    // regression: `@hono/node-server`'s `utils/stream.ts#createStreamBody`
    // reads `controller.desiredSize` on every chunk to decide whether to
    // pause its source stream, which a frozen snapshot could never make
    // go non-positive.
    // Read into a LOCAL and call the local, rather than calling
    // `underlyingSource.start(...)` behind a `typeof` guard. TypeScript
    // narrows either spelling, but geatsc carries the guarded MEMBER as
    // `optional(function-value-dispatch(...), undefined)` and then has to
    // convert it to the bare dispatch the call needs -- a conversion the
    // target installs no runtime for, which refuses certification. A local
    // const gets the narrowed carrier directly, so there is nothing to
    // convert. Every optional-callback call in this file is written this way
    // for that reason.
    const start = underlyingSource.start
    if (start !== undefined) start(new ReadableStreamDefaultController<R>(this))
  }

  desiredSize(): number | null {
    if (this.state_ !== 'readable') return null
    return this.highWaterMark_ - this.queue_.length
  }

  // WHATWG's `enqueue(chunk?: R)` allows an omitted chunk, mirrored on
  // `ReadableStreamDefaultController.enqueue` above (pre-existing, real
  // `lib.dom.d.ts` carries the same looseness). Nothing in this codebase
  // actually calls it without one, so rather than thread `R | undefined`
  // through the queue, the pending-read payload, and `ReadableStreamReadResult<R>`
  // itself, the optional-to-required gap is closed once, here.
  enqueueFromController(chunk?: R): void {
    if (this.state_ !== 'readable') throw new TypeError('ReadableStream is not readable')
    const value = chunk as R
    if (this.waitingResolveValue_ !== undefined) {
      const resolve = this.waitingResolveValue_
      this.waitingResolveValue_ = undefined
      this.waitingResolveDone_ = undefined
      this.waitingReject_ = undefined
      resolve(value)
      return
    }
    this.queue_.push(value)
  }

  closeFromController(): void {
    if (this.state_ !== 'readable') return
    this.state_ = 'closed'
    if (this.waitingResolveDone_ !== undefined) {
      const resolve = this.waitingResolveDone_
      this.waitingResolveValue_ = undefined
      this.waitingResolveDone_ = undefined
      this.waitingReject_ = undefined
      resolve()
    }
    this.closedResolve_()
  }

  errorFromController(reason?: unknown): void {
    if (this.state_ !== 'readable') return
    this.state_ = 'errored'
    this.error_ = reason
    if (this.waitingReject_ !== undefined) {
      const reject = this.waitingReject_
      this.waitingResolveValue_ = undefined
      this.waitingResolveDone_ = undefined
      this.waitingReject_ = undefined
      reject(reason)
    }
    this.closedReject_(reason)
  }

  // Public, unlike the `closed*_` fields themselves: `ReadableStreamDefaultReader`
  // is a different class, and TypeScript's `private` is enforced per class,
  // not per module -- the reader's own `closed` getter (below) needs this.
  closedSignal(): Promise<void> {
    return this.closedPromise_
  }

  readInternal(): Promise<ReadableStreamReadResult<R>> {
    if (this.queue_.length > 0) {
      const value = this.queue_.shift() as R
      return Promise.resolve({ done: false, value })
    }
    if (this.state_ === 'closed') return Promise.resolve({ done: true, value: undefined })
    if (this.state_ === 'errored') return Promise.reject(this.error_)
    const pull = this.source_.pull
    if (pull !== undefined) {
      pull(new ReadableStreamDefaultController<R>(this))
      if (this.queue_.length > 0) {
        const value = this.queue_.shift() as R
        return Promise.resolve({ done: false, value })
      }
      if (this.state_ === 'closed') return Promise.resolve({ done: true, value: undefined })
      // A pull that fails errors the stream before any read is waiting on it.
      if (this.state_ === 'errored') return Promise.reject(this.error_)
    }
    return new Promise<ReadableStreamReadResult<R>>((resolve, reject) => {
      // Each wrapper constructs the field's own exact niladic-or-`R`-ary
      // shape rather than storing the executor's `resolve` directly (which
      // accepts `ReadableStreamReadResult<R> | PromiseLike<...>`, one
      // parameter wider) -- same reasoning as `closedResolve_` above.
      this.waitingResolveValue_ = (value: unknown): void => resolve({ done: false, value: value as R })
      this.waitingResolveDone_ = (): void => resolve({ done: true, value: undefined })
      this.waitingReject_ = reject
    })
  }

  releaseReader(reader: ReadableStreamDefaultReader<R>): void {
    if (this.reader_ !== reader) return
    this.reader_ = null
    this.locked = false
  }

  cancel(reason?: unknown): Promise<void> {
    // Truncated in place, not reassigned (`this.queue_ = []`): a fresh empty
    // array literal hits the same dynamic-array vs. typed-array certify
    // refusal the constructor's field initializer above works around --
    // clearing the existing, already correctly-typed array-object sidesteps
    // it instead of reproducing it a second time.
    this.queue_.length = 0
    this.closeFromController()
    const cancel = this.source_.cancel
    if (cancel !== undefined) cancel(reason)
    return Promise.resolve()
  }

  getReader(options: { mode?: 'byob' } = {}): ReadableStreamDefaultReader<R> {
    if (this.locked) throw new TypeError('ReadableStream is locked')
    this.locked = true
    // Both branches are a `ReadableStreamDefaultReader<R>` over THIS stream,
    // so neither needs a cast. The BYOB branch used to read
    // `new ReadableStreamBYOBReader(this as unknown as ReadableStream<Uint8Array>)`,
    // asserting one stream class was another. That was free while every `R`
    // shared a single physical `ReadableStream`, and is not any more:
    // `ReadableStream<unknown>` -- what `TransformStream` exposes, because
    // `TextDecoderStream` really does enqueue strings -- and
    // `ReadableStream<Uint8Array>` are two C++ classes with no conversion
    // between them, and the compiler refused the assertion rather than
    // silently reinterpreting one struct as the other. The spec's real claim
    // ("a BYOB stream's chunks are bytes") now sits on the CHUNK, inside
    // `ReadableStreamBYOBReader.read`, where it is a checked dynamic
    // assertion instead of a whole-object lie.
    this.reader_ = options.mode === 'byob' ? new ReadableStreamBYOBReader<R>(this) : new ReadableStreamDefaultReader(this)
    return this.reader_
  }

  // `WritableStream` is bare, not `WritableStream<R>`: it lost its own type
  // parameter (see the class's comment below), so there is no `R`-typed
  // writable to name here either. The link between this stream's element
  // type and the destination's accepted chunk type is no longer
  // compiler-checked at the call site -- a real narrowing this reversal
  // costs, not a restatement of the old signature.
  // NOT `pipeThrough<T>(...): ReadableStream<T>`, and this one method is what
  // put TWO ABI blockers on this program:
  //
  //   whatwg-streams.ts:99  ReadableStreamDefaultController#enqueue
  //   whatwg-streams.ts:316 ReadableStream#enqueueFromController
  //
  // each refused with `parameter 0 is bound as "dynamic(declared-any-never-narrowed)"
  // but the ABI declares "optional(typed-array(uint8,array-buffer,shared-refcount),undefined)"`,
  // and its mirror image.
  //
  // `T` was a METHOD-level type parameter, and nothing in this codebase or its
  // apps ever calls `pipeThrough` -- it is declared and never used -- so no call
  // site ever gave `T` an argument to be inferred from. An uninstantiated type
  // parameter reaching representation is an unresolved carrier: `ReadableStream<T>`
  // published this class at geatsc's `dynamic` representation, which is a SECOND
  // element type for `ReadableStream`, and geatsc emits ONE calling convention per
  // function DECLARATION (a `FunctionId` is `fn|decl|<file>|<node>`, with no
  // instantiation segment). One emitted `enqueue` cannot hold both `Uint8Array`
  // -- what `Response.body`, `@hono/node-server` and `stream.ts#readableToWeb`
  // reach it at -- and `dynamic`.
  //
  // MEASURED: deleting this method outright cleared both blockers and nothing
  // else, with `TransformStream`'s own `ReadableStream<unknown>` left untouched.
  // That instantiation was the obvious suspect and is NOT the cause: pinning the
  // transform family to `<string>`, to `<string | Uint8Array>`, and onto a
  // separate non-generic stream class each left both blockers standing while
  // `pipeThrough<T>` remained, and the union arm also cost 15 boxes.
  //
  // The class's own `R` is the honest replacement: a transform that CHANGES the
  // element type is what `T` was for, and this target has none to express --
  // `TransformStream` carries `unknown` chunks, which is not assignable to
  // `ReadableStream<Uint8Array>` in either direction (`R` is invariant: the class
  // holds it in private mutable state). So the only pipelines that could ever
  // type-check here are same-element ones, which is exactly what `R` states.
  // Narrower than WHATWG, and stated rather than erased.
  pipeThrough(transform: { writable: WritableStream; readable: ReadableStream<R> }, options?: unknown): ReadableStream<R> {
    this.pipeTo(transform.writable, options)
    return transform.readable
  }

  pipeTo(destination: WritableStream, _options?: unknown): Promise<void> {
    const reader = this.getReader()
    const writer = destination.getWriter()
    const pump = (): Promise<void> => reader.read().then((result) => {
      if (result.done) {
        reader.releaseLock()
        return writer.close().then(() => writer.releaseLock())
      }
      return writer.write(result.value).then(pump)
    })
    return pump()
  }

  tee(): [ReadableStream<R>, ReadableStream<R>] {
    const left = new ReadableStream<R>()
    const right = new ReadableStream<R>()
    const leftController = new ReadableStreamDefaultController<R>(left)
    const rightController = new ReadableStreamDefaultController<R>(right)
    const reader = this.getReader()
    const pump = (): void => {
      reader.read().then((result) => {
        if (result.done) {
          leftController.close()
          rightController.close()
          reader.releaseLock()
          return
        }
        leftController.enqueue(result.value)
        rightController.enqueue(result.value)
        pump()
      }, (error: unknown) => {
        leftController.error(error)
        rightController.error(error)
      })
    }
    pump()
    return [left, right]
  }

  values(options: { preventCancel?: boolean } = {}): ReadableStreamIterator<R> {
    return new ReadableStreamIterator(this, options.preventCancel === true)
  }

  [Symbol.asyncIterator](): ReadableStreamIterator<R> {
    return this.values()
  }
}

// `R` matches `ReadableStream<R>`'s own element type -- this class is in bare
// global scope at the same arity, and
// `@hono/node-server`'s `request.ts` imports it from `node:stream/web` as
// `ReadableStreamDefaultReader<Uint8Array>` (a real generic instantiation,
// not the bare name -- it was erroring with "Type 'ReadableStreamDefaultReader'
// is not generic" before this class took a type parameter).
class ReadableStreamDefaultReader<R = Uint8Array> {
  protected stream_: ReadableStream<R> | null

  constructor(stream: ReadableStream<R>) {
    this.stream_ = stream
  }

  read(): Promise<ReadableStreamReadResult<R>> {
    if (this.stream_ === null) return Promise.reject(new TypeError('Reader has no stream'))
    return this.stream_.readInternal()
  }

  // WHATWG Streams §4.5.3. Distinct from `cancelAndRelease` (below, this
  // implementation's own non-standard combined helper): the spec method
  // cancels the underlying stream but does NOT release the reader's lock --
  // `@hono/node-server`'s own `utils.ts`
  // (`writeFromReadableStreamDefaultReader`) calls this from a `close`/`error`
  // listener on the destination it is piping to, and separately awaits
  // `closed` (below) to know when to detach those listeners.
  cancel(reason?: unknown): Promise<void> {
    if (this.stream_ === null) return Promise.reject(new TypeError('Reader has no stream'))
    return this.stream_.cancel(reason)
  }

  // WHATWG Streams §4.5.1: settles once, when the stream this reader is
  // locked to closes or errors. See `ReadableStream#closedSignal`'s own
  // comment for why this is stream-scoped rather than tracked per reader
  // acquisition.
  get closed(): Promise<undefined> {
    if (this.stream_ === null) return Promise.resolve(undefined)
    return this.stream_.closedSignal().then(() => undefined)
  }

  releaseLock(): void {
    if (this.stream_ === null) return
    const stream = this.stream_
    this.stream_ = null
    stream.releaseReader(this)
  }

  cancelAndRelease(): Promise<ReadableStreamReadResult<R>> {
    if (this.stream_ === null) return Promise.resolve({ done: true, value: undefined })
    const stream = this.stream_
    this.releaseLock()
    return stream.cancel().then(() => ({ done: true, value: undefined }))
  }
}

// WHATWG Streams §4.7 fixes a BYOB reader to bytes, and can, because the spec
// only lets one be obtained from a byte stream. Here the reader is built by
// `ReadableStream<R>.getReader`, so it is handed whatever stream `R` that
// instance has -- and since a generic class is now one physical class PER
// layout-distinct `R`, a byte-fixed base meant `getReader` had to assert its
// own `this` was a different class. Carrying `R` is what removes that
// assertion; the byte claim moves onto the chunk below, which is where the
// spec's precondition actually lives and where a wrong value is caught.
class ReadableStreamBYOBReader<R = Uint8Array> extends ReadableStreamDefaultReader<R> {
  constructor(stream: ReadableStream<R>) {
    super(stream)
  }

  // `view` is a destination BUFFER, so the result stays `R`-shaped: filling a
  // caller's `Uint8Array` does not change what the stream yields, and keeping
  // the base's return type is also what lets this override a `<R>` base.
  read(view?: Uint8Array): Promise<ReadableStreamReadResult<R>> {
    return super.read().then((result) => {
      if (result.done || view === undefined || view === null) return result
      // The spec's byte precondition, asserted on the value rather than on
      // the stream: a BYOB read of a non-byte stream fails here, loudly,
      // instead of being reinterpreted silently at the class level.
      const source = result.value as unknown as Uint8Array
      const length = Math.min(view.length ?? 0, source.length ?? 0)
      for (let index = 0; index < length; index++) view[index] = source[index]
      return { done: false, value: view as unknown as R }
    })
  }
}

class WritableStreamDefaultController {
  private stream_: WritableStream

  constructor(stream: WritableStream) {
    this.stream_ = stream
  }

  error(reason?: unknown): void {
    this.stream_.errorFromController(reason)
  }
}

// Same shape-vs-instance split as `UnderlyingReadableStreamController` above:
// what `start`/`write` actually receive is a plain literal (built fresh in
// `WritableStream`'s constructor and in `writeInternal`, below), not a real
// `WritableStreamDefaultController` -- this names that literal's real shape.
interface UnderlyingWritableStreamController {
  error(reason?: unknown): void
}

// WHATWG Streams §4.9's `UnderlyingSink<W>` dictionary, narrowed to the
// members this implementation calls. `chunk` is `unknown`, not a fixed
// element type: `WritableStream` below no longer carries a `W` type
// parameter to propagate here, and `TransformStream` (further below) builds
// one of these internally to sit behind sinks with genuinely different
// chunk types -- `TextEncoderStream` writes strings in, `TextDecoderStream`
// writes `Uint8Array | number[] | Buffer` in -- so a fixed element type here
// would be wrong for at least two of this file's own subclasses.
interface UnderlyingWritableStreamSink {
  start?(controller: UnderlyingWritableStreamController): void
  write?(chunk: unknown, controller: UnderlyingWritableStreamController): void | Promise<void>
  close?(): void | Promise<void>
  abort?(reason?: unknown): void
}

// NOT `WritableStream<W = Uint8Array>`. A type parameter genericizes the
// class itself, and `writeInternal`/`closeInternal` (below) each return
// `this.sink_.write(...)`/`this.sink_.close()`'s result after checking
// whether it is already a `Promise`-shaped value or needs wrapping -- with
// `W` in scope, that check's result type was `promise(unresolved)@-` because
// `W` never gets monomorphized (nothing calls `new WritableStream<...>` at a
// single concrete type the compiler can specialize this class to), and every
// obligation naming that carrier became a blocking diagnostic: 35 roots in
// this file alone, the two largest clusters at exactly these two call sites,
// measured on `hono-hello`, 2026-09-15. `unknown` chunk types throughout
// (here and in the sink dictionary above) buy back the same flexibility with
// a carrier the compiler can actually name -- see `EventEmitter.on` in
// `events.ts` and `Server` in `http.ts` for the same fix on the same defect.
//
// Dropping `W` alone only closed 18 of those 35 roots: the other half sat on
// the check itself, `typeof result.then === 'function'`, independent of `W`
// entirely -- accessing `.then` off a `void | Promise<void>` union still
// reaches `Promise<T>.then`'s own (lib-declared, generic-in-two-type-params)
// method signature, which is exactly as unmonomorphizable as `W` was.
// `writeInternal`/`closeInternal` below use `result instanceof Promise`
// instead, which never touches that generic member at all. This is a small
// behavioral narrowing from the spec (WHATWG's `PromiseCall` accepts ANY
// thenable, not just real `Promise` instances) -- but this is a single
// ahead-of-time-compiled program with one canonical `Promise` class, not an
// environment where foreign thenables from another library can show up, so
// the two checks are equivalent in practice for every sink this codebase
// ever constructs.
class WritableStream {
  private sink_: UnderlyingWritableStreamSink
  private state_: string
  private error_: unknown
  private writer_: WritableStreamDefaultWriter | null

  locked: boolean

  constructor(underlyingSink: UnderlyingWritableStreamSink = {}, _strategy: QueuingStrategyInit = {}) {
    this.sink_ = underlyingSink
    this.state_ = 'writable'
    this.error_ = undefined
    this.writer_ = null
    this.locked = false
    const start = underlyingSink.start
    if (start !== undefined) {
      start({ error: (reason?: unknown): void => this.errorFromController(reason) })
    }
  }

  errorFromController(reason?: unknown): void {
    this.state_ = 'errored'
    this.error_ = reason
  }

  // No optional-to-required cast needed here (unlike
  // `ReadableStream#enqueueFromController`'s `chunk as R` above): the sink's
  // own `write?(chunk: unknown, ...)` already accepts `undefined` as part of
  // `unknown`, so the writer-facing `write(chunk?: unknown)` below passes
  // straight through.
  writeInternal(chunk?: unknown): Promise<void> {
    if (this.state_ === 'errored') return Promise.reject(this.error_)
    if (this.state_ !== 'writable') return Promise.reject(new TypeError('WritableStream is closed'))
    const write = this.sink_.write
    if (write !== undefined) {
      const result = write(chunk, {
        error: (reason?: unknown): void => this.errorFromController(reason)
      })
      if (result instanceof Promise) return result
    }
    return Promise.resolve()
  }

  closeInternal(): Promise<void> {
    if (this.state_ === 'closed') return Promise.resolve()
    if (this.state_ === 'errored') return Promise.reject(this.error_)
    this.state_ = 'closed'
    const close = this.sink_.close
    if (close !== undefined) {
      const result = close()
      if (result instanceof Promise) return result
    }
    return Promise.resolve()
  }

  releaseWriter(writer: WritableStreamDefaultWriter): void {
    if (this.writer_ !== writer) return
    this.writer_ = null
    this.locked = false
  }

  abort(reason?: unknown): Promise<void> {
    this.state_ = 'errored'
    this.error_ = reason
    const abort = this.sink_.abort
    if (abort !== undefined) abort(reason)
    return Promise.resolve()
  }

  close(): Promise<void> {
    return this.closeInternal()
  }

  getWriter(): WritableStreamDefaultWriter {
    if (this.locked) throw new TypeError('WritableStream is locked')
    this.locked = true
    this.writer_ = new WritableStreamDefaultWriter(this)
    return this.writer_
  }
}

// NOT `WritableStreamDefaultWriter<W = Uint8Array>` -- see `WritableStream`'s
// own comment above for why the class it wraps dropped its type parameter;
// a writer over a non-generic stream has nothing left to parameterize either.
class WritableStreamDefaultWriter {
  private stream_: WritableStream | null

  constructor(stream: WritableStream) {
    this.stream_ = stream
  }

  get closed(): Promise<void> {
    return Promise.resolve()
  }

  get desiredSize(): number | null {
    return this.stream_ === null ? null : 1
  }

  get ready(): Promise<void> {
    return Promise.resolve()
  }

  abort(reason?: unknown): Promise<void> {
    if (this.stream_ === null) return Promise.reject(new TypeError('Writer has no stream'))
    return this.stream_.abort(reason)
  }

  close(): Promise<void> {
    if (this.stream_ === null) return Promise.reject(new TypeError('Writer has no stream'))
    return this.stream_.closeInternal()
  }

  releaseLock(): void {
    if (this.stream_ === null) return
    const stream = this.stream_
    this.stream_ = null
    stream.releaseWriter(this)
  }

  write(chunk?: unknown): Promise<void> {
    if (this.stream_ === null) return Promise.reject(new TypeError('Writer has no stream'))
    return this.stream_.writeInternal(chunk)
  }
}

// NOT `TransformStreamDefaultController<O = Uint8Array>`. `readableController_`
// now instantiates the still-generic `ReadableStreamDefaultController` at
// `unknown` rather than at a class-level `O`: `TransformStream` below (which
// is what constructs this) lost its own `I`/`O` parameters for the same
// reason `WritableStream` lost `W` -- see that class's comment -- and there
// is no monomorphizable element type left to pass through.
class TransformStreamDefaultController {
  private readableController_: ReadableStreamDefaultController<unknown>

  constructor(readableController: ReadableStreamDefaultController<unknown>) {
    this.readableController_ = readableController
  }

  get desiredSize(): number | null {
    return this.readableController_.desiredSize
  }

  enqueue(chunk?: unknown): void {
    this.readableController_.enqueue(chunk)
  }

  error(reason?: unknown): void {
    this.readableController_.error(reason)
  }

  terminate(): void {
    this.readableController_.close()
  }
}

// Same shape-vs-instance split as `UnderlyingReadableStreamController`/
// `UnderlyingWritableStreamController` above: the object a transformer's
// callbacks receive is a literal rebuilt once per `TransformStream` (below),
// not a `TransformStreamDefaultController` instance -- `desiredSize` here is
// that literal's one-time snapshot, not a live getter. No transformer in this
// codebase reads it, so the difference has no reach here, but it IS a real
// behavioral gap from the real controller class, worth naming rather than
// typing over. `chunk` dropped `O` along with the controller class above.
interface UnderlyingTransformController {
  desiredSize: number | null
  enqueue(chunk?: unknown): void
  error(reason?: unknown): void
  terminate(): void
}

// WHATWG Streams §5.1's `Transformer<I, O>` dictionary, narrowed to the
// members this implementation calls. `chunk` is `unknown`, not `I`: see
// `TransformStream`'s own comment below for why the class -- and therefore
// this dictionary's type parameters -- are gone.
interface Transformer {
  start?(controller: UnderlyingTransformController): void
  transform?(chunk: unknown, controller: UnderlyingTransformController): void | Promise<void>
  flush?(controller: UnderlyingTransformController): void | Promise<void>
}

// NOT `TransformStream<I = Uint8Array, O = Uint8Array>`. Two type parameters
// this time, but the same defect as `WritableStream` above: `writable` is a
// `WritableStream` internally, and `WritableStream`'s own `writeInternal`/
// `closeInternal` are exactly where the `typeof result.then === 'function'`
// dispatch produced an unresolved carrier once a type parameter was in
// scope anywhere in this family -- `TransformStream<I, O>` reaches that same
// `WritableStream` construction below (`new WritableStream<I>(...)`), so it
// carries the defect even though `I`/`O` are its own, different parameters.
// `readable`/`writable` are typed against `unknown` chunks for the same
// reason `TransformStreamDefaultController` above is: nothing here can be
// monomorphized, so there is nothing left to parameterize with.
class TransformStream {
  readable: ReadableStream<unknown>
  writable: WritableStream

  constructor(transformer: Transformer = {}, writableStrategy: QueuingStrategyInit = {}, readableStrategy: QueuingStrategyInit = {}) {
    this.readable = new ReadableStream<unknown>({}, readableStrategy)
    const transformController: UnderlyingTransformController = {
      desiredSize: 1,
      enqueue: (chunk?: unknown): void => this.readable.enqueueFromController(chunk),
      error: (reason?: unknown): void => this.readable.errorFromController(reason),
      terminate: (): void => this.readable.closeFromController()
    }
    this.writable = new WritableStream({
      start: (): void => {
        const start = transformer.start
        if (start !== undefined) start(transformController)
      },
      write: (chunk: unknown): void | Promise<void> => {
        const transform = transformer.transform
        if (transform !== undefined) return transform(chunk, transformController)
        // No `transform` means the identity pass-through the spec defines for
        // an omitted transformer. `chunk` and `transformController.enqueue`
        // are both `unknown` now (no more separate `I`/`O` to reconcile with
        // a cast), so this is a direct pass.
        transformController.enqueue(chunk)
        return undefined
      },
      close: (): void | Promise<void> => {
        const flush = transformer.flush
        if (flush !== undefined) {
          const result = flush(transformController)
          transformController.terminate()
          return result
        }
        transformController.terminate()
        return undefined
      },
      abort: (reason?: unknown): void => transformController.error(reason)
    }, writableStrategy)
  }
}

// NOT `extends TransformStream<string, Uint8Array>` -- `TransformStream` has
// no type parameters to pass one to any more (see its comment above). `chunk`
// below is `unknown` accordingly, one step looser than the real input type
// (this class only ever receives strings), matching the base class's own
// dynamic sink boundary; `String(chunk)` and `Buffer.from(...)` both accept
// `unknown` untouched, so nothing here needs an explicit cast.
class TextEncoderStream extends TransformStream {
  encoding: string

  constructor() {
    // Return annotation is `void | Promise<void>`, not `void`: that is
    // `Transformer['transform']`'s own declared return type, and an arrow
    // narrowed to plain `void` is a different calling convention the target
    // installs no conversion for when the literal is assigned into the
    // (optional) `transform` slot below -- matching the annotation removes
    // the conversion, since there is then nothing to convert.
    super({ transform: (chunk, controller): void | Promise<void> => {
      controller.enqueue(Buffer.from(String(chunk)))
    } })
    this.encoding = 'utf-8'
  }

  get [Symbol.toStringTag](): string {
    return 'TextEncoderStream'
  }
}

// NOT `extends TransformStream<Uint8Array | number[] | Buffer, string>` for
// the same reason as `TextEncoderStream` above. The `Array.isArray`/
// `Buffer.isBuffer` guards below narrow `chunk` (now `unknown`) in their own
// true branches same as before; the trailing `else` is the one spot that
// needs an explicit cast, since TypeScript does not narrow the negative
// branch of an `any`-parametered guard down from `unknown`.
class TextDecoderStream extends TransformStream {
  encoding: string
  fatal: boolean
  ignoreBOM: boolean

  constructor(label: string = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const encoding = label as BufferEncoding
    // Same fix as `TextEncoderStream` above: match `Transformer['transform']`'s
    // own `void | Promise<void>` return annotation exactly.
    super({ transform: (chunk, controller): void | Promise<void> => {
      let decoded: string
      if (Array.isArray(chunk)) {
        const bytes = Buffer.alloc(chunk.length)
        for (let index = 0; index < chunk.length; index++) bytes[index] = Number(chunk[index])
        decoded = bytes.toString(encoding)
      } else if (Buffer.isBuffer(chunk)) {
        decoded = chunk.toString(encoding)
      } else {
        decoded = Buffer.from(chunk as Uint8Array).toString(encoding)
      }
      controller.enqueue(decoded)
    } })
    this.encoding = label.toLowerCase()
    this.fatal = options.fatal === true
    this.ignoreBOM = options.ignoreBOM === true
  }

  get [Symbol.toStringTag](): string {
    return 'TextDecoderStream'
  }
}

class CompressionStream extends TransformStream {
  constructor(_format: string) {
    // Compression hooks can be replaced by a native codec without changing
    // the Web Streams contract; until then chunks retain byte identity.
    super()
  }
}

class DecompressionStream extends TransformStream {
  constructor(_format: string) {
    super()
  }
}

class ByteLengthQueuingStrategy {
  highWaterMark: number

  constructor(init: { highWaterMark: number }) {
    this.highWaterMark = init.highWaterMark
  }

  // The real `QueuingStrategySizeCallback<T>` is `(chunk: T) => number`; this
  // strategy only ever reads a byte/element count off whatever chunk shows
  // up, so the parameter names exactly the two fields it reads rather than
  // widening to an opaque `T`.
  size(chunk?: { byteLength?: number; length?: number } | null): number {
    return chunk?.byteLength ?? chunk?.length ?? 1
  }
}

class CountQueuingStrategy {
  highWaterMark: number

  constructor(init: { highWaterMark: number }) {
    this.highWaterMark = init.highWaterMark
  }

  size(_chunk?: unknown): number {
    return 1
  }
}
