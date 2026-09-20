// `whatwg-url`, answered by the WHATWG classes this target already compiles.
//
// `mongodb-connection-string-url` -- which the driver's own
// `connection_string.ts` imports -- says `import { URL, URLSearchParams } from
// 'whatwg-url'` and builds its whole `ConnectionString` on it
// (`class URLWithoutHost extends URL`). The npm package is JavaScript with no
// type declarations at all, so with no entry for the specifier TypeScript
// resolved the import to nothing: `URL` became an error type, `ConnectionString`
// inherited nothing, and every `url.searchParams`/`url.password` in
// `redact.ts` and `index.ts` reported "Property 'searchParams' does not exist
// on type 'ConnectionString'". Mapping it to the `node:url` facade would not
// have helped either -- that facade's `URL` is a `nodeNotImplemented` stub with
// no members, so the same reads would still not exist.
//
// `runtime/node/globals.ts` has the real ones: compiled classes with a parser,
// `searchParams`, and the username/password accessors. They live in the GLOBAL
// scope because that file is a script (see its header for why that is
// load-bearing), so this module names them by name rather than importing them
// -- there is nothing to import from a script.
//
// The `const`/`type` pair under one alias is what makes each name export BOTH
// meanings. `export { Impl as URL }` re-exports every meaning the local name
// has, and a `const` and a `type` of the same name are two declaration spaces
// rather than a redeclaration -- so `new URL(...)` and `extends URL` both work
// through one specifier, where two separate `export`/`export type` statements
// would collide on the name.
//
// `scripts/build.mjs` roots `globals.ts` when this facade is reachable in
// the resolved package graph. No caller-only import or unconditional browser
// surface is needed: the bare package edge itself carries the implementation
// dependency.

const URLAlias = URL
type URLAlias = URL

const URLSearchParamsAlias = URLSearchParams
type URLSearchParamsAlias = URLSearchParams

export { URLAlias as URL, URLSearchParamsAlias as URLSearchParams }
