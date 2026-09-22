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

**What changed since the 2026-09-21 run** (`http-box-2026-09-21-npm-1.0.16.json`,
still in the repository): nothing in the runtime or the emitted C++. That run
said its binaries were built with `g++`; they were built with `clang++ 18`
(`scripts/build.mjs`'s default, which `bench/goal-http-build.sh` did not
share). The reproduce path now names the same compiler the numbers came from,
and the build flags were measured rather than assumed — see [Compiler and
flags](#compiler-and-flags). The result is 4% more throughput on the raw
server, 7% on Hono, 30% smaller binaries and 0.9-2 MB less PSS.

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
- **scriptc-raw**: the raw server compiled by `scriptc@0.1.3`
  (vercel-labs), a static binary. scriptc has no `node:cluster`, so its
  four-worker row is four processes of a build with `listen({ port,
  reusePort: true })` (`bench/scriptc-cluster.sh`); the plain build cannot
  share the port (the second instance dies with `EADDRINUSE`). Its one-worker
  row is the unmodified file. It passes the same wire-contract checks.

Routes: `GET /` returns `text/plain`, `GET /json` returns
`{"hello":"world"}`. Hono additionally serves `/missing` as a 404, which the
harness checks.

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
request count), with cycles alongside because `-Os` trades one for the other:

| Server | user instructions / request | user cycles / request | kernel instructions / request |
| --- | ---: | ---: | ---: |
| cpp-epoll | 2,533 | 1,562 | 16,478 |
| gea-raw | 10,607 | 7,208 | 14,585 |
| rust-hyper | 12,043 | 8,728 | 15,542 |
| scriptc-raw | 13,808 | 9,414 | 61,338 |
| hono-gea | 36,498 | 30,688 | 15,815 |

The raw servers all spend the same ~15k kernel instructions per request on one
`recv` and one `send`, about two thirds of the request, which is why a 12%
userland advantage shows up as single digits of throughput. scriptc's binary
spends 4× that in the kernel — it is a syscall-count difference, not a
codegen one, and it is most of its gap. gea-raw at `-O2` executed 9,027
instructions in 7,343 cycles; at `-Os` it executes 10,607 in 7,208, and Hono
went from 33,060 instructions in 33,925 cycles to 36,498 in 30,688: fewer
cycles for more instructions is the instruction cache talking.

## Compiler and flags

The C++ compiler and its flags are part of the result, so they were measured
(same emitted source, same host, four pinned workers, 2026-09-22; `-O2` rows
are 4 samples, the rest 3-6). `bench/results/cxx-*.json`,
`clang-flags-*.json` and `http-box-2026-09-22-dist-Os*.json` on the bench
host hold the raw runs; the summary:

| Build | Raw server 4w `/` | Raw binary | Hono 4w `/` | Hono binary |
| --- | ---: | ---: | ---: | ---: |
| clang 18 `-O2` | 290-308k | 2.71 MB | 136-140k | 8.03 MB |
| clang 18 `-O3` | 290-309k | 2.86 MB | | |
| clang 18 `-Os` | 281-302k | 1.93 MB | 142-145k | 5.71 MB |
| clang 18 `-O2 -flto` | 310-316k | 2.61 MB | 143-144k | 7.80 MB |
| clang 18 `-O3 -flto` | 305-313k | 2.84 MB | | |
| **clang 18 `-Os -flto`** (default) | **312-320k** | **1.82 MB** | **148-151k** | **5.47 MB** |
| g++ 13 `-O2` | 287-291k | 2.70 MB | 131-132k | 8.29 MB |
| g++ 13 `-O3 -flto` | 292k | 2.68 MB | | |
| g++ 13 `-Os` | 103-110k (1w) | 1.65 MB | | |

Three things fall out. LTO is worth 3% on clang at no size cost. `-O3` buys
nothing on either compiler. And the level answer is compiler-specific:
under clang `-Os -flto` is both the fastest and the smallest build — level
on the raw server, 5% ahead on Hono (10% at one worker) — while under g++
`-Os` costs 25%. `scripts/build.mjs` therefore defaults to `-Os -flto` with
clang and `-O2 -flto` with g++; `GEA_OPT_LEVEL` and `GEA_LTO=0` override.
g++ 13 is 4-10% behind clang 18 on the same emitted source, which is why the
reproduce path below no longer sets `CXX=g++`.

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
Ports 3000 (Node Hono), 3101 (raw servers) and 3900 (gea Hono) must be free.

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
`hono-gea`, `hono-node`, `gea-raw`, `node-raw`, `scriptc-raw`, `cpp-drogon`,
`rust-axum`, `rust-hyper`, `cpp-epoll`. The result JSON keeps every raw `wrk`
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
