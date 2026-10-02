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

// Stubbed constant values (`node:constants.EACCES`) are inert `undefined` placeholders: an ES module export cannot
// throw on read, so reading one neither throws nor prints. Stubbed functions and classes still throw on use.
for (const scenario of ["named-value", "default-value"]) {
  const run = spawnSync(executable, [scenario], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: "1" },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stdout.trim(), "", `unexpected output for ${scenario}`);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /unreachable connection listener/);
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

process.stdout.write(
  "Verified import-safe Node stubs alongside implemented namespace, class, method, and property access\n",
);
