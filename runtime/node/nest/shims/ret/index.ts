
export const types = {
  ROOT: 0,
  GROUP: 1,
  POSITION: 2,
  SET: 3,
  RANGE: 4,
  REPETITION: 5,
  REFERENCE: 6,
  CHAR: 7
} as const

export interface Root {
  type: typeof types.ROOT
  stack?: Token[]
  options?: Token[][]
  flags?: string[]
}

export interface Group {
  type: typeof types.GROUP
  stack?: Token[]
  options?: Token[][]
  remember: boolean
  followedBy?: boolean
  notFollowedBy?: boolean
  lookBehind?: boolean
  name?: string
}

export interface SetToken {
  type: typeof types.SET
  set: SetTokens
  not: boolean
}

export interface Range {
  type: typeof types.RANGE
  from: number
  to: number
}

export interface Repetition {
  type: typeof types.REPETITION
  min: number
  max: number
  value: Token
}

export type PositionValue = '$' | '^' | 'b' | 'B'

export interface Position {
  type: typeof types.POSITION
  value: PositionValue
}

export interface Reference {
  type: typeof types.REFERENCE
  value: number
}

export interface Char {
  type: typeof types.CHAR
  value: number
}

export type Token = Group | Position | SetToken | Range | Repetition | Reference | Char
export type Tokens = Root | Token
export type SetTokens = (Range | Char | SetToken)[]

type Clause = Root | Group

const INTS = (): SetTokens => [{ type: types.RANGE, from: 48, to: 57 }]
const WORDS = (): SetTokens => [
  { type: types.CHAR, value: 95 },
  { type: types.RANGE, from: 97, to: 122 },
  { type: types.RANGE, from: 65, to: 90 },
  { type: types.RANGE, from: 48, to: 57 }
]
const WHITESPACE = (): SetTokens => [
  { type: types.CHAR, value: 9 },
  { type: types.CHAR, value: 10 },
  { type: types.CHAR, value: 11 },
  { type: types.CHAR, value: 12 },
  { type: types.CHAR, value: 13 },
  { type: types.CHAR, value: 32 },
  { type: types.CHAR, value: 160 },
  { type: types.CHAR, value: 5760 },
  { type: types.RANGE, from: 8192, to: 8202 },
  { type: types.CHAR, value: 8232 },
  { type: types.CHAR, value: 8233 },
  { type: types.CHAR, value: 8239 },
  { type: types.CHAR, value: 8287 },
  { type: types.CHAR, value: 12288 },
  { type: types.CHAR, value: 65279 }
]
const NOTANYCHAR = (): SetTokens => [
  { type: types.CHAR, value: 10 },
  { type: types.CHAR, value: 13 },
  { type: types.CHAR, value: 8232 },
  { type: types.CHAR, value: 8233 }
]

export const words = (): SetToken => ({ type: types.SET, set: WORDS(), not: false })
export const notWords = (): SetToken => ({ type: types.SET, set: WORDS(), not: true })
export const ints = (): SetToken => ({ type: types.SET, set: INTS(), not: false })
export const notInts = (): SetToken => ({ type: types.SET, set: INTS(), not: true })
export const whitespace = (): SetToken => ({ type: types.SET, set: WHITESPACE(), not: false })
export const notWhitespace = (): SetToken => ({ type: types.SET, set: WHITESPACE(), not: true })
export const anyChar = (): SetToken => ({ type: types.SET, set: NOTANYCHAR(), not: true })

const CTRL = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^ ?'
const SPECIAL_REGEX_CHAR = /[[\]{}^$.|?*+()]/
const CHARS_REGEX = /(\[\\b\])|(\\)?\\(?:u([A-F0-9]{4})|x([A-F0-9]{2})|c([@A-Z[\\\]^?])|([0tnvfr]))/g

const escapeCode = (eslsh: string): number => {
  switch (eslsh) {
    case '0':
      return 0
    case 't':
      return 9
    case 'n':
      return 10
    case 'v':
      return 11
    case 'f':
      return 12
    default:
      return 13
  }
}

const charReplacement = (rs: RegExpExecArray): string => {
  const s = rs[0]
  const b = rs[1]
  const lbs = rs[2]
  const a16 = rs[3]
  const b16 = rs[4]
  const dctrl = rs[5]
  const eslsh = rs[6]
  if (lbs) return s
  const code = b ? 8 : a16 ? parseInt(a16, 16) : b16 ? parseInt(b16, 16) : dctrl ? CTRL.indexOf(dctrl) : escapeCode(eslsh ?? '')
  const c = String.fromCharCode(code)
  return SPECIAL_REGEX_CHAR.test(c) ? `\\${c}` : c
}

export function strToChars(str: string): string {
  const regexp = new RegExp(CHARS_REGEX.source, 'g')
  let result = ''
  let last = 0
  let rs: RegExpExecArray | null
  while ((rs = regexp.exec(str)) !== null) {
    result += str.slice(last, rs.index) + charReplacement(rs)
    last = rs.index + rs[0].length
    if (rs[0].length === 0) regexp.lastIndex++
  }
  return result + str.slice(last)
}

const CLASS_REGEX = /\\(?:(w)|(d)|(s)|(W)|(D)|(S))|((?:(?:\\)(.)|([^\]\\]))-(((?:\\)])|(((?:\\)?([^\]])))))|(\])|(?:\\)?([^])/g

export function tokenizeClass(str: string, regexpStr: string): [SetTokens, number] {
  const tokens: SetTokens = []
  const regexp = new RegExp(CLASS_REGEX.source, 'g')
  let rs: RegExpExecArray | null
  while ((rs = regexp.exec(str)) !== null) {
    if (rs[1]) tokens.push(words())
    else if (rs[2]) tokens.push(ints())
    else if (rs[3]) tokens.push(whitespace())
    else if (rs[4]) tokens.push(notWords())
    else if (rs[5]) tokens.push(notInts())
    else if (rs[6]) tokens.push(notWhitespace())
    else if (rs[7]) {
      const from = rs[8] || rs[9] || ''
      const to = rs[10] ?? ''
      tokens.push({ type: types.RANGE, from: from.charCodeAt(0), to: to.charCodeAt(to.length - 1) })
    } else if (rs[16]) tokens.push({ type: types.CHAR, value: rs[16].charCodeAt(0) })
    else return [tokens, regexp.lastIndex]
  }
  throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: Unterminated character class`)
}

const captureGroupFirstChar = /^[a-zA-Z_$]$/i
const captureGroupChars = /^[a-zA-Z0-9_$]$/i
const digit = /\d/

interface QueuedReference {
  reference: Reference
  stack: Token[]
  index: number
}

const popValue = (stack: Token[], regexpStr: string, col: number): Token => {
  const value = stack.pop()
  if (value === undefined) throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: Nothing to repeat at column ${col - 1}`)
  return value
}

const REPETITION_RANGE = /^(\d+)(,(\d+)?)?\}/

export function tokenizer(regexpStr: string): Root {
  let i = 0
  let c: string
  const start: Root = { type: types.ROOT, stack: [] }
  let lastGroup: Clause = start
  let last: Token[] = start.stack ?? []
  const groupStack: Clause[] = []
  const referenceQueue: QueuedReference[] = []
  let groupCount = 0

  const str = strToChars(regexpStr)

  while (i < str.length) {
    switch ((c = str[i++] ?? '')) {
      case '\\':
        if (i === str.length) throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: \\ at end of pattern`)
        switch ((c = str[i++] ?? '')) {
          case 'b':
            last.push({ type: types.POSITION, value: 'b' })
            break
          case 'B':
            last.push({ type: types.POSITION, value: 'B' })
            break
          case 'w':
            last.push(words())
            break
          case 'W':
            last.push(notWords())
            break
          case 'd':
            last.push(ints())
            break
          case 'D':
            last.push(notInts())
            break
          case 's':
            last.push(whitespace())
            break
          case 'S':
            last.push(notWhitespace())
            break
          default:
            if (digit.test(c)) {
              let digits = c
              while (i < str.length && digit.test(str[i] ?? '')) digits += str[i++]
              const reference: Reference = { type: types.REFERENCE, value: parseInt(digits, 10) }
              last.push(reference)
              referenceQueue.push({ reference, stack: last, index: last.length - 1 })
            } else {
              last.push({ type: types.CHAR, value: c.charCodeAt(0) })
            }
        }
        break

      case '^':
        last.push({ type: types.POSITION, value: '^' })
        break
      case '$':
        last.push({ type: types.POSITION, value: '$' })
        break

      case '[': {
        let not: boolean
        if (str[i] === '^') {
          not = true
          i++
        } else {
          not = false
        }
        const classTokens = tokenizeClass(str.slice(i), regexpStr)
        i += classTokens[1]
        last.push({ type: types.SET, set: classTokens[0], not })
        break
      }

      case '.':
        last.push(anyChar())
        break

      case '(': {
        const group: Group = { type: types.GROUP, stack: [], remember: true }
        if (str[i] === '?') {
          c = str[i + 1] ?? ''
          i += 2
          if (c === '=') {
            group.followedBy = true
            group.remember = false
          } else if (c === '!') {
            group.notFollowedBy = true
            group.remember = false
          } else if (c === '<') {
            let name = ''
            if (captureGroupFirstChar.test(str[i] ?? '')) {
              name += str[i]
              i++
            } else {
              throw new SyntaxError(
                `Invalid regular expression: /${regexpStr}/: Invalid capture group name, character '${str[i]}' after '<' at column ${i + 1}`
              )
            }
            while (i < str.length && captureGroupChars.test(str[i] ?? '')) {
              name += str[i]
              i++
            }
            if (!name) {
              throw new SyntaxError(
                `Invalid regular expression: /${regexpStr}/: Invalid capture group name, character '${str[i]}' after '<' at column ${i + 1}`
              )
            }
            if (str[i] !== '>') {
              throw new SyntaxError(
                `Invalid regular expression: /${regexpStr}/: Unclosed capture group name, expected '>', found '${str[i]}' at column ${i + 1}`
              )
            }
            group.name = name
            i++
          } else if (c === ':') {
            group.remember = false
          } else {
            throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: Invalid group, character '${c}' after '?' at column ${i - 1}`)
          }
        } else {
          groupCount += 1
        }
        last.push(group)
        groupStack.push(lastGroup)
        lastGroup = group
        last = group.stack ?? []
        break
      }

      case ')': {
        const previous = groupStack.pop()
        if (previous === undefined) throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: Unmatched ) at column ${i - 1}`)
        lastGroup = previous
        const options = lastGroup.options
        last = options ? (options[options.length - 1] ?? []) : (lastGroup.stack ?? [])
        break
      }

      case '|': {
        if (!lastGroup.options) {
          lastGroup.options = [lastGroup.stack ?? []]
          lastGroup.stack = undefined
        }
        const stack: Token[] = []
        lastGroup.options.push(stack)
        last = stack
        break
      }

      case '{': {
        const rs = REPETITION_RANGE.exec(str.slice(i))
        if (rs !== null) {
          const min = parseInt(rs[1] ?? '', 10)
          const max = rs[2] ? (rs[3] ? parseInt(rs[3], 10) : Infinity) : min
          const value = popValue(last, regexpStr, i)
          i += rs[0].length
          last.push({ type: types.REPETITION, min, max, value })
        } else {
          last.push({ type: types.CHAR, value: 123 })
        }
        break
      }
      case '?':
        last.push({ type: types.REPETITION, min: 0, max: 1, value: popValue(last, regexpStr, i) })
        break
      case '+':
        last.push({ type: types.REPETITION, min: 1, max: Infinity, value: popValue(last, regexpStr, i) })
        break
      case '*':
        last.push({ type: types.REPETITION, min: 0, max: Infinity, value: popValue(last, regexpStr, i) })
        break

      default:
        last.push({ type: types.CHAR, value: c.charCodeAt(0) })
    }
  }

  if (groupStack.length !== 0) throw new SyntaxError(`Invalid regular expression: /${regexpStr}/: Unterminated group`)

  updateReferences(referenceQueue, groupCount)
  return start
}

const OCTAL = /^[0-7]+$/

function updateReferences(referenceQueue: QueuedReference[], groupCount: number): void {
  for (const elem of referenceQueue.reverse()) {
    if (groupCount >= elem.reference.value) continue
    const valueString = elem.reference.value.toString()
    const replacement: Char = { type: types.CHAR, value: parseInt(valueString, 8) }
    elem.stack[elem.index] = replacement
    if (!OCTAL.test(valueString)) {
      let i = 0
      while (valueString[i] !== '8' && valueString[i] !== '9') i += 1
      if (i === 0) {
        replacement.value = valueString.charCodeAt(0)
        i += 1
      } else {
        replacement.value = parseInt(valueString.slice(0, i), 8)
      }
      if (valueString.length > i) {
        const tail = elem.stack.splice(elem.index + 1)
        for (const char of valueString.slice(i)) elem.stack.push({ type: types.CHAR, value: char.charCodeAt(0) })
        for (const token of tail) elem.stack.push(token)
      }
    }
  }
}

export default tokenizer
