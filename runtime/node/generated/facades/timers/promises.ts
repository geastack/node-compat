// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:timers/promises
import { nodeNotImplemented } from "../../../not-implemented"
export { setTimeout } from "../../../timers/promises"

export const scheduler: unknown = undefined

export function setImmediate(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:timers/promises", "setImmediate")
}

export function setInterval(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:timers/promises", "setInterval")
}
