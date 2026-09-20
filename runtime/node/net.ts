// Typed node:net TCP client subset for the official MongoDB driver. Native
// notifications are zero-argument; data is pulled separately as Buffer, which
// keeps every wire byte off gea_cpp_value.

import { Buffer, BufferEncoding } from './buffer'
import { EventEmitter, EventHandler, Listener } from './events'
import { Writable } from './stream'
import { nodeNotImplemented } from './not-implemented'
import {
  clearTimeout as cancelNodeTimer,
  setTimeout as scheduleNodeTimer,
  Timeout
} from './timers'

// `@gea-host-no-property-writes` is the NARROWER of the two host effect
// contracts: it states only that the native writes no JavaScript property,
// and explicitly permits what `@gea-host-inert` forbids -- these natives
// RETAIN their `notify` callback and RUN it later, and `net_read` builds a
// fresh Buffer. Neither is a write on anything the program already holds: the
// callback's own writes are censused where the callback is written, and a new
// object had no keys for the program to observe. `net_write` reads the bytes
// out of the buffer it is handed (`connection->write( data, size )`) and keeps
// nothing.
/** @gea-host-no-property-writes */
declare function __gea_node_net_create(
  host: string,
  port: number,
  family: number,
  hints: number,
  localAddress: string,
  localPort: number,
  bindLocal: boolean,
  notify: () => void
): number
// `@gea-host-inert` below is the per-declaration host effect contract
// (compiler `src/semantics/normalize/host-effect-contracts.ts`): the native
// retains no argument, writes no JavaScript property, and runs no program
// code. It is carried only by the natives whose every parameter is a
// primitive -- a `number` id, a `string`, a `boolean` -- so there is no object
// to retain or write, and whose C++ bodies in `runtime/gea_node.cpp` reach no
// program closure: `end()` posts through `notifySoon()`/`queue_microtask`, and
// `destroy()` goes to `loop_.close`, neither of which calls `notify_` inline.
// `net_create`, `net_set_notify` and `net_server_listen` take a callback;
// `net_read` and `net_write` carry a Buffer across the boundary. Those four
// shapes are deliberately untagged -- the contract is never inferred, and a
// wrong one is trusted the way a signature is.
/** @gea-host-inert */
declare function __gea_node_net_create_error(): string
/** @gea-host-inert */
declare function __gea_node_net_next_event(id: number): number
/** @gea-host-no-property-writes */
declare function __gea_node_net_read(id: number): Buffer
/** @gea-host-inert */
declare function __gea_node_net_error(id: number): string
/** @gea-host-no-property-writes */
declare function __gea_node_net_write(id: number, buffer: Buffer): boolean
/** @gea-host-inert */
declare function __gea_node_net_buffer_size(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_end(id: number): void
/** @gea-host-inert */
declare function __gea_node_net_destroy(id: number): void
/** @gea-host-inert */
declare function __gea_node_net_reset_and_destroy(id: number): void
/** @gea-host-inert */
declare function __gea_node_net_set_paused(id: number, paused: boolean): void
/** @gea-host-inert */
declare function __gea_node_net_set_referenced(id: number, referenced: boolean): void
/** @gea-host-no-property-writes */
declare function __gea_node_net_set_notify(id: number, notify: () => void): void
/** @gea-host-inert */
declare function __gea_node_net_set_keep_alive(
  id: number,
  enabled: boolean,
  initialDelayMs: number
): void
/** @gea-host-inert */
declare function __gea_node_net_set_no_delay(id: number, enabled: boolean): void
/** @gea-host-inert */
declare function __gea_node_net_remote_address(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_remote_port(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_remote_family(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_local_address(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_local_port(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_local_family(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_is_ip(input: string): number
/** @gea-host-inert */
declare function __gea_node_net_normalize_ip(input: string, family: number): string
/** @gea-host-inert */
declare function __gea_node_net_ip_compare(
  left: string,
  leftFamily: number,
  right: string,
  rightFamily: number
): number
/** @gea-host-inert */
declare function __gea_node_net_ip_in_subnet(
  address: string,
  addressFamily: number,
  network: string,
  networkFamily: number,
  prefix: number
): boolean
/** @gea-host-no-property-writes */
declare function __gea_node_net_server_listen(
  host: string,
  port: number,
  family: number,
  backlog: number,
  reusePort: boolean,
  ipv6Only: boolean,
  maxConnections: number,
  notify: () => void
): number
/** @gea-host-inert */
declare function __gea_node_net_server_create_error(): string
/** @gea-host-inert */
declare function __gea_node_net_server_error(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_server_next_event(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_server_take_connection(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_server_close(id: number): void
/** @gea-host-inert */
declare function __gea_node_net_server_set_referenced(id: number, referenced: boolean): void
/** @gea-host-inert */
declare function __gea_node_net_server_set_max_connections(
  id: number,
  maxConnections: number
): void
/** @gea-host-inert */
declare function __gea_node_net_server_connections(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_server_address(id: number): string
/** @gea-host-inert */
declare function __gea_node_net_server_port(id: number): number
/** @gea-host-inert */
declare function __gea_node_net_server_family(id: number): string

const EVENT_CONNECT = 1
const EVENT_DATA = 2
const EVENT_ERROR = 3
const EVENT_CLOSE = 4
const EVENT_DRAIN = 5
const EVENT_FINISH = 6
const EVENT_END = 7

const SERVER_EVENT_LISTENING = 1
const SERVER_EVENT_CONNECTION = 2
const SERVER_EVENT_ERROR = 3
const SERVER_EVENT_CLOSE = 4
const SERVER_EVENT_DROP = 5

let defaultAutoSelectFamily = true
let defaultAutoSelectFamilyAttemptTimeout = 250

interface NodeArgumentError extends Error {
  code: string
}

function invalidArgumentType(name: string, expected: string): never {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}.`) as NodeArgumentError
  error.code = 'ERR_INVALID_ARG_TYPE'
  throw error
}

function outOfRange(name: string, range: string): never {
  const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}.`) as NodeArgumentError
  error.code = 'ERR_OUT_OF_RANGE'
  throw error
}

export interface SocketConstructorOpts {
  fd?: number
  allowHalfOpen?: boolean
  onread?: unknown
  readable?: boolean
  writable?: boolean
  signal?: unknown
  noDelay?: boolean
  keepAlive?: boolean
  keepAliveInitialDelay?: number
  blockList?: unknown
}

export interface TcpSocketConnectOpts {
  host?: string
  port: number
  family?: number
  localAddress?: string
  localPort?: number
  hints?: number
  lookup?: unknown
  autoSelectFamily?: boolean
  autoSelectFamilyAttemptTimeout?: number
}

export interface IpcSocketConnectOpts {
  path: string
}

export type SocketConnectOpts = TcpSocketConnectOpts | IpcSocketConnectOpts

export interface TcpNetConnectOpts extends TcpSocketConnectOpts, SocketConstructorOpts {
  timeout?: number
}

export interface IpcNetConnectOpts extends IpcSocketConnectOpts, SocketConstructorOpts {
  timeout?: number
}

export type NetConnectOpts = TcpNetConnectOpts | IpcNetConnectOpts

export interface ServerOpts {
  allowHalfOpen?: boolean
  pauseOnConnect?: boolean
  noDelay?: boolean
  keepAlive?: boolean
  keepAliveInitialDelay?: number
  highWaterMark?: number
}

export interface ListenOptions {
  backlog?: number
  exclusive?: boolean
  host?: string
  ipv6Only?: boolean
  reusePort?: boolean
  path?: string
  port?: number
  readableAll?: boolean
  writableAll?: boolean
  signal?: unknown
}

export type IPVersion = 'ipv4' | 'ipv6'

export interface SocketAddressInitOptions {
  address?: string
  family?: IPVersion
  flowlabel?: number
  port?: number
}

export interface AddressInfo {
  address: string
  family: string
  port: number
}

type SocketWriteCallback = (error?: Error | null) => void

export type ConnectionListener = (socket: Socket) => void

export interface TypedSocketHandlers {
  connect: () => void
  data: (chunk: Buffer) => void
  error: (error: Error) => void
  close: () => void
}

/** @internal A typed TCP client over the shared reactor, for compiled protocol implementations. */
export class ReactorSocket {
  private nativeId_: number
  private handlers_: TypedSocketHandlers | null

  constructor() {
    this.nativeId_ = 0
    this.handlers_ = null
  }

  connect(port: number, host: string, handlers: TypedSocketHandlers): void {
    if (this.nativeId_ !== 0) throw new Error('Socket is already connecting or connected')
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Port should be >= 0 and < 65536')
    this.handlers_ = handlers
    this.nativeId_ = __gea_node_net_create(host, port, 0, 0, '', 0, false, () => this.dispatch())
    if (this.nativeId_ === 0) {
      const message = __gea_node_net_create_error()
      queueMicrotask((): void => handlers.error(new Error(message.length === 0 ? 'Unable to create socket' : message)))
      return
    }
    __gea_node_net_set_keep_alive(this.nativeId_, true, 0)
    __gea_node_net_set_no_delay(this.nativeId_, true)
  }

  write(data: Uint8Array): boolean {
    if (this.nativeId_ === 0) return false
    return __gea_node_net_write(this.nativeId_, Buffer.from(data))
  }

  close(): void {
    if (this.nativeId_ !== 0) __gea_node_net_destroy(this.nativeId_)
    this.nativeId_ = 0
    this.handlers_ = null
  }

  private dispatch(): void {
    const handlers = this.handlers_
    if (handlers === null) return
    while (true) {
      const event = __gea_node_net_next_event(this.nativeId_)
      if (event === 0) return
      if (event === EVENT_CONNECT) handlers.connect()
      else if (event === EVENT_DATA) handlers.data(__gea_node_net_read(this.nativeId_))
      else if (event === EVENT_ERROR) handlers.error(new Error(__gea_node_net_error(this.nativeId_)))
      else if (event === EVENT_CLOSE) {
        handlers.close()
        this.nativeId_ = 0
        this.handlers_ = null
        return
      }
    }
  }
}

export class Socket extends EventEmitter {
  private nativeId_: number
  private pipeTarget_: Writable | null
  private timeoutHandle_: Timeout | null
  private closeEmitted_: boolean
  private constructorNoDelay_: boolean
  private constructorKeepAlive_: boolean
  private constructorKeepAliveInitialDelay_: number
  private paused_: boolean
  private pendingChunks_: Buffer[]
  private encoding_: BufferEncoding | ''
  private pendingWriteCallbacks_: SocketWriteCallback[]
  private pendingFinishCallbacks_: (() => void)[]
  private destroyAfterFinish_: boolean
  private self_: Socket | null

  connecting: boolean
  destroyed: boolean
  pending: boolean
  bytesRead: number
  bytesWritten: number
  timeout: number
  readyState: string
  remoteAddress: string
  remotePort: number
  remoteFamily: string
  localAddress: string | undefined
  localPort: number | undefined
  localFamily: string | undefined
  autoSelectFamilyAttemptedAddresses: string[]
  bufferSize: number

  constructor(options: SocketConstructorOpts = {}) {
    super()
    this.nativeId_ = 0
    this.pipeTarget_ = null
    this.timeoutHandle_ = null
    this.closeEmitted_ = false
    this.constructorNoDelay_ = options.noDelay ?? false
    this.constructorKeepAlive_ = options.keepAlive ?? false
    this.constructorKeepAliveInitialDelay_ = options.keepAliveInitialDelay ?? 0
    this.paused_ = false
    this.pendingChunks_ = []
    this.encoding_ = ''
    this.pendingWriteCallbacks_ = []
    this.pendingFinishCallbacks_ = []
    this.destroyAfterFinish_ = false
    this.self_ = null
    this.connecting = false
    this.destroyed = false
    this.pending = true
    this.bytesRead = 0
    this.bytesWritten = 0
    this.timeout = 0
    this.readyState = 'opening'
    this.remoteAddress = ''
    this.remotePort = 0
    this.remoteFamily = ''
    this.localAddress = undefined
    this.localPort = undefined
    this.localFamily = undefined
    this.autoSelectFamilyAttemptedAddresses = []
    this.bufferSize = 0

    if (options.fd !== undefined) nodeNotImplemented('node:net', 'Socket.constructor.fd')
    if (options.onread !== undefined) nodeNotImplemented('node:net', 'Socket.constructor.onread')
    if (options.signal !== undefined) nodeNotImplemented('node:net', 'Socket.constructor.signal')
    if (options.blockList !== undefined) nodeNotImplemented('node:net', 'Socket.constructor.blockList')
    if (options.allowHalfOpen === true) {
      nodeNotImplemented('node:net', 'Socket.constructor.allowHalfOpen')
    }
    if (options.readable === false) nodeNotImplemented('node:net', 'Socket.constructor.readable')
    if (options.writable === false) nodeNotImplemented('node:net', 'Socket.constructor.writable')
  }

  connect(options: SocketConnectOpts, connectionListener?: () => void): this
  connect(port: number, host: string, connectionListener?: () => void): this
  connect(port: number, connectionListener?: () => void): this
  connect(path: string, connectionListener?: () => void): this
  connect(
    optionsOrPortOrPath: SocketConnectOpts | number | string,
    hostOrListener?: string | (() => void),
    connectionListener?: () => void
  ): this {
    if (typeof optionsOrPortOrPath === 'string') {
      void hostOrListener
      void connectionListener
      nodeNotImplemented('node:net', 'Socket.connect.path')
      return this
    }

    if (typeof optionsOrPortOrPath === 'number') {
      const host = typeof hostOrListener === 'string' ? hostOrListener : 'localhost'
      if (typeof hostOrListener === 'function') {
        return this.connectTcp(host, optionsOrPortOrPath, 0, 0, '', 0, false, hostOrListener)
      }
      return this.connectTcp(host, optionsOrPortOrPath, 0, 0, '', 0, false, connectionListener)
    }

    if ('path' in optionsOrPortOrPath) {
      void hostOrListener
      void connectionListener
      nodeNotImplemented('node:net', 'Socket.connect.path')
      return this
    }

    if (typeof hostOrListener === 'function') {
      return this.connectTcpOptions(optionsOrPortOrPath, hostOrListener)
    }
    return this.connectTcpOptions(optionsOrPortOrPath, connectionListener)
  }

  override on(name: string, listener: EventHandler): this {
    super.on(name, listener)
    return this
  }

  override once(name: string, listener: EventHandler): this {
    super.once(name, listener)
    return this
  }

  override off(name: string, listener: EventHandler): this {
    super.off(name, listener)
    return this
  }

  override addListener(name: string, listener: EventHandler): this {
    super.addListener(name, listener)
    return this
  }

  override prependListener(name: string, listener: EventHandler): this {
    super.prependListener(name, listener)
    return this
  }

  override prependOnceListener(name: string, listener: EventHandler): this {
    super.prependOnceListener(name, listener)
    return this
  }

  override emit(name: string, ...args: unknown[]): boolean {
    return super.emit(name, ...args)
  }

  setKeepAlive(enabled: boolean = false, initialDelayMs: number = 0): this {
    if (this.nativeId_ !== 0) {
      __gea_node_net_set_keep_alive(this.nativeId_, enabled, initialDelayMs)
    }
    return this
  }

  setNoDelay(enabled: boolean = true): this {
    if (this.nativeId_ !== 0) __gea_node_net_set_no_delay(this.nativeId_, enabled)
    return this
  }

  setTimeout(timeoutMs: number, callback?: () => void): this {
    this.timeout = Math.max(0, timeoutMs)
    if (callback) this.on('timeout', callback)
    this.resetTimeout()
    return this
  }

  write(data: Uint8Array | string, callback?: SocketWriteCallback): boolean
  write(
    data: Uint8Array | string,
    encoding?: BufferEncoding,
    callback?: SocketWriteCallback
  ): boolean
  write(
    data: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | SocketWriteCallback,
    callback?: SocketWriteCallback
  ): boolean {
    if (this.destroyed || this.nativeId_ === 0) {
      const error = new Error('This socket has been ended by the other party') as NodeArgumentError
      error.code = 'EPIPE'
      if (typeof encodingOrCallback === 'function') {
        queueMicrotask(() => encodingOrCallback(error))
      } else if (callback) {
        queueMicrotask(() => callback(error))
      }
      return false
    }
    const buffer =
      typeof data === 'string'
        ? Buffer.from(data, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
        : Buffer.from(data)
    this.resetTimeout()
    this.bytesWritten += buffer.length
    let hasCallback = false
    if (typeof encodingOrCallback === 'function') {
      this.pendingWriteCallbacks_.push(encodingOrCallback)
      hasCallback = true
    } else if (callback) {
      this.pendingWriteCallbacks_.push(callback)
      hasCallback = true
    }
    const accepted = __gea_node_net_write(this.nativeId_, buffer)
    this.bufferSize = __gea_node_net_buffer_size(this.nativeId_)
    if (buffer.length === 0 && hasCallback) this.flushWriteCallbacks()
    return accepted
  }

  end(callback?: () => void): this
  end(data: Uint8Array | string, callback?: () => void): this
  end(data: Uint8Array | string, encoding?: BufferEncoding, callback?: () => void): this
  end(
    dataOrCallback?: Uint8Array | string | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void
  ): this {
    if (typeof dataOrCallback === 'function') {
      this.pendingFinishCallbacks_.push(dataOrCallback)
    } else if (typeof encodingOrCallback === 'function') {
      this.pendingFinishCallbacks_.push(encodingOrCallback)
    } else if (callback) {
      this.pendingFinishCallbacks_.push(callback)
    }
    if (typeof dataOrCallback !== 'function' && dataOrCallback !== undefined) {
      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
      this.write(dataOrCallback, encoding)
    }
    if (this.nativeId_ === 0 || this.destroyed) {
      queueMicrotask(() => {
        this.flushFinishCallbacks()
        this.emit('finish')
      })
      return this
    }
    this.readyState = 'readOnly'
    __gea_node_net_end(this.nativeId_)
    return this
  }

  destroySoon(): void {
    if (this.destroyed) return
    this.destroyAfterFinish_ = true
    this.end()
  }

  resetAndDestroy(): this {
    if (this.nativeId_ !== 0) __gea_node_net_reset_and_destroy(this.nativeId_)
    return this.destroy()
  }

  pause(): this {
    this.paused_ = true
    if (this.nativeId_ !== 0) __gea_node_net_set_paused(this.nativeId_, true)
    return this
  }

  resume(): this {
    this.paused_ = false
    if (this.nativeId_ !== 0) __gea_node_net_set_paused(this.nativeId_, false)
    while (!this.paused_ && this.pendingChunks_.length > 0) {
      const chunk = this.pendingChunks_.shift()
      if (chunk !== undefined) this.deliverChunk(chunk)
    }
    return this
  }

  setEncoding(encoding: BufferEncoding = 'utf8'): this {
    this.encoding_ = encoding
    return this
  }

  address(): AddressInfo | {} {
    if (
      this.localAddress === undefined ||
      this.localFamily === undefined ||
      this.localPort === undefined
    ) {
      // Node's real not-connected sentinel is a genuine empty object, not an
      // `AddressInfo`. Casting the literal through a local declared
      // `unknown` hands geatsc the `dynamic` carrier the `AddressInfo | {}`
      // union's other arm already expects, instead of asking for a
      // conversion from a concrete zero-field record it has none for.
      const empty: unknown = {}
      return empty as AddressInfo | {}
    }
    return {
      address: this.localAddress,
      family: this.localFamily,
      port: this.localPort
    }
  }

  /** @internal Adopt a native socket accepted by node:net.Server. */
  adoptAccepted(nativeId: number, pauseOnConnect: boolean = false): this {
    this.nativeId_ = nativeId
    this.self_ = this
    this.closeEmitted_ = false
    this.connecting = false
    this.destroyed = false
    this.pending = false
    this.readyState = 'open'
    this.remoteAddress = __gea_node_net_remote_address(nativeId)
    this.remotePort = __gea_node_net_remote_port(nativeId)
    this.remoteFamily = __gea_node_net_remote_family(nativeId)
    const localAddress = __gea_node_net_local_address(nativeId)
    const localPort = __gea_node_net_local_port(nativeId)
    const localFamily = __gea_node_net_local_family(nativeId)
    this.localAddress = localAddress.length === 0 ? undefined : localAddress
    this.localPort = localPort === 0 ? undefined : localPort
    this.localFamily = localFamily.length === 0 ? undefined : localFamily
    this.autoSelectFamilyAttemptedAddresses = []
    __gea_node_net_set_notify(nativeId, () => this.dispatchNativeEvents())
    this.setKeepAlive(this.constructorKeepAlive_, this.constructorKeepAliveInitialDelay_)
    this.setNoDelay(this.constructorNoDelay_)
    if (pauseOnConnect) this.pause()
    this.resetTimeout()
    return this
  }

  unref(): this {
    if (this.nativeId_ !== 0) __gea_node_net_set_referenced(this.nativeId_, false)
    return this
  }

  ref(): this {
    if (this.nativeId_ !== 0) __gea_node_net_set_referenced(this.nativeId_, true)
    return this
  }

  pipe<T extends Writable>(destination: T): T {
    this.pipeTarget_ = destination
    return destination
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.connecting = false
    this.pending = false
    this.readyState = 'closed'
    this.clearSocketTimeout()
    this.bufferSize = 0
    if (error !== undefined) this.emit('error', error)
    if (this.nativeId_ !== 0) __gea_node_net_destroy(this.nativeId_)
    queueMicrotask(() => this.emitClose())
    return this
  }

  private clearSocketTimeout(): void {
    if (this.timeoutHandle_ !== null) {
      cancelNodeTimer(this.timeoutHandle_)
      this.timeoutHandle_ = null
    }
  }

  private resetTimeout(): void {
    this.clearSocketTimeout()
    if (this.timeout <= 0 || this.destroyed) return
    this.timeoutHandle_ = scheduleNodeTimer(() => {
      this.timeoutHandle_ = null
      if (!this.destroyed) this.emit('timeout')
    }, this.timeout)
  }

  private emitClose(): void {
    if (this.closeEmitted_) return
    this.closeEmitted_ = true
    this.clearSocketTimeout()
    this.emit('close')
    this.self_ = null
  }

  private deliverChunk(chunk: Buffer): void {
    if (this.pipeTarget_ !== null) {
      this.pipeTarget_.write(chunk)
    } else if (this.encoding_ === '') {
      this.emit('data', chunk)
    } else {
      this.emit('data', chunk.toString(this.encoding_))
    }
  }

  private flushWriteCallbacks(error: Error | null = null): void {
    const callbacks: SocketWriteCallback[] = []
    for (let index = 0; index < this.pendingWriteCallbacks_.length; index += 1) {
      callbacks.push(this.pendingWriteCallbacks_[index])
    }
    this.pendingWriteCallbacks_ = []
    for (let index = 0; index < callbacks.length; index += 1) callbacks[index](error)
  }

  private flushFinishCallbacks(): void {
    const callbacks: (() => void)[] = []
    for (let index = 0; index < this.pendingFinishCallbacks_.length; index += 1) {
      callbacks.push(this.pendingFinishCallbacks_[index])
    }
    this.pendingFinishCallbacks_ = []
    for (let index = 0; index < callbacks.length; index += 1) callbacks[index]()
  }

  private dispatchNativeEvents(): void {
    while (true) {
      const event = __gea_node_net_next_event(this.nativeId_)
      if (event === 0) return
      if (event === EVENT_CONNECT) {
        this.connecting = false
        this.pending = false
        this.readyState = 'open'
        this.remoteAddress = __gea_node_net_remote_address(this.nativeId_)
        this.remotePort = __gea_node_net_remote_port(this.nativeId_)
        this.remoteFamily = __gea_node_net_remote_family(this.nativeId_)
        const localAddress = __gea_node_net_local_address(this.nativeId_)
        const localPort = __gea_node_net_local_port(this.nativeId_)
        const localFamily = __gea_node_net_local_family(this.nativeId_)
        this.localAddress = localAddress.length === 0 ? undefined : localAddress
        this.localPort = localPort === 0 ? undefined : localPort
        this.localFamily = localFamily.length === 0 ? undefined : localFamily
        this.autoSelectFamilyAttemptedAddresses = [`${this.remoteAddress}:${this.remotePort}`]
        this.bufferSize = __gea_node_net_buffer_size(this.nativeId_)
        this.resetTimeout()
        this.emit('connect')
      } else if (event === EVENT_DATA) {
        this.resetTimeout()
        const chunk = __gea_node_net_read(this.nativeId_)
        this.bytesRead += chunk.length
        if (this.paused_) this.pendingChunks_.push(chunk)
        else this.deliverChunk(chunk)
      } else if (event === EVENT_ERROR) {
        this.connecting = false
        this.pending = false
        const error = new Error(__gea_node_net_error(this.nativeId_))
        this.flushWriteCallbacks(error)
        this.emit('error', error)
      } else if (event === EVENT_CLOSE) {
        this.connecting = false
        this.pending = false
        this.destroyed = true
        this.readyState = 'closed'
        this.emitClose()
      } else if (event === EVENT_DRAIN) {
        this.bufferSize = __gea_node_net_buffer_size(this.nativeId_)
        this.flushWriteCallbacks()
      } else if (event === EVENT_FINISH) {
        this.bufferSize = 0
        this.flushWriteCallbacks()
        this.flushFinishCallbacks()
        this.emit('finish')
        if (this.destroyAfterFinish_) this.destroy()
      } else if (event === EVENT_END) {
        if (this.readyState !== 'readOnly') this.readyState = 'writeOnly'
        this.emit('end')
        if (!this.destroyed && this.readyState === 'writeOnly') this.end()
      }
    }
  }

  private connectTcp(
    host: string,
    port: number,
    family: number,
    hints: number,
    localAddress: string,
    localPort: number,
    bindLocal: boolean,
    connectionListener?: () => void
  ): this {
    if (this.nativeId_ !== 0 && !this.destroyed) {
      throw new Error('Socket is already connecting or connected')
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError('Port should be >= 0 and < 65536')
    }
    if (family !== 0 && family !== 4 && family !== 6) {
      throw new RangeError('family must be 0, 4, or 6')
    }
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      throw new RangeError('localPort should be >= 0 and < 65536')
    }
    if (connectionListener) this.once('connect', connectionListener)

    this.destroyed = false
    this.self_ = this
    this.closeEmitted_ = false
    this.connecting = true
    this.pending = true
    this.readyState = 'opening'
    this.nativeId_ = __gea_node_net_create(
      host,
      port,
      family,
      hints,
      localAddress,
      localPort,
      bindLocal,
      () => this.dispatchNativeEvents()
    )
    if (this.nativeId_ === 0) {
      this.connecting = false
      this.pending = false
      this.destroyed = true
      this.readyState = 'closed'
      const message = __gea_node_net_create_error()
      queueMicrotask(() => {
        this.emit('error', new Error(message.length === 0 ? 'Unable to create socket' : message))
        this.emitClose()
      })
      return this
    }
    this.setKeepAlive(this.constructorKeepAlive_, this.constructorKeepAliveInitialDelay_)
    this.setNoDelay(this.constructorNoDelay_)
    this.resetTimeout()
    return this
  }

  private connectTcpOptions(options: TcpSocketConnectOpts, listener?: () => void): this {
    if (options.lookup !== undefined) nodeNotImplemented('node:net', 'Socket.connect.lookup')
    if (options.autoSelectFamily === true) {
      nodeNotImplemented('node:net', 'Socket.connect.autoSelectFamily')
    }
    if (options.autoSelectFamilyAttemptTimeout !== undefined) {
      nodeNotImplemented('node:net', 'Socket.connect.autoSelectFamilyAttemptTimeout')
    }
    return this.connectTcp(
      options.host ?? 'localhost',
      options.port,
      options.family ?? 0,
      options.hints ?? 0,
      options.localAddress ?? '',
      options.localPort ?? 0,
      options.localAddress !== undefined || options.localPort !== undefined,
      listener
    )
  }
}

export class Server extends EventEmitter {
  private nativeId_: number
  private maxConnections_: number
  private address_: AddressInfo | null
  private allowHalfOpen_: boolean
  private pauseOnConnect_: boolean
  private noDelay_: boolean
  private keepAlive_: boolean
  private keepAliveInitialDelay_: number
  private self_: Server | null

  listening: boolean

  constructor(connectionListener?: ConnectionListener)
  constructor(options?: ServerOpts, connectionListener?: ConnectionListener)
  constructor(
    optionsOrListener: ServerOpts | ConnectionListener = {},
    connectionListener?: ConnectionListener
  ) {
    super()
    const options = typeof optionsOrListener === 'function' ? {} : optionsOrListener
    const listener =
      typeof optionsOrListener === 'function' ? optionsOrListener : connectionListener
    this.nativeId_ = 0
    this.listening = false
    this.maxConnections_ = 0
    this.address_ = null
    this.allowHalfOpen_ = options.allowHalfOpen ?? false
    this.pauseOnConnect_ = options.pauseOnConnect ?? false
    this.noDelay_ = options.noDelay ?? false
    this.keepAlive_ = options.keepAlive ?? false
    this.keepAliveInitialDelay_ = options.keepAliveInitialDelay ?? 0
    this.self_ = null
    if (this.allowHalfOpen_) nodeNotImplemented('node:net', 'Server.constructor.allowHalfOpen')
    if (options.highWaterMark !== undefined) {
      nodeNotImplemented('node:net', 'Server.constructor.highWaterMark')
    }
    if (listener) this.on('connection', listener)
  }

  override on(name: string, listener: EventHandler): this {
    super.on(name, listener)
    return this
  }

  override once(name: string, listener: EventHandler): this {
    super.once(name, listener)
    return this
  }

  override off(name: string, listener: EventHandler): this {
    super.off(name, listener)
    return this
  }

  override addListener(name: string, listener: EventHandler): this {
    super.addListener(name, listener)
    return this
  }

  override prependListener(name: string, listener: EventHandler): this {
    super.prependListener(name, listener)
    return this
  }

  override prependOnceListener(name: string, listener: EventHandler): this {
    super.prependOnceListener(name, listener)
    return this
  }

  override emit(name: string, ...args: unknown[]): boolean {
    return super.emit(name, ...args)
  }

  listen(
    port?: number,
    hostname?: string,
    backlog?: number,
    listeningListener?: () => void
  ): this
  listen(port?: number, hostname?: string, listeningListener?: () => void): this
  listen(port?: number, backlog?: number, listeningListener?: () => void): this
  listen(port?: number, listeningListener?: () => void): this
  listen(options: ListenOptions, listeningListener?: () => void): this
  listen(
    optionsOrPortOrPathOrListener: ListenOptions | number | string | (() => void) = 0,
    hostOrBacklogOrListener?: string | number | (() => void),
    backlogOrListener?: number | (() => void),
    listeningListener?: () => void
  ): this {
    if (this.nativeId_ !== 0 || this.listening) {
      const error = new Error('Listen method has been called more than once without closing') as NodeArgumentError
      error.code = 'ERR_SERVER_ALREADY_LISTEN'
      throw error
    }

    if (typeof optionsOrPortOrPathOrListener === 'string') {
      return nodeNotImplemented('node:net', 'Server.listen.path')
    }

    let port = 0
    let host = ''
    let backlog = 511
    let reusePort = false
    let ipv6Only = false
    let listener: (() => void) | undefined

    if (typeof optionsOrPortOrPathOrListener === 'object') {
      const options = optionsOrPortOrPathOrListener
      if (options.path !== undefined) nodeNotImplemented('node:net', 'Server.listen.path')
      if (options.signal !== undefined) nodeNotImplemented('node:net', 'Server.listen.signal')
      if (options.readableAll !== undefined || options.writableAll !== undefined) {
        nodeNotImplemented('node:net', 'Server.listen.pipePermissions')
      }
      port = options.port ?? 0
      host = options.host ?? ''
      backlog = options.backlog ?? 511
      reusePort = options.reusePort ?? false
      ipv6Only = options.ipv6Only ?? false
      listener = typeof hostOrBacklogOrListener === 'function' ? hostOrBacklogOrListener : undefined
    } else if (typeof optionsOrPortOrPathOrListener === 'function') {
      listener = optionsOrPortOrPathOrListener
    } else {
      port = optionsOrPortOrPathOrListener
      if (typeof hostOrBacklogOrListener === 'string') host = hostOrBacklogOrListener
      if (typeof hostOrBacklogOrListener === 'number') backlog = hostOrBacklogOrListener
      if (typeof backlogOrListener === 'number') backlog = backlogOrListener
      if (typeof hostOrBacklogOrListener === 'function') listener = hostOrBacklogOrListener
      if (typeof backlogOrListener === 'function') listener = backlogOrListener
      if (listeningListener) listener = listeningListener
    }

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError('Port should be >= 0 and < 65536')
    }
    if (!Number.isInteger(backlog) || backlog < 0) {
      throw new RangeError('backlog must be a non-negative integer')
    }
    if (listener) this.once('listening', listener)

    const detectedFamily = host.length === 0 ? 0 : isIP(host)
    const family = ipv6Only && detectedFamily === 0 ? 6 : detectedFamily
    this.self_ = this
    let createdId = 0
    createdId = __gea_node_net_server_listen(
      host,
      port,
      family,
      backlog,
      reusePort,
      ipv6Only,
      this.maxConnections_,
      () => this.dispatchNativeEvents()
    )
    if (createdId === 0) {
      const message = __gea_node_net_server_create_error()
      this.self_ = null
      queueMicrotask(() => {
        this.emit('error', new Error(message.length === 0 ? 'Unable to listen' : message))
      })
      return this
    }
    this.nativeId_ = createdId
    return this
  }

  close(callback?: (error?: Error) => void): this {
    if (this.nativeId_ === 0) {
      if (callback) {
        // Keep `error` declared as plain `Error` so it still lowers to
        // `gea::runtime::Error` where the `close` callback expects it; the
        // `NodeArgumentError` cast is only for the `.code` write.
        const error = new Error('Server is not running')
        ;(error as NodeArgumentError).code = 'ERR_SERVER_NOT_RUNNING'
        queueMicrotask(() => callback(error))
      }
      return this
    }
    if (callback) this.once('close', () => callback())
    __gea_node_net_server_close(this.nativeId_)
    this.listening = false
    this.address_ = null
    return this
  }

  address(): AddressInfo | null {
    return this.address_
  }

  getConnections(callback: (error: Error | null, count: number) => void): this {
    const count = this.connections
    queueMicrotask(() => callback(null, count))
    return this
  }

  ref(): this {
    if (this.nativeId_ !== 0) __gea_node_net_server_set_referenced(this.nativeId_, true)
    return this
  }

  unref(): this {
    if (this.nativeId_ !== 0) __gea_node_net_server_set_referenced(this.nativeId_, false)
    return this
  }

  [Symbol.asyncDispose](): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.nativeId_ === 0) {
        resolve()
        return
      }
      this.close(() => resolve())
    })
  }

  get maxConnections(): number {
    return this.maxConnections_
  }

  set maxConnections(value: number) {
    this.maxConnections_ = Math.max(0, value)
    if (this.nativeId_ !== 0) {
      __gea_node_net_server_set_max_connections(this.nativeId_, this.maxConnections_)
    }
  }

  get connections(): number {
    return this.nativeId_ === 0 ? 0 : __gea_node_net_server_connections(this.nativeId_)
  }

  private dispatchNativeEvents(): void {
    const nativeId = this.nativeId_
    if (nativeId === 0) return
    while (true) {
      const event = __gea_node_net_server_next_event(nativeId)
      if (event === 0) return
      if (event === SERVER_EVENT_LISTENING) {
        this.listening = true
        this.address_ = {
          address: __gea_node_net_server_address(nativeId),
          family: __gea_node_net_server_family(nativeId),
          port: __gea_node_net_server_port(nativeId)
        }
        this.emit('listening')
      } else if (event === SERVER_EVENT_CONNECTION) {
        const connectionId = __gea_node_net_server_take_connection(nativeId)
        if (connectionId !== 0) {
          const socket = new Socket({
            noDelay: this.noDelay_,
            keepAlive: this.keepAlive_,
            keepAliveInitialDelay: this.keepAliveInitialDelay_
          })
          socket.adoptAccepted(connectionId, this.pauseOnConnect_)
          this.emit('connection', socket)
        }
      } else if (event === SERVER_EVENT_ERROR) {
        this.emit('error', new Error(__gea_node_net_server_error(nativeId)))
      } else if (event === SERVER_EVENT_CLOSE) {
        this.listening = false
        this.address_ = null
        this.nativeId_ = 0
        this.emit('close')
        this.self_ = null
      } else if (event === SERVER_EVENT_DROP) {
        this.emit('drop')
      }
    }
  }
}

export function createServer(connectionListener?: ConnectionListener): Server
export function createServer(
  options?: ServerOpts,
  connectionListener?: ConnectionListener
): Server
export function createServer(
  optionsOrListener?: ServerOpts | ConnectionListener,
  connectionListener?: ConnectionListener
): Server {
  if (typeof optionsOrListener === 'function') return new Server(optionsOrListener)
  return new Server(optionsOrListener, connectionListener)
}

export function createConnection(options: NetConnectOpts, connectionListener?: () => void): Socket
export function createConnection(
  port: number,
  host?: string,
  connectionListener?: () => void
): Socket
export function createConnection(path: string, connectionListener?: () => void): Socket
export function createConnection(
  optionsOrPortOrPath: NetConnectOpts | number | string,
  hostOrListener?: string | (() => void),
  connectionListener?: () => void
): Socket {
  if (typeof optionsOrPortOrPath === 'object') {
    const socket = new Socket(optionsOrPortOrPath)
    const connected = socket.connect(
      optionsOrPortOrPath,
      typeof hostOrListener === 'function' ? hostOrListener : connectionListener
    )
    if (optionsOrPortOrPath.timeout !== undefined) {
      connected.setTimeout(optionsOrPortOrPath.timeout)
    }
    return connected
  }
  const socket = new Socket()
  if (typeof optionsOrPortOrPath === 'number' && typeof hostOrListener === 'string') {
    return socket.connect(optionsOrPortOrPath, hostOrListener, connectionListener)
  }
  if (typeof optionsOrPortOrPath === 'number') {
    if (typeof hostOrListener === 'function') {
      return socket.connect(optionsOrPortOrPath, hostOrListener)
    }
    if (connectionListener) return socket.connect(optionsOrPortOrPath, connectionListener)
    return socket.connect(optionsOrPortOrPath, undefined)
  }
  if (typeof hostOrListener === 'function') return socket.connect(optionsOrPortOrPath, hostOrListener)
  if (connectionListener) return socket.connect(optionsOrPortOrPath, connectionListener)
  return socket.connect(optionsOrPortOrPath, undefined)
}

export const connect = createConnection

export function getDefaultAutoSelectFamily(): boolean {
  return defaultAutoSelectFamily
}

export function setDefaultAutoSelectFamily(value: boolean): void {
  if (typeof value !== 'boolean') invalidArgumentType('value', 'boolean')
  defaultAutoSelectFamily = value
}

export function getDefaultAutoSelectFamilyAttemptTimeout(): number {
  return defaultAutoSelectFamilyAttemptTimeout
}

export function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void {
  if (typeof value !== 'number') invalidArgumentType('value', 'number')
  if (!Number.isInteger(value)) outOfRange('value', 'an integer')
  if (value < 1 || value > 2147483647) outOfRange('value', '>= 1 && <= 2147483647')
  defaultAutoSelectFamilyAttemptTimeout = Math.max(10, value)
}

export class SocketAddress {
  readonly address: string
  readonly family: IPVersion
  readonly port: number
  readonly flowlabel: number

  constructor(options: SocketAddressInitOptions = {}) {
    const requestedFamily = options.family ?? 'ipv4'
    let familyNumber = 0
    if (requestedFamily === 'ipv4') familyNumber = 4
    else if (requestedFamily.toLowerCase() === 'ipv6') familyNumber = 6
    else {
      const error = new TypeError(`The property 'options.family' is invalid.`) as NodeArgumentError
      error.code = 'ERR_INVALID_ARG_VALUE'
      throw error
    }

    const sourceAddress = options.address ?? (familyNumber === 4 ? '127.0.0.1' : '::')
    const normalizedAddress = __gea_node_net_normalize_ip(sourceAddress, familyNumber)
    if (normalizedAddress.length === 0) {
      const error = new Error('Invalid socket address') as NodeArgumentError
      error.code = 'ERR_INVALID_ADDRESS'
      throw error
    }

    const port = options.port ?? 0
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      const error = new RangeError('options.port should be >= 0 and < 65536.') as NodeArgumentError
      error.code = 'ERR_SOCKET_BAD_PORT'
      throw error
    }

    const flowlabel = options.flowlabel ?? 0
    if (typeof flowlabel !== 'number') invalidArgumentType('options.flowlabel', 'number')
    if (!Number.isInteger(flowlabel)) outOfRange('options.flowlabel', 'an integer')
    if (flowlabel < 0 || flowlabel > 1048575) {
      outOfRange('options.flowlabel', '>= 0 && <= 1048575')
    }

    this.address = normalizedAddress
    this.family = familyNumber === 4 ? 'ipv4' : 'ipv6'
    this.port = port
    this.flowlabel = familyNumber === 6 ? flowlabel : 0
  }

  static parse(input: string): SocketAddress | undefined {
    if (typeof input !== 'string') invalidArgumentType('input', 'string')
    let address = input
    let portText = ''
    let family: IPVersion = 'ipv4'

    if (input.startsWith('[')) {
      const close = input.indexOf(']')
      if (close < 0) return undefined
      address = input.slice(1, close)
      const suffix = input.slice(close + 1)
      if (suffix.length > 0 && !suffix.startsWith(':')) return undefined
      portText = suffix.length > 0 ? suffix.slice(1) : ''
      family = 'ipv6'
    } else {
      const colon = input.indexOf(':')
      if (colon >= 0) {
        if (input.indexOf(':', colon + 1) >= 0) return undefined
        address = input.slice(0, colon)
        portText = input.slice(colon + 1)
      }
    }

    let port = 0
    if (portText.length > 0) {
      for (let index = 0; index < portText.length; index += 1) {
        const character = portText.charCodeAt(index)
        if (character < 48 || character > 57) return undefined
      }
      port = Number(portText)
      if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
      // Node 24.8's parser currently maps the exact decimal service port 80
      // to its default value. Preserve the pinned runtime's observable result.
      if (port === 80) port = 0
    }

    if (__gea_node_net_normalize_ip(address, family === 'ipv4' ? 4 : 6).length === 0) {
      return undefined
    }
    return new SocketAddress({ address, family, port })
  }
}

export class BlockList {
  private addressValues_: string[] = []
  private addressFamilies_: number[] = []
  private rangeStarts_: string[] = []
  private rangeEnds_: string[] = []
  private rangeFamilies_: number[] = []
  private subnetNetworks_: string[] = []
  private subnetPrefixes_: number[] = []
  private subnetFamilies_: number[] = []
  private ruleStrings_: string[] = []
  rules: readonly string[] = []

  addAddress(address: string, type?: IPVersion): void
  addAddress(address: SocketAddress): void
  addAddress(address: string | SocketAddress, type: IPVersion = 'ipv4'): void {
    const parsed = this.asSocketAddress(address, type)
    const family = parsed.family === 'ipv4' ? 4 : 6
    this.addressValues_.unshift(parsed.address)
    this.addressFamilies_.unshift(family)
    this.ruleStrings_.unshift(`Address: IPv${family} ${parsed.address}`)
    this.refreshRules()
  }

  addRange(start: string, end: string, type?: IPVersion): void
  addRange(start: SocketAddress, end: SocketAddress): void
  addRange(
    start: string | SocketAddress,
    end: string | SocketAddress,
    type: IPVersion = 'ipv4'
  ): void {
    const parsedStart = this.asSocketAddress(start, type)
    const parsedEnd = this.asSocketAddress(end, type)
    const startFamily = parsedStart.family === 'ipv4' ? 4 : 6
    const endFamily = parsedEnd.family === 'ipv4' ? 4 : 6
    if (
      startFamily !== endFamily ||
      __gea_node_net_ip_compare(parsedStart.address, startFamily, parsedEnd.address, endFamily) > 0
    ) {
      const error = new TypeError("The argument 'start' must come before end.") as NodeArgumentError
      error.code = 'ERR_INVALID_ARG_VALUE'
      throw error
    }
    this.rangeStarts_.unshift(parsedStart.address)
    this.rangeEnds_.unshift(parsedEnd.address)
    this.rangeFamilies_.unshift(startFamily)
    this.ruleStrings_.unshift(`Range: IPv${startFamily} ${parsedStart.address}-${parsedEnd.address}`)
    this.refreshRules()
  }

  addSubnet(network: SocketAddress, prefix: number): void
  addSubnet(network: string, prefix: number, type?: IPVersion): void
  addSubnet(
    network: string | SocketAddress,
    prefix: number,
    type: IPVersion = 'ipv4'
  ): void {
    const parsed = this.asSocketAddress(network, type)
    const family = parsed.family === 'ipv4' ? 4 : 6
    const maximum = family === 4 ? 32 : 128
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      outOfRange('prefix', `>= 0 && <= ${maximum}`)
    }
    this.subnetNetworks_.unshift(parsed.address)
    this.subnetPrefixes_.unshift(prefix)
    this.subnetFamilies_.unshift(family)
    this.ruleStrings_.unshift(`Subnet: IPv${family} ${parsed.address}/${prefix}`)
    this.refreshRules()
  }

  check(address: SocketAddress): boolean
  check(address: string, type?: IPVersion): boolean
  check(address: string | SocketAddress, type: IPVersion = 'ipv4'): boolean {
    const parsed = this.asSocketAddress(address, type)
    const family = parsed.family === 'ipv4' ? 4 : 6
    for (let index = 0; index < this.addressValues_.length; index += 1) {
      if (
        __gea_node_net_ip_compare(
          parsed.address,
          family,
          this.addressValues_[index],
          this.addressFamilies_[index]
        ) === 0
      ) {
        return true
      }
    }
    for (let index = 0; index < this.rangeStarts_.length; index += 1) {
      const ruleFamily = this.rangeFamilies_[index]
      if (
        __gea_node_net_ip_compare(parsed.address, family, this.rangeStarts_[index], ruleFamily) >= 0 &&
        __gea_node_net_ip_compare(parsed.address, family, this.rangeEnds_[index], ruleFamily) <= 0
      ) {
        return true
      }
    }
    for (let index = 0; index < this.subnetNetworks_.length; index += 1) {
      if (
        __gea_node_net_ip_in_subnet(
          parsed.address,
          family,
          this.subnetNetworks_[index],
          this.subnetFamilies_[index],
          this.subnetPrefixes_[index]
        )
      ) {
        return true
      }
    }
    return false
  }

  static isBlockList(value: unknown): value is BlockList {
    return value instanceof BlockList
  }

  fromJSON(data: string | readonly string[]): void {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    if (!Array.isArray(parsed)) invalidArgumentType('data', 'an array or JSON array string')
    for (let index = 0; index < parsed.length; index += 1) {
      const rule = parsed[index]
      if (typeof rule !== 'string') invalidArgumentType('data', 'an array of strings')
      this.addSerializedRule(rule)
    }
  }

  toJSON(): readonly string[] {
    const result: string[] = []
    for (let index = 0; index < this.ruleStrings_.length; index += 1) {
      result.push(this.ruleStrings_[index])
    }
    return result
  }

  private asSocketAddress(address: string | SocketAddress, type: IPVersion): SocketAddress {
    if (typeof address !== 'string') return address
    return new SocketAddress({ address, family: type })
  }

  private refreshRules(): void {
    this.rules = this.toJSON()
  }

  private addSerializedRule(rule: string): void {
    for (const family of ['ipv4', 'ipv6'] as const) {
      const label = family === 'ipv4' ? 'IPv4' : 'IPv6'
      const addressPrefix = `Address: ${label} `
      const rangePrefix = `Range: ${label} `
      const subnetPrefix = `Subnet: ${label} `
      if (rule.startsWith(addressPrefix)) {
        this.addAddress(rule.slice(addressPrefix.length), family)
        return
      }
      if (rule.startsWith(rangePrefix)) {
        const value = rule.slice(rangePrefix.length)
        const separator = value.indexOf('-')
        if (separator > 0) {
          this.addRange(value.slice(0, separator), value.slice(separator + 1), family)
          return
        }
      }
      if (rule.startsWith(subnetPrefix)) {
        const value = rule.slice(subnetPrefix.length)
        const separator = value.lastIndexOf('/')
        if (separator > 0) {
          this.addSubnet(value.slice(0, separator), Number(value.slice(separator + 1)), family)
          return
        }
      }
    }
    const error = new TypeError('Invalid BlockList rule') as NodeArgumentError
    error.code = 'ERR_INVALID_ARG_VALUE'
    throw error
  }
}

export function isIP(input: string): number {
  return __gea_node_net_is_ip(input)
}

export function isIPv4(input: string): boolean {
  return __gea_node_net_is_ip(input) === 4
}

export function isIPv6(input: string): boolean {
  return __gea_node_net_is_ip(input) === 6
}
