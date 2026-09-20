import { Buffer } from 'node:buffer'
import { Readable, Writable } from 'node:stream'
import { arrayBuffer, blob, buffer, json, text } from 'node:stream/consumers'
import { finished, pipeline } from 'node:stream/promises'

class Collector extends Writable {
  chunks: string[]

  constructor() {
    super()
    this.chunks = []
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    callback(null)
  }
}

const destination = new Collector()

pipeline(Readable.from([Buffer.from('pro'), Buffer.from('mise')], { objectMode: false }), destination)
  .then(() => {
    console.log(`promise-pipeline:${destination.chunks.join('')},${destination.writableFinished}`)
    const completed = new Collector()
    completed.end(Buffer.from('done'))
    return finished(completed)
  })
  .then(() => {
    console.log('promise-finished:true')
    return text(Readable.from([Buffer.from('hello'), Buffer.from(' world')], { objectMode: false }))
  })
  .then(value => {
    console.log(`text:${value}`)
    return buffer(Readable.from([Buffer.from('buf'), Buffer.from('fer')], { objectMode: false }))
  })
  .then(value => {
    console.log(`buffer:${value.toString('utf8')},${value.length}`)
    return json(Readable.from([Buffer.from('{"answer":42}')], { objectMode: false }))
  })
  .then(value => {
    const record = value as { answer: number }
    console.log(`json:${record.answer}`)
    return arrayBuffer(Readable.from([Buffer.from('bytes')], { objectMode: false }))
  })
  .then(value => {
    console.log(`array-buffer:${value.byteLength}`)
    return blob(Readable.from([Buffer.from('blob')], { objectMode: false }))
  })
  .then(value => {
    console.log(`blob-size:${value.size}`)
    return value.text()
  })
  .then(contents => console.log(`blob-text:${contents}`))
