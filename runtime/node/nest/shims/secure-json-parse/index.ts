
import type { ParsedElement, ParsedQs } from '../qs/index'

export type PoisoningAction = 'error' | 'remove' | 'ignore'

export interface ParseOptions {
  protoAction?: PoisoningAction
  constructorAction?: PoisoningAction
  safe?: boolean
}

export type ScanOptions = ParseOptions

export type Reviver = (key: string, value: unknown) => unknown

const suspectProtoRx = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/
const suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseInternal(text: string | Buffer, reviver?: Reviver | null | ParseOptions, options?: ParseOptions): unknown {
  let reviverFn: Reviver | undefined
  if (reviver !== null && typeof reviver === 'object') {
    if (options == null) options = reviver
  } else if (typeof reviver === 'function') {
    reviverFn = reviver
  }
  let source: string = Buffer.isBuffer(text) ? text.toString() : text
  if (source && source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  const obj: unknown = reviverFn === undefined ? JSON.parse(source) : JSON.parse(source, reviverFn)
  if (!isObject(obj)) return obj

  const protoAction: PoisoningAction = (options && options.protoAction) || 'error'
  const constructorAction: PoisoningAction = (options && options.constructorAction) || 'error'
  if (protoAction === 'ignore' && constructorAction === 'ignore') return obj
  if (protoAction !== 'ignore' && constructorAction !== 'ignore') {
    if (suspectProtoRx.test(source) === false && suspectConstructorRx.test(source) === false) return obj
  } else if (protoAction !== 'ignore' && constructorAction === 'ignore') {
    if (suspectProtoRx.test(source) === false) return obj
  } else {
    if (suspectConstructorRx.test(source) === false) return obj
  }
  return scan(obj, { protoAction, constructorAction, safe: options && options.safe })
}

export function scan<T extends object>(obj: T, options?: ScanOptions): T | null {
  const protoAction: PoisoningAction = (options && options.protoAction) || 'error'
  const constructorAction: PoisoningAction = (options && options.constructorAction) || 'error'
  const safe = options && options.safe
  let next: Record<string, unknown>[] = [obj as Record<string, unknown>]
  while (next.length) {
    const nodes = next
    next = []
    for (const node of nodes) {
      if (protoAction !== 'ignore' && Object.hasOwn(node, '__proto__')) {
        if (safe === true) return null
        else if (protoAction === 'error') throw new SyntaxError('Object contains forbidden prototype property')
        delete node['__proto__']
      }
      if (constructorAction !== 'ignore' && Object.hasOwn(node, 'constructor')) {
        const ctor = node['constructor']
        if (isObject(ctor) && Object.hasOwn(ctor, 'prototype')) {
          if (safe === true) return null
          else if (constructorAction === 'error') throw new SyntaxError('Object contains forbidden prototype property')
          delete node['constructor']
        }
      }
      for (const key in node) {
        const value = node[key]
        if (isObject(value)) next.push(value)
      }
    }
  }
  return obj
}

export function scanQuery(obj: ParsedQs, options?: ScanOptions): ParsedQs | null {
  const protoAction: PoisoningAction = (options && options.protoAction) || 'error'
  const constructorAction: PoisoningAction = (options && options.constructorAction) || 'error'
  const safe = options && options.safe
  let next: ParsedQs[] = [obj]
  while (next.length) {
    const nodes = next
    next = []
    for (const node of nodes) {
      if (protoAction !== 'ignore' && Object.hasOwn(node, '__proto__')) {
        if (safe === true) return null
        else if (protoAction === 'error') throw new SyntaxError('Object contains forbidden prototype property')
        delete node['__proto__']
      }
      if (constructorAction !== 'ignore' && Object.hasOwn(node, 'constructor')) {
        const ctor = node['constructor']
        if (ctor !== null && ctor !== undefined && typeof ctor === 'object' && !Array.isArray(ctor) && Object.hasOwn(ctor, 'prototype')) {
          if (safe === true) return null
          else if (constructorAction === 'error') throw new SyntaxError('Object contains forbidden prototype property')
          delete node['constructor']
        }
      }
      for (const key in node) pushQueryChildren(node[key], next)
    }
  }
  return obj
}

function pushQueryChildren(value: ParsedElement, next: ParsedQs[]): void {
  if (value === null || value === undefined || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const element of value) pushQueryChildren(element, next)
  } else {
    next.push(value)
  }
}

export function parse(text: string | Buffer, options?: ParseOptions): unknown
export function parse(text: string | Buffer, reviver?: Reviver | null, options?: ParseOptions): unknown
export function parse(text: string | Buffer, reviver?: Reviver | null | ParseOptions, options?: ParseOptions): unknown {
  return parseInternal(text, reviver, options)
}

export function safeParse(text: string | Buffer, reviver?: Reviver | null): unknown {
  try {
    return parseInternal(text, reviver, { safe: true })
  } catch {
    return undefined
  }
}

const secureJson = { parse, safeParse, scan }
export default secureJson
