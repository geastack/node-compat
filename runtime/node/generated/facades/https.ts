// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:https
import { nodeNotImplemented } from "../../not-implemented"
export { globalAgent } from "../../https"

export class Agent {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented("node:https", "Agent")
  }
}

export function createServer(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:https", "createServer")
}

export function get(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:https", "get")
}

export function request(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:https", "request")
}

export class Server {
  constructor(...args: unknown[]) {
    void args
    nodeNotImplemented("node:https", "Server")
  }
}
