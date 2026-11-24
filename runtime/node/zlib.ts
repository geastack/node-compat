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

// Node's `InputType`: a string (encoded as UTF-8), an ArrayBuffer, or any
// ArrayBufferView. The views are spelled as the carriers they can be, as Web
// Crypto's `BufferSource` is in globals.ts, so each arm is the native typed
// array itself -- a database driver's wire compression hands its
// `Uint8Array` message straight through -- and a Buffer arrives as the
// Uint8Array it is. Every codec reads the bytes the view covers, never the
// whole backing store.
export type InputType =
  | string
  | ArrayBuffer
  | DataView
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

const bytesOf = (input: InputType): Buffer =>
  typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : ArrayBuffer.isView(input)
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(input)

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
/** @gea-host-inert */
declare function __gea_node_zstd_compressor_open(): number
/** @gea-host-inert */
declare function __gea_node_zstd_compressor_set(handle: number, key: number, value: number): void
/** @gea-host-inert */
declare function __gea_node_zstd_compress(handle: number, input: Buffer): Buffer
/** @gea-host-inert */
declare function __gea_node_zstd_compressor_close(handle: number): void
/** @gea-host-inert */
declare function __gea_node_zstd_decompress(input: Buffer): Buffer

// zlib's `windowBits` for each of node's framings.
const ZLIB = 15
const GZIP = 31
const RAW = -15
const DETECT = 47

// The zstd entries are libzstd's own enum values, which node re-exports
// unchanged (read from node 24's `zlib.constants`).
export const constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_fast: 1,
  ZSTD_dfast: 2,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_hashLog: 102,
  ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105,
  ZSTD_c_targetLength: 106,
  ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401,
  ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100,
  ZSTD_CLEVEL_DEFAULT: 3
}

const levelOf = (options: ZlibOptions | undefined): number => options?.level ?? constants.Z_DEFAULT_COMPRESSION

export function inflateSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(bytesOf(input), ZLIB)
}

export function deflateSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(bytesOf(input), ZLIB, levelOf(options))
}

export function gunzipSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(bytesOf(input), GZIP)
}

export function gzipSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(bytesOf(input), GZIP, levelOf(options))
}

export function inflateRawSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(bytesOf(input), RAW)
}

export function deflateRawSync(input: InputType, options?: ZlibOptions): Buffer {
  return __gea_node_zlib_deflate(bytesOf(input), RAW, levelOf(options))
}

export function unzipSync(input: InputType): Buffer {
  return __gea_node_zlib_inflate(bytesOf(input), DETECT)
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
  return __gea_node_brotli_decompress(bytesOf(input))
}

export function brotliDecompress(input: InputType, callback: ZlibCallback): void {
  settle(callback, () => brotliDecompressSync(input))
}

// Node's `ZstdOptions`, the part a one-shot codec reads: `params` maps
// `constants.ZSTD_c_*` to a number, or to a boolean for the flag parameters
// (libzstd reads a flag as 1 or 0).
export interface ZstdOptions {
  params?: { [key: number]: number | boolean }
}

// The parameters reach the encoder before this returns, as node applies them
// in the codec's constructor: a parameter libzstd rejects throws here, not
// through the callback. Reading `params` only now also keeps the caller's
// dictionary out of the deferred work.
export function zstdCompress(input: InputType, options: ZstdOptions, callback: ZlibCallback): void {
  const handle = __gea_node_zstd_compressor_open()
  try {
    const params = options.params
    if (params !== undefined) {
      for (const key of Object.keys(params)) {
        const value = params[Number(key)]
        __gea_node_zstd_compressor_set(handle, Number(key), typeof value === 'number' ? value : value ? 1 : 0)
      }
    }
  } catch (error) {
    __gea_node_zstd_compressor_close(handle)
    throw error
  }
  settle(callback, () => {
    try {
      return __gea_node_zstd_compress(handle, bytesOf(input))
    } finally {
      __gea_node_zstd_compressor_close(handle)
    }
  })
}

export function zstdDecompress(input: InputType, callback: ZlibCallback): void {
  settle(callback, () => __gea_node_zstd_decompress(bytesOf(input)))
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
