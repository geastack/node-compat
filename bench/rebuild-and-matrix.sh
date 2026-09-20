#!/usr/bin/env bash
# Build every current HTTP control, run the complete equal-wire matrix, measure
# startup separately, and print the combined Markdown table.
#
# @geastack/compiler must already be built (npm run build in that package).
#
# Optional environment variables:
#   CXX             C++ compiler (default: g++)
#   CARGO           Cargo executable (default: cargo)
#   ROUNDS          throughput rounds (default: 2)
#   DURATION        wrk duration per route (default: 6s)
#   STARTUP_ROUNDS  fresh launches per configuration (default: 5)
#   RESULT          throughput/RAM JSON path
#   STARTUP_RESULT  startup JSON path
set -euo pipefail

cd "$(dirname "$0")/.."

ROUNDS=${ROUNDS:-2}
DURATION=${DURATION:-6s}
STARTUP_ROUNDS=${STARTUP_ROUNDS:-5}
RESULT=${RESULT:-bench/results/http-local.json}
STARTUP_RESULT=${STARTUP_RESULT:-bench/results/http-local-startup.json}

bash bench/goal-http-build.sh
python3 bench/http-matrix.py \
  --output "$RESULT" \
  --rounds "$ROUNDS" \
  --duration "$DURATION" \
  --workers 1 8
python3 bench/http-matrix.py \
  --output "$STARTUP_RESULT" \
  --rounds "$STARTUP_ROUNDS" \
  --workers 1 8 \
  --startup-only
python3 bench/summarize-http-matrix.py \
  "$RESULT" \
  --startup-result "$STARTUP_RESULT"
