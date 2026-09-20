// node:fs subset needed by MongoDB handshake metadata, its optional TLS file
// loader, and (below) @hono/node-server's static-file middleware. Host
// syscalls are synchronous; Promise wrapping preserves the observable driver
// API without routing file bytes through a dynamic value.

import { Buffer } from './buffer'
import type { BufferEncoding } from './buffer'
import { Readable } from './stream'
import { nodeNotImplemented } from './not-implemented'

/** @gea-host-inert */
declare function __gea_node_fs_access(path: string, mode: number): boolean
declare function __gea_node_fs_read_file(path: string): Buffer

const nodeFsConstants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1
}

function filePath(path: string | URL): string {
  if (typeof path === 'string') return path
  if (path.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
  if (path.hostname !== '' && path.hostname !== 'localhost') throw new TypeError('File URL host must be localhost or empty')
  if (/%2f/i.test(path.pathname)) throw new TypeError('File URL path must not include encoded / characters')
  return decodeURIComponent(path.pathname)
}

export class FsPromises {
  async access(path: string | URL, mode: number = 0): Promise<void> {
    const filename = filePath(path)
    if (!__gea_node_fs_access(filename, mode)) throw new Error(`ENOENT: cannot access '${filename}'`)
  }

  readFile(path: string | URL, encoding: BufferEncoding): Promise<string>
  readFile(path: string | URL, encoding?: null): Promise<Buffer>
  async readFile(path: string | URL, encoding: BufferEncoding | null = null): Promise<Buffer | string> {
    const filename = filePath(path)
    if (!__gea_node_fs_access(filename, nodeFsConstants.R_OK)) {
      throw new Error(`ENOENT: cannot read '${filename}'`)
    }
    const bytes = __gea_node_fs_read_file(filename)
    return encoding === null ? bytes : bytes.toString(encoding)
  }
}

const nodeFsPromises = new FsPromises()

export { nodeFsConstants as constants, nodeFsPromises as promises }

// `existsSync` is exactly what it is on real Node: an access(2)-style
// presence check with the error swallowed. `__gea_node_fs_access` already IS
// that check, so this is a real implementation, not a stand-in for one.
export function existsSync(path: string | URL): boolean {
  return __gea_node_fs_access(filePath(path), nodeFsConstants.F_OK)
}

// The real Node.js `fs.Stats` shape. Declared in full because callers
// (`@hono/node-server`'s serveStatic) narrow on it structurally, but see
// `statSync` below: nothing on this target can actually produce one of these,
// so the type exists without a value ever legitimately carrying it.
export interface Stats {
  isFile(): boolean
  isDirectory(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  blksize: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
}

// There is no `stat`/`fstat` primitive bound on this target (`gea_node.cpp`
// exposes exactly two fs syscalls: `access` and a whole-file `read`) -- no
// mtime, no mode, no size independent of reading the whole file, and no way
// to tell a directory from a regular file. Inventing any of those (today's
// Date as a fake mtime, `false` as a guessed `isDirectory()`) would be a
// fabricated value wearing a real type, which is worse than refusing. This
// refuses by name instead: a program that reaches it fails loudly rather than
// silently mis-serving, e.g. treating every path as "not found" or every file
// as unmodified.
export function statSync(path: string | URL, options?: unknown): Stats {
  void path
  void options
  return nodeNotImplemented('fs', 'statSync')
}

export interface ReadStreamOptions {
  start?: number
  end?: number
  encoding?: BufferEncoding
  highWaterMark?: number
}

// A real Readable: it delivers the actual bytes of the actual file (sliced to
// `start`/`end`, Node's byte range is inclusive of `end`), honors `encoding`
// via Readable's own `setEncoding`, and defers a read failure to the next
// microtask so a caller who attaches `.on('error', ...)` only after
// `createReadStream()` returns -- the normal pattern, and exactly what
// @hono/node-server's serve-static does -- still observes it, matching Node's
// async error-emission contract instead of throwing synchronously out of the
// constructor before anyone is listening.
//
// What is NOT real: there is no fd-based chunked read syscall bound on this
// target (see `statSync` above), only a whole-file `__gea_node_fs_read_file`.
// So this reads the entire file synchronously up front and hands it to
// `Readable` as a single push -- correct bytes, not incremental disk I/O. A
// large file is fully materialized in memory even when only a small byte
// range is requested.
export class ReadStream extends Readable {
  constructor(path: string | URL, options: ReadStreamOptions = {}) {
    super({ highWaterMark: options.highWaterMark })
    if (options.encoding !== undefined) this.setEncoding(options.encoding)
    const filename = filePath(path)
    try {
      const bytes = __gea_node_fs_read_file(filename)
      const start = options.start ?? 0
      const end = options.end === undefined ? bytes.length - 1 : options.end
      this.push(bytes.subarray(start, end + 1))
      this.push(null)
    } catch (error) {
      Promise.resolve().then(() => this.destroy(error instanceof Error ? error : new Error(String(error))))
    }
  }
}

export function createReadStream(path: string | URL, options: ReadStreamOptions = {}): ReadStream {
  return new ReadStream(path, options)
}
