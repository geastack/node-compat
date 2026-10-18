
export interface ParsedQuery {
  [key: string]: string | string[]
}

export type StringifyValue = string | number | boolean | bigint
export type StringifyField = StringifyValue | readonly StringifyValue[] | null | undefined

export interface StringifyInput {
  [key: string]: StringifyField
}

const UTF8_ACCEPT = 12
const UTF8_REJECT = 0
// prettier-ignore
const UTF8_DATA: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 7,
  10, 9, 9, 9, 11, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,

  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  12, 0, 0, 0, 0, 24, 36, 48, 60, 72, 84, 96,
  0, 12, 12, 12, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 24, 24, 24, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 24, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 48, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

  0x7f, 0x3f, 0x3f, 0x3f, 0x00, 0x1f, 0x0f, 0x0f, 0x0f, 0x07, 0x07, 0x07
]

function hexCodeToInt(code: number, shift: number): number {
  if (code >= 48 && code <= 57) return (code - 48) << shift
  if (code >= 97 && code <= 102) return (code - 87) << shift
  if (code >= 65 && code <= 70) return (code - 55) << shift
  return 255
}

export function decodeURIComponent(uri: string): string | null {
  let percentPosition = uri.indexOf('%')
  if (percentPosition === -1) return uri

  const length = uri.length
  let decoded = ''
  let last = 0
  let codepoint = 0
  let startOfOctets = percentPosition
  let state = UTF8_ACCEPT

  while (percentPosition > -1 && percentPosition < length) {
    const high = hexCodeToInt(uri.charCodeAt(percentPosition + 1), 4)
    const low = hexCodeToInt(uri.charCodeAt(percentPosition + 2), 0)
    const byte = high | low
    const type = UTF8_DATA[byte]
    state = UTF8_DATA[256 + state + type]
    codepoint = (codepoint << 6) | (byte & UTF8_DATA[364 + type])

    if (state === UTF8_ACCEPT) {
      decoded += uri.slice(last, startOfOctets)
      decoded += codepoint <= 0xffff ? String.fromCharCode(codepoint) : String.fromCharCode(0xd7c0 + (codepoint >> 10), 0xdc00 + (codepoint & 0x3ff))
      codepoint = 0
      last = percentPosition + 3
      percentPosition = startOfOctets = uri.indexOf('%', last)
    } else if (state === UTF8_REJECT) {
      return null
    } else {
      percentPosition += 3
      if (percentPosition < length && uri.charCodeAt(percentPosition) === 37) continue
      return null
    }
  }

  return decoded + uri.slice(last)
}

const plusRegex = /\+/g

function decodeOrKeep(text: string): string {
  const decoded = decodeURIComponent(text)
  return decoded === null || decoded === '' ? text : decoded
}

export function parse(input: string): ParsedQuery {
  const result: ParsedQuery = {}

  const inputLength = input.length
  let key = ''
  let value = ''
  let startingIndex = -1
  let equalityIndex = -1
  let shouldDecodeKey = false
  let shouldDecodeValue = false
  let keyHasPlus = false
  let valueHasPlus = false
  let hasBothKeyValuePair = false
  let c = 0

  for (let i = 0; i < inputLength + 1; i++) {
    c = i !== inputLength ? input.charCodeAt(i) : 38

    if (c === 38) {
      hasBothKeyValuePair = equalityIndex > startingIndex

      if (!hasBothKeyValuePair) {
        equalityIndex = i
      }

      key = input.slice(startingIndex + 1, equalityIndex)

      if ((hasBothKeyValuePair || key.length > 0) && key !== '__proto__') {
        if (keyHasPlus) {
          key = key.replace(plusRegex, ' ')
        }

        if (shouldDecodeKey) {
          key = decodeOrKeep(key)
        }

        if (hasBothKeyValuePair) {
          value = input.slice(equalityIndex + 1, i)

          if (valueHasPlus) {
            value = value.replace(plusRegex, ' ')
          }

          if (shouldDecodeValue) {
            value = decodeOrKeep(value)
          }
        }
        const currentValue: string | string[] | undefined = Object.hasOwn(result, key) ? result[key] : undefined

        if (currentValue === undefined) {
          result[key] = value
        } else if (Array.isArray(currentValue)) {
          currentValue.push(value)
        } else {
          result[key] = [currentValue, value]
        }
      }

      value = ''
      startingIndex = i
      equalityIndex = i
      shouldDecodeKey = false
      shouldDecodeValue = false
      keyHasPlus = false
      valueHasPlus = false
    }
    else if (c === 61) {
      if (equalityIndex <= startingIndex) {
        equalityIndex = i
      }
      else {
        shouldDecodeValue = true
      }
    }
    else if (c === 43) {
      if (equalityIndex > startingIndex) {
        valueHasPlus = true
      } else {
        keyHasPlus = true
      }
    }
    else if (c === 37) {
      if (equalityIndex > startingIndex) {
        shouldDecodeValue = true
      } else {
        shouldDecodeKey = true
      }
    }
  }

  return result
}

const hexTable: string[] = []
for (let i = 0; i < 256; i++) hexTable.push('%' + ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase())

// prettier-ignore
const noEscape: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0
]

export function encodeString(str: string): string {
  const len = str.length
  if (len === 0) return ''

  let out = ''
  let lastPos = 0
  let i = 0

  outer: for (; i < len; i++) {
    let c = str.charCodeAt(i)

    while (c < 0x80) {
      if (noEscape[c] !== 1) {
        if (lastPos < i) out += str.slice(lastPos, i)
        lastPos = i + 1
        out += hexTable[c]
      }

      if (++i === len) break outer

      c = str.charCodeAt(i)
    }

    if (lastPos < i) out += str.slice(lastPos, i)

    if (c < 0x800) {
      lastPos = i + 1
      out += hexTable[0xc0 | (c >> 6)] + hexTable[0x80 | (c & 0x3f)]
      continue
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1
      out += hexTable[0xe0 | (c >> 12)] + hexTable[0x80 | ((c >> 6) & 0x3f)] + hexTable[0x80 | (c & 0x3f)]
      continue
    }
    ++i

    if (i >= len) {
      throw new Error('URI malformed')
    }

    const c2 = str.charCodeAt(i) & 0x3ff

    lastPos = i + 1
    c = 0x10000 + (((c & 0x3ff) << 10) | c2)
    out += hexTable[0xf0 | (c >> 18)] + hexTable[0x80 | ((c >> 12) & 0x3f)] + hexTable[0x80 | ((c >> 6) & 0x3f)] + hexTable[0x80 | (c & 0x3f)]
  }
  if (lastPos === 0) return str
  if (lastPos < len) return out + str.slice(lastPos)
  return out
}

function getAsPrimitive(value: StringifyValue | null | undefined): string {
  if (typeof value === 'string') {
    return encodeString(value)
  } else if (typeof value === 'bigint') {
    return value.toString()
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e21 ? '' + value : encodeString('' + value)
  }

  return ''
}

function isValueList(value: StringifyField): value is readonly StringifyValue[] {
  return Array.isArray(value)
}

export function stringify(input: StringifyInput): string {
  let result = ''

  const separator = '&'
  const keys = Object.keys(input)
  const keyLength = keys.length
  let valueLength = 0

  for (let i = 0; i < keyLength; i++) {
    const key = keys[i]
    const value = input[key]
    const encodedKey = encodeString(key) + '='

    if (i) {
      result += separator
    }

    if (isValueList(value)) {
      valueLength = value.length
      for (let j = 0; j < valueLength; j++) {
        if (j) {
          result += separator
        }

        result += encodedKey
        result += getAsPrimitive(value[j])
      }
    } else {
      result += encodedKey
      result += getAsPrimitive(value)
    }
  }

  return result
}
