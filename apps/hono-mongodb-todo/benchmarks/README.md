# MongoDB driver benchmark

This suite compares the official `mongodb` driver compiled natively by geatsc
(from its TypeScript source, with `--source-project
node_modules/mongodb/tsconfig.json`) with the official Node.js, Rust, and C++
drivers against the same local MongoDB server. It times sequential,
acknowledged `insertOne`, indexed `findOne`, `updateOne`, and `deleteOne` phases.

How the native build compiles the driver is documented in the app README.

The timed region excludes client construction, connection setup, collection
cleanup, document allocation, and warmup. Every implementation uses the same
logical schema and a 256-byte payload. Every driver is constrained to one
warmed pooled connection.

Requirements:

- MongoDB listening on `127.0.0.1:27017`
- Node.js dependencies installed for the todo app
- Rust and Cargo
- `mongo-cxx-driver` installed through Homebrew
- Homebrew `wrk` for the full-stack HTTP stress profile

On Linux the same commands run with distribution packages (`wrk`, GNU
`/usr/bin/time`); an arm whose toolchain is missing (Cargo, or a
`libmongocxx1` that pkg-config can find) is skipped and named in the report,
and the macOS-only `leaks` heap snapshot is reported as not measured. Set
`BENCH_RESULTS_DIR=<dir>` to write the reports somewhere other than the
tracked `results/` directory, as any run on a machine other than the one the
published numbers come from should.

Run the full benchmark:

```sh
npm run benchmark:drivers
```

Run the longer four-driver endurance pass with macOS peak-RSS accounting:

```sh
npm run benchmark:stress
```

Run native-versus-Node full-stack HTTP stress over both the embedded static
route and MongoDB-backed todo listing:

```sh
npm run benchmark:http
```

Run three Mongo-free BSON profiles (small mixed document, 256-KiB string, and
4,096-integer array), concurrent pool-size profiles, large documents, and batch
writes across all four drivers:

```sh
npm run benchmark:flex
```

The endurance runner defaults to three rounds with 20,000 commands in each of
four CRUD phases per driver. The HTTP runner defaults to three five-second
rounds at 1, 16, and 64 connections. Both require existing native binaries;
the ordinary driver benchmark builds those binaries first.

Peak-RSS collection currently uses macOS `/usr/bin/time -l`. The HTTP runner
samples each server with `ps`, reads the installed wrk version from Homebrew,
and owns ports 3011 and 3012 for the duration of the run.

For a quicker diagnostic run:

```sh
node benchmarks/run.mjs --rounds=3 --skip-build
```

The native and Node arms run a fixed 20,000 operations per phase after 2,000
warmup rounds (the native build cannot read the environment yet), so the
runners reject an `--iterations` or `--warmup` that differs from those counts.

Pass `--skip-build` to reuse already compiled release binaries when isolating a
measurement from compiler activity.

The runner compiles release binaries, rotates driver order between rounds, and
writes raw samples to `benchmarks/results/latest.json` and a summary to
`latest.md`.

The stress runners write their reports beside the baseline as
`stress-latest.{md,json}`, `http-stress-latest.{md,json}`, and
`flex-latest.{md,json}`; `driver-cpu.mjs` writes `driver-cpu-latest.{md,json}`.
Only the `.json` files are tracked in `results/`. A stress result is publishable only when the machine is
otherwise idle, every measured process completes its correctness checks, every
wrk profile reports zero HTTP/socket errors, and both servers pass the
full-stack CRUD checker after load.

The tracked seven-round run measured 3,709 combined operations per second for
Gea: 1.07× the official Node.js driver, effectively tied with Rust, and 4.5%
behind C++ on the measured Apple M4 Max. These numbers apply only to this
warmed, single-connection, sequential workload.

The tracked endurance run completed 480,000 timed MongoDB commands. Gea used
71.2 MiB peak RSS versus Node's 121.0 MiB while sustaining 0.99× Node's
throughput. The current full-stack HTTP run completed 1,273,746 measured
requests with zero errors; the native server peaked at 24.7 MiB versus 292.2
MiB for Node and both servers passed CRUD after stress. The flex run shows Gea
at 1.15×, 1.11×, and 1.11× Node throughput for MongoDB pool sizes 1, 4, and 16,
then 0.71× at pool 64. Its independent raw BSON profiles replace the old mixed
aggregate, record a roughly 1,100× per-document reduction in the former
large-string decode cliff, and expose the remaining string-validation and
numeric-key encoding costs. The raw samples for each run are in `results/`.

The September 2026 remote Linux run adds full Hono
single- and eight-worker comparisons, MongoDB concurrency and pool-size
matrices, and identical BSON-only workloads under Gea, Node, and Rust. Full
Hono sustained 1.64–1.90× Node's throughput with much lower PSS, while in the
isolated BSON workloads Gea was 4.8–10.0× slower than Node.
