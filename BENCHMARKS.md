# geatsc-node HTTP benchmarks

The same TypeScript HTTP servers, compiled to native binaries by geatsc through
node-compat, measured against Node.js, against C++ and Rust servers that
answer the same routes with the same bytes on the wire, and against Vercel's
scriptc compiling the same file. Every number below comes from one run on one
idle machine with one harness; the raw `wrk` output for every sample is in
`bench/results/http-box-2026-09-22-final.json`,
`http-box-2026-09-22-final-startup.json` and `http-box-2026-09-22-final-1w.json`
(scriptc: `http-box-2026-09-22-scriptc.json` and its `-startup` file).

**Provenance.** The gea binaries were built by `bash bench/goal-http-build.sh`
in this checkout with `@geastack/compiler@1.0.16` installed from the registry
(`npm ci`, no symlink under `node_modules/@geastack`). The build script is the
one released as `@geastack/node-compat@1.0.14`: clang 18, `-Os -flto`,
stripped, no `libcrypto`. Raw server 1,822,696 bytes; Hono server 5,472,424
bytes. The C++ and Rust controls and the scriptc binaries were built on the
same host.

**Re-measured 2026-09-22 with `@geastack/compiler@1.0.17` and
`@geastack/node-compat@1.0.15`** (`http-box-2026-09-22-typed-listeners.json`
and its `-startup` file, same pinned protocol, hono-gea and gea-raw only):
raw server 1,048,424 bytes (−42%: function facts register at the sites that
mint a function object instead of a static initializer beside every thunk,
and the typed `request`/`connection` listeners via `@gea-exact-arms` drop
every http/net/events/stream class to keys-only reflection), Hono server
5,042,344 bytes. Throughput is unchanged within noise — gea-raw 315,255 /
319,656 at four workers and 161,619 / 162,299 at one, hono-gea 151,309 /
125,566 at four and 65,381 / 52,699 at one — and PSS is lower: gea-raw
3.7 MB (four workers) / 2.3 MB (one), hono-gea 7.1 MB / 5.0 MB. Startup is
the same 6 / 7 ms. The table below is still the 1.0.16 / 1.0.14 run, because
the controls were measured in it.

**What changed since the 2026-09-21 run** (`http-box-2026-09-21-npm-1.0.16.json`,
still in the repository): nothing in the runtime or the emitted C++. That run
said its binaries were built with `g++`; they were built with `clang++ 18`
(`scripts/build.mjs`'s default, which `bench/goal-http-build.sh` did not
share). The reproduce path now names the same compiler the numbers came from,
and the build flags were measured rather than assumed — see [Compiler and
flags](#compiler-and-flags). The result is 4% more throughput on the raw
server, 7% on Hono, 30% smaller binaries and 0.9-2 MB less PSS.

## What is measured

Three applications, each compiled by geatsc and each also run under Node:

- **Hono** (`apps/hono-hello/server.ts`): the real `hono` package with the
  default `SmartRouter` stack, served through `@hono/node-server`. Under
  geatsc the `serve` import resolves to node-compat's native answer for that
  package (`runtime/node/node-server-adapter.ts`), so a request goes reactor →
  `Request` → `app.fetch` → wire with no intermediate Node objects. The app
  file is unchanged between the two runtimes.
- **NestJS** (`apps/hello-nest/server.ts`): `@nestjs/core` 12.2.0 with a
  decorated controller, served through `@nestjs/platform-node`'s
  `NodeAdapter` over `node:http` (`tools/nest/build-platform-node.mjs` packs
  the three packages from the pinned nest commit). The Node row runs the
  `tsc` output of the same file (`dist-node/`), because Node's type stripping
  has no decorators or decorator metadata; the gea row is `scripts/build.mjs`
  on the file itself with the Nest AOT hook in `tools/nest/aot/`. The Nest
  logger is off in both.
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
- **scriptc-raw**: the raw server compiled by `scriptc@0.1.3`
  (vercel-labs), a static binary. scriptc has no `node:cluster`, so its
  four-worker row is four processes of a build with `listen({ port,
  reusePort: true })` (`bench/scriptc-cluster.sh`); the plain build cannot
  share the port (the second instance dies with `EADDRINUSE`). Its one-worker
  row is the unmodified file. It passes the same wire-contract checks.
  Against the `apps/http-parity` battery (38 raw-socket cases, Node v24 on
  the original file as the oracle) it passes 21 (2026-09-22,
  `bench/results/parity-scriptc-0.1.3-2026-09-22.txt`; gea 38/38 on compiler
  1.0.17, `parity-gea-1.0.17-2026-09-22.txt`). scriptc refuses the file as
  written with 11 errors (`parity-scriptc-0.1.3-as-written-errors-2026-09-22.txt`:
  no lowering for `res.on('finish')`, `setHeader(string[])`, `appendHeader`,
  `socket.remotePort`; the `any`-typed `'data'` chunk needs `--dynamic`;
  `string | string[] | undefined` header values cannot be concatenated; three
  strict-null errors), so its binary is `apps/http-parity/server.scriptc.ts`
  — type-level rewrites plus those three routes removed; Node on the variant
  vs Node on the original passes 35/38, exactly the removed routes
  (`bench/parity-node-variant.sh`). Its LLVM backend refused
  `req.httpVersion` and fell back to the C backend. The 14 real differences:
  HEAD responses carry a body (chunked, or Content-Length plus bytes); 204
  gets `Transfer-Encoding: chunked` and a terminating chunk; HTTP/1.0
  responses are chunked and `Connection: keep-alive` is honored; no `100
  Continue` is ever sent; duplicate request headers keep the last value
  instead of joining; `Transfer-Encoding: gzip`, a space in a header name and
  a 20 KB header are served as 200 (Node: 400/400/431); the 400s it does send
  add `Content-Length: 0`; and `String(undefined)` of an unmatched named
  capture group is `''`.

Routes: `GET /` returns `text/plain`, `GET /json` returns
`{"hello":"world"}`. Hono and Nest additionally serve `/missing` as a 404,
which the harness checks.

## Machine and method

- Dedicated benchmark host: 8 logical CPUs, Intel(R) Xeon(R) CPU E3-1231 v3 @
  3.40GHz, Linux, otherwise idle.
- Node v24.21.0 (Krypton, the current LTS) for the Node rows. geatsc binaries
  built with `clang++ 18 -std=c++20 -Os -flto`, stripped, by the registry
  compiler named under Provenance.
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
  document quoted that eight-worker cell. `--server-cpus` selects the pinning;
  the harness warns when a multi-worker run is started without it.
- **The single-worker cell is bimodal on this host.** With identical
  binaries, a pinned single core delivers two clusters of throughput roughly
  10% apart, for every server, from round to round (gea-raw 137-165k across
  eight rounds today, hyper 118-149k). Four-worker samples do not do this
  (gea-raw 311.6-314.9k across six). Read single-worker deltas under 10% as
  noise; the four-worker column is the one to rank by.
- Four workers means `GEA_WORKERS=4` reuseport processes for gea,
  `node:cluster` with 4 workers for Node, 4 event-loop threads for Drogon,
  4 tokio worker threads for the Rust servers and 4 reuseport processes for
  scriptc. The C++ and Rust controls are built on the benchmark host (`cargo
  build --release` from the tracked `Cargo.lock` for the Rust servers).
- Memory is peak RSS and PSS of the whole server process group while
  serving. PSS divides pages shared through fork by their sharer count and is
  the honest footprint of a multi-process fleet. Same-binary PSS moves by
  about 0.15 MB between runs at four workers; differences under that are
  nothing.
- Startup is the time from spawn to the first correct `GET /` response,
  averaged over five fresh launches per server and worker count, measured in
  a separate pass with no load running.

## Results

### Throughput, memory, startup

| Server | Single `/` | Single `/json` | Single RSS MiB | Single PSS MiB | Single startup ms | 4 workers `/` | 4 workers `/json` | 4 workers RSS MiB | 4 workers PSS MiB | 4 workers startup ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **hono-gea** | **67,653** | **53,645** | 8.1 | 5.2 | 7 | **149,642** | **124,169** | 27.9 | 7.3 | 7 |
| hono-node | 17,515 | 15,799 | 104.9 | 101.6 | 86 | 40,670 | 37,415 | 457.4 | 261.3 | 166 |
| **gea-raw** | **154,025** | **155,149** | 5.7 | 2.8 | 6 | **313,046** | **314,462** | 18.0 | 4.3 | 6 |
| node-raw | 34,906 | 35,144 | 85.7 | 82.3 | 72 | 76,813 | 77,207 | 377.2 | 182.9 | 137 |
| scriptc-raw | 51,144 | 52,417 | 2.7 | 0.9 | 6 | 116,887 | 118,783 | 9.3 | 1.5 | 6 |
| cpp-drogon | 123,255 | 124,292 | 12.9 | 7.4 | 11 | 243,009 | 243,388 | 13.1 | 7.6 | 11 |
| rust-axum | 124,646 | 127,552 | 4.6 | 2.8 | 6 | 224,744 | 229,885 | 5.6 | 3.6 | 6 |
| rust-hyper | 144,922 | 147,346 | 3.6 | 1.9 | 6 | 273,595 | 277,914 | 4.3 | 2.3 | 6 |
| cpp-epoll | 202,022 | 203,347 | 3.7 | 0.9 | 6 | 365,373 | 365,448 | 10.9 | 1.8 | 6 |

Requests per second are the mean over rounds. Memory is the peak over the
run. Startup is the mean of five launches. The scriptc row is a separate run
of the same harness on the same day (`--servers scriptc-raw`).

### Latency

`wrk` percentiles from the last round of each cell, `GET /`.

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| hono-gea | 0.96 ms | 1.01 ms | 429 µs | 0.91 ms |
| hono-node | 3.58 ms | 6.02 ms | 1.58 ms | 3.64 ms |
| gea-raw | 432 µs | 860 µs | 176 µs | 499 µs |
| node-raw | 1.75 ms | 2.04 ms | 744 µs | 1.54 ms |
| scriptc-raw | 1.22 ms | 1.41 ms | 522 µs | 1.09 ms |
| cpp-drogon | 527 µs | 1.04 ms | 197 µs | 788 µs |
| rust-axum | 530 µs | 569 µs | 283 µs | 489 µs |
| rust-hyper | 457 µs | 502 µs | 227 µs | 396 µs |
| cpp-epoll | 288 µs | 586 µs | 85 µs | 184 µs |

### Ratios

Four workers, `GET /` — server and load generator on disjoint physical cores.

| Comparison | Ratio |
| --- | ---: |
| gea-raw vs node-raw | 4.08× |
| gea-raw vs scriptc-raw | 2.68× |
| gea-raw vs rust-axum | 1.39× |
| gea-raw vs cpp-drogon | 1.29× |
| gea-raw vs rust-hyper | 1.14× |
| gea-raw vs cpp-epoll (hand-rolled ceiling) | 0.86× |
| hono-gea vs hono-node | 3.68× |
| hono-gea vs node-raw (framework vs bare Node) | 1.95× |
| hono-gea memory vs hono-node (PSS) | 1/36 |
| gea-raw memory vs node-raw (PSS) | 1/42 |

Single worker, `GET /`: gea-raw 154k vs node-raw 35k (4.41×), scriptc 51k
(3.01×), axum 125k (1.24×), Drogon 123k (1.25×), hyper 145k (1.06×), epoll
202k (0.76×). hono-gea 68k vs hono-node 18k (3.86×).

**How firm the hyper comparison is.** At four workers the two distributions
do not touch: gea-raw's six samples span 311.6k-315.6k and rust-hyper's
273.3k-279.0k, so gea-raw's worst sample is 12% above hyper's best. That held
in every run of this code on 2026-09-21 and 2026-09-22 (five full matrices
across the two days, four of them with the earlier `-O2` build, which was
298-310k against the same 271-284k). At one worker it is **level**: a
dedicated five-round pass of just the two servers gave medians of 141.7k
(gea-raw) and 142.1k (hyper), means of 147k and 143k, both inside the
single-core bimodality described above. Earlier revisions of this document
quoted a single-worker lead; it was the bimodality, not the server.

The measure that does not move with the weather is user-mode instructions per
request (`perf stat -e instructions:u` on the pinned server divided by `wrk`'s
request count), with cycles alongside because `-Os` trades one for the other.
Re-taken 2026-09-22 on the compiler 1.0.17 binaries, two rounds each, mean
shown (`bench/results/insn-2026-09-22-compiler-1.0.17.txt`; the instruction
counts agree to ±0.1% between rounds, the cycle counts to ±5%):

| Server | user instructions / request | user cycles / request | kernel instructions / request |
| --- | ---: | ---: | ---: |
| cpp-epoll | 2,532 | 1,530 | 16,435 |
| gea-raw | 10,464 | 6,572 | 14,602 |
| rust-hyper | 12,057 | 7,931 | 15,574 |
| scriptc-raw | 13,769 | 9,352 | 61,694 |
| hono-gea | 35,966 | 31,662 | 15,919 |

The raw servers all spend the same ~15k kernel instructions per request on one
`recv` and one `send`, about two thirds of the request, which is why a 13%
userland advantage shows up as single digits of throughput. scriptc's binary
spends 4× that in the kernel — it is a syscall-count difference, not a
codegen one, and it is most of its gap. gea-raw at `-O2` executes 9,218
instructions in 7,222 cycles; at `-Os` it executes 10,464 in 6,572, and Hono
goes from 33,540 instructions in 37,454 cycles to 35,966 in 31,662: fewer
cycles for more instructions is the instruction cache talking.

## Compiler and flags

The C++ compiler and its flags are part of the result, so they were measured
(same emitted source, same host, four pinned workers, 3 rounds x 8 s). The
clang rows were re-taken on 2026-09-22 with `@geastack/compiler@1.0.17`
(`bench/results/http-box-2026-09-22-flags-{O2,O3,Os,O2-lto}.json`; the
`-Os -flto` row is the `typed-listeners` run above) so that every size on
this page comes from one compiler. The g++ rows are from the earlier build
of the same day (`bench/results/cxx-*.json` on the bench host, compiler
1.0.16, 4-6 samples); their binaries were 1.5x larger across the board, like
the clang ones, so only their throughput is listed.

| Build | Raw server 4w `/` | Raw binary | Hono 4w `/` | Hono binary |
| --- | ---: | ---: | ---: | ---: |
| clang 18 `-O2` | 304-313k | 1.72 MB | 139-142k | 7.51 MB |
| clang 18 `-O3` | 307-311k | 1.81 MB | 140-143k | 8.00 MB |
| clang 18 `-Os` | 306-314k | 1.13 MB | 141k | 5.32 MB |
| clang 18 `-O2 -flto` | 304-308k | 1.64 MB | 141-144k | 7.27 MB |
| **clang 18 `-Os -flto`** (default) | **307-320k** | **1.05 MB** | **150-152k** | **5.04 MB** |
| g++ 13 `-O2` | 287-291k | | 131-132k | |
| g++ 13 `-O3 -flto` | 292k | | | |
| g++ 13 `-Os` | 103-110k (1w) | | | |

Three things fall out. `-O3` buys nothing on either compiler. On the raw
server every clang build lands inside the same round-to-round spread, so the
flags are chosen on size and on Hono. And the level answer is
compiler-specific: under clang `-Os -flto` is both the smallest build and the
fastest one on Hono, 5-7% ahead of the other flag sets at four workers with a
binary about a third smaller than `-O2 -flto` — while under g++ `-Os` costs
25%. `scripts/build.mjs` therefore defaults to `-Os -flto` with clang and
`-O2 -flto` with g++; `GEA_OPT_LEVEL` and `GEA_LTO=0` override. g++ 13 is
4-10% behind clang 18 on the same emitted source, which is why the reproduce
path below no longer sets `CXX=g++`.

Two other build facts, measured because they were assumed: stripping the
binary changes nothing that runs (`.symtab`/`.strtab` sit outside every
`LOAD` segment; the A/B was flat), and linking `libcrypto` into a server that
never reaches `node:crypto` costs 0.45 MB of PSS per process for the mapped
and relocated library. `bench/pss-breakdown.py` is the instrument: it sums
`Pss` per mapping under the harness's load.

## Reading the result

- **The compiled `node:http` app leads the framework servers.** At four
  workers it passes hyper by 14%, Drogon by 29% and axum by 39%, and reaches
  86% of a hand-written epoll loop that does no HTTP parsing. It is 4.1× Node
  running the same file, at a forty-second of the memory, and starts in 6 ms
  against 137 ms.
- **Against scriptc, the other TypeScript-to-native compiler**, the same
  file is 2.7× faster at four workers and 3.0× at one, with a third of the
  latency. scriptc's binary is the smallest in the table (222 KB, 0.9 MB PSS)
  and starts as fast; its cost per request is in the kernel. scriptc does not
  build the Hono app (its static mode compiles only the program's own file;
  `--dynamic` embeds a QuickJS island whose `node:http` has no
  `createServer`).
- **What `@geastack/node-compat@1.0.12` and `@geastack/compiler@1.0.16`
  changed (239k → 301k at four workers on 2026-09-21).** The response head is
  no longer built as a JavaScript string. `writeHead`/`setHeader`/`end` now
  stream status line, fields and framing straight into the connection's
  retained output buffer through `__gea_http_head_begin/field/end`; the
  framing decision (Content-Length, chunked, close-delimited, no-body), the
  `Date` line and the `Connection`/`Keep-Alive` tail are made natively, with
  the common tail cached per second; `end(text)` on a chunked response writes
  size line, payload and terminator in one append. Allocations per request
  fell from 23 to 15 and user-mode instructions from 10,657 to 9,401 (at
  `-O2`). The wire bytes are unchanged — the harness's 72 wire-contract
  checks and `bench/raw-http-correctness.py` (Node parity for plain, JSON,
  query, long URL, POST and pipelined requests) both pass. Hono's native
  adapter writes its head through the same path.
- **What `@geastack/node-compat@1.0.14` changed (301k → 313k, Hono 140k →
  150k).** No runtime code: the build. `-Os -flto` under clang, stripped,
  `libcrypto` only when reached. The gain is real but it is a compiler-flag
  gain, and the section above says exactly how large and on which compiler.
- **A compiled framework beats bare Node.** hono-gea serves 150k requests per
  second against raw `node:http`'s 77k — 1.95× — while Hono on Node manages
  41k. The whole Hono stack compiled is faster than Node running no framework
  at all.
- **Hono compiled is 3.7× Hono on Node** at four workers and 3.9× at one. The
  framework's own per-request work (Context, Response, Headers, router) is the
  entire remaining gap between the Hono row and the raw row. Nothing in Hono
  was modified.
- **Memory.** At four workers the gea fleet holds 18.0 MB RSS / 4.3 MB PSS to
  serve 313k requests per second; the Node cluster holds 377 MB / 183 MB to
  serve 77k. PSS divides pages shared through fork by their sharer count, so
  the 1/42 figure is the one that survives scrutiny. The Rust servers are
  smaller still (hyper 2.3 MB PSS), and scriptc's static binary smaller than
  those (1.5 MB).
- **Startup is the least noisy margin.** 6-7 ms against 72-166 ms, and the gea
  figure does not grow with worker count while Node's roughly doubles from one
  worker to four.
- **Latency.** At four workers gea-raw's p50 is 176 µs against hyper's 227 µs
  and Drogon's 197 µs, but its p99 of 499 µs is behind hyper's 396 µs and
  axum's 489 µs. At one worker its p50 (432 µs) is the best of the framework
  servers and its p99 (860 µs) is the worst of them -- hyper holds 502 µs --
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
Ports 3000 (Node Hono), 3101 (raw servers) and 3900 (gea Hono, Nest) must be free.

Requirements: Node.js and the repository's npm dependencies, Python 3, `wrk`,
`util-linux`, clang (18 or newer; `-flto` needs its gold plugin,
`LLVMgold.so`, or set `CXX=g++`), Rust and Cargo, and for Drogon its
development libraries (Drogon, Trantor, jsoncpp, OpenSSL, zlib, uuid).

The compiler can come from the registry or from a checkout. The registry path
needs no compiler build, and is the install this document's gea servers were
built from:

```sh
npm ci                                                  # @geastack/compiler + @geastack/node-compat from npm
npm ci --prefix apps/hono-hello                         # hono + @hono/node-server (no workspaces: the root install does not reach it)
node tools/nest/build-platform-node.mjs                 # @nestjs/{common,core,platform-node} 12.2.0 tarballs from the pinned nest checkout (../nest or GEA_NEST_DIR)
npm ci --prefix apps/hello-nest                         # the vendored Nest packages, reflect-metadata, rxjs, typescript
bash bench/goal-http-build.sh                           # gea servers + C++ and Rust controls, clang++ -Os -flto
```

Without the second install the Hono build stops at `Cannot find module
'hono'`. `CXX=g++ bash bench/goal-http-build.sh` builds with GCC at
`-O2 -flto` and lands 4-10% lower; the numbers above are clang's.

`goal-http-build.sh` resolves the compiler through
`require.resolve('@geastack/compiler/package.json')`, so it picks up the
installed package with no further configuration. Verify there is no local
shortcut in play before believing a number, and check which C++ compiler
built a binary before comparing it with anything (`readelf -p .comment`):

```sh
find node_modules/@geastack -maxdepth 1 -type l          # must print nothing
node -p "require('@geastack/compiler/package.json').version"
readelf -p .comment apps/raw-http-hello/dist/server      # names the C++ compiler
```

From a checkout instead, build the shared compiler once and let the same
script emit the servers. The gea servers are emitted by the one
`compiler/dist`; never a private compiler build.

```sh
cd /path/to/geastack/compiler && npm run build && cd ../node-compat
npm ci --prefix apps/hono-hello                         # needed on this path too
node tools/nest/build-platform-node.mjs && npm ci --prefix apps/hello-nest
bash bench/goal-http-build.sh
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

For the scriptc row, build the server with `scriptc@0.1.3` (`npx scriptc
build apps/raw-http-hello/server.ts -o raw-static`, and a second build of the
file with `listen({ port: 3101, reusePort: true })` for the four-worker
cell), then:

```sh
SCRIPTC_RAW=/path/to/raw-rp python3 bench/http-matrix.py --servers scriptc-raw \
  --output bench/results/scriptc-local.json --rounds 3 --duration 8s --workers 1 4 --server-cpus 0-3
```

`--server-cpus` must name physical cores the load generator does not share;
check `/sys/devices/system/cpu/cpu*/topology/thread_siblings_list` before
choosing, because sibling numbering differs between machines and the wrong
choice silently measures a saturated host. `--servers` narrows a run to any of
`hono-gea`, `hono-node`, `nest-gea`, `nest-node`, `gea-raw`, `node-raw`,
`scriptc-raw`, `cpp-drogon`, `rust-axum`, `rust-hyper`, `cpp-epoll`. The result JSON keeps every raw `wrk`
report, the percentile latencies, peak RSS and PSS per process, startup
samples, machine metadata, artifact SHA-256 hashes and the wire-contract
validation record.

Things that bit these runs and are worth knowing. A binary copied from a Mac
is a Mach-O file that Linux reports as a shell syntax error when executed, so
rebuild the Rust controls with `cargo build --release` on the host. A `wrk`
report against a port nobody listens on looks like a very slow server rather
than an error, which is why the harness validates every server's responses
before sampling it. A sibling symlink into a `@geastack` checkout hides
packaging defects that only a registry install reveals: a symlinked
package.json is read as a plain file, so an `exports` map that omits
`"./package.json"` never fails locally and fails for every real consumer. And
two scripts that both say "build" can name different compilers: the 09-21
numbers were clang's while the document said g++, which was only caught by
reading the binaries' `.comment` sections.

## hello-nest: Node against the compiled binary, 2026-10-19

Not the bench host. This run is `bench/http-matrix.py --servers nest-gea
nest-node` inside an arm64 Linux container (Ubuntu 24.04, clang 18.1.3,
Node v24.20.0, wrk 4.1.0) on a Colima VM with 8 vCPUs and 12 GiB on an Apple
M1 (4 performance and 4 efficiency cores; the VM's vCPUs are not pinned to
physical cores, so `--server-cpus 0-3 --load-cpus 4-7` separates server and
load generator inside the VM only). The VM ran nothing else. Raw records:
`bench/results/nest-colima-arm64-2026-10-19.json` and its `-startup` file.
Numbers here are comparable with each other and with nothing in the tables
above.

`apps/hello-nest/server.ts` was built by `scripts/build.mjs` from a compiler
checkout carrying the four hello-nest fixes (`GEA_COMPILER_DIR`, 1.0.37 plus
`fix/error-subclass-instanceof`, `fix/array-keys-over-recursive-wrapper`,
`fix/hoist-module-function-declarations`, `fix/uri-error-thrown-not-aborted`),
`-Os -flto`, stripped: 7,619,264 bytes, 61,265 emitted lines. The Node row
is `tsc` output of the same file (`dist-node/server.js`), one process or a
`node:cluster` of four. Both answered `scripts/test-hello-nest.mjs` 10 of 11
identical before the run (the known `JSON.parse` message wording).
Protocol as above: 2 s warmup, 8 s samples, `-t4 -c64`, three interleaved
rounds, startup in a separate five-launch pass.

| Server | Single `/` | Single `/json` | Single RSS MiB | Single PSS MiB | Single startup ms | 4 workers `/` | 4 workers `/json` | 4 workers RSS MiB | 4 workers PSS MiB | 4 workers startup ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **nest-gea** | **121,131** | **111,276** | 10.8 | 9.4 | 13 | **281,100** | **270,107** | 31.4 | 10.9 | 13 |
| nest-node | 53,039 | 47,787 | 123.9 | 122.8 | 527 | 142,989 | 139,628 | 536.0 | 338.1 | 1,014 |

Per-round `GET /`: nest-gea 128.8k / 123.6k / 111.0k at one worker and
291.2k / 270.9k / 281.2k at four; nest-node 53.6k / 51.6k / 53.9k and
154.6k / 149.3k / 125.0k.

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| nest-gea | 502 µs | 2.34 ms | 169 µs | 816 µs |
| nest-node | 1.13 ms | 2.27 ms | 388 µs | 38.3 ms |

Ratios, compiled over Node, means over rounds: 1.97× (`/`) and 1.93×
(`/json`) at four workers, 2.28× and 2.33× at one worker; PSS 1/31 at four
workers and 1/13 at one; startup 13 ms against 527 ms and 1,014 ms. The
compiled ratio is about half of Hono's on the bench host (3.7×), and the
single-worker rounds spread 15% for the compiled binary against 4% for Node,
so the one-worker cells carry the same caution as the bimodality note above.

### The full matrix on the same VM, later the same day

All ten servers, same container, same protocol, VM otherwise idle:
`bench/results/http-colima-arm64-2026-10-19.json` (rounds 1-2 complete for
every server, round 3 for the six gea and Node rows; the run aborted when
`cpp-drogon` at one worker timed out 63 of 64 connections in its warmup, which
the harness refuses), `http-colima-arm64-2026-10-19-controls.json` (the four
controls again, three clean rounds, 19 minutes later) and
`http-colima-arm64-2026-10-19-startup.json` (five launches each, all ten).
The gea and Node rows are the first file, the controls the second, as the
scriptc row above is a separate run of the same harness. Binaries: hono-gea
4,805,616 bytes, nest-gea 7,619,264, gea-raw 3,403,464; controls built in the
container with clang 18.1.3 and `cargo build --release --locked`.

| Server | Single `/` | Single `/json` | Single RSS MiB | Single PSS MiB | Single startup ms | 4 workers `/` | 4 workers `/json` | 4 workers RSS MiB | 4 workers PSS MiB | 4 workers startup ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **hono-gea** | **132,018** | **97,355** | 7.3 | 6.3 | 7 | **254,633** | **211,371** | 25.9 | 8.5 | 11 |
| hono-node | 29,372 | 25,538 | 116.8 | 115.7 | 89 | 56,799 | 48,976 | 440.9 | 260.2 | 148 |
| **nest-gea** | **103,000** | **88,705** | 10.8 | 9.4 | 13 | **210,652** | **194,149** | 31.5 | 10.9 | 15 |
| nest-node | 42,828 | 38,581 | 120.2 | 119.2 | 698 | 77,146 | 81,775 | 532.8 | 334.8 | 1,700 |
| **gea-raw** | **156,805** | **153,935** | 5.5 | 4.6 | 14 | **291,858** | **278,909** | 18.1 | 5.9 | 15 |
| node-raw | 43,572 | 43,894 | 87.8 | 86.8 | 101 | 103,868 | 96,322 | 365.2 | 185.7 | 219 |
| cpp-drogon | 128,777 | 125,933 | 11.8 | 10.3 | 32 | 238,242 | 231,066 | 12.0 | 10.5 | 28 |
| rust-axum | 154,358 | 157,571 | 4.1 | 3.2 | 13 | 189,086 | 184,784 | 5.0 | 4.1 | 92 |
| rust-hyper | 186,388 | 180,580 | 3.1 | 2.2 | 10 | 208,856 | 211,222 | 3.5 | 2.6 | 6 |
| cpp-epoll | 175,417 | 170,298 | 3.2 | 2.3 | 6 | 290,664 | 288,241 | 10.0 | 3.4 | 6 |

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| hono-gea | 448 µs | 910 µs | 179 µs | 880 µs |
| hono-node | 1.90 ms | 4.23 ms | 840 µs | 2.89 ms |
| nest-gea | 545 µs | 1.15 ms | 225 µs | 1.15 ms |
| nest-node | 1.33 ms | 2.71 ms | 718 µs | 7.72 ms |
| gea-raw | 363 µs | 1.42 ms | 154 µs | 990 µs |
| node-raw | 1.41 ms | 2.82 ms | 633 µs | 2.69 ms |
| cpp-drogon | 482 µs | 1.09 ms | 193 µs | 940 µs |
| rust-axum | 406 µs | 19.46 ms | 265 µs | 950 µs |
| rust-hyper | 317 µs | 542 µs | 251 µs | 1.84 ms |
| cpp-epoll | 284 µs | 652 µs | 143 µs | 1.15 ms |

Four workers, `GET /`: nest-gea 2.73× nest-node (2.40× at one worker),
hono-gea 4.48× hono-node, gea-raw 2.81× node-raw; nest-gea is 0.83× hono-gea
and 2.03× bare Node. PSS at four workers is 1/31 for all three pairs.

What this VM can resolve. The Nest rows an hour apart read 281k / 143k
(nest-gea / nest-node, four workers, the dedicated run above) and 211k / 77k
here, so the same binaries moved 25% and 46% between runs and the ratio moved
from 1.97× to 2.73×. Round-to-round spreads inside one run reach 30% for the
Node cluster rows (node-raw 109k / 117k / 86k, nest-node 94k / 66k / 72k) and
15% for cpp-epoll and cpp-drogon. The pairs hold their order in every round,
the sizes of the gaps do not; the bench-host tables above are where those
sizes are measured.

## The same VM on 2026-10-25: platform-node 12.2.0, published compiler 1.0.47

Same container, protocol and CPU split as the 2026-10-19 runs above. What
changed: `apps/hello-nest` runs platform-node 12.2.0 (nest `0828b0d`), and all
three gea binaries were built inside the container by the published
`@geastack/compiler` 1.0.47 (`GEA_COMPILER_DIR` at an npm install, no
checkout). Ubuntu 24.04 ships libbrotlidec 1.1.0, which `scripts/build.mjs`
refuses (CVE-2026-111497), so brotli 1.2.1 was built into a prefix and passed
as `BROTLI_DIR`. The VM's other containers were stopped and the macOS host ran
nothing CPU-bound. An attempt earlier that day, with two desktop renderers each
holding a host core, measured every row about 40% lower with doubled startup
and the same ratios; it is not recorded.

Records: `bench/results/http-colima-arm64-2026-10-25.json` (all ten servers,
three complete rounds each, 72 wire checks passed) and its `-startup` file;
`nest-colima-arm64-2026-10-25.json` and its `-startup` file are a nest-only run
seventy minutes earlier that agrees with the full matrix within 2%. hello-nest
answered `scripts/test-hello-nest.mjs` 10 of 11 identical (the `JSON.parse`
message wording, which 1.0.47 predates). Binaries: hono-gea 5,283,152 bytes,
nest-gea 8,016,904, gea-raw 3,669,280; cpp-epoll 73,944, cpp-drogon 126,352,
rust-hyper 1,029,480, rust-axum 1,218,160.

| Server | Single `/` | Single `/json` | Single RSS MiB | Single PSS MiB | Single startup ms | 4 workers `/` | 4 workers `/json` | 4 workers RSS MiB | 4 workers PSS MiB | 4 workers startup ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **hono-gea** | **153,784** | **121,440** | 7.4 | 6.4 | 7 | **376,158** | **323,931** | 26.0 | 8.5 | 8 |
| hono-node | 32,085 | 29,943 | 117.0 | 115.9 | 65 | 99,174 | 90,035 | 436.3 | 255.5 | 103 |
| **nest-gea** | **121,585** | **114,648** | 11.0 | 9.6 | 12 | **324,514** | **314,454** | 31.8 | 11.2 | 12 |
| nest-node | 54,336 | 52,106 | 119.6 | 118.5 | 498 | 175,532 | 165,650 | 548.8 | 350.7 | 924 |
| **gea-raw** | **232,639** | **229,654** | 5.4 | 4.5 | 9 | **459,725** | **474,422** | 17.8 | 5.9 | 7 |
| node-raw | 58,188 | 57,713 | 89.2 | 88.1 | 53 | 180,682 | 177,656 | 361.9 | 182.4 | 76 |
| cpp-drogon | 184,309 | 177,426 | 11.8 | 10.3 | 12 | 396,290 | 394,825 | 12.0 | 10.5 | 6 |
| rust-axum | 212,382 | 216,768 | 4.0 | 3.2 | 6 | 320,962 | 321,643 | 5.2 | 4.2 | 6 |
| rust-hyper | 245,773 | 249,293 | 3.2 | 2.3 | 6 | 340,853 | 341,511 | 3.7 | 2.8 | 6 |
| cpp-epoll | 281,368 | 280,232 | 3.2 | 2.3 | 6 | 473,147 | 472,736 | 10.0 | 3.4 | 6 |

| Server | Single p50 | Single p99 | 4 workers p50 | 4 workers p99 |
| --- | ---: | ---: | ---: | ---: |
| hono-gea | 395 µs | 826 µs | 128 µs | 844 µs |
| hono-node | 1.94 ms | 3.89 ms | 571 µs | 2.02 ms |
| nest-gea | 510 µs | 1.03 ms | 148 µs | 736 µs |
| nest-node | 1.13 ms | 2.29 ms | 318 µs | 1.66 ms |
| gea-raw | 249 µs | 534 µs | 96 µs | 1.68 ms |
| node-raw | 1.06 ms | 2.10 ms | 302 µs | 1.17 ms |
| cpp-drogon | 320 µs | 685 µs | 116 µs | 635 µs |
| rust-axum | 292 µs | 352 µs | 163 µs | 498 µs |
| rust-hyper | 251 µs | 302 µs | 152 µs | 442 µs |
| cpp-epoll | 199 µs | 433 µs | 90 µs | 1.00 ms |

`GET /`, compiled over Node: hono-gea 4.79× at one worker and 3.79× at four,
nest-gea 2.24× and 1.85×, gea-raw 4.00× and 2.54×. At four workers nest-gea
is 0.86× hono-gea and 1.80× bare Node, and gea-raw is 0.97× cpp-epoll and
1.35× rust-hyper. PSS at four workers is 1/30 to 1/31 for the three pairs.

Every row is higher than on 2026-10-19, the controls included (cpp-epoll
175k to 281k at one worker), so this VM session ran faster than that one and
only ratios compare across the two days. Those moved most for the Node cluster
rows (nest-node 77k to 176k at four workers), which were the noisiest rows of
2026-10-19.
