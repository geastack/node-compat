#!/bin/sh
# usage: alloc-hist.sh <phase>   (run on the bench box; see alloc-hist.mjs)
export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
T=$HOME/.cache/keyorder-tmp
cd "$(dirname "$0")/.." || exit 1
flock ~/geastack-box-build.lock timeout 150 node benchmarks/alloc-hist.mjs "$PWD/dist/driver-box55/server" $T/alloc-take-ids.txt "$1" $T/alloc-hist-$1.json
sudo -n sh -c 'for e in /sys/kernel/tracing/events/gea_alloc/e[0-9]*; do echo "!hist:keys=common_pid" > $e/trigger 2>/dev/null; done'
