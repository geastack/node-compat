import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const entry = path.join(
  repo,
  "apps",
  "hono-mongodb-todo",
  "tests",
  "net-runtime-probe.ts",
);
const rootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gea-node24-net-regression-"),
);
const outDir = path.join(rootDir, "dist");
const executable = path.join(outDir, "net-runtime-probe");

const server = net.createServer((socket) => socket.pipe(socket));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(37123, "127.0.0.1", resolve);
});

try {
  const build = spawnSync(
    process.execPath,
    [
      path.join(repo, "scripts", "build.mjs"),
      entry,
      "--out",
      outDir,
      "--exe",
      executable,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: repo });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Node TCP regression probe timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`);
  assert.match(output.stdout, /node-net-runtime-ok/);
  assert.doesNotMatch(
    `${output.stdout}\n${output.stderr}`,
    /ERR_GEA_NODE_NOT_IMPLEMENTED/,
    "the existing MongoDB-oriented TCP client subset must remain implemented",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(rootDir, { recursive: true, force: true });
}

process.stdout.write(
  "Verified bare-net TCP connect, write, read, and close regression\n",
);
