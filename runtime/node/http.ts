// geatsc-compiled `node:http` — a real subset of Node's http module running on
// the native reactor (runtime/gea_node.cpp).
//
// The C++ layer parses full HTTP/1.x requests (request line, headers,
// content-length and chunked bodies, size limits, 100-continue) and dispatches
// each one with a connection id. Responses stream back through per-connection
// intrinsics (`__gea_http_write` / `__gea_http_done`), so handlers can be
// synchronous, async, or long-lived (chunked streaming). Keep-alive and
// pipelining ordering are enforced by the reactor: the next pipelined request
// on a connection is not dispatched until the previous response is done.
//
// Response serialization matches Node's observable behavior (verified
// byte-for-byte by apps/http-parity): app headers in insertion order, then
// Date / Connection / Keep-Alive, then the auto framing header; `writeHead`
// commits the header block (so the body streams chunked unless the app set
// Content-Length); a plain `end(body)` without writeHead emits an exact
// Content-Length; HTTP/1.0 without a known length falls back to
// close-delimited; 1xx/204/304 and HEAD suppress the body.
//
// Known deviations (documented, not silent): request `set-cookie` duplicates
// join with ", " instead of becoming an array (headers stays a string→string
// map); `getHeader` returns multi-value headers joined with ", ";
// `writeHead(status, message, headers)` 3-arg form is not supported — set
// `res.statusMessage` instead; chunk trailers are parsed and discarded;
// body chunks are byte-preserving strings, not Buffers; `res.req` is not
// provided (the request is in scope wherever the response is); req/res
// listeners compile to NATIVE closures with no JS function identity, so
// `removeListener(name, fn)` on them cannot match — use
// `removeAllListeners(name)`.

import { EventEmitter, EventHandler, EventName } from './events'
import { Buffer, BufferEncoding } from './buffer-types'
import { nodeNotImplemented } from './not-implemented'
import { DestroyCallback, Duplex, Readable, StreamCallback, Writable } from './stream'
import { Socket as NetSocket } from './net'

// The narrower contract (see `net.ts` for the argument). `serve` stores the
// dispatch handler; `done` reaches `responseComplete` -> `processInput`, which
// runs the program's own handler for the next pipelined request; `destroy` and
// `stop` tear C++ state down. Running program code is permitted here and
// forbidden by `@gea-host-inert`, which is why these four carry this tag and
// not that one -- none of them writes a property on any JavaScript object.
/** @gea-host-no-property-writes */
declare function __gea_http_serve(
  port: number,
  onRequest: (connId: number, flags: number, method: string, url: string, httpVersion: string, rawHead: string, body: string) => void
): void
// `@gea-host-inert` is the per-declaration host effect contract (compiler
// `src/semantics/normalize/host-effect-contracts.ts`). `write`/`write_bytes`
// copy their payload into the connection's own buffer (`enqueueResponseBytes`
// builds a `std::string` from the bytes) and `peer`/`date` only read, so none
// retains an argument or runs program code. `done` and `destroy` are NOT
// tagged and must not be: `responseComplete` calls `processInput()`, which
// dispatches the next pipelined request into the program's own `onRequest`
// closure -- program code, inside the call. `serve` takes that closure, and
// `stop` runs the listener closer.
/** @gea-host-inert */
declare function __gea_http_write(connId: number, data: string): void
// Octets rather than text, for a `Uint8Array`/`Buffer` body: a TypeScript
// `string` cannot carry arbitrary bytes across this boundary intact. See the
// definition in `runtime/gea_node.cpp` for why both calls exist.
/** @gea-host-inert */
declare function __gea_http_write_bytes(connId: number, data: Uint8Array): void
// The inbound direction: the reactor's request body string as its own octets.
// `Buffer.from(body)` would decode it as UTF-8 and replace every invalid byte.
/** @gea-host-inert */
declare function __gea_http_body_bytes(body: string): Buffer
/** @gea-host-no-property-writes */
declare function __gea_http_done(connId: number, keepAlive: boolean): void
/** @gea-host-no-property-writes */
declare function __gea_http_destroy(connId: number): void
/** @gea-host-inert */
declare function __gea_http_peer(connId: number): string
/** @gea-host-inert */
declare function __gea_http_date(): string
/** @gea-host-no-property-writes */
declare function __gea_http_stop(): void

// Dispatch flags from the reactor (keep in sync with gea_node.cpp).
const FLAG_KEEP_ALIVE = 1
const FLAG_FIRST_ON_CONNECTION = 2

// NOTE: deliberately NOT named `METHODS`: geatsc keys module-level globals by
// bare name and hono's router exports its own `METHODS` const. The compiler
// now REJECTS such collisions at compile time (rename this back to see the
// diagnostic); classes got full symbol-based disambiguation, globals keep the
// loud error until they get the same. `http.METHODS` is available via the
// default export.
export const httpMethods: string[] = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE'
]

export const STATUS_CODES: { [code: string]: string } = {
  '100': 'Continue',
  '101': 'Switching Protocols',
  '102': 'Processing',
  '103': 'Early Hints',
  '200': 'OK',
  '201': 'Created',
  '202': 'Accepted',
  '203': 'Non-Authoritative Information',
  '204': 'No Content',
  '205': 'Reset Content',
  '206': 'Partial Content',
  '207': 'Multi-Status',
  '208': 'Already Reported',
  '226': 'IM Used',
  '300': 'Multiple Choices',
  '301': 'Moved Permanently',
  '302': 'Found',
  '303': 'See Other',
  '304': 'Not Modified',
  '305': 'Use Proxy',
  '307': 'Temporary Redirect',
  '308': 'Permanent Redirect',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '402': 'Payment Required',
  '403': 'Forbidden',
  '404': 'Not Found',
  '405': 'Method Not Allowed',
  '406': 'Not Acceptable',
  '407': 'Proxy Authentication Required',
  '408': 'Request Timeout',
  '409': 'Conflict',
  '410': 'Gone',
  '411': 'Length Required',
  '412': 'Precondition Failed',
  '413': 'Payload Too Large',
  '414': 'URI Too Long',
  '415': 'Unsupported Media Type',
  '416': 'Range Not Satisfiable',
  '417': 'Expectation Failed',
  '418': "I'm a Teapot",
  '421': 'Misdirected Request',
  '422': 'Unprocessable Entity',
  '423': 'Locked',
  '424': 'Failed Dependency',
  '425': 'Too Early',
  '426': 'Upgrade Required',
  '428': 'Precondition Required',
  '429': 'Too Many Requests',
  '431': 'Request Header Fields Too Large',
  '451': 'Unavailable For Legal Reasons',
  '500': 'Internal Server Error',
  '501': 'Not Implemented',
  '502': 'Bad Gateway',
  '503': 'Service Unavailable',
  '504': 'Gateway Timeout',
  '505': 'HTTP Version Not Supported',
  '506': 'Variant Also Negotiates',
  '507': 'Insufficient Storage',
  '508': 'Loop Detected',
  '509': 'Bandwidth Limit Exceeded',
  '510': 'Not Extended',
  '511': 'Network Authentication Required'
}

export function statusText(code: number): string {
  // Fast path for the overwhelmingly common codes — the map lookup below is a
  // String(code) allocation plus a linear scan of ~60 entries per response.
  if (code === 200) return 'OK'
  if (code === 404) return 'Not Found'
  if (code === 204) return 'No Content'
  if (code === 500) return 'Internal Server Error'
  const text = STATUS_CODES[String(code)]
  if (text === undefined || text === '') return 'unknown'
  return text
}

// Node joins duplicate request headers per header semantics: singleton headers
// keep the FIRST value, `cookie` joins with "; ", everything else with ", ".
function isSingletonHeader(lower: string): boolean {
  return (
    lower === 'age' ||
    lower === 'authorization' ||
    lower === 'content-length' ||
    lower === 'content-type' ||
    lower === 'etag' ||
    lower === 'expires' ||
    lower === 'from' ||
    lower === 'host' ||
    lower === 'if-modified-since' ||
    lower === 'if-unmodified-since' ||
    lower === 'last-modified' ||
    lower === 'location' ||
    lower === 'max-forwards' ||
    lower === 'proxy-authorization' ||
    lower === 'referer' ||
    lower === 'retry-after' ||
    lower === 'server' ||
    lower === 'user-agent'
  )
}

// This used to be a second, unrelated implementation of Node's `net.Socket` -- a disconnected
// class with its own private fields, never sharing so much as a common ancestor with net.ts's
// real `Socket` (which tls.ts's `TLSSocket` correctly extends). Two Socket classes standing in
// for one Node type is exactly the kind of two-authorities defect this codebase avoids elsewhere:
// hono's `request.ts` does `(incoming.socket as TLSSocket).encrypted` (a plain duck-typed check
// for HTTPS), and TypeScript refuses that cast unless the source is a real super/subtype of
// TLSSocket. Extending net.ts's Socket instead of inventing a third shape fixes the cast without
// touching net.ts or tls.ts.
//
// net.Socket's own constructor and its TCP-specific methods (connect/write/pipe/setNoDelay/...)
// are never invoked here: this class only ever wraps a connId from the HTTP reactor, never a
// native TCP connection, so the inherited `nativeId_` stays 0 for the lifetime of the instance
// and every method that guards on it (`write`, `pause`, `setNoDelay`, ...) is simply inert, not
// live behaviour. `destroy()`/`destroySoon()` are overridden because the inherited ones talk to
// the wrong reactor (`__gea_node_net_destroy` on a `nativeId_` that is always 0 here, instead of
// `__gea_http_destroy` on the real `connId_`).
export class Socket extends NetSocket {
  private connId_: number
  // The HTTP reactor serves plaintext only. `@hono/node-server` reads this
  // through a `TLSSocket` cast to pick the URL scheme; a plain Node socket has
  // no such property, which reads the same falsy way.
  readonly encrypted: boolean = false

  constructor(connId: number = 0) {
    super()
    this.connId_ = connId
    this.remoteFamily = 'IPv4'
    this.loadPeer()
  }

  // Not lazy any more (it was, via a private remoteAddress_/remotePort_ pair, before this class
  // extended net.Socket): TypeScript will not let a subclass override a plain inherited property
  // with an accessor pair (TS2611/TS2855), so remoteAddress/remotePort now come straight from
  // net.Socket's own writable fields, populated once, eagerly, right here. Guarded on connId_ !==
  // 0 so the module-load-time placeholder socket (connId 0, see below) never calls into the
  // reactor for a connection that was never accepted. This is scoped by the same laziness the
  // getter used to add on top of: `IncomingMessage.socket` only constructs a Socket at all when
  // the app reads `.socket`, so the peer syscall still isn't paid by requests that never touch it.
  private loadPeer(): void {
    if (this.connId_ === 0) return
    const peer = __gea_http_peer(this.connId_)
    const space = peer.indexOf(' ')
    if (space >= 0) {
      this.remoteAddress = peer.substring(0, space)
      this.remotePort = Number(peer.substring(space + 1))
    }
  }

  // Real destroySoon waits for pending writes to flush before closing. This handle never
  // buffers writes of its own (ServerResponse writes straight to the reactor via
  // __gea_http_write, bypassing Socket entirely), so there is nothing to wait for -- an
  // immediate destroy is the honest equivalent.
  override destroySoon(): void {
    this.destroy()
  }

  override destroy(): this {
    if (this.destroyed) return this
    this.destroyed = true
    __gea_http_destroy(this.connId_)
    return this
  }
}

// Shared placeholder: ServerResponse's socket slot is overwritten with the
// request's socket right after construction (Node shares ONE socket object
// between req and res), so constructing a fresh Socket per response would be
// a wasted allocation.
const placeholderSocket = new Socket(0)

// Body/lifecycle listeners are stored as TYPED native closures — a
// `(chunk: string) => void` slot covers 'data' (one string arg) and the
// no-arg 'end'/'close' listeners (an arrow with fewer params adapts, exactly
// like JS). No gea_cpp_value boxing anywhere in listener storage or dispatch.
export type MessageListener = (chunk: string) => void

export type ClientRequestErrorListener = (error: Error) => void
export type ClientResponseListener = (response: IncomingMessage) => void

export type OutgoingHttpHeader = string | number | boolean | readonly string[]

// Same shape Node ships: an arbitrary header bag keyed by name, values
// widened past plain strings (numbers for things like Content-Length,
// arrays for repeated headers such as set-cookie). `writeHead` accepts this
// directly and funnels every value through `setHeader`, which already knows
// how to serialize each of these shapes.
export interface OutgoingHttpHeaders {
  [name: string]: OutgoingHttpHeader | undefined
}

export interface RequestOptions {
  headers?: { [name: string]: OutgoingHttpHeader | undefined }
  host?: string
  hostname?: string
  method?: string
  path?: string
  port?: number | string
  protocol?: string
  timeout?: number
}

// `IncomingMessage` used to keep its own hand-rolled body_/bodyPending_/paused_/endEmitted_/
// destroyed_/errored_/encoding_/didRead_ state, driven entirely off EventEmitter with a custom
// deliverBody() -- a private, parallel reimplementation of exactly what stream.ts's Readable
// already does (a pending-chunk queue, pause/resume, push/read, readable*/destroyed/errored). It
// only existed because IncomingMessage did not extend Readable. Now that it does (see the
// `extends Readable` below, and the "Writable extends Stream" comment on stream.ts for the
// hierarchy change that made this possible without paying for the writable side too),
// IncomingMessage drives Readable's own storage: the whole body arrives from the reactor in one
// shot, so it is `push()`ed in full in the constructor, and consumption goes through Readable's
// real push/read/pause/resume/destroy machinery instead of a duplicate.
export class IncomingMessage extends Readable {
  method: string
  url: string
  statusCode?: number
  httpVersion: string
  httpVersionMajor: number
  httpVersionMinor: number
  complete: boolean
  // Not a Node property but a widely honoured adapter convention: a body
  // parser that has already drained the request stashes the raw bytes here,
  // and `@hono/node-server`'s `request.ts` re-reads them (`'rawBody' in
  // incoming && incoming.rawBody instanceof Buffer`) inside a ReadableStream
  // `start` callback. TypeScript drops an `instanceof` narrowing of a
  // property path once it crosses into a callback, so with the field
  // undeclared that read is `unknown` there and `controller.enqueue` refuses
  // it (TS2345); declared, it is `Buffer | undefined` everywhere and the
  // optional `enqueue(chunk?: Uint8Array)` takes it as written. Nothing this
  // target ships assigns it.
  rawBody?: Buffer

  private connId_: number
  private socket_: Socket | undefined
  private headersMap_: { [name: string]: string } | undefined
  private rawHead_: string
  private rawHeaders_: string[] | undefined
  // Dedupes the deferred-resume microtask newListenerAdded schedules below -- 'data' and 'end'
  // listeners attached in the same synchronous turn (the common case) should drain once, not twice.
  private deliveryScheduled_: boolean

  constructor(connId: number, method: string, url: string, httpVersion: string, rawHead: string, body: string) {
    super()
    this.connId_ = connId
    this.method = method
    this.url = url
    this.statusCode = undefined
    // The wire form is "HTTP/1.1"; Node exposes "1.1".
    this.httpVersion = httpVersion === 'HTTP/1.0' ? '1.0' : httpVersion === 'HTTP/1.1' ? '1.1' : httpVersion
    this.httpVersionMajor = 1
    this.httpVersionMinor = this.httpVersion === '1.0' ? 0 : 1
    this.socket_ = undefined
    this.headersMap_ = undefined
    this.rawHead_ = rawHead
    this.rawHeaders_ = undefined
    this.deliveryScheduled_ = false
    // Node's `complete` means "the parser has seen the whole message", not
    // "the app has drained it": for a body-less GET it is already true inside
    // the 'request' listener. The reactor only dispatches once the full body is
    // in hand, so it is true from construction here too. This used to be set
    // from a `once('end')` closure, which cost every request a boxed listener,
    // three entry arrays, the 'newListener'/'removeListener' dispatches and a
    // splice -- for a flag the constructor already knows.
    this.complete = true
    if (body.length > 0) this.push(body)
    this.push(null)
  }

  // Typed as `net.Socket` (the real Node return type for `IncomingMessage.socket`), not the
  // concrete `Socket` subclass constructed below. hono's `request.ts` does
  // `(incoming.socket as TLSSocket).encrypted`: TLSSocket extends net.Socket directly, so casting
  // from the WIDER net.Socket type is a plain, valid downcast. Casting from the narrower `Socket`
  // subclass declared in this file would not be (it carries its own private `connId_` that
  // TLSSocket does not, which breaks the structural comparability TypeScript needs for the
  // assertion) -- this is why the getter's declared return type matters here, not just the
  // runtime value.
  get socket(): NetSocket {
    let socket = this.socket_
    if (socket === undefined) {
      socket = new Socket(this.connId_)
      this.socket_ = socket
    }
    return socket
  }

  // Lazy: the reactor hands over the raw header block as ONE buffer; the
  // alternating [name, value, ...] array only materializes if the app reads
  // it. Trimming rules mirror the reactor's parse (OWS around values).
  get rawHeaders(): string[] {
    let rawHeaders = this.rawHeaders_
    if (rawHeaders === undefined) {
      rawHeaders = []
      const head = this.rawHead_
      let pos = 0
      while (pos < head.length) {
        let eol = head.indexOf('\r\n', pos)
        if (eol < 0) eol = head.length
        const line = head.substring(pos, eol)
        pos = eol + 2
        if (line.length === 0) continue
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        let valueStart = colon + 1
        while (valueStart < line.length && (line[valueStart] === ' ' || line[valueStart] === '\t')) valueStart++
        let valueEnd = line.length
        while (valueEnd > valueStart && (line[valueEnd - 1] === ' ' || line[valueEnd - 1] === '\t')) valueEnd--
        rawHeaders.push(line.substring(0, colon))
        rawHeaders.push(line.substring(valueStart, valueEnd))
      }
      this.rawHeaders_ = rawHeaders
    }
    return rawHeaders
  }

  // Lazy joined headers — built on first access so requests that never read
  // `headers` (the common hot path) pay nothing.
  get headers(): { [name: string]: string } {
    let headers = this.headersMap_
    if (headers === undefined) {
      headers = {}
      const raw = this.rawHeaders
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const lower = raw[i].toLowerCase()
        const value = raw[i + 1]
        if (!headers.hasOwnProperty(lower)) {
          headers[lower] = value
        } else if (!isSingletonHeader(lower)) {
          headers[lower] = headers[lower] + (lower === 'cookie' ? '; ' : ', ') + value
        }
      }
      this.headersMap_ = headers
    }
    return headers
  }

  // Readable's own `newListenerAdded` resumes (synchronously) the instant a 'data' listener is
  // added, draining whatever is already pushed. That is exactly right for a stream that fills up
  // over time, but this reactor hands the WHOLE body to the constructor before the request
  // handler ever runs, so a synchronously-attached 'data' listener would drain immediately inside
  // the very `.on('data', ...)` call -- before the handler has had its full synchronous turn to
  // attach every listener it means to (e.g. 'end' right after 'data'). Deferring one microtask
  // (deduped via deliveryScheduled_ so 'data' and 'end' attached in the same tick only schedule
  // once) reproduces Node's actual contract: listener registration is synchronous, delivery is
  // not. This intentionally does NOT call `super.newListenerAdded` -- Readable's synchronous
  // resume is exactly the behaviour being replaced. An 'end'-only listener (no 'data') still
  // triggers delivery here, matching this runtime's documented deviation from strict Node
  // semantics (a real un-flowing, un-resumed Readable with only an 'end' listener never fires it).
  protected override newListenerAdded(name: string): void {
    if ((name !== 'data' && name !== 'end') || this.deliveryScheduled_ || this.readableFlowing === true) return
    this.deliveryScheduled_ = true
    const self = this
    queueMicrotask(() => {
      self.deliveryScheduled_ = false
      if (self.readableFlowing !== false) self.resume()
    })
  }

  /**
   * Native server requests arrive from the reactor with their complete body. This narrow bridge
   * lets compiled adapters consume that body without manufacturing a pending JavaScript Promise
   * around EventEmitter callbacks. `super.read()` (Readable's real, synchronous read) already
   * does exactly that; this only normalizes the empty case to `''` instead of `null` and widens
   * the return type to plain `string` (see `read()` below for why a public `.read()` call wraps
   * bytes in a Buffer instead -- this bridge is for compiled adapters that already know they want
   * text).
   */
  readBody(): string {
    // `Readable.read` hands the drained chunk through `emittedChunk`, which
    // this class overrides to wrap the stored byte-string in a Buffer whenever
    // no encoding was set -- so the chunk arriving here is a Buffer, not the
    // string Readable stores. Unwrapped through the same byte-preserving
    // mapping (`latin1`: one char per octet) the reactor stored it in.
    const chunk: unknown = super.read(0)
    if (typeof chunk === 'string') return chunk
    return Buffer.isBuffer(chunk) ? chunk.toString('latin1') : ''
  }

  /** `readBody()` as the octets the client sent, for binary bodies (multipart files). */
  readBodyBytes(): Buffer {
    const chunk: unknown = super.read(0)
    if (Buffer.isBuffer(chunk)) return chunk
    return __gea_http_body_bytes(typeof chunk === 'string' ? chunk : '')
  }

  // Node's Readable#read(): pull whatever is buffered and unread, as a Buffer unless setEncoding
  // was called (real Node hands out Buffers by default and strings once an encoding is set).
  // Readable's own storage always holds this reactor's body as a plain string (byte-preserving,
  // not a Buffer -- see this file's header comment), so the Buffer-wrapping has to happen here,
  // one layer up, rather than in stream.ts's generic `emittedChunk`. This target hands over the
  // whole body up front (no partial/streamed reads from the reactor), so `size` has nothing to
  // act on -- every call drains whatever remains in one shot, same as a `size` larger than the
  // buffer would in real Node.
  override read(size: number = 0): Buffer | string | null {
    const chunk: unknown = super.read(size)
    if (chunk === null) return null
    return this.readableEncoding === null ? __gea_http_body_bytes(chunk as string) : (chunk as string)
  }

  // Node's 'data' hands out Buffers unless setEncoding was called; the stored
  // reactor string is wrapped for the same reason `read()` wraps it.
  // `Readable.toWeb` and @hono/node-server's body reader both expect bytes.
  protected override emittedChunk(chunk: unknown): unknown {
    const emitted = super.emittedChunk(chunk)
    return this.readableEncoding === null && typeof emitted === 'string' ? __gea_http_body_bytes(emitted) : emitted
  }

  override _destroy(error: Error | null, callback: DestroyCallback): void {
    __gea_http_destroy(this.connId_)
    // Mirrors the original behaviour: destroying a request owes listeners their 'close' off the
    // dispatch stack, not synchronously inside destroy().
    queueMicrotask(() => callback(error))
  }
}

// Response lifecycle listeners ('finish', 'close') take no arguments — a
// typed no-arg closure slot, no boxing.
export type ResponseListener = () => void

// Extends Writable (not EventEmitter) so this is assignable everywhere `@hono/node-server`
// types a response as `Writable` -- see the "Writable extends Stream" comment on stream.ts for
// the hierarchy change that made this cheap: ServerResponse now carries Writable's own field set
// (writable/writableAborted/writableCorked/writableHighWaterMark/writableLength/writableNeedDrain/
// writableObjectMode/destroyed/closed/errored, plus a small unused write-queue for corking), not
// Readable's, since Writable no longer drags Readable's ~20 fields along for the ride.
//
// write()/end()/destroy() below stay ServerResponse's OWN implementations rather than routing
// through Writable's generic performWrite/_write plumbing: they drive HTTP framing byte-for-byte
// (chunked-encoding hex prefixes, Content-Length auto-computation, HEAD/1xx/204/304 body
// suppression, keep-alive headers) verified elsewhere in this repo to match Node exactly, and
// write straight to the reactor (`__gea_http_write`/`__gea_http_write_bytes`) with no intermediate
// queue. Re-deriving all of that from `_write`/`_final` hooks would be a much larger, riskier
// rewrite of code with a byte-for-byte parity requirement, for no behavioural gain -- Writable's
// own `_write`/`_writev`/`_final`/`_destroy` defaults are simply never called here. `destroyed`,
// `closed` and `errored` are Writable's real fields now (no more private `destroyed_` shadow).
export class ServerResponse extends Writable {
  statusCode: number
  statusMessage: string
  sendDate: boolean
  finished: boolean

  private connId_: number
  private request_: IncomingMessage | undefined
  private isHead_: boolean
  private http10_: boolean
  private keepAliveRequested_: boolean
  private headersCommitted_: boolean // header block serialized (writeHead / first write)
  private headWritten_: boolean // header bytes handed to the reactor
  private pendingHead_: string
  private chunked_: boolean
  private suppressBody_: boolean // HEAD / 1xx / 204 / 304
  private keepAliveFinal_: boolean
  private firstHeaderPresent_: boolean
  private firstHeaderName_: string
  private firstHeaderValue_: string
  private firstHeaderLine_: string
  private extraHeaderNames_: string[] | undefined
  private extraHeaderValues_: string[] | undefined
  private extraHeaderLines_: string[] | undefined

  constructor(connId: number, isHead: boolean, keepAliveRequested: boolean, http10: boolean, request: IncomingMessage) {
    super()
    this.connId_ = connId
    this.request_ = request
    this.isHead_ = isHead
    this.http10_ = http10
    this.keepAliveRequested_ = keepAliveRequested
    this.statusCode = 200
    this.statusMessage = ''
    this.sendDate = true
    this.finished = false
    this.headersCommitted_ = false
    this.headWritten_ = false
    this.pendingHead_ = ''
    this.chunked_ = false
    this.suppressBody_ = false
    this.keepAliveFinal_ = keepAliveRequested
    this.firstHeaderPresent_ = false
    this.firstHeaderName_ = ''
    this.firstHeaderValue_ = ''
    this.firstHeaderLine_ = ''
    this.extraHeaderNames_ = undefined
    this.extraHeaderValues_ = undefined
    this.extraHeaderLines_ = undefined
  }

  get socket(): NetSocket {
    return this.request_ === undefined ? placeholderSocket : this.request_.socket
  }

  get headersSent(): boolean {
    return this.headersCommitted_
  }

  // `writable` is Writable's own plain field (defaults true at construction), not a getter here:
  // TypeScript will not let a subclass override a plain inherited property with an accessor
  // (TS2611 -- the same rule that keeps http.ts's `Socket.remoteAddress` a plain field instead of
  // a lazy getter now, see that class). So `end()` and `destroy()` below flip it to `false`
  // directly, at the same points they flip `finished`/`destroyed`, instead of deriving it.

  private indexOfHeader(lower: string): number {
    if (this.firstHeaderPresent_ && this.firstHeaderName_ === lower) return 0
    const names = this.extraHeaderNames_
    if (names === undefined) return -1
    for (let i = 0; i < names.length; i++) {
      if (names[i] === lower) return i + 1
    }
    return -1
  }

  private removeHeaderAt(index: number): void {
    const names = this.extraHeaderNames_
    const values = this.extraHeaderValues_
    const lines = this.extraHeaderLines_
    if (index === 0) {
      if (names !== undefined && values !== undefined && lines !== undefined && names.length > 0) {
        this.firstHeaderName_ = names[0]
        this.firstHeaderValue_ = values[0]
        this.firstHeaderLine_ = lines[0]
        names.splice(0, 1)
        values.splice(0, 1)
        lines.splice(0, 1)
      } else {
        this.firstHeaderPresent_ = false
        this.firstHeaderName_ = ''
        this.firstHeaderValue_ = ''
        this.firstHeaderLine_ = ''
      }
      return
    }
    if (names !== undefined && values !== undefined && lines !== undefined) {
      names.splice(index - 1, 1)
      values.splice(index - 1, 1)
      lines.splice(index - 1, 1)
    }
  }

  private removeAllOfHeader(lower: string): void {
    let index = this.indexOfHeader(lower)
    while (index >= 0) {
      this.removeHeaderAt(index)
      index = this.indexOfHeader(lower)
    }
  }

  // Typed fast path used by writeHead / end / the serializer.
  private setHeaderString(name: string, value: string): void {
    const lower = name.toLowerCase()
    const index = this.indexOfHeader(lower)
    if (index >= 0) {
      const names = this.extraHeaderNames_
      const values = this.extraHeaderValues_
      const lines = this.extraHeaderLines_
      if (index === 0) {
        this.firstHeaderValue_ = value
        this.firstHeaderLine_ = name + ': ' + value + '\r\n'
      } else if (names !== undefined && values !== undefined && lines !== undefined) {
        values[index - 1] = value
        lines[index - 1] = name + ': ' + value + '\r\n'
      }
      if (names !== undefined && values !== undefined && lines !== undefined) {
        for (let i = names.length - 1; i >= 0; i--) {
          if (names[i] === lower && i !== index - 1) {
            names.splice(i, 1)
            values.splice(i, 1)
            lines.splice(i, 1)
          }
        }
      }
      return
    }
    this.appendHeaderNormalized(name, lower, value)
  }

  private appendHeaderString(name: string, value: string): void {
    const lower = name.toLowerCase()
    this.appendHeaderNormalized(name, lower, value)
  }

  private appendHeaderNormalized(name: string, lower: string, value: string): void {
    const line = name + ': ' + value + '\r\n'
    if (!this.firstHeaderPresent_) {
      this.firstHeaderPresent_ = true
      this.firstHeaderName_ = lower
      this.firstHeaderValue_ = value
      this.firstHeaderLine_ = line
      return
    }
    let names = this.extraHeaderNames_
    let values = this.extraHeaderValues_
    let lines = this.extraHeaderLines_
    if (names === undefined || values === undefined || lines === undefined) {
      names = []
      values = []
      lines = []
      this.extraHeaderNames_ = names
      this.extraHeaderValues_ = values
      this.extraHeaderLines_ = lines
    }
    names.push(lower)
    values.push(value)
    lines.push(line)
  }

  // Node-compatible surface: accepts a string, number, or array of strings.
  setHeader(name: string, value: OutgoingHttpHeader): ServerResponse {
    if (Array.isArray(value)) {
      // Bind the narrowed array into its own `readonly string[]`-declared
      // local. The manifest deliberately carries no computed `get` recipe
      // for a tagged union mixing array and primitive arms (only
      // uniform-kind unions -- all typed-array, all dictionary, all
      // array-object -- have one; see certify/property-access-keys.ts), and
      // `value[i]` otherwise still carries the whole union's carrier even
      // inside this `Array.isArray` guard.
      const values: readonly string[] = value
      this.removeAllOfHeader(name.toLowerCase())
      for (let i = 0; i < values.length; i++) this.appendHeaderString(name, String(values[i]))
      return this
    }
    this.setHeaderString(name, String(value))
    return this
  }

  appendHeader(name: string, value: OutgoingHttpHeader): ServerResponse {
    if (Array.isArray(value)) {
      // Same narrowing local as setHeader above, for the same reason: `value[i]`
      // on the mixed array/primitive union has no manifest recipe.
      const values: readonly string[] = value
      for (let i = 0; i < values.length; i++) this.appendHeaderString(name, String(values[i]))
      return this
    }
    this.appendHeaderString(name, String(value))
    return this
  }

  // Multi-value headers come back joined with ", " (deviation: Node returns
  // the array that was set).
  getHeader(name: string): string {
    const lower = name.toLowerCase()
    let out = ''
    if (this.firstHeaderPresent_ && this.firstHeaderName_ === lower) out = this.firstHeaderValue_
    const names = this.extraHeaderNames_
    const values = this.extraHeaderValues_
    if (names === undefined || values === undefined) return out
    for (let i = 0; i < names.length; i++) {
      if (names[i] === lower) out = out === '' ? values[i] : out + ', ' + values[i]
    }
    return out
  }

  hasHeader(name: string): boolean {
    return this.indexOfHeader(name.toLowerCase()) >= 0
  }

  removeHeader(name: string): void {
    this.removeAllOfHeader(name.toLowerCase())
  }

  getHeaderNames(): string[] {
    const out: string[] = []
    if (this.firstHeaderPresent_) out.push(this.firstHeaderName_)
    const names = this.extraHeaderNames_
    if (names === undefined) return out
    for (let i = 0; i < names.length; i++) {
      let seen = false
      for (let j = 0; j < out.length; j++) {
        if (out[j] === names[i]) {
          seen = true
          break
        }
      }
      if (!seen) out.push(names[i])
    }
    return out
  }

  getHeaders(): { [name: string]: string } {
    const out: { [name: string]: string } = {}
    if (this.firstHeaderPresent_) out[this.firstHeaderName_] = this.firstHeaderValue_
    const names = this.extraHeaderNames_
    const values = this.extraHeaderValues_
    if (names === undefined || values === undefined) return out
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const value = values[i]
      if (out.hasOwnProperty(name)) {
        out[name] = out[name] + ', ' + value
      } else {
        out[name] = value
      }
    }
    return out
  }

  // Serialize the header block, matching Node byte-for-byte: status line, app
  // headers in insertion order, Date, Connection (+ Keep-Alive), then the
  // auto-computed framing header last. autoContentLength >= 0 is the
  // single-shot end() fast path; -1 means streaming (chunked on 1.1,
  // close-delimited on 1.0).
  private commitHeaders(autoContentLength: number): void {
    if (this.headersCommitted_) return
    this.headersCommitted_ = true
    const noBody = this.isHead_ || this.statusCode === 204 || this.statusCode === 304 || (this.statusCode >= 100 && this.statusCode < 200)
    let hasContentLength = false
    let hasTransferEncoding = false
    let hasDate = false
    let connection = ''
    if (this.firstHeaderPresent_) {
      if (this.firstHeaderName_ === 'content-length') hasContentLength = true
      else if (this.firstHeaderName_ === 'transfer-encoding') hasTransferEncoding = true
      else if (this.firstHeaderName_ === 'date') hasDate = true
      else if (this.firstHeaderName_ === 'connection') connection = this.firstHeaderValue_
    }
    const names = this.extraHeaderNames_
    const values = this.extraHeaderValues_
    for (let i = 0; names !== undefined && values !== undefined && i < names.length; i++) {
      const name = names[i]
      if (name === 'content-length') hasContentLength = true
      else if (name === 'transfer-encoding') hasTransferEncoding = true
      else if (name === 'date') hasDate = true
      else if (name === 'connection') connection = values[i]
    }
    let framing = ''
    let closeDelimited = false
    if (noBody) {
      this.suppressBody_ = true
    } else if (hasContentLength || hasTransferEncoding) {
      // App-controlled framing — serialize as-is.
    } else if (autoContentLength >= 0) {
      framing = 'Content-Length: ' + String(autoContentLength) + '\r\n'
    } else if (this.http10_) {
      closeDelimited = true // HTTP/1.0 cannot chunk: body runs to connection close
    } else {
      this.chunked_ = true
      framing = 'Transfer-Encoding: chunked\r\n'
    }
    let keepAlive = this.keepAliveRequested_
    if (connection === 'close' || (connection !== '' && connection.toLowerCase() === 'close')) keepAlive = false
    if (closeDelimited) keepAlive = false
    this.keepAliveFinal_ = keepAlive

    const message = this.statusMessage === '' ? statusText(this.statusCode) : this.statusMessage
    const status = String(this.statusCode)
    const firstLine = this.firstHeaderPresent_ ? this.firstHeaderLine_ : ''
    const lines = this.extraHeaderLines_
    let datePrefix = ''
    let date = ''
    let dateSuffix = ''
    if (this.sendDate && !hasDate) {
      datePrefix = 'Date: '
      date = __gea_http_date()
      dateSuffix = '\r\n'
    }
    let connectionPrefix = ''
    let connectionValue = ''
    let connectionSuffix = ''
    let keepAliveLine = ''
    if (connection === '') {
      connectionPrefix = 'Connection: '
      connectionValue = keepAlive ? 'keep-alive' : 'close'
      connectionSuffix = '\r\n'
      if (keepAlive) keepAliveLine = 'Keep-Alive: timeout=5\r\n'
    }
    // The overwhelmingly common zero/one-header response is one flat string
    // expression. The compiler lowers it to one sized concat, so growing the
    // status line through header/date/connection appends does not repeatedly
    // reallocate the same response buffer.
    if (lines === undefined) {
      this.pendingHead_ =
        'HTTP/1.1 ' +
        status +
        ' ' +
        message +
        '\r\n' +
        firstLine +
        datePrefix +
        date +
        dateSuffix +
        connectionPrefix +
        connectionValue +
        connectionSuffix +
        keepAliveLine +
        framing +
        '\r\n'
      return
    }
    this.pendingHead_ = 'HTTP/1.1 ' + status + ' ' + message + '\r\n' + firstLine
    for (const line of lines) this.pendingHead_ += line
    this.pendingHead_ += datePrefix + date + dateSuffix
    this.pendingHead_ += connectionPrefix + connectionValue + connectionSuffix + keepAliveLine
    this.pendingHead_ += framing
    this.pendingHead_ += '\r\n'
  }

  // Hand bytes to the reactor, prefixing the serialized header block on the
  // first write so head+first-chunk go out as ONE buffer append.
  private emitPayload(data: string): void {
    if (!this.headWritten_) {
      this.headWritten_ = true
      __gea_http_write(this.connId_, this.pendingHead_ + data)
      this.pendingHead_ = ''
      return
    }
    if (data.length > 0) __gea_http_write(this.connId_, data)
  }

  // The same hand-off for a body that is OCTETS. `prefix` and `suffix` are the
  // chunked framing around it (a hex length line, a terminating `0\r\n\r\n`) --
  // ASCII by construction, so they stay on the string call; only the body
  // itself takes the byte call, because a TypeScript string cannot carry
  // arbitrary bytes to the reactor intact.
  private emitPayloadBytes(prefix: string, data: Uint8Array, suffix: string): void {
    if (!this.headWritten_) {
      this.headWritten_ = true
      __gea_http_write(this.connId_, this.pendingHead_ + prefix)
      this.pendingHead_ = ''
    } else if (prefix.length > 0) __gea_http_write(this.connId_, prefix)
    if (data.length > 0) __gea_http_write_bytes(this.connId_, data)
    if (suffix.length > 0) __gea_http_write(this.connId_, suffix)
  }

  writeHead(status: number, headers: OutgoingHttpHeaders = {}): ServerResponse {
    this.statusCode = status
    // Route every entry through setHeader (not the string-only fast path)
    // so number/array values (Content-Length, repeated headers) get the same
    // stringify-and-expand treatment setHeader/appendHeader already give them.
    for (const key in headers) {
      const value = headers[key]
      if (value !== undefined) this.setHeader(key, value)
    }
    // Node serializes the header block at writeHead time — the body that
    // follows streams chunked unless the app set Content-Length.
    this.commitHeaders(-1)
    return this
  }

  // RFC 8297 103 response, written straight to the reactor ahead of the real
  // header block. Deliberately bypasses commitHeaders/emitPayload: this is a
  // separate preliminary response, not part of the final one, so it must not
  // mark headersCommitted_/headWritten_ or consume the framing machinery that
  // the eventual writeHead/end call still needs to run.
  writeEarlyHints(hints: { [name: string]: string | readonly string[] }, callback?: () => void): void {
    const link = hints['link']
    const linkValue = Array.isArray(link) ? link.join(', ') : link
    if (this.headersCommitted_ || linkValue === undefined || linkValue.length === 0) {
      if (callback !== undefined) callback()
      return
    }
    let head = 'HTTP/1.1 103 Early Hints\r\nLink: ' + linkValue + '\r\n'
    for (const key in hints) {
      if (key === 'link') continue
      const value = hints[key]
      head += key + ': ' + (Array.isArray(value) ? value.join(', ') : value) + '\r\n'
    }
    head += '\r\n'
    __gea_http_write(this.connId_, head)
    if (callback !== undefined) callback()
  }

  flushHeaders(): void {
    this.commitHeaders(-1)
    this.emitPayload('')
  }

  // `string | Uint8Array`, as Node's own `write`/`end` take. The byte arm is
  // not a convenience: a `Uint8Array` body is arbitrary octets, and routing it
  // through the string call would require it to be valid UTF-8 to survive.
  // `@hono/node-server`'s `listener.ts` reaches both arms of this union on the
  // ordinary response path (`outgoing.end(body)` for a string body, and again
  // for a `Uint8Array` one).
  override write(chunk: string | Uint8Array): boolean {
    if (this.finished || this.destroyed) return false
    this.commitHeaders(-1)
    if (typeof chunk === 'string') {
      let payload = ''
      const chunkLength = Buffer.byteLength(chunk)
      if (chunkLength > 0 && !this.suppressBody_) {
        payload = this.chunked_ ? chunkLength.toString(16) + '\r\n' + chunk + '\r\n' : chunk
      }
      this.emitPayload(payload)
      return true
    }
    const byteLength = chunk.byteLength
    if (byteLength === 0 || this.suppressBody_) this.emitPayload('')
    else if (this.chunked_) this.emitPayloadBytes(byteLength.toString(16) + '\r\n', chunk, '\r\n')
    else this.emitPayloadBytes('', chunk, '')
    return true
  }

  override end(chunk: string | Uint8Array = ''): this {
    if (this.finished || this.destroyed) return this
    this.finished = true
    this.writable = false
    this.writableEnded = true
    if (typeof chunk === 'string') {
      const chunkLength = Buffer.byteLength(chunk)
      this.commitHeaders(chunkLength)
      let payload = ''
      if (!this.suppressBody_) {
        if (this.chunked_) {
          payload = chunkLength > 0 ? chunkLength.toString(16) + '\r\n' + chunk + '\r\n0\r\n\r\n' : '0\r\n\r\n'
        } else if (chunkLength > 0) {
          payload = chunk
        }
      }
      this.emitPayload(payload)
    } else {
      const byteLength = chunk.byteLength
      this.commitHeaders(byteLength)
      if (this.suppressBody_) this.emitPayload('')
      else if (this.chunked_)
        this.emitPayloadBytes(
          byteLength > 0 ? byteLength.toString(16) + '\r\n' : '',
          chunk,
          byteLength > 0 ? '\r\n0\r\n\r\n' : '0\r\n\r\n'
        )
      else this.emitPayloadBytes('', chunk, '')
    }
    this.writableFinished = true
    __gea_http_done(this.connId_, this.keepAliveFinal_)
    if (this.hasAnyListeners()) {
      if (this.listenerCount('finish') > 0) this.emit('finish')
      if (this.listenerCount('close') > 0) this.emit('close')
    }
    return this
  }

  // Unlike end(), not gated on `finished`: a real destroy() forces the
  // underlying connection closed even after a normal end() (the same
  // __gea_http_destroy primitive Socket.destroy uses), which is exactly what
  // callers reach for post-end() to stop a bad connection from being reused
  // on keep-alive.
  override destroy(error: Error | null = null): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.writable = false
    void error
    __gea_http_destroy(this.connId_)
    return this
  }
}

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

/**
 * `node:http`'s server-construction options -- deliberately EMPTY.
 *
 * Node's own `ServerOptions` carries fourteen members (`maxHeaderSize`,
 * `keepAlive`, `keepAliveInitialDelay`, `insecureHTTPParser`,
 * `joinDuplicateHeaders`, `IncomingMessage`, `ServerResponse`, ...) and this
 * target honors none of them: the reactor behind `__gea_http_serve` has fixed
 * parsing, fixed keep-alive behaviour, and constructs its own
 * `IncomingMessage`/`ServerResponse`. Declaring those members and ignoring
 * them is the failure this runtime avoids everywhere else -- the program would
 * compile a setting it silently does not get. Left empty, an object literal
 * that sets one is an excess-property error at the call site, naming the
 * member: the same fail-closed answer, in the checker instead of in
 * production.
 *
 * The name itself has to exist regardless of what is in it:
 * `@hono/node-server`'s `types.ts` imports it (`ServerOptions as
 * HttpServerOptions`) to type its own `serverOptions?` field, so an absent
 * export is a `TS2614` before any option is ever set.
 */
export interface ServerOptions {}

// `connection`/`clientError` carry `NetSocket`, not this file's own `Socket`
// subclass: real Node types both as `net.Socket`, and `IncomingMessage.socket`
// (below) is itself declared as `NetSocket` for the same reason (matching
// Node's actual `IncomingMessage.socket: net.Socket`, and letting a
// `TLSSocket` cast type-check) -- so `req.socket` passed to `emit('connection', ...)`
// needs the map to accept the same widened type.
export class Server extends EventEmitter {
  // Concrete per-event overloads, NOT an `EventEmitter<ServerEventMap>` type
  // argument: `@hono/node-server` writes `server.on('upgrade', (req, socket,
  // head) => ...)` with no annotations, so the parameters have to come from
  // here, but a generic base whose members read `TEvents[K]` gave every
  // listener array in `events.ts` an unresolved carrier (measured: 30 blocking
  // diagnostics on `hono-hello`, 2026-09-15). These are plain overloads over
  // literal name types -- no type parameter, so nothing to monomorphize.
  //
  // The trailing catch-all is what keeps this class's own internal
  // `this.emit('close')` / `this.on(name, fn)` calls working, and it must come
  // LAST: TypeScript picks the first matching overload.
  //
  // `connection`/`clientError` carry `NetSocket`, not this file's own `Socket`
  // subclass: real Node types both as `net.Socket`, and `IncomingMessage.socket`
  // (below) is itself declared as `NetSocket` for the same reason (matching
  // Node's actual `IncomingMessage.socket: net.Socket`, and letting a
  // `TLSSocket` cast type-check) -- so `req.socket` passed to
  // `emit('connection', ...)` needs the same widened type.
  override on(name: 'request', fn: (req: IncomingMessage, res: ServerResponse) => void): this
  override on(name: 'connection', fn: (socket: NetSocket) => void): this
  override on(name: 'upgrade', fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): this
  override on(name: 'clientError', fn: (error: Error, socket: NetSocket) => void): this
  override on(name: EventName, fn: EventHandler): this
  override on(name: EventName, fn: EventHandler): this {
    return super.on(name, fn)
  }

  override once(name: 'request', fn: (req: IncomingMessage, res: ServerResponse) => void): this
  override once(name: 'connection', fn: (socket: NetSocket) => void): this
  override once(name: 'upgrade', fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): this
  override once(name: 'clientError', fn: (error: Error, socket: NetSocket) => void): this
  override once(name: EventName, fn: EventHandler): this
  override once(name: EventName, fn: EventHandler): this {
    return super.once(name, fn)
  }

  listening: boolean
  private requestListeners_: RequestListener[]
  private requestListener_: RequestListener
  private port_: number

  constructor(requestListener: RequestListener) {
    super()
    this.listening = false
    this.requestListener_ = requestListener
    this.requestListeners_ = []
    this.port_ = 0
  }

  // Node's own shape is `listen(port?, host?, backlog?, callback?)`, and
  // `@hono/node-server`'s `serve()` calls the three-argument form:
  // `server.listen(options.port ?? 3000, options.hostname, () => ...)`.
  //
  // `hostname` is accepted and CHECKED rather than accepted and dropped. The
  // reactor binds `INADDR_ANY` unconditionally (`gea_node.cpp`'s listener
  // setup: `addr.sin_addr.s_addr = htonl(INADDR_ANY)`), so a program that asks
  // for `127.0.0.1` expecting a loopback-only socket would instead get one
  // reachable from the whole network -- a silent difference that widens what
  // the process exposes. Only the spellings that already mean "every
  // interface" pass; anything else is refused here, naming the member.
  listen(port: number, hostname?: string | (() => void), callback?: () => void): Server {
    let done = callback
    if (typeof hostname === 'function') done = hostname
    else if (hostname !== undefined && hostname !== '0.0.0.0' && hostname !== '::')
      nodeNotImplemented('http', `Server.listen with hostname ${hostname} (this target binds every interface)`)
    this.port_ = port
    this.listening = true
    if (done !== undefined) done()
    this.emit('listening')
    // Drain `on('request', ...)`-registered listeners (stored boxed by the
    // generic emitter — a cold startup path) into typed adapters so the
    // per-request dispatch below never boxes. The primary path — the
    // createServer(listener) constructor argument — is typed end-to-end.
    const boxedExtras = this.listeners('request')
    for (let i = 0; i < boxedExtras.length; i++) {
      const boxedFn = boxedExtras[i]
      this.requestListeners_.push((rq: IncomingMessage, rs: ServerResponse) => {
        boxedFn(rq, rs)
      })
    }
    // Capture into locals: the dispatch closure must not capture `this` (the
    // reactor stores it by value; shared_from_this would dangle).
    const listener = this.requestListener_
    const extraListeners = this.requestListeners_
    const self = this
    __gea_http_serve(
      port,
      (connId: number, flags: number, method: string, url: string, httpVersion: string, rawHead: string, body: string): void => {
        const keepAlive = (flags & FLAG_KEEP_ALIVE) !== 0
        const req = new IncomingMessage(connId, method, url, httpVersion, rawHead, body)
        const res = new ServerResponse(connId, method === 'HEAD', keepAlive, httpVersion === 'HTTP/1.0', req)
        // Gate the connection emit on listener presence: its ARGUMENT boxes at
        // the call site (building the socket's object bridge).
        if ((flags & FLAG_FIRST_ON_CONNECTION) !== 0 && self.listenerCount('connection') > 0) {
          self.emit('connection', req.socket)
        }
        listener(req, res)
        for (let i = 0; i < extraListeners.length; i++) {
          const extra = extraListeners[i]
          extra(req, res)
        }
        // Body delivery no longer needs an explicit post-dispatch nudge here: `req` pushed its
        // whole body in its own constructor (before `listener` ran), and IncomingMessage's
        // `newListenerAdded` override schedules the drain itself, once, off a microtask, the
        // moment a 'data' or 'end' listener is attached -- whether that happens synchronously
        // above or later from inside an async handler.
      }
    )
    return this
  }

  close(callback?: () => void): Server {
    this.listening = false
    __gea_http_stop()
    this.emit('close')
    if (callback !== undefined) callback()
    return this
  }

  address(): { address: string; family: string; port: number } {
    return { address: '0.0.0.0', family: 'IPv4', port: this.port_ }
  }
}

export class ClientRequest {
  on(name: string, listener: ClientRequestErrorListener): ClientRequest {
    return this
  }

  end(): ClientRequest {
    return this
  }

  destroy(error?: Error): void {
    throw error ?? new Error('HTTP client requests are not supported by the gea node-compat runtime')
  }
}

export function get(
  // Node's real signature accepts `string | URL`. `URL` is only declared by
  // `runtime/node/globals.ts`, opt-in via `--globals` (see that file's
  // header) — this module, unlike it, is unconditionally part of every
  // build, `--globals` or not, so it cannot depend on a name that may not be
  // in scope. Dropping the `URL` arm costs nothing real: this function
  // throws unconditionally below (`http.get` is unimplemented), so no
  // caller ever reaches a codepath that cares which type was declared here.
  url: string,
  options: RequestOptions,
  callback: ClientResponseListener
): ClientRequest {
  throw new Error('http.get is not supported by the gea node-compat runtime')
}

// Node's `createServer(options, listener)` form as well as `createServer(listener)`:
// `@hono/node-server` always passes its `serverOptions` first. No option is
// honored yet, so the options object is only skipped.
export function createServer(optionsOrListener: ServerOptions | RequestListener, requestListener?: RequestListener): Server {
  if (requestListener !== undefined) return new Server(requestListener)
  return new Server(optionsOrListener as RequestListener)
}

// A CommonJS-style default namespace: every member here is already a
// concretely-typed class/function, so the bag itself is honestly
// `Record<string, unknown>` (matching `stream.ts`'s `streamDefault`) rather
// than `any` -- the dynamic part is the re-export mechanism, not any one
// member.
const httpDefault: Record<string, unknown> = {
  createServer,
  get,
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  STATUS_CODES,
  METHODS: httpMethods
}

export default httpDefault
