// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:module
import { nodeNotImplemented } from "../../not-implemented"

export const builtinModules: unknown = undefined

export const constants: unknown = undefined

export function createRequire(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "createRequire")
}

export function enableCompileCache(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "enableCompileCache")
}

export function findPackageJSON(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "findPackageJSON")
}

export function findSourceMap(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "findSourceMap")
}

export function flushCompileCache(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "flushCompileCache")
}

export function getCompileCacheDir(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "getCompileCacheDir")
}

export function getSourceMapsSupport(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "getSourceMapsSupport")
}

export function isBuiltin(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "isBuiltin")
}

export class Module {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented("node:module", "Module")
  }
}

export const prototype: unknown = undefined

export function register(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "register")
}

export function registerHooks(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "registerHooks")
}

export function runMain(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "runMain")
}

export function setSourceMapsSupport(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "setSourceMapsSupport")
}

export class SourceMap {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented("node:module", "SourceMap")
  }
}

export function stripTypeScriptTypes(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "stripTypeScriptTypes")
}

export function syncBuiltinESMExports(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "syncBuiltinESMExports")
}

export function wrap(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:module", "wrap")
}

// `export =` is a genuinely dynamic CommonJS namespace boundary. Keep
// string-keyed assignments so C/C++ platform macros cannot rewrite Node
// constant names while the generated module is being compiled.
const __node24Default: any = {}
__node24Default["builtinModules"] = builtinModules
__node24Default["constants"] = constants
__node24Default["createRequire"] = createRequire
__node24Default["enableCompileCache"] = enableCompileCache
__node24Default["findPackageJSON"] = findPackageJSON
__node24Default["findSourceMap"] = findSourceMap
__node24Default["flushCompileCache"] = flushCompileCache
__node24Default["getCompileCacheDir"] = getCompileCacheDir
__node24Default["getSourceMapsSupport"] = getSourceMapsSupport
__node24Default["isBuiltin"] = isBuiltin
__node24Default["Module"] = Module
__node24Default["prototype"] = prototype
__node24Default["register"] = register
__node24Default["registerHooks"] = registerHooks
__node24Default["runMain"] = runMain
__node24Default["setSourceMapsSupport"] = setSourceMapsSupport
__node24Default["SourceMap"] = SourceMap
__node24Default["stripTypeScriptTypes"] = stripTypeScriptTypes
__node24Default["syncBuiltinESMExports"] = syncBuiltinESMExports
__node24Default["wrap"] = wrap
export default __node24Default
