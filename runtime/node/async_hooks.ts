export {
  AsyncLocalStorage,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId
} from './generated/facades/async_hooks'

export class AsyncResource {
  readonly type: string

  constructor(type: string) {
    this.type = type
  }

  runInAsyncScope<Args extends unknown[], Result>(fn: (...args: Args) => Result, thisArg?: unknown, ...args: Args): Result {
    return fn.apply(thisArg, args)
  }
}
