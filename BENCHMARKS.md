# geatsc-node HTTP benchmarks

The same TypeScript HTTP servers, compiled to native binaries by geatsc through
node-compat, measured against Node.js and against C++ and Rust servers that
answer the same routes with the same bytes on the wire. Every number below
comes from one run on one idle machine with one harness; the raw `wrk` output
for every sample is in `bench/results/http-box-2026-09-20-clean4.json` and
`bench/results/http-box-2026-09-20-clean4-startup.json`.

The gea binaries in this run were emitted by `@geastack/compiler@1.0.15` and
`@geastack/node-compat@1.0.11` **installed from the npm registry**, not from a
local checkout: `npm ci` against the committed lockfile, zero symlinks in
`node_modules/@geastack`. What is measured here is what a reader gets by
installing the published packages.

## What is measured

Two applications, each compiled by geatsc and each also run under Node:

- **Hono** (`apps/hono-hello/server.ts`): the real `hono` package with the
  default `SmartRouter` stack, served through `@hono/node-server`. Under
  geatsc the `serve` import resolves to node-compat's native answer for that
  package (`runtime/node/hono-node-server.ts`), so a request goes reactor →
  `Request` → `app.fetch` → wire with no intermediate Node objects. The app
  file is unchanged between the two runtimes.
- **Raw `node:http`** (`apps/raw-http-hello/server.ts`): `createServer((req,
  res) => ...)`, `writeHead`, `end`. Under geatsc this is node-compat's
  `IncomingMessage`/`ServerResponse` implementation over the C++ reactor.

Controls answering the identical raw routes with byte-identical responses,
validated by the harness before any sample is taken (48 wire-contract checks,
202 bytes for `/` and 206 for `/json`):

- **cpp-epoll**: a hand-rolled single-file epoll server
  (`apps/raw-http-hello/cpp-server/server.cpp`). No HTTP framework, no
  general request parsing. This is the ceiling, not a peer.
- **cpp-drogon**: the Drogon C++ web framework
  (`apps/raw-http-hello/drogon-server/main.cc`).
- **rust-hyper**: hyper 1.x on tokio (`rust-server/src/main.rs`).
- **rust-axum**: axum 0.8 with extractors and a Date middleware
  (`rust-server/src/bin/axum-http-hello.rs`).

Routes: `GET /` returns `text/plain`, `GET /json` returns
`{"hello":"world"}`. Hono additionally serves `/missing` as a 404, which the
harness checks.

## Machine and method

- Dedicated benchmark host: 8 logical CPUs, Intel(R) Xeon(R) CPU E3-1231 v3 @ 3.40GHz, Linux, otherwise idle.
- Node v24.21.0 (Krypton, the current LTS) for the Node rows. geatsc binaries built with `g++ -O2
  -std=c++20` from the shared `compiler/dist`.
- Harness: `bench/http-matrix.py`. A single-worker server is pinned to CPU 0,
  a four-worker server to CPUs 0-3, and `wrk` always to CPUs 4-7 with
  `--latency -t4 -c64`, keep-alive, 8-second samples after a 2-second warmup.
  Two interleaved rounds per server, worker count and route.
- **Why four workers and not eight.** This host has eight logical CPUs but
  only **four physical cores**, with hyperthread siblings paired as 0-1, 2-3,
  4-5 and 6-7. Pinning the server to 0-3 and `wrk` to 4-7 gives each two
  physical cores that the other never touches. Spreading the server across all
  eight logical CPUs instead puts it on the same silicon as the load
  generator: total utilisation reaches 7.2 of 8 logical CPUs and the
  measurement becomes host-limited rather than server-limited. It does not
  merely add noise, it *inverts the ranking* -- going from four workers to
  eight, rust-hyper falls from 264k to 239k and cpp-epoll from 365k to 322k,
  both while being scheduled onto fewer CPUs, whereas the slower gea-raw keeps
  climbing to 266k and appears to overtake them. Earlier revisions of this
  document quoted that eight-worker cell and reported gea-raw passing hyper and
  axum. That result was an artefact of saturation and has been withdrawn.
  `--server-cpus` selects the pinning; the default remains `0-7` for
  compatibility and should not be used for comparisons on this box.
- Four workers means `GEA_WORKERS=4` reuseport processes for gea,
  `node:cluster` with 4 workers for Node, 4 event-loop threads for Drogon and
  4 tokio worker threads for the Rust servers. The C++ and Rust controls are
  built on the benchmark host (`cargo build --release` from the tracked
  `Cargo.lock` for the Rust servers).
- Memory is peak RSS and PSS of the whole server process group while
  serving. PSS divides pages shared through fork by their sharer count and is
  the honest footprint of a multi-process fleet.
- Startup is the time from spawn to the first correct `GET /` response,
  averaged over five fresh launches per server and worker count, measured in
  a separate pass with no load running.

## Results

### Throughput, memory, startup

| Server | Single `/` | Single `/json` | Single RSS MiB | Single PSS MiB | Single startup ms | 4 workers `/` | 4 workers `/json` | 4 workers RSS MiB | 4 workers PSS MiB | 4 workers startup ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **hono-gea** | **51,951** | **39,759** | 9.5 | 6.6 | 7 | **126,677** | **104,700** | 33.1 | 8.8 | 7 |
| hono-node | 17,533 | 15,948 | 109.5 | 106.1 | 89 | 40,899 | 37,490 | 454.9 | 258.6 | 166 |
| **gea-raw** | **100,490** | **100,640** | 6.2 | 3.3 | 6 | **238,716** | **238,965** | 19.1 | 5.1 | 6 |
| node-raw | 35,342 | 35,429 | 85.0 | 81.7 | 70 | 77,370 | 77,245 | 380.0 | 185.9 | 145 |
| cpp-drogon | 116,983 | 117,337 | 12.9 | 7.5 | 11 | 243,122 | 242,264 | 13.1 | 7.6 | 11 |
| rust-axum | 115,514 | 118,402 | 4.5 | 2.8 | 6 | 223,606 | 227,142 | 5.4 | 3.4 | 6 |
| rust-hyper | 143,343 | 145,456 | 3.6 | 1.8 | 6 | 263,697 | 270,416 | 4.2 | 2.2 | 6 |
| cpp-epoll | 198,146 | 201,414 | 3.8 | 1.0 | 6 | 364,753 | 364,522 | 10.8 | 1.9 | 6 |

Requests per second are the mean over rounds. Memory is the peak over the
run. Startup is the mean of five launches.

### Latency

`wrk` percentiles from the last round of each cell, `GET /`.

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| hono-gea | 1.17 ms | 1.27 ms | 495 µs | 1.31 ms |
| hono-node | 3.52 ms | 4.02 ms | 1.52 ms | 2.12 ms |
| gea-raw | 662 µs | 781 µs | 263 µs | 581 µs |
| node-raw | 1.78 ms | 1.99 ms | 806 µs | 1.12 ms |
| cpp-drogon | 541 µs | 629 µs | 258 µs | 570 µs |
| rust-axum | 577 µs | 621 µs | 286 µs | 496 µs |
| rust-hyper | 438 µs | 481 µs | 238 µs | 411 µs |
| cpp-epoll | 305 µs | 636 µs | 85 µs | 186 µs |

### Ratios

Four workers, `GET /` — server and load generator on disjoint physical cores.

| Comparison | Ratio |
| --- | ---: |
| gea-raw vs node-raw | 3.09× |
| gea-raw vs rust-axum | 1.07× |
| gea-raw vs cpp-drogon | 0.98× |
| gea-raw vs rust-hyper | 0.91× |
| gea-raw vs cpp-epoll (hand-rolled ceiling) | 0.65× |
| hono-gea vs hono-node | 3.10× |
| hono-gea vs node-raw (framework vs bare Node) | 1.64× |
| hono-gea memory vs hono-node (PSS) | 1/29 |
| gea-raw memory vs node-raw (PSS) | 1/36 |

Single worker, `GET /`: gea-raw 100k vs node-raw 35k (2.84×), axum 116k
(0.87×), Drogon 117k (0.86×), hyper 143k (0.70×), epoll 198k (0.51×).
hono-gea 52k vs hono-node 18k (2.96×). **The single-worker cell has a wide
error bar — see the instability note — and the ratios against the compiled
controls should not be quoted from it.**

## Reading the result

- **The compiled `node:http` app sits with the compiled-language servers.**
  At four workers it passes axum by 7%, is level with Drogon within 2%, trails
  hyper by 9%, and reaches 65% of a hand-written epoll loop that does no HTTP
  framing. It is 3.09× Node running the same file, at a thirty-sixth of the
  memory, and starts in 6 ms against 145 ms.
- **A compiled framework beats bare Node.** hono-gea serves 127k requests per
  second against raw `node:http`'s 77k — 1.64× — while Hono on Node manages
  41k. The whole Hono stack compiled is faster than Node running no framework
  at all.
- **Hono compiled is 3.1× Hono on Node** at both worker counts. The
  framework's own per-request work (Context, Response, Headers, router) is the
  entire remaining gap between the Hono row and the raw row. Nothing in Hono
  or `@hono/node-server` was modified.
- **Memory is the widest honest margin.** At four workers the gea fleet holds
  19.1 MB RSS / 5.1 MB PSS to serve 239k requests per second; the Node cluster
  holds 380 MB / 186 MB to serve 77k. PSS divides pages shared through fork by
  their sharer count, so the 1/36 figure is the one that survives scrutiny.
- **Startup is the least noisy margin.** 6-7 ms against 70-166 ms, and the gea
  figure does not grow with worker count while Node's roughly doubles from one
  worker to four.
- **Latency.** At four workers gea-raw's p50 is 263 µs against Drogon's 258 µs
  and hyper's 238 µs; its p99 of 581 µs sits between Drogon's 570 µs and
  axum's 496 µs. Node's raw p99 is 1.12 ms and Hono-on-Node's 2.12 ms. The
  epoll control is in another class at 85 µs p50.
- **Where the remaining gap to hyper is.** Both servers are at the syscall
  floor — one read and one write per request, epoll batched around 32 events
  per wait — so the difference is entirely user-space. A perf profile of
  gea-raw is flat, with no symbol above 4%, and roughly 16% of CPU in
  `std::string` operations and `gea::node::alloc`. The host boundary passes
  method, url, httpVersion, rawHead and body as five `std::string` values per
  request, which `IncomingMessage` then copies again into its fields; hyper
  never materialises those, keeping headers as slices into the read buffer.
  That is the cost to remove, and it is a packaging problem in the node-compat
  layer rather than anything about the reactor.
- **The single-worker cell is unstable, and the instability is per process.**
  Six freshly launched gea-raw processes measured 111.9k, 111.8k, 109.6k,
  87.7k, 106.5k and 116.0k on `GET /`. Two samples taken from the *same*
  process agree within 1-3%, so a process is fast or slow for its whole life
  rather than sample to sample — a 34% spread across processes. Launching
  under `setarch -R` to disable address-space randomisation collapses that
  spread to 8% (98.1k-106.1k), which identifies heap layout as the cause: the
  hot per-request allocations sometimes land in colliding cache sets. The
  controls do not show this — six rust-hyper processes spanned 140.8k-148.1k,
  a 5% spread. It is the same root cause as the throughput gap; an
  allocation-light hot path would not be layout-sensitive. Averaging over four
  worker processes is why the four-worker cell is stable to 1-3%.

## Reproducing

Run on an otherwise idle Linux host with at least eight logical CPUs. The
harness uses `taskset`, `/proc` and `lscpu`, so it does not run on macOS.
Ports 3000 (Node Hono), 3101 (raw servers) and 3900 (gea Hono) must be free.

Requirements: Node.js and the repository's npm dependencies, Python 3, `wrk`,
`util-linux`, a C++20 compiler, Rust and Cargo, and for Drogon its
development libraries (Drogon, Trantor, jsoncpp, OpenSSL, zlib, uuid).

The compiler can come from the registry or from a checkout. This run used the
registry, which is the path a reader can reproduce without building anything:

```sh
npm ci                                                  # @geastack/compiler + @geastack/node-compat from npm
CXX=g++ bash bench/goal-http-build.sh                   # gea servers + C++ and Rust controls
```

`goal-http-build.sh` resolves the compiler through
`require.resolve('@geastack/compiler/package.json')`, so it picks up the
installed package with no further configuration. Verify there is no local
shortcut in play before believing a number:

```sh
find node_modules/@geastack -maxdepth 1 -type l          # must print nothing
node -p "require('@geastack/compiler/package.json').version"
```

From a checkout instead, build the shared compiler once and let the same
script emit the servers. The gea servers are emitted by the one
`compiler/dist`; never a private compiler build.

```sh
cd /path/to/geastack/compiler && npm run build && cd ../node-compat
node scripts/build.mjs apps/hono-hello/server.ts        # -> apps/hono-hello/dist/server
node scripts/build.mjs apps/raw-http-hello/server.ts    # -> apps/raw-http-hello/dist/server
CXX=g++ bash bench/goal-http-build.sh
```

Throughput, latency and memory, two rounds, then the separate startup pass:

```sh
python3 bench/http-matrix.py --output bench/results/http-local.json \
  --rounds 2 --duration 8s --workers 1 4 --gea-dist dist --server-cpus 0-3
python3 bench/http-matrix.py --output bench/results/http-local-startup.json \
  --rounds 5 --workers 1 4 --gea-dist dist --server-cpus 0-3 --startup-only
python3 bench/summarize-http-matrix.py bench/results/http-local.json \
  --startup-result bench/results/http-local-startup.json
```

`--server-cpus` must name physical cores the load generator does not share;
check `/sys/devices/system/cpu/cpu*/topology/thread_siblings_list` before
choosing, because sibling numbering differs between machines and the wrong
choice silently measures a saturated host. `--servers` narrows a run to any of `hono-gea`, `hono-node`, `gea-raw`,
`node-raw`, `cpp-drogon`, `rust-axum`, `rust-hyper`, `cpp-epoll`. The result
JSON keeps every raw `wrk` report, the percentile latencies, peak RSS and PSS
per process, startup samples, machine metadata, artifact SHA-256 hashes and
the wire-contract validation record.

Three things that bit these runs and are worth knowing. A binary copied from
a Mac is a Mach-O file that Linux reports as a shell syntax error when
executed, so rebuild the Rust controls with `cargo build --release` on the
host. A `wrk` report against a port nobody listens on looks like a very slow
server rather than an error, which is why the harness validates every
server's responses before sampling it. And a sibling symlink into a
`@geastack` checkout hides packaging defects that only a registry install
reveals: a symlinked package.json is read as a plain file, so an `exports`
map that omits `"./package.json"` never fails locally and fails for every
real consumer.
