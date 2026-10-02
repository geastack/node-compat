#!/usr/bin/env python3
"""Measure four native Perry cluster workers, proving all four serve connections.

Build each app's server.cluster.ts into dist/server-perry-cluster first.
The primary and four workers share CPUs 0-3; wrk uses CPUs 4-7. Default Perry
cluster scheduling (SCHED_RR) is retained. Response bytes are not normalized
into Node's framing; status, content type and decoded body must match.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--duration', default='8s')
parser.add_argument('--check-only', action='store_true')
args = parser.parse_args()
APPS = {'perry-raw': ('raw-http-hello', 3101), 'perry-hono': ('hono-hello', 3900)}
compiler = Path(shutil.which('perry')).resolve()
result = {
    'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'settings': vars(args), 'perry': subprocess.check_output(['perry', '--version'], text=True).strip(),
    'machine': subprocess.check_output(['lscpu'], text=True),
    'server_cpus': '0-3', 'load_cpus': '4-7', 'workers': 4,
    'connections': 64, 'load_threads': 4, 'scheduling': 'default SCHED_RR',
    'start_load': Path('/proc/loadavg').read_text().strip(),
    'compiler_sha256': hashlib.sha256(compiler.read_bytes()).hexdigest(),
    'sha256': {}, 'checks': [], 'samples': [], 'complete': False,
}
for app, _ in APPS.values():
    for name in ('server.ts', 'server.cluster.ts', 'dist/server-perry-cluster'):
        path = Path('apps', app, name)
        result['sha256'][str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
result['sha256']['bench/perry-cluster-http.py'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def save():
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


def children(pid):
    try:
        direct = [int(p) for p in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
    except FileNotFoundError:
        return []
    return direct + [child for p in direct for child in children(p)]


def request(port, path, method='GET', body=None, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        return {'status': response.status, 'headers': response.getheaders(), 'body': response.read().decode()}
    finally:
        conn.close()


def assert_response(response, status, body, content_type):
    headers = {k.lower(): v for k, v in response['headers']}
    if (response['status'], response['body']) != (status, body) or not headers.get('content-type', '').startswith(content_type):
        raise RuntimeError(f'Incorrect response: {response}')


def verify_workers(primary, port, expected_body):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        pids = children(primary)
        if len(pids) == 4:
            break
        time.sleep(.1)
    else:
        raise RuntimeError(f'Expected four worker processes, found {pids}')
    conns = []
    try:
        for _ in range(64):
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            conns.append(conn)
            conn.request('GET', '/')
            response = conn.getresponse()
            assert_response({'status': response.status, 'headers': response.getheaders(),
                             'body': response.read().decode()}, 200, expected_body, 'text/plain')
            if conn.sock is None:
                raise RuntimeError('Worker verification needs persistent connections')
        client_ports = {conn.sock.getsockname()[1] for conn in conns}
        inodes = {}
        for table in ('tcp', 'tcp6'):
            for line in Path(f'/proc/net/{table}').read_text().splitlines()[1:]:
                fields = line.split()
                local_port = int(fields[1].split(':')[1], 16)
                remote_port = int(fields[2].split(':')[1], 16)
                if local_port == port and remote_port in client_ports and fields[3] == '01':
                    inodes[fields[9]] = remote_port
        workers = []
        for pid in pids:
            owned = set()
            for fd in Path(f'/proc/{pid}/fd').iterdir():
                try:
                    target = os.readlink(fd)
                except FileNotFoundError:
                    continue
                match = re.fullmatch(r'socket:\[(\d+)\]', target)
                if match and match[1] in inodes:
                    owned.add(inodes[match[1]])
            status = Path(f'/proc/{pid}/status').read_text()
            cpus = re.search(r'^Cpus_allowed_list:\s*(.+)$', status, re.M).group(1)
            if not owned or cpus != '0-3':
                raise RuntimeError(f'Worker {pid}: {len(owned)} connections, CPUs {cpus}')
            workers.append({'pid': pid, 'cpus': cpus, 'verified_connections': len(owned),
                            'client_ports': sorted(owned), 'command': Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode()})
        if len({p for w in workers for p in w['client_ports']}) != 64:
            raise RuntimeError('Not every probe connection belongs to a worker')
        return {'primary_pid': primary, 'workers': workers, 'verified_connections': 64}
    finally:
        for conn in conns:
            conn.close()


def wrk(port, path, duration):
    command = ['taskset', '-c', '4-7', 'wrk', '--latency', '-t4', '-c64',
               f'-d{duration}', f'http://127.0.0.1:{port}{path}']
    run = subprocess.run(command, capture_output=True, text=True, timeout=45)
    raw = run.stdout + run.stderr
    match = re.search(r'Requests/sec:\s*([\d.]+)', raw)
    valid = bool(run.returncode == 0 and match and float(match[1]) > 0
                 and not re.search(r'(?:connect|read|write|timeout) [1-9]\d*', raw)
                 and not re.search(r'Non-2xx or 3xx responses:\s*[1-9]', raw))
    return {'command': command, 'exit': run.returncode, 'raw': raw,
            'rps': float(match[1]) if match else None, 'valid': valid}


save()
for round_no in range(1, (1 if args.check_only else args.rounds) + 1):
    names = list(APPS) if round_no % 2 else list(reversed(APPS))
    for name in names:
        app, port = APPS[name]
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError(f'Port {port} already occupied')
        command = ['taskset', '-c', '0-3', f'apps/{app}/dist/server-perry-cluster']
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        check = {'server': name, 'round': round_no, 'command': command}
        result['checks'].append(check)
        known_workers = []
        try:
            for attempt in range(150):
                if proc.poll() is not None:
                    raise RuntimeError('Primary exited before readiness')
                try:
                    request(port, '/')
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(.1)
            else:
                raise RuntimeError('Server readiness timeout')
            expected_body = 'Hello Hono!' if name == 'perry-hono' else 'Hello, World! GET /'
            check['responses'] = {path: request(port, path) for path in ('/', '/json')}
            assert_response(check['responses']['/'], 200, expected_body, 'text/plain')
            assert_response(check['responses']['/json'], 200, '{"hello":"world"}', 'application/json')
            if name == 'perry-hono':
                check['responses']['/missing'] = request(port, '/missing')
                check['responses']['/body/json'] = request(port, '/body/json', 'POST', '{"name":"cluster parity"}', {'Content-Type': 'application/json'})
                assert_response(check['responses']['/missing'], 404, '404 Not Found', 'text/plain')
                assert_response(check['responses']['/body/json'], 200, 'cluster parity', 'text/plain')
            check['worker_verification'] = verify_workers(proc.pid, port, expected_body)
            known_workers = [w['pid'] for w in check['worker_verification']['workers']]
            check['correct'] = True
            save()
            print('VERIFIED', name, [(w['pid'], w['verified_connections']) for w in check['worker_verification']['workers']], flush=True)
            if args.check_only:
                continue
            check['warmup'] = wrk(port, '/', '2s')
            if not check['warmup']['valid']:
                raise RuntimeError('Warmup failed')
            for path in (['/', '/json'] if round_no % 2 else ['/json', '/']):
                sample = {'server': name, 'round': round_no, 'workers': 4, 'path': path,
                          **wrk(port, path, args.duration)}
                result['samples'].append(sample)
                save()
                print('SAMPLE', name, round_no, path, sample['rps'], sample['valid'], flush=True)
                if not sample['valid'] or sorted(children(proc.pid)) != sorted(known_workers):
                    raise RuntimeError('Invalid sample or worker set changed during timing')
        except Exception as error:
            check['error'] = str(error)
            raise
        finally:
            remaining = set(known_workers + children(proc.pid))
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
            for pid in remaining:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                check['output'] = proc.communicate(timeout=5)[0]
            except subprocess.TimeoutExpired:
                for pid in remaining | {proc.pid}:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                check['output'] = proc.communicate()[0]
            check['exit'] = proc.returncode
            save()
result['complete'] = True
save()
