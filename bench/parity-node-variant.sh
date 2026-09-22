#!/usr/bin/env bash
# Runs Node on the scriptc variant of the parity app, so the parity driver can
# diff "Node on server.scriptc.ts" against "Node on server.ts":
#   node apps/http-parity/driver.mjs bench/parity-node-variant.sh apps/http-parity/server.ts
# Every case except the three routes the variant removes must PASS; that is
# the proof that the variant's type-level rewrites change no behavior.
cd "$(dirname "$0")/.." || exit 1
exec node apps/http-parity/server.scriptc.ts
