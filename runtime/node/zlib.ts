// node:zlib's codecs, over the platform zlib (`gea_node_zlib.hpp`).
//
// The synchronous functions are node's `*Sync` family; the callback forms run
// the same codec and report on a later turn, as node's do. Streams
// (`createGzip` and friends) hold a native codec handle and push each chunk's
// output as it is produced. Buffer never crosses a dynamic
// carrier: a database driver's wire compression and saslprep's code-point
// tables both hand over a whole Buffer and take a whole Buffer back.

import { Buffer } from './buffer'
import { Transform, type DestroyCallback, type TransformCallback } from './stream'

// The driver always supplies Buffer here. Keeping the alias exact to that
// source use prevents the Buffer | Uint8Array API union from degrading the
// wire payload to gea_cpp_value.
export type InputType = Buffer

export interface ZlibOptions {
  level?: number
}

export type ZlibCallback = (error: Error | null, result: Buffer) => void

/** @gea-host-inert */
declare function __gea_node_zlib_inflate(input: Buffer, windowBits: number): Buffer
/** @gea-host-inert */
declare function __gea_node_zlib_deflate(input: Buffer, windowBits: number, level: number): Buffer
/** @gea-host-inert */
declare function __gea_node_brotli_decompress(input: Buffer): Buffer
/** @gea-host-inert */
declare function __gea_node_zlib_stream_open(mode: number, windowBits: number, level: number): number
/** @gea-host-inert */
declare function __gea_node_zlib_stream_write(handle: number, input: Buffer): void
/** @gea-host-inert */
declare function __gea_node_zlib_stream_read(handle: number): Buffer
/** @gea-host-inert */
declare function __gea_node_zlib_stream_pending(handle: number): boolean
/** @gea-host-inert */
declare function __gea_node_zlib_stream_leftover(handle: number): boolean
/** @gea-host-inert */
declare function __gea_node_zlib_stream_finish(handle: number): Buffer
/** @gea-host-inert */
declare function __gea_node_zlib_stream_close(handle: number): void
/** @gea-host-inert */
declare function __gea_node_brotli_stream_open(): number
/** @gea-host-inert */
declare function __gea_node_brotli_stream_write(handle: number, input: Buffer): void
/** @gea-host-inert */
declare function __gea_node_brotli_stream_read(handle: number): Buffer
/** @gea-host-inert */
declare function __gea_node_brotli_stream_pending(handle: number): boolean
/** @gea-host-inert */
declare function __gea_node_brotli_stream_leftover(handle: number): boolean
/** @gea-host-inert */
declare function __gea_node_brotli_stream_finish(handle: number): void
/** @gea-host-inert */
declare function __gea_node_brotli_stream_close(handle: number): void

// zlib's `windowBits` for each of node's framings.
const ZLIB = 15
const GZIP = 31
const RAW = -15
const DETECT = 47

export const constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1
}

const levelOf = (options: ZlibOptions | undefined): number => options?.level ?? constants.Z_DEFAULT_COMPRESSION

export function inflateSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(input, ZLIB)
}

export function deflateSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(input, ZLIB, levelOf(options))
}

export function gunzipSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(input, GZIP)
}

export function gzipSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(input, GZIP, levelOf(options))
}

export function inflateRawSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(input, RAW)
}

export function deflateRawSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(input, RAW, levelOf(options))
}

export function unzipSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(input, DETECT)
}

/** Run a codec now and report on a later turn: node never calls a zlib callback synchronously. */
const settle = (callback: ZlibCallback, run: () => Buffer): void => {
  let result: Buffer
  try {
    result = run()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    queueMicrotask(() => callback(failure, Buffer.alloc(0)))
    return
  }
  queueMicrotask(() => callback(null, result))
}

export function inflate(input: InputType, callback: ZlibCallback): void {
  settle(callback, () => inflateSync(input))
}

export function deflate(input: InputType, options: ZlibOptions, callback: ZlibCallback): void {
  settle(callback, () => deflateSync(input, options))
}

export function gunzip(input: InputType, callback: ZlibCallback): void {
  settle(callback, () => gunzipSync(input))
}

export function gzip(input: InputType, options: ZlibOptions, callback: ZlibCallback): void {
  settle(callback, () => gzipSync(input, options))
}

export function brotliDecompressSync(input: InputType): Buffer {
  return __gea_node_brotli_decompress(input)
}

export function brotliDecompress(input: InputType, callback: ZlibCallback): void {
  settle(callback, () => brotliDecompressSync(input))
}

const MODE_INFLATE = 0
const MODE_DEFLATE = 1
const MODE_BROTLI_DECOMPRESS = 2

const failureOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

class ZlibBase extends Transform {
  private handle_: number
  private brotli_: boolean

  constructor(mode: number, windowBits: number, level: number) {
    super()
    this.brotli_ = mode === MODE_BROTLI_DECOMPRESS
    this.handle_ = this.brotli_ ? __gea_node_brotli_stream_open() : __gea_node_zlib_stream_open(mode, windowBits, level)
  }

  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    try {
      if (this.brotli_) __gea_node_brotli_stream_write(this.handle_, chunk)
      else __gea_node_zlib_stream_write(this.handle_, chunk)
    } catch (error) {
      this.release_()
      callback(failureOf(error))
      return
    }
    this.drain_(false, callback)
  }

  override _flush(callback: TransformCallback): void {
    this.drain_(true, callback)
  }

  private drain_(finishing: boolean, callback: TransformCallback): void {
    let more = true
    while (more) {
      let piece: Buffer
      try {
        piece = this.step_(finishing)
        more = this.brotli_ ? __gea_node_brotli_stream_pending(this.handle_) : __gea_node_zlib_stream_pending(this.handle_)
      } catch (error) {
        this.release_()
        callback(failureOf(error))
        return
      }
      if (piece.length > 0) this.push(piece)
      if (this.destroyed) {
        callback(null)
        return
      }
    }
    if (finishing) {
      this.release_()
      callback(null)
      return
    }
    const leftover = this.brotli_ ? __gea_node_brotli_stream_leftover(this.handle_) : __gea_node_zlib_stream_leftover(this.handle_)
    if (leftover) this.push(null)
    callback(null)
  }

  private step_(finishing: boolean): Buffer {
    if (!this.brotli_) return finishing ? __gea_node_zlib_stream_finish(this.handle_) : __gea_node_zlib_stream_read(this.handle_)
    if (!finishing) return __gea_node_brotli_stream_read(this.handle_)
    __gea_node_brotli_stream_finish(this.handle_)
    return Buffer.alloc(0)
  }

  override _destroy(error: Error | null, callback: DestroyCallback): void {
    this.release_()
    callback(error)
  }

  private release_(): void {
    if (this.handle_ === 0) return
    if (this.brotli_) __gea_node_brotli_stream_close(this.handle_)
    else __gea_node_zlib_stream_close(this.handle_)
    this.handle_ = 0
  }
}

export class Gunzip extends ZlibBase {
  constructor() {
    super(MODE_INFLATE, GZIP, 0)
  }
}

export class Inflate extends ZlibBase {
  constructor() {
    super(MODE_INFLATE, ZLIB, 0)
  }
}

export class InflateRaw extends ZlibBase {
  constructor() {
    super(MODE_INFLATE, RAW, 0)
  }
}

export class Unzip extends ZlibBase {
  constructor() {
    super(MODE_INFLATE, DETECT, 0)
  }
}

export class BrotliDecompress extends ZlibBase {
  constructor() {
    super(MODE_BROTLI_DECOMPRESS, 0, 0)
  }
}

export class Gzip extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(MODE_DEFLATE, GZIP, levelOf(options))
  }
}

export class Deflate extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(MODE_DEFLATE, ZLIB, levelOf(options))
  }
}

export class DeflateRaw extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(MODE_DEFLATE, RAW, levelOf(options))
  }
}

export function createGunzip(): Gunzip {
  return new Gunzip()
}

export function createInflate(): Inflate {
  return new Inflate()
}

export function createInflateRaw(): InflateRaw {
  return new InflateRaw()
}

export function createUnzip(): Unzip {
  return new Unzip()
}

export function createBrotliDecompress(): BrotliDecompress {
  return new BrotliDecompress()
}

export function createGzip(options?: ZlibOptions): Gzip {
  return new Gzip(options)
}

export function createDeflate(options?: ZlibOptions): Deflate {
  return new Deflate(options)
}

export function createDeflateRaw(options?: ZlibOptions): DeflateRaw {
  return new DeflateRaw(options)
}
