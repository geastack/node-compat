// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:test
import { nodeNotImplemented } from "../../not-implemented"

export function after(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "after")
}

export function afterEach(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "afterEach")
}

export const assert: unknown = undefined

export function before(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "before")
}

export function beforeEach(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "beforeEach")
}

export function describe(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "describe")
}

export function it(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "it")
}

export const mock: unknown = undefined

export class MockPropertyContext {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented("node:test", "MockPropertyContext")
  }
}

export function only(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "only")
}

export function run(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "run")
}

export function skip(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "skip")
}

export const snapshot: unknown = undefined

export function suite(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "suite")
}

export function test(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "test")
}

export function todo(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:test", "todo")
}

// `export =` is a genuinely dynamic CommonJS namespace boundary. Keep
// string-keyed assignments so C/C++ platform macros cannot rewrite Node
// constant names while the generated module is being compiled.
const __node24Default: any = {}
__node24Default["after"] = after
__node24Default["afterEach"] = afterEach
__node24Default["assert"] = assert
__node24Default["before"] = before
__node24Default["beforeEach"] = beforeEach
__node24Default["describe"] = describe
__node24Default["it"] = it
__node24Default["mock"] = mock
__node24Default["MockPropertyContext"] = MockPropertyContext
__node24Default["only"] = only
__node24Default["run"] = run
__node24Default["skip"] = skip
__node24Default["snapshot"] = snapshot
__node24Default["suite"] = suite
__node24Default["test"] = test
__node24Default["todo"] = todo
export default __node24Default
