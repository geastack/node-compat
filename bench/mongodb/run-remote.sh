#!/usr/bin/env bash
# Fair direct-driver MongoDB write matrix. Run this on the benchmark host from
# the node-compat repository root. It uses one client thread/process at a time
# and rotates case order between rounds.
set -euo pipefail

cd "$(dirname "$0")/../.."

ROUNDS=${ROUNDS:-5}
INSERT_ONE_DOCUMENTS=${INSERT_ONE_DOCUMENTS:-1000}
INSERT_MANY_DOCUMENTS=${INSERT_MANY_DOCUMENTS:-50000}
BATCH_SIZE=${BATCH_SIZE:-100}
CLIENT_CPU=${CLIENT_CPU:-0}
MONGODB_URI=${MONGODB_URI:-mongodb://127.0.0.1:27017/}
MONGOCXX_PREFIX=${MONGOCXX_PREFIX:-$HOME/mongodb-drivers/install}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULT_DIR=${RESULT_DIR:-"bench/results/mongodb-write-${STAMP}"}
BENCH_DIR=bench/mongodb
WORK_ROOT=${WORK_ROOT:-bench/.work/mongodb-write}
NODE_WORK_DIR="$WORK_ROOT/node"
CPP_WORK_DIR="$WORK_ROOT/cpp"

export TMPDIR="$WORK_ROOT/tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export NODE_COMPILE_CACHE="$WORK_ROOT/node-compile-cache"
export npm_config_cache="$WORK_ROOT/npm-cache"
export CARGO_HOME="$WORK_ROOT/cargo-home"
export CARGO_TARGET_DIR="$WORK_ROOT/cargo-target"
export CCACHE_DIR="$WORK_ROOT/ccache"
export CCACHE_TEMPDIR="$WORK_ROOT/ccache-tmp"
export SCCACHE_DIR="$WORK_ROOT/sccache"
export XDG_CACHE_HOME="$WORK_ROOT/xdg-cache"

RUST_BIN_PATH="$CARGO_TARGET_DIR/release/mongodb-write-benchmark"
CPP_BIN_PATH="$CPP_WORK_DIR/mongodb-write-benchmark"

mkdir -p \
  "$RESULT_DIR" \
  "$NODE_WORK_DIR" \
  "$CPP_WORK_DIR" \
  "$TMPDIR" \
  "$NODE_COMPILE_CACHE" \
  "$npm_config_cache" \
  "$CARGO_HOME" \
  "$CARGO_TARGET_DIR" \
  "$CCACHE_DIR" \
  "$CCACHE_TEMPDIR" \
  "$SCCACHE_DIR" \
  "$XDG_CACHE_HOME"

for value in "$ROUNDS" "$INSERT_ONE_DOCUMENTS" "$INSERT_MANY_DOCUMENTS" "$BATCH_SIZE"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "benchmark sizes and rounds must be positive integers" >&2; exit 2; }
done

export PKG_CONFIG_PATH="$MONGOCXX_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$MONGOCXX_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

mongosh --quiet "$MONGODB_URI" --eval 'const result=db.adminCommand({ping:1}); if (result.ok !== 1) { throw new Error(JSON.stringify(result)) }' >/dev/null
mongosh --quiet "$MONGODB_URI" --eval 'db.getSiblingDB("gea_mongodb_write_bench").dropDatabase()' >/dev/null

cp "$BENCH_DIR/package.json" "$BENCH_DIR/package-lock.json" "$BENCH_DIR/node.mjs" "$NODE_WORK_DIR/"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$NODE_WORK_DIR"
"$HOME/.cargo/bin/cargo" build --locked --release --manifest-path "$BENCH_DIR/rust/Cargo.toml"

read -r -a mongocxx_cflags <<<"$(pkg-config --cflags libmongocxx1)"
read -r -a mongocxx_libs <<<"$(pkg-config --libs libmongocxx1)"
g++ -O3 -DNDEBUG -std=c++20 -Wall -Wextra -Wpedantic \
  "${mongocxx_cflags[@]}" "$BENCH_DIR/cpp/main.cpp" -o "$CPP_BIN_PATH" \
  "${mongocxx_libs[@]}" -Wl,-rpath,"$MONGOCXX_PREFIX/lib"

NODE_BIN=(node "$NODE_WORK_DIR/node.mjs")
RUST_BIN=("$RUST_BIN_PATH")
CPP_BIN=("$CPP_BIN_PATH")

cleanup() {
  mongosh --quiet "$MONGODB_URI" --eval 'db.getSiblingDB("gea_mongodb_write_bench").dropDatabase()' >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

{
  echo "timestamp_utc=$STAMP"
  echo "rounds=$ROUNDS insert_one_documents=$INSERT_ONE_DOCUMENTS insert_many_documents=$INSERT_MANY_DOCUMENTS batch_size=$BATCH_SIZE"
  echo "client_cpu=$CLIENT_CPU mongodb_uri_host=127.0.0.1 mongodb_database=gea_mongodb_write_bench"
  uname -a
  lscpu
  mongod --version
  mongosh --version
  mongosh --quiet "$MONGODB_URI" --eval 'db.version()'
  node --version
  npm --version
  node -p "require('./$NODE_WORK_DIR/node_modules/mongodb/package.json').version"
  "$HOME/.cargo/bin/rustc" --version
  "$HOME/.cargo/bin/cargo" --version
  "$HOME/.cargo/bin/cargo" tree --depth 1 --manifest-path "$BENCH_DIR/rust/Cargo.toml"
  g++ --version | head -1
  pkg-config --modversion libmongocxx1
  pkg-config --modversion mongoc2
  sha256sum \
    "$BENCH_DIR/node.mjs" \
    "$BENCH_DIR/package-lock.json" \
    "$BENCH_DIR/rust/src/main.rs" \
    "$BENCH_DIR/rust/Cargo.lock" \
    "$RUST_BIN_PATH" \
    "$BENCH_DIR/cpp/main.cpp" \
    "$CPP_BIN_PATH" \
    "$BENCH_DIR/run-remote.sh" \
    "$BENCH_DIR/record-sample.mjs" \
    "$BENCH_DIR/summarize.mjs"
} >"$RESULT_DIR/metadata.txt"

printf 'round\tdriver\tworkload\twrite_concern\tdocuments\toperations\tbatch_size\telapsed_ns\tdocuments_per_second\toperations_per_second\tcount\tcollection\n' >"$RESULT_DIR/samples.tsv"

CASES=()
for driver in node rust cpp; do
  for workload in insert-one insert-many; do
    for journal in false true; do
      CASES+=("$driver|$workload|$journal")
    done
  done
done

echo "RESULT_DIR=$RESULT_DIR"
for round in $(seq 1 "$ROUNDS"); do
  order=("${CASES[@]}")
  if [[ "$round" -eq 2 ]]; then
    order=()
    for ((index=${#CASES[@]} - 1; index >= 0; --index)); do order+=("${CASES[index]}"); done
  elif [[ "$round" -gt 2 ]]; then
    shift_by=$(((round * 5) % ${#CASES[@]}))
    order=("${CASES[@]:shift_by}" "${CASES[@]:0:shift_by}")
  fi

  for benchmark_case in "${order[@]}"; do
    IFS='|' read -r driver workload journal <<<"$benchmark_case"
    if [[ "$workload" == insert-one ]]; then documents=$INSERT_ONE_DOCUMENTS; else documents=$INSERT_MANY_DOCUMENTS; fi
    write_concern="w1-j${journal}"
    collection="r${round}_${driver//-/_}_${workload//-/_}_${write_concern//-/_}"
    raw="$RESULT_DIR/round-${round}-${driver}-${workload}-${write_concern}.json"

    case "$driver" in
      node) command=("${NODE_BIN[@]}") ;;
      rust) command=("${RUST_BIN[@]}") ;;
      cpp) command=("${CPP_BIN[@]}") ;;
      *) echo "unknown driver: $driver" >&2; exit 2 ;;
    esac

    taskset -c "$CLIENT_CPU" "${command[@]}" \
      "$MONGODB_URI" "$workload" "$journal" "$documents" "$BATCH_SIZE" "$collection" >"$raw"
    node "$BENCH_DIR/record-sample.mjs" \
      "$round" "$driver" "$workload" "$write_concern" "$documents" "$BATCH_SIZE" "$collection" "$raw" "$RESULT_DIR/samples.tsv"
    sleep 0.2
  done
done

node "$BENCH_DIR/summarize.mjs" --expect-rounds "$ROUNDS" "$RESULT_DIR/samples.tsv" | tee "$RESULT_DIR/summary.txt"
echo "BENCHMARK_COMPLETE result_dir=$RESULT_DIR"
