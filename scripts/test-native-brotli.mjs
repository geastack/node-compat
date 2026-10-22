import assert from 'node:assert/strict'
import { brotliCompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { compilerRuntimeInclude } from './resolve-compiler.mjs'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'apps/nest-node-probe/dist/native-brotli') + (process.platform === 'win32' ? '.exe' : '')
mkdirSync(dirname(executable), { recursive: true })
const bytes = (value) => `bytes("${value.toString('hex')}")`
const inputs = [
  Buffer.alloc(0),
  Buffer.from('abc'),
  Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 37) & 255)),
  Buffer.from('{"hello":"nest","n":1} '.repeat(20000))
]
const operations = inputs.map((input) => `std::cout << hex(gea::node::brotli::decompress(${bytes(brotliCompressSync(input))})) << '\\n';`)
const trailing = Buffer.concat([brotliCompressSync(inputs[1]), Buffer.from('xyz')])
operations.push(`std::cout << hex(gea::node::brotli::decompress(${bytes(trailing)})) << '\\n';`)
const truncated = brotliCompressSync(inputs[3]).subarray(0, 40)
const prefixes = []
if (process.env.BROTLI_DIR) prefixes.push(resolve(process.env.BROTLI_DIR))
else if (process.platform === 'win32') prefixes.push(...[process.env.VCPKG_ROOT, 'C:\\vcpkg'].filter(Boolean).map((r) => resolve(r, 'installed', 'x64-windows-static')))
else if (process.platform === 'darwin') {
  try {
    prefixes.push(execFileSync('brew', ['--prefix', 'brotli'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch {}
  prefixes.push('/opt/homebrew/opt/brotli', '/usr/local/opt/brotli')
}
const prefix = prefixes.find((p) => existsSync(resolve(p, 'include', 'brotli', 'decode.h')))
const brotliFlags = [
  ...(prefix ? [`-I${resolve(prefix, 'include')}`, `-L${resolve(prefix, 'lib')}`] : []),
  ...(prefix && process.platform !== 'win32' ? [`-Wl,-rpath,${resolve(prefix, 'lib')}`] : []),
  '-lbrotlidec',
  '-lbrotlicommon'
]
const code = String.raw`
#include "gea_node_buffer.hpp"
#include "gea_node_brotli.hpp"
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
template<class F> void throws(F action, const std::string& expected) {
  bool caught = false;
  try { action(); } catch (const gea::Value& error) {
    caught = true;
    assert(gea::host::instanceOfError(error, "Error"));
    const auto native = gea::detail::unboxAs<gea::Ref<gea::runtime::Error>>(error, gea::Value::Tag::Object, "brotli error");
    const std::string message = native->message;
    assert(message == expected);
    std::cout << "throws " << message << '\n';
  }
  assert(caught);
}
int main() {
  ${operations.join('\n  ')}
  throws([] { gea::node::brotli::decompress(bytes("0102030405")); }, "unexpected end of file");
  throws([] { gea::node::brotli::decompress(${bytes(truncated)}); }, "unexpected end of file");
  throws([] { gea::node::brotli::decompress(bytes("ff")); }, "Decompression failed");
}
`
execFileSync(
  process.env.CXX ?? 'clang++',
  ['-std=c++20', '-fsanitize=undefined,address', `-I${compilerRuntimeInclude()}`, `-I${resolve(root, 'runtime/node')}`, '-x', 'c++', '-', ...brotliFlags, '-o', executable],
  { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
)
const lines = execFileSync(executable, { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024 })
  .trimEnd()
  .split(/\r?\n/)
let at = 0
for (const input of inputs) assert.equal(lines[at++], input.toString('hex'), 'decompress')
assert.equal(lines[at++], inputs[1].toString('hex'), 'trailing bytes ignored')
assert.equal(lines[at++], 'throws unexpected end of file')
assert.equal(lines[at++], 'throws unexpected end of file')
assert.equal(lines[at++], 'throws Decompression failed')
assert.equal(at, lines.length)
console.log(`NATIVE_BROTLI_OK:${lines.length}`)
