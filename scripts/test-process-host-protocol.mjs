import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

import { compilerRuntimeInclude } from './resolve-compiler.mjs'
import { geatscNodePlugin } from '../plugin/index.mjs'

const root = resolve(import.meta.dirname, '..')
const compilerRequire = createRequire(import.meta.resolve('@geastack/compiler/plugin'))
const ts = compilerRequire('typescript')

test('Process host metadata claims a finite, receiverless Process@1 protocol', () => {
  const capabilities = geatscNodePlugin().instantiate().capabilities
  assert.equal(capabilities.nativeTypes.has('Process'), false)
  assert.deepEqual(capabilities.nativeTypesByDeclaration.get('Process'), {
    declarationName: 'Process',
    declarationFileName: resolve(root, 'runtime/node/node-globals.ts'),
    native: 'gea::node::Process'
  })
  assert.deepEqual(capabilities.hostSingletonDeclarations.get('process'), {
    declarationName: 'process',
    declarationFileName: resolve(root, 'runtime/node/node-globals.ts')
  })
  for (const member of ['env', 'nextTick', 'hrtime', 'on', 'removeListener', 'getBuiltinModule'])
    assert.ok(capabilities.hostMembers.has(`gea::node::Process.${member}`))
  assert.equal(capabilities.hostMembers.get('gea::node::Process.getBuiltinModule')?.result, 'dynamic')
  assert.equal(capabilities.commonJsBuiltinModules.get('node:diagnostics_channel'), 'diagnostics_channel')
  assert.equal(capabilities.commonJsBuiltinModules.get('diagnostics_channel'), 'diagnostics_channel')
  assert.ok(capabilities.commonJsBuiltinModuleSources.get('diagnostics_channel'))
  assert.equal(capabilities.commonJsBuiltinModules.has('v8'), false)
  assert.equal(capabilities.commonJsBuiltinModules.has('node:v8'), false)
  assert.equal(capabilities.commonJsBuiltinModuleSources.has('v8'), false)
  assert.equal(
    capabilities.hostMethodBindings.get(resolve(root, 'runtime/node/node-globals.ts'))?.get('Process.getBuiltinModule')
      ?.builtinModuleLookup,
    true
  )
  // These declarations are not runtime promises.  In particular, a throwing
  // facade must never turn into a claimed host member just because Node types
  // mention it.
  for (const member of ['emitWarning', 'once', 'platform', 'version'])
    assert.equal(capabilities.hostMembers.has(`gea::node::Process.${member}`), false)
  assert.equal(capabilities.hostMembers.has('gea::node::ProcessWriteStream.write'), false)
  assert.equal(capabilities.hostMembers.has('gea::node::Process.kill'), false)
  assert.deepEqual(capabilities.hostInvocations.get('gea::node::ProcessHrTime.call'), {
    emit: 'gea::node::process::hrtime()',
    arity: 0
  })
})

test('Process getBuiltinModule uses the cached native builtin registry', () => {
  const executable = resolve(root, 'apps/fastify-hello/dist/process-builtin-module')
  execFileSync(
    process.env.CXX ?? 'clang++',
    [
      '-std=c++20',
      `-I${compilerRuntimeInclude()}`,
      `-I${resolve(root, 'runtime')}`,
      `-I${resolve(root, 'runtime/node')}`,
      '-x',
      'c++',
      '-',
      '-o',
      executable
    ],
    {
      input: `
#include "gea_node.hpp"
#include <cassert>
int loads = 0;
gea::commonjs::ModuleRecord record;
gea::Value load_record() { return gea::commonjs::evaluate(record, [] { ++loads; }); }
int main() {
  gea::commonjs::registerBuiltinModule("diagnostics_channel", &load_record);
  const auto plain = gea::node::process::get_builtin_module("diagnostics_channel");
  const auto prefixed = gea::node::process::get_builtin_module("node:diagnostics_channel");
  assert(plain.tag() == gea::Value::Tag::Object);
  assert(plain.asDynamicObject() == prefixed.asDynamicObject());
  assert(loads == 1);
  assert(gea::node::process::get_builtin_module("v8").tag() == gea::Value::Tag::Undefined);
  assert(gea::node::process::get_builtin_module("node:v8").tag() == gea::Value::Tag::Undefined);
  assert(gea::node::process::get_builtin_module("not-a-builtin").tag() == gea::Value::Tag::Undefined);
}
`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  execFileSync(executable, { stdio: 'inherit' })
})

test('Process getBuiltinModule preserves Node’s generic literal return type', () => {
  const declaration = resolve(root, 'runtime/node/node-globals.ts')
  const entry = resolve(root, 'fixtures/process-builtin-module-type.ts')
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === entry
      ? ts.createSourceFile(
          fileName,
          `const value = process.getBuiltinModule('node:diagnostics_channel'); const unavailable = process.getBuiltinModule('v8')`,
          languageVersion,
          true
        )
      : read(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram({ rootNames: [declaration, entry], options, host })
  const source = program.getSourceFile(entry)
  assert.ok(source)
  const initializer = source.statements[0].declarationList.declarations[0].initializer
  assert.ok(initializer)
  assert.equal(
    program.getTypeChecker().typeToString(program.getTypeChecker().getTypeAtLocation(initializer)),
    `typeof import("${resolve(root, 'runtime/node/diagnostics_channel')}")`
  )
  const unavailable = source.statements[1].declarationList.declarations[0].initializer
  assert.ok(unavailable)
  assert.match(program.getTypeChecker().typeToString(program.getTypeChecker().getTypeAtLocation(unavailable)), /undefined/)
  assert.equal(
    program
      .getSemanticDiagnostics()
      .some((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').includes('getBuiltinModule')),
    false
  )
})

test('Process native state preserves environment identity, tuple ABI, next-tick priority, and exit semantics', () => {
  const executable = resolve(root, 'apps/fastify-hello/dist/process-host-protocol')
  execFileSync(
    process.env.CXX ?? 'clang++',
    [
      '-std=c++20',
      `-I${compilerRuntimeInclude()}`,
      `-I${resolve(root, 'runtime')}`,
      `-I${resolve(root, 'runtime/node')}`,
      '-x',
      'c++',
      '-',
      '-o',
      executable
    ],
    {
      input: `
#include "gea_node.hpp"
#include <cassert>
#include <limits>
int mutations = 0;
void added(void*, double) { ++mutations; }
void mutating(void*, double) {
  ++mutations;
  gea::node::process::on("exit", gea::CallableObject<void(double)>(&added, nullptr));
}
int main(int argc, char** argv) {
  if (argc == 2) gea::node::process::exit(std::stod(argv[1]));
  auto first = gea::node::process::env();
  (*first)["GEA_PROCESS_HOST_PROTOCOL"] = gea::Optional<std::string>("ok");
  auto second = gea::node::process::env();
  assert(first == second);
  assert(*second->read("GEA_PROCESS_HOST_PROTOCOL") == "ok");
  auto elapsed = gea::node::process::hrtime();
  assert(elapsed.size() == 2);
  assert(elapsed[0] >= 0 && elapsed[1] >= 0 && elapsed[1] < 1'000'000'000);
  assert(!gea::node::process::hrtime_bigint().isZero());
  int order = 0;
  gea::node::process::next_tick([&order] { assert(order == 0); order = 1; });
  gea::detail::setNextTickDrain(&gea::node::drain_next_ticks);
  gea::detail::queuePromiseJob([&order] {
    assert(order == 1); order = 2;
    gea::node::process::next_tick([&order] { assert(order == 2); order = 3; });
  });
  gea::detail::drainPromiseJobs();
  assert(order == 3);
  order = 0;
  gea::node::queue_microtask([&order] { assert(order == 1); order = 2; });
  gea::node::process::next_tick([&order] { assert(order == 0); order = 1; });
  gea::node::drain_microtasks();
  assert(order == 2);
  assert(gea::node::process::exit_status(std::numeric_limits<double>::quiet_NaN()) == 0);
  assert(gea::node::process::exit_status(std::numeric_limits<double>::infinity()) == 0);
  assert(gea::node::process::exit_status(4294967297.0) == 1);
  gea::node::process::on("exit", gea::CallableObject<void(double)>(&mutating, nullptr));
  gea::node::process::emit_exit(7);
  assert(mutations == 1);
  gea::node::process::emit_exit(7);
  assert(mutations == 3);
  gea::CallableObject<void(double)> listener(+[](void*, double) {}, nullptr);
  const auto listener_count = gea::node::process::exit_listeners().size();
  gea::node::process::on("exit", listener);
  assert(gea::node::process::exit_listeners().size() == listener_count + 1);
  gea::node::process::remove_listener("exit", listener);
  assert(gea::node::process::exit_listeners().size() == listener_count);
}
`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  execFileSync(executable, { stdio: 'inherit' })
  assert.equal(spawnSync(executable, ['4294967297']).status, 1)
})
