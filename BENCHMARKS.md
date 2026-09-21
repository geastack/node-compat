# geatsc-node HTTP benchmarks

The same TypeScript HTTP servers, compiled to native binaries by geatsc through
node-compat, measured against Node.js and against C++ and Rust servers that
answer the same routes with the same bytes on the wire. Every number below
comes from one run on one idle machine with one harness; the raw `wrk` output
for every sample is in `bench/results/http-box-2026-09-21-npm-1.0.16.json` and
`bench/results/http-box-2026-09-21-npm-1.0.16-startup.json`.

**Provenance.** The gea binaries in this run were built from the registry:
`npm ci` installed `@geastack/compiler@1.0.16` and
`@geastack/node-compat@1.0.12` with no symlink under `node_modules/@geastack`,
and the runtime and plugin the build read are byte-identical to the published
node-compat tarball. The previous releases (`@geastack/compiler@1.0.15`,
`@geastack/node-compat@1.0.11`) reproduce the previous run
(`http-box-2026-09-20-clean4.json`: gea-raw 100k single, 239k at four
workers). `http-box-2026-09-21.json` is the same day's pre-release run of this
code from a checkout and agrees with this one.

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
validated by the harness before any sample is taken (72 wire-contract checks,
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
  -std=c++20` by the registry compiler named under Provenance.
- Harness: `bench/http-matrix.py`. A single-worker server is pinned to CPU 0,
  a four-worker server to CPUs 0-3, and `wrk` always to CPUs 4-7 with
  `--latency -t4 -c64`, keep-alive, 8-second samples after a 2-second warmup.
  Three interleaved rounds per server, worker count and route.
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
| **hono-gea** | **60,802** | **48,242** | 11.1 | 7.5 | 7 | **139,551** | **115,693** | 36.8 | 9.4 | 7 |
| hono-node | 17,101 | 15,759 | 108.5 | 105.1 | 85 | 40,885 | 37,678 | 455.2 | 259.1 | 166 |
| **gea-raw** | **153,188** | **154,956** | 7.4 | 3.8 | 6 | **301,147** | **304,376** | 22.2 | 5.2 | 6 |
| node-raw | 35,214 | 35,224 | 89.1 | 85.8 | 71 | 77,168 | 77,999 | 380.3 | 186.1 | 137 |
| cpp-drogon | 110,374 | 109,917 | 12.9 | 7.5 | 11 | 242,493 | 241,906 | 13.1 | 7.7 | 11 |
| rust-axum | 118,672 | 122,102 | 4.5 | 2.8 | 6 | 217,092 | 222,754 | 5.2 | 3.3 | 6 |
| rust-hyper | 143,427 | 146,405 | 3.6 | 1.9 | 6 | 271,436 | 276,252 | 4.4 | 2.4 | 6 |
| cpp-epoll | 199,155 | 200,411 | 3.8 | 1.0 | 6 | 365,733 | 365,547 | 10.7 | 1.9 | 6 |

Requests per second are the mean over rounds. Memory is the peak over the
run. Startup is the mean of five launches.

### Latency

`wrk` percentiles from the last round of each cell, `GET /`.

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| hono-gea | 1.06 ms | 2.11 ms | 502 µs | 1.24 ms |
| hono-node | 3.69 ms | 6.71 ms | 1.66 ms | 3.63 ms |
| gea-raw | 398 µs | 811 µs | 173 µs | 533 µs |
| node-raw | 1.85 ms | 2.14 ms | 796 µs | 1.70 ms |
| cpp-drogon | 588 µs | 696 µs | 275 µs | 610 µs |
| rust-axum | 585 µs | 617 µs | 291 µs | 494 µs |
| rust-hyper | 454 µs | 492 µs | 224 µs | 388 µs |
| cpp-epoll | 300 µs | 612 µs | 85 µs | 184 µs |

### Ratios

Four workers, `GET /` — server and load generator on disjoint physical cores.

| Comparison | Ratio |
| --- | ---: |
| gea-raw vs node-raw | 3.90× |
| gea-raw vs rust-axum | 1.39× |
| gea-raw vs cpp-drogon | 1.24× |
| gea-raw vs rust-hyper | 1.11× |
| gea-raw vs cpp-epoll (hand-rolled ceiling) | 0.82× |
| hono-gea vs hono-node | 3.41× |
| hono-gea vs node-raw (framework vs bare Node) | 1.81× |
| hono-gea memory vs hono-node (PSS) | 1/28 |
| gea-raw memory vs node-raw (PSS) | 1/36 |

Single worker, `GET /`: gea-raw 153k vs node-raw 35k (4.35×), axum 119k
(1.29×), Drogon 110k (1.39×), hyper 143k (1.07×), epoll 199k (0.77×).
hono-gea 61k vs hono-node 17k (3.56×).

**How firm the hyper comparison is.** Three rounds, two routes, six samples
per cell. At four workers the two distributions do not touch: gea-raw's six
samples span 292.2k-310.6k and rust-hyper's 264.3k-282.5k, so gea-raw's worst
sample is above hyper's best. That held in all three runs of this code taken
on 2026-09-21. At one worker this run does not overlap either -- gea-raw
152.4k-157.8k, hyper 140.1k-148.2k -- but the single-core cell is the noisy
one on this host: the two pre-release runs the same day had gea-raw anywhere
from 121k to 158k and hyper from 128k to 151k with identical binaries, and in
one of them hyper led on the mean. Read the single-worker cell as "level with
hyper or slightly ahead, clear of axum and Drogon", not as a settled win. The
measure that is not noisy is user-mode instructions per request (`perf stat
-e instructions:u` on the pinned server divided by `wrk`'s request count):
gea-raw 9,401, rust-hyper 12,054, cpp-epoll 2,531, and hono-gea 33,558. The
raw servers all spend the same ~14.7k kernel instructions per request on one
`recv` and one `send`, which is about two thirds of the request, so a 22%
userland advantage shows up as single digits of throughput; two back-to-back
instruction runs of the same gea-raw binary measured 160k and 145k requests
per second with the same instruction count, which is the size of the host's
own swing.

## Reading the result

- **The compiled `node:http` app leads the framework servers.** At four
  workers it passes hyper by 11%, Drogon by 24% and axum by 39%, and reaches
  82% of a hand-written epoll loop that does no HTTP parsing. It is 3.90× Node
  running the same file, at a thirty-sixth of the memory, and starts in 6 ms
  against 137 ms.
- **What `@geastack/node-compat@1.0.12` and `@geastack/compiler@1.0.16`
  changed (239k → 301k at four workers, 100k → 153k at one).** The response head is
  no longer built as a JavaScript string. `writeHead`/`setHeader`/`end` now
  stream status line, fields and framing straight into the connection's
  retained output buffer through `__gea_http_head_begin/field/end`; the
  framing decision (Content-Length, chunked, close-delimited, no-body), the
  `Date` line and the `Connection`/`Keep-Alive` tail are made natively, with
  the common tail cached per second; `end(text)` on a chunked response writes
  size line, payload and terminator in one append. Allocations per request
  fell from 23 to 15 and user-mode instructions from 10,657 to 9,401. The wire
  bytes are unchanged — the harness's 72 wire-contract checks and
  `bench/raw-http-correctness.py` (Node parity for plain, JSON, query, long
  URL, POST and pipelined requests) both pass. Hono's native adapter writes
  its head through the same path, which is where its 127k → 140k comes from.
- **What else is in these releases.** None of it is on the `GET` hot path, and
  the throughput above is the same with and without it, but it is what makes
  the release correct rather than only fast. The compiler no longer emits
  class hierarchies nothing names: a subclass whose base is an earlier class
  in the same file or a built-in is pruned like any other unreached
  declaration, so a program that imports only `node:process` stopped carrying
  node-compat's WHATWG stream classes (3,764 → 379 emitted C++ lines for that
  fixture; neither server here contains them any more). A `Buffer` held in an
  `any` answers `length`, `byteLength`, indexing and string concatenation
  natively (`body += chunk` in a `data` handler used to abort), and a
  `Readable` constructed paused no longer marks `'end'` as emitted before
  anyone listens, so an empty-body `POST` answers. `apps/http-parity` is
  byte-for-byte with Node on all 38 of its requests.
- **A compiled framework beats bare Node.** hono-gea serves 139k requests per
  second against raw `node:http`'s 77k — 1.81× — while Hono on Node manages
  41k. The whole Hono stack compiled is faster than Node running no framework
  at all.
- **Hono compiled is 3.4× Hono on Node** at four workers and 3.6× at one. The
  framework's own per-request work (Context, Response, Headers, router) is the
  entire remaining gap between the Hono row and the raw row. Nothing in Hono
  was modified.
- **Memory.** At four workers the gea fleet holds 22.2 MB RSS / 5.2 MB PSS to
  serve 301k requests per second; the Node cluster holds 380 MB / 186 MB to
  serve 77k. PSS divides pages shared through fork by their sharer count, so
  the 1/36 figure is the one that survives scrutiny. The Rust servers are
  smaller still (hyper 2.4 MB PSS).
- **Startup is the least noisy margin.** 6-7 ms against 71-166 ms, and the gea
  figure does not grow with worker count while Node's roughly doubles from one
  worker to four.
- **Latency.** At four workers gea-raw's p50 is 173 µs against hyper's 224 µs
  and Drogon's 275 µs, but its p99 of 533 µs is behind hyper's 388 µs and
  axum's 494 µs. At one worker its p50 (398 µs) is the best of the framework
  servers and its p99 (811 µs) is the worst of them -- hyper holds 492 µs --
  so the tail, not the median, is the open item. The epoll control is in
  another class at 85 µs p50.
- **Where the remaining distance to the epoll ceiling is.** Every server here
  is at the syscall floor — one read and one write per request — so the
  difference is entirely user-space, and a perf profile of gea-raw is flat
  with no symbol above 1.5%. What is left is the general `node:http` object
  model the control does not have: an `IncomingMessage` and a
  `ServerResponse` per request, a header dictionary for `writeHead`, and the
  five request strings crossing the host boundary.

## Reproducing

Run on an otherwise idle Linux host with at least eight logical CPUs. The
harness uses `taskset`, `/proc` and `lscpu`, so it does not run on macOS.
Ports 3000 (Node Hono), 3101 (raw servers) and 3900 (gea Hono) must be free.

Requirements: Node.js and the repository's npm dependencies, Python 3, `wrk`,
`util-linux`, a C++20 compiler, Rust and Cargo, and for Drogon its
development libraries (Drogon, Trantor, jsoncpp, OpenSSL, zlib, uuid).

The compiler can come from the registry or from a checkout. The registry path
needs no compiler build, and is the install this document's gea servers were
built from:

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

Throughput, latency and memory, three rounds, then the separate startup pass:

```sh
python3 bench/http-matrix.py --output bench/results/http-local.json \
  --rounds 3 --duration 8s --workers 1 4 --gea-dist dist --server-cpus 0-3
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
