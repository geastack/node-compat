import { Buffer } from 'node:buffer'
import {
  duplexPair,
  finished,
  getDefaultHighWaterMark,
  isReadable,
  isWritable,
  PassThrough,
  pipeline,
  Readable,
  setDefaultHighWaterMark,
  Writable
} from 'node:stream'

class Collector extends Writable {
  chunks: string[]
  writes: number

  constructor() {
    super({ highWaterMark: 2 })
    this.chunks = []
    this.writes = 0
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.writes++
    if (Buffer.isBuffer(chunk)) this.chunks.push(chunk.toString('utf8'))
    else this.chunks.push(String(chunk))
    callback(null)
  }
}

setDefaultHighWaterMark(false, 1024)
setDefaultHighWaterMark(true, 5)
console.log(`hwm:${getDefaultHighWaterMark(false)},${getDefaultHighWaterMark(true)}`)

const source = Readable.from([Buffer.from('a'), Buffer.from('b')], { objectMode: false })
const pass = new PassThrough()
const collector = new Collector()
let pipelineCalls = 0
pipeline(source, pass, collector, (error?: Error | null) => {
  if (error !== undefined && error !== null) throw error
  pipelineCalls++
})
console.log(
  `pipeline:${collector.chunks.join('')},${collector.writes},${collector.writableFinished},${pipelineCalls}`
)
console.log(`state:${isReadable(source)},${isWritable(collector)},${source.readableEnded}`)

let finishedCalls = 0
finished(collector, (error?: Error | null) => {
  if (error !== undefined && error !== null) throw error
  finishedCalls++
})
console.log(`finished:${finishedCalls}`)

const pair = duplexPair()
let paired = ''
pair[1].on('data', (chunk?: unknown) => {
  if (Buffer.isBuffer(chunk)) paired += chunk.toString('utf8')
})
pair[0].write(Buffer.from('pair'))
console.log(`duplex:${paired}`)

const corked = new Collector()
corked.cork()
corked.write(Buffer.from('x'))
corked.write(Buffer.from('y'))
console.log(`corked:${corked.writableCorked},${corked.writableLength}`)
corked.uncork()
corked.end()
console.log(`uncorked:${corked.chunks.join('')},${corked.writableFinished}`)

const numbers = Readable.from([1, 2, 3])
const mapped = numbers.map(value => Number(value) * 2)
const filtered = mapped.filter(value => Number(value) > 2)
filtered.toArray().then(values => console.log(`functional:${values.join(',')}`))
