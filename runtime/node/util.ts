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
