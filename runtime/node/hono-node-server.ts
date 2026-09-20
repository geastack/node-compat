// `@hono/node-server`, answered by this target (see `scripts/build.mjs`'s
// `answeredPackages`): the same `serve({ fetch, port }, listening)` surface an
// app imports from the package, over the reactor directly.
//
// The package's own listener exists to run a WHATWG fetch handler on Node's
// `http` module: it takes the IncomingMessage/ServerResponse pair Node built,
// wraps them into a `Request`, and unwraps the `Response` back into
// `writeHead`/`end`. On this target every one of those layers is compiled
// TypeScript with a real cost -- a Readable and a Writable with their
// EventEmitter state, the header block parsed into an array and then an
// object and then a `Headers`, the response body awaited through a Promise
// and re-framed -- and the request reaches the program as the reactor's own
// dispatch anyway (`__gea_http_serve`), with the method, the URL, the raw
// header block and the body bytes already separated. So this goes from that
// dispatch to a `Request` (`Request.fromWire`: nothing copied, headers parsed
// only if read) and from the `Response` to one wire write. What Hono itself
// does per request is unchanged; what this removes is the adapter around it.
//
// Same-tree measurement, one worker, `/json`: 13.3k rps through the compiled
// package against 26.0k through this shape (hono-bridge, 2026-09-18).
import { statusText } from './http'
import { Buffer } from './buffer-types'

// The same contracts `http.ts` states for these five, for the same reasons
// (see its declarations): `serve` stores the dispatch closure and `done` may
// run the program's handler for the next pipelined request, so neither is
// inert, but none of the five writes a property on any JavaScript object.
// Without the tag the census stamps `every` key onto each intrinsic the
// dispatch closure reaches, `Object` included, and refuses Hono's own
// `Object.keys`.
/** @gea-host-no-property-writes */
declare function __gea_http_serve(
  port: number,
  onRequest: (connId: number, flags: number, method: string, url: string, httpVersion: string, rawHead: string, body: string) => void
): void
/** @gea-host-inert */
declare function __gea_http_write(connId: number, data: string): void
/** @gea-host-inert */
declare function __gea_http_body_bytes(body: string): Buffer
/** @gea-host-no-property-writes */
declare function __gea_http_done(connId: number, keepAlive: boolean): void
/** @gea-host-inert */
declare function __gea_http_date(): string
/** @gea-host-no-property-writes */
declare function __gea_http_stop(): void

// Mirrors the reactor's dispatch flags (`http.ts` declares the same two).
const FLAG_KEEP_ALIVE = 1

// The package binds Node's own request/response pair as the handler's `env`.
// This target has no such pair on this path -- that is the point of it -- so
// the handler is called with no env at all, stated in the type rather than
// hidden behind an object with two `undefined` fields. (Not an object
// literal on purpose, and not only for the type: a literal captured by the
// dispatch closure below reaches `Object.prototype` in the host-mutation
// census's alias graph, and handing that closure to the untagged reactor
// intrinsic then stamps `every` key onto `Object` -- which refuses Hono's own
// `Object.keys` in the router.)
export type FetchCallback = (request: Request, env?: undefined) => Response | Promise<Response>
export interface Options {
  fetch: FetchCallback
  port?: number
  hostname?: string
  overrideGlobalObjects?: boolean
}
export interface AddressInfo {
  address: string
  family: string
  port: number
}
export interface ServerType {
  close(callback?: (error?: Error) => void): void
}

// `Host`, found by code units at each line start rather than by lowercasing
// every header name: it is the one header the URL needs before the handler
// runs, and the rest of the block stays unparsed unless the handler reads it.
function isHostLine(head: string, pos: number): boolean {
  return (head.charCodeAt(pos) | 32) === 104 &&
  (head.charCodeAt(pos + 1) | 32) === 111 &&
  (head.charCodeAt(pos + 2) | 32) === 115 &&
  (head.charCodeAt(pos + 3) | 32) === 116 &&
  head.charCodeAt(pos + 4) === 58
}

function hostOf(head: string): string {
  const length = head.length
  let pos = 0
  while (pos < length) {
    let eol = head.indexOf('\r\n', pos)
    if (eol < 0) eol = length
    if (isHostLine(head, pos)) {
      let valueStart = pos + 5
      while (valueStart < eol && (head[valueStart] === ' ' || head[valueStart] === '\t')) valueStart++
      let valueEnd = eol
      while (valueEnd > valueStart && (head[valueEnd - 1] === ' ' || head[valueEnd - 1] === '\t')) valueEnd--
      if (valueEnd > valueStart) return head.substring(valueStart, valueEnd)
      break
    }
    pos = eol + 2
  }
  return 'localhost'
}

// The head in one string and the body appended to it: one write, one
// `done`. Framing follows `ServerResponse#commitHeaders` for the cases a
// `Response` can produce -- a `Content-Length` unless the app set its own
// framing, no body for HEAD/1xx/204/304, `Date` unless set, and the
// connection line from the request's keep-alive flag unless the app decided.
function respond(connId: number, keepAliveRequested: boolean, isHead: boolean, response: Response): void {
  const status = response.status
  const headers = response.headers
  const body = Response.bodyTextOf(response)
  const noBody = isHead || status === 204 || status === 304 || (status >= 100 && status < 200)
  const connection = headers.get('connection')
  const keepAlive = keepAliveRequested && (connection === null || connection.toLowerCase() !== 'close')
  const message = response.statusText === '' ? statusText(status) : response.statusText
  let head = 'HTTP/1.1 ' + String(status) + ' ' + message + '\r\n' + Headers.wireLinesOf(headers)
  if (!noBody && !headers.has('content-length') && !headers.has('transfer-encoding')) {
    head += 'Content-Length: ' + String(Buffer.byteLength(body)) + '\r\n'
  }
  if (!headers.has('date')) head += 'Date: ' + __gea_http_date() + '\r\n'
  if (connection === null) head += keepAlive ? 'Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n' : 'Connection: close\r\n'
  head += '\r\n'
  __gea_http_write(connId, noBody ? head : head + body)
  __gea_http_done(connId, keepAlive)
}

function respondFailure(connId: number, error: unknown): void {
  console.error('hono-node-server: handler failed', error)
  __gea_http_write(connId, 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  __gea_http_done(connId, false)
}

// The reactor's per-request work, as a declared function the dispatch closure
// calls rather than a body it carries. The closure handed to
// `__gea_http_serve` is an argument to an untagged host native, and the
// host-mutation census stamps `every` key onto each intrinsic object such an
// argument can reach; a closure that itself read `Request` or `Promise` (both
// properties of the global object) reached the global object, and with it
// `Object` -- which then failed Hono's own `Object.keys` obligation in the
// router. Here the closure captures exactly one value, the app's handler,
// the same shape `http.ts`'s `Server#listen` closure has always had.
function dispatch(fetch: FetchCallback, connId: number, flags: number, method: string, url: string, rawHead: string, body: string): void {
  const keepAlive = (flags & FLAG_KEEP_ALIVE) !== 0
  const isHead = method === 'HEAD'
  const request = Request.fromWire('http://' + hostOf(rawHead) + url, method, rawHead, body.length > 0 ? __gea_http_body_bytes(body) : undefined)
  let result: Response | Promise<Response>
  try {
    result = fetch(request)
  } catch (error) {
    respondFailure(connId, error)
    return
  }
  if (result instanceof Promise) {
    result.then(
      (response: Response) => {
        respond(connId, keepAlive, isHead, response)
      },
      (error: unknown) => {
        respondFailure(connId, error)
      }
    )
  } else {
    respond(connId, keepAlive, isHead, result)
  }
}

export const serve = (options: Options, listeningListener?: (info: AddressInfo) => void): ServerType => {
  const fetch = options.fetch
  const port = options.port ?? 3000
  __gea_http_serve(port, (connId: number, flags: number, method: string, url: string, _httpVersion: string, rawHead: string, body: string): void => {
    dispatch(fetch, connId, flags, method, url, rawHead, body)
  })
  if (listeningListener !== undefined) listeningListener({ address: '0.0.0.0', family: 'IPv4', port })
  return {
    close(callback?: (error?: Error) => void): void {
      __gea_http_stop()
      if (callback !== undefined) callback()
    }
  }
}
