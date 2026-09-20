import { MongoClient, ObjectId, type Document } from "mongodb";

declare function __gea_node_process_env(): {
  [key: string]: string | undefined;
};

interface BenchmarkDocument {
  _id: ObjectId;
  title: string;
  completed: boolean;
  revision: number;
  payload: string;
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

async function run(): Promise<void> {
  const benchmarkEnv = __gea_node_process_env();
  const iterations = Number(benchmarkEnv.BENCH_ITERATIONS ?? "1000");
  const warmup = Number(benchmarkEnv.BENCH_WARMUP ?? "50");
  const collectionName = benchmarkEnv.BENCH_COLLECTION ?? "driver_gea";
  const client = new MongoClient("mongodb://127.0.0.1:27017", {
    maxPoolSize: 1,
  });
  const database = client.db("gea_driver_benchmark");
  const collection = database.collection<BenchmarkDocument>(collectionName);
  const payload =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const ids: ObjectId[] = [];
  const documents: Document[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const id = new ObjectId();
    ids.push(id);
    documents.push({
      _id: id,
      title: "todo",
      completed: false,
      revision: 1,
      payload,
    });
  }

  await client.connect();
  try {
    for (let index = 0; index < warmup; index += 1) {
      const id = new ObjectId();
      await collection.deleteOne({ _id: id });
      await collection.insertOne({
        _id: id,
        title: "warmup",
        completed: false,
        revision: 1,
        payload,
      });
      await collection.findOne({ _id: id });
      await collection.updateOne(
        { _id: id },
        { $set: { completed: true, revision: 2 } },
      );
      await collection.deleteOne({ _id: id });
    }

    let startedAt = Date.now();
    for (let index = 0; index < iterations; index += 1) {
      await collection.insertOne(documents[index]);
    }
    const insertMs = elapsed(startedAt);

    startedAt = Date.now();
    for (let index = 0; index < iterations; index += 1) {
      const found = await collection.findOne({ _id: ids[index] });
      if (found === null) throw new Error("findOne missed a seeded document");
    }
    const findMs = elapsed(startedAt);

    startedAt = Date.now();
    for (let index = 0; index < iterations; index += 1) {
      const updated = await collection.updateOne(
        { _id: ids[index] },
        { $set: { completed: true, revision: 2 } },
      );
      if (updated.matchedCount !== 1)
        throw new Error("updateOne missed a seeded document");
    }
    const updateMs = elapsed(startedAt);

    startedAt = Date.now();
    for (let index = 0; index < iterations; index += 1) {
      const deleted = await collection.deleteOne({ _id: ids[index] });
      if (deleted.deletedCount !== 1)
        throw new Error("deleteOne missed a seeded document");
    }
    const deleteMs = elapsed(startedAt);

    console.log(
      `BENCH_RESULT:${JSON.stringify({
        driver: "gea-native",
        iterations,
        transport: "one warmed pooled connection",
        milliseconds: {
          insertOne: insertMs,
          findOne: findMs,
          updateOne: updateMs,
          deleteOne: deleteMs,
        },
      })}`,
    );
  } finally {
    await client.close();
  }
}

await run();
