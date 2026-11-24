// node:zlib's zstd codecs, promisified exactly as a database driver's
// built-in zstd wire compressor wraps them (mongodb 7.9 `deps.ts`): the level
// rides in `params` under `constants.ZSTD_c_compressionLevel`. Only round
// trips and decoded bytes are printed -- a one-shot encoder and node's
// streaming one frame the same bytes differently -- plus how node rejects
// bad input.

import * as zlib from 'node:zlib'
import { Buffer } from 'node:buffer'

const compress = (buf: Uint8Array, level?: number): Promise<Uint8Array> => {
  const options = level == null ? {} : { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(buf, options, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })
}

const decompress = (buf: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    zlib.zstdDecompress(buf, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')

const rejection = async (input: Uint8Array): Promise<string> => {
  try {
    await decompress(input)
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : 'non-error'
  }
}

async function main(): Promise<void> {
  console.log('available', typeof zlib.zstdCompress === 'function' && typeof zlib.zstdDecompress === 'function')
  const message = Buffer.from('a wire message, a wire message, a wire message')
  console.log('default level', utf8(await decompress(await compress(message))))
  console.log('level 19', utf8(await decompress(await compress(message, 19))))
  console.log('level 1 window', utf8(await decompress(await compress(message.subarray(7, 19), 1))))
  console.log('empty', (await decompress(await compress(new Uint8Array(0)))).length)

  // A flag parameter takes a boolean: a checksummed frame is 4 bytes longer.
  const checksummed = await new Promise<Uint8Array>((resolve, reject) => {
    zlib.zstdCompress(message, { params: { [zlib.constants.ZSTD_c_checksumFlag]: true } }, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })
  console.log('checksum flag', utf8(await decompress(checksummed)), checksummed.length - (await compress(message)).length)

  // A frame node's streaming encoder wrote (no declared content size).
  console.log('node frame', utf8(await decompress(Buffer.from('28b52ffd2014a100007a737464206672616d652066726f6d206e6f6465', 'hex'))))

  const frame = await compress(message)
  console.log('truncated', await rejection(frame.subarray(0, frame.length - 2)))
  console.log('garbage', await rejection(new Uint8Array([1, 2, 3, 4])))
  console.log('nothing', await rejection(new Uint8Array(0)))
}

main()
