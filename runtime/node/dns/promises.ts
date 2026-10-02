// Typed `node:dns/promises` surface over the generated facade.
//
// The generated facade types every resolver `(...args: unknown[]) => never`,
// so a library that awaits one -- the MongoDB driver resolves `mongodb+srv://`
// seeds with `resolveSrv`/`resolveTxt` and canonicalizes Kerberos hosts with
// `lookup`/`resolvePtr`/`resolveCname` -- cannot type-check its results. These
// are node's declared shapes. Name resolution itself is not implemented yet:
// each call rejects with the facade's not-implemented error, the same failure
// the facade raised, now through the Promise node's API returns.

import { nodeNotImplemented } from '../not-implemented'

export * from '../generated/facades/dns/promises'

export interface LookupAddress {
  address: string
  family: number
}

export interface LookupOptions {
  family?: number | 'IPv4' | 'IPv6'
  hints?: number
  all?: boolean
  order?: 'ipv4first' | 'ipv6first' | 'verbatim'
  verbatim?: boolean
}

export interface SrvRecord {
  priority: number
  weight: number
  port: number
  name: string
}

// Node's error codes, as node itself spells them (`dns.TIMEOUT === 'ETIMEOUT'`).
export const NODATA = 'ENODATA'
export const FORMERR = 'EFORMERR'
export const SERVFAIL = 'ESERVFAIL'
export const NOTFOUND = 'ENOTFOUND'
export const NOTIMP = 'ENOTIMP'
export const REFUSED = 'EREFUSED'
export const BADQUERY = 'EBADQUERY'
export const BADNAME = 'EBADNAME'
export const BADFAMILY = 'EBADFAMILY'
export const BADRESP = 'EBADRESP'
export const CONNREFUSED = 'ECONNREFUSED'
export const TIMEOUT = 'ETIMEOUT'
export const EOF = 'EOF'
export const FILE = 'EFILE'
export const NOMEM = 'ENOMEM'
export const DESTRUCTION = 'EDESTRUCTION'
export const BADSTR = 'EBADSTR'
export const BADFLAGS = 'EBADFLAGS'
export const NONAME = 'ENONAME'
export const BADHINTS = 'EBADHINTS'
export const NOTINITIALIZED = 'ENOTINITIALIZED'
export const LOADIPHLPAPI = 'ELOADIPHLPAPI'
export const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS'
export const CANCELLED = 'ECANCELLED'

function unimplemented<T>(member: string): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    try {
      nodeNotImplemented('node:dns/promises', member)
    } catch (error) {
      reject(error)
    }
  })
}

export function lookup(_hostname: string, _options?: LookupOptions | number): Promise<LookupAddress> {
  return unimplemented<LookupAddress>('lookup')
}

export function resolveSrv(_hostname: string): Promise<SrvRecord[]> {
  return unimplemented<SrvRecord[]>('resolveSrv')
}

export function resolveTxt(_hostname: string): Promise<string[][]> {
  return unimplemented<string[][]>('resolveTxt')
}

export function resolvePtr(_hostname: string): Promise<string[]> {
  return unimplemented<string[]>('resolvePtr')
}

export function resolveCname(_hostname: string): Promise<string[]> {
  return unimplemented<string[]>('resolveCname')
}
