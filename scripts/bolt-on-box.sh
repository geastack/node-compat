#!/usr/bin/env bash
# BOLT a WSL-built driver on the Linux bench box (the only place with LBR), relayed through this Mac.
#
#   bash node-compat/scripts/bolt-on-box.sh <name> [--no-strip]
#
# <name> is a WSL build dir: ~/geastack/node-compat/apps/hono-mongodb-todo/dist/<name>/server must be the
# --pgo build WITHOUT --bolt. The script:
#   1. copies that image to the box under ~/.cache/keyorder-tmp/wslbolt/<name>/input,
#   2. under `flock ~/geastack-box-build.lock`: drops the benchmark DB, runs the image under
#      `perf record -e cycles:u -c 200003 -j any,u` (LBR; the same training build.mjs --bolt uses: the
#      driver run directly, it is self-terminating), then perf2bolt and llvm-bolt with build.mjs's options,
#   3. copies the BOLTed image back to WSL dist/<name>/server; the pre-BOLT image is kept as
#      dist/<name>/bolt/input and the profile as dist/<name>/bolt/profile.fdata (as build.mjs does).
# Keep the llvm-bolt flag list in sync with boltExecutable() in node-compat/scripts/build.mjs.
set -euo pipefail
NAME=${1:?usage: bolt-on-box.sh <name> [--no-strip]}
STRIP=0; [ "${2:-}" = "--no-strip" ] || STRIP=1
BOX=ubuntu@51.159.98.194
WIN=dashwin-geastack
WSLAPP='~/geastack/node-compat/apps/hono-mongodb-todo'
D='~/.cache/keyorder-tmp/wslbolt'/$NAME
wsl() { ssh "$WIN" "wsl -d Ubuntu-24.04 -- bash -c \"$1\""; }

echo "[bolt-on-box] 1/3 uploading $NAME/server to the box" >&2
wsl "cat $WSLAPP/dist/$NAME/server" | ssh "$BOX" "mkdir -p $D && cat > $D/input && chmod +x $D/input && ls -la $D/input" >&2

echo "[bolt-on-box] 2/3 profiling + rewriting on the box (holding geastack-box-build.lock)" >&2
ssh "$BOX" "STRIP=$STRIP D=$D bash -s" <<'REMOTE' >&2
set -euo pipefail
D=${D/#\~/$HOME}
exec 9>"$HOME/geastack-box-build.lock"
flock 9
B=/usr/lib/llvm-22/bin
cd "$D"
rm -f perf.data perf.data.old profile.fdata server
mongosh --quiet --eval "db.getSiblingDB('gea_driver_benchmark').dropDatabase()" >/dev/null
perf record -q -e cycles:u -c 200003 -j any,u -o perf.data -- ./input >/dev/null || echo "WARNING: training exited $?; using partial profile"
PATH=$B:$PATH $B/perf2bolt -p perf.data -o profile.fdata ./input 2>&1 | grep -v '^BOLT-WARNING' | tail -5
$B/llvm-bolt ./input -o server -data=profile.fdata -reorder-blocks=ext-tsp -reorder-functions=cdsort -split-functions -split-all-cold -split-eh -icf=1 -use-gnu-stack -hugify -dyno-stats 2>&1 | grep -v '^BOLT-WARNING' | tail -8
[ "$STRIP" = 1 ] && strip server
rm -f perf.data perf.data.old
ls -la server profile.fdata
REMOTE

echo "[bolt-on-box] 3/3 copying the BOLTed image back to WSL" >&2
wsl "mkdir -p $WSLAPP/dist/$NAME/bolt && cp -f $WSLAPP/dist/$NAME/server $WSLAPP/dist/$NAME/bolt/input"
ssh "$BOX" "cd $D && tar c server profile.fdata" | wsl "cd $WSLAPP/dist/$NAME && tar x && mv -f profile.fdata bolt/profile.fdata && chmod +x server && ls -la server"
echo "[bolt-on-box] done: $WSLAPP/dist/$NAME/server" >&2
