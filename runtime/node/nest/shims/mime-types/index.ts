import { extname } from 'node:path'
import { extensionTypes, typeExtensions, typeCharsets } from '../mime-db/db.generated'

const EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/
const TEXT_TYPE_REGEXP = /^text\//i

export const types: { [extension: string]: string } = extensionTypes
export const extensions: { [type: string]: string[] } = typeExtensions

export function charset(type: string): string | false {
  if (!type || typeof type !== 'string') return false
  const match = EXTRACT_TYPE_REGEXP.exec(type)
  if (match) {
    const key = match[1].toLowerCase()
    if (Object.hasOwn(typeCharsets, key) && typeCharsets[key] !== '') return typeCharsets[key]
    if (TEXT_TYPE_REGEXP.test(match[1])) return 'UTF-8'
  }
  return false
}

export const charsets = { lookup: charset }

export function contentType(str: string): string | false {
  if (!str || typeof str !== 'string') return false
  const mime = str.indexOf('/') === -1 ? lookup(str) : str
  if (mime === false) return false
  let value = mime
  if (value.indexOf('charset') === -1) {
    const found = charset(value)
    if (found !== false) value += '; charset=' + found.toLowerCase()
  }
  return value
}

export function extension(type: string): string | false {
  if (!type || typeof type !== 'string') return false
  const match = EXTRACT_TYPE_REGEXP.exec(type)
  if (!match) return false
  const key = match[1].toLowerCase()
  if (!Object.hasOwn(typeExtensions, key)) return false
  const exts = typeExtensions[key]
  return exts.length === 0 ? false : exts[0]
}

export function lookup(path: string): string | false {
  if (!path || typeof path !== 'string') return false
  const ext = extname('x.' + path).toLowerCase().slice(1)
  if (!ext) return false
  return Object.hasOwn(extensionTypes, ext) ? extensionTypes[ext] : false
}
