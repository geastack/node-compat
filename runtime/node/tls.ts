// Compile-time-compatible TLS surface. The first MongoDB correctness target is
// explicitly plain mongodb://127.0.0.1, so entering this path is a loud error.

import { Socket } from './net'
import type { Buffer } from './buffer'

export interface PeerCertificate {
  subject?: {
    CN?: string
  }
  issuer?: {
    CN?: string
  }
  subjectaltname?: string
  valid_from?: string
  valid_to?: string
  fingerprint?: string
  fingerprint256?: string
  serialNumber?: string
  raw?: Uint8Array
}

export interface SecureContext {}

export interface ConnectionOptions {
  host?: string
  port?: number
  path?: string
  allowPartialTrustChain?: boolean
  ALPNProtocols?: readonly string[] | readonly Uint8Array[]
  servername?: string
  socket?: Socket
  ca?: string | Buffer | readonly (string | Buffer)[]
  cert?: string | Buffer | readonly (string | Buffer)[]
  checkServerIdentity?: (hostname: string, certificate: PeerCertificate) => Error | undefined
  ciphers?: string
  crl?: string | Buffer | readonly (string | Buffer)[]
  ecdhCurve?: string
  key?: string | Buffer | readonly (string | Buffer | { pem: string | Buffer; passphrase?: string })[]
  minDHSize?: number
  passphrase?: string
  pfx?: string | Buffer | readonly (string | Buffer | { buf: string | Buffer; passphrase?: string })[]
  rejectUnauthorized?: boolean
  secureContext?: SecureContext
  secureProtocol?: string
  session?: Uint8Array
}

export type TLSSocketOptions = ConnectionOptions

export class TLSSocket extends Socket {
  // Node's own docs: "Always returns true. May be used to distinguish TLS
  // sockets from regular net.Socket instances." It is a discriminant, not a
  // runtime flag -- true for every real TLSSocket, TLS support or not.
  readonly encrypted: boolean = true

  disableRenegotiation(): void {}
}

function nodeTlsConnect(_options: ConnectionOptions): TLSSocket {
  throw new Error('TLS is not implemented by the gea node-compat runtime')
}

export { nodeTlsConnect as connect }
