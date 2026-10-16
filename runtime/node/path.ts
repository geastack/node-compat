// node:path is pure string manipulation over a path spelling -- no syscalls,
// nothing to bind to the reactor, so (unlike most of this directory) this is
// a full implementation rather than a native-binding facade. The algorithms
// below follow Node's own path semantics faithfully, posix and win32 alike,
// including the trailing-separator/`.`/`..`-segment, drive-letter and UNC edge
// cases: many programs (this target's own HTTP framework test app among them) depend on
// exact behavioural parity, not an approximation.
//
// Node's own `path` module picks its default export's behaviour from
// `process.platform`, and so does this one: the top-level exports are the
// win32 implementation on a Windows host and the posix one everywhere else.
// `posix` and `win32` are always both available, whatever the host, exactly
// as in Node.

import { nodeNotImplemented } from './not-implemented'

/** @gea-host-inert */
declare function __gea_node_platform(): string

const windowsHost: boolean = __gea_node_platform() === 'win32'

const FORWARD_SLASH = 47 // '/'.charCodeAt(0)
const DOT = 46 // '.'.charCodeAt(0)

function isPosixPathSeparator(code: number): boolean {
  return code === FORWARD_SLASH
}

// Resolves `.`/`..` segments and collapses repeated separators within a
// single path string. Shared by `normalize`, `join` and `resolve`, which
// differ only in whether a leading `..` is kept (relative paths keep it;
// absolute paths can't climb above root) and in what they do with the ends.
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let code = 0
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i)
    else if (isPosixPathSeparator(code)) break
    else code = FORWARD_SLASH

    if (isPosixPathSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment (`//`) or a lone `.` segment: drop it.
      } else if (lastSlash !== i - 1 && dots === 2) {
        // A `..` segment: pop the previous real segment, unless there isn't
        // one, in which case keep the `..` (only when climbing above the
        // root is allowed -- i.e. the whole path is relative).
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== DOT ||
          res.charCodeAt(res.length - 2) !== DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/')
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1) {
                res = ''
                lastSegmentLength = 0
              } else {
                res = res.slice(0, lastSlashIndex)
                lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
              }
              lastSlash = i
              dots = 0
              continue
            }
          } else if (res.length === 2 || res.length === 1) {
            res = ''
            lastSegmentLength = 0
            lastSlash = i
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..'
          lastSegmentLength = 2
        }
      } else {
        res += res.length > 0 ? `/${path.slice(lastSlash + 1, i)}` : path.slice(lastSlash + 1, i)
        lastSegmentLength = i - lastSlash - 1
      }
      lastSlash = i
      dots = 0
    } else if (code === DOT && dots !== -1) {
      dots += 1
    } else {
      dots = -1
    }
  }
  return res
}

function posixNormalize(path: string): string {
  if (path.length === 0) return '.'
  const isAbsolute = path.charCodeAt(0) === FORWARD_SLASH
  const trailingSeparator = path.charCodeAt(path.length - 1) === FORWARD_SLASH
  let normalized = normalizeString(path, !isAbsolute)
  if (normalized.length === 0) {
    if (isAbsolute) return '/'
    return trailingSeparator ? './' : '.'
  }
  if (trailingSeparator) normalized += '/'
  return isAbsolute ? `/${normalized}` : normalized
}

function posixJoinAll(paths: string[]): string {
  if (paths.length === 0) return '.'
  let joined: string | undefined
  for (const segment of paths) {
    if (segment.length > 0) joined = joined === undefined ? segment : `${joined}/${segment}`
  }
  return joined === undefined ? '.' : posixNormalize(joined)
}

// There is no native cwd() binding on this target yet (grep the runtime: no
// `__gea_node_*cwd*` symbol exists) -- so this delegates to the ambient
// global `process.cwd()` exactly like Node does, rather than inventing a
// fake root. Today that throws `ERR_GEA_NODE_NOT_IMPLEMENTED` for any
// `resolve()` call that bottoms out without an absolute segment among its
// arguments; that is an honest reflection of "this target cannot yet answer
// 'what directory am I in'", not a defect in path.ts. It starts working the
// moment `process.cwd()` gets a real implementation, with no change here.
function cwd(): string {
  return process.cwd()
}

// node's `posixCwd`: on Windows, `C:\Users\me` is `/Users/me` to posix.resolve.
function posixCwd(): string {
  if (!windowsHost) return cwd()
  const spelled = cwd().replace(/\\/g, '/')
  return spelled.slice(spelled.indexOf('/'))
}

function posixResolveAll(paths: string[]): string {
  let resolvedPath = ''
  let resolvedAbsolute = false
  for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i -= 1) {
    const path = i >= 0 ? paths[i] : posixCwd()
    if (path.length === 0) continue
    resolvedPath = `${path}/${resolvedPath}`
    resolvedAbsolute = path.charCodeAt(0) === FORWARD_SLASH
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute)
  if (resolvedAbsolute) return `/${resolvedPath}`
  return resolvedPath.length > 0 ? resolvedPath : '.'
}

function posixIsAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === FORWARD_SLASH
}

function posixDirname(path: string): string {
  if (path.length === 0) return '.'
  const hasRoot = path.charCodeAt(0) === FORWARD_SLASH
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; i -= 1) {
    if (path.charCodeAt(i) === FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return path.slice(0, end)
}

function posixBasename(path: string, suffix?: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return ''
    let extIdx = suffix.length - 1
    let firstNonSlashEnd = -1
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const code = path.charCodeAt(i)
      if (code === FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1
          break
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false
          firstNonSlashEnd = i + 1
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            extIdx -= 1
            if (extIdx === -1) end = i
          } else {
            extIdx = -1
            end = firstNonSlashEnd
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }

  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path.charCodeAt(i) === FORWARD_SLASH) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  if (end === -1) return ''
  return path.slice(start, end)
}

function posixExtname(path: string): string {
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  // Tracks whether the run of dots before `end` is a single trailing dot
  // (0), more than one dot / a real extension (1), or interrupted by a
  // non-dot character (-1) -- distinguishes `..bashrc` and `.` from `.gz`.
  let preDotState = 0
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const code = path.charCodeAt(i)
    if (code === FORWARD_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    // The whole basename is one run of dots (`.`, `..`, `...`): no extension.
    preDotState === 0 ||
    // Exactly one dot, and it's the first character of the basename
    // (`.hidden`): that's a dotfile name, not an extension -- `extname`
    // returns `''`, matching Node.
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return ''
  }
  return path.slice(startDot, end)
}

function posixRelative(from: string, to: string): string {
  if (from === to) return ''
  const resolvedFrom = posixResolve(from)
  const resolvedTo = posixResolve(to)
  if (resolvedFrom === resolvedTo) return ''

  const fromStart = 1
  const fromEnd = resolvedFrom.length
  const fromLen = fromEnd - fromStart
  const toStart = 1
  const toLen = resolvedTo.length - toStart
  const length = fromLen < toLen ? fromLen : toLen
  let lastCommonSep = -1
  let i = 0
  for (; i < length; i += 1) {
    const fromCode = resolvedFrom.charCodeAt(fromStart + i)
    if (fromCode !== resolvedTo.charCodeAt(toStart + i)) break
    else if (fromCode === FORWARD_SLASH) lastCommonSep = i
  }
  if (i === length) {
    if (toLen > length) {
      if (resolvedTo.charCodeAt(toStart + i) === FORWARD_SLASH) return resolvedTo.slice(toStart + i + 1)
      if (i === 0) return resolvedTo.slice(toStart + i)
    } else if (fromLen > length) {
      if (resolvedFrom.charCodeAt(fromStart + i) === FORWARD_SLASH) lastCommonSep = i
      else if (i === 0) lastCommonSep = 0
    }
  }

  let out = ''
  for (let j = fromStart + lastCommonSep + 1; j <= fromEnd; j += 1) {
    if (j === fromEnd || resolvedFrom.charCodeAt(j) === FORWARD_SLASH) out += out.length === 0 ? '..' : '/..'
  }
  return `${out}${resolvedTo.slice(toStart + lastCommonSep)}`
}

export interface ParsedPath {
  root: string
  dir: string
  base: string
  ext: string
  name: string
}

export interface FormatInputPathObject {
  root?: string
  dir?: string
  base?: string
  ext?: string
  name?: string
}

function posixParse(path: string): ParsedPath {
  const ret: ParsedPath = { root: '', dir: '', base: '', ext: '', name: '' }
  if (path.length === 0) return ret

  const isAbsolute = path.charCodeAt(0) === FORWARD_SLASH
  const start = isAbsolute ? 1 : 0
  if (isAbsolute) ret.root = '/'

  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  let i = path.length - 1
  for (; i >= start; i -= 1) {
    const code = path.charCodeAt(i)
    if (code === FORWARD_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    if (end !== -1) {
      ret.base = ret.name = startPart === 0 && isAbsolute ? path.slice(1, end) : path.slice(startPart, end)
    }
  } else {
    if (startPart === 0 && isAbsolute) {
      ret.name = path.slice(1, startDot)
      ret.base = path.slice(1, end)
    } else {
      ret.name = path.slice(startPart, startDot)
      ret.base = path.slice(startPart, end)
    }
    ret.ext = path.slice(startDot, end)
  }

  if (startPart > 0) ret.dir = path.slice(0, startPart - 1)
  else if (isAbsolute) ret.dir = '/'

  return ret
}

function posixFormat(pathObject: FormatInputPathObject): string {
  const dir = pathObject.dir || pathObject.root || ''
  const base = pathObject.base || `${pathObject.name ?? ''}${pathObject.ext ?? ''}`
  if (!dir) return base
  return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`
}

// Identity on posix: there is no separate "namespaced" path spelling (that's
// a win32-only concept, e.g. `\\?\C:\...`) to convert into.
function posixToNamespacedPath(path: string): string {
  return path
}

// Glob matching is a distinct feature (pattern compilation, not path-string
// manipulation) and isn't needed by anything reaching this target today.
// Refuse explicitly instead of shipping a partial/wrong matcher.
function nodePathMatchesGlob(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:path', 'matchesGlob')
}

export const sep: string = windowsHost ? '\\' : '/'
export const delimiter: string = windowsHost ? ';' : ':'

// ---- win32 ------------------------------------------------------------------
//
// Node's `path.win32`, line for line: `/` and `\` are both separators, a
// path may start with a drive (`C:`), a UNC root (`\\server\share`) or a
// device root (`\\.\` / `\\?\`), and results are spelled with `\`.

const BACKWARD_SLASH = 92 // '\\'.charCodeAt(0)
const COLON = 58 // ':'.charCodeAt(0)
const QUESTION_MARK = 63 // '?'.charCodeAt(0)

function isWin32PathSeparator(code: number): boolean {
  return code === FORWARD_SLASH || code === BACKWARD_SLASH
}

function isWindowsDeviceRoot(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

// Node's `normalizeString` with `\` as the separator.
function win32NormalizeString(path: string, allowAboveRoot: boolean): string {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let code = 0
  for (let i = 0; i <= path.length; i += 1) {
    if (i < path.length) code = path.charCodeAt(i)
    else if (isWin32PathSeparator(code)) break
    else code = FORWARD_SLASH

    if (isWin32PathSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment or a lone `.` segment: drop it.
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== DOT ||
          res.charCodeAt(res.length - 2) !== DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1
            if (lastSlashIndex === -1) {
              res = ''
              lastSegmentLength = 0
            } else {
              res = res.slice(0, lastSlashIndex)
              lastSegmentLength = res.length - 1 - res.lastIndexOf('\\')
            }
            lastSlash = i
            dots = 0
            continue
          } else if (res.length !== 0) {
            res = ''
            lastSegmentLength = 0
            lastSlash = i
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '\\..' : '..'
          lastSegmentLength = 2
        }
      } else {
        if (res.length > 0) res += `\\${path.slice(lastSlash + 1, i)}`
        else res = path.slice(lastSlash + 1, i)
        lastSegmentLength = i - lastSlash - 1
      }
      lastSlash = i
      dots = 0
    } else if (code === DOT && dots !== -1) {
      dots += 1
    } else {
      dots = -1
    }
  }
  return res
}

// DOS device names, which Windows resolves wherever they appear.
const WINDOWS_RESERVED_NAMES: string[] = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'COM\xb9', 'COM\xb2', 'COM\xb3',
  'LPT\xb9', 'LPT\xb2', 'LPT\xb3'
]

function isWindowsReservedName(path: string, colonIndex: number): boolean {
  // `slice(0, -1)` (no colon: index -1) is what node's own check reads too.
  const devicePart = path.slice(0, colonIndex).toUpperCase()
  return WINDOWS_RESERVED_NAMES.includes(devicePart)
}

// The end of a `\\server\share` root starting at index 2 of `path`, as
// Node's matchers find it: [serverEnd, shareStart, shareEnd], or null when
// `path` has no server part followed by a separator and a share.
function uncRoot(path: string): number[] | null {
  const len = path.length
  let j = 2
  let last = j
  while (j < len && !isWin32PathSeparator(path.charCodeAt(j))) j += 1
  if (j >= len || j === last) return null
  const serverEnd = j
  last = j
  while (j < len && isWin32PathSeparator(path.charCodeAt(j))) j += 1
  if (j >= len || j === last) return null
  last = j
  while (j < len && !isWin32PathSeparator(path.charCodeAt(j))) j += 1
  return [serverEnd, last, j]
}

function win32ResolveAll(paths: string[]): string {
  let resolvedDevice = ''
  let resolvedTail = ''
  let resolvedAbsolute = false

  for (let i = paths.length - 1; i >= -1; i -= 1) {
    let path: string
    if (i >= 0) {
      path = paths[i]
      if (path.length === 0) continue
    } else if (resolvedDevice.length === 0) {
      path = cwd()
      // Fast path for the current directory.
      if (
        paths.length === 0 ||
        (paths.length === 1 && (paths[0] === '' || paths[0] === '.') && isWin32PathSeparator(path.charCodeAt(0)))
      ) {
        return windowsHost ? path : path.replace(/\//g, '\\')
      }
    } else {
      // Windows keeps a current directory per drive. Node reads it from the
      // hidden `=C:` environment entry; this runtime's process.env does not
      // carry those, so a drive other than the process's own resolves
      // against its root -- what node does when the entry is absent.
      path = cwd()
      if (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() && path.charCodeAt(2) === BACKWARD_SLASH) {
        path = `${resolvedDevice}\\`
      }
    }

    const len = path.length
    let rootEnd = 0
    let device = ''
    let isAbsolute = false
    const code = path.charCodeAt(0)

    if (len === 1) {
      if (isWin32PathSeparator(code)) {
        rootEnd = 1
        isAbsolute = true
      }
    } else if (isWin32PathSeparator(code)) {
      isAbsolute = true
      if (isWin32PathSeparator(path.charCodeAt(1))) {
        const unc = uncRoot(path)
        if (unc !== null) {
          const firstPart = path.slice(2, unc[0])
          if (firstPart !== '.' && firstPart !== '?') {
            device = `\\\\${firstPart}\\${path.slice(unc[1], unc[2])}`
            rootEnd = unc[2]
          } else {
            // A device root (`\\.\PHYSICALDRIVE0`).
            device = `\\\\${firstPart}`
            rootEnd = 4
          }
        }
      } else {
        rootEnd = 1
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
      device = path.slice(0, 2)
      rootEnd = 2
      if (len > 2 && isWin32PathSeparator(path.charCodeAt(2))) {
        isAbsolute = true
        rootEnd = 3
      }
    }

    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        // This path points to another device, so it does not apply.
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue
      } else {
        resolvedDevice = device
      }
    }

    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break
    } else {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`
      resolvedAbsolute = isAbsolute
      if (isAbsolute && resolvedDevice.length > 0) break
    }
  }

  resolvedTail = win32NormalizeString(resolvedTail, !resolvedAbsolute)
  if (resolvedAbsolute) return `${resolvedDevice}\\${resolvedTail}`
  const relative = `${resolvedDevice}${resolvedTail}`
  return relative.length > 0 ? relative : '.'
}

function win32Resolve(...paths: string[]): string {
  return win32ResolveAll(paths)
}

function win32Normalize(path: string): string {
  const len = path.length
  if (len === 0) return '.'
  let rootEnd = 0
  let device: string | undefined = undefined
  let isAbsolute = false
  const code = path.charCodeAt(0)

  if (len === 1) return code === FORWARD_SLASH ? '\\' : path
  if (isWin32PathSeparator(code)) {
    isAbsolute = true
    if (isWin32PathSeparator(path.charCodeAt(1))) {
      const unc = uncRoot(path)
      if (unc !== null) {
        const firstPart = path.slice(2, unc[0])
        if (firstPart === '.' || firstPart === '?') {
          // A device root (`\\.\PHYSICALDRIVE0`), or `\\?\COM1:` and the like.
          device = `\\\\${firstPart}`
          rootEnd = 4
          const colonIndex = path.indexOf(':')
          const possibleDevice = path.slice(4, colonIndex + 1)
          if (isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
            device = `\\\\?\\${possibleDevice}`
            rootEnd = 4 + possibleDevice.length
          }
        } else if (unc[2] === len) {
          // A UNC root alone: its normalized spelling is all there is.
          return `\\\\${firstPart}\\${path.slice(unc[1])}\\`
        } else {
          device = `\\\\${firstPart}\\${path.slice(unc[1], unc[2])}`
          rootEnd = unc[2]
        }
      }
    } else {
      rootEnd = 1
    }
  } else {
    const colonIndex = path.indexOf(':')
    if (colonIndex > 0) {
      if (isWindowsDeviceRoot(code) && colonIndex === 1) {
        device = path.slice(0, 2)
        rootEnd = 2
        if (len > 2 && isWin32PathSeparator(path.charCodeAt(2))) {
          isAbsolute = true
          rootEnd = 3
        }
      } else if (isWindowsReservedName(path, colonIndex)) {
        device = path.slice(0, colonIndex + 1)
        rootEnd = colonIndex + 1
      }
    }
  }

  let tail = rootEnd < len ? win32NormalizeString(path.slice(rootEnd), !isAbsolute) : ''
  if (tail.length === 0 && !isAbsolute) tail = '.'
  if (tail.length > 0 && isWin32PathSeparator(path.charCodeAt(len - 1))) tail += '\\'
  if (!isAbsolute && device === undefined && path.includes(':')) {
    // A relative result must not turn into something Windows would read as
    // a drive-qualified path (CVE-2024-36139).
    if (tail.length >= 2 && isWindowsDeviceRoot(tail.charCodeAt(0)) && tail.charCodeAt(1) === COLON) return `.\\${tail}`
    let index = path.indexOf(':')
    while (index !== -1) {
      if (index === len - 1 || isWin32PathSeparator(path.charCodeAt(index + 1))) return `.\\${tail}`
      index = path.indexOf(':', index + 1)
    }
  }
  if (isWindowsReservedName(path, path.indexOf(':'))) return `.\\${device ?? ''}${tail}`
  if (device === undefined) return isAbsolute ? `\\${tail}` : tail
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`
}

function win32IsAbsolute(path: string): boolean {
  const len = path.length
  if (len === 0) return false
  const code = path.charCodeAt(0)
  return (
    isWin32PathSeparator(code) ||
    (len > 2 && isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON && isWin32PathSeparator(path.charCodeAt(2)))
  )
}

function win32JoinAll(paths: string[]): string {
  if (paths.length === 0) return '.'
  let joined = ''
  let firstPart = ''
  let any = false
  for (const segment of paths) {
    if (segment.length === 0) continue
    if (!any) {
      joined = segment
      firstPart = segment
      any = true
    } else {
      joined += `\\${segment}`
    }
  }
  if (!any) return '.'
  // A joined path must not start with two separators unless its first part
  // did: normalize() would read it as a UNC root.
  let needsReplace = true
  let slashCount = 0
  if (isWin32PathSeparator(firstPart.charCodeAt(0))) {
    slashCount += 1
    const firstLen = firstPart.length
    if (firstLen > 1 && isWin32PathSeparator(firstPart.charCodeAt(1))) {
      slashCount += 1
      if (firstLen > 2) {
        if (isWin32PathSeparator(firstPart.charCodeAt(2))) slashCount += 1
        else needsReplace = false
      }
    }
  }
  if (needsReplace) {
    while (slashCount < joined.length && isWin32PathSeparator(joined.charCodeAt(slashCount))) slashCount += 1
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`
  }
  // A part naming a reserved device (`COM1:`) is left unnormalized, only
  // re-spelled with backslashes.
  for (const part of joined.split('\\')) {
    const colonIndex = part.indexOf(':')
    if (part.length > 0 && colonIndex !== -1 && isWindowsReservedName(part, colonIndex)) return joined.replace(/\//g, '\\')
  }
  return win32Normalize(joined)
}

function win32Join(...paths: string[]): string {
  return win32JoinAll(paths)
}

function win32Relative(from: string, to: string): string {
  if (from === to) return ''
  const fromOrig = win32ResolveAll([from])
  const toOrig = win32ResolveAll([to])
  if (fromOrig === toOrig) return ''
  const fromLower = fromOrig.toLowerCase()
  const toLower = toOrig.toLowerCase()
  if (fromLower === toLower) return ''

  if (fromOrig.length !== fromLower.length || toOrig.length !== toLower.length) {
    // Lower-casing changed a length (a non-ASCII character): compare whole
    // segments instead of character offsets.
    const fromSplit = fromOrig.split('\\')
    const toSplit = toOrig.split('\\')
    if (fromSplit[fromSplit.length - 1] === '') fromSplit.pop()
    if (toSplit[toSplit.length - 1] === '') toSplit.pop()
    const fromCount = fromSplit.length
    const toCount = toSplit.length
    const shorter = fromCount < toCount ? fromCount : toCount
    let k = 0
    for (; k < shorter; k += 1) {
      if (fromSplit[k].toLowerCase() !== toSplit[k].toLowerCase()) break
    }
    if (k === 0) return toOrig
    if (k === shorter) {
      if (toCount > shorter) return toSplit.slice(k).join('\\')
      if (fromCount > shorter) return `${'..\\'.repeat(fromCount - 1 - k)}..`
      return ''
    }
    return `${'..\\'.repeat(fromCount - k)}${toSplit.slice(k).join('\\')}`
  }

  let fromStart = 0
  while (fromStart < fromLower.length && fromLower.charCodeAt(fromStart) === BACKWARD_SLASH) fromStart += 1
  let fromEnd = fromLower.length
  while (fromEnd - 1 > fromStart && fromLower.charCodeAt(fromEnd - 1) === BACKWARD_SLASH) fromEnd -= 1
  const fromLen = fromEnd - fromStart

  let toStart = 0
  while (toStart < toLower.length && toLower.charCodeAt(toStart) === BACKWARD_SLASH) toStart += 1
  let toEnd = toLower.length
  while (toEnd - 1 > toStart && toLower.charCodeAt(toEnd - 1) === BACKWARD_SLASH) toEnd -= 1
  const toLen = toEnd - toStart

  const length = fromLen < toLen ? fromLen : toLen
  let lastCommonSep = -1
  let i = 0
  for (; i < length; i += 1) {
    const fromCode = fromLower.charCodeAt(fromStart + i)
    if (fromCode !== toLower.charCodeAt(toStart + i)) break
    else if (fromCode === BACKWARD_SLASH) lastCommonSep = i
  }

  if (i !== length) {
    if (lastCommonSep === -1) return toOrig
  } else {
    if (toLen > length) {
      // `from` is the exact base path of `to`.
      if (toLower.charCodeAt(toStart + i) === BACKWARD_SLASH) return toOrig.slice(toStart + i + 1)
      // `from` is the device root.
      if (i === 2) return toOrig.slice(toStart + i)
    }
    if (fromLen > length) {
      if (fromLower.charCodeAt(fromStart + i) === BACKWARD_SLASH) lastCommonSep = i
      else if (i === 2) lastCommonSep = 3
    }
    if (lastCommonSep === -1) lastCommonSep = 0
  }

  let out = ''
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; i += 1) {
    if (i === fromEnd || fromLower.charCodeAt(i) === BACKWARD_SLASH) out += out.length === 0 ? '..' : '\\..'
  }
  toStart += lastCommonSep
  if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`
  if (toOrig.charCodeAt(toStart) === BACKWARD_SLASH) toStart += 1
  return toOrig.slice(toStart, toEnd)
}

function win32ToNamespacedPath(path: string): string {
  if (path.length === 0) return path
  const resolvedPath = win32ResolveAll([path])
  if (resolvedPath.length <= 2) return path
  if (resolvedPath.charCodeAt(0) === BACKWARD_SLASH) {
    if (resolvedPath.charCodeAt(1) === BACKWARD_SLASH) {
      const code = resolvedPath.charCodeAt(2)
      // A plain UNC root becomes a long UNC path.
      if (code !== QUESTION_MARK && code !== DOT) return `\\\\?\\UNC\\${resolvedPath.slice(2)}`
    }
  } else if (
    isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
    resolvedPath.charCodeAt(1) === COLON &&
    resolvedPath.charCodeAt(2) === BACKWARD_SLASH
  ) {
    return `\\\\?\\${resolvedPath}`
  }
  return resolvedPath
}

function win32Dirname(path: string): string {
  const len = path.length
  if (len === 0) return '.'
  let rootEnd = -1
  let offset = 0
  const code = path.charCodeAt(0)
  if (len === 1) return isWin32PathSeparator(code) ? path : '.'
  if (isWin32PathSeparator(code)) {
    rootEnd = offset = 1
    if (isWin32PathSeparator(path.charCodeAt(1))) {
      const unc = uncRoot(path)
      if (unc !== null) {
        // A UNC root alone is its own dirname.
        if (unc[2] === len) return path
        if (unc[2] !== unc[1]) rootEnd = offset = unc[2] + 1
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
    rootEnd = len > 2 && isWin32PathSeparator(path.charCodeAt(2)) ? 3 : 2
    offset = rootEnd
  }

  let end = -1
  let matchedSlash = true
  for (let i = len - 1; i >= offset; i -= 1) {
    if (isWin32PathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) {
    if (rootEnd === -1) return '.'
    end = rootEnd
  }
  return path.slice(0, end)
}

function win32Basename(path: string, suffix?: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true
  // A drive prefix's separator is not a trailing separator to skip.
  if (path.length >= 2 && isWindowsDeviceRoot(path.charCodeAt(0)) && path.charCodeAt(1) === COLON) start = 2

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return ''
    let extIdx = suffix.length - 1
    let firstNonSlashEnd = -1
    for (let i = path.length - 1; i >= start; i -= 1) {
      const code = path.charCodeAt(i)
      if (isWin32PathSeparator(code)) {
        if (!matchedSlash) {
          start = i + 1
          break
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false
          firstNonSlashEnd = i + 1
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            extIdx -= 1
            if (extIdx === -1) end = i
          } else {
            extIdx = -1
            end = firstNonSlashEnd
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }

  for (let i = path.length - 1; i >= start; i -= 1) {
    if (isWin32PathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  if (end === -1) return ''
  return path.slice(start, end)
}

function win32Extname(path: string): string {
  let start = 0
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  if (path.length >= 2 && path.charCodeAt(1) === COLON && isWindowsDeviceRoot(path.charCodeAt(0))) start = startPart = 2

  for (let i = path.length - 1; i >= start; i -= 1) {
    const code = path.charCodeAt(i)
    if (isWin32PathSeparator(code)) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }
  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return ''
  }
  return path.slice(startDot, end)
}

function win32Format(pathObject: FormatInputPathObject): string {
  const dir = pathObject.dir || pathObject.root || ''
  const ext = pathObject.ext ?? ''
  const base = pathObject.base || `${pathObject.name || ''}${ext.length > 0 && ext.charCodeAt(0) !== DOT ? '.' : ''}${ext}`
  if (!dir) return base
  return dir === pathObject.root ? `${dir}${base}` : `${dir}\\${base}`
}

function win32Parse(path: string): ParsedPath {
  const ret: ParsedPath = { root: '', dir: '', base: '', ext: '', name: '' }
  if (path.length === 0) return ret

  const len = path.length
  let rootEnd = 0
  let code = path.charCodeAt(0)

  if (len === 1) {
    if (isWin32PathSeparator(code)) {
      ret.root = ret.dir = path
      return ret
    }
    ret.base = ret.name = path
    return ret
  }
  if (isWin32PathSeparator(code)) {
    rootEnd = 1
    if (isWin32PathSeparator(path.charCodeAt(1))) {
      const unc = uncRoot(path)
      if (unc !== null) {
        if (unc[2] === len) rootEnd = unc[2]
        else if (unc[2] !== unc[1]) rootEnd = unc[2] + 1
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
    if (len <= 2) {
      ret.root = ret.dir = path
      return ret
    }
    rootEnd = 2
    if (isWin32PathSeparator(path.charCodeAt(2))) {
      if (len === 3) {
        ret.root = ret.dir = path
        return ret
      }
      rootEnd = 3
    }
  }
  if (rootEnd > 0) ret.root = path.slice(0, rootEnd)

  let startDot = -1
  let startPart = rootEnd
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  for (let i = path.length - 1; i >= rootEnd; i -= 1) {
    code = path.charCodeAt(i)
    if (isWin32PathSeparator(code)) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }

  if (end !== -1) {
    if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(startPart, end)
    } else {
      ret.name = path.slice(startPart, startDot)
      ret.base = path.slice(startPart, end)
      ret.ext = path.slice(startDot, end)
    }
  }
  // The root keeps its trailing separator as the dir (`C:\abc` -> `C:\`);
  // any other dir drops it (`C:\abc\def` -> `C:\abc`).
  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1)
  else ret.dir = ret.root
  return ret
}

function win32MatchesGlob(path: string, pattern: string): boolean {
  void path
  void pattern
  return nodeNotImplemented('node:path', 'win32.matchesGlob')
}

// ---- the host's own path -----------------------------------------------------

function posixJoin(...paths: string[]): string {
  return posixJoinAll(paths)
}

function posixResolve(...paths: string[]): string {
  return posixResolveAll(paths)
}

function nodePathBasename(path: string, suffix?: string): string {
  return windowsHost ? win32Basename(path, suffix) : posixBasename(path, suffix)
}
function nodePathDirname(path: string): string {
  return windowsHost ? win32Dirname(path) : posixDirname(path)
}
function nodePathExtname(path: string): string {
  return windowsHost ? win32Extname(path) : posixExtname(path)
}
function nodePathFormat(pathObject: FormatInputPathObject): string {
  return windowsHost ? win32Format(pathObject) : posixFormat(pathObject)
}
function nodePathIsAbsolute(path: string): boolean {
  return windowsHost ? win32IsAbsolute(path) : posixIsAbsolute(path)
}
function nodePathJoin(...paths: string[]): string {
  return windowsHost ? win32JoinAll(paths) : posixJoinAll(paths)
}
function nodePathNormalize(path: string): string {
  return windowsHost ? win32Normalize(path) : posixNormalize(path)
}
function nodePathParse(path: string): ParsedPath {
  return windowsHost ? win32Parse(path) : posixParse(path)
}
function nodePathRelative(from: string, to: string): string {
  return windowsHost ? win32Relative(from, to) : posixRelative(from, to)
}
function nodePathResolve(...paths: string[]): string {
  return windowsHost ? win32ResolveAll(paths) : posixResolveAll(paths)
}
function nodePathToNamespacedPath(path: string): string {
  return windowsHost ? win32ToNamespacedPath(path) : posixToNamespacedPath(path)
}

export {
  nodePathBasename as basename,
  nodePathDirname as dirname,
  nodePathExtname as extname,
  nodePathFormat as format,
  nodePathIsAbsolute as isAbsolute,
  nodePathJoin as join,
  nodePathMatchesGlob as matchesGlob,
  nodePathNormalize as normalize,
  nodePathParse as parse,
  nodePathRelative as relative,
  nodePathResolve as resolve,
  nodePathToNamespacedPath as toNamespacedPath
}

// Node's documented aliases: the posix and the win32 implementation,
// regardless of host platform.
export const posix = {
  basename: posixBasename,
  delimiter: ':',
  dirname: posixDirname,
  extname: posixExtname,
  format: posixFormat,
  isAbsolute: posixIsAbsolute,
  join: posixJoin,
  matchesGlob: nodePathMatchesGlob,
  normalize: posixNormalize,
  parse: posixParse,
  relative: posixRelative,
  resolve: posixResolve,
  sep: '/',
  toNamespacedPath: posixToNamespacedPath
}

export const win32 = {
  basename: win32Basename,
  delimiter: ';',
  dirname: win32Dirname,
  extname: win32Extname,
  format: win32Format,
  isAbsolute: win32IsAbsolute,
  join: win32Join,
  matchesGlob: win32MatchesGlob,
  normalize: win32Normalize,
  parse: win32Parse,
  relative: win32Relative,
  resolve: win32Resolve,
  sep: '\\',
  toNamespacedPath: win32ToNamespacedPath
}
