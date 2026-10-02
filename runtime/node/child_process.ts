// Typed `node:child_process` surface over the generated facade.
//
// The generated facade declares `spawn(...args: unknown[]): never`, which is
// honest about the run time (nothing here can start a process) but not about
// the TYPE: a caller that stores the result -- the MongoDB driver's
// `MongocryptdManager` keeps `this._child = spawn(...)` and then subscribes
// `this._child.on('error', ...)` -- sees its field narrowed to `never` and
// fails to type-check. Node declares a `ChildProcess`, an EventEmitter, so
// that is what `spawn` states here. Spawning still throws the facade's
// not-implemented error; every other export is the facade's own.

import { EventEmitter } from './events'
import { nodeNotImplemented } from './not-implemented'

export * from './generated/facades/child_process'

export type StdioOption = 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'ipc'

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  argv0?: string
  stdio?: StdioOption | readonly (StdioOption | number | null | undefined)[]
  detached?: boolean
  uid?: number
  gid?: number
  shell?: boolean | string
  windowsHide?: boolean
  timeout?: number
  killSignal?: string | number
}

export class ChildProcess extends EventEmitter {
  readonly pid: number | undefined = undefined
  readonly exitCode: number | null = null
  readonly signalCode: string | null = null
  readonly killed: boolean = false
  readonly spawnfile: string = ''
  readonly spawnargs: string[] = []

  kill(_signal?: string | number): boolean {
    return nodeNotImplemented('node:child_process', 'ChildProcess.kill')
  }

  ref(): void {
    nodeNotImplemented('node:child_process', 'ChildProcess.ref')
  }

  unref(): void {
    nodeNotImplemented('node:child_process', 'ChildProcess.unref')
  }
}

export function spawn(_command: string, _args?: readonly string[], _options?: SpawnOptions): ChildProcess {
  return nodeNotImplemented('node:child_process', 'spawn')
}
