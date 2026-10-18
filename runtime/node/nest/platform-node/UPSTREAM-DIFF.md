# Edits against upstream (nestjs/nest `feat/platform-node` @ 2b10fb2)

Policy: the vendored files are edited only where the whole-program `strict`
checking of this target rejects code platform-node compiles under its own
`noImplicitAny: false` / `useUnknownInCatchVariables: false` tsconfig, and
each edit is listed here with the upstream line. Behaviour is unchanged.

| File | Upstream line | Edit | Why |
|---|---|---|---|
| `body-parser/body-parser.ts` | 657 `throw toParseError(error, text);` | `error instanceof Error ? error : new SyntaxError(String(error))` | catch variable is `unknown` under `strict`; `toParseError` takes `Error`. `JSON.parse` and `secure-json-parse` only ever throw `SyntaxError`, so the fallback branch is unreachable in practice. |

## No-boxing typing

The find-my-way shim (`runtime/node/nest/shims/find-my-way`) types the route
store as a type parameter instead of the package's `any`, so the vendored
route table names its store type and drops its `as any` casts. Behaviour is
unchanged.

| File | Upstream line | Edit | Why |
|---|---|---|---|
| `router/route-table.ts` | 272-273 `FindMyWay.Instance<FindMyWay.HTTPVersion.V1>` | `FindMyWay.Instance<RouteRecord>` | the shim's router is generic over the store; the package's typings are generic over the HTTP version (node-compat has no http2 server). |
| `router/route-table.ts` | 289-290 `FindMyWay(routerOptions)` | `FindMyWay<RouteRecord>(routerOptions)` | names the store type at construction. |
| `router/route-table.ts` | 347 `router.on(routerMethod as any, ...)` | `routerMethod as FindMyWay.HTTPMethod` | `any` is refused by geatsc; the method is one of the shim's `HTTPMethod` union (the registration is in a try/catch that falls back on a throw, as upstream). |
| `router/route-table.ts` | 399 `router: FindMyWay.Instance<FindMyWay.HTTPVersion.V1>` | `FindMyWay.Instance<RouteRecord>` | as 272-273. |
| `router/route-table.ts` | 403 `router.find(method as any, path)` | `router.find(method, path)` | the shim's `find` takes the method as a string, as the package's runtime does. |
| `router/route-table.ts` | 410-411 `result.store as RouteRecord` / `result.params as Record<string, string>` | `result.store` / `result.params` | typed by the generic result (`RouteRecord`, narrowed by the `null` check above; `{ [name: string]: string \| undefined }`). |
