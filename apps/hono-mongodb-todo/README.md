# Hono + MongoDB + Gea todo

A deliberately small full-stack application with one implementation shared by
Node and geatsc:

- the browser UI is the published `@geajs/core` package, compiled by the
  official `@geajs/vite-plugin`;
- the HTTP application is Hono's default `Hono` export (`import { Hono } from
  'hono'`);
- persistence uses the official `mongodb` Node.js driver in both runtimes:
  under Node from its published JavaScript, in native builds compiled from the
  TypeScript source the published package ships;
- the Node HTTP bridge carries the request body and `content-type` into the
  Fetch `Request` consumed by Hono;
- Vite output is embedded as typed string constants, so the native server does
  not need a filesystem implementation at runtime.

Package versions are pinned in `package.json` and `package-lock.json`:
`@geajs/core` 1.4.2, `@geajs/vite-plugin` 1.4.2, Hono 4.12.27, MongoDB driver
7.1.1, its locked BSON dependency 7.3.3, TypeScript 6.0.3, and Vite 8.1.0.

## Run under Node

Start MongoDB on `127.0.0.1:27017`, then:

```sh
npm install
npm run check
npm run node
```

Open <http://127.0.0.1:3000>. The database name is `gea_hono_todo`.
The server prints its listening message only after the official MongoDB client
has connected and completed an `admin` database ping.

With either the Node or native server running, execute the deterministic
full-stack HTTP correctness check from another shell:

```sh
npm run check:fullstack
```

Set `GEA_TODO_BASE_URL` to check a server at a different origin. The checker
fetches the embedded HTML, JavaScript, and CSS, then verifies the complete
POST, GET, PATCH, DELETE, and final-absence lifecycle for one captured todo ID.

The JSON API is intentionally straightforward for benchmarking:

```sh
curl http://127.0.0.1:3000/api/todos
curl -X POST http://127.0.0.1:3000/api/todos \
  -H 'content-type: application/json' \
  -d '{"title":"Compile the MongoDB driver"}'
curl -X PATCH http://127.0.0.1:3000/api/todos/TODO_ID \
  -H 'content-type: application/json' \
  -d '{"completed":true}'
curl -X DELETE http://127.0.0.1:3000/api/todos/TODO_ID
```

## Native build

Native builds use node-compat's `scripts/build.mjs`, which needs
`@geastack/compiler` (run `npm install` at the node-compat repository root, or
set `GEA_COMPILER_DIR` to a built compiler checkout) and a C++ compiler (`$CXX`,
default `clang++`). The command regenerates and embeds the Gea frontend, then
compiles `server.ts` with Hono, the official mongodb driver and BSON from their
TypeScript sources:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run build:native:hono-mongodb
```

`--source-project node_modules/mongodb/tsconfig.json` points the build at the
driver's own `tsconfig.json`, so the driver's TypeScript source in
`node_modules/mongodb/src` is checked with the driver's own language options.
There is no vendored driver checkout and no package override.

`npm run native:hono-mongodb` builds and launches the executable,
`dist/hono-mongodb`. Keep MongoDB and benchmark clients on the same remote host
when comparing write throughput so network latency is identical.

Hono without the driver is built and tested by node-compat's own
`apps/hono-hello` (see the repository README).

## What the native MongoDB build contains

The native build compiles the application's unchanged `import "mongodb"` from
the installed driver's TypeScript source. The driver, BSON, Hono, the app, and
the node-compat runtime are compiled into one native executable that sends
BSON OP_MSG commands to MongoDB over node-compat's native sockets; there is no
Node process or database sidecar in the runtime path.

The benchmark clients set `maxPoolSize: 1, minPoolSize: 1` for parity with
every comparison driver.

## Native correctness

Prerequisites: `mongod` listening on `127.0.0.1:27017`, this app's
dependencies installed (`npm install`, which includes `tsx` for the Node
reference run), and the compiler available as above.

Build and check each probe in one step:

```sh
npm run build:native:mongodb-ping
npm run build:native:mongodb-crud
```

Each runs `scripts/native-mongodb-correctness.mjs` on a probe in
`correctness/native/` (`mongodb-cmap-ping`, `mongodb-source-crud`): it builds
the probe into `dist/correctness/<probe>/`, runs the probe under Node with
`tsx` and as the native binary, and requires identical stdout and exit codes.
It prints `MONGODB_NATIVE_CORRECTNESS_OK:<probe>` or
`MONGODB_NATIVE_CORRECTNESS_MISMATCH:<probe>` with a line diff, then a
`MONGODB_NATIVE_CORRECTNESS_SUMMARY` line, and exits non-zero on any failure.

`npm run run:native:mongodb-ping` and `npm run run:native:mongodb-crud` pass
`--skip-build`: they repeat the comparison against binaries already built by
the commands above. `npm run correctness:native` builds and checks every probe
in `correctness/native/`.

For the complete app, build and launch the native Hono + MongoDB executable,
then run the HTTP lifecycle checker from another shell:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run native:hono-mongodb
GEA_TODO_BASE_URL=http://127.0.0.1:3000 npm run check:fullstack
```

The full build required an 8 GB compiler heap on the measured development
machine after Node's default 4 GB heap was exhausted. The emitted executable
does not inherit that heap setting. The server is a large program, so the
build splits it into per-file translation units on its own and, where a
full-LTO link would not fit in memory, links them with ThinLTO (clang) or
without LTO (g++); a `[build]` line says which. A one-unit full-LTO build of
it needs about 25 GB.

## Driver benchmark

```sh
npm run benchmark:drivers
```

The suite compares the natively compiled official driver with the official
Node.js driver under Node, and with the Rust and C++ drivers. It runs the same sequential acknowledged insert, indexed find,
update, and delete workload over one warmed pooled connection. Driver order
rotates across seven rounds, and the runner records medians and all raw samples.

- Runner and implementations: [`benchmarks`](benchmarks)
- Raw samples and metadata: [`benchmarks/results/latest.json`](benchmarks/results/latest.json)

The tracked stress runs completed 480,000 timed driver commands and 2,937,997
HTTP requests without a CRUD mismatch, HTTP error, or socket error. The native
server remained at 22.4 MiB peak RSS under load, while Node reached 296.8 MiB.
At one MongoDB-backed HTTP connection their throughput was effectively equal;
at 16 and 64 connections Node was roughly three times faster because its driver
overlaps operations while the current Gea host exchange blocks the reactor for
each complete request/response command.

## Asset embedding

`npm run build:assets` runs Vite and then `scripts/embed-frontend.mjs`. The
embed step requires exactly one JavaScript and one CSS output, sorts filenames,
and rewrites `generated/frontend-assets.ts` deterministically. The generated
module is imported directly by `server.ts`; no `node:fs` import enters the
native application graph.
