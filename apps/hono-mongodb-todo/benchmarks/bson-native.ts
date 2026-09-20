import { deserialize, ObjectId, serialize, type Document } from "bson";

declare function __gea_node_process_env(): {
  [key: string]: string | undefined;
};

// Golden FNV-1a hashes from official Node BSON 7.3.1, checked outside timing.
// Byte counts alone would miss corrupted payloads after an optimization.
function validateBytes(bytes: Uint8Array, expected: number): void {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = Math.imul(hash ^ bytes[index]!, 16777619) >>> 0;
  }
  if (hash !== expected) throw new Error("BSON wire bytes differ from Node");
}

function report(
  mode: string,
  encodeMilliseconds: number,
  decodeMilliseconds: number,
  bytes: number,
  checksum: number,
): void {
  console.log(
    `BSON_RESULT:${mode},${encodeMilliseconds},${decodeMilliseconds},${bytes},${checksum}`,
  );
}

function small(iterations: number): void {
  const document: Document = {
    _id: new ObjectId("0123456789abcdef01234567"),
    title: "todo",
    completed: false,
    revision: 1,
    payload: "0123456789abcdef".repeat(16),
  };
  const bytes = serialize(document);
  validateBytes(bytes, 2382079293);
  validateBytes(serialize(deserialize(bytes)), 2382079293);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum += serialize(document).length;
  }
  const encodeMilliseconds = Date.now() - startedAt;

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(bytes);
    const revision: unknown = decoded.revision;
    if (typeof revision !== "number") throw new Error("missing revision");
    checksum += revision;
  }
  report(
    "small",
    encodeMilliseconds,
    Date.now() - startedAt,
    bytes.length,
    checksum,
  );
}

function largeString(iterations: number): void {
  const document: Document = { payload: "x".repeat(256 * 1024) };
  const bytes = serialize(document);
  validateBytes(bytes, 2121388551);
  validateBytes(serialize(deserialize(bytes)), 2121388551);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum += serialize(document).length;
  }
  const encodeMilliseconds = Date.now() - startedAt;

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(bytes);
    const payload: unknown = decoded.payload;
    if (typeof payload !== "string") throw new Error("missing payload");
    checksum += payload.length;
  }
  report(
    "string-256k",
    encodeMilliseconds,
    Date.now() - startedAt,
    bytes.length,
    checksum,
  );
}

function integerArray(iterations: number): void {
  const values: number[] = [];
  for (let index = 0; index < 4096; index += 1) values.push(index);
  const document: Document = { values };
  const bytes = serialize(document);
  validateBytes(bytes, 1872448930);
  validateBytes(serialize(deserialize(bytes)), 1872448930);
  let checksum = 0;

  let startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum += serialize(document).length;
  }
  const encodeMilliseconds = Date.now() - startedAt;

  startedAt = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const decoded = deserialize(bytes);
    const decodedValues: unknown = decoded.values;
    if (!Array.isArray(decodedValues)) throw new Error("missing values");
    checksum += decodedValues.length;
  }
  report(
    "array-4096",
    encodeMilliseconds,
    Date.now() - startedAt,
    bytes.length,
    checksum,
  );
}

const env = __gea_node_process_env();
const mode = env.BENCH_MODE ?? "small";
const iterations = Number(env.BENCH_ITERATIONS ?? "1000");

if (mode === "small") small(iterations);
else if (mode === "string-256k") largeString(iterations);
else if (mode === "array-4096") integerArray(iterations);
else throw new Error(`unknown BSON benchmark mode: ${mode}`);
