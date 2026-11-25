#!/bin/sh
# Training workload for a profile-guided (and BOLT) build of the server:
#
#   node ../../scripts/build.mjs server.ts ... --pgo-train 'sh benchmarks/pgo-train.sh' --bolt
#
# build.mjs runs this with GEA_PGO_EXE naming the executable to train. It
# serves the routes the HTTP benchmark measures, read-heavy with some writes,
# and ends the server with SIGTERM, which exits normally so the profile is
# written. Needs wrk, curl and a MongoDB at MONGODB_URL.
set -eu

PORT=${GEA_PGO_PORT:-3019}
URL=http://127.0.0.1:$PORT
SECONDS_READ=${GEA_PGO_SECONDS:-20}
export PORT
export MONGODB_URL="${MONGODB_URL:-mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&maxPoolSize=4&minPoolSize=1}"

"$GEA_PGO_EXE" &
server=$!
trap 'kill -TERM $server 2>/dev/null || true' EXIT

ready=0
for _ in $(seq 300); do
  if curl -s -o /dev/null "$URL/api/todos"; then
    ready=1
    break
  fi
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "pgo-train: the server did not come up on $URL" >&2; exit 1; }

wrk -t2 -c16 "-d${SECONDS_READ}s" "$URL/api/todos" >/dev/null
wrk -t2 -c16 -d3s "$URL/" >/dev/null

# Writes: create, update and delete, so those paths are laid out too.
for i in $(seq 200); do
  id=$(curl -s -X POST "$URL/api/todos" -H 'content-type: application/json' -d "{\"title\":\"pgo training $i\"}" |
    sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')
  [ -n "$id" ] || continue
  curl -s -o /dev/null -X PATCH "$URL/api/todos/$id" -H 'content-type: application/json' -d '{"completed":true}'
  curl -s -o /dev/null -X DELETE "$URL/api/todos/$id"
done

wrk -t2 -c16 -d5s "$URL/api/todos" >/dev/null

trap - EXIT
kill -TERM "$server"
wait "$server" || true
