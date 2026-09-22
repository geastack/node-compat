# node-compat

Compiles Node.js HTTP apps — using the `node:http` API and the `hono` npm
library — to native macOS/Linux binaries with
[geatsc](https://github.com/geastack/compiler), and checks the result against
Node.

The same TypeScript file runs under Node and compiles to a native binary. A
raw-socket test battery compares the two byte-for-byte.

## Headline results

- **Full-stack Gea + Hono + MongoDB:** the todo application compiles the Gea
  frontend, Hono, the MongoDB package's typed Gea entry, BSON, and the
  node-compat runtime into one native executable. Its deterministic HTTP test
  passes create, persisted read, update, persisted read, delete, and final
  absence. The native driver reuses a client-owned TCP pool and measured 1.07×
  the official Node.js driver on the tracked sequential CRUD benchmark. A
  2.94-million-request HTTP stress run kept the native server at 22.4 MiB peak
  RSS versus Node's 296.8 MiB maximum observed sample. See
  [the application documentation](apps/hono-mongodb-todo/README.md).
- **Correctness:** 38/38 scenarios byte-identical to Node v24
  ([apps/http-parity](apps/http-parity)) — request header parsing with Node's
  exact joining rules, content-length + chunked bodies (extensions, trailers,
  1 MB payloads), `Expect: 100-continue`, keep-alive + pipelining ordering,
  HTTP/1.0 close-delimited semantics, HEAD/1xx/204/304 framing, implicit
  Content-Length vs `writeHead`→chunked, streaming writes, async handlers,
  real timers, statusMessage, set-cookie arrays, the header API surface,
  events, and Node-identical 400/431 error responses to malformed input.
- **Throughput** (8-core Xeon E3-1231 v3, `wrk`, 2 rounds x 8 s, against Node
  v24.18.0, measured 2026-09-19):

  | server             | `GET /` req/s | `/json` req/s | p50 / p99         | peak RSS |
  | ------------------ | ------------- | ------------- | ----------------- | -------- |
  | **gea, 1 worker**  | **110,624**   | **110,312**   | 594 us / 1.11 ms  | 6 MB     |
  | axum, 1 thread     | 119,798       | 126,280       | 549 us / 605 us   | 5 MB     |
  | node, 1 worker     | 37,342        | 37,954        | 1.70 ms / 2.07 ms | 91 MB    |
  | **gea, 8 workers** | **265,183**   | **265,624**   | 123 us / 4.30 ms  | 35 MB    |
  | axum, 8 threads    | 219,927       | 223,387       | 214 us / 1.45 ms  | 6 MB     |
  | node, 8 workers    | 124,762       | 124,638       | 370 us / 3.34 ms  | 685 MB   |

  Single-threaded, that is 92% of axum (a Rust framework doing the same full
  protocol flow) and 3.0x Node, using 6 MB against Node's 91 MB. Across eight
  workers it is 2.1x Node and ahead of axum. The eight-worker servers share
  CPUs with the load generator, so those rows are host-limited rather than a
  ceiling. Full measured history in [BENCHMARKS.md](BENCHMARKS.md).

## npm package

The compiler depends on `@geastack/node-compat` and resolves its exported
build driver automatically when you run `geatsc` in a Node project, so an
application never needs a sibling source checkout.

The package ships `plugin/`, `runtime/` and `scripts/build.mjs`; the example
applications and the benchmarks are not included. Its optional compiler peer
supplies the compiler API when the target is used, rather than installing a
second compiler as a runtime dependency.

## Quick start

In your own project, add the package and point the build driver at a server
file. Node 22 or newer is required for TypeScript type stripping.

```sh
npm install @geastack/node-compat
npx geatsc-node build server.ts
./dist/server                        # → listening on http://127.0.0.1:3000
```

To work on this repository instead, build the compiler first
(`npm run build` in a `geastack/compiler` checkout), then drive the bundled
applications directly:

```sh
npm --prefix apps/hono-hello install   # hono, for the hono apps only

node scripts/build.mjs apps/raw-http-hello/server.ts
./apps/raw-http-hello/dist/server

# the Node-parity battery
node scripts/build.mjs apps/http-parity/server.ts
node apps/http-parity/driver.mjs apps/http-parity/dist/server apps/http-parity/server.ts
# → 36/36 parity, 0 diffs
```

### Build behaviour

A library is compiled from its typed `.ts` source automatically, with no flag.
The compiler acquires the source for the exact installed version and caches it
under `node_modules/.cache/geatsc/sources`, restoring the generics `tsc`
erased so the library's hot path monomorphizes to fully typed C++ (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- `--debug` builds at `-O0 -g` for lldb. Optimized builds are stripped and
  link-time optimized, at `-Os` under `clang++` (the `CXX` default) and `-O2`
  under g++, because the right level depends on the compiler. Measured on the
  bench host (clang 18, four pinned workers, compiler 1.0.17): `-Os -flto` is
  level with `-O2 -flto` on the raw HTTP server (307-320k vs 304-308k req/s,
  inside the round-to-round spread) and 5-7% faster on the compiled Hono app
  (150-152k vs 141-144k), at binaries about a third smaller (1.05 MB / 5.04 MB
  against 1.64 MB / 7.27 MB) and less memory — Hono runs more instructions at
  `-Os` but fewer cycles, so its hot path is instruction-cache bound.
  `-O3` buys nothing on either compiler. g++ 13 is the other way round (`-Os`
  costs 25%) and is 4-10% behind clang on the same emitted source, so the
  published numbers are clang's. `GEA_OPT_LEVEL` overrides the level,
  `GEA_LTO=0` drops the LTO.
- Binaries link with hidden visibility and dead-stripping
  (`-fvisibility=hidden`, `-Wl,-dead_strip` / `--gc-sections`). OpenSSL is
  linked only when the program reaches `node:crypto`; a server that never
  hashes anything maps no `libcrypto` (measured: 0.45 MB of PSS per process).

Every figure above and its history is in [BENCHMARKS.md](BENCHMARKS.md).

## Layout

- **[runtime/gea_node.cpp](runtime/gea_node.cpp)** — the native layer: a
  single-threaded reactor (epoll on Linux, poll fallback), a full HTTP/1.x
  request parser, per-connection response streaming, reactor-integrated
  timers, and a size-class pool allocator (Linux).
- **[runtime/node/](runtime/node)** — `node:http` and `node:events` written in
  TypeScript and compiled by geatsc itself, sitting on the reactor through a
  small intrinsic surface. Response serialization matches Node byte-for-byte;
  hot-path listener storage is fully typed (native `std::function` slots — no
  dynamic-value boxing).
- **[apps/http-parity/](apps/http-parity)** — the proof of completeness: one
  app file, two runtimes, byte-diffed responses.
- **[apps/cluster-hello/](apps/cluster-hello)** — the `node:cluster` parity
  probe: the same file forks workers under Node and natively; workers that
  die are replaced, workers told to leave are not, SIGTERM to the primary
  leaves no orphans. Output matches Node's run line for line.
- **[apps/raw-http-hello/](apps/raw-http-hello)** — the benchmark app, plus
  the Rust comparison servers (raw hyper and full-flow axum, single- and
  multi-threaded) under `rust-server/`.
- **[apps/hono-hello/](apps/hono-hello)** — Hono's full default router stack
  served natively over the `node:http` bridge; the build compiles Hono from its
  typed source, giving the monomorphized zero-boxing variant. Its parity test covers JSON and multipart
  POST bodies as well as GET routing.
- **[apps/hono-mongodb-todo/](apps/hono-mongodb-todo)** — the full-stack Gea
  frontend, Hono server, and native MongoDB application, including driver
  architecture, validation, pool behavior, and Node/Rust/C++ benchmark docs.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit, the
  dispatch contract, and the performance engineering notes.
- **[BENCHMARKS.md](BENCHMARKS.md)** — the full measured history, oldest to
  newest, including negative results.

## Known deviations from Node

These are intentional. The header of
[runtime/node/http.ts](runtime/node/http.ts) documents each one.

- A throwing request handler is isolated to a 500 + connection close. Node
  kills the process on the same error (`uncaughtException`).
- Request/response listeners compile to native closures with no JS function
  identity, so `removeListener(name, fn)` on req/res cannot match a specific
  listener — use `removeAllListeners(name)`.
- Request `set-cookie` duplicates join with `", "` instead of becoming an
  array (`req.headers` stays a string→string map); `getHeader` returns
  multi-value headers joined with `", "`.
- `writeHead(status, statusMessage, headers)` 3-arg form is unsupported — set
  `res.statusMessage` instead.
- Bodies are byte-preserving strings, not Buffers; chunk trailers are parsed
  and discarded; `res.req` is not provided.
- `node:cluster` ([runtime/node/cluster.ts](runtime/node/cluster.ts)) forks
  real worker processes (a re-exec of the binary; `isPrimary`/`isWorker`,
  `fork(env)`, `worker.id/process.pid`, `kill`/`disconnect`, `'online'`,
  `'exit'` with Node's `(code, signal)` null encoding, `exitedAfterDisconnect`,
  `cluster.disconnect()`) and connections are distributed by the kernel through
  SO_REUSEPORT listeners — Node's `SCHED_NONE`; `schedulingPolicy` is
  accepted and ignored. There is **no IPC channel**: `worker.send` /
  `process.send` throw, `'message'` never fires, `'listening'` is not emitted,
  and `'online'` is emitted by the primary right after the fork. A worker
  exits when the primary dies (a liveness pipe closes), like Node's
  `'disconnect'`.
- `process.pid`, `process.ppid`, `process.exit(code)`, `os.availableParallelism()`
  and `os.cpus()` (count-only entries) are provided for the cluster shape.

## Status

- `node:http` server surface: **complete and parity-proven** (see above).
- `node:cluster`: forking, replacement, signals and orderly shutdown proven
  natively against Node's output with `apps/cluster-hello` (0 refusals; the
  66 boxed carriers are EventEmitter's deliberate `any[]` argument boundary).
- hono: the full default router stack compiles from typed source and serves
  GET, JSON POST, URL-encoded forms and multipart forms with binary `File`
  parts. Routes, the 404/compose middleware path, status codes, and response
  headers (`application/json`, hono's own `charset=UTF-8`) are correct. The
  build's router is monomorphized (`SmartRouter`, `RegExpRouter`
  and `TrieRouter`, with `std::tuple` route storage and no boxed handlers at
  rest).
- MongoDB todo: compiles and runs against a real local MongoDB server through
  BSON OP_MSG and a reusable native TCP pool. The supported Gea entry covers
  the app's direct-host CRUD surface; authentication, TLS, cluster topology,
  retry layers, and multi-batch cursors remain outside that surface.
- Compiler-feature regression apps: [apps/tuple-test](apps/tuple-test)
  (tuple monomorphization + the hono router/Result/entries shapes, byte-
  diffed vs node) and [apps/mapkeys-test](apps/mapkeys-test)
  (Object.keys/values/entries over dictionary storages).
- fastify: blocked on ~20 emitter codegen bugs; the `new Function` wall is
  already broken (a bounded runtime evaluator covers find-my-way's generated
  code — see `apps/newfn-test`).

## License

Apache-2.0 (see `LICENSE`). Use it, change it, ship closed-source products on
it, no strings attached. The only GeaStack code under a different license is
the embedded board support (`targets` and `@geastack/chips`, GPL-3.0-only):
shipping closed-source firmware through those needs a commercial license.
Contact [contact@geastack.com](mailto:contact@geastack.com) for commercial terms, support and hosted builds.
