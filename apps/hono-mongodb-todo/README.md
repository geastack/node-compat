# Hono + MongoDB + Gea todo

A deliberately small full-stack application with one implementation shared by
Node and geatsc:

- the browser UI is the published `@geajs/core` package, compiled by the
  official `@geajs/vite-plugin`;
- the HTTP application is Hono's `tiny` preset;
- persistence uses the official `mongodb` Node.js driver under Node and the
  package fork's typed Gea entry in native builds, with the same
  `Collection<TodoDocument>` application calls;
- the Node HTTP bridge carries the request body and `content-type` into the
  Fetch `Request` consumed by Hono;
- Vite output is embedded as typed string constants, so the native server does
  not need a filesystem implementation at runtime.

Package versions are pinned to versions already present in this workspace or
the local npm cache: `@geajs/core` 1.4.0, `@geajs/vite-plugin` 1.4.1, Hono
4.12.27, MongoDB driver 7.1.1, its locked BSON dependency 7.3.1,
TypeScript 6.0.3, and Vite 8.1.0.

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

## Native source-compilation modes

Both commands regenerate and embed the Gea frontend before compiling the same
`server.ts` file:

```sh
# Compile Hono from its vendored TypeScript source. The MongoDB package still
# resolves through its published package entry.
npm run build:native:hono

# Compile Hono, the MongoDB package's Gea entry, BSON, and the driver's
# connection-string parser from vendored TypeScript.
npm run build:native:hono-mongodb
```

The first mode isolates the Hono source-compilation path. The second is the
complete native application path. It compiles the MongoDB fork's supported Gea
surface and official BSON implementation instead of hiding persistence behind
app-level casts or a substitute database client. The
`mongodb-connection-string-url` override preserves generic map and URL search
parameter types that the published JavaScript has erased.

`npm run native:hono` and `npm run native:hono-mongodb` build and launch their
corresponding executables. Keep MongoDB and benchmark clients on the same
remote host when comparing write throughput so network latency is identical.

## What the native MongoDB build contains

The native build resolves the application's unchanged `import "mongodb"` to
the fork's typed Gea entry. That entry, vendored BSON, Hono, the app, and the
node-compat runtime are compiled into one native executable. It sends real
BSON-bearing OP_MSG commands to MongoDB through a client-owned native TCP pool;
there is no Node process or database sidecar in the runtime path.

The Gea entry implements the direct single-host API used here: client
connection and close, database commands, sorted first-batch finds, and
acknowledged single-document insert, find, update, and delete operations. It is
not the complete official driver's topology, authentication, TLS, retry,
session, or cursor surface.

Each `MongoClient` eagerly opens one socket and reuses it across sequential
commands. `maxPoolSize` defaults to four and is clamped between one and 64.
The benchmark fixes it at one for parity with every comparison driver.

## Native correctness

Build the shared compiler in `geastack/compiler` first. Then run the focused
native probes from this app:

```sh
npm run run:native:mongodb-ping
npm run run:native:mongodb-crud
```

The ping probe requires `PING:1`. The CRUD probe requires the deterministic
marker
`0123456789abcdef01234567:created:false:updated:true:1:absent`. The runner adds
`MONGODB_NATIVE_CORRECTNESS_RUN_OK:ping` or
`MONGODB_NATIVE_CORRECTNESS_RUN_OK:crud` only after checking the exact marker.

For the complete app, build and launch the native Hono + MongoDB executable,
then run the HTTP lifecycle checker from another shell:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run native:hono-mongodb
GEA_TODO_BASE_URL=http://127.0.0.1:3000 npm run check:fullstack
```

The full build required an 8 GB compiler heap on the measured development
machine after Node's default 4 GB heap was exhausted. The emitted executable
does not inherit that heap setting.

## Driver benchmark

```sh
npm run benchmark:drivers
```

The suite compares the compiled Gea entry with the official Node.js, Rust, and
C++ drivers. It runs the same sequential acknowledged insert, indexed find,
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
