import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfacePath = path.resolve(
  here,
  "..",
  "..",
  "runtime",
  "node",
  "generated",
  "node24-surface.json",
);
const ledgerPath = path.resolve(
  here,
  "..",
  "..",
  "runtime",
  "node",
  "generated",
  "node24-compatibility.json",
);
const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));

assert.equal(surface.formatVersion, 1);
assert.equal(surface.target.nodeMajor, 24);
assert.match(surface.target.typesVersion, /^24\./);
assert.equal(Object.keys(surface.modules).length, 57);
assert.equal(surface.globals.length, 119);
assert.ok(
  surface.globals.every((entry) => /^[$A-Z_a-z][$\w]*$/.test(entry.name)),
);
assert.equal(
  new Set(surface.globals.map((entry) => entry.name)).size,
  surface.globals.length,
);

for (const [moduleName, module] of Object.entries(surface.modules)) {
  assert.match(moduleName, /^node:/);
  assert.deepEqual(
    module.exports,
    [...module.exports].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  );
  assert.equal(
    new Set(module.exports.map((entry) => entry.name)).size,
    module.exports.length,
  );
}

assert.equal(ledger.formatVersion, 1);
assert.deepEqual(ledger.statusVocabulary, [
  "conformant",
  "partial",
  "stubbed",
  "plugin",
]);
assert.deepEqual(Object.keys(ledger.modules), Object.keys(surface.modules));
for (const [moduleName, module] of Object.entries(surface.modules)) {
  const runtime = ledger.modules[moduleName];
  assert.ok(runtime, `missing compatibility ledger module ${moduleName}`);
  assert.deepEqual(runtime.aliases, module.aliases);
  assert.deepEqual(
    runtime.declarationExports,
    module.exports.map((entry) => entry.name),
  );
  assert.deepEqual(
    runtime.runtimeExports.map((entry) => entry.name),
    module.exports.filter((entry) => entry.runtime).map((entry) => entry.name),
  );
  for (const entry of runtime.runtimeExports) {
    assert.ok(ledger.statusVocabulary.includes(entry.status));
    if (entry.status === "conformant") {
      assert.ok(
        entry.behavioralTests?.length,
        `${moduleName}.${entry.name} lacks behavioral tests`,
      );
    }
  }
}

const net = surface.modules["node:net"];
assert.ok(net, "node:net must be inventoried");
assert.deepEqual(net.aliases, ["net"]);

const netExports = new Map(net.exports.map((entry) => [entry.name, entry]));
for (const name of [
  "BlockList",
  "Server",
  "Socket",
  "SocketAddress",
  "connect",
  "createConnection",
  "createServer",
  "getDefaultAutoSelectFamily",
  "isIP",
  "isIPv4",
  "isIPv6",
  "setDefaultAutoSelectFamily",
]) {
  assert.ok(netExports.has(name), `node:net.${name} must be inventoried`);
}
assert.equal(netExports.get("createServer").runtime, true);
assert.ok(netExports.get("createServer").callSignatures.length >= 2);
assert.ok(
  netExports.get("Server").members.some((member) => member.name === "listen"),
);
assert.ok(
  netExports.get("Socket").members.some((member) => member.name === "connect"),
);
assert.ok(
  netExports
    .get("BlockList")
    .members.some((member) => member.name === "addAddress"),
);

for (const moduleName of ["node:constants", "node:process"]) {
  const exportEquals = surface.modules[moduleName].exports.find(
    (entry) => entry.exportEquals,
  );
  assert.ok(exportEquals, `${moduleName} export= object must be inventoried`);
  assert.equal(exportEquals.name, "default");
  assert.ok(exportEquals.members.length > 50);
}

const globals = new Map(surface.globals.map((entry) => [entry.name, entry]));
for (const name of [
  "Buffer",
  "NodeJS",
  "process",
  "setImmediate",
  "setTimeout",
]) {
  assert.ok(globals.has(name), `Node 24 global ${name} must be inventoried`);
}

process.stdout.write(
  `Verified Node ${surface.target.nodeMajor} surface from @types/node ${surface.target.typesVersion}: ` +
    `${Object.keys(surface.modules).length} modules, ${surface.globals.length} globals\n`,
);
