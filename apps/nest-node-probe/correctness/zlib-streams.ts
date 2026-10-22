import { Buffer } from 'node:buffer'
import { PassThrough, type Transform } from 'node:stream'
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
  gunzipSync
} from 'node:zlib'

const log = (line: string): void => {
  console.log(line)
}

const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(40)
const GZIP = '1f8b08000000000000130bc94855282ccd4cce56482aca2fcf5348cbaf50c82acd2d2856c82f4b2d5228c94855c849acaa5448c94fd7530819553caa7854f1a8e251c5a38a87976200e6c3956408070000'
const DEFLATE = '789c0bc94855282ccd4cce56482aca2fcf5348cbaf50c82acd2d2856c82f4b2d5228c94855c849acaa5448c94fd7530819553caa7854f1a8e251c5a38a87976200880a8637'
const DEFLATE_RAW = '0bc94855282ccd4cce56482aca2fcf5348cbaf50c82acd2d2856c82f4b2d5228c94855c849acaa5448c94fd7530819553caa7854f1a8e251c5a38a87976200'
const BROTLI = '1b0707882c0e78d3d0955d9710bb172ba9cad092cc8cad415ce6f236c8199e9e0a7b830d387048206f24bf41a715ce1c1e27aa2938c2a9749f0603'
const GZIP_MEMBERS = '1f8b08000000000000134bcb2c2a2e510000fc7af11c060000001f8b08000000000000132b4e4dcecf4b010069111fb606000000'

interface Case {
  name: string
  decoder: string
  input: Buffer
  expected: string
}

function decoder(kind: string): Transform {
  switch (kind) {
    case 'gunzip':
      return createGunzip()
    case 'inflate':
      return createInflate()
    case 'inflateRaw':
      return createInflateRaw()
    case 'unzip':
      return createUnzip()
    case 'brotli':
      return createBrotliDecompress()
    default:
      throw new Error(`unknown decoder ${kind}`)
  }
}

const cases: Case[] = [
  { name: 'gunzip', decoder: 'gunzip', input: Buffer.from(GZIP, 'hex'), expected: TEXT },
  { name: 'inflate', decoder: 'inflate', input: Buffer.from(DEFLATE, 'hex'), expected: TEXT },
  { name: 'inflateRaw', decoder: 'inflateRaw', input: Buffer.from(DEFLATE_RAW, 'hex'), expected: TEXT },
  { name: 'unzip gzip', decoder: 'unzip', input: Buffer.from(GZIP, 'hex'), expected: TEXT },
  { name: 'unzip zlib', decoder: 'unzip', input: Buffer.from(DEFLATE, 'hex'), expected: TEXT },
  { name: 'brotli', decoder: 'brotli', input: Buffer.from(BROTLI, 'hex'), expected: TEXT },
  { name: 'gunzip members', decoder: 'gunzip', input: Buffer.from(GZIP_MEMBERS, 'hex'), expected: 'first second' },
  { name: 'gunzip garbage', decoder: 'gunzip', input: Buffer.from('0102030405', 'hex'), expected: '' },
  { name: 'gunzip truncated', decoder: 'gunzip', input: Buffer.from(GZIP, 'hex').subarray(0, 40), expected: '' },
  { name: 'inflate garbage', decoder: 'inflate', input: Buffer.from('0102030405', 'hex'), expected: '' },
  { name: 'brotli truncated', decoder: 'brotli', input: Buffer.from(BROTLI, 'hex').subarray(0, 40), expected: '' },
  { name: 'brotli corrupt', decoder: 'brotli', input: Buffer.from('ff', 'hex'), expected: '' },
  { name: 'brotli empty', decoder: 'brotli', input: Buffer.from('3b', 'hex'), expected: '' }
]

let at = 0

function runDecoder(item: Case, done: () => void): void {
  const source = new PassThrough()
  const stream = decoder(item.decoder)
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  stream.on('end', () => {
    const output = Buffer.concat(chunks)
    log(`${item.name}: end ${output.length} ${output.toString() === item.expected ? 'match' : 'MISMATCH'}`)
  })
  stream.on('error', (error: Error) => {
    log(`${item.name}: error ${error.message}`)
  })
  stream.on('close', () => {
    log(`${item.name}: close destroyed ${stream.destroyed}`)
    done()
  })
  source.pipe(stream)
  const third = Math.max(1, Math.floor(item.input.length / 3))
  source.write(item.input.subarray(0, third))
  source.write(item.input.subarray(third, 2 * third))
  source.end(item.input.subarray(2 * third))
}

function roundTrip(name: string, encoder: Transform, decode: Transform, done: () => void): void {
  const chunks: Buffer[] = []
  encoder.pipe(decode)
  decode.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  decode.on('end', () => {
    const output = Buffer.concat(chunks)
    log(`${name}: end ${output.length} ${output.toString() === TEXT ? 'match' : 'MISMATCH'}`)
    done()
  })
  encoder.write(Buffer.from(TEXT.slice(0, 600)))
  encoder.write(Buffer.from(TEXT.slice(600, 1200)))
  encoder.end(Buffer.from(TEXT.slice(1200)))
}

function noise(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  let seed = 7
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    bytes[i] = seed % 256
  }
  return bytes
}

function beforeEnd(name: string, stream: Transform, input: Buffer, done: () => void): void {
  let seen = false
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    log(`${name}: output before end ${seen ? 'yes' : 'no'}`)
    stream.end()
  }
  const timer = setTimeout(finish, 2000)
  stream.on('data', () => {
    if (seen) return
    seen = true
    clearTimeout(timer)
    finish()
  })
  stream.on('end', () => done())
  stream.on('error', (error: Error) => {
    log(`${name}: error ${error.message}`)
    done()
  })
  stream.write(input)
}

function stringWrite(done: () => void): void {
  const encoder = createGzip()
  const chunks: Buffer[] = []
  encoder.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  encoder.on('end', () => {
    log(`gzip string write: ${gunzipSync(Buffer.concat(chunks)).toString()}`)
  })
  encoder.on('close', () => done())
  encoder.write('first ')
  encoder.end('second', 'utf8')
}

function next(): void {
  if (at < cases.length) {
    const item = cases[at]
    at++
    runDecoder(item, next)
    return
  }
  if (at === cases.length) {
    at++
    roundTrip('gzip round trip', createGzip(), createGunzip(), next)
    return
  }
  if (at === cases.length + 1) {
    at++
    roundTrip('deflate round trip', createDeflate({ level: 9 }), createInflate(), next)
    return
  }
  if (at === cases.length + 2) {
    at++
    roundTrip('deflateRaw round trip', createDeflateRaw(), createInflateRaw(), next)
    return
  }
  if (at === cases.length + 3) {
    at++
    beforeEnd('gunzip streams', createGunzip(), Buffer.from(GZIP, 'hex'), next)
    return
  }
  if (at === cases.length + 4) {
    at++
    beforeEnd('brotli streams', createBrotliDecompress(), Buffer.from(BROTLI, 'hex'), next)
    return
  }
  if (at === cases.length + 5) {
    at++
    beforeEnd('gzip streams', createGzip(), noise(262144), next)
    return
  }
  if (at === cases.length + 6) {
    at++
    stringWrite(next)
    return
  }
  log(`brotliDecompressSync: ${brotliDecompressSync(Buffer.from(BROTLI, 'hex')).toString() === TEXT ? 'match' : 'MISMATCH'}`)
  log(`gunzipSync: ${gunzipSync(Buffer.from(GZIP, 'hex')).toString() === TEXT ? 'match' : 'MISMATCH'}`)
  log('done')
}

log('start')
next()
