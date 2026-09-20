// Node-compatible diagnostics channels used by Fastify and other source-built
// libraries. Messages and callbacks are deliberately dynamic: diagnostics
// channels are an application-defined observation boundary, while the channel
// registry and tracing objects remain ordinary native source classes.

export type ChannelName = string | symbol
export type ChannelListener = (message: unknown, name: ChannelName) => void

export interface ContextStore<StoreType> {
  run<Args extends unknown[], Result>(store: StoreType, callback: (...args: Args) => Result, ...args: Args): Result
}

interface StoreBinding<ContextType> {
  readonly store: ContextStore<unknown>
  readonly transform: (context: ContextType) => unknown
}

const channelNames: ChannelName[] = []
const namedChannels: Channel<unknown, unknown>[] = []

// Node retains inactive named channels through weak references. Gea does not
// expose WeakRef/FinalizationRegistry, so this registry retains them strongly.
// Collection timing is the only difference: lookup identity, replacement,
// subscriber state, and every other API-observable behavior remain the same.
function channelIndex(name: ChannelName): number {
  return channelNames.indexOf(name)
}

function reportUncaught(error: unknown): void {
  process.nextTick(() => {
    throw error
  })
}

export class Channel<StoreType = unknown, ContextType = StoreType> {
  readonly name: ChannelName
  private readonly listeners_: ChannelListener[]
  private readonly stores_: StoreBinding<ContextType>[]

  constructor(name: ChannelName) {
    this.name = name
    this.listeners_ = []
    this.stores_ = []
    const index = channelIndex(name)
    if (index < 0) {
      channelNames.push(name)
      namedChannels.push(this as Channel<unknown, unknown>)
    } else {
      // `new Channel(name)` is public in Node and becomes the named registry
      // entry even when another channel with the same name already exists.
      namedChannels[index] = this as Channel<unknown, unknown>
    }
  }

  get hasSubscribers(): boolean {
    return this.listeners_.length > 0 || this.stores_.length > 0
  }

  publish(message: ContextType): void {
    const listeners = this.listeners_.slice()
    for (let index = 0; index < listeners.length; index += 1) {
      try {
        listeners[index](message, this.name)
      } catch (error) {
        // Node reports subscriber failures as uncaught exceptions after every
        // current subscriber has had its synchronous observation opportunity.
        reportUncaught(error)
      }
    }
  }

  subscribe(listener: ChannelListener): void {
    this.listeners_.push(listener)
  }

  unsubscribe(listener: ChannelListener): boolean {
    const index = this.listeners_.indexOf(listener)
    if (index < 0) return false
    this.listeners_.splice(index, 1)
    return true
  }

  bindStore(store: ContextStore<ContextType>): void
  bindStore<BoundStoreType>(store: ContextStore<BoundStoreType>, transform: (context: ContextType) => BoundStoreType): void
  bindStore<BoundStoreType>(
    store: ContextStore<BoundStoreType>,
    transform?: (context: ContextType) => BoundStoreType
  ): void {
    const existing = this.stores_.findIndex((binding) => binding.store === store)
    const binding: StoreBinding<ContextType> = {
      store: store as ContextStore<unknown>,
      transform: transform ?? ((context) => context as unknown as BoundStoreType)
    }
    if (existing < 0) this.stores_.push(binding)
    else this.stores_[existing] = binding
  }

  unbindStore<BoundStoreType>(store: ContextStore<BoundStoreType>): boolean {
    const index = this.stores_.findIndex((binding) => binding.store === store)
    if (index < 0) return false
    this.stores_.splice(index, 1)
    return true
  }

  runStores<ThisArg, Args extends unknown[], Result>(
    context: ContextType,
    fn: (this: ThisArg, ...args: Args) => Result,
    thisArg?: ThisArg,
    ...args: Args
  ): Result {
    const stores = this.stores_.slice()
    const run = (index: number): Result => {
      if (index < 0) {
        this.publish(context)
        return fn.call(thisArg as ThisArg, ...args)
      }
      const binding = stores[index]
      let storeContext: unknown
      try {
        storeContext = binding.transform(context)
      } catch (error) {
        // A diagnostics transform cannot suppress the operation it observes.
        // Node reports the exception asynchronously and continues through the
        // remaining stores, subscribers, and wrapped callback.
        reportUncaught(error)
        return run(index - 1)
      }
      return binding.store.run(storeContext, () => run(index - 1))
    }
    return run(stores.length - 1)
  }
}

export function channel(name: ChannelName): Channel<unknown, unknown> {
  const index = channelIndex(name)
  if (index >= 0) return namedChannels[index]
  return new Channel<unknown, unknown>(name)
}

export function hasSubscribers(name: ChannelName): boolean {
  const index = channelIndex(name)
  return index >= 0 && namedChannels[index].hasSubscribers
}

export function subscribe(name: ChannelName, listener: ChannelListener): void {
  channel(name).subscribe(listener)
}

export function unsubscribe(name: ChannelName, listener: ChannelListener): boolean {
  return channel(name).unsubscribe(listener)
}

export interface TracingChannelSubscribers<ContextType extends object> {
  readonly start?: (message: ContextType) => void
  readonly end?: (message: ContextType) => void
  readonly asyncStart?: (message: ContextType) => void
  readonly asyncEnd?: (message: ContextType) => void
  readonly error?: (message: ContextType) => void
}

export interface TracingChannelCollection<StoreType, ContextType extends object> {
  readonly start: Channel<StoreType, ContextType>
  readonly end: Channel<StoreType, ContextType>
  readonly asyncStart: Channel<StoreType, ContextType>
  readonly asyncEnd: Channel<StoreType, ContextType>
  readonly error: Channel<StoreType, ContextType>
}

interface TraceResult {
  result?: unknown
  error?: unknown
}

const tracingEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const
type TracingEvent = (typeof tracingEvents)[number]

export class TracingChannel<StoreType = unknown, ContextType extends object = Record<string, unknown>> {
  readonly start: Channel<StoreType, ContextType>
  readonly end: Channel<StoreType, ContextType>
  readonly asyncStart: Channel<StoreType, ContextType>
  readonly asyncEnd: Channel<StoreType, ContextType>
  readonly error: Channel<StoreType, ContextType>

  constructor(nameOrChannels: string | TracingChannelCollection<StoreType, ContextType>) {
    if (typeof nameOrChannels === 'string') {
      this.start = channel(`tracing:${nameOrChannels}:start`) as Channel<StoreType, ContextType>
      this.end = channel(`tracing:${nameOrChannels}:end`) as Channel<StoreType, ContextType>
      this.asyncStart = channel(`tracing:${nameOrChannels}:asyncStart`) as Channel<StoreType, ContextType>
      this.asyncEnd = channel(`tracing:${nameOrChannels}:asyncEnd`) as Channel<StoreType, ContextType>
      this.error = channel(`tracing:${nameOrChannels}:error`) as Channel<StoreType, ContextType>
    } else {
      this.start = nameOrChannels.start
      this.end = nameOrChannels.end
      this.asyncStart = nameOrChannels.asyncStart
      this.asyncEnd = nameOrChannels.asyncEnd
      this.error = nameOrChannels.error
    }
  }

  get hasSubscribers(): boolean {
    return tracingEvents.some((event) => this[event].hasSubscribers)
  }

  subscribe(subscribers: TracingChannelSubscribers<ContextType>): void {
    for (const event of tracingEvents) {
      const listener = subscribers[event]
      if (listener) this[event].subscribe(listener as ChannelListener)
    }
  }

  unsubscribe(subscribers: TracingChannelSubscribers<ContextType>): boolean {
    let removed = true
    for (const event of tracingEvents) {
      const listener = subscribers[event]
      if (listener) removed = this[event].unsubscribe(listener as ChannelListener) && removed
    }
    return removed
  }

  traceSync<ThisArg, Args extends unknown[], Result>(
    fn: (this: ThisArg, ...args: Args) => Result,
    context?: ContextType,
    thisArg?: ThisArg,
    ...args: Args
  ): Result {
    if (!this.hasSubscribers) return fn.call(thisArg as ThisArg, ...args)
    const trace = (context ?? {}) as ContextType & TraceResult
    return this.start.runStores(trace, () => {
      try {
        const result = fn.call(thisArg as ThisArg, ...args)
        trace.result = result
        return result
      } catch (error) {
        trace.error = error
        this.error.publish(trace)
        throw error
      } finally {
        this.end.publish(trace)
      }
    }, undefined)
  }

  tracePromise<ThisArg, Args extends unknown[], Result>(
    fn: (this: ThisArg, ...args: Args) => Result | PromiseLike<Result>,
    context?: ContextType,
    thisArg?: ThisArg,
    ...args: Args
  ): Promise<Result> {
    if (!this.hasSubscribers) return fn.call(thisArg as ThisArg, ...args) as Promise<Result>
    const trace = (context ?? {}) as ContextType & TraceResult
    const promise = this.start.runStores(trace, () => {
      try {
        const result = fn.call(thisArg as ThisArg, ...args)
        return result instanceof Promise ? result : Promise.resolve(result)
      } catch (error) {
        trace.error = error
        this.error.publish(trace)
        throw error
      } finally {
        this.end.publish(trace)
      }
    }, undefined)
    return promise.then(
      (result) => {
        trace.result = result
        this.asyncStart.publish(trace)
        this.asyncEnd.publish(trace)
        return result
      },
      (error) => {
        trace.error = error
        this.error.publish(trace)
        this.asyncStart.publish(trace)
        this.asyncEnd.publish(trace)
        throw error
      }
    )
  }

  traceCallback<ThisArg, Args extends unknown[], Result>(
    fn: (this: ThisArg, ...args: Args) => Result,
    position: number = -1,
    context?: ContextType,
    thisArg?: ThisArg,
    ...args: Args
  ): Result {
    if (!this.hasSubscribers) return fn.call(thisArg as ThisArg, ...args)
    const trace = (context ?? {}) as ContextType & TraceResult
    const callArgs = args.slice() as unknown[]
    const callbackValue = callArgs.at(position)
    if (typeof callbackValue !== 'function') throw new TypeError('The callback argument must be a function')
    const callback = callbackValue as (...callbackArgs: unknown[]) => unknown
    const thisChannel = this
    const wrappedCallback = function (this: unknown, ...callbackArgs: unknown[]): void {
      if (callbackArgs[0]) {
        trace.error = callbackArgs[0]
        thisChannel.error.publish(trace)
      } else {
        trace.result = callbackArgs[1]
      }
      thisChannel.asyncStart.runStores(trace, () => {
        try {
          return callback.call(this, ...callbackArgs)
        } finally {
          thisChannel.asyncEnd.publish(trace)
        }
      }, undefined)
    }
    callArgs.splice(position, 1, wrappedCallback)
    return this.start.runStores(trace, () => {
      try {
        return fn.call(thisArg as ThisArg, ...(callArgs as Args))
      } catch (error) {
        trace.error = error
        this.error.publish(trace)
        throw error
      } finally {
        this.end.publish(trace)
      }
    }, undefined)
  }
}

export function tracingChannel<StoreType = unknown, ContextType extends object = Record<string, unknown>>(
  nameOrChannels: string | TracingChannelCollection<StoreType, ContextType>
): TracingChannel<StoreType, ContextType> {
  return new TracingChannel(nameOrChannels)
}
