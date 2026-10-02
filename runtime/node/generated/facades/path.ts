// Generated from the pinned Node 24 declaration inventory. Do not edit.
// Canonical builtin: node:path
import { nodeNotImplemented } from "../../not-implemented"
import { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, toNamespacedPath, win32 } from "../../path"
export { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, toNamespacedPath, win32 }

export function matchesGlob(...args: unknown[]): never {
  void args
  return nodeNotImplemented("node:path", "matchesGlob")
}

// `export =` is a genuinely dynamic CommonJS namespace boundary. Keep
// string-keyed assignments so C/C++ platform macros cannot rewrite Node
// constant names while the generated module is being compiled.
const __node24Default: any = {}
__node24Default["basename"] = basename
__node24Default["delimiter"] = delimiter
__node24Default["dirname"] = dirname
__node24Default["extname"] = extname
__node24Default["format"] = format
__node24Default["isAbsolute"] = isAbsolute
__node24Default["join"] = join
__node24Default["matchesGlob"] = matchesGlob
__node24Default["normalize"] = normalize
__node24Default["parse"] = parse
__node24Default["posix"] = posix
__node24Default["relative"] = relative
__node24Default["resolve"] = resolve
__node24Default["sep"] = sep
__node24Default["toNamespacedPath"] = toNamespacedPath
__node24Default["win32"] = win32
export default __node24Default
