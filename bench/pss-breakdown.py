#!/usr/bin/env python3
"""Break a gea server's PSS down per mapping, under the same load http-matrix.py applies.

Usage: python3 bench/pss-breakdown.py <server binary> <port> [--workers 4] [--runs 5]

Each run starts the binary pinned like http-matrix.py (0 for one worker, --server-cpus
otherwise), warms it with wrk for 2 s, loads it for --duration, then reads
/proc/<pid>/smaps for every process in the server's process group and sums Pss by
mapping: [heap], anonymous, [stack], and each mapped file. The point is to see which
part of the number moves between runs of the same binary, and which part moves between
two binaries.
"""
import argparse
import os
import re
import socket
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('binary')
parser.add_argument('port', type=int)
parser.add_argument('--workers', type=int, default=4)
parser.add_argument('--runs', type=int, default=5)
parser.add_argument('--duration', default='4s')
parser.add_argument('--server-cpus', default='0-3')
args = parser.parse_args()


def wait_for_port(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.02)
    raise SystemExit(f'port {port} never opened')


def wrk(port, path, duration):
    subprocess.run(['taskset', '-c', '4-7', 'wrk', '-t4', '-c64', '-d', duration,
                    f'http://127.0.0.1:{port}{path}'], check=True, capture_output=True)


def group_pids(group):
    pids = []
    for file in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = file.read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group:
                pids.append(int(file.parent.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return sorted(pids)


def smaps_by_mapping(pid):
    """Sum Pss (KiB) per mapping name for one process."""
    totals = defaultdict(int)
    name = None
    for line in Path(f'/proc/{pid}/smaps').read_text().splitlines():
        header = re.match(r'^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$', line)
        if header:
            name = header[1] or '[anon]'
            continue
        pss = re.match(r'^Pss:\s+(\d+) kB', line)
        if pss:
            totals[name] += int(pss[1])
    return totals


def category(name):
    if name in ('[heap]', '[anon]', '[stack]', '[vdso]', '[vvar]', '[vsyscall]'):
        return name
    if name.startswith('/'):
        return os.path.basename(name)
    return name


def measure():
    env = os.environ.copy()
    env['GEA_WORKERS'] = str(args.workers)
    cpus = '0' if args.workers == 1 else args.server_cpus
    proc = subprocess.Popen(['taskset', '-c', cpus, args.binary], env=env,
                            start_new_session=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_port(args.port)
        wrk(args.port, '/', '2s')
        wrk(args.port, '/', args.duration)
        per_process = {}
        for pid in group_pids(proc.pid):
            per_process[pid] = smaps_by_mapping(pid)
        return per_process
    finally:
        subprocess.run(['kill', '-TERM', '--', f'-{proc.pid}'], capture_output=True)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            subprocess.run(['kill', '-KILL', '--', f'-{proc.pid}'], capture_output=True)
        time.sleep(0.2)


print(f'binary={args.binary} workers={args.workers} runs={args.runs}')
for run in range(1, args.runs + 1):
    per_process = measure()
    by_category = defaultdict(int)
    process_totals = []
    for pid, totals in per_process.items():
        process_totals.append(sum(totals.values()))
        for name, kib in totals.items():
            by_category[category(name)] += kib
    total = sum(by_category.values())
    top = sorted(by_category.items(), key=lambda item: -item[1])
    parts = ' '.join(f'{name}={kib}' for name, kib in top if kib >= 32)
    print(f'run={run} total_pss_kib={total} per_process={process_totals} {parts}', flush=True)
