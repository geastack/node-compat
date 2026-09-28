// Small typed node:util surface required by MongoDB's structured logger.
// `inspect` is intentionally a dynamic boundary: its public contract accepts
// arbitrary JavaScript values. Options remain a concrete record and the result
// is always a native string.

export interface InspectOptions {
  breakLength?: number
  colors?: boolean
  compact?: boolean | number
  customInspect?: boolean
  depth?: number | null
  getters?: boolean | 'get' | 'set'
  maxArrayLength?: number | null
  maxStringLength?: number | null
  numericSeparator?: boolean
  showHidden?: boolean
  showProxy?: boolean
  sorted?: boolean
}

function nodeUtilInspect(value: unknown, options?: InspectOptions): string {
  // The first native implementation only promises a deterministic printable
  // representation. MongoDB uses this on an opt-in logger path, not on BSON or
  // wire data. Keep the unused options typed so call sites do not become `any`.
  if (options?.colors === true) {
    throw new Error('util.inspect colors are not supported by the gea node-compat runtime')
  }
  return String(value)
}

export { nodeUtilInspect as inspect }

interface NodeArgumentError extends Error {
  code: string
}

function invalidArgType(name: string, expected: string, actual: undefined | null): never {
  const kind = name.includes('.') ? 'property' : 'argument'
  const received = actual === undefined ? 'undefined' : 'null'
  const error = new TypeError(`The "${name}" ${kind} must be of type ${expected}. Received ${received}`) as NodeArgumentError
  error.code = 'ERR_INVALID_ARG_TYPE'
  throw error
}

// Node's `util.inherits`: the constructor's own prototype object is re-parented
// in place, so members already assigned to it stay, and `super_` names the base.
export function inherits(ctor: Function, superCtor: Function): void {
  if (ctor === undefined || ctor === null) invalidArgType('ctor', 'function', ctor)
  if (superCtor === undefined || superCtor === null) invalidArgType('superCtor', 'function', superCtor)
  // Any object can be a prototype, so it crosses as the box `Function#prototype` reads.
  const superPrototype = superCtor.prototype
  if (superPrototype === undefined) invalidArgType('superCtor.prototype', 'object', undefined)
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true })
  Object.setPrototypeOf(ctor.prototype, superPrototype)
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : `${value}`
}

function stringifyOrCircular(value: unknown): string {
  try {
    return `${JSON.stringify(value)}`
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Converting circular structure')) return '[Circular]'
    throw error
  }
}

// `%s` renders an object through `inspect`, which on this target is the
// deterministic `String(value)` described above rather than Node's inspector.
function formatString(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value !== 'object' || value === null) return String(value)
  return nodeUtilInspect(value)
}

function formatInteger(value: unknown, parse: (text: string) => number): string {
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return 'NaN'
  return formatNumber(parse(String(value)))
}

// Node's `formatWithOptionsInternal`, directive by directive.
export function format(...args: unknown[]): string {
  const first = args[0]
  let used = 0
  let text = ''
  let join = ''
  if (typeof first === 'string') {
    if (args.length === 1) return first
    let lastPosition = 0
    for (let index = 0; index < first.length - 1; index++) {
      if (first.charCodeAt(index) !== 37) continue
      const next = first.charCodeAt(++index)
      if (used + 1 !== args.length) {
        let piece: string
        switch (next) {
          case 115:
            piece = formatString(args[++used])
            break
          case 106:
            piece = stringifyOrCircular(args[++used])
            break
          case 100: {
            const value = args[++used]
            piece = typeof value === 'bigint' ? `${value}n` : typeof value === 'symbol' ? 'NaN' : formatNumber(Number(value))
            break
          }
          case 79:
          case 111:
            piece = nodeUtilInspect(args[++used])
            break
          case 105:
            piece = formatInteger(args[++used], (value) => Number.parseInt(value))
            break
          case 102:
            piece = formatInteger(args[++used], (value) => Number.parseFloat(value))
            break
          case 99:
            used += 1
            piece = ''
            break
          case 37:
            text += first.slice(lastPosition, index)
            lastPosition = index + 1
            continue
          default:
            continue
        }
        if (lastPosition !== index - 1) text += first.slice(lastPosition, index - 1)
        text += piece
        lastPosition = index + 1
      } else if (next === 37) {
        text += first.slice(lastPosition, index)
        lastPosition = index + 1
      }
    }
    if (lastPosition !== 0) {
      used++
      join = ' '
      if (lastPosition < first.length) text += first.slice(lastPosition)
    }
  }
  while (used < args.length) {
    const value = args[used]
    text += join
    text += typeof value === 'string' ? value : nodeUtilInspect(value)
    join = ' '
    used++
  }
  return text
}

// `NODE_DEBUG` is a comma-separated list of section names, `*` matching any
// run of characters, compared case-insensitively.
function sectionPatternMatches(pattern: string, section: string): boolean {
  const parts = pattern.toUpperCase().split('*')
  const head = parts[0] ?? ''
  if (!section.startsWith(head)) return false
  if (parts.length === 1) return section.length === head.length
  let position = head.length
  for (let index = 1; index < parts.length - 1; index++) {
    const found = section.indexOf(parts[index] ?? '', position)
    if (found < 0) return false
    position = found + (parts[index] ?? '').length
  }
  const tail = parts[parts.length - 1] ?? ''
  return section.length - tail.length >= position && section.endsWith(tail)
}

function debugSectionEnabled(section: string): boolean {
  const setting = process.env['NODE_DEBUG']
  if (setting === undefined || setting === '') return false
  return setting.split(',').some((pattern) => sectionPatternMatches(pattern, section))
}

export type DebugLogger = (...args: unknown[]) => void

// Node's `util.debuglog`: the section is tested once, on first use, and an
// enabled logger writes `SECTION pid: message` to stderr (one string through
// `console.error` is that line, newline included).
export function debuglog(section: string, callback?: (logger: DebugLogger) => void): DebugLogger {
  let implementation: DebugLogger | undefined
  return (...args: unknown[]): void => {
    if (implementation === undefined) {
      const name = section.toUpperCase()
      const enabled = debugSectionEnabled(name)
      const pid = process.pid
      implementation = enabled ? (...message: unknown[]) => console.error(`${name} ${pid}: ${format(...message)}`) : () => {}
      if (callback !== undefined) callback(implementation)
    }
    implementation(...args)
  }
}
