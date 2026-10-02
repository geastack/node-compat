// Driver against driver, with MongoDB's latency taken out: the CPU the
// CLIENT process spends per operation, native Gea driver versus Node's
// official one, on the same operations against the same local mongod.
//
// Wall-clock per operation is mostly the round trip to mongod, which is the
// same for both drivers. CPU time is not: a process waiting on a socket burns
// none, and mongod's work runs in another process. Each driver prints a
// `BENCH_PHASE:<name>` marker after a phase and then idles; this harness reads
// the process's cumulative user+system CPU (every thread) during that idle
// window, so consecutive samples differ by exactly one phase's client CPU.
// Startup, connect and warmup fall before the `ready` sample.
//
//   node benchmarks/driver-cpu.mjs [--rounds=3] [--native=dist/driver-bench/benchmark-gea-driver]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(benchmarkRoot, "..");
const resultRoot = path.join(benchmarkRoot, "results");

const flag = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument === undefined ? fallback : argument.slice(prefix.length);
};
const rounds = Number(flag("rounds", "3"));
const nativeExecutable = path.resolve(appRoot, flag("native", "dist/driver-bench/benchmark-gea-driver"));
if (!fs.existsSync(nativeExecutable))
  throw new Error(`missing ${nativeExecutable}; build benchmarks/native-driver.ts first`);

const drivers = [
  { name: "gea-native", command: nativeExecutable, args: [] },
  { name: "nodejs-official", command: process.execPath, args: [path.join(benchmarkRoot, "node-driver.mjs")] },
];
const operations = ["insertOne", "findOne", "updateOne", "deleteOne"];

// macOS `ps` reports CPU as `MM:SS.cc`; 20000 operations per phase keep
// centiseconds under a few percent of any phase. Linux `ps` prints whole
// seconds (`[HH:]MM:SS`), which rounds every phase to zero, so there the
// scheduler's per-thread nanosecond totals are summed instead.
const linuxCpuMicroseconds = (pid) => {
  let nanoseconds = 0;
  for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
    try {
      nanoseconds += Number(fs.readFileSync(`/proc/${pid}/task/${task}/schedstat`, "utf8").split(" ")[0]);
    } catch {
      // A thread that exited between the listing and the read.
    }
  }
  return nanoseconds / 1000;
};
const sample = (pid) => {
  const [time, rss] = execFileSync("ps", ["-o", "time=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
  if (process.platform === "linux") return { cpuMicroseconds: linuxCpuMicroseconds(pid), rssBytes: Number(rss) * 1024 };
  const [minutes, seconds] = time.split(":");
  return { cpuMicroseconds: (Number(minutes) * 60 + Number(seconds)) * 1_000_000, rssBytes: Number(rss) * 1024 };
};
const dropDatabase = () =>
  spawnSync("mongosh", ["--quiet", "--eval", "db.getSiblingDB('gea_driver_benchmark').dropDatabase()"], { stdio: "ignore" });

const measure = (driver) =>
  new Promise((resolve, reject) => {
    dropDatabase();
    const child = spawn(driver.command, driver.args, { cwd: appRoot, stdio: ["ignore", "pipe", "inherit"] });
    const samples = {};
    const pending = [];
    let result = null;
    let peakRssBytes = 0;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("BENCH_PHASE:")) {
        const name = line.slice("BENCH_PHASE:".length);
        // Mid-way through the driver's 400 ms idle: the marker's own write and
        // any trailing work have settled.
        pending.push(
          new Promise((done) =>
            setTimeout(() => {
              samples[name] = sample(child.pid);
              peakRssBytes = Math.max(peakRssBytes, samples[name].rssBytes);
              done();
            }, 200),
          ),
        );
      } else if (line.startsWith("BENCH_RESULT:")) result = JSON.parse(line.slice("BENCH_RESULT:".length));
    });
    child.on("error", reject);
    child.on("exit", async (code, signal) => {
      await Promise.all(pending);
      if (code !== 0 || result === null) return reject(new Error(`${driver.name} exited ${code ?? signal}`));
      const phases = ["ready", ...operations];
      const cpuPerOperation = Object.fromEntries(
        operations.map((operation, index) => [
          operation,
          (samples[operation].cpuMicroseconds - samples[phases[index]].cpuMicroseconds) / result.iterations,
        ]),
      );
      const wallPerOperation = Object.fromEntries(
        operations.map((operation) => [operation, (result.milliseconds[operation] * 1000) / result.iterations]),
      );
      resolve({
        iterations: result.iterations,
        startupConnectWarmupCpuMicroseconds: samples.ready.cpuMicroseconds,
        cpuPerOperation,
        wallPerOperation,
        peakRssBytes,
      });
    });
  });

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const samples = [];
try {
  for (let round = 0; round < rounds; round += 1) {
    const ordered = round % 2 === 0 ? drivers : [...drivers].reverse();
    for (const driver of ordered) {
      const measured = await measure(driver);
      samples.push({ round: round + 1, driver: driver.name, ...measured });
      console.log(
        `round ${round + 1}/${rounds} ${driver.name}: CPU µs/op ${operations
          .map((operation) => `${operation} ${measured.cpuPerOperation[operation].toFixed(1)}`)
          .join(", ")}`,
      );
    }
  }
} finally {
  dropDatabase();
}

const summary = drivers.map((driver) => {
  const own = samples.filter((entry) => entry.driver === driver.name);
  const per = (field) =>
    Object.fromEntries(operations.map((operation) => [operation, median(own.map((entry) => entry[field][operation]))]));
  const cpu = per("cpuPerOperation");
  return {
    driver: driver.name,
    cpuMicrosecondsPerOperation: cpu,
    cpuMicrosecondsPerOperationMean: operations.reduce((total, operation) => total + cpu[operation], 0) / operations.length,
    wallMicrosecondsPerOperation: per("wallPerOperation"),
    peakRssBytes: median(own.map((entry) => entry.peakRssBytes)),
    startupConnectWarmupCpuMicroseconds: median(own.map((entry) => entry.startupConnectWarmupCpuMicroseconds)),
  };
});
const [gea, node] = summary;
const metadata = {
  timestamp: new Date().toISOString(),
  host: `${os.cpus()[0]?.model ?? "unknown CPU"} (${os.cpus().length} logical cores)`,
  loadAverage: os.loadavg(),
  mongodb: execFileSync("mongosh", ["--quiet", "--eval", "db.version()"], { encoding: "utf8" }).trim().split(/\r?\n/).at(-1),
  iterations: samples[0].iterations,
  rounds,
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(resultRoot, "driver-cpu-latest.json"), `${JSON.stringify({ metadata, samples, summary }, null, 2)}\n`);

const us = (value) => `${value.toFixed(1)} µs`;
const lines = [
  "# MongoDB driver CPU per operation: Gea native vs Node official",
  "",
  `Run: ${metadata.timestamp} on ${metadata.host}, MongoDB ${metadata.mongodb}, load ${metadata.loadAverage.map((value) => value.toFixed(1)).join("/")}. ${metadata.iterations} operations per phase, median of ${rounds} rounds, one pooled connection.`,
  "",
  "Client CPU per operation (user+system, all threads), MongoDB latency and MongoDB's own CPU excluded:",
  "",
  "| Operation | Gea | Node | Gea vs Node |",
  "|---|---:|---:|---:|",
  ...operations.map(
    (operation) =>
      `| ${operation} | ${us(gea.cpuMicrosecondsPerOperation[operation])} | ${us(node.cpuMicrosecondsPerOperation[operation])} | ${(gea.cpuMicrosecondsPerOperation[operation] / node.cpuMicrosecondsPerOperation[operation]).toFixed(2)}× |`,
  ),
  `| mean | ${us(gea.cpuMicrosecondsPerOperationMean)} | ${us(node.cpuMicrosecondsPerOperationMean)} | ${(gea.cpuMicrosecondsPerOperationMean / node.cpuMicrosecondsPerOperationMean).toFixed(2)}× |`,
  "",
  "Wall-clock per operation, round trip to mongod included (for reference):",
  "",
  "| Operation | Gea | Node |",
  "|---|---:|---:|",
  ...operations.map(
    (operation) => `| ${operation} | ${us(gea.wallMicrosecondsPerOperation[operation])} | ${us(node.wallMicrosecondsPerOperation[operation])} |`,
  ),
  "",
  `Peak RSS: Gea ${(gea.peakRssBytes / 1024 / 1024).toFixed(1)} MiB, Node ${(node.peakRssBytes / 1024 / 1024).toFixed(1)} MiB. Startup + connect + warmup CPU: Gea ${(gea.startupConnectWarmupCpuMicroseconds / 1000).toFixed(0)} ms, Node ${(node.startupConnectWarmupCpuMicroseconds / 1000).toFixed(0)} ms.`,
];
fs.writeFileSync(path.join(resultRoot, "driver-cpu-latest.md"), `${lines.join("\n")}\n`);
console.log(`\n${lines.join("\n")}`);
