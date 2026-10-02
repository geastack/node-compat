#!/usr/bin/env python3
"""Diagnostic CPU profiles of the already-built Perry Hono and raw HTTP apps.

This deliberately keeps profiler runs separate from published throughput runs.
Requires Linux perf and wrk; run from node-compat on the benchmark host.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
output = Path('bench/results/perry-0.5.1520-profiles-2026-09-23.json')
result = {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'server_cpus': '0', 'load_cpus': '4-7', 'connections': 64,
          'purpose': 'diagnosis, not replacement benchmark numbers', 'profiles': []}


def save():
    output.write_text(json.dumps(result, indent=2) + '\n')


def wrk(port, duration):
    return ['taskset', '-c', '4-7', 'wrk', '--latency', '-t4', '-c64',
            f'-d{duration}s', f'http://127.0.0.1:{port}/']


for app, port, expected in [('hono-hello', 3900, b'Hello Hono!'),
                            ('raw-http-hello', 3101, b'Hello, World! GET /')]:
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise RuntimeError(f'Port {port} occupied')
    binary = Path('apps', app, 'dist/server-perry-source')
    data = Path('apps', app, 'dist/perry-profile.data')
    item = {'app': app, 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    result['profiles'].append(item)
    proc = subprocess.Popen(['taskset', '-c', '0', str(binary)], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        for attempt in range(150):
            if proc.poll() is not None:
                raise RuntimeError('Server exited')
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                conn.request('GET', '/')
                response = conn.getresponse()
                if response.status != 200 or response.read() != expected:
                    raise RuntimeError('Incorrect response')
                break
            except (OSError, http.client.HTTPException):
                time.sleep(.1)
            finally:
                conn.close()
        else:
            raise RuntimeError('Readiness timeout')
        subprocess.run(wrk(port, 2), capture_output=True, text=True, timeout=10, check=True)
        for kind in ('stat', 'record'):
            load = subprocess.Popen(wrk(port, 8), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                if kind == 'stat':
                    command = ['perf', 'stat', '-p', str(proc.pid), '-e',
                               'task-clock,cycles:u,instructions:u,context-switches,cpu-migrations,page-faults', '--', 'sleep', '6']
                else:
                    command = ['perf', 'record', '-F', '199', '-e', 'cycles:u',
                               '--call-graph', 'dwarf,8192', '-p', str(proc.pid), '-o', str(data), '--', 'sleep', '6']
                run = subprocess.run(command, capture_output=True, text=True, timeout=20)
                item[kind] = {'command': command, 'exit': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr}
                if run.returncode:
                    raise RuntimeError(f'perf {kind}: {run.stderr}')
            finally:
                item[kind + '_load'] = load.communicate(timeout=15)[0]
            save()
        for kind, extra in [('flat', ['--no-children']), ('stacks', ['--children', '-g', 'graph,0.5,caller'])]:
            command = ['perf', 'report', '-i', str(data), '--stdio', '--percent-limit', '0.5', *extra]
            report = subprocess.run(command, capture_output=True, text=True, timeout=30)
            item[kind] = report.stdout
            item[kind + '_errors'] = report.stderr
        print(app, item['stat']['stderr'], item['flat'][:18000], flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            item['server_output'] = proc.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            item['server_output'] = proc.communicate()[0]
        save()
result['complete'] = True
save()
