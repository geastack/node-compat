import { deserialize, serialize, type Document } from "bson";
import { MongoClient, ObjectId, type Db } from "mongodb";

declare function __gea_node_process_env(): {
  [key: string]: string | undefined;
};

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function waitForAll(promises: Promise<number>[]): Promise<number> {
  return new Promise<number>((resolve, reject): void => {
    let remaining = promises.length;
    let completed = 0;
    const observations: Promise<number>[] = [];
    if (remaining === 0) {
      resolve(0);
      return;
    }
    for (let index = 0; index < promises.length; index += 1) {
      observations.push(
        promises[index]
          .then((count: number): number => {
            completed += count;
            remaining -= 1;
            if (remaining === 0) resolve(completed);
            return count;
          })
          .catch((reason: unknown): number => {
            reject(reason);
            return 0;
          }),
      );
    }
  });
}

function pingWorker(database: Db, count: number): Promise<number> {
  if (count === 0) return Promise.resolve(0);
  return database
    .command({ ping: 1 })
    .then((reply: Document): Promise<number> => {
      if (reply.ok !== 1) throw new Error("ping failed");
      return pingWorker(database, count - 1).then(
        (completed: number): number => completed + 1,
      );
    });
}

function concurrentPings(
  database: Db,
  total: number,
  concurrency: number,
): Promise<number> {
  const workers: Promise<number>[] = [];
  const base = Math.floor(total / concurrency);
  const extra = total % concurrency;
  for (let index = 0; index < concurrency; index += 1) {
    workers.push(pingWorker(database, base + (index < extra ? 1 : 0)));
  }
  return waitForAll(workers);
}

function bsonSmallCase(iterations: number): void {
  const small: Document = {
    _id: new ObjectId(),
    title: "todo",
    completed: false,
    revision: 1,
    payload: "0123456789abcdef".repeat(16),
  };
  const smallBytes = serialize(small);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(small).length;
  const smallEncode = elapsed(startedAt);

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(smallBytes);
    const revision: unknown = decoded.revision;
    if (typeof revision !== "number") throw new Error("missing revision");
    checksum += revision;
  }
  const decode = elapsed(startedAt);

  console.log(
    `FLEX_RESULT:${JSON.stringify({
      driver: "gea-native",
      mode: "bson-small",
      checksum,
      operations: { encode: iterations, decode: iterations },
      milliseconds: { encode: smallEncode, decode },
      bytes: smallBytes.length,
    })}`,
  );
}

function bsonStringCase(iterations: number): void {
  const document: Document = { payload: "x".repeat(256 * 1024) };
  const bytes = serialize(document);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(document).length;
  const encode = elapsed(startedAt);

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(bytes);
    const payload: unknown = decoded.payload;
    if (typeof payload !== "string") throw new Error("missing payload");
    checksum += payload.length;
  }
  const decode = elapsed(startedAt);

  console.log(
    `FLEX_RESULT:${JSON.stringify({
      driver: "gea-native",
      mode: "bson-string-256k",
      checksum,
      operations: { encode: iterations, decode: iterations },
      milliseconds: { encode, decode },
      bytes: bytes.length,
    })}`,
  );
}

function bsonArrayCase(iterations: number): void {
  const values: number[] = [];
  for (let index = 0; index < 4096; index += 1) values.push(index);
  const document: Document = { values };
  const bytes = serialize(document);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(document).length;
  const encode = elapsed(startedAt);

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(bytes);
    const decodedValues: unknown = decoded.values;
    if (!Array.isArray(decodedValues)) throw new Error("missing values");
    checksum += decodedValues.length;
  }
  const decode = elapsed(startedAt);

  console.log(
    `FLEX_RESULT:${JSON.stringify({
      driver: "gea-native",
      mode: "bson-array-4096",
      checksum,
      operations: { encode: iterations, decode: iterations },
      milliseconds: { encode, decode },
      bytes: bytes.length,
    })}`,
  );
}

async function mongoCase(
  mode: string,
  iterations: number,
  poolSize: number,
  concurrency: number,
  collectionName: string,
): Promise<void> {
  const client = new MongoClient("mongodb://127.0.0.1:27017", {
    maxPoolSize: poolSize,
  });
  const database = client.db("gea_driver_benchmark");
  const collection = database.collection<{ _id: ObjectId }>(collectionName);
  await client.connect();
  try {
    await database.command({ ping: 1 });
    if (mode === "concurrent") {
      await concurrentPings(
        database,
        Math.min(iterations, concurrency),
        concurrency,
      );
      const startedAt = Date.now();
      const completed = await concurrentPings(
        database,
        iterations,
        concurrency,
      );
      console.log(
        `FLEX_RESULT:${JSON.stringify({
          driver: "gea-native",
          mode,
          iterations: completed,
          poolSize,
          concurrency,
          milliseconds: { concurrentPing: elapsed(startedAt) },
        })}`,
      );
      return;
    }

    if (mode === "batch") {
      const batchSize = 100;
      let inserted = 0;
      let startedAt = Date.now();
      while (inserted < iterations) {
        const documents: Document[] = [];
        const count = Math.min(batchSize, iterations - inserted);
        for (let index = 0; index < count; index += 1) {
          documents.push({
            _id: new ObjectId(),
            group: "batch",
            revision: 1,
            payload: "x".repeat(256),
          });
        }
        await database.command({
          insert: collectionName,
          documents,
          ordered: true,
        });
        inserted += count;
      }
      const insertBatch = elapsed(startedAt);
      startedAt = Date.now();
      const update = await database.command({
        update: collectionName,
        updates: [
          {
            q: { group: "batch" },
            u: { $set: { revision: 2 } },
            multi: true,
            upsert: false,
          },
        ],
      });
      if ((update.n as number) !== iterations)
        throw new Error("bulk update count mismatch");
      const bulkUpdate = elapsed(startedAt);
      console.log(
        `FLEX_RESULT:${JSON.stringify({
          driver: "gea-native",
          mode,
          iterations,
          batchSize,
          milliseconds: { insertBatch, bulkUpdate },
        })}`,
      );
      return;
    }

    const values: number[] = [];
    for (let index = 0; index < 4096; index += 1) values.push(index);
    const ids: ObjectId[] = [];
    let startedAt = Date.now();
    for (let index = 0; index < iterations; index += 1) {
      const id = new ObjectId();
      ids.push(id);
      await collection.insertOne({
        _id: id,
        payload: "x".repeat(256 * 1024),
        values,
      });
    }
    const largeInsert = elapsed(startedAt);
    startedAt = Date.now();
    for (let index = 0; index < ids.length; index += 1) {
      const found = await collection.findOne({ _id: ids[index] });
      if (found === null || (found.values as number[]).length !== 4096)
        throw new Error("large document mismatch");
    }
    const largeFind = elapsed(startedAt);
    console.log(
      `FLEX_RESULT:${JSON.stringify({
        driver: "gea-native",
        mode: "large",
        iterations,
        documentBytes: 256 * 1024,
        arrayElements: 4096,
        milliseconds: { largeInsert, largeFind },
      })}`,
    );
  } finally {
    await client.close();
  }
}

async function run(): Promise<void> {
  const env = __gea_node_process_env();
  const mode = env.BENCH_MODE ?? "bson-small";
  const iterations = Number(env.BENCH_ITERATIONS ?? "1000");
  const poolSize = Number(env.BENCH_POOL_SIZE ?? "4");
  const concurrency = Number(env.BENCH_CONCURRENCY ?? "64");
  const collectionName = env.BENCH_COLLECTION ?? "flex_gea";
  if (mode === "bson-small") {
    bsonSmallCase(iterations);
    return;
  }
  if (mode === "bson-string-256k") {
    bsonStringCase(iterations);
    return;
  }
  if (mode === "bson-array-4096") {
    bsonArrayCase(iterations);
    return;
  }
  await mongoCase(mode, iterations, poolSize, concurrency, collectionName);
}

await run();
