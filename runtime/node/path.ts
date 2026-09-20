// node:path is pure string manipulation over a path spelling -- no syscalls,
// nothing to bind to the reactor, so (unlike most of this directory) this is
// a full implementation rather than a native-binding facade. The algorithms
// below follow Node's own posix path semantics faithfully, including the
// trailing-slash/`.`/`..`-segment edge cases: many programs (this target's
// own hono-hello app among them) depend on exact behavioural parity, not an
// approximation.
//
// This target has exactly one platform: POSIX (the geatsc native targets are
// Linux/macOS/ESP32/Android -- never Windows). Node's own `path` module picks
// its default export's behaviour from `process.platform`; here that choice is
// permanently posix, so the top-level exports below ARE the posix
// implementation, and `posix` is the same functions again under Node's
// documented alias. `win32` gets an explicit `nodeNotImplemented` refusal
// rather than silently aliasing to posix -- a `\`-separator program fed
// posix-separator answers would be a silently wrong answer, not a missing
// feature.

import { nodeNotImplemented } from './not-implemented'

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

function nodePathNormalize(path: string): string {
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

function nodePathJoin(...paths: string[]): string {
  if (paths.length === 0) return '.'
  let joined: string | undefined
  for (const segment of paths) {
    if (segment.length > 0) joined = joined === undefined ? segment : `${joined}/${segment}`
  }
  return joined === undefined ? '.' : nodePathNormalize(joined)
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

function nodePathResolve(...paths: string[]): string {
  let resolvedPath = ''
  let resolvedAbsolute = false
  for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i -= 1) {
    const path = i >= 0 ? paths[i] : cwd()
    if (path.length === 0) continue
    resolvedPath = `${path}/${resolvedPath}`
    resolvedAbsolute = path.charCodeAt(0) === FORWARD_SLASH
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute)
  if (resolvedAbsolute) return `/${resolvedPath}`
  return resolvedPath.length > 0 ? resolvedPath : '.'
}

function nodePathIsAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === FORWARD_SLASH
}

function nodePathDirname(path: string): string {
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

function nodePathBasename(path: string, suffix?: string): string {
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

function nodePathExtname(path: string): string {
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

function nodePathRelative(from: string, to: string): string {
  if (from === to) return ''
  const resolvedFrom = nodePathResolve(from)
  const resolvedTo = nodePathResolve(to)
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

function nodePathParse(path: string): ParsedPath {
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

function nodePathFormat(pathObject: FormatInputPathObject): string {
  const dir = pathObject.dir || pathObject.root || ''
  const base = pathObject.base || `${pathObject.name ?? ''}${pathObject.ext ?? ''}`
  if (!dir) return base
  return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`
}

// Identity on posix: there is no separate "namespaced" path spelling (that's
// a win32-only concept, e.g. `\\?\C:\...`) to convert into.
function nodePathToNamespacedPath(path: string): string {
  return path
}

// Glob matching is a distinct feature (pattern compilation, not path-string
// manipulation) and isn't needed by anything reaching this target today.
// Refuse explicitly instead of shipping a partial/wrong matcher.
function nodePathMatchesGlob(...args: unknown[]): never {
  void args
  return nodeNotImplemented('node:path', 'matchesGlob')
}

export const sep = '/'
export const delimiter = ':'

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

// This target's native platforms (Linux/macOS/ESP32/Android) are all POSIX,
// so the top-level exports above already implement posix semantics --
// `posix` is Node's documented alias for "the posix implementation,
// regardless of host platform", reusing the same functions rather than a
// second copy.
export const posix = {
  basename: nodePathBasename,
  delimiter,
  dirname: nodePathDirname,
  extname: nodePathExtname,
  format: nodePathFormat,
  isAbsolute: nodePathIsAbsolute,
  join: nodePathJoin,
  matchesGlob: nodePathMatchesGlob,
  normalize: nodePathNormalize,
  parse: nodePathParse,
  relative: nodePathRelative,
  resolve: nodePathResolve,
  sep,
  toNamespacedPath: nodePathToNamespacedPath
}

// Explicit refusal, not a silent alias to posix: a `\`-separated win32
// program fed posix answers (wrong separator, wrong root/UNC handling) is a
// silently wrong answer, which is worse than a program that cannot use
// node:path.win32 at all. This target has no Windows native build.
//
// Each stub keeps win32's real parameter list (matching the posix sibling it
// refuses to be) so callers get a normal-looking signature and a `never`
// return -- `never` is assignable to every declared return type, so no `any`
// or cast is needed to satisfy them.
function win32Basename(path: string, suffix?: string): string {
  void path
  void suffix
  return nodeNotImplemented('node:path', 'win32.basename')
}
function win32Dirname(path: string): string {
  void path
  return nodeNotImplemented('node:path', 'win32.dirname')
}
function win32Extname(path: string): string {
  void path
  return nodeNotImplemented('node:path', 'win32.extname')
}
function win32Format(pathObject: FormatInputPathObject): string {
  void pathObject
  return nodeNotImplemented('node:path', 'win32.format')
}
function win32IsAbsolute(path: string): boolean {
  void path
  return nodeNotImplemented('node:path', 'win32.isAbsolute')
}
function win32Join(...paths: string[]): string {
  void paths
  return nodeNotImplemented('node:path', 'win32.join')
}
function win32MatchesGlob(path: string, pattern: string): boolean {
  void path
  void pattern
  return nodeNotImplemented('node:path', 'win32.matchesGlob')
}
function win32Normalize(path: string): string {
  void path
  return nodeNotImplemented('node:path', 'win32.normalize')
}
function win32Parse(path: string): ParsedPath {
  void path
  return nodeNotImplemented('node:path', 'win32.parse')
}
function win32Relative(from: string, to: string): string {
  void from
  void to
  return nodeNotImplemented('node:path', 'win32.relative')
}
function win32Resolve(...paths: string[]): string {
  void paths
  return nodeNotImplemented('node:path', 'win32.resolve')
}
function win32ToNamespacedPath(path: string): string {
  void path
  return nodeNotImplemented('node:path', 'win32.toNamespacedPath')
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
