import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { compilerRuntimeInclude } from './resolve-compiler.mjs'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'apps/hono-mongodb-todo/dist/native-byte-bridges')
const code = String.raw`
#include "gea_node.hpp"
#include <cassert>
#include <iostream>

int main(int argc, char **argv) {
  assert(argc == 3);
  const auto file = gea::node::read_file(argv[2]);
  assert(!file.empty());
  assert(gea::node::crypto_random_bytes(0).empty());
  const auto first = gea::node::crypto_random_bytes(4096);
  const auto second = gea::node::crypto_random_bytes(4096);
  assert(first.size() == 4096 && second.size() == 4096 && first != second);
  for (double invalid : {-1.0, std::numeric_limits<double>::infinity()}) {
    bool threw = false;
    try { gea::node::crypto_random_bytes(invalid); } catch (const gea::Value &) { threw = true; }
    assert(threw);
  }
  bool missingThrew = false;
  try { gea::node::read_file(std::string(argv[2]) + ".missing"); } catch (const gea::Value &) { missingThrew = true; }
  assert(missingThrew);
  bool directoryThrew = false;
  try { gea::node::read_file("."); } catch (const gea::Value &) { directoryThrew = true; }
  assert(directoryThrew);
#ifdef __linux__
  assert(!gea::node::read_file("/proc/self/status").empty());
#endif
  gea::TypedArray<std::uint8_t> payload(180000);
  for (std::size_t i = 0; i < payload.size(); ++i) payload.data()[i] = static_cast<std::uint8_t>(i % 251);
  std::vector<std::uint8_t> received;
  bool connected = false;
  double id = 0;
  id = gea::node::net_create("127.0.0.1", std::stod(argv[1]), 4, 0, "", 0, false, [&] {
    for (int event; (event = static_cast<int>(gea::node::net_next_event(id))) != 0;) {
      if (event == 1) {
        connected = true;
        assert(gea::node::net_write(id, payload));
      } else if (event == 2) {
        auto chunk = gea::node::net_read(id);
        received.insert(received.end(), chunk.begin(), chunk.end());
        if (received.size() == payload.size()) gea::node::net_destroy(id);
      } else if (event == 3) {
        std::cerr << gea::node::net_error(id) << std::endl;
        std::abort();
      }
    }
  });
  assert(id != 0);
  __gea_node_run_pending();
  assert(connected && received.size() == payload.size());
  assert(std::equal(received.begin(), received.end(), payload.data()));
  std::cout << "NATIVE_BYTE_BRIDGES_OK:" << file.size() << ":" << received.size() << std::endl;
}
`
execFileSync(process.env.CXX ?? 'clang++', [
  '-std=c++20', '-fsanitize=undefined',
  `-I${compilerRuntimeInclude()}`,
  `-I${resolve(root, 'runtime')}`, `-I${resolve(root, 'runtime/node')}`,
  '-x', 'c++', '-', '-o', executable
], { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

const sockets = new Set()
const server = createServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.pipe(socket)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const file = resolve(root, 'runtime/gea_node.cpp')
  const { stdout, stderr } = await promisify(execFile)(executable, [String(server.address().port), file], { timeout: 15000 })
  assert.equal(stderr, '')
  assert.equal(stdout.trim(), `NATIVE_BYTE_BRIDGES_OK:${readFileSync(file).length}:180000`)
  console.log(stdout.trim())
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
}
