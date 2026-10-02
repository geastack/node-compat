// Per-operation allocation-site census for a native driver binary.
//
// Pool cells are taken by inlined free-list pops, so no function can be
// probed to count them. The caller registers a uprobe event `gea_alloc:e<N>`
// on every store to an `AllocationPool::available` / `fresh` slot (from the
// disassembly); this harness puts an in-kernel hit-count histogram on the ids
// in `<ids-file>` only while ONE phase runs (a probed pool take costs ~1.5 us,
// so probing the warmup and every phase would take minutes), snapshots the
// histograms around that phase and kills the binary. Adding a trigger is fast;
// the caller removes them afterwards, which synchronizes the kernel for ~40 s.
//
//   node benchmarks/alloc-hist.mjs <binary> <ids-file> <phase> <out.json>
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [binary, idsFile, target, outFile] = process.argv.slice(2);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracefs = "/sys/kernel/tracing/events/gea_alloc";
const phases = ["ready", "insertOne", "findOne", "updateOne", "deleteOne"];
const previous = phases[phases.indexOf(target) - 1];
const ids = fs.readFileSync(idsFile, "utf8").split(/\s+/).filter(Boolean);

const sudoSh = (script) => spawnSync("sudo", ["-n", "sh", "-c", script], { encoding: "utf8", maxBuffer: 1 << 28 });
const idList = ids.map((id) => `e${id}`).join(" ");

const snapshot = (pid) => {
  const tids = new Set(fs.readdirSync(`/proc/${pid}/task`));
  const text = sudoSh(`cd ${tracefs}; for e in ${idList}; do echo "@@ $e"; cat $e/hist; done`).stdout;
  const counts = {};
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@ ")) current = Number(line.slice(4));
    else {
      const match = /\{ common_pid:\s*(\d+)\s*\}\s*hitcount:\s*(\d+)/.exec(line);
      if (match && tids.has(match[1])) counts[current] = (counts[current] ?? 0) + Number(match[2]);
    }
  }
  return counts;
};

spawnSync("mongosh", ["--quiet", "--eval", "db.getSiblingDB('gea_driver_benchmark').dropDatabase()"], { stdio: "ignore" });
const child = spawn(binary, [], { cwd: appRoot, stdio: ["ignore", "pipe", "inherit"] });
let before = null;
let done = false;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.startsWith("BENCH_PHASE:") || done) return;
  const name = line.slice("BENCH_PHASE:".length);
  if (name === previous) {
    sudoSh(`cd ${tracefs}; for e in ${idList}; do echo "hist:keys=common_pid" > $e/trigger; done`);
    before = snapshot(child.pid);
    console.error(`${new Date().toISOString()} armed ${ids.length} sites after ${name}`);
  } else if (name === target && before !== null) {
    setTimeout(() => {
      const after = snapshot(child.pid);
      done = true;
      const delta = {};
      for (const [id, hits] of Object.entries(after)) delta[id] = hits - (before[id] ?? 0);
      fs.writeFileSync(outFile, JSON.stringify({ target, delta }));
      console.error(`${new Date().toISOString()} wrote ${outFile}`);
      child.kill("SIGTERM");
    }, 150);
  }
});
child.on("exit", () => process.exit(0));
