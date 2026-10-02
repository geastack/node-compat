# Perry 0.5.1520: Hono and HTTP parity on the bench box

Tested on 2026-09-23 on `benchmark-test` (51.159.98.194), Intel Xeon
E3-1231 v3, four physical cores / eight logical CPUs. Node oracle: v24.21.0.
Hono: 4.12.34; `@hono/node-server`: 2.1.1.

**Hono runs unchanged after building a matching Perry compiler and full runtime
from source. The npm release alone was insufficient. Node is 10.8–11.6× faster
in this single-CPU comparison; strict raw HTTP parity is 1/38.**

## Hono throughput

Medians of three eight-second runs per endpoint and runtime. The server is
pinned to logical CPU 0; wrk uses CPUs 4–7, four threads, 64 connections, and a
two-second warmup before each server's pair of measurements. Server and endpoint
order reverse on round two. Both runtimes execute the identical Hono
`server.ts`, with the standard `@hono/node-server` adapter. All builds were
stopped before timing. The starting load average (0.67/1.44/1.31) was decaying
from the preceding builds; the process check showed no remaining compiler jobs.

| Endpoint | Perry requests/s, median | Node requests/s, median | Node / Perry | Perry p99, median | Node p99, median |
| -------- | -----------------------: | ----------------------: | -----------: | ----------------: | ---------------: |
| `/`      |                 2,829.84 |               32,939.96 |       11.64× |          51.89 ms |          2.38 ms |
| `/json`  |                 2,557.22 |               27,672.35 |       10.82× |          62.92 ms |          3.39 ms |

Raw requests/s samples, in chronological round order:

| Runtime | `/`                               | `/json`                           |
| ------- | --------------------------------- | --------------------------------- |
| Perry   | 2,842.38 / 2,713.80 / 2,829.84    | 2,557.22 / 2,619.34 / 2,530.48    |
| Node    | 32,939.96 / 33,608.14 / 32,801.64 | 27,809.19 / 27,168.54 / 27,672.35 |

Post-sample process RSS ranged **136.6–163.5 MiB for Perry** and
**112.0–114.7 MiB for Node**. These are snapshots, not peak-memory measurements.
All 12 timed samples passed wrk's positive-throughput, socket-error, and
non-2xx/3xx checks. Before each server run, `/`, `/json`, `/missing`, and
`/body/json` passed expected status, body and content-type checks. This is a
single-process, single-CPU measurement, not a multi-worker scaling test.

Full wrk output, memory snapshots, hardware, compiler hash, source/binary hashes,
and package versions are in `perry-0.5.1520-hono-performance-2026-09-23.json`.
Ports 3000 and 3900 were free after cleanup; no benchmark server was left running.

The existing 38-request battery tests `apps/http-parity/server.ts`, a raw
`node:http` app. It is separate from the Hono app and must not be described as
38 Hono routes. The driver normalizes only the Date header value before comparing
the complete raw responses, including header spelling/order and framing.

## 38-request result with matching source compiler/runtime

**1/38 byte-identical; 37 differences. Driver exit 1.** Only `status-204` passes.
All responses are saved in `parity-perry-0.5.1520-source-2026-09-23.txt`.
The unchanged driver's `--- gea ----` label denotes the tested Perry executable
in this run, not a Gea measurement.

Many differences are wire-format choices: capitalized `Content-Type`, different
header order, and `Content-Length` instead of Node's chunked response after
`writeHead`. Other differences include HTTP/1.0 keep-alive behavior, implicit HEAD
content lengths, and combining duplicate `X-Extra` fields into `e1,e2`.

Two requests differ in status and decoded body:

| Case                      | Node 24.21.0    | Perry 0.5.1520             |
| ------------------------- | --------------- | -------------------------- |
| 20,000-byte header        | 431, empty body | 200, `Hello, World! GET /` |
| Malformed chunk size `ZZ` | 400, empty body | 200, `echo::len=0`         |

As a diagnostic only, decoding transfer framing and comparing status/body gives
36/38 matches. This ignores header semantics and does **not** replace the 1/38
byte-parity result.

## Published npm compiler

Installed `@perryts/perry@0.5.1520` in the bench box's existing user-level Node
v24.21.0 installation. No application or dependency source was patched.

```sh
perry compile apps/http-parity/server.ts -o apps/http-parity/dist/server-perry
perry compile apps/hono-hello/server.ts -o apps/hono-hello/dist/server-perry
```

The parity app failed to link (exit 1, 5.38 seconds):

```text
warning: `http` needs libperry_ext_http.a, which is not on disk.
undefined reference to `js_node_http_create_server_with_options'
undefined reference to `js_node_http_server_listen'
Error: Linking failed
```

Hono compiled in 24.23 seconds (30 native modules, zero JavaScript fallback
modules; reported binary size 31.5 MB). The executable exited with code 1 before
opening port 3900:

```text
TypeError: Cannot read properties of undefined (reading 'listen')
    at <anonymous>
```

The identical Hono source passed GET `/`, GET `/json`, missing-route 404, and
POST `/body/json` checks under Node. Published-release results are in
`perry-0.5.1520-release-2026-09-23.json`. Its startup timing was collected during
a runtime build and is diagnostic only, not a performance measurement.

## Matching source-runtime attempt

Installed the upstream source tag `v0.5.1520`, commit
`381045a8735ff325621c5dfb26a3bd4f5a8798c5`, in `~/perry` on the bench box.
Enabled the documented `PERRY_WORKSPACE_ROOT` override and retried the raw app
with automatic runtime optimization, two Cargo jobs, and the repository's pinned
Rust nightly `nightly-2026-08-20`.

The runtime, stdlib and HTTP archive built successfully, but the npm compiler
rejected them:

```text
Error: runtime library does not match this Perry compiler:
  library build: v0.5.1520 (commit 381045a8735f)
  Perry build: v0.5.1520 (source 85ccd72f8e53)
```

The identity check was not disabled or modified. A compiler from the same source
tag resolved that mismatch and successfully compiled the unchanged parity app
(reported executable size 20.4 MB).

The source compiler build uses the documented `perry-dev` profile and `dev-cli`
feature set (compiler build optimization only; emitted programs still use LLVM's
normal optimization and release runtime archives):

```sh
LLVM_SYS_221_PREFIX=/usr/lib/llvm-22 CARGO_BUILD_JOBS=2 \
  cargo build --profile perry-dev -p perry --no-default-features --features dev-cli
```

The first build failed because LLVM's static `Polly` library was absent. Installing
`libpolly-22-dev` also upgraded the installed LLVM 22 package set from the June
2026 packaging revision to July 2026 revision `.80`, both LLVM 22.1.8. No reboot
or Gea rebuild was performed. The source checkout and installed toolchain remain
on the bench box for reproduction.

The successful commands for the unchanged applications were:

```sh
export PATH="$HOME/perry/target/perry-dev:$HOME/.nvm/versions/node/v24.21.0/bin:$HOME/.cargo/bin:$PATH"
export PERRY_WORKSPACE_ROOT="$HOME/perry" PERRY_NO_TELEMETRY=1 CARGO_BUILD_JOBS=2
cd ~/node-compat
perry compile apps/http-parity/server.ts -o apps/http-parity/dist/server-perry-source
perry compile apps/hono-hello/server.ts -o apps/hono-hello/dist/server-perry-source
node apps/http-parity/driver.mjs apps/http-parity/dist/server-perry-source apps/http-parity/server.ts
python3 bench/perry-http.py --skip-parity --binary-name server-perry-source \
  --rounds 3 --duration 8s --output bench/results/perry-0.5.1520-hono-performance-2026-09-23.json
```

The direct/indirect factory reproducer passes under the source-built Perry:

```text
direct server: object listen: function
indirect server: object listen: function
```

That small probe does not reproduce the original packaged Hono startup failure.
An attempted reuse of the raw-HTTP-only archives for Hono failed to link because
those archives omit Web Request/Response, Headers, and Web Crypto APIs. That is
an insufficient-feature diagnostic configuration, not evidence that the normal
Hono compilation is unsupported; the normal automatic feature build is tested
separately. All build attempts are retained in
`perry-0.5.1520-source-builds-2026-09-23.json`.

The normal automatic Hono build succeeded in **435.52 seconds**, including its
first full runtime build. It emitted 30 native modules, no JavaScript fallback,
and a reported **25.9 MB** executable. The unchanged Hono app passed all four
application checks with the matching source compiler/runtime. The original
packaged startup failure therefore does not establish an inherent Hono compiler
failure. Initial source-built response checks are saved in
`perry-0.5.1520-source-hono-2026-09-23.json`; their startup timings were collected
during another build and are diagnostic only.

Two `-15` exits in the build log are deliberate cancellations: an unnecessary
second runtime build for the tiny factory probe (retried successfully with the
existing archives), and an optional Perry-specific Hono adapter build stopped
when the original standard adapter succeeded. The optional adapter package and
variant source were removed. The tested Hono app uses `@hono/node-server`.

## Reproduction tools

- `bench/perry-http.py`: checks the raw parity binary, invokes the unchanged
  38-case driver, checks Hono against expected responses, and only benchmarks
  servers that return correct responses. Uses server CPU 0, wrk CPUs 4–7,
  four load threads, 64 connections, a two-second warmup, and three eight-second
  rounds for `/` and `/json`. Node runs the exact `server.ts` source, including
  the standard Hono adapter, rather than the older `server.node.mjs` bridge.
- `bench/perry-http-create-server.ts`: compares direct `createServer` with
  `(options.createServer || createServer)(...)`, the invocation used by the
  standard Hono adapter. Node returns a server with a callable `listen` for both.

Upstream reference: [Perry release](https://github.com/PerryTS/perry/releases/tag/v0.5.1520).

## Follow-up: raw HTTP throughput for the website comparison chart

Compiled the unchanged `apps/raw-http-hello/server.ts` with the same source-built
Perry compiler. Automatic feature selection built the runtime archives under
`target/perry-auto-68106413b5248bb4/release`; the resulting executable was reported
as 17.5 MB. The build finished before timing began.

`bench/perry-raw-http.py` measures this binary against Node v24.21.0 running the
identical `server.ts`. Both server processes are pinned to CPU 0, with wrk on
4–7, four load threads, 64 connections, two seconds of warmup, and three
eight-second samples per endpoint. Server and endpoint order reverse in round
two. This is a single-CPU result, not a four-worker measurement.

| Runtime | `/` mean req/s | `/` median req/s | `/json` mean req/s | `/json` median req/s |
| --- | ---: | ---: | ---: | ---: |
| Perry | 44,508.54 | 45,017.83 | 46,436.25 | 46,849.91 |
| Node | 32,951.36 | 33,334.55 | 33,266.93 | 33,919.65 |

All twelve samples passed socket/status-error checks, and both applications
passed status, content-type and decoded-body checks. The harness records the raw
responses separately; Perry's headers/framing differ from Node's, so this is not
an identical-wire benchmark. The means are used in the website context chart to
match the earlier chart's aggregation, rather than mixing means and medians.
Perry delivers about 1.35× Node's mean throughput on the raw `/` endpoint.

Data: `perry-0.5.1520-raw-performance-2026-09-23.json`. Reproduce after compiling:

```sh
perry compile apps/raw-http-hello/server.ts -o apps/raw-http-hello/dist/server-perry-source
python3 bench/perry-raw-http.py --rounds 3 --duration 8s \
  --output bench/results/perry-0.5.1520-raw-performance-2026-09-23.json
```

The historical chart uses `http-box-2026-09-22-final.json`, which reports means
over three rounds. Its compiled Gea Hono source uses `@hono/node-server`. Its
Node/Hono control differs: the recorded hash for `bench/http-matrix.py`
(`f1a7463f…`) matches the harness that launches `server.node.mjs`, whose recorded
hash (`ebd47d00…`) matches the `hono/tiny` custom bridge. Both files and the
standard-adapter Gea entry are present in commit `e661a7e`. Today's Perry/Node
Hono run uses the standard adapter on both sides. The website chart retains the original eight rows and adds Perry raw/Hono,
without adding fresh Node controls. A caption identifies Perry as a separate
run; Gea was not remeasured.

Ports 3101 and 3900 were free after the raw benchmark completed.

## Four-worker completion

The `server.cluster.ts` entry in each app wraps the original server body in the
worker branch of `node:cluster` and forks four workers from the primary. Imports
and request handlers are unchanged; Hono retains `@hono/node-server`. Both entry
files compiled with the same Perry source compiler and existing automatic
runtime archives. Reported executable sizes remain 17.5 MB raw and 25.9 MB Hono.

`bench/perry-cluster-http.py` pins the primary and four workers to CPUs 0–3, with
wrk on CPUs 4–7. Perry's default SCHED_RR distributes accepted connections. The
harness opens 64 persistent connections, checks their responses, and matches
the server-side socket inodes to each worker's file descriptors. Every worker
owned exactly 16 verified connections in each of six launches. It checks all
worker affinities and requires the same four workers to remain alive after each
timed sample. Hono's `/missing` and JSON POST also pass status/body/content-type
checks before each launch is timed.

| Runtime | `/` mean req/s | `/` median req/s | `/json` mean req/s | `/json` median req/s |
| --- | ---: | ---: | ---: | ---: |
| Perry raw, 4 workers | 84,350.74 | 83,752.97 | 87,743.10 | 87,787.77 |
| Perry Hono, 4 workers | 6,533.05 | 6,612.38 | 6,021.67 | 5,974.77 |

Three rounds, two-second warmup, eight-second samples, 64 connections, four wrk
threads, with application and endpoint order reversed in round two. All twelve
samples passed socket/status-error checks. No compiler jobs ran during timing.
The raw JSON includes commands, source/compiler/binary hashes, every wrk report,
and all per-worker connection proofs:
`perry-0.5.1520-four-workers-2026-09-23.json`.

```sh
perry compile apps/raw-http-hello/server.cluster.ts -o apps/raw-http-hello/dist/server-perry-cluster
perry compile apps/hono-hello/server.cluster.ts -o apps/hono-hello/dist/server-perry-cluster
python3 bench/perry-cluster-http.py --rounds 3 --duration 8s \
  --output bench/results/perry-0.5.1520-four-workers-2026-09-23.json
```

All six primary processes and all 24 workers were absent from `/proc` after
cleanup. Ports 3101 and 3900 were free. The website chart now includes measured
Perry rows in both its one-CPU and four-worker views, alongside the original
eight entries without date groups or descriptive sublabels. The article's
reproduction section and raw-data download links were removed at the author's
request; the underlying measurement records remain available in the repository.


## CPU profiling follow-up

`bench/perry-profile.py` profiled the unchanged single-CPU binaries on CPU 0,
with wrk on CPUs 4–7, four load threads and 64 connections. Each app received a
2-second warmup, then separate 6-second perf-stat and 199 Hz user-cycle call-stack
recordings during 8-second loads. These are diagnostic runs, not replacements
for the published throughput measurements. Results are retained in
`perry-0.5.1520-profiles-2026-09-23.json`.

Both applications consumed 1.000 CPU during perf stat. Hono recorded 22.03 billion
user cycles and 27.73 billion user instructions over six seconds (IPC 1.26);
raw recorded 15.79 billion user cycles and 20.75 billion instructions (IPC 1.31).
The corresponding stat loads reported 2,815.46 and 43,849.41 requests/second.

Hono's inclusive user-cycle sample percentages include 48.04% through
`js_native_call_method`, 19.76% through `promise::microtasks::run_microtasks`,
and 10.55% through minor GC. These paths overlap and must not be summed.
Flat samples are spread across array access, UTF-8 validation, buffer checks,
string-key comparison, object metadata, allocation and GC bookkeeping.
Raw's flat profile instead has prominent handle-table iteration (10.21% in
DashMap iteration and 8.70% in HTTP-server handle iteration).

This supports substantial dynamic runtime overhead in the compiled Hono path;
it does not isolate the exact causes of the Node/Perry difference. No Node CPU
profile or optimization experiment was run. The sample is short, and 11.80% of
Hono's inclusive roots are unresolved. No samples were reported lost.

To symbolize the originally stripped binaries, the same sources were recompiled
with `PERRY_KEEP_SYMBOLS=1`, which skips post-link stripping. Both symbol copies
have the same ELF BuildID and identical `.text` addresses and SHA-256 hashes as
the measured originals; verification is included in the JSON. The originals
were the binaries actually profiled. `perf buildid-cache --update` was required
to replace the stripped cache entries; `--add` alone did not do so. Reports were
regenerated from the original perf data and demangled with `c++filt -s rust`.
