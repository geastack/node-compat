#!/usr/bin/env python3
"""Measure the unchanged raw HTTP app with Perry and Node on one logical CPU.

Unlike http-matrix.py's identical-wire comparison, this records wire differences
and requires matching status, content type and decoded body before timing.
Run from a Linux node-compat checkout with the prebuilt Perry binary and Node 24.
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
args = parser.parse_args()
entry = 'apps/raw-http-hello/server.ts'
binary = 'apps/raw-http-hello/dist/server-perry-source'
compiler = Path(shutil.which('perry')).resolve()
result = {
    'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'settings': vars(args), 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'perry': subprocess.check_output(['perry', '--version'], text=True).strip(),
    'machine': subprocess.check_output(['lscpu'], text=True),
    'server_cpus': '0', 'load_cpus': '4-7', 'connections': 64, 'load_threads': 4,
    'start_load': Path('/proc/loadavg').read_text().strip(),
    'sha256': {p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
               for p in (entry, binary, 'bench/perry-raw-http.py')},
    'compiler_sha256': hashlib.sha256(compiler.read_bytes()).hexdigest(),
    'validation': 'status, content type and decoded body; wire recorded separately',
    'checks': [], 'samples': [], 'complete': False,
}


def save():
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


def request(path):
    conn = http.client.HTTPConnection('127.0.0.1', 3101, timeout=2)
    try:
        conn.request('GET', path)
        response = conn.getresponse()
        return {'status': response.status, 'headers': response.getheaders(),
                'body': response.read().decode()}
    finally:
        conn.close()


def wire(path):
    with socket.create_connection(('127.0.0.1', 3101), timeout=2) as conn:
        conn.sendall(f'GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'.encode())
        chunks = []
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return b''.join(chunks).decode()
            chunks.append(chunk)


def wrk(path, duration):
    command = ['taskset', '-c', '4-7', 'wrk', '--latency', '-t4', '-c64',
               f'-d{duration}', f'http://127.0.0.1:3101{path}']
    run = subprocess.run(command, capture_output=True, text=True, timeout=45)
    raw = run.stdout + run.stderr
    match = re.search(r'Requests/sec:\s*([\d.]+)', raw)
    valid = bool(run.returncode == 0 and match and float(match[1]) > 0
                 and not re.search(r'(?:connect|read|write|timeout) [1-9]\d*', raw)
                 and not re.search(r'Non-2xx or 3xx responses:\s*[1-9]', raw))
    sample = {'command': command, 'exit': run.returncode, 'raw': raw,
              'rps': float(match[1]) if match else None, 'valid': valid}
    return sample


save()
for round_no in range(1, args.rounds + 1):
    for name in (['perry', 'node'] if round_no % 2 else ['node', 'perry']):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', 3101)) == 0:
                raise RuntimeError('Port 3101 already occupied')
        command = ['taskset', '-c', '0', *([binary] if name == 'perry' else ['node', entry])]
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        check = {'server': name, 'round': round_no, 'command': command}
        result['checks'].append(check)
        try:
            for attempt in range(150):
                if proc.poll() is not None:
                    raise RuntimeError('Server exited before readiness')
                try:
                    request('/')
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(.1)
            else:
                raise RuntimeError('Server readiness timeout')
            check['responses'] = {path: request(path) for path in ('/', '/json')}
            for path, response in check['responses'].items():
                body = 'Hello, World! GET /' if path == '/' else '{"hello":"world"}'
                content_type = ('text/plain' if path == '/' else 'application/json') + '; charset=utf-8'
                headers = {k.lower(): v for k, v in response['headers']}
                if (response['status'], response['body'], headers.get('content-type')) != (200, body, content_type):
                    raise RuntimeError(f'Incorrect {path}: {response}')
            check['wire'] = {path: wire(path) for path in ('/', '/json')}
            check['correct'] = True
            check['warmup'] = wrk('/', '2s')
            if not check['warmup']['valid']:
                raise RuntimeError('Warmup failed')
            for path in (['/', '/json'] if round_no % 2 else ['/json', '/']):
                sample = {'server': name, 'round': round_no, 'workers': 1, 'path': path,
                          **wrk(path, args.duration)}
                result['samples'].append(sample)
                save()
                print(name, round_no, path, sample['rps'], sample['valid'], flush=True)
                if not sample['valid']:
                    raise RuntimeError('Invalid wrk sample')
        except Exception as error:
            check['error'] = str(error)
            raise
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                check['output'] = proc.communicate(timeout=5)[0]
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                check['output'] = proc.communicate()[0]
            check['exit'] = proc.returncode
            save()
result['complete'] = True
save()
