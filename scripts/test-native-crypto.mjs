import assert from 'node:assert/strict'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { compilerRuntimeInclude } from './resolve-compiler.mjs'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'apps/hono-mongodb-todo/dist/native-crypto')
const operations = []
const expected = []
const bytes = (value) => `bytes("${value.toString('hex')}")`
const check = (expression, value) => {
  operations.push(String.raw`std::cout << hex(${expression}) << '\n';`)
  expected.push(value.toString('hex'))
}
const algorithms = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']
const input = Buffer.from(Array.from({ length: 513 }, (_, i) => (i * 37) & 255))
for (const algorithm of algorithms) {
  for (const data of [Buffer.alloc(0), Buffer.from('abc'), input]) {
    check(`gea::node::crypto::digest("${algorithm}", ${bytes(data)})`, createHash(algorithm).update(data).digest())
    for (const key of [Buffer.alloc(0), Buffer.from('key'), input]) {
      check(`gea::node::crypto::hmac("${algorithm}", ${bytes(key)}, ${bytes(data)})`, createHmac(algorithm, key).update(data).digest())
    }
  }
}
for (const algorithm of algorithms.slice(1)) {
  for (const [password, salt, iterations, length] of [
    [Buffer.from('pāss\0word'), input, 4096, 65],
    [Buffer.alloc(0), Buffer.alloc(0), 1, 20],
    [input, Buffer.from('salt'), 2, 1],
  ]) {
    check(
      `gea::node::crypto::pbkdf2(${bytes(password)}, ${bytes(salt)}, ${iterations}, ${length}, "${algorithm}")`,
      pbkdf2Sync(password, salt, iterations, length, algorithm),
    )
  }
}
const code = String.raw`
#include "gea_node_buffer.hpp"
#include "gea_node_crypto.hpp"
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
    const auto native = gea::detail::unboxAs<gea::Ref<gea::runtime::Error>>(error, gea::Value::Tag::Object, "crypto error");
    assert(!native->message.empty());
  }
  assert(caught);
}
int main() {
  ${operations.join('\n')}
  const auto a = bytes("010203"), b = bytes("010204"), empty = bytes("");
  assert(gea::node::crypto::timingSafeEqual(a, a));
  assert(!gea::node::crypto::timingSafeEqual(a, b));
  assert(gea::node::crypto::timingSafeEqual(empty, empty));
  throws([&] { gea::node::crypto::timingSafeEqual(a, empty); });
  throws([&] { gea::node::crypto::validate("not-a-digest"); });
  for (double invalid : {-1.0, 0.0, 1.5, std::numeric_limits<double>::infinity()})
    throws([&] { gea::node::crypto::pbkdf2(a, b, invalid, 32, "sha256"); });
  for (double invalid : {-1.0, 0.0, 1.5, std::numeric_limits<double>::infinity()})
    throws([&] { gea::node::crypto::pbkdf2(a, b, 1, invalid, "sha256"); });
}
`
execFileSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    '-fsanitize=undefined',
    `-I${compilerRuntimeInclude()}`,
    `-I${resolve(root, 'runtime/node')}`,
    '-x',
    'c++',
    '-',
    ...(process.platform === 'linux' ? ['-lcrypto'] : []),
    '-o',
    executable,
  ],
  { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
)
assert.deepEqual(execFileSync(executable, { encoding: 'utf8', timeout: 30000 }).trimEnd().split('\n'), expected)
console.log(`NATIVE_CRYPTO_OK:${expected.length}`)
