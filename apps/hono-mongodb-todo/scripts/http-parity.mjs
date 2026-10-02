// HTTP parity: runs the todo server under Node and as the native binary, one
// after the other on different ports against the same MongoDB, drives the
// SAME scripted conversation through every route (including 404s and bad
// input), and diffs status, content-type and body step by step.
//
// Ids and timestamps are minted per run, so each ObjectId is replaced by the
// order it was first seen in (`<id#1>`) and each ISO timestamp by `<ts>` --
// after checking both are well formed. Everything else must be identical.
//
// Usage:
//   node scripts/http-parity.mjs --native dist/server/hono-mongodb [--node dist-node/server.js]
//                                [--node-port 3311] [--native-port 3312]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MongoClient } from "mongodb";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
};
const nativeBinary = argument("--native", null);
const nodeEntry = path.resolve(
  appRoot,
  argument("--node", "dist-node/server.js"),
);
const nodePort = Number(argument("--node-port", "3311"));
const nativePort = Number(argument("--native-port", "3312"));
const mongoUrl = process.env.MONGODB_URL ?? "mongodb://127.0.0.1:27017";
if (nativeBinary === null) {
  console.error(
    "usage: node scripts/http-parity.mjs --native <binary> [--node <entry>]",
  );
  process.exit(2);
}

const resetCollection = async () => {
  const client = new MongoClient(mongoUrl);
  try {
    await client.connect();
    await client.db("gea_hono_todo").collection("todos").deleteMany({});
  } finally {
    await client.close();
  }
};

const startServer = async (label, command, args, port) => {
  const child = spawn(command, args, {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `${label} exited with ${child.exitCode} before listening:\n${output}`,
      );
    try {
      await fetch(`http://127.0.0.1:${port}/api/todos`, {
        signal: AbortSignal.timeout(1000),
      });
      return { child, output: () => output };
    } catch {
      await sleep(100);
    }
  }
  child.kill("SIGKILL");
  throw new Error(`${label} did not answer on port ${port}:\n${output}`);
};

const objectIdPattern = /\b[0-9a-f]{24}\b/g;
const isoPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;

// The conversation. Steps may read ids an earlier step created.
const conversation = (html) => {
  const script =
    html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/i)?.[1] ??
    html.match(/src="([^"]+\.js)"/i)?.[1];
  const style =
    html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/i)?.[1] ??
    html.match(/href="([^"]+\.css)"/i)?.[1];
  const json = (value) => ({
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  });
  return [
    { name: "frontend-script", method: "GET", path: () => script },
    { name: "frontend-style", method: "GET", path: () => style },
    { name: "list-empty", method: "GET", path: () => "/api/todos" },
    {
      name: "create-first",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: "  first todo  " }),
      keep: "first",
    },
    {
      name: "create-second",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: "second todo" }),
      keep: "second",
    },
    {
      name: "create-unicode",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: "üñíçødé ✓ todo" }),
      keep: "third",
    },
    {
      name: "create-empty-title",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: "   " }),
    },
    {
      name: "create-missing-title",
      method: "POST",
      path: () => "/api/todos",
      ...json({ done: true }),
    },
    {
      name: "create-title-not-string",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: 42 }),
    },
    {
      name: "create-title-too-long",
      method: "POST",
      path: () => "/api/todos",
      ...json({ title: "x".repeat(241) }),
    },
    {
      name: "create-json-array",
      method: "POST",
      path: () => "/api/todos",
      ...json(["title"]),
    },
    {
      name: "create-json-null",
      method: "POST",
      path: () => "/api/todos",
      ...json(null),
    },
    {
      name: "create-invalid-json",
      method: "POST",
      path: () => "/api/todos",
      body: "not json",
      headers: { "content-type": "application/json" },
    },
    { name: "list-three", method: "GET", path: () => "/api/todos" },
    {
      name: "get-one-no-route",
      method: "GET",
      path: (ids) => `/api/todos/${ids.first}`,
    },
    {
      name: "update-completed",
      method: "PATCH",
      path: (ids) => `/api/todos/${ids.first}`,
      ...json({ completed: true }),
    },
    {
      name: "update-title",
      method: "PATCH",
      path: (ids) => `/api/todos/${ids.second}`,
      ...json({ title: " renamed " }),
    },
    {
      name: "update-both",
      method: "PATCH",
      path: (ids) => `/api/todos/${ids.third}`,
      ...json({ title: "both", completed: true }),
    },
    {
      name: "update-no-fields",
      method: "PATCH",
      path: (ids) => `/api/todos/${ids.first}`,
      ...json({}),
    },
    {
      name: "update-completed-not-boolean",
      method: "PATCH",
      path: (ids) => `/api/todos/${ids.first}`,
      ...json({ completed: "yes" }),
    },
    {
      name: "update-invalid-id",
      method: "PATCH",
      path: () => "/api/todos/not-an-id",
      ...json({ completed: true }),
    },
    {
      name: "update-unknown-id",
      method: "PATCH",
      path: () => "/api/todos/0123456789abcdef01234567",
      ...json({ completed: true }),
    },
    { name: "list-after-updates", method: "GET", path: () => "/api/todos" },
    {
      name: "delete-second",
      method: "DELETE",
      path: (ids) => `/api/todos/${ids.second}`,
    },
    {
      name: "delete-second-again",
      method: "DELETE",
      path: (ids) => `/api/todos/${ids.second}`,
    },
    {
      name: "delete-invalid-id",
      method: "DELETE",
      path: () => "/api/todos/xyz",
    },
    { name: "list-after-delete", method: "GET", path: () => "/api/todos" },
    { name: "unknown-path", method: "GET", path: () => "/nope" },
    {
      name: "unknown-method",
      method: "PUT",
      path: () => "/api/todos",
      ...json({ title: "put" }),
    },
    {
      name: "delete-first",
      method: "DELETE",
      path: (ids) => `/api/todos/${ids.first}`,
    },
    {
      name: "delete-third",
      method: "DELETE",
      path: (ids) => `/api/todos/${ids.third}`,
    },
    { name: "list-final", method: "GET", path: () => "/api/todos" },
  ];
};

const runConversation = async (label, port) => {
  const base = `http://127.0.0.1:${port}`;
  const seen = new Map();
  const problems = [];
  const normalize = (text) =>
    text
      .replace(objectIdPattern, (id) => {
        if (!seen.has(id)) seen.set(id, `<id#${seen.size + 1}>`);
        return seen.get(id);
      })
      .replace(isoPattern, (stamp) => {
        if (Number.isNaN(Date.parse(stamp)))
          problems.push(`${label}: malformed timestamp ${stamp}`);
        return "<ts>";
      });
  const exchange = async (method, target, init = {}) => {
    const response = await fetch(new URL(target, base), {
      method,
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    };
  };
  const results = [];
  const root = await exchange("GET", "/");
  results.push({ name: "frontend-html", ...root, body: normalize(root.body) });
  const ids = {};
  for (const step of conversation(root.body)) {
    const target = step.path(ids);
    const answer = await exchange(
      step.method,
      target,
      step.body === undefined ? {} : { body: step.body, headers: step.headers },
    );
    if (step.keep !== undefined && answer.status === 201)
      ids[step.keep] = JSON.parse(answer.body).id;
    results.push({ name: step.name, ...answer, body: normalize(answer.body) });
  }
  return { results, problems };
};

const runOne = async (label, command, args, port) => {
  await resetCollection();
  const server = await startServer(label, command, args, port);
  try {
    return await runConversation(label, port);
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
  }
};

const node = await runOne("node", process.execPath, [nodeEntry], nodePort);
const native = await runOne(
  "native",
  path.resolve(appRoot, nativeBinary),
  [],
  nativePort,
);
await resetCollection();

let failed = 0;
for (const [index, expected] of node.results.entries()) {
  const actual = native.results[index];
  const same =
    actual !== undefined &&
    actual.status === expected.status &&
    actual.contentType === expected.contentType &&
    actual.body === expected.body;
  if (same) {
    console.log(
      `PASS ${expected.name.padEnd(30)} ${expected.status} ${expected.contentType ?? "-"}`,
    );
    continue;
  }
  failed++;
  console.log(`FAIL ${expected.name}`);
  console.log(
    `  node:   ${expected.status} ${expected.contentType} ${JSON.stringify(expected.body).slice(0, 400)}`,
  );
  console.log(
    `  native: ${actual?.status} ${actual?.contentType} ${JSON.stringify(actual?.body ?? "").slice(0, 400)}`,
  );
}
for (const problem of [...node.problems, ...native.problems]) {
  failed++;
  console.log(`FAIL ${problem}`);
}
console.log(
  `\n${node.results.length - failed}/${node.results.length} steps identical`,
);
process.exit(failed === 0 ? 0 : 1);
