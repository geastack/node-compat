// Node's timer globals -- `setTimeout`, `setInterval`, `clearTimeout`,
// `clearInterval` -- and the `Timeout` handle they hand back, layered over the
// native reactor-integrated timer registry.
//
// Like `globals.ts`, `whatwg-streams.ts` and `abort-events.ts` this file is a
// SCRIPT, never a module: it must have NO top-level `import`/`export`, because
// that is the whole mechanism putting these declarations in real global scope.
// `@hono/node-server`'s `listener.ts` writes `setTimeout(forceClose, ms)` and
// `clearTimeout(timer)` with no import of either name in sight, and hono's own
// `timeout` middleware and `utils/concurrent.ts` do the same, so the names have
// to resolve by themselves.
//
// This used to be an ambient `const setTimeout: typeof import('./timers.js')
// .setTimeout` in `node-globals.ts` over a module implementation, which is the
// same mistake that page already documents for the WHATWG stream classes: an
// ambient `const` over source is a claim of a HOST binding that does not exist.
// The unit emitted `extern gea::CallableObject<...> setTimeout;` -- a symbol
// nothing defines -- and the only reason that did not surface as a link failure
// is that node-compat's v1 plugin table also claimed the bare name
// `setTimeout` as the host intrinsic `__gea_node_set_timeout`, so the call
// never read the cell. That claim disagreed with this source in both
// directions: the host symbol takes `(std::function<void()>, double)` and
// returns a `double`, while the program's own types say the callback is
// variadic, the delay is optional, and the result is a `Timeout` OBJECT whose
// `.unref?.()` `listener.ts` calls. Nine clang errors in hono-hello came out of
// that one disagreement. `plugin/index.mjs` no longer claims the bare names; the
// only host symbols are the `__gea_node_timer_*` ones below, and this file is
// the implementation.
//
// `timers.ts` is the `node:timers` module surface over these same
// declarations -- the second half of Node exposing them twice, not a second
// implementation, exactly as `stream/web.ts` is for `whatwg-streams.ts`.

// The narrower host contract: `__gea_node_timer_start_timeout`/`_interval`
// move the callback into the native timer registry and return an id. They
// retain it and later run it -- so not `@gea-host-inert` -- but write no
// JavaScript property.
/** @gea-host-no-property-writes */
declare function __gea_node_timer_start_timeout(callback: () => void, delay: number): number
/** @gea-host-no-property-writes */
declare function __gea_node_timer_start_interval(callback: () => void, delay: number): number
/** @gea-host-inert */
declare function __gea_node_timer_clear(id: number): void
/** @gea-host-inert */
declare function __gea_node_timer_unref(id: number): void
/** @gea-host-no-property-writes */
declare function __gea_node_immediate_start(callback: () => void): number
/** @gea-host-inert */
declare function __gea_node_immediate_clear(id: number): void
/** @gea-host-inert */
declare function __gea_node_immediate_ref(id: number, referenced: boolean): void

class Timeout {
  private id_: number
  private referenced_: boolean

  constructor(id: number) {
    this.id_ = id
    this.referenced_ = true
  }

  id(): number {
    return this.id_
  }

  unref(): Timeout {
    if (this.referenced_) {
      this.referenced_ = false
      __gea_node_timer_unref(this.id_)
    }
    return this
  }

  hasRef(): boolean {
    return this.referenced_
  }
}

// `callback`'s parameters are the arguments written after the delay (Node's
// `setTimeout(callback, delay, ...args)`), so a real caller like a `Promise`
// executor's `resolve: (value: T) => void` (the `new Promise((resolve) =>
// setTimeout(resolve))` idiom `@hono/node-server`'s `listener.ts`/`request.ts`
// rely on) is assignable here and receives exactly what the call passed.
//
// NOT a `never` rest list: that is how geatsc spells a callable carrying
// IDENTITY ONLY (`callable-identity`), which states no calling convention, and
// handing one to the host symbol below refused certification outright with
// "no runtime conversion is installed from callable-identity to
// function-value-dispatch(()->void)". See `events.ts`'s `EventHandler` for the
// same defect and the same fix.
//
// The wrapper closure is the other half: the host symbol declares `() => void`
// and the native timer forwards no arguments, so rather than leave a
// rest-arity callable to be converted to a zero-arity one by a conversion this
// target does not install, the zero-arity callable is CONSTRUCTED here, and it
// forwards the call's own arguments. One plain signature each: `node:timers`
// re-exports these two as values, and an alias of an overload set would be
// stored at the overload's type rather than the implementation's frame.
function setTimeout(callback: (...args: any[]) => void, delay: number = 0, ...args: any[]): Timeout {
  return new Timeout(
    __gea_node_timer_start_timeout((): void => {
      callback(...args)
    }, delay)
  )
}

function setInterval(callback: (...args: any[]) => void, delay: number = 0, ...args: any[]): Timeout {
  return new Timeout(
    __gea_node_timer_start_interval((): void => {
      callback(...args)
    }, delay)
  )
}

// `setImmediate`'s handle. Its callback runs in the loop's check phase, after
// the pass's I/O callbacks (`gea::node::immediates`).
class Immediate {
  private id_: number
  private referenced_: boolean

  constructor(id: number) {
    this.id_ = id
    this.referenced_ = true
  }

  id(): number {
    return this.id_
  }

  ref(): Immediate {
    if (!this.referenced_) {
      this.referenced_ = true
      __gea_node_immediate_ref(this.id_, true)
    }
    return this
  }

  unref(): Immediate {
    if (this.referenced_) {
      this.referenced_ = false
      __gea_node_immediate_ref(this.id_, false)
    }
    return this
  }

  hasRef(): boolean {
    return this.referenced_
  }
}

// A generic overload over one plain implementation: the overload states that
// the callback receives the arguments written after it (which types an untyped
// callback's parameters, D106), and a call runs the implementation, so a
// JavaScript caller's `any` instantiation needs no per-instantiation copy.
function setImmediate<TArgs extends any[]>(callback: (...args: TArgs) => void, ...args: TArgs): Immediate
function setImmediate(callback: (...args: any[]) => void, ...args: any[]): Immediate {
  return new Immediate(
    __gea_node_immediate_start((): void => {
      callback(...args)
    })
  )
}

function clearImmediate(handle: Immediate | null | undefined): void {
  if (handle === null || handle === undefined) return
  __gea_node_immediate_clear(handle.id())
}

function timerId(handle: Timeout | number | null | undefined): number {
  if (handle === null || handle === undefined) return 0
  return typeof handle === 'number' ? handle : handle.id()
}

function clearTimeout(handle: Timeout | number | null | undefined): void {
  __gea_node_timer_clear(timerId(handle))
}

function clearInterval(handle: Timeout | number | null | undefined): void {
  clearTimeout(handle)
}
