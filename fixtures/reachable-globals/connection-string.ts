// Stand-in for the mongodb driver's own `connection_string.ts`, which used to
// live under the `vendored-sources/mongodb` submodule. That submodule is gone
// (see docs/ARCHITECTURE.md, "Compile-from-source (the zero-boxing
// pipeline)"): the compiler now acquires a dependency's typed source on
// demand instead of reading a checked-in copy, so there is no tracked,
// always-available `.ts` file for the real package to point a test at.
//
// This fixture exercises the same transitive-import shape the real graph
// has: an entry that bare-imports `mongodb-connection-string-url`, which
// itself bare-imports `whatwg-url` (see `mongodb-connection-string-url.ts`
// next to this file). `scripts/test-fastify-host-surfaces.mjs` points
// `moduleOverrides` at both of these fixtures instead of resolving them from
// node_modules, so the test does not depend on either package being
// installed anywhere.
import ConnectionString from 'mongodb-connection-string-url'

export function parseConnectionString(uri: string): ConnectionString {
  return new ConnectionString(uri)
}
