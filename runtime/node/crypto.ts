// Typed node:crypto byte generation. Buffer stays on the native carrier; the
// optional callback is scheduled as a microtask to preserve Node's async form.

import { Buffer } from './buffer'
import type { BufferEncoding } from './buffer'
import { nodeNotImplemented } from './not-implemented'

export type RandomBytesCallback = (error: Error | null, buffer: Buffer) => void

/** @gea-host-inert */
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
/** @gea-host-inert */
declare function __gea_node_crypto_digest(algorithm: string, input: Buffer): Buffer
/** @gea-host-inert */
declare function __gea_node_crypto_hmac(algorithm: string, key: Buffer, input: Buffer): Buffer
/** @gea-host-inert */
declare function __gea_node_crypto_pbkdf2(password: Buffer, salt: Buffer, iterations: number, keyLength: number, digest: string): Buffer
/** @gea-host-inert */
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

/** Node's `randomFillSync(buffer, offset?, size?)`: fills in place and returns the same view. */
export function randomFillSync<T extends Uint8Array>(buffer: T, offset: number = 0, size: number = buffer.length - offset): T {
  if (offset < 0 || offset > buffer.length) throw new RangeError('The value of "offset" is out of range.')
  if (size < 0 || offset + size > buffer.length) throw new RangeError('The value of "size" is out of range.')
  buffer.set(__gea_node_crypto_random_bytes(size), offset)
  return buffer
}

// Node's cipher and signing classes, at the shapes node declares. The
// operations are not implemented on this target yet; the MongoDB client-side
// encryption hooks that name them are only reached through `mongocrypt`'s
// native addon, which this target cannot load either.
export class Cipher {
  setAutoPadding(_autoPadding: boolean = true): Cipher {
    return this
  }

  update(_data: BinaryLike): Buffer {
    return nodeNotImplemented('node:crypto', 'Cipher.update')
  }

  final(): Buffer {
    return nodeNotImplemented('node:crypto', 'Cipher.final')
  }
}

export class Decipher {
  setAutoPadding(_autoPadding: boolean = true): Decipher {
    return this
  }

  update(_data: BinaryLike): Buffer {
    return nodeNotImplemented('node:crypto', 'Decipher.update')
  }

  final(): Buffer {
    return nodeNotImplemented('node:crypto', 'Decipher.final')
  }
}

export class Sign {
  update(_data: BinaryLike): Sign {
    return this
  }

  end(): Sign {
    return this
  }

  sign(_privateKey: BinaryLike): Buffer {
    return nodeNotImplemented('node:crypto', 'Sign.sign')
  }
}

export function createCipheriv(_algorithm: string, _key: BinaryLike, _iv: BinaryLike | null): Cipher {
  return nodeNotImplemented('node:crypto', 'createCipheriv')
}

export function createDecipheriv(_algorithm: string, _key: BinaryLike, _iv: BinaryLike | null): Decipher {
  return nodeNotImplemented('node:crypto', 'createDecipheriv')
}

export function createSign(_algorithm: string): Sign {
  return nodeNotImplemented('node:crypto', 'createSign')
}
