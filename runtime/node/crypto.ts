// Typed node:crypto byte generation. Buffer stays on the native carrier; the
// optional callback is scheduled as a microtask to preserve Node's async form.

import { Buffer } from './buffer'
import type { BufferEncoding } from './buffer'

export type RandomBytesCallback = (error: Error | null, buffer: Buffer) => void

declare function __gea_node_crypto_random_bytes(size: number): Buffer

function nodeCryptoRandomBytes(size: number): Buffer
function nodeCryptoRandomBytes(size: number, callback: RandomBytesCallback): void
function nodeCryptoRandomBytes(size: number, callback?: RandomBytesCallback): Buffer | void {
  const bytes = __gea_node_crypto_random_bytes(size)
  if (callback !== undefined) {
    queueMicrotask(() => callback(null, bytes))
    return
  }
  return bytes
}

export { nodeCryptoRandomBytes as randomBytes }

export type BinaryLike = string | Uint8Array

/** @gea-host-inert */
declare function __gea_node_crypto_validate(algorithm: string): void
declare function __gea_node_crypto_digest(algorithm: string, input: Buffer): Buffer
declare function __gea_node_crypto_hmac(algorithm: string, key: Buffer, input: Buffer): Buffer
declare function __gea_node_crypto_pbkdf2(password: Buffer, salt: Buffer, iterations: number, keyLength: number, digest: string): Buffer
declare function __gea_node_crypto_timing_safe_equal(left: Uint8Array, right: Uint8Array): boolean
/** @gea-host-inert */
declare function __gea_node_crypto_get_fips(): number

function copyBytes(input: BinaryLike, encoding: BufferEncoding = 'utf8'): Buffer {
  return typeof input === 'string' ? Buffer.from(input, encoding) : Buffer.from(input)
}

// Copy at update time: a caller may mutate a Buffer before digest(). Keeping
// owned chunks also makes Hash.copy() independent without dynamic carriers.
export class Hash {
  private chunks: Buffer[] = []
  private finalized = false
  private algorithm: string

  constructor(algorithm: string) {
    __gea_node_crypto_validate(algorithm)
    this.algorithm = algorithm
  }

  update(data: BinaryLike, inputEncoding: BufferEncoding = 'utf8'): Hash {
    if (this.finalized) throw new Error('Digest already called')
    this.chunks.push(copyBytes(data, inputEncoding))
    return this
  }

  copy(): Hash {
    if (this.finalized) throw new Error('Digest already called')
    const result = new Hash(this.algorithm)
    result.chunks = this.chunks.slice()
    return result
  }

  digest(): Buffer
  digest(encoding: BufferEncoding): string
  digest(encoding?: BufferEncoding): Buffer | string {
    if (this.finalized) throw new Error('Digest already called')
    const bytes = __gea_node_crypto_digest(this.algorithm, Buffer.concat(this.chunks))
    this.finalized = true
    this.chunks = []
    return encoding === undefined ? bytes : bytes.toString(encoding)
  }
}

export class Hmac {
  private chunks: Buffer[] = []
  private finalized = false
  private algorithm: string
  private key: Buffer

  constructor(algorithm: string, key: BinaryLike) {
    __gea_node_crypto_validate(algorithm)
    this.algorithm = algorithm
    this.key = copyBytes(key)
  }

  update(data: BinaryLike, inputEncoding: BufferEncoding = 'utf8'): Hmac {
    if (this.finalized) throw new Error('Digest already called')
    this.chunks.push(copyBytes(data, inputEncoding))
    return this
  }

  digest(): Buffer
  digest(encoding: BufferEncoding): string
  digest(encoding?: BufferEncoding): Buffer | string {
    // Node's Hmac returns an empty digest on subsequent calls; Hash throws.
    const bytes = this.finalized ? Buffer.alloc(0) : __gea_node_crypto_hmac(this.algorithm, this.key, Buffer.concat(this.chunks))
    this.finalized = true
    this.chunks = []
    this.key = Buffer.alloc(0)
    return encoding === undefined ? bytes : bytes.toString(encoding)
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm)
}

export function createHmac(algorithm: string, key: BinaryLike): Hmac {
  return new Hmac(algorithm, key)
}

export function pbkdf2Sync(password: BinaryLike, salt: BinaryLike, iterations: number, keyLength: number, digest: string): Buffer {
  return __gea_node_crypto_pbkdf2(copyBytes(password), copyBytes(salt), iterations, keyLength, digest)
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return __gea_node_crypto_timing_safe_equal(left, right)
}

export function getFips(): number {
  return __gea_node_crypto_get_fips()
}
