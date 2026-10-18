const SUBTYPE_NAME_REGEXP = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.-]{0,126}$/
const TYPE_NAME_REGEXP = /^[A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126}$/
const TYPE_REGEXP = /^ *([A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126})\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}) *$/

export interface MediaTypeLike {
  type: string
  subtype: string
  suffix?: string
}

export class MediaType implements MediaTypeLike {
  type: string
  subtype: string
  suffix: string | undefined

  constructor(type: string, subtype: string, suffix: string | undefined) {
    this.type = type
    this.subtype = subtype
    this.suffix = suffix
  }
}

export function format(obj: MediaTypeLike): string {
  if (!obj || typeof obj !== 'object') throw new TypeError('argument obj is required')
  const subtype = obj.subtype
  const suffix = obj.suffix
  const type = obj.type
  if (!type || !TYPE_NAME_REGEXP.test(type)) throw new TypeError('invalid type')
  if (!subtype || !SUBTYPE_NAME_REGEXP.test(subtype)) throw new TypeError('invalid subtype')
  let string = type + '/' + subtype
  if (suffix) {
    if (!TYPE_NAME_REGEXP.test(suffix)) throw new TypeError('invalid suffix')
    string += '+' + suffix
  }
  return string
}

export function test(string: string): boolean {
  if (typeof string !== 'string') throw new TypeError('argument string is required to be a string')
  return TYPE_REGEXP.test(string.toLowerCase())
}

export function parse(string: string): MediaType {
  if (typeof string !== 'string') throw new TypeError('argument string is required to be a string')
  const match = TYPE_REGEXP.exec(string.toLowerCase())
  if (!match) throw new TypeError('invalid media type')
  const type = match[1]
  let subtype = match[2]
  let suffix: string | undefined
  const index = subtype.lastIndexOf('+')
  if (index !== -1) {
    suffix = subtype.slice(index + 1)
    subtype = subtype.slice(0, index)
  }
  return new MediaType(type, subtype, suffix)
}
