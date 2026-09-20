import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(benchmarkRoot, "..");
const nodeCompatRoot = path.resolve(appRoot, "../..");
const distRoot = path.join(appRoot, "dist");
const resultRoot = path.join(benchmarkRoot, "results");
const rounds = Number(
  process.argv.find((value) => value.startsWith("--rounds="))?.split("=")[1] ??
    "3",
);
const skipBuild = process.argv.includes("--skip-build");
if (!Number.isInteger(rounds) || rounds < 1)
  throw new Error("rounds must be a positive integer");

const nativeExecutable = path.join(distRoot, "benchmark-gea-flex");
const cppExecutable = path.join(distRoot, "benchmark-cpp-flex");
const rustTarget = path.join(distRoot, "benchmark-rust");
const rustExecutable = path.join(rustTarget, "release", "flex");
const pkgConfigPath = [
  "/opt/homebrew/opt/mongo-cxx-driver/lib/pkgconfig",
  "/opt/homebrew/opt/mongo-c-driver/lib/pkgconfig",
  process.env.PKG_CONFIG_PATH,
]
  .filter(Boolean)
  .join(":");

function checked(command, args, options = {}) {
  console.log(`build: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed with ${result.error?.message ?? result.status ?? result.signal}`,
    );
}

if (!skipBuild) {
  checked(
    process.execPath,
    [
      path.join(nodeCompatRoot, "scripts/build.mjs"),
      path.join(benchmarkRoot, "flex-native.ts"),
      "--from-source=mongodb,bson,mongodb-connection-string-url",
      "--source-project",
      path.join(nodeCompatRoot, "vendored-sources/mongodb/tsconfig.json"),
      "--globals",
      "--out",
      distRoot,
      "--exe",
      nativeExecutable,
    ],
    { env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" } },
  );
  checked(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(benchmarkRoot, "rust-driver/Cargo.toml"),
      "--bin",
      "flex",
      "--jobs",
      "4",
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: rustTarget } },
  );
  const flags = execFileSync(
    "pkg-config",
    ["--cflags", "--libs", "libmongocxx1"],
    {
      encoding: "utf8",
      env: { ...process.env, PKG_CONFIG_PATH: pkgConfigPath },
    },
  )
    .trim()
    .split(/\s+/);
  checked(
    "clang++",
    [
      "-std=c++20",
      "-O2",
      path.join(benchmarkRoot, "flex-cpp.cpp"),
      "-o",
      cppExecutable,
      ...flags,
      "-Wl,-rpath,/opt/homebrew/opt/mongo-cxx-driver/lib",
    ],
    { env: { ...process.env, PKG_CONFIG_PATH: pkgConfigPath } },
  );
}

const drivers = [
  { name: "gea-native", command: nativeExecutable, args: [] },
  {
    name: "nodejs-official",
    command: process.execPath,
    args: [path.join(benchmarkRoot, "flex-node.mjs")],
  },
  { name: "rust-official", command: rustExecutable, args: [] },
  { name: "cpp-official", command: cppExecutable, args: [] },
];
for (const driver of drivers)
  if (!fs.existsSync(driver.command))
    throw new Error(`missing ${driver.name} executable ${driver.command}`);

const profiles = [
  { mode: "bson-small", iterations: 50_000 },
  { mode: "bson-string-256k", iterations: 1_000 },
  { mode: "bson-array-4096", iterations: 1_000 },
  ...[1, 4, 16, 64].map((poolSize) => ({
    mode: "concurrent",
    iterations: 4000,
    poolSize,
    concurrency: 64,
  })),
  { mode: "large", iterations: 10, poolSize: 4 },
  { mode: "batch", iterations: 2000, poolSize: 4 },
];

function parseTime(stderr) {
  const rss = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m)?.[1];
  const times = stderr.match(
    /^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys$/m,
  );
  const reclaims = stderr.match(/^\s*(\d+)\s+page reclaims$/m)?.[1];
  const footprint = stderr.match(/^\s*(\d+)\s+peak memory footprint$/m)?.[1];
  if (rss === undefined || times === null)
    throw new Error(`could not parse /usr/bin/time output:\n${stderr}`);
  return {
    peakRssBytes: Number(rss),
    peakFootprintBytes: footprint === undefined ? null : Number(footprint),
    pageReclaims: reclaims === undefined ? null : Number(reclaims),
    processSeconds: {
      real: Number(times[1]),
      user: Number(times[2]),
      system: Number(times[3]),
    },
  };
}

const samples = [];
const runId = Date.now().toString(36);
for (let round = 0; round < rounds; round += 1) {
  for (
    let profileIndex = 0;
    profileIndex < profiles.length;
    profileIndex += 1
  ) {
    const profile = profiles[profileIndex];
    const offset = (round + profileIndex) % drivers.length;
    const ordered = [...drivers.slice(offset), ...drivers.slice(0, offset)];
    for (const driver of ordered) {
      const label =
        profile.mode === "concurrent"
          ? `${profile.mode}-pool-${profile.poolSize}`
          : profile.mode;
      console.log(`flex ${round + 1}/${rounds}: ${driver.name} ${label}`);
      const collection = `flex_${driver.name.replaceAll("-", "_")}_${profile.mode}_${profile.poolSize ?? 0}_${runId}_${round}`;
      const result = spawnSync(
        "/usr/bin/time",
        ["-l", driver.command, ...driver.args],
        {
          cwd: appRoot,
          encoding: "utf8",
          timeout: 600_000,
          env: {
            ...process.env,
            BENCH_MODE: profile.mode,
            BENCH_ITERATIONS: String(profile.iterations),
            BENCH_POOL_SIZE: String(profile.poolSize ?? 4),
            BENCH_CONCURRENCY: String(profile.concurrency ?? 1),
            BENCH_COLLECTION: collection,
          },
        },
      );
      if (result.error || result.status !== 0) {
        process.stderr.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        throw new Error(
          `${driver.name} ${label} failed with ${result.error?.message ?? result.status ?? result.signal}`,
        );
      }
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("FLEX_RESULT:"));
      if (line === undefined)
        throw new Error(`${driver.name} ${label} emitted no FLEX_RESULT`);
      const benchmark = JSON.parse(line.slice("FLEX_RESULT:".length));
      const timing = parseTime(result.stderr);
      samples.push({
        round: round + 1,
        profile: label,
        ...benchmark,
        ...timing,
      });
      const milliseconds = Object.values(benchmark.milliseconds).reduce(
        (sum, value) => sum + value,
        0,
      );
      console.log(
        `  ${milliseconds.toFixed(1)} ms timed, ${(timing.peakRssBytes / 1024 / 1024).toFixed(1)} MiB RSS, ${(timing.processSeconds.user + timing.processSeconds.system).toFixed(2)} CPU s`,
      );
    }
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};
const summaries = [];
for (const profile of [...new Set(samples.map((sample) => sample.profile))]) {
  for (const driver of drivers) {
    const selected = samples.filter(
      (sample) => sample.profile === profile && sample.driver === driver.name,
    );
    const first = selected[0];
    const operationNames = Object.keys(first.milliseconds);
    const milliseconds = Object.fromEntries(
      operationNames.map((name) => [
        name,
        median(selected.map((sample) => sample.milliseconds[name])),
      ]),
    );
    const phaseOperations = first.operations ?? null;
    const documentBytes = typeof first.bytes === "number" ? first.bytes : null;
    const phaseOperationsPerSecond =
      phaseOperations === null
        ? null
        : Object.fromEntries(
            operationNames.map((name) => [
              name,
              (phaseOperations[name] * 1000) / milliseconds[name],
            ]),
          );
    const phaseMebibytesPerSecond =
      documentBytes === null || phaseOperationsPerSecond === null
        ? null
        : Object.fromEntries(
            operationNames.map((name) => [
              name,
              (phaseOperationsPerSecond[name] * documentBytes) / 1024 / 1024,
            ]),
          );
    let logicalOperations;
    if (first.mode.startsWith("bson-"))
      logicalOperations = Object.values(first.operations).reduce(
        (sum, value) => sum + value,
        0,
      );
    else
      logicalOperations =
        first.iterations * (first.mode === "concurrent" ? 1 : 2);
    const timedMilliseconds = Object.values(milliseconds).reduce(
      (sum, value) => sum + value,
      0,
    );
    summaries.push({
      profile,
      driver: driver.name,
      milliseconds,
      phaseOperations,
      phaseOperationsPerSecond,
      phaseMebibytesPerSecond,
      documentBytes,
      logicalOperations,
      logicalOperationsPerSecond:
        (logicalOperations * 1000) / timedMilliseconds,
      medianPeakRssBytes: median(selected.map((sample) => sample.peakRssBytes)),
      medianCpuSeconds: median(
        selected.map(
          (sample) => sample.processSeconds.user + sample.processSeconds.system,
        ),
      ),
    });
  }
}

for (const summary of summaries) {
  const node = summaries.find(
    (candidate) =>
      candidate.profile === summary.profile &&
      candidate.driver === "nodejs-official",
  );
  summary.throughputVsNode =
    summary.logicalOperationsPerSecond / node.logicalOperationsPerSecond;
  summary.rssVsNode = summary.medianPeakRssBytes / node.medianPeakRssBytes;
}

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
  rounds,
};
const report = {
  metadata,
  methodology: {
    bsonSmall:
      "50,000 in-process BSON encodes and 50,000 full decodes of a 334-byte mixed-type todo document; no MongoDB",
    bsonString:
      "1,000 in-process BSON encodes and 1,000 full decodes of a document containing one 256-KiB UTF-8 string; no MongoDB",
    bsonArray:
      "1,000 in-process BSON encodes and 1,000 full decodes of a document containing 4,096 integers; no MongoDB",
    concurrent:
      "4,000 acknowledged ping commands split over 64 workers; pool sizes 1, 4, 16, and 64",
    large:
      "10 sequential acknowledged inserts and indexed reads of 256-KiB documents with 4,096-number arrays",
    batch:
      "2,000 documents inserted in batches of 100, followed by one acknowledged multi-document update",
    process:
      "macOS /usr/bin/time -l wall/user/system CPU, peak RSS, peak footprint, and page-reclaim counters",
    aggregation: "median across rotated driver order; all raw samples retained",
  },
  samples,
  summary: summaries,
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(
  path.join(resultRoot, "flex-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
const formatRate = (value) =>
  value < 10
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    : Math.round(value).toLocaleString("en-US");
const formatRatio = (value) =>
  value < 0.01 ? "<0.01×" : `${value.toFixed(2)}×`;
const lines = [
  "# MongoDB driver flex benchmark",
  "",
  `Run: ${metadata.timestamp} on ${metadata.host}, MongoDB ${metadata.mongodb}.`,
  "",
  "| Workload | Driver | Logical ops/s | vs Node | Peak RSS | RSS vs Node | Client CPU |",
  "|---|---|---:|---:|---:|---:|---:|",
  ...summaries.map(
    (entry) =>
      `| ${entry.profile} | ${entry.driver} | ${formatRate(entry.logicalOperationsPerSecond)} | ${formatRatio(entry.throughputVsNode)} | ${(entry.medianPeakRssBytes / 1024 / 1024).toFixed(1)} MiB | ${entry.rssVsNode.toFixed(2)}× | ${entry.medianCpuSeconds.toFixed(2)} s |`,
  ),
  "",
  "## Raw BSON phases",
  "",
  "| Workload | Driver | Encode ops/s / MiB/s | vs Node | Decode ops/s / MiB/s | vs Node |",
  "|---|---|---:|---:|---:|---:|",
  ...summaries
    .filter((entry) => entry.profile.startsWith("bson-"))
    .map((entry) => {
      const node = summaries.find(
        (candidate) =>
          candidate.profile === entry.profile &&
          candidate.driver === "nodejs-official",
      );
      const encodeRate = entry.phaseOperationsPerSecond.encode;
      const decodeRate = entry.phaseOperationsPerSecond.decode;
      const nodeEncodeRate = node.phaseOperationsPerSecond.encode;
      const nodeDecodeRate = node.phaseOperationsPerSecond.decode;
      const encodeThroughput = `${formatRate(encodeRate)} / ${formatRate(entry.phaseMebibytesPerSecond.encode)} MiB/s`;
      const lazyCppDecode = entry.driver === "cpp-official";
      const decodeThroughput = lazyCppDecode
        ? `${formatRate(decodeRate)} / lazy view`
        : `${formatRate(decodeRate)} / ${formatRate(entry.phaseMebibytesPerSecond.decode)} MiB/s`;
      const decodeRatio = lazyCppDecode
        ? "n/a"
        : formatRatio(decodeRate / nodeDecodeRate);
      return `| ${entry.profile} | ${entry.driver} | ${encodeThroughput} | ${formatRatio(encodeRate / nodeEncodeRate)} | ${decodeThroughput} | ${decodeRatio} |`;
    }),
  "",
  "BSON runs do not contact MongoDB. The Node, Rust, and Gea decoders materialize owned documents. The C++ driver exposes BSON views, so its decode rows validate and traverse the requested value without allocating an equivalent object graph. Concurrent runs use 64 workers at each stated pool size. Large-document and batch rates count both write and read/update document operations. Raw phase timings, CPU split, RSS, footprint, and page reclaims are in `flex-latest.json`.",
];
fs.writeFileSync(
  path.join(resultRoot, "flex-latest.md"),
  `${lines.join("\n")}\n`,
);
console.log(`\n${lines.join("\n")}`);
