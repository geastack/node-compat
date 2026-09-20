# MongoDB direct write benchmark

This matrix compares the official MongoDB Node.js, Rust, and C++ drivers against
the same local MongoDB server. It is intentionally a direct-driver benchmark;
HTTP routing is not in the timed path.

The two workloads are:

- `insert-one`: sequential acknowledged `insertOne` calls.
- `insert-many`: sequential acknowledged `insertMany` calls over pre-split
  batches (100 documents by default).

Each driver pre-generates the same BSON-shaped todo documents before timing:
`_id` and `seq` are BSON int64, `priority` is BSON int32, and the remaining
fields have identical names, order, values, and types. Connection setup, ping,
document construction, driver warmup, count validation, and cleanup are outside
the timed region. Every timed sample checks both acknowledged result counts and
`countDocuments`; invalid samples stop the matrix.

The write concern variants are explicit `w=1,journal=false` and
`w=1,journal=true`. One client process/thread runs at a time, pinned to one CPU,
and case order rotates between rounds. The MongoDB server is shared and remains
warm between samples.

On the configured Ubuntu benchmark server, from the `node-compat` directory:

```sh
ROUNDS=5 bench/mongodb/run-remote.sh
```

Useful overrides are `INSERT_ONE_DOCUMENTS`, `INSERT_MANY_DOCUMENTS`,
`BATCH_SIZE`, `CLIENT_CPU`, `MONGODB_URI`, `MONGOCXX_PREFIX`, and `RESULT_DIR`.
Raw per-sample JSON, a validated TSV matrix, build/version metadata, and the
median summary are written under `bench/results/mongodb-write-*`.
