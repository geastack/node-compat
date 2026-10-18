// node:fs subset needed by a database driver's handshake metadata, its optional
// TLS file loader, and (below) an HTTP framework's static-file middleware. Host
// syscalls are synchronous; Promise wrapping preserves the observable driver
// API without routing file bytes through a dynamic value.

import { Buffer } from './buffer'
import type { BufferEncoding } from './buffer'
import { Readable } from './stream'
import { nodeNotImplemented } from './not-implemented'

/** @gea-host-inert */
declare function __gea_node_fs_access(path: string, mode: number): boolean
/** @gea-host-inert */
declare function __gea_node_fs_read_file(path: string): Buffer
/** @gea-host-inert */
declare function __gea_node_fs_stat(path: string, followSymlinks: boolean): number
/** @gea-host-inert */
declare function __gea_node_fs_stat_field(field: number): number
/** @gea-host-inert */
declare function __gea_node_net_errno_name(error: number): string

const nodeFsConstants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFCHR: 0o020000,
  S_IFBLK: 0o060000,
  S_IFIFO: 0o010000,
  S_IFLNK: 0o120000,
  S_IFSOCK: 0o140000
}

/** @gea-host-inert */
declare function __gea_node_platform(): string

function filePath(path: string | URL): string {
  if (typeof path === 'string') return path
  if (path.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
  if (__gea_node_platform() === 'win32') return windowsFilePath(path)
  if (path.hostname !== '' && path.hostname !== 'localhost') throw new TypeError('File URL host must be localhost or empty')
  if (/%2f/i.test(path.pathname)) throw new TypeError('File URL path must not include encoded / characters')
  return decodeURIComponent(path.pathname)
}

// node's `fileURLToPath` on Windows: `file:///C:/a/b` is `C:\a\b`, and a URL
// with a host names a UNC share, `\\host\share\...`.
function windowsFilePath(path: URL): string {
  if (/%2f|%5c/i.test(path.pathname)) throw new TypeError('File URL path must not include encoded \\ or / characters')
  const pathname = decodeURIComponent(path.pathname.replace(/\//g, '\\'))
  if (path.hostname !== '' && path.hostname !== 'localhost') return `\\\\${path.hostname}${pathname}`
  const letter = pathname.charCodeAt(1) | 0x20
  if (pathname.length < 3 || letter < 97 || letter > 122 || pathname.charAt(2) !== ':')
    throw new TypeError('File URL path must be absolute')
  return pathname.slice(1)
}

export interface FsSystemError extends Error {
  errno: number
  code: string
  syscall: string
  path: string
}

function fsErrnoDescription(code: string, errnoValue: number): string {
  switch (code) {
    case 'EACCES':
      return 'permission denied'
    case 'EIO':
      return 'i/o error'
    case 'ELOOP':
      return 'too many symbolic links encountered'
    case 'ENAMETOOLONG':
      return 'name too long'
    case 'ENOENT':
      return 'no such file or directory'
    case 'ENOMEM':
      return 'not enough memory'
    case 'ENOTDIR':
      return 'not a directory'
    case 'EOVERFLOW':
      return 'value too large for defined data type'
    case 'EPERM':
      return 'operation not permitted'
    default:
      return `Unknown system error ${errnoValue}`
  }
}

function fsSystemError(errnoValue: number, syscall: string, path: string): FsSystemError {
  const named = __gea_node_net_errno_name(errnoValue)
  const code = named === 'UNKNOWN' ? `Unknown system error ${errnoValue}` : named
  const error = new Error(`${code}: ${fsErrnoDescription(code, errnoValue)}, ${syscall} '${path}'`) as FsSystemError
  error.errno = -errnoValue
  error.code = code
  error.syscall = syscall
  error.path = path
  return error
}

export class Stats {
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

  constructor(
    dev: number,
    ino: number,
    mode: number,
    nlink: number,
    uid: number,
    gid: number,
    rdev: number,
    size: number,
    blksize: number,
    blocks: number,
    atimeMs: number,
    mtimeMs: number,
    ctimeMs: number,
    birthtimeMs: number
  ) {
    this.dev = dev
    this.ino = ino
    this.mode = mode
    this.nlink = nlink
    this.uid = uid
    this.gid = gid
    this.rdev = rdev
    this.size = size
    this.blksize = blksize
    this.blocks = blocks
    this.atimeMs = atimeMs
    this.mtimeMs = mtimeMs
    this.ctimeMs = ctimeMs
    this.birthtimeMs = birthtimeMs
    this.atime = new Date(Math.round(atimeMs))
    this.mtime = new Date(Math.round(mtimeMs))
    this.ctime = new Date(Math.round(ctimeMs))
    this.birthtime = new Date(Math.round(birthtimeMs))
  }

  private isType(type: number): boolean {
    return (this.mode & nodeFsConstants.S_IFMT) === type
  }
  isFile(): boolean {
    return this.isType(nodeFsConstants.S_IFREG)
  }
  isDirectory(): boolean {
    return this.isType(nodeFsConstants.S_IFDIR)
  }
  isBlockDevice(): boolean {
    return this.isType(nodeFsConstants.S_IFBLK)
  }
  isCharacterDevice(): boolean {
    return this.isType(nodeFsConstants.S_IFCHR)
  }
  isSymbolicLink(): boolean {
    return this.isType(nodeFsConstants.S_IFLNK)
  }
  isFIFO(): boolean {
    return this.isType(nodeFsConstants.S_IFIFO)
  }
  isSocket(): boolean {
    return this.isType(nodeFsConstants.S_IFSOCK)
  }
}

export interface StatOptions {
  bigint?: boolean
}

function statPath(path: string | URL, options: StatOptions | undefined, syscall: string, member: string): Stats {
  if (options !== undefined && options.bigint === true) return nodeNotImplemented('fs', `${member} with bigint`)
  const filename = filePath(path)
  const errnoValue = __gea_node_fs_stat(filename, syscall === 'stat')
  if (errnoValue !== 0) throw fsSystemError(errnoValue, syscall, filename)
  return new Stats(
    __gea_node_fs_stat_field(0),
    __gea_node_fs_stat_field(1),
    __gea_node_fs_stat_field(2),
    __gea_node_fs_stat_field(3),
    __gea_node_fs_stat_field(4),
    __gea_node_fs_stat_field(5),
    __gea_node_fs_stat_field(6),
    __gea_node_fs_stat_field(7),
    __gea_node_fs_stat_field(8),
    __gea_node_fs_stat_field(9),
    __gea_node_fs_stat_field(10),
    __gea_node_fs_stat_field(11),
    __gea_node_fs_stat_field(12),
    __gea_node_fs_stat_field(13)
  )
}

export interface StatSyncOptions extends StatOptions {
  throwIfNoEntry?: boolean
}

export function statSync(path: string | URL, options?: StatSyncOptions & { throwIfNoEntry?: true }): Stats
export function statSync(path: string | URL, options: StatSyncOptions & { throwIfNoEntry: false }): Stats | undefined
export function statSync(path: string | URL, options?: StatSyncOptions): Stats | undefined {
  try {
    return statPath(path, options, 'stat', 'statSync')
  } catch (error) {
    if (options !== undefined && options.throwIfNoEntry === false && error instanceof Error && 'syscall' in error) {
      const failure = error as FsSystemError
      if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') return undefined
    }
    throw error
  }
}

export type StatCallback = (err: FsSystemError | null, stats: Stats | undefined) => void

export function stat(path: string | URL, optionsOrCallback: StatOptions | StatCallback, callback?: StatCallback): void {
  const options: StatOptions | undefined = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
  const done: StatCallback | undefined = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
  if (done === undefined) throw new TypeError('The "cb" argument must be of type function. Received undefined')
  let stats: Stats | undefined
  let failure: FsSystemError | null = null
  try {
    stats = statPath(path, options, 'stat', 'stat')
  } catch (error) {
    if (error instanceof Error && 'syscall' in error) failure = error as FsSystemError
    else throw error
  }
  Promise.resolve().then(() => {
    done(failure, stats)
  })
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

  async stat(path: string | URL, options?: StatOptions): Promise<Stats> {
    return statPath(path, options, 'stat', 'promises.stat')
  }
}

const nodeFsPromises = new FsPromises()

export { nodeFsConstants as constants, nodeFsPromises as promises }

export function existsSync(path: string | URL): boolean {
  return __gea_node_fs_access(filePath(path), nodeFsConstants.F_OK)
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
// an HTTP framework's static-file middleware does -- still observes it, matching Node's
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
      // A block body: `destroy` returns the stream, and an expression body made
      // this a `Promise<ReadStream>`, boxing every Readable subclass through
      // the typed `then`.
      Promise.resolve().then(() => {
        this.destroy(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }
}

export function createReadStream(path: string | URL, options: ReadStreamOptions = {}): ReadStream {
  return new ReadStream(path, options)
}
