// Checked-in override for the generated `node:http2` facade (see
// scripts/builtin-modules.mjs: a checked-in runtime/node/<name>.ts wins over
// runtime/node/generated/facades/<name>.ts deterministically).
//
// This target's reactor (runtime/gea_node.cpp) speaks HTTP/1.x only — there is
// no HTTP/2 frame layer, no multiplexed streams, nothing to bind a real
// Http2Server to. The honest model is NOT an empty stub: `@hono/node-server`
// types its request/response surface as `IncomingMessage | Http2ServerRequest`
// and `ServerResponse | Http2ServerResponse`, so every member access on those
// unions needs to resolve. Making `Http2ServerRequest extends IncomingMessage`
// and `Http2ServerResponse extends ServerResponse` gives the union every
// member of the HTTP/1 surface for free, while `createServer` /
// `createSecureServer` throw unconditionally — so no program running on this
// target can ever actually obtain one, and `incoming instanceof
// Http2ServerRequest` correctly evaluates false for every request this
// reactor produces (they are always plain `IncomingMessage`). That is exactly
// the branch behaviour Hono's dual HTTP/1 + HTTP/2 listener wants.
import { nodeNotImplemented } from './not-implemented'
import { Buffer } from './buffer-types'
import { IncomingMessage, ServerResponse, Server } from './http'

export function connect(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'connect')
}

// Real error-code values (RFC 7540 §7 / nghttp2.h) — these are plain
// constants, not reactor behaviour, so there is no reason to fake them.
export const constants = {
  NGHTTP2_NO_ERROR: 0x0,
  NGHTTP2_PROTOCOL_ERROR: 0x1,
  NGHTTP2_INTERNAL_ERROR: 0x2,
  NGHTTP2_FLOW_CONTROL_ERROR: 0x3,
  NGHTTP2_SETTINGS_TIMEOUT: 0x4,
  NGHTTP2_STREAM_CLOSED: 0x5,
  NGHTTP2_FRAME_SIZE_ERROR: 0x6,
  NGHTTP2_REFUSED_STREAM: 0x7,
  NGHTTP2_CANCEL: 0x8,
  NGHTTP2_COMPRESSION_ERROR: 0x9,
  NGHTTP2_CONNECT_ERROR: 0xa,
  NGHTTP2_ENHANCE_YOUR_CALM: 0xb,
  NGHTTP2_INADEQUATE_SECURITY: 0xc,
  NGHTTP2_HTTP_1_1_REQUIRED: 0xd
} as const

export interface Settings {
  headerTableSize?: number
  enablePush?: boolean
  initialWindowSize?: number
  maxFrameSize?: number
  maxConcurrentStreams?: number
  maxHeaderListSize?: number
  maxHeaderSize?: number
  enableConnectProtocol?: boolean
}

// Real option names carried through unused: `serverOptions` in Hono's
// `createHttp2Options` is a pass-through to Node's own `createServer`, which
// this target never calls (createServer below throws before touching it).
export interface ServerOptions {
  maxDeflateDynamicTableSize?: number
  maxSessionMemory?: number
  maxHeaderListPairs?: number
  maxOutstandingPings?: number
  maxSendHeaderBlockLength?: number
  paddingStrategy?: number
  peerMaxConcurrentStreams?: number
  settings?: Settings
  unknownProtocolTimeout?: number
}

export interface SecureServerOptions extends ServerOptions {
  allowHTTP1?: boolean
  ALPNProtocols?: readonly string[]
  key?: string | Buffer | readonly (string | Buffer)[]
  cert?: string | Buffer | readonly (string | Buffer)[]
  ca?: string | Buffer | readonly (string | Buffer)[]
  passphrase?: string
}

export function createSecureServer(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'createSecureServer')
}

export function createServer(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'createServer')
}

export function getDefaultSettings(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'getDefaultSettings')
}

export function getPackedSettings(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'getPackedSettings')
}

export function getUnpackedSettings(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'getUnpackedSettings')
}

// `authority`/`scheme`/`stream` are the genuinely HTTP/2-only members
// (Hono's newRequest() reads them only after narrowing with `instanceof
// Http2ServerRequest`); every other member Hono touches — `.destroy`,
// `.readableEnded`, `.method`, `.url`, `.headers`, `.rawHeaders`, `.complete`,
// `.socket` — comes from extending IncomingMessage. The constructor always
// throws, so the fields below are never read with real values; they exist
// only so the type carries the shape Hono's source declares.
export class Http2ServerRequest extends IncomingMessage {
  authority: string
  scheme: string
  stream: unknown

  constructor(...args: unknown[]) {
    super(0, '', '', '', '', '')
    void args
    nodeNotImplemented('node:http2', 'Http2ServerRequest')
  }
}

// Same reasoning as Http2ServerRequest: every member Hono's listener.ts
// touches (`.writableFinished`, `.headersSent`, `.writeHead`, `.end`,
// `.destroy`, `.on`, `.once`, `.writable`) comes from extending ServerResponse.
export class Http2ServerResponse extends ServerResponse {
  constructor(...args: unknown[]) {
    super(0, false, false, false, new IncomingMessage(0, '', '', '', '', ''))
    void args
    nodeNotImplemented('node:http2', 'Http2ServerResponse')
  }
}

// Pure type-level surfaces: neither is ever imported as a value by Hono (only
// `import type`), and since createServer/createSecureServer above always
// throw, nothing on this target can ever hold an instance. An interface that
// extends Server's instance shape is the honest representation — it types the
// union in `ServerType = Server | Http2Server | Http2SecureServer` without
// pretending a constructible HTTP/2 server class exists.
export interface Http2Server extends Server {}
export interface Http2SecureServer extends Http2Server {}

export function performServerHandshake(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:http2', 'performServerHandshake')
}

// A real marker symbol, not reactor behaviour — Node's http2.sensitiveHeaders
// is just a well-known Symbol callers can stash on a headers object, so there
// is no reason to fake this one with `undefined`.
export const sensitiveHeaders: symbol = Symbol('nodejs.http2.sensitiveHeaders')
