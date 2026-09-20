import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const snapshotPath = path.join(
  repo,
  "runtime",
  "node",
  "generated",
  "node24-docs.json",
);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

assert.equal(snapshot.formatVersion, 1);
assert.equal(snapshot.target.nodeVersion, "24.13.0");
assert.equal(snapshot.target.declarationPackage, "@types/node");
assert.equal(snapshot.target.declarationVersion, "24.13.3");
assert.equal(
  snapshot.source.url,
  "https://nodejs.org/download/release/v24.13.0/docs/api/all.json",
);
assert.equal(
  snapshot.source.sha256,
  "674f4add970df2c97393adc2981305f94879856a3aa6c1538f2594534b583d1a",
);
assert.equal(snapshot.source.bytes, 7818882);
assert.ok(snapshot.records.length >= 4000);
assert.ok(snapshot.metadata.stabilityRecords >= 250);
assert.ok(snapshot.metadata.platformMentionRecords > 0);
assert.equal(snapshot.declarationModules.length, 57);
assert.deepEqual(
  snapshot.declarationModules.filter((entry) => !entry.documented),
  [],
  "every declared Node 24 builtin must map to its official documentation source",
);

process.stdout.write(
  `Verified official Node ${snapshot.target.nodeVersion} documentation snapshot: ` +
    `${snapshot.records.length} records, ${snapshot.source.sha256}\n`,
);
