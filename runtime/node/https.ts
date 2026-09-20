// Checked-in override for the generated `node:https` facade (see
// scripts/builtin-modules.mjs: a checked-in runtime/node/<name>.ts wins over
// runtime/node/generated/facades/<name>.ts deterministically).
//
// This target's reactor has no TLS layer (see runtime/node/tls.ts), so
// there is nothing here to make real: every value export still throws
// `nodeNotImplemented`. The only defect Hono's source actually hits is a
// missing TYPE — `ServerOptions` — needed so `createHttpsOptions` in
// `@hono/node-server`'s types.ts type-checks; it is never constructed on
// this target (the field is only read by the https arm of `createServer`,
// which is unreachable since `https.createServer` below throws first).
import { nodeNotImplemented } from './not-implemented'
import { Buffer } from './buffer-types'

// Real Node https.ServerOptions is `http.ServerOptions & tls.TlsOptions`.
// http.ts does not (yet) export a `ServerOptions` type for this target, so
// this carries the TLS-option half directly — the half Hono's own
// `createHttpsOptions` actually needs a name for.
export interface ServerOptions {
  key?: string | Buffer | readonly (string | Buffer)[]
  cert?: string | Buffer | readonly (string | Buffer)[]
  ca?: string | Buffer | readonly (string | Buffer)[]
  passphrase?: string
  ALPNProtocols?: readonly string[]
  requestCert?: boolean
  rejectUnauthorized?: boolean
}

export class Agent {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented('node:https', 'Agent')
  }
}

export function createServer(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:https', 'createServer')
}

export function get(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:https', 'get')
}

export const globalAgent: unknown = undefined

export function request(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:https', 'request')
}

export class Server {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented('node:https', 'Server')
  }
}
