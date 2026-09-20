import { Blob, Buffer } from '../buffer'
import type { Readable } from '../stream'

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value)
  return Buffer.from(value as Uint8Array)
}

export function buffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalLength = 0
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, totalLength))
    }
    const fail = (error?: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    stream.once('error', fail)
    stream.once('end', finish)
    stream.on('data', (chunk?: unknown) => {
      const value = asBuffer(chunk)
      chunks.push(value)
      totalLength += value.length
    })
  })
}

export function text(stream: Readable): Promise<string> {
  return buffer(stream).then(value => value.toString('utf8'))
}

export function json(stream: Readable): Promise<unknown> {
  return text(stream).then(value => JSON.parse(value))
}

export function arrayBuffer(stream: Readable): Promise<ArrayBuffer> {
  return buffer(stream).then(value =>
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  )
}

export function blob(stream: Readable): Promise<Blob> {
  return buffer(stream).then(value => new Blob([value]))
}
