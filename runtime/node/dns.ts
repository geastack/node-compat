// Typed `node:dns` surface over the generated facade.
//
// `dns.promises` was the facade's `unknown`, so `dns.promises.resolveSrv(...)`
// failed to type-check in every library that uses it (the MongoDB driver's
// connection-string and SRV-polling paths). `promises` is the typed
// `node:dns/promises` module; the record types and node's string error codes
// are re-exported from it so `dns.SrvRecord` and `dns.TIMEOUT` mean what node
// says they do. The callback resolvers remain the facade's.

import * as promises from './dns/promises'

export * from './generated/facades/dns'
export { promises }
export type { LookupAddress, LookupOptions, SrvRecord } from './dns/promises'
export {
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED
} from './dns/promises'
