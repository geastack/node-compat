#!/usr/bin/env python3
"""Serial, rotated BSON trials. No database and no temporary files.

Run from the application's dist directory, or supply --ssh HOST --cwd DIR.
Compilation is separate: --label records its toolchain/optimization settings.
Each trial is a fresh process; JIT startup within the timed loops is included.
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import shlex
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ssh")
parser.add_argument("--cwd", default=".")
parser.add_argument("--label", required=True)
parser.add_argument("--rounds", type=int, default=3)
parser.add_argument("--output")
args = parser.parse_args()
if args.rounds < 1:
    parser.error("--rounds must be positive")
if args.ssh:
    command = "cd " + shlex.quote(args.cwd) + " && python3 - --label " + shlex.quote(args.label) + " --rounds " + str(args.rounds)
    result = subprocess.run(["ssh", args.ssh, command], input=Path(__file__).read_text(), text=True, stdout=subprocess.PIPE, check=True)
    if args.output:
        Path(args.output).write_text(result.stdout)
    else:
        print(result.stdout, end="")
    sys.exit(0)

os.chdir(args.cwd)
commands = {
    "gea": ["./benchmark-gea-bson-linux"],
    "node": ["/usr/bin/node", "../dist-node/bson-node.mjs"],
    "rust": ["./benchmark-rust/target/release/flex"],
}
shapes = [("small", 50000, 334, 335), ("string-256k", 1000, 262163, 524307), ("array-4096", 1000, 39868, 43964)]
report = {
    "label": args.label,
    "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": platform.node(), "platform": platform.platform(),
    "load_before": os.getloadavg(),
    "artifacts_sha256": {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in [
        commands["gea"][0], commands["rust"][0], "benchmark-gea-bson.cpp",
        "remote-runtime/compiler/gea_runtime.h", "remote-runtime/compiler/gea_dynamic_proxy.h",
        "remote-runtime/nodecompat/node/gea_node_buffer.hpp",
        "../dist-node/bson-node.mjs",
    ]},
    "bson_version": json.loads(Path("../dist-node/node_modules/bson/package.json").read_text())["version"],
    "node_version": subprocess.check_output(["/usr/bin/node", "--version"], text=True).strip(),
    "fresh_process_per_trial": True, "trials": [],
}
for round_index in range(args.rounds):
    order = list(commands)
    order = order[round_index % 3:] + order[:round_index % 3]
    for mode, iterations, byte_count, checksum_per_iteration in shapes:
        for driver in order:
            env = dict(os.environ, BENCH_MODE=("bson-" if driver == "rust" else "") + mode, BENCH_ITERATIONS=str(iterations))
            run = subprocess.run(["/usr/bin/time", "-f", "RESOURCE:%U,%S,%M", *commands[driver]], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if run.returncode:
                raise RuntimeError(f"{driver} {mode} exited {run.returncode}: {run.stdout} {run.stderr}")
            if driver == "rust":
                result = json.loads(next(line.removeprefix("FLEX_RESULT:") for line in run.stdout.splitlines() if line.startswith("FLEX_RESULT:")))
                encode, decode = result["milliseconds"]["encode"], result["milliseconds"]["decode"]
                actual_bytes, checksum = result["bytes"], result["checksum"]
            else:
                fields = next(line.removeprefix("BSON_RESULT:").split(",") for line in run.stdout.splitlines() if line.startswith("BSON_RESULT:"))
                encode, decode, actual_bytes, checksum = float(fields[1]), float(fields[2]), int(fields[3]), int(fields[4])
            if actual_bytes != byte_count or checksum != iterations * checksum_per_iteration:
                raise RuntimeError(f"checksum/size mismatch: {driver} {mode}: {run.stdout}")
            resource = next(line.removeprefix("RESOURCE:").split(",") for line in run.stderr.splitlines() if line.startswith("RESOURCE:"))
            trial = dict(round=round_index + 1, driver=driver, mode=mode, iterations=iterations, encode_ms=encode, decode_ms=decode,
                         bytes=actual_bytes, checksum=checksum, user_seconds=float(resource[0]), system_seconds=float(resource[1]), peak_rss_kib=int(resource[2]))
            report["trials"].append(trial)
            print(f"round {round_index + 1} {driver} {mode}: {encode:.2f}/{decode:.2f} ms", file=sys.stderr, flush=True)
report["load_after"] = os.getloadavg()
result = json.dumps(report, indent=2) + "\n"
if args.output:
    Path(args.output).write_text(result)
else:
    print(result, end="")
