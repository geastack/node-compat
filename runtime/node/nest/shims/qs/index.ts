
export type Charset = 'utf-8' | 'iso-8859-1'

export type DefaultDecoder = (str: string, defaultDecoder: undefined, charset?: Charset) => string

export type Decoder = (str: string, defaultDecoder: DefaultDecoder, charset: Charset, type: 'key' | 'value') => string | null

export interface ParseOptions {
  allowPrototypes?: boolean
  arrayLimit?: number
  depth?: number | false
  charset?: Charset
  charsetSentinel?: boolean
  interpretNumericEntities?: boolean
  decoder?: Decoder
  parameterLimit?: number
  strictDepth?: boolean
}

export type ParsedValue = string | null | ParsedQs | ParsedElement[]
export type ParsedElement = ParsedValue | undefined
export interface ParsedQs {
  [key: string]: ParsedValue | undefined
}

interface Options {
  allowPrototypes: boolean
  arrayLimit: number
  depth: number
  charset: Charset
  charsetSentinel: boolean
  interpretNumericEntities: boolean
  decoder: Decoder | undefined
  parameterLimit: number
  strictDepth: boolean
}

export const OBJECT_PROTOTYPE_KEYS: readonly string[] = [
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__',
  'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString'
]
const isObjectPrototypeKey = (key: string): boolean => OBJECT_PROTOTYPE_KEYS.indexOf(key) !== -1

export const defaultDecoder: DefaultDecoder = (str, _defaultDecoder, charset) => {
  const strWithoutPlus = str.replace(/\+/g, ' ')
  if (charset === 'iso-8859-1') {
    return strWithoutPlus.replace(/%[0-9a-f]{2}/gi, (sequence) => String.fromCharCode(parseInt(sequence.slice(1), 16)))
  }
  try {
    return decodeURIComponent(strWithoutPlus)
  } catch {
    return strWithoutPlus
  }
}

const defaults: Options = {
  allowPrototypes: false,
  arrayLimit: 20,
  depth: 5,
  charset: 'utf-8',
  charsetSentinel: false,
  interpretNumericEntities: false,
  decoder: undefined,
  parameterLimit: 1000,
  strictDepth: false
}

const overflowIndexes = new WeakMap<object, number>()
const markOverflow = (obj: ParsedQs, maxIndex: number): ParsedQs => {
  overflowIndexes.set(obj, maxIndex)
  return obj
}
const isOverflow = (obj: object): boolean => overflowIndexes.has(obj)
const getMaxIndex = (obj: object): number => overflowIndexes.get(obj) ?? -1
const setMaxIndex = (obj: object, maxIndex: number): void => {
  overflowIndexes.set(obj, maxIndex)
}

const isPlainObject = (value: ParsedElement): value is ParsedQs => value !== null && typeof value === 'object' && !Array.isArray(value)

const interpretNumericEntities = (str: string): string =>
  str.replace(/&#(\d+);/g, (_match, numberStr: string) => String.fromCharCode(parseInt(numberStr, 10)))

const isoSentinel = 'utf8=%26%2310003%3B'

const charsetSentinel = 'utf8=%E2%9C%93'

const arrayToObject = (source: ParsedElement[]): ParsedQs => {
  const obj: ParsedQs = {}
  for (let i = 0; i < source.length; ++i) {
    const element = source[i]
    if (element !== undefined) obj[String(i)] = element
  }
  return obj
}

const concatValues = (a: ParsedElement, b: ParsedElement): ParsedElement[] => {
  const result: ParsedElement[] = []
  if (Array.isArray(a)) for (const element of a) result.push(element)
  else result.push(a)
  if (Array.isArray(b)) for (const element of b) result.push(element)
  else result.push(b)
  return result
}

const combine = (a: ParsedElement, b: ParsedElement, arrayLimit: number): ParsedValue => {
  if (isPlainObject(a) && isOverflow(a)) {
    const newIndex = getMaxIndex(a) + 1
    a[String(newIndex)] = b
    setMaxIndex(a, newIndex)
    return a
  }
  const result = concatValues(a, b)
  if (result.length > arrayLimit) return markOverflow(arrayToObject(result), result.length - 1)
  return result
}

const setElement = (target: ParsedElement[], index: number, element: ParsedElement): void => {
  while (target.length < index) target.push(undefined)
  if (index === target.length) target.push(element)
  else target[index] = element
}

const splitParameters = (str: string, limit: number | undefined): string[] => {
  if (limit === undefined) return str.split('&')
  const parts: string[] = []
  let start = 0
  while (parts.length < limit) {
    const end = str.indexOf('&', start)
    if (end === -1) {
      parts.push(str.slice(start))
      break
    }
    parts.push(str.slice(start, end))
    start = end + 1
  }
  return parts
}

const decodeWith = (options: Options, str: string, charset: Charset, type: 'key' | 'value'): string | null =>
  options.decoder === undefined ? defaultDecoder(str, undefined, charset) : options.decoder(str, defaultDecoder, charset, type)

const parseValues = (str: string, options: Options): Map<string, ParsedValue> => {
  const obj = new Map<string, ParsedValue>()

  const cleanStr = str.replace(/%5B/gi, '[').replace(/%5D/gi, ']')

  const limit = options.parameterLimit === Infinity ? undefined : options.parameterLimit
  const parts = splitParameters(cleanStr, limit)

  let skipIndex = -1
  let i: number

  let charset = options.charset
  if (options.charsetSentinel) {
    for (i = 0; i < parts.length; ++i) {
      if (parts[i].indexOf('utf8=') === 0) {
        if (parts[i] === charsetSentinel) charset = 'utf-8'
        else if (parts[i] === isoSentinel) charset = 'iso-8859-1'
        skipIndex = i
        break
      }
    }
  }

  for (i = 0; i < parts.length; ++i) {
    if (i === skipIndex) continue
    const part = parts[i]

    const bracketEqualsPos = part.indexOf(']=')
    const pos = bracketEqualsPos === -1 ? part.indexOf('=') : bracketEqualsPos + 1

    let key: string | null
    let val: ParsedValue = ''
    if (pos === -1) {
      key = decodeWith(options, part, charset, 'key')
      val = ''
    } else {
      key = decodeWith(options, part.slice(0, pos), charset, 'key')
      if (key !== null) {
        val = decodeWith(options, part.slice(pos + 1), charset, 'value')
      }
    }

    if (val && options.interpretNumericEntities && charset === 'iso-8859-1') {
      val = interpretNumericEntities(String(val))
    }

    if (key !== null) {
      if (obj.has(key)) {
        obj.set(key, combine(obj.get(key), val, options.arrayLimit))
      } else {
        obj.set(key, val)
      }
    }
  }

  return obj
}

const parseObject = (chain: string[], val: ParsedValue, options: Options): ParsedValue => {
  let leaf: ParsedValue = val

  for (let i = chain.length - 1; i >= 0; --i) {
    let obj: ParsedValue
    const root = chain[i]

    if (root === '[]') {
      obj = isPlainObject(leaf) && isOverflow(leaf) ? leaf : combine([], leaf, options.arrayLimit)
    } else {
      const cleanRoot = root.charAt(0) === '[' && root.charAt(root.length - 1) === ']' ? root.slice(1, -1) : root
      const decodedRoot = cleanRoot
      const index = parseInt(decodedRoot, 10)
      const isValidArrayIndex = !isNaN(index) && root !== decodedRoot && String(index) === decodedRoot && index >= 0
      if (isValidArrayIndex && index < options.arrayLimit) {
        const arr: ParsedElement[] = []
        setElement(arr, index, leaf)
        obj = arr
      } else if (isValidArrayIndex) {
        const overflow: ParsedQs = {}
        overflow[String(index)] = leaf
        obj = markOverflow(overflow, index)
      } else {
        const record: ParsedQs = {}
        if (decodedRoot !== '__proto__') record[decodedRoot] = leaf
        obj = record
      }
    }

    leaf = obj
  }

  return leaf
}

const splitKeyIntoSegments = (key: string, options: Options): string[] | undefined => {
  if (options.depth <= 0) {
    if (isObjectPrototypeKey(key) && !options.allowPrototypes) return undefined
    return [key]
  }

  const segments: string[] = []

  const first = key.indexOf('[')
  const parent = first >= 0 ? key.slice(0, first) : key
  if (parent) {
    if (isObjectPrototypeKey(parent) && !options.allowPrototypes) return undefined
    segments.push(parent)
  }

  const n = key.length
  let open = first
  let collected = 0

  while (open >= 0 && collected < options.depth) {
    let level = 1
    let i = open + 1
    let close = -1

    while (i < n && close < 0) {
      const cu = key.charCodeAt(i)
      if (cu === 0x5b) {
        level += 1
      } else if (cu === 0x5d) {
        level -= 1
        if (level === 0) close = i
      }
      i += 1
    }

    if (close < 0) {
      segments.push('[' + key.slice(open) + ']')
      return segments
    }

    const seg = key.slice(open, close + 1)
    const content = seg.slice(1, -1)
    if (isObjectPrototypeKey(content) && !options.allowPrototypes) return undefined

    segments.push(seg)
    collected += 1

    open = key.indexOf('[', close + 1)
  }

  if (open >= 0) {
    if (options.strictDepth === true) {
      throw new RangeError('Input depth exceeded depth option of ' + options.depth + ' and strictDepth is true')
    }
    segments.push('[' + key.slice(open) + ']')
  }

  return segments
}

const parseKeys = (givenKey: string, val: ParsedValue, options: Options): ParsedValue | undefined => {
  if (!givenKey) return undefined
  const keys = splitKeyIntoSegments(givenKey, options)
  if (!keys) return undefined
  return parseObject(keys, val, options)
}

const mergeIntoObject = (target: ParsedQs, source: ParsedQs | ParsedElement[], options: Options): ParsedQs => {
  const sourceIsOverflow = isOverflow(source)
  for (const key of Object.keys(source)) {
    const value: ParsedElement = Array.isArray(source) ? source[Number(key)] : source[key]
    if (value === undefined) continue
    const existing = target[key]
    if (existing !== undefined && Object.hasOwn(target, key)) target[key] = merge(existing, value, options)
    else target[key] = value
    if (sourceIsOverflow && !isOverflow(target)) markOverflow(target, getMaxIndex(source))
    if (isOverflow(target)) {
      const keyNum = parseInt(key, 10)
      if (String(keyNum) === key && keyNum >= 0 && keyNum > getMaxIndex(target)) setMaxIndex(target, keyNum)
    }
  }
  return target
}

const merge = (target: ParsedValue, source: ParsedValue | undefined, options: Options): ParsedValue => {
  if (!source) return target

  if (typeof source !== 'object') {
    if (Array.isArray(target)) {
      const nextIndex = target.length
      if (nextIndex >= options.arrayLimit) return markOverflow(arrayToObject(concatValues(target, source)), nextIndex)
      target.push(source)
    } else if (isPlainObject(target)) {
      if (isOverflow(target)) {
        const newIndex = getMaxIndex(target) + 1
        target[String(newIndex)] = source
        setMaxIndex(target, newIndex)
      } else {
        return [target, source]
      }
    } else {
      return [target, source]
    }
    return target
  }

  if (!target || typeof target !== 'object') {
    if (isPlainObject(source) && isOverflow(source)) {
      const result: ParsedQs = { 0: target }
      for (const oldKey of Object.keys(source)) result[String(parseInt(oldKey, 10) + 1)] = source[oldKey]
      return markOverflow(result, getMaxIndex(source) + 1)
    }
    const combined = concatValues(target, source)
    if (combined.length > options.arrayLimit) return markOverflow(arrayToObject(combined), combined.length - 1)
    return combined
  }

  if (Array.isArray(target) && Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) {
      const item = source[i]
      if (item === undefined) continue
      const targetItem = target[i]
      if (i < target.length && targetItem !== undefined) {
        if (typeof targetItem === 'object' && typeof item === 'object' && item !== null) {
          target[i] = merge(targetItem, item, options)
        } else {
          target.push(item)
        }
      } else {
        setElement(target, i, item)
      }
    }
    if (target.length > options.arrayLimit) return markOverflow(arrayToObject(target), target.length - 1)
    return target
  }

  const mergeTarget: ParsedQs = Array.isArray(target) ? arrayToObject(target) : target
  return mergeIntoObject(mergeTarget, source, options)
}

type Container = ParsedQs | ParsedElement[]
const readAt = (container: Container, key: string): ParsedElement => (Array.isArray(container) ? container[Number(key)] : container[key])
const writeAt = (container: Container, key: string, value: ParsedElement): void => {
  if (Array.isArray(container)) container[Number(key)] = value
  else container[key] = value
}

const compact = (value: ParsedQs): ParsedQs => {
  const root: ParsedQs = { o: value }
  const queue: { obj: Container; prop: string }[] = [{ obj: root, prop: 'o' }]

  for (let i = 0; i < queue.length; ++i) {
    const item = queue[i]
    const obj = readAt(item.obj, item.prop)
    if (obj === null || obj === undefined || typeof obj !== 'object') continue
    for (const key of Object.keys(obj)) {
      const val = readAt(obj, key)
      if (typeof val === 'object' && val !== null) queue.push({ obj, prop: key })
    }
  }

  while (queue.length > 1) {
    const item = queue.pop()!
    const obj = readAt(item.obj, item.prop)
    if (Array.isArray(obj)) {
      const compacted: ParsedElement[] = []
      for (let j = 0; j < obj.length; ++j) {
        if (obj[j] !== undefined) compacted.push(obj[j])
      }
      writeAt(item.obj, item.prop, compacted)
    }
  }
  return value
}

const normalizeParseOptions = (opts?: ParseOptions): Options => {
  if (!opts) return defaults

  if (typeof opts.decoder !== 'undefined' && typeof opts.decoder !== 'function') {
    throw new TypeError('Decoder has to be a function.')
  }
  if (typeof opts.charset !== 'undefined' && opts.charset !== 'utf-8' && opts.charset !== 'iso-8859-1') {
    throw new TypeError('The charset option must be either utf-8, iso-8859-1, or undefined')
  }
  const charset: Charset = typeof opts.charset === 'undefined' ? defaults.charset : opts.charset

  return {
    allowPrototypes: typeof opts.allowPrototypes === 'boolean' ? opts.allowPrototypes : defaults.allowPrototypes,
    arrayLimit: typeof opts.arrayLimit === 'number' ? opts.arrayLimit : defaults.arrayLimit,
    charset,
    charsetSentinel: typeof opts.charsetSentinel === 'boolean' ? opts.charsetSentinel : defaults.charsetSentinel,
    decoder: typeof opts.decoder === 'function' ? opts.decoder : defaults.decoder,
    depth: typeof opts.depth === 'number' || opts.depth === false ? Number(opts.depth) : defaults.depth,
    interpretNumericEntities:
      typeof opts.interpretNumericEntities === 'boolean' ? opts.interpretNumericEntities : defaults.interpretNumericEntities,
    parameterLimit: typeof opts.parameterLimit === 'number' ? opts.parameterLimit : defaults.parameterLimit,
    strictDepth: typeof opts.strictDepth === 'boolean' ? opts.strictDepth : defaults.strictDepth
  }
}

export function parse(str: string, opts?: ParseOptions): ParsedQs {
  const options = normalizeParseOptions(opts)

  if (str === '' || str === null || typeof str === 'undefined') return {}

  const tempObj = parseValues(str, options)
  let obj: ParsedQs = {}

  for (const [key, value] of tempObj) {
    const newObj = parseKeys(key, value, options)
    if (newObj === undefined) continue
    if (typeof newObj !== 'object' || newObj === null) {
      obj = mergeIntoObject(obj, { [key]: newObj }, options)
    } else {
      obj = mergeIntoObject(obj, newObj, options)
    }
  }

  return compact(obj)
}

const qs = { parse }
export default qs
