
export interface ParseOptions {
  decode?: (value: string) => string
}

export interface SerializeOptions {
  encode?: (value: string) => string
  maxAge?: number
  domain?: string
  path?: string
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  partitioned?: boolean
  priority?: string
  sameSite?: boolean | string
}

const cookieNameRegExp = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const cookieValueRegExp = /^("?)[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]*\1$/

const domainValueRegExp = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const pathValueRegExp = /^[\u0020-\u003A\u003D-\u007E]*$/

export function parse(str: string, opt?: ParseOptions): { [name: string]: string } {
  if (typeof str !== 'string') throw new TypeError('argument str must be a string')

  const obj: { [name: string]: string } = {}
  const len = str.length
  if (len < 2) return obj

  const dec = (opt && opt.decode) || decode
  let index = 0
  let eqIdx = 0
  let endIdx = 0

  do {
    eqIdx = str.indexOf('=', index)
    if (eqIdx === -1) break

    endIdx = str.indexOf(';', index)

    if (endIdx === -1) {
      endIdx = len
    } else if (eqIdx > endIdx) {
      index = str.lastIndexOf(';', eqIdx - 1) + 1
      continue
    }

    const keyStartIdx = startIndex(str, index, eqIdx)
    const keyEndIdx = endIndex(str, eqIdx, keyStartIdx)
    const key = str.slice(keyStartIdx, keyEndIdx)

    if (!Object.hasOwn(obj, key)) {
      let valStartIdx = startIndex(str, eqIdx + 1, endIdx)
      let valEndIdx = endIndex(str, endIdx, valStartIdx)

      if (str.charCodeAt(valStartIdx) === 0x22 && str.charCodeAt(valEndIdx - 1) === 0x22) {
        valStartIdx++
        valEndIdx--
      }

      const val = str.slice(valStartIdx, valEndIdx)
      obj[key] = tryDecode(val, dec)
    }

    index = endIdx + 1
  } while (index < len)

  return obj
}

function startIndex(str: string, index: number, max: number): number {
  do {
    const code = str.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09) return index
  } while (++index < max)
  return max
}

function endIndex(str: string, index: number, min: number): number {
  while (index > min) {
    const code = str.charCodeAt(--index)
    if (code !== 0x20 && code !== 0x09) return index + 1
  }
  return min
}

export function serialize(name: string, val: string, opt?: SerializeOptions): string {
  const enc = (opt && opt.encode) || encodeURIComponent

  if (typeof enc !== 'function') throw new TypeError('option encode is invalid')
  if (!cookieNameRegExp.test(name)) throw new TypeError('argument name is invalid')

  const value = enc(val)
  if (!cookieValueRegExp.test(value)) throw new TypeError('argument val is invalid')

  let str = name + '=' + value
  if (!opt) return str

  if (opt.maxAge != null) {
    const maxAge = Math.floor(opt.maxAge)
    if (!isFinite(maxAge)) throw new TypeError('option maxAge is invalid')
    str += '; Max-Age=' + maxAge
  }

  if (opt.domain) {
    if (!domainValueRegExp.test(opt.domain)) throw new TypeError('option domain is invalid')
    str += '; Domain=' + opt.domain
  }

  if (opt.path) {
    if (!pathValueRegExp.test(opt.path)) throw new TypeError('option path is invalid')
    str += '; Path=' + opt.path
  }

  if (opt.expires) {
    const expires = opt.expires
    if (!(expires instanceof Date) || isNaN(expires.valueOf())) throw new TypeError('option expires is invalid')
    str += '; Expires=' + expires.toUTCString()
  }

  if (opt.httpOnly) str += '; HttpOnly'
  if (opt.secure) str += '; Secure'
  if (opt.partitioned) str += '; Partitioned'

  if (opt.priority) {
    const priority = typeof opt.priority === 'string' ? opt.priority.toLowerCase() : opt.priority
    switch (priority) {
      case 'low':
        str += '; Priority=Low'
        break
      case 'medium':
        str += '; Priority=Medium'
        break
      case 'high':
        str += '; Priority=High'
        break
      default:
        throw new TypeError('option priority is invalid')
    }
  }

  if (opt.sameSite) {
    const sameSite = typeof opt.sameSite === 'string' ? opt.sameSite.toLowerCase() : opt.sameSite
    switch (sameSite) {
      case true:
        str += '; SameSite=Strict'
        break
      case 'lax':
        str += '; SameSite=Lax'
        break
      case 'strict':
        str += '; SameSite=Strict'
        break
      case 'none':
        str += '; SameSite=None'
        break
      default:
        throw new TypeError('option sameSite is invalid')
    }
  }

  return str
}

function decode(str: string): string {
  return str.indexOf('%') !== -1 ? decodeURIComponent(str) : str
}

function tryDecode(str: string, decode: (value: string) => string): string {
  try {
    return decode(str)
  } catch {
    return str
  }
}
