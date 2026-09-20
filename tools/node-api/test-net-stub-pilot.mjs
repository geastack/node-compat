import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const appDir = path.join(repo, "apps", "net-stub-pilot");
const outDir = path.join(appDir, "dist");
const executable = path.join(outDir, "server");
fs.rmSync(outDir, { recursive: true, force: true });

const build = spawnSync(
  process.execPath,
  [
    path.join(repo, "scripts", "build.mjs"),
    path.join(appDir, "server.ts"),
    "--out",
    outDir,
    "--exe",
    executable,
    "--debug",
  ],
  { cwd: repo, encoding: "utf8" },
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const runtimeScenarios = new Map([
  ["named-value", "node:constants.EACCES"],
  ["default-value", "node:constants.EACCES"],
]);
for (const [scenario, operation] of runtimeScenarios) {
  const run = spawnSync(executable, [scenario], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: "1" },
  });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(
    output,
    new RegExp(
      `ERR_GEA_NODE_NOT_IMPLEMENTED: ${operation.replaceAll(".", "\\.")} is not implemented for geastack target node@24`,
    ),
    `missing stable stub error for ${scenario}`,
  );
  assert.doesNotMatch(output, /unreachable connection listener/);
}

const implementedScenarios = new Map([
  ["direct-call", "false"],
  ["constructor", "false"],
  ["namespace-call", "true"],
  ["bare-namespace-call", "true"],
  ["static-method", "0"],
  ["instance-method", "{}"],
  ["instance-property", "0"],
]);
for (const [scenario, expected] of implementedScenarios) {
  const run = spawnSync(executable, [scenario], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: "1" },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stdout.trim(), expected, `unexpected output for ${scenario}`);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/);
}

const moduleDir = path.join(outDir, "modules");
const netHeaderName = fs
  .readdirSync(moduleDir)
  .find(
    (name) =>
      name.endsWith(".hpp") &&
      !name.endsWith(".types.hpp") &&
      fs
        .readFileSync(path.join(moduleDir, name), "utf8")
        .includes("fn_createServer"),
  );
assert.ok(netHeaderName, "generated node:net header was not found");
const netHeader = fs.readFileSync(path.join(moduleDir, netHeaderName), "utf8");
assert.match(netHeader, /fn_createServer\(/);

const entrySource = fs
  .readdirSync(moduleDir)
  .filter((name) => name.endsWith(".cpp"))
  .map((name) => fs.readFileSync(path.join(moduleDir, name), "utf8"))
  .find((source) => source.includes("fn_compileOfficialOverloads"));
assert.ok(entrySource, "generated pilot entry implementation was not found");
assert.doesNotMatch(entrySource, /fn_createServer\(gea_cpp_key/);
assert.doesNotMatch(entrySource, /__gea_node_not_implemented\("node:net", "createServer"\)/);
assert.match(entrySource, /fn_compileOfficialConstructors/);
assert.doesNotMatch(entrySource, /__gea_node_not_implemented\("node:net", "Server"\)/);
assert.match(entrySource, /fn_compileQualifiedStubs/);
for (const member of [
  "isIPv4",
  "isIPv6",
  "SocketAddress.parse",
  "Socket.address",
  "Socket.bytesRead",
]) {
  assert.doesNotMatch(
    entrySource,
    new RegExp(
      `__gea_node_not_implemented\\(\"node:net\", \"${member.replace(".", "\\.")}\"\\)`,
    ),
  );
}
assert.match(
  entrySource,
  /__gea_node_not_implemented\("node:constants", "EACCES"\)/,
);
assert.doesNotMatch(
  entrySource,
  /__gea_node_not_implemented\([^;\n]*gea_cpp_key/,
);

process.stdout.write(
  "Verified import-safe Node stubs alongside implemented namespace, class, method, and property access\n",
);
