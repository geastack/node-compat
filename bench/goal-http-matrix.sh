#!/usr/bin/env bash
# Compatibility entry point for the current equal-wire HTTP matrix.
# Pass the same arguments accepted by bench/http-matrix.py, including --output.
set -euo pipefail

cd "$(dirname "$0")/.."
if (( $# == 0 )); then
  set -- \
    --output bench/results/http-local.json \
    --rounds 2 \
    --duration 6s \
    --workers 1 8
fi
exec python3 bench/http-matrix.py "$@"
