import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync, gunzipSync, gzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { compilerRuntimeInclude } from './resolve-compiler.mjs'

// gea_node_zlib.hpp against node's own zlib: every codec decodes node's output
// byte-exactly, node decodes every one of ours, and malformed or truncated
// input throws instead of returning a prefix.
const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'apps/hono-mongodb-todo/dist/native-zlib')
mkdirSync(dirname(executable), { recursive: true })
const bytes = (value) => `bytes("${value.toString('hex')}")`
const inputs = [
  Buffer.alloc(0),
  Buffer.from('abc'),
  Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 37) & 255)),
  Buffer.from('saslprep '.repeat(20000))
]
const framings = [
  [15, deflateSync, inflateSync],
  [31, gzipSync, gunzipSync],
  [-15, deflateRawSync, inflateRawSync]
]
const operations = []
for (const input of inputs) {
  for (const [bits, compress] of framings) {
    operations.push(`std::cout << hex(gea::node::zlib::inflate(${bytes(compress(input))}, ${bits})) << '\\n';`)
    for (const level of [-1, 0, 9])
      operations.push(`std::cout << hex(gea::node::zlib::deflate(${bytes(input)}, ${bits}, ${level})) << '\\n';`)
  }
  // Unzip detects either wrapper.
  operations.push(`std::cout << hex(gea::node::zlib::inflate(${bytes(gzipSync(input))}, 47)) << '\\n';`)
  operations.push(`std::cout << hex(gea::node::zlib::inflate(${bytes(deflateSync(input))}, 47)) << '\\n';`)
}
// node's Gunzip reads every member of a multi-member file.
const members = Buffer.concat([gzipSync(Buffer.from('first ')), gzipSync(Buffer.from('second'))])
operations.push(`std::cout << hex(gea::node::zlib::inflate(${bytes(members)}, 31)) << '\\n';`)
const truncated = gzipSync(inputs[3]).subarray(0, 40)
const code = String.raw`
#include "gea_node_buffer.hpp"
#include "gea_node_zlib.hpp"
#include <cassert>
#include <iostream>
gea::TypedArray<std::uint8_t> bytes(const std::string& hex) {
  const auto source = gea::node::buffer::from(hex, "hex");
  gea::TypedArray<std::uint8_t> result(source->size());
  std::copy(source->data(), source->data() + source->size(), result.data());
  return result;
}
std::string hex(const std::vector<std::uint8_t>& source) {
  gea::TypedArray<std::uint8_t> value(source.size());
  std::copy(source.begin(), source.end(), value.data());
  return gea::node::buffer::toString(value, "hex");
}
template<class F> void throws(F action) {
  bool caught = false;
  try { action(); } catch (const gea::Value& error) {
    caught = true;
    assert(gea::host::instanceOfError(error, "Error"));
  }
  assert(caught);
}
int main() {
  ${operations.join('\n  ')}
  throws([] { gea::node::zlib::inflate(bytes("0102030405"), 31); });
  throws([] { gea::node::zlib::inflate(${bytes(truncated)}, 31); });
  throws([] { gea::node::zlib::deflate(bytes("00"), 15, 10); });
  throws([] { gea::node::zlib::inflate(bytes("00"), 12); });
}
`
execFileSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    '-fsanitize=undefined,address',
    `-I${compilerRuntimeInclude()}`,
    `-I${resolve(root, 'runtime/node')}`,
    '-x',
    'c++',
    '-',
    '-lz',
    '-o',
    executable
  ],
  { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
)
const lines = execFileSync(executable, { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024 })
  .trimEnd()
  .split('\n')
let at = 0
const decoded = (line) => Buffer.from(line, 'hex')
for (const input of inputs) {
  for (const [bits, , decompress] of framings) {
    assert.equal(lines[at++], input.toString('hex'), `inflate ${bits}`)
    for (const level of [-1, 0, 9]) assert.deepEqual(decompress(decoded(lines[at++])), input, `deflate ${bits} level ${level}`)
  }
  assert.equal(lines[at++], input.toString('hex'), 'unzip of gzip')
  assert.equal(lines[at++], input.toString('hex'), 'unzip of zlib')
}
assert.equal(decoded(lines[at++]).toString(), 'first second')
assert.equal(at, lines.length)
console.log(`NATIVE_ZLIB_OK:${lines.length}`)
