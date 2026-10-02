import { Binary, BSON, deserialize, ObjectId, serialize, type Document } from "bson";

// The serializer's per-value cost with no database, in the shapes the driver
// hands it: an open `Document`, a typed record (what every command and user
// document the driver builds is), and a nested command around it, with the
// driver's own options. Constants
// rather than environment reads for the reason `native-driver.ts` gives. Node counterpart: `bson-serialize.mjs`.
const iterations = 200000;
const payload = "0123456789abcdef".repeat(16);
const options = { checkKeys: false, serializeFunctions: false, ignoreUndefined: false };

type Todo = { _id: ObjectId; title: string; completed: boolean; revision: number; payload: string };
type Command = { insert: string; documents: Todo[]; ordered: boolean; lsid: { id: Binary }; $db: string };

function time(label: string, document: Document): number {
  let checksum = 0;
  const startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) checksum += serialize(document, options).length;
  console.log(`BSON_RESULT:${label},${Date.now() - startedAt},${checksum}`);
  return checksum;
}

function run(): void {
  const id = new ObjectId("0123456789abcdef01234567");
  const open: Document = { _id: id, title: "todo-1", completed: false, revision: 1, payload };
  const todo: Todo = { _id: id, title: "todo-1", completed: false, revision: 1, payload };
  const command: Command = {
    insert: "todos",
    documents: [todo],
    ordered: true,
    lsid: { id: new Binary(new Uint8Array(16), 4) },
    $db: "gea_driver_benchmark"
  };
  // Long constructed through the namespace exactly as the driver does
  // (`cmap/commands.ts`): the constructor value `export { BSON }` materializes
  // has no call to type its dispatch from otherwise.
  if (new BSON.Long(1, 0).toNumber() !== 1) throw new Error("Long");
  time("open", open);
  time("record", todo);
  time("command", command);
  const bytes = serialize(open, options);
  let checksum = 0;
  const startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const revision: unknown = deserialize(bytes).revision;
    if (typeof revision !== "number") throw new Error("missing revision");
    checksum += revision;
  }
  console.log(`BSON_RESULT:deserialize,${Date.now() - startedAt},${checksum}`);
}

run();
