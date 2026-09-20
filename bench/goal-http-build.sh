#!/usr/bin/env bash
# Build every artifact consumed by bench/http-matrix.py.
#
# The installed @geastack/compiler must already have been built. scripts/build.mjs
# imports that one shared build. This script never creates or retargets a
# compiler build.
#
# Usage on the Linux benchmark host:
#   npm --prefix "$(node -p "require('path').dirname(require.resolve('@geastack/compiler/package.json'))")" run build
#   CXX=clang++-22 bash bench/goal-http-build.sh
#
# Set GEA_COMPILER_JS to point at a specific build instead.
#
# Set CXX=g++ to use GCC. Set CARGO to override the cargo executable.
set -euo pipefail

cd "$(dirname "$0")/.."

CXX_BIN=${CXX:-g++}
CARGO_BIN=${CARGO:-cargo}
# The compiler's exports map declares only an "import" condition, so
# require.resolve('@geastack/compiler') raises ERR_PACKAGE_PATH_NOT_EXPORTED.
# './package.json' is exported, so its directory is the reliable anchor.
COMPILER_ROOT=$(node -p "require('path').dirname(require.resolve('@geastack/compiler/package.json'))" 2>/dev/null || true)
COMPILER_JS=${GEA_COMPILER_JS:-${COMPILER_ROOT:+$COMPILER_ROOT/dist/compiler.js}}

if [[ -z "$COMPILER_JS" ]]; then
  echo "@geastack/compiler is not installed; run: npm install @geastack/compiler" >&2
  exit 1
fi
if [[ ! -f "$COMPILER_JS" ]]; then
  echo "missing shared compiler build: $COMPILER_JS" >&2
  echo "run: npm --prefix \"$COMPILER_ROOT\" run build" >&2
  exit 1
fi
command -v "$CXX_BIN" >/dev/null || {
  echo "C++ compiler not found: $CXX_BIN" >&2
  exit 1
}
command -v "$CARGO_BIN" >/dev/null || {
  echo "Cargo not found: $CARGO_BIN" >&2
  exit 1
}

# No source-selection flags: the compiler acquires each dependency's typed
# source for the exact installed version by itself. The flags that used to be
# here pinned Hono to a checked-in vendored checkout, which is gone.
echo "=== Hono Gea: typed Hono source through the shared compiler ==="
CXX="$CXX_BIN" node scripts/build.mjs \
  apps/hono-hello/server.ts \
  --out apps/hono-hello/dist

echo "=== Gea raw: node:http source through the shared compiler ==="
CXX="$CXX_BIN" node scripts/build.mjs \
  apps/raw-http-hello/server.ts \
  --out apps/raw-http-hello/dist

echo "=== C++ epoll control ==="
"$CXX_BIN" -O2 -std=c++20 \
  apps/raw-http-hello/cpp-server/server.cpp \
  -o apps/raw-http-hello/dist/cpp-epoll

echo "=== C++ Drogon control ==="
"$CXX_BIN" -O2 -std=c++20 \
  apps/raw-http-hello/drogon-server/main.cc \
  -I/usr/include/jsoncpp \
  -ldrogon -ltrantor -ljsoncpp -lssl -lcrypto -lz -luuid -lpthread \
  -o apps/raw-http-hello/dist/cpp-drogon

echo "=== Rust Hyper and Axum controls ==="
"$CARGO_BIN" build \
  --manifest-path apps/raw-http-hello/rust-server/Cargo.toml \
  --release --locked

artifacts=(
  apps/hono-hello/dist/server
  apps/raw-http-hello/dist/server
  apps/raw-http-hello/dist/cpp-epoll
  apps/raw-http-hello/dist/cpp-drogon
  apps/raw-http-hello/rust-server/target/release/rust-http-hello
  apps/raw-http-hello/rust-server/target/release/axum-http-hello
)

echo "=== Built artifacts ==="
for artifact in "${artifacts[@]}"; do
  [[ -x "$artifact" ]] || {
    echo "missing executable after build: $artifact" >&2
    exit 1
  }
  ls -lh "$artifact"
done
