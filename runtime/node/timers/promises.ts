// Promise-based timer surface used by the MongoDB driver's retry and OIDC
// throttling paths. MongoDB only awaits completion and never consumes Node's
// optional generic value, so this deliberately keeps a concrete Promise<void>
// ABI rather than boxing an unconstrained T.

export interface TimerOptions {
  ref?: boolean
  signal?: AbortSignal
}

async function nodeTimerPromiseSetTimeout(
  delay: number = 0,
  options?: TimerOptions
): Promise<void> {
  if (options?.signal?.aborted) throw new Error('The operation was aborted')

  // geatsc's current Promise carrier has no suspend/resume continuation yet.
  // Never fake timing by resolving immediately: retry/backoff callers must get
  // an explicit failure until the reactor can resume the awaiting frame.
  throw new Error(
    `timers/promises.setTimeout(${delay}) requires native Promise continuation support`
  )
}

export { nodeTimerPromiseSetTimeout as setTimeout }
