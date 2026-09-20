#!/usr/bin/env bash
# Benchmark: the SAME real node:http app, compiled to a native binary by geatsc
# vs. run under Node.js. Requires `wrk` and `node` on PATH.
#
#   1. build the native binary:  node ../../scripts/build.mjs server.ts
#   2. run this script:          bash bench.sh
#
# Both are single-threaded event-loop HTTP servers on the port `server.ts` and
# `server.node.mjs` both listen on; we bench each in isolation (start -> warmup
# -> measure -> stop) on GET / and GET /json. The port is read from the source
# rather than restated here: a second spelling of it silently benched nothing
# (wrk against a closed port reports zero requests and no error worth grepping).
set -euo pipefail
cd "$(dirname "$0")"
PORT=$(grep -oE 'server\.listen\(([0-9]+)' server.ts | grep -oE '[0-9]+')
URL="http://127.0.0.1:$PORT"

bench_one() { # $1 label  $2 start-command
  eval "$2 >/dev/null 2>&1 &"
  local pid=$!
  # Prove the server actually answers before benching it. `wrk` against a port
  # nothing listens on prints a perfectly ordinary report with 0 requests, so
  # without this a server that failed to start is reported as a slow one.
  local ready=0
  for _ in $(seq 1 50); do
    if curl -fsS -o /dev/null --max-time 1 "$URL/"; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" -ne 1 ]; then
    echo "FAIL: $1 did not answer on $URL within 10s" >&2
    kill "$pid" 2>/dev/null || true
    return 1
  fi
  wrk -t2 -c32 -d3s "$URL/" >/dev/null 2>&1 || true       # warmup
  echo "=========== $1 ==========="
  for path in / /json; do
    echo "--- GET $path (4 threads, 64 conns, 10s) ---"
    wrk -t4 -c64 -d10s "$URL$path" 2>&1 | grep -E "Requests/sec|Latency |Transfer/sec|Socket errors" || true
  done
  local rss; rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
  echo "RSS (idle-after-load): $((rss/1024)) MB"
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; sleep 0.5
}

bench_one "geatsc-native ($(ls -la dist/server | awk '{printf "%.2f MB binary", $5/1048576}'))" "./dist/server"
bench_one "node.js $(node --version)" "node server.node.mjs"
