// Strongly typed `node:buffer` surface for geatsc's node-compat target.
//
// The `Buffer` declarations themselves live in `buffer-types.ts` and are
// re-exported here: see that file's header for why naming a type must not drag
// an implementation in. This module is what `node:buffer` resolves to, so it
// owns the one thing in the surface that has a body -- `Blob`.

// `Buffer` is re-exported as a VALUE (which carries its type meaning with it),
// not in the `export type` list: naming it in both makes the type-only export
// win, and every `Buffer.from(...)` through this module then reads "cannot be
// used as a value because it was exported using 'export type'".
export type { BufferEncoding, BufferConstructor } from './buffer-types'
export { Buffer } from './buffer-types'
import { Buffer } from './buffer-types'
import type { Buffer as BufferType } from './buffer-types'
export type { BufferType }

export interface BlobOptions {
  endings?: 'transparent' | 'native'
  type?: string
}

export class Blob {
  private data_: Buffer
  readonly size: number
  readonly type: string

  constructor(sources: readonly unknown[] = [], options: BlobOptions = {}) {
    const chunks: Buffer[] = []
    let totalLength = 0
    for (let index = 0; index < sources.length; index++) {
      const source: unknown = sources[index]
      let chunk: Buffer
      if (source instanceof Blob) chunk = source.data_
      else if (typeof source === 'string') chunk = Buffer.from(source)
      // Every remaining `BlobPart` the spec admits is a view over bytes
      // (`ArrayBuffer`, a TypedArray, a DataView). The cast states that last
      // arm, which narrowing cannot reach from `unknown`, rather than leaving
      // the whole binding open.
      else chunk = Buffer.from(source as Uint8Array)
      chunks.push(chunk)
      totalLength += chunk.length
    }
    this.data_ = Buffer.concat(chunks, totalLength)
    this.size = this.data_.length
    this.type = (options.type ?? '').toLowerCase()
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.data_.buffer.slice(
        this.data_.byteOffset,
        this.data_.byteOffset + this.data_.byteLength
      ) as ArrayBuffer
    )
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.data_)
  }

  slice(start: number = 0, end: number = this.size, contentType: string = ''): Blob {
    const from = start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size)
    const to = end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size)
    return new Blob([this.data_.subarray(from, Math.max(from, to))], { type: contentType })
  }

  stream(): unknown {
    return { data: this.data_ }
  }

  text(): Promise<string> {
    return Promise.resolve(this.data_.toString('utf8'))
  }
}

