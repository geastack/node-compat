// `node:async_hooks`. This runtime installs no async hooks and tracks no async
// ids, so an `AsyncResource`'s scope is the caller's own: `runInAsyncScope`
// calls the function with its receiver and arguments, and `emitDestroy` has no
// hook to notify. Everything that would have to answer an async id refuses by
// name, as the generated facade does for the whole module.
import type { EventHandler } from './events'
import { nodeNotImplemented } from './not-implemented'

const moduleName = 'node:async_hooks'

export class AsyncLocalStorage {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented(moduleName, 'AsyncLocalStorage')
  }
}

export class AsyncResource {
  constructor(type: string, triggerAsyncIdOrOptions?: unknown) {
    void type
    void triggerAsyncIdOrOptions
  }

  // Any arity, like an event listener: `EventHandler` is that dynamic surface.
  runInAsyncScope(fn: EventHandler, thisArg?: unknown, ...args: unknown[]): unknown {
    return fn.apply(thisArg, args)
  }

  emitDestroy(): this {
    return this
  }

  asyncId(): number {
    return nodeNotImplemented(moduleName, 'AsyncResource.asyncId')
  }

  triggerAsyncId(): number {
    return nodeNotImplemented(moduleName, 'AsyncResource.triggerAsyncId')
  }

  bind(fn: EventHandler): never {
    void fn
    return nodeNotImplemented(moduleName, 'AsyncResource.bind')
  }

  static bind(fn: EventHandler, type?: string, thisArg?: unknown): never {
    void fn
    void type
    void thisArg
    return nodeNotImplemented(moduleName, 'AsyncResource.bind')
  }
}

export const asyncWrapProviders: unknown = undefined

export function createHook(...args: unknown[]): never {
  void args
  return nodeNotImplemented(moduleName, 'createHook')
}

export function executionAsyncId(...args: unknown[]): never {
  void args
  return nodeNotImplemented(moduleName, 'executionAsyncId')
}

export function executionAsyncResource(...args: unknown[]): never {
  void args
  return nodeNotImplemented(moduleName, 'executionAsyncResource')
}

export function triggerAsyncId(...args: unknown[]): never {
  void args
  return nodeNotImplemented(moduleName, 'triggerAsyncId')
}
