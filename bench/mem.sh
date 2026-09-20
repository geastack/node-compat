#!/usr/bin/env bash
# Compatibility entry point for an eight-worker RSS/PSS sample under load.
# The current harness records peak process-group RSS and PSS around each route.
set -euo pipefail

cd "$(dirname "$0")/.."
RESULT=${RESULT:-bench/results/http-local-memory.json}
ROUNDS=${ROUNDS:-1}
DURATION=${DURATION:-10s}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  exec python3 bench/http-matrix.py --help
fi

python3 bench/http-matrix.py \
  --output "$RESULT" \
  --rounds "$ROUNDS" \
  --duration "$DURATION" \
  --workers 8 \
  "$@"
python3 bench/summarize-http-matrix.py "$RESULT"
