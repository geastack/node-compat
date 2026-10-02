import { Binary, deserialize, ObjectId, serialize } from "bson";

// Node counterpart of `bson-serialize.ts`; keep the two in lockstep.
const iterations = 200000;
const payload = "0123456789abcdef".repeat(16);
const options = { checkKeys: false, serializeFunctions: false, ignoreUndefined: false };

function time(label, document) {
  let checksum = 0;
  const startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) checksum += serialize(document, options).length;
  console.log(`BSON_RESULT:${label},${Date.now() - startedAt},${checksum}`);
  return checksum;
}

const id = new ObjectId("0123456789abcdef01234567");
const open = { _id: id, title: "todo-1", completed: false, revision: 1, payload };
const todo = { _id: id, title: "todo-1", completed: false, revision: 1, payload };
const command = {
  insert: "todos",
  documents: [todo],
  ordered: true,
  lsid: { id: new Binary(new Uint8Array(16), 4) },
  $db: "gea_driver_benchmark"
};
time("open", open);
time("record", todo);
time("command", command);
const bytes = serialize(open, options);
let checksum = 0;
const startedAt = Date.now();
for (let index = 0; index < iterations; index += 1) {
  const revision = deserialize(bytes).revision;
  if (typeof revision !== "number") throw new Error("missing revision");
  checksum += revision;
}
console.log(`BSON_RESULT:deserialize,${Date.now() - startedAt},${checksum}`);
