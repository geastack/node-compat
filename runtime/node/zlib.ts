// Typed node:zlib compile surface used by MongoDB's optional wire-compression
// path. Buffer never crosses a dynamic carrier. Compression is deliberately
// loud until a native codec is connected; uncompressed MongoDB traffic does
// not execute these functions.

import { type Buffer } from './buffer'

// The driver always supplies Buffer here. Keeping the alias exact to that
// source use prevents the Buffer | Uint8Array API union from degrading the
// wire payload to gea_cpp_value.
export type InputType = Buffer

export interface ZlibOptions {
  level?: number
}

export type ZlibCallback = (error: Error | null, result: Buffer) => void

export function inflate(input: InputType, callback: ZlibCallback): void {
  throw new Error('zlib.inflate is not supported by the gea node-compat runtime')
}

export function deflate(input: InputType, options: ZlibOptions, callback: ZlibCallback): void {
  throw new Error('zlib.deflate is not supported by the gea node-compat runtime')
}
