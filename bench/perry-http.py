#!/usr/bin/env python3
"""Validate prebuilt Perry apps, then benchmark only correct Hono servers.

Run on the Linux bench box from node-compat with Node 24 and Perry on PATH.
Compile the unchanged apps into their existing dist directories first.
The 38-case raw HTTP battery is distinct from the Hono application checks.
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
parser.add_argument('--binary-name', default='server-perry')
parser.add_argument('--hono-entry', default='apps/hono-hello/server.ts', help='Source used for the Perry Hono binary')
parser.add_argument('--skip-parity', action='store_true', help='Reuse a separately recorded parity run')
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--duration', default='8s')
parser.add_argument('--skip-bench', action='store_true', help='Only run correctness checks')
args = parser.parse_args()
result = {
    'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'settings': vars(args),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'perry': subprocess.check_output(['perry', '--version'], text=True).strip(),
    'machine': subprocess.check_output(['lscpu'], text=True),
    'start_load': Path('/proc/loadavg').read_text().strip(),
    'server_cpus': '0', 'load_cpus': '4-7', 'connections': 64,
    'load_threads': 4, 'sha256': {}, 'hono': [], 'samples': []
}
compiler = Path(shutil.which('perry')).resolve()
result['compiler_path'] = str(compiler)
result['compiler_sha256'] = hashlib.sha256(compiler.read_bytes()).hexdigest()
result['packages'] = {
    package: json.loads(Path(f'apps/hono-hello/node_modules/{package}/package.json').read_text())['version']
    for package in ('hono', '@hono/node-server')
}
for app in ('http-parity', 'hono-hello'):
    for name in ('server.ts', f'dist/{args.binary_name}', 'package.json'):
        path = Path(f'apps/{app}/{name}')
        if path.is_file():
            result['sha256'][str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
for name in ('apps/http-parity/driver.mjs', 'bench/perry-http.py', args.hono_entry):
    result['sha256'][name] = hashlib.sha256(Path(name).read_bytes()).hexdigest()


def save():
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


def port_free(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) != 0


def stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        return proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        return proc.communicate()[0]


def request(path, method='GET', body=None, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', 3900, timeout=2)
    try:
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        return {'status': response.status, 'headers': response.getheaders(),
                'body': response.read().decode()}
    finally:
        conn.close()


def wrk(path, duration):
    cmd = ['taskset', '-c', '4-7', 'wrk', '--latency', '-t4', '-c64',
           f'-d{duration}', f'http://127.0.0.1:3900{path}']
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    raw = run.stdout + run.stderr
    match = re.search(r'Requests/sec:\s*([\d.]+)', raw)
    valid = run.returncode == 0 and match and float(match[1]) > 0
    valid = valid and not re.search(r'(?:connect|read|write|timeout) [1-9]\d*', raw)
    valid = valid and not re.search(r'Non-2xx or 3xx responses:\s*[1-9]', raw)
    return {'command': cmd, 'exit': run.returncode, 'raw': raw,
            'valid': bool(valid), 'rps': float(match[1]) if match else None}


save()
parity_binary = Path(f'apps/http-parity/dist/{args.binary_name}')
if args.skip_parity:
    result['parity'] = {'status': 'skipped', 'reason': 'See separately recorded 38-case run'}
elif not parity_binary.is_file():
    result['parity'] = {'status': 'blocked', 'reason': 'No compiled parity binary; build failed'}
else:
    if not port_free(3000):
        raise RuntimeError('Port 3000 already occupied')
    # Preflight captures startup errors the unchanged driver deliberately hides.
    proc = subprocess.Popen([str(parity_binary)], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    ready = False
    for _ in range(150):
        if proc.poll() is not None:
            break
        if not port_free(3000):
            ready = True
            break
        time.sleep(.1)
    log = stop(proc)
    if not ready:
        result['parity'] = {'status': 'blocked', 'reason': 'Server did not listen',
                            'output': log, 'exit': proc.returncode}
    else:
        driver = subprocess.Popen(['node', 'apps/http-parity/driver.mjs', str(parity_binary),
                                   'apps/http-parity/server.ts'], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            output = driver.communicate(timeout=240)[0]
            result['parity'] = {'status': 'completed' if '38 parity' in output else 'incomplete',
                                'exit': driver.returncode, 'output': output}
        except subprocess.TimeoutExpired:
            result['parity'] = {'status': 'incomplete', 'reason': '240-second driver timeout',
                                'output': stop(driver)}
        finally:
            stop(driver)
print('PARITY', json.dumps(result['parity']), flush=True)
save()

servers = {
    'perry': [f'apps/hono-hello/dist/{args.binary_name}'],
    'node': ['node', 'apps/hono-hello/server.ts']
}
disabled = set()
for round_no in range(1, (1 if args.skip_bench else args.rounds) + 1):
    names = list(servers) if round_no % 2 else list(reversed(servers))
    for name in names:
        if name in disabled:
            continue
        if not port_free(3900):
            raise RuntimeError('Port 3900 already occupied')
        check = {'server': name, 'round': round_no}
        result['hono'].append(check)
        started = time.monotonic()
        proc = subprocess.Popen(['taskset', '-c', '0', *servers[name]],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            while time.monotonic() - started < 15:
                if proc.poll() is not None:
                    raise RuntimeError(f'Server exited before listening: {proc.returncode}')
                try:
                    root = request('/')
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(.1)
            else:
                raise RuntimeError('Server did not listen within 15 seconds')
            check['startup_ms'] = (time.monotonic() - started) * 1000
            check['responses'] = {
                '/': root, '/json': request('/json'), '/missing': request('/missing'),
                '/body/json': request('/body/json', 'POST', '{"name":"Perry parity"}',
                                      {'Content-Type': 'application/json'})
            }
            expected = {'/': (200, 'Hello Hono!'), '/json': (200, '{"hello":"world"}'),
                        '/missing': (404, '404 Not Found'), '/body/json': (200, 'Perry parity')}
            for path, (status, body) in expected.items():
                response = check['responses'][path]
                if (response['status'], response['body']) != (status, body):
                    raise RuntimeError(f'Incorrect response for {path}: {response}')
                content_type = dict((key.lower(), value) for key, value in response['headers']).get('content-type', '')
                expected_type = 'application/json' if path == '/json' else 'text/plain'
                if not content_type.lower().startswith(expected_type):
                    raise RuntimeError(f'Incorrect content-type for {path}: {content_type}')
            check['correct'] = True
            if args.skip_bench:
                continue
            check['warmup'] = wrk('/', '2s')
            if not check['warmup']['valid']:
                raise RuntimeError('wrk warmup failed')
            for path in (['/', '/json'] if round_no % 2 else ['/json', '/']):
                sample = {'server': name, 'round': round_no, 'path': path}
                sample.update(wrk(path, args.duration))
                sample['memory'] = Path(f'/proc/{proc.pid}/smaps_rollup').read_text()
                result['samples'].append(sample)
                print('SAMPLE', name, round_no, path, sample['rps'], sample['valid'], flush=True)
                save()
                if not sample['valid']:
                    raise RuntimeError('wrk measurement failed')
        except Exception as error:
            check['error'] = str(error)
            disabled.add(name)
            print('BLOCKED', name, str(error), flush=True)
        finally:
            check['output'] = stop(proc)
            check['exit'] = proc.returncode
            save()
result['complete'] = True
save()
