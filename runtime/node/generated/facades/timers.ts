// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:timers
import { nodeNotImplemented } from "../../not-implemented"
export { clearInterval, clearTimeout, setInterval, setTimeout } from "../../timers"

export function clearImmediate(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:timers", "clearImmediate")
}

export const promises: unknown = undefined

export function setImmediate(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:timers", "setImmediate")
}
