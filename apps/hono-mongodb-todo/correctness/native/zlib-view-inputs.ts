// node:zlib's callback codecs, promisified the way a database driver's wire
// compression wraps them, fed every `InputType` Node accepts: a Uint8Array
// window into a larger buffer, other ArrayBufferViews, an ArrayBuffer, a
// string, and a Buffer. Only round trips and inflated bytes are printed, so
// the output does not depend on which zlib build compressed. Named imports
// keep the brotli decoder, which nothing here calls, out of the program.

import { deflate, gunzipSync, gzipSync, inflate, inflateSync, type InputType, type ZlibOptions } from 'node:zlib'
import { Buffer } from 'node:buffer'

const zlibInflate = (input: InputType): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    inflate(input, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })

const zlibDeflate = (input: InputType, options: ZlibOptions): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    deflate(input, options, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })

const text = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')

async function main(): Promise<void> {
  // A message body that is a window into a larger frame, as a wire message is.
  const frame = new Uint8Array(64)
  for (let index = 0; index < frame.length; index++) frame[index] = (index * 7) & 255
  const window = frame.subarray(16, 48)
  const level = { level: 6 }
  console.log('uint8 window', text(await zlibInflate(await zlibDeflate(window, level))))
  console.log('int16', text(await zlibInflate(await zlibDeflate(new Int16Array([1, -2, 300, -32768]), level))))
  console.log('dataview', text(await zlibInflate(await zlibDeflate(new DataView(frame.buffer, 60, 4), level))))
  console.log('arraybuffer', text(await zlibInflate(await zlibDeflate(frame.buffer.slice(0, 8), level))))
  console.log('string', text(await zlibInflate(await zlibDeflate('pāss\0word', {}))))
  console.log('buffer', text(await zlibInflate(await zlibDeflate(Buffer.from('buffer still works'), level))))

  // Node-produced zlib bytes, handed over as a view with a nonzero offset.
  const compressed = Buffer.from('789c2bcb4c2d57c8cc2b282d2956284a4d4cce5028c9485548ce4f494d060090ba0a21', 'hex')
  const padded = new Uint8Array(compressed.length + 5)
  padded.set(compressed, 3)
  console.log('offset view', Buffer.from(await zlibInflate(padded.subarray(3, 3 + compressed.length))).toString('utf8'))
  console.log('sync view', inflateSync(padded.subarray(3, 3 + compressed.length)).toString('utf8'))
  console.log('sync string', gunzipSync(gzipSync('gzip a string')).toString('utf8'))

  try {
    await zlibInflate(new Uint8Array([1, 2, 3, 4]))
    console.log('garbage inflated')
  } catch {
    console.log('garbage rejected')
  }
}

main()
