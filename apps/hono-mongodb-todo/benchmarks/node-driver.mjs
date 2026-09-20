import { MongoClient, ObjectId } from "mongodb";

const iterations = Number(process.env.BENCH_ITERATIONS ?? "1000");
const warmup = Number(process.env.BENCH_WARMUP ?? "50");
const collectionName = process.env.BENCH_COLLECTION ?? "driver_node";
const payload = "0123456789abcdef".repeat(16);
const client = new MongoClient(
  "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false",
  { maxPoolSize: 1, minPoolSize: 1 },
);
const collection = client.db("gea_driver_benchmark").collection(collectionName);
const ids = Array.from(
  { length: iterations },
  (_, index) =>
    new ObjectId(`000000000000000000${String(index + 1000).padStart(6, "0")}`),
);
const documents = ids.map((id, index) => ({
  _id: id,
  title: `todo-${index}`,
  completed: false,
  revision: 1,
  payload,
}));

await client.connect();
try {
  for (let index = 0; index < warmup; index += 1) {
    const id = new ObjectId(
      `000000000000000000${String(index).padStart(6, "0")}`,
    );
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
  let startedAt = performance.now();
  for (const document of documents) await collection.insertOne(document);
  const insertMs = performance.now() - startedAt;

  startedAt = performance.now();
  for (const id of ids) {
    if ((await collection.findOne({ _id: id })) === null)
      throw new Error("findOne missed a seeded document");
  }
  const findMs = performance.now() - startedAt;

  startedAt = performance.now();
  for (const id of ids) {
    const result = await collection.updateOne(
      { _id: id },
      { $set: { completed: true, revision: 2 } },
    );
    if (result.matchedCount !== 1)
      throw new Error("updateOne missed a seeded document");
  }
  const updateMs = performance.now() - startedAt;

  startedAt = performance.now();
  for (const id of ids) {
    const result = await collection.deleteOne({ _id: id });
    if (result.deletedCount !== 1)
      throw new Error("deleteOne missed a seeded document");
  }
  const deleteMs = performance.now() - startedAt;

  console.log(
    `BENCH_RESULT:${JSON.stringify({
      driver: "nodejs-official",
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
