// node:zlib's one-shot codecs, over the platform zlib (`gea_node_zlib.hpp`).
//
// The synchronous functions are node's `*Sync` family; the callback forms run
// the same codec and report on a later turn, as node's do. Streams
// (`createGzip` and friends) are not provided. Buffer never crosses a dynamic
// carrier: the MongoDB driver's wire compression and saslprep's code-point
// tables both hand over a whole Buffer and take a whole Buffer back.

import { Buffer } from './buffer'

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
