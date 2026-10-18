# Edits against upstream (nestjs/nest `feat/platform-node` @ 2b10fb2)

Policy: the vendored files are edited only where the whole-program `strict`
checking of this target rejects code platform-node compiles under its own
`noImplicitAny: false` / `useUnknownInCatchVariables: false` tsconfig, and
each edit is listed here with the upstream line. Behaviour is unchanged.

| File | Upstream line | Edit | Why |
|---|---|---|---|

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

## Certification typing

geatsc certifies only what it can type statically: no `any` that is read
dynamically, no object built through a reassigned `function () {}` prototype,
no `Object.assign` onto an Error, no `instanceof` against a typed-array
constructor, no `Array.from` with a mapping callback, and a missing key of a
map typed `{ [name: string]: string }` reads as the empty string. These edits
type what the package left dynamic; behaviour is unchanged except where a
row says so.

| File | Upstream line | Edit | Why |
|---|---|---|---|
| `router/route-table.ts` | 11-21, 39-43 `params: Record<string, any>` | `params: RouteParams`, a new exported interface `{ [name: string]: string \| string[] }` | the shapes path-to-regexp and find-my-way produce: a string per parameter, a string array per wildcard. |
| `router/route-table.ts` | 54-55 `const ParamsObject = function () {} as unknown as new () => Record<string, any>; ParamsObject.prototype = Object.create(null);` and 444 `new ParamsObject()` | removed; `const params: RouteParams = {}` | a constructor made from a function with a reassigned prototype has no runtime conversion; a compiled map has no prototype to pollute, so a null-prototype object buys nothing here. |
| `router/route-table.ts` | 58 `Array.from({ length: 32 }, (_, i) => \`p${i}\`)` | a `for` loop pushing the 32 names | `Array.from`'s mapping callback is called with `(undefined, index)` by the runtime, which does not match the `(value, number)` callable. |
| `router/route-table.ts` | 64 `type Matcher = ... { params: Record<string, any> }` and 153 `exceedsMaxParamLength(params: Record<string, any>, ...)` | `RouteParams` | as 11-21. |
| `router/route-table.ts` | 92 `return (pathname: string) => matcher(pathname) as any;` | `return matcher;` | the path-to-regexp shim's match function already has the `Matcher` shape; the `as any` erased it. |
| `router/route-table.ts` | 448-451 `params[names[i]] = ... : values[positionalName(i)]` | the value is assigned only when defined | `RouteParams` has no `undefined`; find-my-way fills every positional parameter of a route it matched, so no key is left out in practice. |
| `router/node-router.ts` | 15 `type PathMatcher = ... params: any` | `params: RouteParams` (imported) | as route-table 11-21. |
| `adapters/node-request.ts` | 5 `import { parse as parseQueryString } from 'fast-querystring';` | adds `type ParsedQuery` | the query's static type (below). |
| `adapters/node-request.ts` | 11 | adds `import type { RouteParams } from '../router/route-table.js';` | the params' static type (below). |
| `adapters/node-request.ts` | 33-41 `const NODE_APP = Object.freeze({ get(setting: string): unknown {...} })` and 211 `get app(): { get(setting: string): unknown }` | `class NodeApp { get(setting) {...} }`, `Object.freeze(new NodeApp())`, `get app(): NodeApp` | a method of an object literal is a function-valued property, which has no runtime conversion to its declared return type; a class method does. |
| `adapters/node-request.ts` | 104 `declare params: Record<string, any>;` | `declare params: RouteParams;` | as route-table 11-21. |
| `adapters/node-request.ts` | 108 `declare body: any;` and 229-233 `Object.defineProperty(NodeRequest.prototype, 'body', { value: undefined, writable: true, configurable: true })` | `body: any = undefined;` (a field) | `Object.defineProperty` on a class prototype is not lowered; a compiled instance has the slot in its layout, so the field costs no per-request property write. `'body' in req` stays true. |
| `adapters/node-request.ts` | 119, 124, 135 `Record<string, any>` for `[QUERY]`, `get query()`, `set query()` | `ParsedQuery` (`{ [key: string]: string \| string[] }`) | what fast-querystring's `parse` returns; a map of `string \| string[]` has no runtime conversion to a map of `any`. |
| `adapters/node-request.ts` | 690-693 `return view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)` | `return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)` | `instanceof Uint8Array` has no runtime helper. Behaviour: a `Uint8Array` body is sent through a new view over the same bytes rather than itself; the bytes written are the same. |
| `adapters/node-request.ts` | 386 `const text = JSON.stringify(body);` | `const text: string \| undefined = JSON.stringify(body);` | the lib types `JSON.stringify` as returning `string`; it returns `undefined` for an undefined body. The compiled program reads a cell typed `string` as present and throws for the absent result (`res.json(req.body)` with no body: a 500). Node's behaviour is unchanged. |
