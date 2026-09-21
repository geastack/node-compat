// node-compat plugin: exposes the native Node runtime (event loop + TCP + HTTP)
// to geatsc-compiled TypeScript, and emits that runtime's C++ as a normal
// generated source file.
//
// Mechanism:
//  - `configure()` registers ambient intrinsic functions as `embeddedHostFunctions`
//    so a call in the compiled TS lowers to a direct call of the C++ symbol.
//  - `createCppBackend().transformGeneratedSources()` adds `gea_node.cpp` to the
//    generated source list, so the multi-file native build compiles + links it
//    like every other generated module.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeCpp = path.resolve(here, '..', 'runtime', 'gea_node.cpp')
const runtimeBufferHeader = path.resolve(here, '..', 'runtime', 'node', 'gea_node_buffer.hpp')
const runtimeNetHeader = path.resolve(here, '..', 'runtime', 'node', 'gea_node_net.hpp')
const nodeCompatibilityLedgerPath = path.resolve(
  here,
  '..',
  'runtime',
  'node',
  'generated',
  'node24-compatibility.json'
)
const BUFFER_NATIVE_TYPE = 'gea_node_buffer'

function nodeStubRuntimeCall(moduleName, memberName, aliases = []) {
  return {
    name: memberName,
    exportName: memberName,
    moduleSpecifiers: [moduleName, ...aliases],
    emit(context) {
      const returnType = context.typeName(context.expression)
      const call = `__gea_node_not_implemented(${JSON.stringify(moduleName)}, ${JSON.stringify(memberName)})`
      const argumentEffects = context.expression.arguments
        .map((argument) => `(void)(${context.emitExpression(argument)});`)
        .join(' ')
      if (returnType === 'void') return `([&]() -> void { ${argumentEffects} ${call}; })()`
      const concreteReturn = returnType === 'auto' ? 'gea_cpp_value' : returnType
      return `([&]() -> ${concreteReturn} { ${argumentEffects} ${call}; return ${concreteReturn}{}; })()`
    }
  }
}

function nodeStubRuntimeConstruction(moduleName, memberName, aliases = []) {
  return {
    name: memberName,
    exportName: memberName,
    moduleSpecifiers: [moduleName, ...aliases],
    emit(context) {
      const returnType = context.typeName(context.expression)
      const concreteReturn = returnType === 'auto' ? 'gea_cpp_value' : returnType
      const argumentEffects = (context.expression.arguments ?? [])
        .map((argument) => `(void)(${context.emitExpression(argument)});`)
        .join(' ')
      return `([&]() -> ${concreteReturn} { ${argumentEffects} __gea_node_not_implemented(${JSON.stringify(moduleName)}, ${JSON.stringify(memberName)}); return ${concreteReturn}{}; })()`
    }
  }
}

function nodeStubResult(context, moduleName, memberName, effects = []) {
  const returnType = context.typeName(context.expression)
  const call = `__gea_node_not_implemented(${JSON.stringify(moduleName)}, ${JSON.stringify(memberName)})`
  const effectCode = effects.filter(Boolean).map((effect) => `(void)(${effect});`).join(' ')
  if (returnType === 'void') return `([&]() -> void { ${effectCode} ${call}; })()`
  const concreteReturn = returnType === 'auto' ? 'gea_cpp_value' : returnType
  return `([&]() -> ${concreteReturn} { ${effectCode} ${call}; return ${concreteReturn}{}; })()`
}

function nodeStubRuntimeNamespaceCall(moduleName, memberName, aliases = []) {
  return {
    name: memberName,
    moduleSpecifiers: [moduleName, ...aliases],
    scope: 'module',
    emit(context) {
      return nodeStubResult(
        context,
        moduleName,
        memberName,
        context.expression.arguments.map((argument) => context.emitExpression(argument))
      )
    }
  }
}

function nodeStubRuntimeMemberCall(moduleName, className, member, aliases = []) {
  return {
    name: member.name,
    moduleSpecifiers: [moduleName, ...aliases],
    receiverExportName: className,
    scope: member.scope,
    emit(context) {
      const effects = []
      if (member.scope === 'instance') effects.push(context.emitReceiver())
      effects.push(...context.expression.arguments.map((argument) => context.emitExpression(argument)))
      const operation = className === 'default' ? member.name : `${className}.${member.name}`
      return nodeStubResult(context, moduleName, operation, effects)
    }
  }
}

function nodeStubRuntimeValueRead(moduleName, memberName, aliases = []) {
  return {
    name: memberName,
    exportName: memberName,
    moduleSpecifiers: [moduleName, ...aliases],
    emit(context) {
      return nodeStubResult(context, moduleName, memberName)
    }
  }
}

function nodeStubRuntimeNamespaceValueRead(moduleName, memberName, aliases = []) {
  return {
    name: memberName,
    moduleSpecifiers: [moduleName, ...aliases],
    scope: 'module',
    emit(context) {
      return nodeStubResult(context, moduleName, memberName)
    }
  }
}

function nodeStubRuntimeMemberRead(moduleName, className, member, aliases = []) {
  return {
    name: member.name,
    moduleSpecifiers: [moduleName, ...aliases],
    receiverExportName: className,
    scope: member.scope,
    emit(context) {
      const effects = member.scope === 'instance' ? [context.emitReceiver()] : []
      const operation = className === 'default' ? member.name : `${className}.${member.name}`
      return nodeStubResult(context, moduleName, operation, effects)
    }
  }
}

function nodePartialRuntimeMemberRead(moduleName, className, member, aliases = []) {
  return {
    name: member.name,
    moduleSpecifiers: [moduleName, ...aliases],
    receiverExportName: className,
    scope: member.scope,
    emit(context) {
      if (member.scope === 'static') {
        const suffix = member.overlayKind === 'GetAccessor' || member.overlayKind === 'SetAccessor' ? '()' : ''
        return `${className}::${member.name}${suffix}`
      }
      const storage = context
        .expressionStorageTypeName(context.receiver)
        .replace(/^const\s+/, '')
        .replace(/\s*&+\s*$/, '')
        .trim()
      const type = context
        .typeName(context.receiver)
        .replace(/^const\s+/, '')
        .replace(/\s*&+\s*$/, '')
        .trim()
      const receiver = context.emitReceiver()
      const suffix = member.overlayKind === 'GetAccessor' ? '()' : ''
      const isPointer = (value) =>
        /^(?:std::shared_ptr|gea_rc_ptr|gea_gc_ptr)<.+>$/.test(value) || /\*$/.test(value)
      if (isPointer(storage) || isPointer(type)) return `(${receiver})->${member.name}${suffix}`
      const isClassValue = (value) => value === className || value.endsWith(`::${className}`)
      if (isClassValue(storage) || isClassValue(type)) return `(${receiver}).${member.name}${suffix}`
      return null
    }
  }
}

const nodeCompatibilityLedger = JSON.parse(fs.readFileSync(nodeCompatibilityLedgerPath, 'utf8'))
const nodeStubRuntimeCalls = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports
      .filter((entry) => entry.status === 'stubbed' && entry.kind === 'function')
      .map((entry) => nodeStubRuntimeCall(moduleName, entry.name, module.aliases))
)
const nodeStubRuntimeConstructions = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports
      .filter((entry) => entry.status === 'stubbed' && entry.kind === 'class')
      .map((entry) => nodeStubRuntimeConstruction(moduleName, entry.name, module.aliases))
)
const nodeStubRuntimeNamespaceCalls = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports
      .filter((entry) => entry.status === 'stubbed' && entry.kind === 'function')
      .map((entry) => nodeStubRuntimeNamespaceCall(moduleName, entry.name, module.aliases))
)
const nodeStubRuntimeValueReads = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports
      .filter((entry) => entry.status === 'stubbed' && entry.kind === 'value')
      .map((entry) => nodeStubRuntimeValueRead(moduleName, entry.name, module.aliases))
)
const nodeStubRuntimeNamespaceValueReads = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports
      .filter((entry) => entry.status === 'stubbed' && entry.kind === 'value')
      .map((entry) => nodeStubRuntimeNamespaceValueRead(moduleName, entry.name, module.aliases))
)
const nodeStubRuntimeClassMemberCalls = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports.flatMap((entry) =>
      (entry.members ?? [])
        .filter(
          (member) =>
            member.status === 'stubbed' &&
            member.name !== '<constructor>' &&
            (member.kind === 'MethodDeclaration' || member.kind === 'MethodSignature')
        )
        .map((member) =>
          nodeStubRuntimeMemberCall(moduleName, entry.name, member, module.aliases)
        )
    )
)
const nodeStubRuntimeClassMemberReads = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports.flatMap((entry) =>
      (entry.members ?? [])
        .filter(
          (member) =>
            member.status === 'stubbed' &&
            member.name !== '<constructor>' &&
            member.kind !== 'MethodDeclaration' &&
            member.kind !== 'MethodSignature'
        )
        .map((member) =>
          nodeStubRuntimeMemberRead(moduleName, entry.name, member, module.aliases)
        )
    )
)
const nodePartialRuntimeClassMemberReads = Object.entries(nodeCompatibilityLedger.modules).flatMap(
  ([moduleName, module]) =>
    module.runtimeExports.flatMap((entry) =>
      (entry.members ?? [])
        .filter(
          (member) =>
            member.status === 'partial' &&
            member.overlayKind !== undefined &&
            member.kind !== 'MethodDeclaration' &&
            member.kind !== 'MethodSignature'
        )
        .map((member) =>
          nodePartialRuntimeMemberRead(moduleName, entry.name, member, module.aliases)
        )
    )
)

const blockListRulesRead = {
  name: 'rules',
  emit(context) {
    const storage = context.expressionStorageTypeName(context.receiver).replace(/^const\s+/, '').trim()
    const type = context.typeName(context.receiver).replace(/^const\s+/, '').trim()
    if (!storage.includes('BlockList') && !type.includes('BlockList')) return null
    const receiver = context.emitReceiver()
    if (receiver.includes('this')) return null
    const isPointer = /^(?:std::shared_ptr|gea_rc_ptr|gea_gc_ptr)<.+>$/.test(storage) || /\*$/.test(storage)
    return isPointer ? `(${receiver})->rules` : `(${receiver}).rules`
  }
}

const bufferMemberReturnTypes = {
  subarray: BUFFER_NATIVE_TYPE,
  slice: BUFFER_NATIVE_TYPE,
  set: 'void',
  write: 'double',
  copy: 'double',
  readUInt8: 'double',
  readInt32LE: 'double',
  readUInt32LE: 'double',
  writeUInt8: 'double',
  writeInt32LE: 'double',
  writeUInt32LE: 'double',
  toString: 'std::string',
  equals: 'bool',
  compare: 'double',
  swap32: BUFFER_NATIVE_TYPE
}

const bufferMemberHelpers = {
  subarray: null,
  slice: null,
  set: null,
  write: 'write',
  copy: 'copy',
  readUInt8: 'read_uint8',
  readInt32LE: 'read_int32_le',
  readUInt32LE: 'read_uint32_le',
  writeUInt8: 'write_uint8',
  writeInt32LE: 'write_int32_le',
  writeUInt32LE: 'write_uint32_le',
  toString: 'to_string',
  equals: 'equals',
  compare: 'compare',
  swap32: 'swap32'
}

function bufferRuntimeMemberCall(name, helper) {
  return {
    name,
    emit(context) {
      const receiverType = context.typeName(context.receiver)
      const receiverStorage = context.expressionStorageTypeName(context.receiver)
      if (receiverType !== BUFFER_NATIVE_TYPE && receiverStorage !== BUFFER_NATIVE_TYPE) return null

      // A narrowed union can retain gea_cpp_value storage. Reconstituting the
      // native carrier here is the intentional dynamic boundary; its typed-array
      // bridge preserves the shared byte owner, offset, and length without
      // boxing individual bytes.
      const receiver = `gea_node_buffer(${context.emitReceiver()})`
      const args = context.expression.arguments.map((argument) => context.emitExpression(argument))
      if (helper === null) return `(${receiver}).${name}(${args.join(', ')})`
      const callArgs = [receiver, ...args].join(', ')
      return `gea::node_buffer::${helper}(${callArgs})`
    }
  }
}

const bufferRuntimeMemberCalls = Object.entries(bufferMemberHelpers).map(([name, helper]) =>
  bufferRuntimeMemberCall(name, helper)
)

// The intrinsic surface. Extend this as the TS-side Node builtins grow.
export const intrinsics = {
  __gea_answer: { emit: '__gea_answer', returnType: 'double', decl: 'double __gea_answer();' },
  __gea_serve_hello: { emit: '__gea_serve_hello', returnType: 'void', decl: 'void __gea_serve_hello(double port);' },
  __gea_http_serve: {
    emit: '__gea_http_serve',
    returnType: 'void',
    decl: 'void __gea_http_serve(double port, const gea_cpp_value& handler);'
  },
  __gea_http_write: {
    emit: '__gea_http_write',
    returnType: 'void',
    decl: 'void __gea_http_write(double connId, std::string data);'
  },
  // Two pieces -- in practice the serialized header block and the first body
  // chunk -- appended into the connection buffer with ONE flush.
  //
  // `emitPayload` used to call `__gea_http_write` with `head + body`, which
  // built a third string holding a copy of both purely to satisfy the arity.
  // Both parts are taken by reference, not by value: the header block is an
  // lvalue field at the call site, so a by-value parameter would copy it and
  // reintroduce the allocation this exists to remove.
  __gea_http_write2: {
    emit: '__gea_http_write2',
    returnType: 'void',
    decl: 'void __gea_http_write2(double connId, const std::string& head, const std::string& body);'
  },
  // The response header block, serialized into the connection's retained
  // output buffer rather than into a string the (per-request) response object
  // owns -- see `HttpConnectionBase::headBegin` in `runtime/gea_node.cpp`.
  __gea_http_head_begin: {
    emit: '__gea_http_head_begin',
    returnType: 'void',
    decl: 'void __gea_http_head_begin(double connId, double status, const std::string& message);'
  },
  __gea_http_head_field: {
    emit: '__gea_http_head_field',
    returnType: 'void',
    decl: 'void __gea_http_head_field(double connId, const std::string& name, const std::string& value);'
  },
  // Header-block bytes already spelled by the caller: appended, not flushed.
  __gea_http_head_raw: {
    emit: '__gea_http_head_raw',
    returnType: 'void',
    decl: 'void __gea_http_head_raw(double connId, const std::string& text);'
  },
  __gea_http_head_end: {
    emit: '__gea_http_head_end',
    returnType: 'double',
    decl: 'double __gea_http_head_end(double connId, double flags, double autoContentLength);'
  },
  // Body bytes by reference (`__gea_http_write` copies its by-value argument).
  __gea_http_body: {
    emit: '__gea_http_body',
    returnType: 'void',
    decl: 'void __gea_http_body(double connId, const std::string& data);'
  },
  // A string's UTF-8 length: the storage size, not a `Buffer.byteLength` call.
  __gea_http_text_bytes: {
    emit: '__gea_http_text_bytes',
    returnType: 'double',
    decl: 'double __gea_http_text_bytes(const std::string& text);'
  },
  // A whole chunked body -- size line, text, terminator -- appended in place.
  __gea_http_final_chunk: {
    emit: '__gea_http_final_chunk',
    returnType: 'void',
    decl: 'void __gea_http_final_chunk(double connId, const std::string& data);'
  },
  // The byte-preserving sibling of `__gea_http_write`, for a `Uint8Array` or
  // `Buffer` response body. Same carrier `net_write` takes.
  __gea_http_write_bytes: {
    emit: '__gea_http_write_bytes',
    returnType: 'void',
    decl: 'void __gea_http_write_bytes(double connId, const gea::TypedArray<std::uint8_t>& data);'
  },
  // The inbound direction: a request body string's own octets as a Buffer.
  __gea_http_body_bytes: {
    emit: '__gea_http_body_bytes',
    returnType: 'gea::Ref<gea::TypedArray<std::uint8_t>>',
    decl: 'gea::Ref<gea::TypedArray<std::uint8_t>> __gea_http_body_bytes(const std::string& body);'
  },
  __gea_http_done: {
    emit: '__gea_http_done',
    returnType: 'void',
    decl: 'void __gea_http_done(double connId, bool keepAlive);'
  },
  __gea_http_destroy: {
    emit: '__gea_http_destroy',
    returnType: 'void',
    decl: 'void __gea_http_destroy(double connId);'
  },
  __gea_http_peer: {
    emit: '__gea_http_peer',
    returnType: 'std::string',
    decl: 'std::string __gea_http_peer(double connId);'
  },
  __gea_http_date: {
    emit: '__gea_http_date',
    returnType: 'std::string',
    decl: 'const std::string& __gea_http_date();'
  },
  __gea_http_date_second: {
    emit: '__gea_http_date_second',
    returnType: 'double',
    decl: 'double __gea_http_date_second();'
  },
  __gea_http_stop: {
    emit: '__gea_http_stop',
    returnType: 'void',
    decl: 'void __gea_http_stop();'
  },
  // Real reactor-integrated delayed timers (the runtime's standalone fallback
  // degrades a setTimeout delay to an immediate microtask).
  setTimeout: {
    emit: '__gea_node_set_timeout',
    returnType: 'double',
    decl: 'double __gea_node_set_timeout(std::function<void()> callback, double delayMs);'
  },
  setInterval: {
    emit: '__gea_node_set_interval',
    returnType: 'double',
    decl: 'double __gea_node_set_interval(std::function<void()> callback, double delayMs);'
  },
  clearTimeout: {
    emit: '__gea_node_clear_timer',
    returnType: 'void',
    decl: 'void __gea_node_clear_timer(double id);'
  },
  clearInterval: {
    emit: '__gea_node_clear_timer',
    returnType: 'void',
    decl: 'void __gea_node_clear_timer(double id);'
  },
  __gea_node_timer_unref: {
    emit: '__gea_node_timer_unref',
    returnType: 'void',
    decl: 'void __gea_node_timer_unref(double id);'
  },
  __gea_node_timer_start_timeout: {
    emit: '__gea_node_set_timeout',
    returnType: 'double',
    decl: 'double __gea_node_set_timeout(std::function<void()> callback, double delayMs);'
  },
  __gea_node_timer_start_interval: {
    emit: '__gea_node_set_interval',
    returnType: 'double',
    decl: 'double __gea_node_set_interval(std::function<void()> callback, double delayMs);'
  },
  __gea_node_timer_clear: {
    emit: '__gea_node_clear_timer',
    returnType: 'void',
    decl: 'void __gea_node_clear_timer(double id);'
  },
  __gea_node_process_env: {
    emit: 'gea_cpp_process_env',
    returnType: 'gea_cpp_value'
  },
  __gea_node_version: {
    emit: '__gea_node_version',
    returnType: 'std::string',
    decl: 'std::string __gea_node_version();'
  },
  __gea_node_platform: {
    emit: '__gea_node_platform',
    returnType: 'std::string',
    decl: 'std::string __gea_node_platform();'
  },
  __gea_node_os_arch: {
    emit: '__gea_node_os_arch',
    returnType: 'std::string',
    decl: 'std::string __gea_node_os_arch();'
  },
  __gea_node_os_release: {
    emit: '__gea_node_os_release',
    returnType: 'std::string',
    decl: 'std::string __gea_node_os_release();'
  },
  // node:cluster and the process/os facts a cluster program needs. See
  // runtime/node/cluster.ts and the cluster namespace in runtime/gea_node.cpp.
  __gea_node_cluster_worker_id: {
    emit: '__gea_node_cluster_worker_id',
    returnType: 'double',
    decl: 'double __gea_node_cluster_worker_id();'
  },
  __gea_node_cluster_fork: {
    emit: '__gea_node_cluster_fork',
    returnType: 'double',
    decl: 'double __gea_node_cluster_fork(double id, std::string env);'
  },
  __gea_node_cluster_spawn_error: {
    emit: '__gea_node_cluster_spawn_error',
    returnType: 'std::string',
    decl: 'std::string __gea_node_cluster_spawn_error();'
  },
  __gea_node_cluster_set_notify: {
    emit: 'gea::node::cluster_set_notify',
    returnType: 'void'
  },
  __gea_node_cluster_next_exit: {
    emit: '__gea_node_cluster_next_exit',
    returnType: 'double',
    decl: 'double __gea_node_cluster_next_exit();'
  },
  __gea_node_cluster_exit_code: {
    emit: '__gea_node_cluster_exit_code',
    returnType: 'double',
    decl: 'double __gea_node_cluster_exit_code();'
  },
  __gea_node_cluster_exit_signal: {
    emit: '__gea_node_cluster_exit_signal',
    returnType: 'std::string',
    decl: 'std::string __gea_node_cluster_exit_signal();'
  },
  __gea_node_cluster_kill: {
    emit: '__gea_node_cluster_kill',
    returnType: 'bool',
    decl: 'bool __gea_node_cluster_kill(double pid, std::string signal);'
  },
  __gea_node_cluster_watch_channel: {
    emit: 'gea::node::cluster_watch_channel',
    returnType: 'void'
  },
  __gea_node_process_pid: {
    emit: '__gea_node_process_pid',
    returnType: 'double',
    decl: 'double __gea_node_process_pid();'
  },
  __gea_node_process_ppid: {
    emit: '__gea_node_process_ppid',
    returnType: 'double',
    decl: 'double __gea_node_process_ppid();'
  },
  __gea_node_process_exit: {
    emit: '__gea_node_process_exit',
    returnType: 'void',
    decl: 'void __gea_node_process_exit(double code);'
  },
  __gea_node_os_available_parallelism: {
    emit: '__gea_node_os_available_parallelism',
    returnType: 'double',
    decl: 'double __gea_node_os_available_parallelism();'
  },
  __gea_node_os_type: {
    emit: '__gea_node_os_type',
    returnType: 'std::string',
    decl: 'std::string __gea_node_os_type();'
  },
  __gea_node_stdio_write: {
    emit: '__gea_node_stdio_write',
    returnType: 'void',
    decl: 'void __gea_node_stdio_write(double fd, std::string data);'
  },
  __gea_node_fs_access: {
    emit: '__gea_node_fs_access',
    returnType: 'bool',
    decl: 'bool __gea_node_fs_access(std::string path, double mode);'
  },
  // These return the native Buffer carrier directly. Their declarations live
  // in gea_node_buffer.hpp, which generated_support.hpp includes, so no
  // gea_cpp_value bridge is introduced for random/file bytes.
  __gea_node_crypto_random_bytes: {
    emit: 'gea::node::crypto_random_bytes',
    returnType: BUFFER_NATIVE_TYPE
  },
  __gea_node_fs_read_file: {
    emit: 'gea::node::read_file',
    returnType: BUFFER_NATIVE_TYPE
  },
  // The socket notification is a typed zero-argument closure. Event payloads
  // are drained separately, with wire chunks returned as native Buffer.
  __gea_node_net_create: {
    emit: 'gea::node::net_create',
    returnType: 'double'
  },
  __gea_node_net_create_error: {
    emit: 'gea::node::net_create_error',
    returnType: 'std::string'
  },
  __gea_node_net_next_event: {
    emit: 'gea::node::net_next_event',
    returnType: 'double'
  },
  __gea_node_net_read: {
    emit: 'gea::node::net_read',
    returnType: BUFFER_NATIVE_TYPE
  },
  __gea_node_net_error: {
    emit: 'gea::node::net_error',
    returnType: 'std::string'
  },
  __gea_node_net_write: {
    emit: 'gea::node::net_write',
    returnType: 'bool'
  },
  __gea_node_mongodb_pool_open: {
    emit: 'gea::node::mongodb_pool_open',
    returnType: 'double'
  },
  __gea_node_mongodb_pool_exchange: {
    emit: 'gea::node::mongodb_pool_exchange',
    returnType: BUFFER_NATIVE_TYPE
  },
  __gea_node_mongodb_pool_close: {
    emit: 'gea::node::mongodb_pool_close',
    returnType: 'void'
  },
  __gea_node_net_buffer_size: {
    emit: 'gea::node::net_buffer_size',
    returnType: 'double'
  },
  __gea_node_net_end: {
    emit: 'gea::node::net_end',
    returnType: 'void'
  },
  __gea_node_net_destroy: {
    emit: 'gea::node::net_destroy',
    returnType: 'void'
  },
  __gea_node_net_reset_and_destroy: {
    emit: 'gea::node::net_reset_and_destroy',
    returnType: 'void'
  },
  __gea_node_net_set_paused: {
    emit: 'gea::node::net_set_paused',
    returnType: 'void'
  },
  __gea_node_net_set_referenced: {
    emit: 'gea::node::net_set_referenced',
    returnType: 'void'
  },
  __gea_node_net_set_notify: {
    emit: 'gea::node::net_set_notify',
    returnType: 'void'
  },
  __gea_node_net_set_keep_alive: {
    emit: 'gea::node::net_set_keep_alive',
    returnType: 'void'
  },
  __gea_node_net_set_no_delay: {
    emit: 'gea::node::net_set_no_delay',
    returnType: 'void'
  },
  __gea_node_net_remote_address: {
    emit: 'gea::node::net_remote_address',
    returnType: 'std::string'
  },
  __gea_node_net_remote_port: {
    emit: 'gea::node::net_remote_port',
    returnType: 'double'
  },
  __gea_node_net_remote_family: {
    emit: 'gea::node::net_remote_family',
    returnType: 'std::string'
  },
  __gea_node_net_local_address: {
    emit: 'gea::node::net_local_address',
    returnType: 'std::string'
  },
  __gea_node_net_local_port: {
    emit: 'gea::node::net_local_port',
    returnType: 'double'
  },
  __gea_node_net_local_family: {
    emit: 'gea::node::net_local_family',
    returnType: 'std::string'
  },
  __gea_node_net_is_ip: {
    emit: 'gea::node::net_is_ip',
    returnType: 'double'
  },
  __gea_node_net_normalize_ip: {
    emit: 'gea::node::net_normalize_ip',
    returnType: 'std::string'
  },
  __gea_node_net_ip_compare: {
    emit: 'gea::node::net_ip_compare',
    returnType: 'double'
  },
  __gea_node_net_ip_in_subnet: {
    emit: 'gea::node::net_ip_in_subnet',
    returnType: 'bool'
  },
  __gea_node_net_server_listen: {
    emit: 'gea::node::net_server_listen',
    returnType: 'double'
  },
  __gea_node_net_server_create_error: {
    emit: 'gea::node::net_server_create_error',
    returnType: 'std::string'
  },
  __gea_node_net_server_error: {
    emit: 'gea::node::net_server_error',
    returnType: 'std::string'
  },
  __gea_node_net_server_next_event: {
    emit: 'gea::node::net_server_next_event',
    returnType: 'double'
  },
  __gea_node_net_server_take_connection: {
    emit: 'gea::node::net_server_take_connection',
    returnType: 'double'
  },
  __gea_node_net_server_close: {
    emit: 'gea::node::net_server_close',
    returnType: 'void'
  },
  __gea_node_net_server_set_referenced: {
    emit: 'gea::node::net_server_set_referenced',
    returnType: 'void'
  },
  __gea_node_net_server_set_max_connections: {
    emit: 'gea::node::net_server_set_max_connections',
    returnType: 'void'
  },
  __gea_node_net_server_connections: {
    emit: 'gea::node::net_server_connections',
    returnType: 'double'
  },
  __gea_node_net_server_address: {
    emit: 'gea::node::net_server_address',
    returnType: 'std::string'
  },
  __gea_node_net_server_port: {
    emit: 'gea::node::net_server_port',
    returnType: 'double'
  },
  __gea_node_net_server_family: {
    emit: 'gea::node::net_server_family',
    returnType: 'std::string'
  }
}
