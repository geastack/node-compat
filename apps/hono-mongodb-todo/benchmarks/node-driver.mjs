import { MongoClient, ObjectId } from "mongodb";

// Kept in lockstep with `native-driver.ts`: same operations, same documents,
// same connection, same phase markers.
const iterations = 20000;
const warmup = 2000;
const payload = "0123456789abcdef".repeat(16);

const seededId = (index) =>
  new ObjectId(`00000000000000000${String(index).padStart(7, "0")}`);

// `driver-cpu.mjs` samples this process's CPU while it idles after each
// marker, so the difference between two samples is the client CPU of exactly
// one phase; the wait on mongod burns none of it.
async function phase(name) {
  console.log(`BENCH_PHASE:${name}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const client = new MongoClient(
  "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false",
  { maxPoolSize: 1, minPoolSize: 1 },
);
const collection = client.db("gea_driver_benchmark").collection("driver_node");
await client.connect();
try {
  for (let index = 0; index < warmup; index += 1) {
    const id = seededId(iterations + index);
    await collection.insertOne({ _id: id, title: "warmup", completed: false, revision: 1, payload });
    await collection.findOne({ _id: id });
    await collection.updateOne({ _id: id }, { $set: { completed: true, revision: 2 } });
    await collection.deleteOne({ _id: id });
  }
  await phase("ready");

  let startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await collection.insertOne({ _id: seededId(index), title: `todo-${index}`, completed: false, revision: 1, payload });
  }
  const insertMs = performance.now() - startedAt;
  await phase("insertOne");

  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const found = await collection.findOne({ _id: seededId(index) });
    if (found === null) throw new Error("findOne missed a seeded document");
  }
  const findMs = performance.now() - startedAt;
  await phase("findOne");

  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const updated = await collection.updateOne({ _id: seededId(index) }, { $set: { completed: true, revision: 2 } });
    if (updated.matchedCount !== 1) throw new Error("updateOne missed a seeded document");
  }
  const updateMs = performance.now() - startedAt;
  await phase("updateOne");

  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const deleted = await collection.deleteOne({ _id: seededId(index) });
    if (deleted.deletedCount !== 1) throw new Error("deleteOne missed a seeded document");
  }
  const deleteMs = performance.now() - startedAt;
  await phase("deleteOne");

  console.log(
    `BENCH_RESULT:${JSON.stringify({
      driver: "nodejs-official",
      iterations,
      milliseconds: { insertOne: insertMs, findOne: findMs, updateOne: updateMs, deleteOne: deleteMs },
    })}`,
  );
} finally {
  await client.close();
}
