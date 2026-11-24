import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandExists, mongodbVersion, resultRootFor, versionOf } from "./platform.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(benchmarkRoot, "..");
const nodeCompatRoot = path.resolve(appRoot, "../..");
const distRoot = path.join(appRoot, "dist");
const resultRoot = resultRootFor(benchmarkRoot);

const valueOf = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument === undefined
    ? fallback
    : Number(argument.slice(prefix.length));
};

// The defaults are the counts `native-driver.ts` and `node-driver.mjs` run as
// constants (the native build cannot read the environment yet); the Rust and
// C++ arms take them through BENCH_ITERATIONS/BENCH_WARMUP.
const iterations = valueOf("iterations", 20000);
const warmup = valueOf("warmup", 2000);
const rounds = valueOf("rounds", 7);
const skipBuild = process.argv.includes("--skip-build");
if (
  ![iterations, warmup, rounds].every(Number.isInteger) ||
  iterations < 1 ||
  warmup < 0 ||
  rounds < 1
) {
  throw new Error(
    "iterations, warmup, and rounds must be non-negative integers (iterations and rounds must be positive)",
  );
}

fs.mkdirSync(distRoot, { recursive: true });
fs.mkdirSync(resultRoot, { recursive: true });

const nativeExecutable = path.join(distRoot, "benchmark-gea-driver");
const rustTarget = path.join(distRoot, "benchmark-rust");
const rustExecutable = path.join(
  rustTarget,
  "release",
  "gea-mongodb-driver-benchmark",
);
const cppExecutable = path.join(distRoot, "benchmark-cpp-driver");
const pkgConfigPath = [
  "/opt/homebrew/opt/mongo-cxx-driver/lib/pkgconfig",
  "/opt/homebrew/opt/mongo-c-driver/lib/pkgconfig",
  process.env.PKG_CONFIG_PATH,
]
  .filter(Boolean)
  .join(":");

// The Rust and C++ arms need their toolchains; a machine without one runs the
// remaining drivers and the report says which arms were skipped.
const cppFlagsOrNull = () => {
  try {
    return execFileSync("pkg-config", ["--cflags", "--libs", "libmongocxx1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PKG_CONFIG_PATH: pkgConfigPath },
    })
      .trim()
      .split(/\s+/);
  } catch {
    return null;
  }
};
const haveRust = commandExists("cargo");
const cppFlags = cppFlagsOrNull();
const skippedArms = [
  ...(haveRust ? [] : ["rust-official (no cargo on PATH)"]),
  ...(cppFlags ? [] : ["cpp-official (pkg-config finds no libmongocxx1)"]),
];
for (const arm of skippedArms) console.log(`skipping ${arm}`);

function runChecked(command, args, options = {}) {
  console.log(`build: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed with ${result.error?.message ?? result.status ?? result.signal}`,
    );
  }
}

if (!skipBuild) {
  runChecked(process.execPath, [
    path.join(nodeCompatRoot, "scripts/build.mjs"),
    path.join(benchmarkRoot, "native-driver.ts"),
    "--source-project",
    path.join(appRoot, "node_modules/mongodb/tsconfig.json"),
    "--globals",
    "--out",
    distRoot,
    "--exe",
    nativeExecutable,
  ]);

  if (haveRust) runChecked(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(benchmarkRoot, "rust-driver/Cargo.toml"),
      "--jobs",
      "4",
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: rustTarget } },
  );

  if (cppFlags) runChecked(
    "clang++",
    [
      "-std=c++20",
      "-O2",
      path.join(benchmarkRoot, "cpp-driver.cpp"),
      "-o",
      cppExecutable,
      ...cppFlags,
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
    args: [path.join(benchmarkRoot, "node-driver.mjs")],
  },
  ...(haveRust ? [{ name: "rust-official", command: rustExecutable, args: [] }] : []),
  ...(cppFlags ? [{ name: "cpp-official", command: cppExecutable, args: [] }] : []),
];
for (const driver of drivers) {
  if (driver.command !== process.execPath && !fs.existsSync(driver.command))
    throw new Error(`missing benchmark executable: ${driver.command}`);
}
const samples = [];
const runId = Date.now().toString(36);

for (let round = 0; round < rounds; round += 1) {
  const ordered = [
    ...drivers.slice(round % drivers.length),
    ...drivers.slice(0, round % drivers.length),
  ];
  for (const driver of ordered) {
    const collection = `${driver.name.replaceAll("-", "_")}_${runId}_${round}`;
    console.log(`run ${round + 1}/${rounds}: ${driver.name}`);
    const result = spawnSync(driver.command, driver.args, {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        BENCH_ITERATIONS: String(iterations),
        BENCH_WARMUP: String(warmup),
        BENCH_COLLECTION: collection,
      },
    });
    if (result.error || result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      throw new Error(
        `${driver.name} failed with ${result.error?.message ?? result.status ?? result.signal}`,
      );
    }
    const resultLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("BENCH_RESULT:"));
    if (resultLine === undefined)
      throw new Error(`${driver.name} did not emit BENCH_RESULT`);
    const sample = JSON.parse(resultLine.slice("BENCH_RESULT:".length));
    if (sample.iterations !== iterations)
      throw new Error(
        `${driver.name} ran ${sample.iterations} iterations, not ${iterations}; the native and Node arms run a fixed 20000`,
      );
    samples.push({ round: round + 1, ...sample });
    console.log(`  ${JSON.stringify(sample.milliseconds)}`);
  }
}

const operations = ["insertOne", "findOne", "updateOne", "deleteOne"];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};
const summarized = drivers.map((driver) => {
  const driverSamples = samples.filter(
    (sample) => sample.driver === driver.name,
  );
  const milliseconds = Object.fromEntries(
    operations.map((operation) => [
      operation,
      median(driverSamples.map((sample) => sample.milliseconds[operation])),
    ]),
  );
  const operationsPerSecond = Object.fromEntries(
    operations.map((operation) => [
      operation,
      (iterations * 1000) / milliseconds[operation],
    ]),
  );
  operationsPerSecond.combined =
    (iterations * operations.length * 1000) /
    operations.reduce((total, operation) => total + milliseconds[operation], 0);
  return {
    driver: driver.name,
    transport: driverSamples[0].transport,
    medianMilliseconds: milliseconds,
    operationsPerSecond,
  };
});
const nodeSummary = summarized.find(
  (entry) => entry.driver === "nodejs-official",
);
for (const entry of summarized) {
  entry.relativeToNode = Object.fromEntries(
    [...operations, "combined"].map((operation) => [
      operation,
      entry.operationsPerSecond[operation] /
        nodeSummary.operationsPerSecond[operation],
    ]),
  );
}

const metadata = {
  timestamp: new Date().toISOString(),
  host: `${os.cpus()[0]?.model ?? "unknown CPU"} (${os.cpus().length} logical cores)`,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  mongodb: mongodbVersion(),
  node: process.version,
  nodeDriver: JSON.parse(
    fs.readFileSync(
      path.join(appRoot, "node_modules/mongodb/package.json"),
      "utf8",
    ),
  ).version,
  rust: haveRust ? versionOf("rustc", ["--version"]) : null,
  rustDriver: fs
    .readFileSync(path.join(benchmarkRoot, "rust-driver/Cargo.lock"), "utf8")
    .match(/name = "mongodb"\nversion = "([^"]+)"/)?.[1],
  cppDriver: cppFlags
    ? (versionOf("brew", ["list", "--versions", "mongo-cxx-driver"]) ??
      versionOf("pkg-config", ["--modversion", "libmongocxx1"]))
    : null,
  skippedArms,
  iterations,
  warmup,
  rounds,
};
const report = {
  metadata,
  methodology: {
    database:
      "MongoDB on 127.0.0.1:27017, acknowledged writes, indexed _id reads",
    workload:
      "256-byte payload plus _id/title/completed/revision fields; sequential insertOne, findOne, updateOne, deleteOne phases",
    timing:
      "connection setup and warmup excluded; median elapsed phase time across rounds",
    connectionPolicy: "all drivers use one warmed pooled connection",
  },
  samples,
  summary: summarized,
};
fs.writeFileSync(
  path.join(resultRoot, "latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

const formatRate = (value) => Math.round(value).toLocaleString("en-US");
const lines = [
  "# MongoDB driver benchmark",
  "",
  `Run: ${metadata.timestamp} on ${metadata.host}`,
  "",
  `MongoDB ${metadata.mongodb}; ${metadata.node}; Node driver ${metadata.nodeDriver}${haveRust ? `; Rust driver ${metadata.rustDriver}` : ""}${cppFlags ? `; C++ driver ${metadata.cppDriver.replace("mongo-cxx-driver ", "")}` : ""}.`,
  ...(skippedArms.length > 0 ? ["", `Skipped: ${skippedArms.join("; ")}.`] : []),
  "",
  `Each result is the median of ${rounds} rounds × ${iterations.toLocaleString("en-US")} sequential operations after ${warmup} untimed CRUD warmups.`,
  "",
  "| Driver | insertOne ops/s | findOne ops/s | updateOne ops/s | deleteOne ops/s | Combined ops/s | vs Node |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...summarized.map(
    (entry) =>
      `| ${entry.driver} | ${formatRate(entry.operationsPerSecond.insertOne)} | ${formatRate(entry.operationsPerSecond.findOne)} | ${formatRate(entry.operationsPerSecond.updateOne)} | ${formatRate(entry.operationsPerSecond.deleteOne)} | ${formatRate(entry.operationsPerSecond.combined)} | ${entry.relativeToNode.combined.toFixed(2)}× |`,
  ),
  "",
  "Every driver reuses one warmed pooled connection. Client construction, connection setup, cleanup, and warmup are outside the timed phases.",
  "",
  "Raw samples and exact phase times are in `latest.json`.",
];
fs.writeFileSync(path.join(resultRoot, "latest.md"), `${lines.join("\n")}\n`);
console.log(`\n${lines.join("\n")}`);
