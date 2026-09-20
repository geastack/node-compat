import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(benchmarkRoot, "..");
const resultRoot = path.join(benchmarkRoot, "results");
const nativeExecutable = path.join(appRoot, "dist/hono-mongodb");
const nodeEntry = path.join(appRoot, "dist-node/server.js");

const numberFlag = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument === undefined
    ? fallback
    : Number(argument.slice(prefix.length));
};
const durationSeconds = numberFlag("duration", 5);
const rounds = numberFlag("rounds", 3);
if (
  !Number.isInteger(durationSeconds) ||
  durationSeconds < 1 ||
  !Number.isInteger(rounds) ||
  rounds < 1
) {
  throw new Error("duration and rounds must be positive integers");
}
for (const file of [nativeExecutable, nodeEntry]) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `missing ${file}; build both native and Node servers first`,
    );
  }
}
execFileSync("which", ["wrk"], { stdio: "ignore" });

const mongoUrl =
  "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&maxPoolSize=4&minPoolSize=1";
const runtimes = [
  {
    name: "gea-native",
    command: nativeExecutable,
    args: [],
    port: 3011,
  },
  {
    name: "nodejs-official",
    command: process.execPath,
    args: [nodeEntry],
    port: 3012,
  },
];
const profiles = [
  { name: "static-c1", path: "/", threads: 1, connections: 1 },
  { name: "static-c64", path: "/", threads: 4, connections: 64 },
  { name: "mongodb-c1", path: "/api/todos", threads: 1, connections: 1 },
  { name: "mongodb-c16", path: "/api/todos", threads: 4, connections: 16 },
  { name: "mongodb-c64", path: "/api/todos", threads: 4, connections: 64 },
];

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const rssBytes = (pid) => {
  try {
    const kib = Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
};

const liveHeap = (pid) => {
  const output = execFileSync("leaks", [String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const match = output.match(/Process \d+: (\d+) nodes malloced for (\d+) KB/);
  if (match === null)
    throw new Error(`could not parse leaks output for PID ${pid}`);
  return {
    liveAllocationCount: Number(match[1]),
    liveAllocationBytes: Number(match[2]) * 1024,
  };
};

async function waitForServer(runtime, child, logs) {
  const url = `http://127.0.0.1:${runtime.port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `${runtime.name} exited during startup (${child.exitCode}):\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(100);
  }
  throw new Error(`${runtime.name} did not listen within 30 seconds`);
}

async function startServer(runtime) {
  const logs = [];
  const child = spawn(runtime.command, runtime.args, {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(runtime.port),
      MONGODB_URL: mongoUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  await waitForServer(runtime, child, logs);
  return { child, logs, idleRssBytes: rssBytes(child.pid) };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  await Promise.race([exited, delay(2_000)]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

const parseWrk = (stdout) => {
  const requestsPerSecond = Number(
    stdout.match(/^Requests\/sec:\s+([\d.]+)$/m)?.[1],
  );
  const requestLine = stdout.match(/^\s*(\d+) requests in ([^,]+),/m);
  const latencyAverage = stdout.match(/^\s*Latency\s+(\S+)/m)?.[1];
  const latencyP50 = stdout.match(/^\s*50%\s+(\S+)/m)?.[1];
  const latencyP99 = stdout.match(/^\s*99%\s+(\S+)/m)?.[1];
  const socketErrors = stdout.match(
    /^\s*Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)$/m,
  );
  const non2xx = Number(
    stdout.match(/^Non-2xx or 3xx responses: (\d+)$/m)?.[1] ?? 0,
  );
  if (!Number.isFinite(requestsPerSecond) || requestLine === null) {
    throw new Error(`could not parse wrk output:\n${stdout}`);
  }
  return {
    requestsPerSecond,
    completedRequests: Number(requestLine[1]),
    observedDuration: requestLine[2],
    latencyAverage,
    latencyP50,
    latencyP99,
    socketErrors: socketErrors
      ? {
          connect: Number(socketErrors[1]),
          read: Number(socketErrors[2]),
          write: Number(socketErrors[3]),
          timeout: Number(socketErrors[4]),
        }
      : { connect: 0, read: 0, write: 0, timeout: 0 },
    non2xx,
  };
};

async function runWrk(runtime, server, profile, duration) {
  const args = [
    "--latency",
    `-t${profile.threads}`,
    `-c${profile.connections}`,
    `-d${duration}s`,
    `http://127.0.0.1:${runtime.port}${profile.path}`,
  ];
  const child = spawn("wrk", args, {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const memory = [server.idleRssBytes, rssBytes(server.child.pid)];
  const sampler = setInterval(() => {
    memory.push(rssBytes(server.child.pid));
  }, 250);
  const result = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  clearInterval(sampler);
  memory.push(rssBytes(server.child.pid));
  if (result.code !== 0) {
    throw new Error(
      `wrk failed for ${runtime.name}/${profile.name} (${result.code ?? result.signal}): ${stderr}`,
    );
  }
  const parsed = parseWrk(stdout);
  const errorCount =
    Object.values(parsed.socketErrors).reduce(
      (total, value) => total + value,
      0,
    ) + parsed.non2xx;
  if (errorCount !== 0) {
    throw new Error(
      `${runtime.name}/${profile.name} completed with ${errorCount} HTTP/socket errors`,
    );
  }
  return {
    runtime: runtime.name,
    profile: profile.name,
    path: profile.path,
    threads: profile.threads,
    connections: profile.connections,
    durationSeconds: duration,
    ...parsed,
    peakServerRssBytes: Math.max(...memory),
  };
}

const servers = new Map();
try {
  for (const runtime of runtimes) {
    const server = await startServer(runtime);
    servers.set(runtime.name, server);
    console.log(
      `${runtime.name} ready: ${(server.idleRssBytes / 1024 / 1024).toFixed(1)} MiB idle RSS`,
    );
  }

  console.log("warming static and MongoDB-backed routes");
  for (const runtime of runtimes) {
    const server = servers.get(runtime.name);
    await runWrk(
      runtime,
      server,
      { name: "warm-static", path: "/", threads: 2, connections: 16 },
      2,
    );
    await runWrk(
      runtime,
      server,
      {
        name: "warm-mongodb",
        path: "/api/todos",
        threads: 2,
        connections: 16,
      },
      2,
    );
  }

  const samples = [];
  const correctness = {};
  const heapSnapshots = {};
  for (let round = 0; round < rounds; round += 1) {
    for (
      let profileIndex = 0;
      profileIndex < profiles.length;
      profileIndex += 1
    ) {
      const profile = profiles[profileIndex];
      const offset = (round + profileIndex) % runtimes.length;
      const ordered = [...runtimes.slice(offset), ...runtimes.slice(0, offset)];
      for (const runtime of ordered) {
        console.log(
          `http ${round + 1}/${rounds}: ${runtime.name} ${profile.name}`,
        );
        const sample = await runWrk(
          runtime,
          servers.get(runtime.name),
          profile,
          durationSeconds,
        );
        samples.push({ round: round + 1, ...sample });
        console.log(
          `  ${Math.round(sample.requestsPerSecond).toLocaleString("en-US")} req/s, p99 ${sample.latencyP99}, ${(sample.peakServerRssBytes / 1024 / 1024).toFixed(1)} MiB peak RSS`,
        );
      }
    }
  }

  for (const runtime of runtimes) {
    const server = servers.get(runtime.name);
    if (server.child.exitCode !== null) {
      throw new Error(
        `${runtime.name} exited after stress (${server.child.exitCode}):\n${server.logs.join("")}`,
      );
    }
    heapSnapshots[runtime.name] = liveHeap(server.child.pid);
    console.log(
      `${runtime.name}: ${heapSnapshots[runtime.name].liveAllocationCount.toLocaleString("en-US")} live allocations, ${(heapSnapshots[runtime.name].liveAllocationBytes / 1024 / 1024).toFixed(1)} MiB live heap`,
    );
  }

  for (const runtime of runtimes) {
    const check = spawnSync(
      process.execPath,
      [path.join(appRoot, "scripts/check-fullstack.mjs")],
      {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          GEA_TODO_BASE_URL: `http://127.0.0.1:${runtime.port}`,
        },
      },
    );
    if (check.error || check.status !== 0) {
      throw new Error(
        `${runtime.name} post-stress correctness failed:\n${check.stdout}\n${check.stderr}`,
      );
    }
    const marker = check.stdout.trim().split(/\r?\n/).at(-1);
    if (!marker.startsWith("FULLSTACK_HTTP_CORRECTNESS_OK:")) {
      throw new Error(`${runtime.name} emitted an invalid correctness marker`);
    }
    correctness[runtime.name] = marker;
    console.log(`${runtime.name}: ${marker}`);
  }

  const durationMicroseconds = (value) => {
    const match = /^(\d+(?:\.\d+)?)(us|ms|s)$/.exec(value);
    if (match === null) throw new Error(`unsupported wrk duration ${value}`);
    const multiplier =
      match[2] === "us" ? 1 : match[2] === "ms" ? 1000 : 1_000_000;
    return Number(match[1]) * multiplier;
  };
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  };
  const summary = profiles.flatMap((profile) => {
    const rows = runtimes.map((runtime) => {
      const selected = samples.filter(
        (sample) =>
          sample.runtime === runtime.name && sample.profile === profile.name,
      );
      return {
        runtime: runtime.name,
        profile: profile.name,
        medianRequestsPerSecond: median(
          selected.map((sample) => sample.requestsPerSecond),
        ),
        medianPeakServerRssBytes: median(
          selected.map((sample) => sample.peakServerRssBytes),
        ),
        maximumPeakServerRssBytes: Math.max(
          ...selected.map((sample) => sample.peakServerRssBytes),
        ),
        medianCompletedRequests: median(
          selected.map((sample) => sample.completedRequests),
        ),
        medianLatencyP99Microseconds: median(
          selected.map((sample) => durationMicroseconds(sample.latencyP99)),
        ),
      };
    });
    const node = rows.find((row) => row.runtime === "nodejs-official");
    for (const row of rows) {
      row.throughputVsNode =
        row.medianRequestsPerSecond / node.medianRequestsPerSecond;
      row.peakRssVsNode =
        row.medianPeakServerRssBytes / node.medianPeakServerRssBytes;
    }
    return rows;
  });

  const metadata = {
    timestamp: new Date().toISOString(),
    host: `${os.cpus()[0]?.model ?? "unknown CPU"} (${os.cpus().length} logical cores)`,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    mongodb: execFileSync("mongosh", ["--quiet", "--eval", "db.version()"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .at(-1),
    wrk: execFileSync("brew", ["list", "--versions", "wrk"], {
      encoding: "utf8",
    }).trim(),
    durationSeconds,
    rounds,
    measuredRequests: samples.reduce(
      (total, sample) => total + sample.completedRequests,
      0,
    ),
  };
  const report = {
    metadata,
    methodology: {
      servers:
        "same server.ts: native Gea/Hono/MongoDB binary versus Node with official MongoDB driver",
      database:
        "shared local MongoDB; direct connection; pool size four; read-only during timed HTTP profiles",
      memory:
        "server-process RSS sampled every 250 ms; MongoDB and wrk process memory excluded",
      allocations:
        "macOS leaks live heap-node count and bytes after all stress profiles; this is a retained-allocation snapshot, not cumulative malloc calls",
      correctness:
        "zero wrk HTTP/socket errors required and full-stack create/read/update/delete check rerun after stress",
    },
    servers: Object.fromEntries(
      runtimes.map((runtime) => [
        runtime.name,
        {
          port: runtime.port,
          idleRssBytes: servers.get(runtime.name).idleRssBytes,
          ...heapSnapshots[runtime.name],
        },
      ]),
    ),
    correctness,
    samples,
    summary,
  };
  fs.mkdirSync(resultRoot, { recursive: true });
  fs.writeFileSync(
    path.join(resultRoot, "http-stress-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const rate = (value) => Math.round(value).toLocaleString("en-US");
  const mib = (value) => (value / 1024 / 1024).toFixed(1);
  const lines = [
    "# Full-stack HTTP stress benchmark",
    "",
    `Run: ${metadata.timestamp} on ${metadata.host}, MongoDB ${metadata.mongodb}, ${metadata.wrk}.`,
    "",
    `Each result is the median of ${rounds} × ${durationSeconds}-second wrk runs after route warmup. The measured profiles completed ${metadata.measuredRequests.toLocaleString("en-US")} HTTP requests with zero HTTP or socket errors, then both servers passed the full-stack CRUD checker.`,
    "",
    "| Profile | Gea req/s | Node req/s | Gea vs Node | Gea peak RSS | Node peak RSS | Gea RSS vs Node |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...profiles.map((profile) => {
      const gea = summary.find(
        (row) => row.profile === profile.name && row.runtime === "gea-native",
      );
      const node = summary.find(
        (row) =>
          row.profile === profile.name && row.runtime === "nodejs-official",
      );
      return `| ${profile.name} | ${rate(gea.medianRequestsPerSecond)} | ${rate(node.medianRequestsPerSecond)} | ${gea.throughputVsNode.toFixed(2)}× | ${mib(gea.medianPeakServerRssBytes)} MiB | ${mib(node.medianPeakServerRssBytes)} MiB | ${gea.peakRssVsNode.toFixed(2)}× |`;
    }),
    "",
    "| Profile | Gea p99 latency | Node p99 latency |",
    "|---|---:|---:|",
    ...profiles.map((profile) => {
      const gea = summary.find(
        (row) => row.profile === profile.name && row.runtime === "gea-native",
      );
      const node = summary.find(
        (row) =>
          row.profile === profile.name && row.runtime === "nodejs-official",
      );
      const formatLatency = (microseconds) =>
        microseconds < 1000
          ? `${Math.round(microseconds)} µs`
          : `${(microseconds / 1000).toFixed(2)} ms`;
      return `| ${profile.name} | ${formatLatency(gea.medianLatencyP99Microseconds)} | ${formatLatency(node.medianLatencyP99Microseconds)} |`;
    }),
    "",
    `Idle server RSS: Gea ${mib(servers.get("gea-native").idleRssBytes)} MiB; Node ${mib(servers.get("nodejs-official").idleRssBytes)} MiB. MongoDB server memory is excluded.`,
    `Post-stress live heap: Gea ${heapSnapshots["gea-native"].liveAllocationCount.toLocaleString("en-US")} allocations / ${mib(heapSnapshots["gea-native"].liveAllocationBytes)} MiB; Node ${heapSnapshots["nodejs-official"].liveAllocationCount.toLocaleString("en-US")} allocations / ${mib(heapSnapshots["nodejs-official"].liveAllocationBytes)} MiB. These are retained allocations reported by macOS \`leaks\`, not cumulative allocation calls.`,
    "",
    "Raw per-round throughput, latency, request counts, errors, and sampled RSS are in `http-stress-latest.json`.",
  ];
  fs.writeFileSync(
    path.join(resultRoot, "http-stress-latest.md"),
    `${lines.join("\n")}\n`,
  );
  console.log(`\n${lines.join("\n")}`);
} finally {
  for (const server of servers.values()) await stopServer(server);
}
