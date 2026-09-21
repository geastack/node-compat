#!/usr/bin/env bash
# Same shape as bench/http-matrix.py: server on CPU 0 (1 worker) or 0-3 (4 workers),
# wrk on CPUs 4-7, -t4 -c64, 2 s warm-up then an 8 s sample, three rounds, both paths.
set -u
BIN="$1"; WORKERS="$2"; LABEL="$3"
CPUS=0; [ "$WORKERS" = 4 ] && CPUS=0-3
for round in 1 2 3; do
  for path in / /json; do
    pids=()
    for i in $(seq 1 "$WORKERS"); do taskset -c $CPUS "$BIN" >/dev/null 2>&1 & pids+=($!); done
    for i in $(seq 1 40); do curl -s -o /dev/null --max-time 1 http://127.0.0.1:3101/ && break; sleep 0.25; done
    taskset -c 4-7 wrk -t4 -c64 -d2s "http://127.0.0.1:3101$path" >/dev/null 2>&1
    out=$(taskset -c 4-7 wrk -t4 -c64 -d8s --latency "http://127.0.0.1:3101$path" 2>/dev/null)
    rps=$(echo "$out" | awk "/Requests\/sec/{print \$2}")
    p50=$(echo "$out" | awk "/ 50%/{print \$2}"); p99=$(echo "$out" | awk "/ 99%/{print \$2}")
    rss=0; for p in "${pids[@]}"; do r=$(awk "/VmHWM/{print \$2}" /proc/$p/status 2>/dev/null); rss=$((rss + ${r:-0})); done
    kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null
    printf "round=%s %-14s workers=%s path=%-5s rps=%10s p50=%-8s p99=%-8s rss_kib=%s\n" "$round" "$LABEL" "$WORKERS" "$path" "$rps" "$p50" "$p99" "$rss"
    sleep 0.5
  done
done
