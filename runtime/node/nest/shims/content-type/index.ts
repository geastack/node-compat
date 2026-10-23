
const TEXT_REGEXP = /^[\u0009\u0020-\u007e\u0080-\u00ff]*$/
const TOKEN_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const QUOTE_REGEXP = /[\\"]/g
const TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export interface ContentType {
  type: string
  index: number
  parameters: ContentTypeParameters
}

export interface ContentTypeParameters {
  [name: string]: string
}

export interface ContentTypeInput {
  type?: string
  parameters?: ContentTypeParameters
}

export interface ParseOptions {
  parameters?: boolean
  comma?: boolean
  start?: number
}

export function format(obj: ContentTypeInput): string {
  const type = obj.type
  const parameters = obj.parameters

  if (!type || !TYPE_REGEXP.test(type)) {
    throw new TypeError(`Invalid type: ${type}`)
  }

  let result = type

  if (parameters) {
    for (const param of Object.keys(parameters)) {
      if (!TOKEN_REGEXP.test(param)) {
        throw new TypeError(`Invalid parameter name: ${param}`)
      }
      result += `; ${param}=${qstring(parameters[param])}`
    }
  }

  return result
}

const SP = 32
const HTAB = 9
const SEMI = 59
const EQ = 61
const DQUOTE = 34
const BSLASH = 92
const COMMA = 44
const NO_STOP_CHAR = 65_536

export function parse(header: string, options?: ParseOptions): ContentType {
  const stopChar = options?.comma === true ? COMMA : NO_STOP_CHAR
  const len = header.length
  let index = skipOWS(header, options?.start ?? 0, len)

  const valueStart = index
  index = skipValue(header, index, len, stopChar)
  const valueEnd = trailingOWS(header, valueStart, index)
  const type = header.slice(valueStart, valueEnd).toLowerCase()

  if (options?.parameters === false) {
    return { type, index, parameters: {} }
  }

  return parseParameters(header, type, index, len, stopChar)
}

function parseParameters(header: string, type: string, index: number, len: number, stopChar: number): ContentType {
  const parameters: ContentTypeParameters = {}

  parameter: while (index < len) {
    if (header.charCodeAt(index) === stopChar) break

    index = skipOWS(header, index + 1, len)

    const keyStart = index

    while (index < len) {
      const code = header.charCodeAt(index)
      if (code === stopChar) break parameter

      if (code === SEMI) continue parameter

      if (code === EQ) {
        const keyEnd = trailingOWS(header, keyStart, index)
        const key = header.slice(keyStart, keyEnd).toLowerCase()

        index = skipOWS(header, index + 1, len)

        if (index < len && header.charCodeAt(index) === DQUOTE) {
          index++

          let value = ''
          while (index < len) {
            const code = header.charCodeAt(index++)
            if (code === DQUOTE) {
              index = skipValue(header, index, len, stopChar)
              if (!Object.hasOwn(parameters, key)) parameters[key] = value
              break
            }

            if (code === BSLASH && index < len) {
              value += header[index++]
              continue
            }

            value += String.fromCharCode(code)
          }

          continue parameter
        }

        const valueStart = index
        index = skipValue(header, index, len, stopChar)

        if (!Object.hasOwn(parameters, key)) {
          const valueEnd = trailingOWS(header, valueStart, index)
          parameters[key] = header.slice(valueStart, valueEnd)
        }

        continue parameter
      }

      index++
    }
  }

  return { type, index, parameters }
}

function skipValue(str: string, index: number, len: number, stopChar: number): number {
  while (index < len) {
    const code = str.charCodeAt(index)
    if (code === SEMI || code === stopChar) break
    index++
  }
  return index
}

function skipOWS(header: string, index: number, len: number): number {
  while (index < len) {
    const char = header.charCodeAt(index)
    if (char !== SP && char !== HTAB) break
    index++
  }
  return index
}

function trailingOWS(header: string, start: number, end: number): number {
  while (end > start) {
    const char = header.charCodeAt(end - 1)
    if (char !== SP && char !== HTAB) break
    end--
  }
  return end
}

function qstring(str: string): string {
  if (TOKEN_REGEXP.test(str)) return str
  if (TEXT_REGEXP.test(str)) return `"${str.replace(QUOTE_REGEXP, '\\$&')}"`

  throw new TypeError(`Invalid parameter value: ${str}`)
}
