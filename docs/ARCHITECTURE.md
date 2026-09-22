# Architecture

How a TypeScript `node:http` app becomes a native binary that answers HTTP
byte-for-byte like Node — and why it runs at Rust-framework speed.

## The three layers

```
app source (server.ts — uses node:http, unmodified)
        │  geatsc compile graph (nodeResolution follows node:/bare imports)
        ▼
runtime/node/*.ts (http, events — TypeScript, compiled BY geatsc)
        │  intrinsics (plugin-declared ambient functions → direct C++ calls)
        ▼
runtime/gea_node.cpp (reactor: event loop, sockets, HTTP parser, allocator)
```

Everything ends up in **one translation unit**: geatsc emits `program.cpp`,
the [plugin](../plugin/index.mjs) `#include`s `gea_node.cpp` right after the
runtime umbrella, and clang (or g++) compiles the lot with whole-program
visibility (`-Os -flto` under clang, `-O2 -flto` under g++, `-fno-exceptions`,
`-fno-rtti`).

### Layer 1 — the reactor (`runtime/gea_node.cpp`)

A single-threaded reactor, written as namespaced RAII C++:

- **Event loop**: epoll on Linux (O(ready) kernel wait; interest changes
  re-armed via `EPOLL_CTL_MOD` only when a watcher's interest actually
  changed), `poll()` as the portable fallback (macOS). Each pass drains the
  geatsc microtask queue — this is what makes async handlers (promise
  continuations) progress — and fires due timers.
- **HTTP/1.x parser**: request line + header validation (whitespace-in-name
  smuggling guard, duplicate content-length check), content-length and
  chunked bodies (extensions ignored, trailers parsed and discarded), 16 KB
  header cap (431), 64 MB body cap (413), `Expect: 100-continue`
  auto-acknowledgement, connection semantics per version. Malformed input
  gets Node-identical error responses.
- **Dispatch contract**: each complete request calls the geatsc-emitted
  responder as a **template-deduced direct call** (no `std::function`, no
  boxing):

  ```
  (connId, flags, method, url, httpVersion, rawHeadBlock, body) → void
  ```

  The raw header block crosses as ONE string; TS materializes the
  `rawHeaders` array lazily, only if the app reads it. Responses come back
  through per-connection intrinsics — `__gea_http_write(connId, bytes)` /
  `__gea_http_done(connId, keepAlive)` — so a response can complete
  synchronously, from a microtask, or from a timer. The reactor holds the
  next pipelined request until the current response is done (ordering).
- **Timers**: a real timer registry; the plugin maps global
  `setTimeout`/`setInterval`/`clearTimeout` to intrinsics, and the loop's
  poll timeout is the next due delay. (The stock geatsc fallback degrades a
  delay to an immediate microtask — servers need real delays.)
- **Pool allocator** (Linux only): global `operator new/delete` override.
  Blocks are carved from 1 MB-aligned arena chunks registered in a lookup
  table; `release` masks a pointer to its chunk base — a hit recycles onto a
  per-size-class free list, a miss means "not ours" and routes to `free()`
  (always correct for the malloc-backed default operator new). Free-list
  links are read/written with `memcpy` — the raw `*(void**)` punning
  miscompiles under `-O2` strict aliasing. **Disabled on macOS**: Apple's
  prebuilt libc++ has internalized `free()` calls (e.g. inside the
  out-of-line `std::string::__grow_by_and_replace`) that no operator
  override can intercept; a pooled buffer freed there aborts. Linux
  interposition through the executable's exported operators is the
  documented, fully consistent mechanism.

### Layer 2 — the Node builtins (`runtime/node/*.ts`)

`node:http` and `node:events`, written in TypeScript and compiled by geatsc
like any other code. Design rules learned the hard way:

- **Response serialization matches Node byte-for-byte** (verified by the
  parity suite): app headers in insertion order, then Date (per-second
  cached), `Connection` + `Keep-Alive: timeout=5`, then the auto framing
  header last. `writeHead` commits the header block (so the body that
  follows streams chunked unless the app set Content-Length); a plain
  `end(body)` without writeHead emits an exact Content-Length; HTTP/1.0
  without a known length falls back to close-delimited; HEAD/1xx/204/304
  suppress the body.
- **Typed listener storage — no boxed listeners.** Each class stores its hot
  listeners in native typed slots:
  - `IncomingMessage`: `std::vector<std::function<void(std::string)>>` — one
    signature covers `'data'` (chunk) and the no-arg `'end'`/`'close'`
    (an arrow with fewer params adapts, exactly like JS).
  - `ServerResponse`: `std::function<void()>` for `'finish'`/`'close'`.
  - `Server`: typed `(req, res)` slots for `'request'`; `on('request')`
    registrations drain into typed adapters at `listen()` (startup-time), so
    per-request dispatch never boxes.
  The generic `EventEmitter` remains for cold/exotic events. Its storage is
  FLAT parallel arrays — nested arrays are avoided on purpose (element
  access on a nested vector yields a value copy in the emitted C++, so
  `listeners[i].push(fn)` mutations are silently lost).
- **The hot path is 100% typed C++** — audited in the emitted `program.cpp`:
  `writeHead`, `end`, `commitHeaders`, `setHeaderString`, `emitPayload`,
  `deliverBody`, `Socket` contain zero `gea_cpp_value`. Header objects are
  the native `gea_cpp_str_map` (string→string dictionary lowering for
  `Record<string,string>`); header lines are pre-joined into a typed
  `string[]` and serialized with a typed for-of; loop-indexed array reads
  compile to direct subscripts via the compiler's loop-bound prover.
- **Body delivery semantics**: the reactor buffers the full body before
  dispatch; `'data'`/`'end'` fire after the handler's synchronous chance to
  attach listeners (matching Node's paused-until-read model), with a
  microtask re-check when listeners attach late.

### Layer 3 — the compiler features this exercised

Work that landed in geatsc because of this project (each is general, not
http-specific):

- `gea_cpp_str_map`: `{[k: string]: string}` lowers to a native typed map
  (literal build, for-in, element reads all typed).
- String building: `+` concat chains and template literals build into one
  accumulator (`gea_cpp_append_value`) instead of quadratic per-step
  `to_string(l) + to_string(r)` copies.
- Loop-bound prover: `for (i = 0; i < arr.length; i++)` indexing the same
  receiver emits a direct typed subscript — the JS out-of-bounds `undefined`
  case is provably unreachable (guarded by a conservative no-shrink scan of
  the loop body).
- Deduced-receiver method calls (`auto&&` params) route through an SFINAE
  `->`/`.`/boxed dispatcher instead of a hardcoded member access.
- Tuple monomorphization: heterogeneous fixed tuples (`[RegExp, string, T]`,
  hono's router storage) lower to `std::tuple<...>` — typed slots, literal
  index reads via `std::get`, typed destructuring, canonical spelling
  program-wide, with element-wise binding casts across every boxed boundary.
- Dynamic-boundary integrity: values crossing into `gea_cpp_value` keep their
  shape — `std::optional<T>` unwraps (was an inert object), `shared_ptr`
  identity round-trips through `object_owner`, typed lambdas whose params
  aren't gcv-shaped box through an argument-converting `std::function`
  adapter (the arity-dispatch probes lie under C++20 aggregate paren-init),
  and `Object.keys/values/entries` iterate dictionary storages
  (`gea_cpp_map`/`gea_cpp_str_map`, boxed or native) instead of emitting
  statically-empty lists.
- Top-level destructuring declarations bind their targets (each gets a typed
  global slot; the whole pattern defers into `__gea_top_level()` as a
  destructuring assignment — previously only the initializer's side effects
  survived).
- Assorted correctness fixes surfaced by this codebase: narrowed
  `this.#field` return casts, nested-vector array-literal element casts, the
  `this[dynamicKey] = v` static-field router ordering.

## The parity harness (how we know it's complete)

“Feature complete” is a claim; [apps/http-parity](../apps/http-parity) is the
evidence. One TypeScript app exercising the full surface runs under
gea-native and under real Node (≥22, type stripping). The driver opens raw
TCP sockets, sends 36 hand-written HTTP scenarios (including malformed ones),
captures complete responses, normalizes ONLY the Date header value, and
requires byte equality. Servers restart per case so a crash cannot
contaminate later cases (relevant: Node's process dies on a throwing handler
— ours answers 500; that case is excluded as a documented, intentional
difference).

Run it: see README quick start. Expected output: `36/36 parity, 0 diffs`.

## Compile-from-source (the zero-boxing pipeline)

npm libraries ship compiled `.js` with all TypeScript generics erased —
geatsc then has no type parameters to monomorphize, and generic values
(hono's `Context<E>`, router handlers) must box. Compiling the library from
its typed `.ts` source restores the generics and the whole chain emits as
typed C++ templates.

- This is **not a flag and not a checked-in copy**. The compiler acquires a
  dependency's typed source for the exact version the application installed,
  from the repository and commit recorded in that version's npm metadata, and
  caches it under `node_modules/.cache/geatsc/sources`. Both the registry
  identity and the checkout's package identity must match; there is no
  latest-branch or tag-guess fallback, and a failed checkout retains the
  installed implementation rather than compiling something else.
- The app's `import from 'hono/tiny'` is untouched: only the output-to-source
  mapping changes.
- A `vendored-sources/<pkg>` submodule used to serve this purpose and is gone.
  A checkout pinned to one version answered for whatever version the
  application had actually installed, and kept answering after the dependency
  moved.
- Cross-module name collisions (hono declares `class Hono` in two modules)
  are handled by the compiler: colliding class declarations get mangled
  emitted keys and references resolve through their checker symbols;
  colliding module-level GLOBALS are rejected with a compile-time diagnostic
  (loud failure instead of a silently shared cell) until they get the same
  symbol-based treatment.

### MongoDB source boundary

Native builds that select `mongodb` resolve the package root to the fork's
`src/gea.ts` entry. This entry keeps the application's normal `mongodb` import
and typed collection API while limiting the compiled graph to the direct
OP_MSG client the target currently supports. BSON is compiled from the typed
source acquired for its installed version. The ordinary Node build resolves the
official npm entry.

The TypeScript entry serializes a command into BSON and crosses three typed
intrinsics: pool open, request/response exchange, and pool close. The C++
runtime owns the corresponding sockets. Each client eagerly opens one socket,
leases an idle socket for one synchronous OP_MSG exchange, and returns it to
the pool. `SO_KEEPALIVE` and `TCP_NODELAY` are enabled; pool size is bounded to
1–64. This removes DNS, TCP setup, and teardown from steady-state CRUD.

The exact supported API, wire frame, failure behavior, pool lifecycle, and
missing topology/authentication features are documented in
the `hono-mongodb-todo` app.
The app's own README lists the independent ping, CRUD, full-stack, browser and
connection-reuse checks.

## Performance notes (what actually mattered)

Measured on the idle benchmark box; the full history with numbers is in
[BENCHMARKS.md](../BENCHMARKS.md). In order of impact:

1. **Kill dynamic-value traffic** (`gea_cpp_value`) — the typed dispatch
   boundary, typed header maps, typed listeners. Boxing was never one big
   cost; it was death by make_shared: each box allocates bridge closures.
2. **`-Os -flto` on clang, `-O2 -flto` on g++, never `-O3`** — the flag
   answer depends on the compiler, so it was measured on both (four pinned
   workers, 2026-09-22, compiler 1.0.17). clang 18, raw server: `-O2`
   304-313k req/s at 1.72 MB, `-O2 -flto` 304-308k at 1.64 MB, `-Os -flto`
   307-320k at 1.05 MB, `-O3` level with `-O2` at +5% size. clang 18, Hono:
   `-O2 -flto` 141-144k at 7.27 MB, `-Os -flto` 150-152k at 5.04 MB — more
   instructions per request (35,966 vs 33,540) but fewer cycles (31,662 vs
   37,454): the hot path is instruction-cache bound and smaller code wins.
   g++ 13: `-O2` 290k, `-O3 -flto` 292k (inside the noise), `-Os` −25% at
   1.65 MB; and g++ is 4-10% behind clang on the same emitted source.
   Stripped, and `-lcrypto` only when `node:crypto` is reached (0.45 MB of PSS
   per process otherwise). Always measure, and say which compiler.
3. **Pool allocator** — +31%; a server's steady state allocates the same few
   sizes forever, and recycling beats even a good general malloc.
4. **epoll** + syscall-adjacent trims (move the response buffer instead of
   copying, per-second Date cache by reference, request-line parse in place).
5. **Beware invisible per-call boxing**: `emit('request', req, res)` boxes
   its ARGUMENTS at the call site even with zero listeners (arguments are
   evaluated before emit can bail) — that single ungated call cost 40% of
   total throughput before it was gated/typed.

## Gotchas for future work

- Overriding a base-class method with a body that touches typed `this` state
  breaks in the class-prototype re-emission (boxed receiver, no binding
  casts on args). Until the emitter lowers that path storage-aware, use the
  drain-at-listen pattern or module-level helpers.
- Module-level globals are still keyed by bare name program-wide; a
  cross-module collision is a compile error (rename one side). Classes are
  fully disambiguated.
- `pkill -f <name>` in an inline ssh command matches the ssh command line
  itself and kills the session — put remote process management in script
  files on the box.
- Benchmark discipline: interleave rounds, print the load average with every
  sample, and never compare numbers taken under different machine load.
