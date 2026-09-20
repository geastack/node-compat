import { deserialize, ObjectId, serialize } from "bson";
import { MongoClient } from "mongodb";

const mode = process.env.BENCH_MODE ?? "bson-small";
const iterations = Number(process.env.BENCH_ITERATIONS ?? "1000");
const poolSize = Number(process.env.BENCH_POOL_SIZE ?? "4");
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? "64");
const collectionName = process.env.BENCH_COLLECTION ?? "flex_node";

function emitBsonResult(checksum, bytes, encode, decode) {
  console.log(
    `FLEX_RESULT:${JSON.stringify({ driver: "nodejs-official", mode, checksum, operations: { encode: iterations, decode: iterations }, milliseconds: { encode, decode }, bytes })}`,
  );
}

function bsonSmallCase() {
  const small = {
    _id: new ObjectId(),
    title: "todo",
    completed: false,
    revision: 1,
    payload: "0123456789abcdef".repeat(16),
  };
  const smallBytes = serialize(small);
  let checksum = 0;
  let startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(small).length;
  const smallEncode = performance.now() - startedAt;
  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += deserialize(smallBytes).revision;
  const decode = performance.now() - startedAt;
  emitBsonResult(checksum, smallBytes.length, smallEncode, decode);
}

function bsonStringCase() {
  const document = { payload: "x".repeat(256 * 1024) };
  const bytes = serialize(document);
  let checksum = 0;
  let startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(document).length;
  const encode = performance.now() - startedAt;
  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += deserialize(bytes).payload.length;
  const decode = performance.now() - startedAt;
  emitBsonResult(checksum, bytes.length, encode, decode);
}

function bsonArrayCase() {
  const document = {
    values: Array.from({ length: 4096 }, (_, index) => index),
  };
  const bytes = serialize(document);
  let checksum = 0;
  let startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += serialize(document).length;
  const encode = performance.now() - startedAt;
  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1)
    checksum += deserialize(bytes).values.length;
  const decode = performance.now() - startedAt;
  emitBsonResult(checksum, bytes.length, encode, decode);
}

async function mongoCase() {
  const client = new MongoClient(
    "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false",
    {
      maxPoolSize: poolSize,
      minPoolSize: 1,
    },
  );
  const database = client.db("gea_driver_benchmark");
  const collection = database.collection(collectionName);
  await client.connect();
  try {
    await database.command({ ping: 1 });
    if (mode === "concurrent") {
      const worker = async (count) => {
        for (let index = 0; index < count; index += 1)
          await database.command({ ping: 1 });
        return count;
      };
      const counts = Array.from(
        { length: concurrency },
        (_, index) =>
          Math.floor(iterations / concurrency) +
          (index < iterations % concurrency ? 1 : 0),
      );
      await Promise.all(counts.map((count) => worker(Math.min(count, 1))));
      const startedAt = performance.now();
      const completed = (await Promise.all(counts.map(worker))).reduce(
        (sum, count) => sum + count,
        0,
      );
      console.log(
        `FLEX_RESULT:${JSON.stringify({ driver: "nodejs-official", mode, iterations: completed, poolSize, concurrency, milliseconds: { concurrentPing: performance.now() - startedAt } })}`,
      );
      return;
    }
    if (mode === "batch") {
      const batchSize = 100;
      let inserted = 0;
      let startedAt = performance.now();
      while (inserted < iterations) {
        const count = Math.min(batchSize, iterations - inserted);
        const documents = Array.from({ length: count }, () => ({
          _id: new ObjectId(),
          group: "batch",
          revision: 1,
          payload: "x".repeat(256),
        }));
        await collection.insertMany(documents, { ordered: true });
        inserted += count;
      }
      const insertBatch = performance.now() - startedAt;
      startedAt = performance.now();
      const updated = await collection.updateMany(
        { group: "batch" },
        { $set: { revision: 2 } },
      );
      if (updated.matchedCount !== iterations)
        throw new Error("bulk update count mismatch");
      const bulkUpdate = performance.now() - startedAt;
      console.log(
        `FLEX_RESULT:${JSON.stringify({ driver: "nodejs-official", mode, iterations, batchSize, milliseconds: { insertBatch, bulkUpdate } })}`,
      );
      return;
    }
    const values = Array.from({ length: 4096 }, (_, index) => index);
    const ids = [];
    let startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const id = new ObjectId();
      ids.push(id);
      await collection.insertOne({
        _id: id,
        payload: "x".repeat(256 * 1024),
        values,
      });
    }
    const largeInsert = performance.now() - startedAt;
    startedAt = performance.now();
    for (const id of ids) {
      const found = await collection.findOne({ _id: id });
      if (found === null || found.values.length !== 4096)
        throw new Error("large document mismatch");
    }
    const largeFind = performance.now() - startedAt;
    console.log(
      `FLEX_RESULT:${JSON.stringify({ driver: "nodejs-official", mode: "large", iterations, documentBytes: 256 * 1024, arrayElements: 4096, milliseconds: { largeInsert, largeFind } })}`,
    );
  } finally {
    await client.close();
  }
}

if (mode === "bson-small") bsonSmallCase();
else if (mode === "bson-string-256k") bsonStringCase();
else if (mode === "bson-array-4096") bsonArrayCase();
else await mongoCase();
