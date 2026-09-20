import { finishedPromise, pipelinePromise } from '../stream'

export interface FinishedOptions {
  cleanup?: boolean
  error?: boolean
  readable?: boolean
  signal?: unknown
  writable?: boolean
}

export function nodeStreamPromiseFinished(stream: unknown, options: FinishedOptions = {}): Promise<void> {
  return finishedPromise(stream, options)
}

export function nodeStreamPromisePipeline(
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
): Promise<void> {
  return pipelinePromise(first, second, third, fourth, fifth, sixth, seventh, eighth, ninth, tenth)
}

export {
  nodeStreamPromiseFinished as finished,
  nodeStreamPromisePipeline as pipeline
}
