
const DEFAULT_DELIMITER = '/'
const NOOP_VALUE = (value: string): string => value
const ID_START = /^[$_A-Za-z]$/
const ID_CONTINUE = /^[$‌‍0-9A-Za-z_]$/
const ID = /^[$_A-Za-z][$‌‍0-9A-Za-z_]*$/

export type Encode = (value: string) => string

export type Decode = (value: string) => string

export interface ParseOptions {
  encodePath?: Encode
}

export interface PathToRegexpOptions {
  end?: boolean
  trailing?: boolean
  sensitive?: boolean
  delimiter?: string
}

export interface MatchOptions extends PathToRegexpOptions {
  decode?: Decode | false
}

export interface CompileOptions {
  encode?: Encode | false
  delimiter?: string
}

export interface CompileAndParseOptions extends CompileOptions, ParseOptions {}

export interface MatchAndParseOptions extends MatchOptions, ParseOptions {}

export interface PathToRegexpAndParseOptions extends PathToRegexpOptions, ParseOptions {}

function escapeText(str: string): string {
  return str.replace(/[{}()\[\]+?!:*\\]/g, '\\$&')
}

function escape(str: string): string {
  return str.replace(/[.+*?^${}()[\]|/\\]/g, '\\$&')
}

export interface Text {
  type: 'text'
  value: string
}

export interface Parameter {
  type: 'param'
  name: string
}

export interface Wildcard {
  type: 'wildcard'
  name: string
}

export interface Group {
  type: 'group'
  tokens: Token[]
}

export type Key = Parameter | Wildcard

export type Keys = Key[]

export type Token = Text | Parameter | Wildcard | Group

export type FlatToken = Text | Parameter | Wildcard

export class TokenData {
  readonly tokens: Token[]
  readonly originalPath: string | undefined

  constructor(tokens: Token[], originalPath?: string) {
    this.tokens = tokens
    this.originalPath = originalPath
  }
}

export class PathError extends TypeError {
  readonly originalPath: string | undefined

  constructor(message: string, originalPath: string | undefined) {
    let text = message
    if (originalPath) text += `: ${originalPath}`
    text += '; visit https://git.new/pathToRegexpError for info'
    super(text)
    this.originalPath = originalPath
  }
}

function codePoints(str: string): string[] {
  const chars: string[] = []
  let index = 0
  while (index < str.length) {
    const code = str.codePointAt(index) ?? 0
    const width = code > 0xffff ? 2 : 1
    chars.push(str.slice(index, index + width))
    index += width
  }
  return chars
}

export function parse(str: string, options: ParseOptions = {}): TokenData {
  const encodePath = options.encodePath ?? NOOP_VALUE
  const chars = codePoints(str)
  let index = 0

  function consumeUntil(end: string): Token[] {
    const output: Token[] = []
    let path = ''

    function writePath(): void {
      if (!path) return
      output.push({ type: 'text', value: encodePath(path) })
      path = ''
    }

    while (index < chars.length) {
      const value = chars[index++]

      if (value === end) {
        writePath()
        return output
      }

      if (value === '\\') {
        if (index === chars.length) {
          throw new PathError(`Unexpected end after \\ at index ${index}`, str)
        }

        path += chars[index++]
        continue
      }

      if (value === ':' || value === '*') {
        let name = ''

        if (index < chars.length && ID_START.test(chars[index])) {
          do {
            name += chars[index++]
          } while (index < chars.length && ID_CONTINUE.test(chars[index]))
        } else if (index < chars.length && chars[index] === '"') {
          let quoteStart = index

          while (index < chars.length) {
            if (chars[++index] === '"') {
              index++
              quoteStart = 0
              break
            }

            if (chars[index] === '\\') index++

            if (index < chars.length) name += chars[index]
          }

          if (quoteStart) {
            throw new PathError(`Unterminated quote at index ${quoteStart}`, str)
          }
        }

        if (!name) {
          throw new PathError(`Missing parameter name at index ${index}`, str)
        }

        writePath()
        if (value === ':') output.push({ type: 'param', name })
        else output.push({ type: 'wildcard', name })
        continue
      }

      if (value === '{') {
        writePath()
        output.push({ type: 'group', tokens: consumeUntil('}') })
        continue
      }

      if (value === '}' || value === '(' || value === ')' || value === '[' || value === ']' || value === '+' || value === '?' || value === '!') {
        throw new PathError(`Unexpected ${value} at index ${index - 1}`, str)
      }

      path += value
    }

    if (end) {
      throw new PathError(`Unexpected end at index ${index}, expected ${end}`, str)
    }

    writePath()
    return output
  }

  return new TokenData(consumeUntil(''), str)
}

export interface ParamData {
  [name: string]: string | string[] | undefined
}

export type PathFunction = (data?: ParamData) => string

export function compile(path: Path, options: CompileAndParseOptions = {}): PathFunction {
  const encode = options.encode === undefined ? encodeURIComponent : options.encode
  const delimiter = options.delimiter ?? DEFAULT_DELIMITER
  const data = toTokenData(path, options)
  const fn = tokensToFunction(data.tokens, delimiter, encode)

  return function build(params: ParamData = {}): string {
    const missing: string[] = []
    const result = fn(params, missing)

    if (missing.length) {
      throw new TypeError(`Missing parameters: ${missing.join(', ')}`)
    }

    return result
  }
}

type TokenEncoder = (data: ParamData, missing: string[]) => string

function tokensToFunction(tokens: Token[], delimiter: string, encode: Encode | false): TokenEncoder {
  const encoders = tokens.map((token) => tokenToFunction(token, delimiter, encode))

  return (data: ParamData, missing: string[]) => {
    let result = ''

    for (const encoder of encoders) {
      result += encoder(data, missing)
    }

    return result
  }
}

function isList(value: string | string[]): value is string[] {
  return Array.isArray(value)
}

function tokenToFunction(token: Token, delimiter: string, encode: Encode | false): TokenEncoder {
  if (token.type === 'text') {
    const text = token.value
    return () => text
  }

  if (token.type === 'group') {
    const fn = tokensToFunction(token.tokens, delimiter, encode)

    return (data, missing) => {
      const len = missing.length
      const value = fn(data, missing)
      if (missing.length === len) return value

      missing.length = len
      return ''
    }
  }

  const encodeValue = encode || NOOP_VALUE
  const name = token.name

  if (token.type === 'wildcard' && encode !== false) {
    return (data, missing) => {
      const value = data[name]
      if (value == null) {
        missing.push(name)
        return ''
      }

      if (!isList(value) || value.length === 0) {
        throw new TypeError(`Expected "${name}" to be a non-empty array`)
      }

      let result = ''

      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
          throw new TypeError(`Expected "${name}/${i}" to be a string`)
        }

        if (i > 0) result += delimiter
        result += encodeValue(value[i])
      }

      return result
    }
  }

  return (data, missing) => {
    const value = data[name]
    if (value == null) {
      missing.push(name)
      return ''
    }

    if (typeof value !== 'string') {
      throw new TypeError(`Expected "${name}" to be a string`)
    }

    return encodeValue(value)
  }
}

type Decoder = (value: string) => string | string[]

export interface MatchParams {
  [name: string]: string | string[]
}

export interface MatchResult {
  path: string
  params: MatchParams
}

export type Match = false | MatchResult

export type MatchFunction = (path: string) => Match

export type Path = string | TokenData

function toTokenData(path: Path, options: ParseOptions): TokenData {
  return typeof path === 'string' ? parse(path, options) : path
}

export function match(path: Path | Path[], options: MatchAndParseOptions = {}): MatchFunction {
  const decoding = options.decode !== false
  const decode: Decode = options.decode === undefined ? decodeURIComponent : options.decode === false ? NOOP_VALUE : options.decode
  const delimiter = options.delimiter ?? DEFAULT_DELIMITER
  const { regexp, keys } = pathToRegexp(path, options)

  const decoders: Decoder[] = keys.map((key): Decoder => {
    if (!decoding) return (value: string): string | string[] => value
    if (key.type === 'param') return (value: string): string | string[] => decode(value)
    return (value: string): string | string[] => value.split(delimiter).map(decode)
  })

  return function matcher(input: string): Match {
    const m = regexp.exec(input)
    if (!m) return false

    const matched = m[0]
    const params: MatchParams = {}

    for (let i = 1; i < m.length; i++) {
      const captured = m[i]
      if (captured === undefined) continue

      const key = keys[i - 1]
      const decoder = decoders[i - 1]
      params[key.name] = decoder(captured)
    }

    return { path: matched, params }
  }
}

export interface PathRegExp {
  regexp: RegExp
  keys: Keys
}

export function pathToRegexp(path: Path | Path[], options: PathToRegexpAndParseOptions = {}): PathRegExp {
  const delimiter = options.delimiter ?? DEFAULT_DELIMITER
  const end = options.end ?? true
  const sensitive = options.sensitive ?? false
  const trailing = options.trailing ?? true
  const keys: Keys = []
  let source = ''
  let combinations = 0

  function processOne(single: Path): void {
    const data = toTokenData(single, options)
    flatten(data.tokens, 0, [], (tokens) => {
      if (combinations >= 256) {
        throw new PathError('Too many path combinations', data.originalPath)
      }

      if (combinations > 0) source += '|'
      source += toRegExpSource(tokens, delimiter, keys, data.originalPath)
      combinations++
    })
  }

  if (Array.isArray(path)) {
    for (const p of path) processOne(p)
  } else {
    processOne(path)
  }

  let pattern = `^(?:${source})`
  if (trailing) pattern += '(?:' + escape(delimiter) + '$)?'
  pattern += end ? '$' : '(?=' + escape(delimiter) + '|$)'

  return { regexp: new RegExp(pattern, sensitive ? '' : 'i'), keys }
}

function flatten(tokens: Token[], index: number, result: FlatToken[], callback: (result: FlatToken[]) => void): void {
  while (index < tokens.length) {
    const token = tokens[index++]

    if (token.type === 'group') {
      const len = result.length
      flatten(token.tokens, 0, result, (seq) => flatten(tokens, index, seq, callback))
      result.length = len
      continue
    }

    result.push(token)
  }

  callback(result)
}

function toRegExpSource(tokens: FlatToken[], delimiter: string, keys: Keys, originalPath: string | undefined): string {
  let result = ''
  let backtrack = ''
  let wildcardBacktrack = ''
  let prevCaptureType = 0
  let hasSegmentCapture = 0
  let index = 0

  function hasWildcardInSegment(from: number): boolean {
    while (from < tokens.length) {
      const token = tokens[from++]
      if (token.type === 'wildcard') return true
      if (token.type === 'text') {
        if (token.value.includes(delimiter)) break
      }
    }
    return false
  }

  function peekText(from: number): string {
    let text = ''
    while (from < tokens.length) {
      const token = tokens[from++]
      if (token.type !== 'text') break
      text += token.value
    }
    return text
  }

  while (index < tokens.length) {
    const token = tokens[index++]

    if (token.type === 'text') {
      result += escape(token.value)
      backtrack += token.value
      if (prevCaptureType === 2) wildcardBacktrack += token.value
      if (token.value.includes(delimiter)) hasSegmentCapture = 0
      continue
    }

    if (prevCaptureType && !backtrack) {
      throw new PathError(`Missing text before "${token.name}" ${token.type}`, originalPath)
    }

    if (token.type === 'param') {
      result +=
        hasSegmentCapture & 2
          ? `(${negate(delimiter, backtrack)}+)`
          : hasWildcardInSegment(index)
            ? `(${negate(delimiter, peekText(index))}+)`
            : hasSegmentCapture & 1
              ? `(${negate(delimiter, backtrack)}+|${escape(backtrack)})`
              : `(${negate(delimiter, '')}+)`

      prevCaptureType = 1
      hasSegmentCapture |= 1
    } else {
      result +=
        hasSegmentCapture & 2
          ? `(${negate(backtrack, '')}+)`
          : wildcardBacktrack
            ? `(${negate(wildcardBacktrack, '')}+|${negate(delimiter, '')}+)`
            : `([^]+)`

      wildcardBacktrack = ''
      prevCaptureType = 2
      hasSegmentCapture |= 2
    }

    keys.push(token)
    backtrack = ''
  }

  return result
}

function negate(a: string, b: string): string {
  if (b.length > a.length) return negate(b, a)

  if (a === b) b = ''
  if (b.length > 1) return `(?:(?!${escape(a)}|${escape(b)})[^])`
  if (a.length > 1) return `(?:(?!${escape(a)})[^${escape(b)}])`
  return `[^${escape(a + b)}]`
}

function stringifyTokens(tokens: Token[], index: number): string {
  let value = ''

  while (index < tokens.length) {
    const token = tokens[index++]

    if (token.type === 'text') {
      value += escapeText(token.value)
      continue
    }

    if (token.type === 'group') {
      value += '{' + stringifyTokens(token.tokens, 0) + '}'
      continue
    }

    if (token.type === 'param') {
      value += ':' + stringifyName(token.name, index < tokens.length ? tokens[index] : undefined)
      continue
    }

    value += '*' + stringifyName(token.name, index < tokens.length ? tokens[index] : undefined)
  }

  return value
}

export function stringify(data: TokenData): string {
  return stringifyTokens(data.tokens, 0)
}

function stringifyName(name: string, next: Token | undefined): string {
  if (!ID.test(name)) return JSON.stringify(name)

  if (next !== undefined && next.type === 'text' && ID_CONTINUE.test(next.value.charAt(0))) {
    return JSON.stringify(name)
  }

  return name
}
