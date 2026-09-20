#!/usr/bin/env python3
"""Linux HTTP comparison. Run from node-compat; results retain every wrk sample.

Generated Gea sources must come from the shared compiler/dist. Native binaries
live in the apps' normal dist directories. No private compiler build is used.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
parser.add_argument('--rounds', type=int, default=2)
parser.add_argument('--duration', default='8s')
parser.add_argument('--servers', nargs='+', default=[
    'hono-gea', 'hono-node', 'gea-raw', 'node-raw',
    'cpp-drogon', 'rust-axum', 'rust-hyper', 'cpp-epoll'])
parser.add_argument('--workers', nargs='+', type=int, default=[1, 8])
# `dist` is the historical build; `dist` is what `scripts/build.mjs` writes today.
parser.add_argument('--gea-dist', default='dist')
parser.add_argument('--startup-only', action='store_true',
                    help='validate readiness/wire behavior and record startup without wrk')
parser.add_argument('--server-cpus', default=None,
                    help='taskset list for multi-worker servers (default 0-7). This box has 4 '
                         'physical cores with siblings 0-1, 2-3, 4-5, 6-7 and wrk pinned to 4-7, '
                         'so the default overlaps the load generator and measures a saturated '
                         'host. Pass 0-3 to give the server two physical cores the load '
                         'generator does not touch.')
args = parser.parse_args()


def command(name, workers):
    env = os.environ.copy()
    for key in ('SINGLE_THREAD', 'GEA_WORKERS', 'CPP_WORKERS',
                'NODE_WORKERS', 'DROGON_THREADS', 'TOKIO_WORKER_THREADS'):
        env.pop(key, None)
    if name in ('hono-gea', 'gea-raw'):
        app = 'hono-hello' if name == 'hono-gea' else 'raw-http-hello'
        cmd = [f'apps/{app}/{args.gea_dist}/server']
        env['GEA_WORKERS'] = str(workers)
    elif name in ('hono-node', 'node-raw'):
        app = 'hono-hello' if name == 'hono-node' else 'raw-http-hello'
        entry = 'server' if workers == 1 else 'cluster'
        cmd = ['node', f'apps/{app}/{entry}.node.mjs']
        env['NODE_WORKERS'] = str(workers)
    elif name.startswith('rust-'):
        binary = 'rust-http-hello' if name == 'rust-hyper' else 'axum-http-hello'
        cmd = [f'apps/raw-http-hello/rust-server/target/release/{binary}']
        if workers == 1:
            env['SINGLE_THREAD'] = '1'
        else:
            env['TOKIO_WORKER_THREADS'] = str(workers)
    else:
        cmd = [f'apps/raw-http-hello/dist/{name}']
        env['DROGON_THREADS' if name == 'cpp-drogon' else 'CPP_WORKERS'] = str(workers)
    cpus = '0' if workers == 1 else (args.server_cpus or '0-7')
    return ['taskset', '-c', cpus, *cmd], env


def hono_gea_port():
    source = Path('apps/hono-hello/server.ts').read_text()
    match = re.search(r'port:\s*(\d+)', source)
    return int(match[1]) if match else 3000


def port_free(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) != 0


def request(port, path):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        conn.request('GET', path)
        response = conn.getresponse()
        return response.status, response.getheader('content-type', ''), response.read().decode()
    finally:
        conn.close()


def raw_wire_response(port, path):
    wire = (f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n').encode()
    with socket.create_connection(('127.0.0.1', port), timeout=2) as conn:
        conn.settimeout(2)
        conn.sendall(wire)
        data = b''
        while b'\r\n\r\n' not in data:
            part = conn.recv(65536)
            if not part:
                raise RuntimeError(f'{path}: connection closed before response headers')
            data += part
        head, body = data.split(b'\r\n\r\n', 1)
        lines = head.split(b'\r\n')
        headers = {}
        for line in lines[1:]:
            name, value = line.split(b':', 1)
            headers.setdefault(name.decode().lower(), []).append(value.strip().decode())
        if headers.get('transfer-encoding') == ['chunked']:
            while b'\r\n0\r\n\r\n' not in body:
                part = conn.recv(65536)
                if not part:
                    raise RuntimeError(f'{path}: connection closed before final chunk')
                body += part
        elif 'content-length' in headers:
            length = int(headers['content-length'][0])
            while len(body) < length:
                part = conn.recv(65536)
                if not part:
                    raise RuntimeError(f'{path}: connection closed before content-length body')
                body += part
        else:
            raise RuntimeError(f'no response framing for {path}: {head!r}')
    return lines[0].decode(), headers, body, head + b'\r\n\r\n' + body


def validate_raw_wire(port, path):
    status, headers, encoded_body, raw = raw_wire_response(port, path)
    expected_type = ('application/json; charset=utf-8' if path == '/json'
                     else 'text/plain; charset=utf-8')
    expected_body = (b'{"hello":"world"}' if path == '/json'
                     else b'Hello, World! GET /')
    expected_headers = {
        'content-type': [expected_type],
        'connection': ['keep-alive'],
        'keep-alive': ['timeout=5'],
        'transfer-encoding': ['chunked'],
    }
    if status != 'HTTP/1.1 200 OK':
        raise RuntimeError(f'{path}: wrong status line: {status!r}')
    if set(headers) != {*expected_headers, 'date'}:
        raise RuntimeError(f'{path}: wrong header set: {headers!r}')
    for name, expected in expected_headers.items():
        if headers.get(name) != expected:
            raise RuntimeError(f'{path}: wrong {name}: {headers.get(name)!r}')
    date = headers['date']
    if len(date) != 1 or not re.fullmatch(
            r'[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT', date[0]):
        raise RuntimeError(f'{path}: wrong date: {date!r}')
    chunks = []
    remaining = encoded_body
    while True:
        marker = remaining.find(b'\r\n')
        if marker < 0:
            raise RuntimeError(f'{path}: malformed chunk size: {remaining!r}')
        size = int(remaining[:marker], 16)
        remaining = remaining[marker + 2:]
        if size == 0:
            if remaining != b'\r\n':
                raise RuntimeError(f'{path}: chunk trailers are not empty: {remaining!r}')
            break
        chunk, ending, remaining = remaining[:size], remaining[size:size + 2], remaining[size + 2:]
        if ending != b'\r\n':
            raise RuntimeError(f'{path}: malformed chunk ending')
        chunks.append(chunk)
    if chunks != [expected_body]:
        raise RuntimeError(f'{path}: wrong chunks: {chunks!r}')
    expected_bytes = 206 if path == '/json' else 202
    if len(raw) != expected_bytes:
        raise RuntimeError(f'{path}: expected {expected_bytes} wire bytes, got {len(raw)}')
    return {'path': path, 'bytes': len(raw), 'headers': headers,
            'body_sha256': hashlib.sha256(expected_body).hexdigest()}


def process_memory(group):
    members = []
    for file in Path('/proc').glob('[0-9]*/stat'):
        try:
            # comm can contain spaces; pgrp is field 5 (third after comm).
            fields = file.read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group:
                continue
            values = dict(re.findall(r'^(Rss|Pss):\s+(\d+)',
                          (file.parent / 'smaps_rollup').read_text(), re.M))
            members.append({'pid': int(file.parent.name),
                            'rss_kib': int(values.get('Rss', 0)),
                            'pss_kib': int(values.get('Pss', 0))})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return {'rss_kib': sum(p['rss_kib'] for p in members),
            'pss_kib': sum(p['pss_kib'] for p in members), 'processes': members}


def stop(proc, port):
    # start_new_session owns this entire group, including fork/cluster workers.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    for _ in range(50):
        if port_free(port):
            return
        time.sleep(.1)
    raise RuntimeError(f'Port {port} still occupied after stopping group {proc.pid}')


def wrk(port, path, duration, warmup=False):
    cmd = ['taskset', '-c', '4-7', 'wrk', '--latency', '-t4', '-c64',
           f'-d{duration}', f'http://127.0.0.1:{port}{path}']
    output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
    if re.search(r'(?:connect|read|write|timeout) [1-9]\d*', output) or \
            re.search(r'Non-2xx or 3xx responses:\s*[1-9]', output):
        raise RuntimeError(output)
    if warmup:
        return output
    rps = re.search(r'Requests/sec:\s*([\d.]+)', output)
    if not rps or float(rps[1]) <= 0:
        raise RuntimeError(output)
    return {'rps': float(rps[1]), 'raw': output,
            'latency': dict(re.findall(r'^\s+(50%|90%|99%)\s+(\S+)', output, re.M))}


# The gea rows run out of --gea-dist (see `command`), so the recorded hashes
# have to follow it. Spelling `dist/` here while the run served `dist/`
# made the provenance block describe binaries that were never measured, which
# is worse than recording nothing. The C++ controls are always built into
# `dist/` and are named literally.
artifacts = [
    f'apps/hono-hello/{args.gea_dist}/server', f'apps/hono-hello/{args.gea_dist}/server.cpp',
    f'apps/hono-hello/{args.gea_dist}/gea_runtime.h', f'apps/raw-http-hello/{args.gea_dist}/server',
    f'apps/raw-http-hello/{args.gea_dist}/server.cpp', f'apps/raw-http-hello/{args.gea_dist}/gea_runtime.h',
    'apps/raw-http-hello/dist/cpp-drogon', 'apps/raw-http-hello/dist/cpp-epoll',
    'runtime/gea_node.cpp', 'runtime/gea_node.hpp',
    'apps/hono-hello/server.node.mjs', 'apps/hono-hello/cluster.node.mjs',
    'apps/hono-hello/node_modules/hono/package.json',
    'apps/raw-http-hello/server.node.mjs', 'apps/raw-http-hello/cluster.node.mjs',
    'apps/raw-http-hello/rust-server/target/release/rust-http-hello',
    'apps/raw-http-hello/rust-server/target/release/axum-http-hello',
    'apps/raw-http-hello/rust-server/src/main.rs',
    'apps/raw-http-hello/rust-server/src/bin/axum-http-hello.rs',
    'apps/raw-http-hello/cpp-server/server.cpp',
    'apps/raw-http-hello/drogon-server/main.cc',
    'apps/raw-http-hello/rust-server/Cargo.lock', 'bench/http-matrix.py']
result = {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'settings': vars(args), 'server_cpus': {'1': '0', 'multi': args.server_cpus or '0-7'},
          'load_cpus': '4-7', 'connections': 64, 'load_threads': 4,
          'caveat': 'Eight-worker servers and wrk share CPUs; loopback throughput is host-limited.',
          'machine': subprocess.check_output(['lscpu'], text=True),
          'node': subprocess.check_output(['node', '--version'], text=True).strip(),
          'start_load': Path('/proc/loadavg').read_text().strip(),
          'sha256': {p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
                     for p in artifacts if Path(p).exists()}, 'wire_contract': [],
          'startups': [], 'samples': []}


def save():
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


save()
for round_no in range(1, args.rounds + 1):
    cases = [(name, workers) for name in args.servers for workers in args.workers]
    if round_no % 2 == 0:
        cases.reverse()
    for name, workers in cases:
        # Each entry fixes its own port in source: the gea hono app moved to
        # 3900 (port 3000 is taken on the developer Mac), the node entry kept
        # 3000, raw-http-hello listens on 3101.
        port = hono_gea_port() if name == 'hono-gea' else 3000 if name == 'hono-node' else 3101
        if not port_free(port):
            raise RuntimeError(f'Port {port} occupied before {name}')
        cmd, env = command(name, workers)
        started = time.monotonic()
        proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            expected = 'Hello Hono!' if name.startswith('hono-') else 'Hello, World! GET /'
            for attempt in range(1000):
                if proc.poll() is not None:
                    raise RuntimeError(f'{name} exited: {proc.stdout.read()}')
                try:
                    status, content_type, body = request(port, '/')
                    if status != 200 or body != expected or not content_type.startswith('text/plain'):
                        raise RuntimeError(f'{name} wrong root: {status} {content_type} {body}')
                    startup_ms = (time.monotonic() - started) * 1000
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(.005)
            else:
                raise RuntimeError(f'{name} not ready')
            result['startups'].append({'round': round_no, 'server': name,
                                       'workers': workers, 'milliseconds': startup_ms})
            status, content_type, body = request(port, '/json')
            if status != 200 or body != '{"hello":"world"}' or not content_type.startswith('application/json'):
                raise RuntimeError(f'{name} wrong JSON: {status} {content_type} {body}')
            if name.startswith('hono-') and request(port, '/missing')[0] != 404:
                raise RuntimeError(f'{name} wrong missing-route status')
            if not name.startswith('hono-'):
                for path in ('/', '/json'):
                    contract = validate_raw_wire(port, path)
                    contract.update({'server': name, 'workers': workers})
                    result['wire_contract'].append(contract)
                save()
            if args.startup_only:
                save()
                continue
            # Let all cluster/fork workers finish startup before warming up.
            time.sleep(1)
            before = process_memory(proc.pid)
            expected_processes = workers + (1 if name.endswith('node') or name == 'node-raw' else 0)
            if workers > 1 and name in ('hono-gea', 'gea-raw', 'hono-node', 'node-raw', 'cpp-epoll'):
                if len(before['processes']) != expected_processes:
                    raise RuntimeError(f'{name}: expected {expected_processes} processes, got {before}')
            wrk(port, '/', '2s', warmup=True)
            for path in (['/', '/json'] if round_no % 2 else ['/json', '/']):
                sample = {'round': round_no, 'server': name, 'workers': workers, 'path': path,
                          'memory_before': process_memory(proc.pid),
                          'load_before': Path('/proc/loadavg').read_text().strip()}
                sample.update(wrk(port, path, args.duration))
                sample['memory_after'] = process_memory(proc.pid)
                sample['load_after'] = Path('/proc/loadavg').read_text().strip()
                result['samples'].append(sample)
                save()
                print(f"round={round_no} {name:12} workers={workers} path={path:5} "
                      f"rps={sample['rps']:10.2f} rss_kib={sample['memory_after']['rss_kib']}", flush=True)
        except Exception as error:
            result['error'] = str(error)
            save()
            raise
        finally:
            stop(proc, port)
            proc.stdout.close()
        time.sleep(.5)
result['complete'] = True
save()
