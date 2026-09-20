#!/usr/bin/env python3
"""Node wire parity and sustained raw Gea ownership checks, using normal app output."""
import argparse
import http.client
from pathlib import Path
import re
import socket
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', default='apps/raw-http-hello/dist/server')
parser.add_argument('--requests', type=int, default=101000)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent

def request(method, path, extra=b'', body=b''):
    return method + b' ' + path + b' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' + extra + b'\r\n' + body

cases = [
    request(b'GET', b'/'), request(b'GET', b'/json'),
    request(b'GET', b'/?q=one&q=two'), request(b'GET', b'/' + b'x' * 4096),
    request(b'POST', b'/echo', b'Content-Length: 5\r\n', b'hello'),
    b'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n' + request(b'GET', b'/json')]
results = []
for command in [['node', 'apps/raw-http-hello/server.node.mjs'], [args.binary]]:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', 3101))
    process = subprocess.Popen(command, cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for attempt in range(100):
            if process.poll() is not None:
                raise RuntimeError(process.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', 3101), timeout=.1):
                    break
            except OSError:
                time.sleep(.02)
        responses = []
        for wire in cases:
            with socket.create_connection(('127.0.0.1', 3101), timeout=3) as connection:
                connection.sendall(wire)
                data = b''
                while part := connection.recv(65536):
                    data += part
                responses.append(re.sub(rb'Date: [^\r]+', b'Date: normalized', data, flags=re.I))
        results.append(responses)
        if len(results) == 2:
            assert results[0] == results[1], [(i, a, b) for i, (a, b) in enumerate(zip(*results)) if a != b]
            print('Node wire parity: plain, JSON, query, long URL, POST, pipeline passed', flush=True)
            connection = http.client.HTTPConnection('127.0.0.1', 3101, timeout=3)
            samples = []
            for index in range(args.requests):
                route = '/json' if index % 2 else '/'
                connection.request('GET', route)
                response = connection.getresponse()
                assert response.status == 200
                assert response.read() == (b'{"hello":"world"}' if route == '/json' else b'Hello, World! GET /')
                assert response.getheader('Content-Type') == ('application/json; charset=utf-8' if route == '/json' else 'text/plain; charset=utf-8')
                if index in [999, args.requests // 2 - 1, args.requests - 1]:
                    rss = int(subprocess.check_output(['ps', '-o', 'rss=', '-p', str(process.pid)]))
                    samples.append((index + 1, rss))
            connection.close()
            print('RSS samples (requests, KiB):', samples, flush=True)
            assert max(rss for _, rss in samples) - min(rss for _, rss in samples) <= 256
    finally:
        process.terminate()
        process.wait(timeout=5)
