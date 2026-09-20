// node:cluster over the native reactor.
//
// Node's cluster forks worker PROCESSES that re-run the program from the top
// with `cluster.isPrimary === false`, and the primary hears of each worker's
// exit. The native layer (runtime/gea_node.cpp, namespace gea::node::cluster)
// gives this module exactly those facts: `fork` re-executes this binary with a
// worker id in its environment, worker exits arrive through a SIGCHLD-driven
// reactor watcher, and a liveness pipe closes when the primary dies so a
// worker exits on 'disconnect' the way Node's does.
//
// What it does NOT have is an IPC channel. `worker.send`/`process.send` refuse
// loudly; 'online' is emitted by the primary right after the fork rather than
// reported by the worker; 'listening' is not emitted. Connections are
// distributed by the kernel through SO_REUSEPORT listeners (Node's
// SCHED_NONE), not round-robined by the primary.
import { EventEmitter } from './events'
import { nodeNotImplemented } from './not-implemented'

/** @gea-host-inert */
declare function __gea_node_cluster_worker_id(): number
/** @gea-host-inert */
declare function __gea_node_cluster_fork(id: number, env: string): number
/** @gea-host-inert */
declare function __gea_node_cluster_spawn_error(): string
// The narrower host contract: both store their callback in `cluster::state()`
// and run it from the reactor. No JavaScript property is written.
/** @gea-host-no-property-writes */
declare function __gea_node_cluster_set_notify(notify: () => void): void
/** @gea-host-inert */
declare function __gea_node_cluster_next_exit(): number
/** @gea-host-inert */
declare function __gea_node_cluster_exit_code(): number
/** @gea-host-inert */
declare function __gea_node_cluster_exit_signal(): string
/** @gea-host-inert */
declare function __gea_node_cluster_kill(pid: number, signal: string): boolean
/** @gea-host-no-property-writes */
declare function __gea_node_cluster_watch_channel(onDisconnect: () => void): void
/** @gea-host-inert */
declare function __gea_node_process_pid(): number
/** @gea-host-inert */
declare function __gea_node_process_exit(code: number): void

export interface ClusterSettings {
  execArgv?: string[]
  exec?: string
  args?: string[]
  silent?: boolean
  uid?: number
  gid?: number
  inspectPort?: number
  serialization?: string
  cwd?: string
  windowsHide?: boolean
}

export interface Address {
  address: string
  port: number
  addressType: number
}

/** `worker.process`: Node's ChildProcess, at the width this target answers. */
export class WorkerProcess {
  readonly pid: number

  constructor(pid: number) {
    this.pid = pid
  }

  kill(signal: string = 'SIGTERM'): boolean {
    return __gea_node_cluster_kill(this.pid, signal)
  }
}

export class Worker extends EventEmitter {
  readonly id: number
  readonly process: WorkerProcess
  // Node's three states: `undefined` while alive, `true` when the worker was
  // told to leave (kill/disconnect), `false` when it died on its own.
  exitedAfterDisconnect: boolean | undefined = undefined
  private connected_: boolean = true
  private dead_: boolean = false
  private self_: boolean

  constructor(id: number, pid: number, self: boolean) {
    super()
    this.id = id
    this.process = new WorkerProcess(pid)
    this.self_ = self
  }

  isConnected(): boolean {
    return this.connected_
  }

  isDead(): boolean {
    return this.dead_
  }

  kill(signal: string = 'SIGTERM'): void {
    this.exitedAfterDisconnect = true
    this.connected_ = false
    if (this.self_) {
      // In the worker, Node ends its own process; the primary sees the exit.
      __gea_node_process_exit(0)
      return
    }
    __gea_node_cluster_kill(this.process.pid, signal)
  }

  destroy(signal: string = 'SIGTERM'): void {
    this.kill(signal)
  }

  disconnect(): this {
    // No channel to close gracefully: a disconnect is the worker leaving on
    // purpose. In the worker that is an exit; in the primary, a SIGTERM the
    // worker was told to expect (`exitedAfterDisconnect === true`).
    this.exitedAfterDisconnect = true
    if (this.self_) {
      this.connected_ = false
      this.emit('disconnect')
      __gea_node_process_exit(0)
      return this
    }
    this.kill('SIGTERM')
    return this
  }

  send(): boolean {
    return nodeNotImplemented('node:cluster', 'Worker.send')
  }

  /** @internal The primary recording this worker's exit. */
  markExited(): void {
    this.connected_ = false
    this.dead_ = true
  }

  /** @internal The worker losing its primary. */
  markDisconnected(): void {
    this.connected_ = false
  }
}

// "k=v" entries separated by U+001F, the shape the native spawn takes.
const ENV_SEPARATOR = String.fromCharCode(31)

// Node's two scheduling policies. Module-level rather than fields on
// `Cluster` because `SCHED_RR`/`SCHED_NONE` are also libc macros
// (<pthread.h>), and the emitter spells a class field by its TypeScript name:
// a field of that name expands inside the emitted C++ and does not compile.
// That is a compiler defect (emitted member names are not macro-safe), not a
// property of this module; `cluster.SCHED_RR` returns to the object once the
// emitter shields them.
export const SCHED_NONE: number = 1
export const SCHED_RR: number = 2

export class Cluster extends EventEmitter {
  // Kernel distribution through SO_REUSEPORT is what Node calls SCHED_NONE.
  schedulingPolicy: number = SCHED_NONE
  settings: ClusterSettings = {}
  readonly isPrimary: boolean
  readonly isMaster: boolean
  readonly isWorker: boolean
  worker: Worker | undefined = undefined
  workers: { [id: string]: Worker } = {}
  private list_: Worker[] = []
  private nextId_: number = 0
  private notifying_: boolean = false

  constructor() {
    super()
    const id = __gea_node_cluster_worker_id()
    this.isPrimary = id === 0
    this.isMaster = this.isPrimary
    this.isWorker = !this.isPrimary
    if (this.isWorker) {
      const self = new Worker(id, __gea_node_process_pid(), true)
      this.worker = self
      __gea_node_cluster_watch_channel(() => {
        // The primary is gone. Node's worker emits 'disconnect' and, unless
        // it was already leaving, exits immediately.
        self.markDisconnected()
        self.emit('disconnect')
        this.emit('disconnect', self)
        if (self.exitedAfterDisconnect !== true) __gea_node_process_exit(0)
      })
    }
  }

  setupPrimary(settings?: ClusterSettings): void {
    if (settings !== undefined) this.settings = settings
    this.emit('setup', this.settings)
  }

  setupMaster(settings?: ClusterSettings): void {
    this.setupPrimary(settings)
  }

  fork(env?: { [key: string]: string }): Worker {
    if (!this.isPrimary) throw new Error('cluster.fork() is only available in the primary process')
    const id = this.nextId_ + 1
    this.nextId_ = id
    let pairs = ''
    if (env !== undefined) {
      const keys = Object.keys(env)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        pairs += (pairs.length === 0 ? '' : ENV_SEPARATOR) + key + '=' + env[key]
      }
    }
    if (!this.notifying_) {
      this.notifying_ = true
      __gea_node_cluster_set_notify(() => this.drainExits())
    }
    const pid = __gea_node_cluster_fork(id, pairs)
    if (pid === 0) throw new Error('cluster.fork() failed: ' + __gea_node_cluster_spawn_error())
    const worker = new Worker(id, pid, false)
    this.workers[String(id)] = worker
    this.list_.push(worker)
    queueMicrotask(() => {
      this.emit('fork', worker)
      worker.emit('online')
      this.emit('online', worker)
    })
    return worker
  }

  disconnect(callback?: () => void): void {
    const pending: Worker[] = []
    for (let index = 0; index < this.list_.length; index += 1) pending.push(this.list_[index])
    if (pending.length === 0) {
      if (callback !== undefined) queueMicrotask(callback)
      return
    }
    let remaining = pending.length
    for (let index = 0; index < pending.length; index += 1) {
      const worker = pending[index]
      worker.once('exit', () => {
        remaining -= 1
        if (remaining === 0 && callback !== undefined) callback()
      })
      worker.disconnect()
    }
  }

  private drainExits(): void {
    while (true) {
      const pid = __gea_node_cluster_next_exit()
      if (pid === 0) return
      const code = __gea_node_cluster_exit_code()
      const signal = __gea_node_cluster_exit_signal()
      const exitCode: number | null = code < 0 ? null : code
      const exitSignal: string | null = signal.length === 0 ? null : signal
      let found = -1
      for (let index = 0; index < this.list_.length; index += 1) {
        if (this.list_[index].process.pid === pid) found = index
      }
      if (found < 0) continue
      const worker = this.list_[found]
      this.list_.splice(found, 1)
      delete this.workers[String(worker.id)]
      if (worker.exitedAfterDisconnect === undefined) worker.exitedAfterDisconnect = false
      worker.markExited()
      worker.emit('disconnect')
      this.emit('disconnect', worker)
      worker.emit('exit', exitCode, exitSignal)
      this.emit('exit', worker, exitCode, exitSignal)
    }
  }
}

const cluster = new Cluster()

export default cluster

export const isPrimary: boolean = cluster.isPrimary
export const isMaster: boolean = cluster.isMaster
export const isWorker: boolean = cluster.isWorker
export const worker: Worker | undefined = cluster.worker
export const workers: { [id: string]: Worker } = cluster.workers

export function fork(env?: { [key: string]: string }): Worker {
  return cluster.fork(env)
}

export function setupPrimary(settings?: ClusterSettings): void {
  cluster.setupPrimary(settings)
}

export function disconnect(callback?: () => void): void {
  cluster.disconnect(callback)
}
