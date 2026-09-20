#!/usr/bin/env bash
# Compatibility entry point for a one-worker current HTTP matrix.
set -euo pipefail

cd "$(dirname "$0")/.."
RESULT=${RESULT:-bench/results/http-local-single.json}
ROUNDS=${ROUNDS:-3}
DURATION=${DURATION:-10s}
exec python3 bench/http-matrix.py \
  --output "$RESULT" \
  --rounds "$ROUNDS" \
  --duration "$DURATION" \
  --workers 1 \
  "$@"
