
const DECODE_COMPONENT_TABLE = new Uint8Array(768)
const DECODE_COMPONENT_PAIRS: [string, string][] = [
  ['%23', '#'], ['%24', '$'], ['%25', '%'], ['%26', '&'],
  ['%2B', '+'], ['%2b', '+'], ['%2C', ','], ['%2c', ','], ['%2F', '/'], ['%2f', '/'],
  ['%3A', ':'], ['%3a', ':'], ['%3B', ';'], ['%3b', ';'],
  ['%3D', '='], ['%3d', '='], ['%3F', '?'], ['%3f', '?'],
  ['%40', '@']
]
for (const pair of DECODE_COMPONENT_PAIRS) {
  const encoded = pair[0]
  const char = pair[1]
  DECODE_COMPONENT_TABLE[((encoded.charCodeAt(1) - 50) << 8) | encoded.charCodeAt(2)] = char.charCodeAt(0)
}

function decodeComponentCharCode(highCharCode: number, lowCharCode: number): number {
  if (highCharCode < 50 || highCharCode > 52 || lowCharCode > 255) return 0
  return DECODE_COMPONENT_TABLE[((highCharCode - 50) << 8) | lowCharCode]
}

function decodeComponentChar(highCharCode: number, lowCharCode: number): string | null {
  const charCode = decodeComponentCharCode(highCharCode, lowCharCode)
  if (charCode === 0) return null
  return String.fromCharCode(charCode)
}

export const MIN_NATIVE_SCAN_LENGTH = 12

export interface SanitizedUrl {
  path: string
  querystring: string
  shouldDecodeParam: boolean
}

export function safeDecodeURI(path: string, useSemicolonDelimiter: boolean): SanitizedUrl {
  if (path.length >= MIN_NATIVE_SCAN_LENGTH) return safeDecodeURINativeScan(path, useSemicolonDelimiter)
  return safeDecodeURICharScan(path, useSemicolonDelimiter, 1)
}

export function safeDecodeURINativeScan(path: string, useSemicolonDelimiter: boolean): SanitizedUrl {
  const percentIndex = path.indexOf('%', 1)

  let delimIndex = path.indexOf('?', 1)
  const hashIndex = path.indexOf('#', 1)
  if (hashIndex !== -1 && (delimIndex === -1 || hashIndex < delimIndex)) delimIndex = hashIndex
  if (useSemicolonDelimiter) {
    const semicolonIndex = path.indexOf(';', 1)
    if (semicolonIndex !== -1 && (delimIndex === -1 || semicolonIndex < delimIndex)) delimIndex = semicolonIndex
  }

  if (percentIndex === -1 || (delimIndex !== -1 && percentIndex > delimIndex)) {
    if (delimIndex === -1) return { path, querystring: '', shouldDecodeParam: false }
    return { path: path.slice(0, delimIndex), querystring: path.slice(delimIndex + 1), shouldDecodeParam: false }
  }

  return safeDecodeURIPercentScan(path, useSemicolonDelimiter, percentIndex)
}

export function safeDecodeURICharScan(path: string, useSemicolonDelimiter: boolean, startIndex: number): SanitizedUrl {
  for (let i = startIndex; i < path.length; i++) {
    const charCode = path.charCodeAt(i)
    if (charCode === 37) {
      return safeDecodeURIPercentScan(path, useSemicolonDelimiter, i)
    } else if (charCode === 63 || charCode === 35 || (charCode === 59 && useSemicolonDelimiter)) {
      return { path: path.slice(0, i), querystring: path.slice(i + 1), shouldDecodeParam: false }
    }
  }
  return { path, querystring: '', shouldDecodeParam: false }
}

function reencodePercentChar(path: string, index: number): string {
  return path.slice(0, index + 1) + '25' + path.slice(index + 1)
}

function safeDecodeURIPercentScan(path: string, useSemicolonDelimiter: boolean, startIndex: number): SanitizedUrl {
  let shouldDecode = false
  let shouldDecodeParam = false
  let querystring = ''

  for (let i = startIndex; i < path.length; i++) {
    const charCode = path.charCodeAt(i)
    if (charCode === 37) {
      const componentCharCode = decodeComponentCharCode(path.charCodeAt(i + 1), path.charCodeAt(i + 2))
      if (componentCharCode === 0) {
        shouldDecode = true
      } else {
        shouldDecodeParam = true
        if (componentCharCode === 37) {
          shouldDecode = true
          path = reencodePercentChar(path, i)
          i += 2
        }
        i += 2
      }
    } else if (charCode === 63 || charCode === 35 || (charCode === 59 && useSemicolonDelimiter)) {
      querystring = path.slice(i + 1)
      path = path.slice(0, i)
      break
    }
  }
  const decodedPath = shouldDecode ? decodeURI(path) : path
  return { path: decodedPath, querystring, shouldDecodeParam }
}

export function safeDecodeURIComponent(uriComponent: string): string {
  const startIndex = uriComponent.indexOf('%')
  if (startIndex === -1) return uriComponent

  let decoded = ''
  let lastIndex = startIndex

  for (let i = startIndex; i < uriComponent.length; i++) {
    if (uriComponent.charCodeAt(i) === 37) {
      const highCharCode = uriComponent.charCodeAt(i + 1)
      const lowCharCode = uriComponent.charCodeAt(i + 2)
      const decodedChar = decodeComponentChar(highCharCode, lowCharCode)
      decoded += uriComponent.slice(lastIndex, i) + decodedChar
      lastIndex = i + 3
    }
  }
  return uriComponent.slice(0, startIndex) + decoded + uriComponent.slice(lastIndex)
}

const urlSanitizer = { safeDecodeURI, safeDecodeURIComponent, safeDecodeURINativeScan, safeDecodeURICharScan, MIN_NATIVE_SCAN_LENGTH }
export default urlSanitizer
