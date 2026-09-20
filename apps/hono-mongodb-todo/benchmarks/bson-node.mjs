import { deserialize, ObjectId, serialize } from "bson";

const mode = process.env.BENCH_MODE ?? "small";
const iterations = Number(process.env.BENCH_ITERATIONS ?? "1000");

function report(modeName, encodeMilliseconds, decodeMilliseconds, bytes, checksum) {
  console.log(
    `BSON_RESULT:${modeName},${encodeMilliseconds},${decodeMilliseconds},${bytes},${checksum}`,
  );
}

function run(document, validate) {
  const bytes = serialize(document);
  let checksum = 0;

  let startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum += serialize(document).length;
  }
  const encodeMilliseconds = performance.now() - startedAt;

  startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum += validate(deserialize(bytes));
  }
  report(
    mode,
    encodeMilliseconds,
    performance.now() - startedAt,
    bytes.length,
    checksum,
  );
}

if (mode === "small") {
  run(
    {
      _id: new ObjectId("0123456789abcdef01234567"),
      title: "todo",
      completed: false,
      revision: 1,
      payload: "0123456789abcdef".repeat(16),
    },
    (document) => document.revision,
  );
} else if (mode === "string-256k") {
  run(
    { payload: "x".repeat(256 * 1024) },
    (document) => document.payload.length,
  );
} else if (mode === "array-4096") {
  const values = [];
  for (let index = 0; index < 4096; index += 1) values.push(index);
  run({ values }, (document) => document.values.length);
} else {
  throw new Error(`unknown BSON benchmark mode: ${mode}`);
}
