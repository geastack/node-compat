import { parse as parseContentType } from '../content-type/index'
import { test as isMediaType } from '../media-typer/index'
import { lookup as mimeLookup } from '../mime-types/index'

export interface RequestLike {
  headers: RequestHeaders
}

export interface RequestHeaders {
  [name: string]: string | undefined
}

export default function typeofrequest(req: RequestLike, types?: string | string[], ...rest: string[]): string | false | null {
  if (!hasBody(req)) return null
  const list = rest.length > 0 ? [types, ...rest] : types
  return is(req.headers['content-type'], list)
}

export function is(value: string | undefined, types?: string | string[] | (string | string[] | undefined)[], ...rest: string[]): string | false {
  const val = normalizeType(value)
  if (!val) return false
  let candidates: (string | string[] | undefined)[] | undefined
  if (types !== undefined && !Array.isArray(types)) candidates = [types, ...rest]
  else candidates = types
  if (!candidates || !candidates.length) return val
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (mimeMatch(normalize(candidate), val)) {
      return candidate[0] === '+' || candidate.indexOf('*') !== -1 ? val : candidate
    }
  }
  return false
}

export function hasBody(req: RequestLike): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true
  const length = req.headers['content-length']
  if (typeof length === 'string') return !isNaN(Number(length))
  return false
}

export function normalize(type: string): string | false {
  if (typeof type !== 'string') return false
  switch (type) {
    case 'urlencoded':
      return 'application/x-www-form-urlencoded'
    case 'multipart':
      return 'multipart/*'
  }
  if (type[0] === '+') return '*/*' + type
  return type.indexOf('/') === -1 ? mimeLookup(type) : type
}

export function match(expected: string | false, actual: string): boolean {
  return mimeMatch(expected, actual)
}

function mimeMatch(expected: string | false, actual: string): boolean {
  if (expected === false) return false
  const actualParts = actual.split('/')
  const expectedParts = expected.split('/')
  if (actualParts.length !== 2 || expectedParts.length !== 2) return false
  if (expectedParts[0] !== '*' && expectedParts[0] !== actualParts[0]) return false
  if (expectedParts[1].slice(0, 2) === '*+') {
    return expectedParts[1].length <= actualParts[1].length + 1 &&
      expectedParts[1].slice(1) === actualParts[1].slice(1 - expectedParts[1].length)
  }
  if (expectedParts[1] !== '*' && expectedParts[1] !== actualParts[1]) return false
  return true
}

function normalizeType(value: string | undefined): string | null {
  if (!value) return null
  const type = parseContentType(value, { parameters: false }).type
  return isMediaType(type) ? type : null
}
