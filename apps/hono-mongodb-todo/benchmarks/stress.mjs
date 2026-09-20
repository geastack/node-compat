import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(benchmarkRoot, "..");
const distRoot = path.join(appRoot, "dist");
const resultRoot = path.join(benchmarkRoot, "results");

const numberFlag = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument === undefined
    ? fallback
    : Number(argument.slice(prefix.length));
};

const iterations = numberFlag("iterations", 10_000);
const warmup = numberFlag("warmup", 100);
const rounds = numberFlag("rounds", 3);
if (
  ![iterations, warmup, rounds].every(Number.isInteger) ||
  iterations < 1 ||
  warmup < 0 ||
  rounds < 1
) {
  throw new Error(
    "iterations, warmup, and rounds must be integers; iterations and rounds must be positive",
  );
}

const nativeExecutable = path.join(distRoot, "benchmark-gea-driver");
const rustExecutable = path.join(
  distRoot,
  "benchmark-rust/release/gea-mongodb-driver-benchmark",
);
const cppExecutable = path.join(distRoot, "benchmark-cpp-driver");
const drivers = [
  { name: "gea-native", command: nativeExecutable, args: [] },
  {
    name: "nodejs-official",
    command: process.execPath,
    args: [path.join(benchmarkRoot, "node-driver.mjs")],
  },
  { name: "rust-official", command: rustExecutable, args: [] },
  { name: "cpp-official", command: cppExecutable, args: [] },
];

for (const driver of drivers) {
  if (!fs.existsSync(driver.command)) {
    throw new Error(
      `missing ${driver.name} executable ${driver.command}; run npm run benchmark:drivers first`,
    );
  }
}

const parseTime = (stderr) => {
  const rss = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m)?.[1];
  const times = stderr.match(
    /^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys$/m,
  );
  if (rss === undefined || times === null) {
    throw new Error(`could not parse /usr/bin/time output:\n${stderr}`);
  }
  return {
    peakRssBytes: Number(rss),
    processSeconds: {
      real: Number(times[1]),
      user: Number(times[2]),
      system: Number(times[3]),
    },
  };
};

const samples = [];
const runId = Date.now().toString(36);
for (let round = 0; round < rounds; round += 1) {
  const ordered = [
    ...drivers.slice(round % drivers.length),
    ...drivers.slice(0, round % drivers.length),
  ];
  for (const driver of ordered) {
    const collection = `stress_${driver.name.replaceAll("-", "_")}_${runId}_${round}`;
    console.log(`stress ${round + 1}/${rounds}: ${driver.name}`);
    const result = spawnSync(
      "/usr/bin/time",
      ["-l", driver.command, ...driver.args],
      {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 600_000,
        env: {
          ...process.env,
          BENCH_ITERATIONS: String(iterations),
          BENCH_WARMUP: String(warmup),
          BENCH_COLLECTION: collection,
        },
      },
    );
    if (result.error || result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      throw new Error(
        `${driver.name} failed with ${result.error?.message ?? result.status ?? result.signal}`,
      );
    }
    const resultLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("BENCH_RESULT:"));
    if (resultLine === undefined) {
      throw new Error(`${driver.name} did not emit BENCH_RESULT`);
    }
    const benchmark = JSON.parse(resultLine.slice("BENCH_RESULT:".length));
    if (benchmark.iterations !== iterations) {
      throw new Error(`${driver.name} reported the wrong iteration count`);
    }
    const timing = parseTime(result.stderr);
    const timedMilliseconds = Object.values(benchmark.milliseconds).reduce(
      (total, value) => total + value,
      0,
    );
    const sample = {
      round: round + 1,
      ...benchmark,
      ...timing,
      timedOperationsPerSecond:
        (iterations * Object.keys(benchmark.milliseconds).length * 1000) /
        timedMilliseconds,
    };
    samples.push(sample);
    console.log(
      `  ${Math.round(sample.timedOperationsPerSecond).toLocaleString("en-US")} ops/s, ${(sample.peakRssBytes / 1024 / 1024).toFixed(1)} MiB peak RSS`,
    );
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};
const summary = drivers.map((driver) => {
  const selected = samples.filter((sample) => sample.driver === driver.name);
  return {
    driver: driver.name,
    medianTimedOperationsPerSecond: median(
      selected.map((sample) => sample.timedOperationsPerSecond),
    ),
    medianPeakRssBytes: median(
      selected.map((sample) => sample.peakRssBytes),
    ),
    maximumPeakRssBytes: Math.max(
      ...selected.map((sample) => sample.peakRssBytes),
    ),
    medianProcessSeconds: median(
      selected.map((sample) => sample.processSeconds.real),
    ),
  };
});
const node = summary.find((entry) => entry.driver === "nodejs-official");
for (const entry of summary) {
  entry.throughputVsNode =
    entry.medianTimedOperationsPerSecond /
    node.medianTimedOperationsPerSecond;
  entry.peakRssVsNode = entry.medianPeakRssBytes / node.medianPeakRssBytes;
}

const metadata = {
  timestamp: new Date().toISOString(),
  host: `${os.cpus()[0]?.model ?? "unknown CPU"} (${os.cpus().length} logical cores)`,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  totalMemoryBytes: os.totalmem(),
  mongodb: execFileSync("mongosh", ["--quiet", "--eval", "db.version()"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .at(-1),
  iterations,
  warmup,
  rounds,
  timedCommands: iterations * 4 * drivers.length * rounds,
};
const report = {
  metadata,
  methodology: {
    workload:
      "sequential acknowledged insertOne, indexed findOne, updateOne, and deleteOne",
    transport: "one warmed pooled connection per driver process",
    memory:
      "macOS /usr/bin/time -l maximum resident set size; includes runtime, driver, linked libraries, BSON state, and preallocated benchmark documents",
    aggregation:
      "median throughput and peak RSS across rotated rounds; maximum RSS also retained",
  },
  samples,
  summary,
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(
  path.join(resultRoot, "stress-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

const rate = (value) => Math.round(value).toLocaleString("en-US");
const mib = (value) => (value / 1024 / 1024).toFixed(1);
const lines = [
  "# MongoDB driver endurance and memory benchmark",
  "",
  `Run: ${metadata.timestamp} on ${metadata.host}, MongoDB ${metadata.mongodb}.`,
  "",
  `Each result is the median of ${rounds} rounds × ${iterations.toLocaleString("en-US")} operations in each of four sequential CRUD phases. The complete run executed ${metadata.timedCommands.toLocaleString("en-US")} timed MongoDB commands plus warmup.`,
  "",
  "| Driver | Combined ops/s | vs Node | Median peak RSS | Max peak RSS | RSS vs Node | Process wall time |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...summary.map(
    (entry) =>
      `| ${entry.driver} | ${rate(entry.medianTimedOperationsPerSecond)} | ${entry.throughputVsNode.toFixed(2)}× | ${mib(entry.medianPeakRssBytes)} MiB | ${mib(entry.maximumPeakRssBytes)} MiB | ${entry.peakRssVsNode.toFixed(2)}× | ${entry.medianProcessSeconds.toFixed(2)} s |`,
  ),
  "",
  "Peak RSS comes from macOS `/usr/bin/time -l` and includes each process runtime, driver, linked libraries, BSON state, and the preallocated benchmark documents. MongoDB server memory is excluded.",
  "",
  "Raw per-round timings and memory measurements are in `stress-latest.json`.",
];
fs.writeFileSync(
  path.join(resultRoot, "stress-latest.md"),
  `${lines.join("\n")}\n`,
);
console.log(`\n${lines.join("\n")}`);
