import {
  Duplex,
  Readable,
  Writable
} from 'node:stream'
import {
  ReadableStream,
  WritableStream
} from 'node:stream/web'

class Collector extends Writable {
  values: string[]

  constructor() {
    super({ objectMode: true })
    this.values = []
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.values.push(String(chunk))
    callback(null)
  }
}

const iterable = Readable.from(['one', 'two'])
const iterator: any = iterable.iterator({ destroyOnReturn: false })
const firstIteration: Promise<any> = iterator.next()
firstIteration.then((result: any) => {
  console.log(`iterator-next:${result.done},${result.value}`)
  const returned: Promise<any> = iterator.return()
  returned.then((closed: any) => console.log(`iterator-return:${closed.done},${iterable.destroyed}`))
})

const webInput = new ReadableStream({
  start(controller: any): void {
    const dynamicController: any = controller
    dynamicController.enqueue('from-web')
    dynamicController.close()
  }
})
const nodeInput = Readable.fromWeb(webInput, { objectMode: true })
const nodeInputValues: string[] = []
nodeInput.on('data', (value?: any) => nodeInputValues.push(String(value)))
nodeInput.once('end', () => console.log(`readable-from:${nodeInputValues.join(',')}`))

const webOutput: any = Readable.toWeb(Readable.from(['to-web']))
const webOutputReader: any = webOutput.getReader()
const webOutputRead: Promise<any> = webOutputReader.read()
webOutputRead.then((result: any) => console.log(`readable-to:${result.done},${result.value}`))

const webWrites: string[] = []
const webSink = new WritableStream({
  write(chunk: any): void { webWrites.push(String(chunk)) },
  close(): void { webWrites.push('closed') }
})
const nodeSink = Writable.fromWeb(webSink, { objectMode: true })
nodeSink.write('from-node')
nodeSink.end(() => console.log(`writable-from:${webWrites.join(',')}`))

const collector = new Collector()
const webWriter: any = Writable.toWeb(collector).getWriter()
const webWrite: Promise<any> = webWriter.write('from-web')
webWrite.then(() => {
  const webClose: Promise<any> = webWriter.close()
  webClose.then(() => console.log(`writable-to:${collector.values.join(',')},${collector.writableFinished}`))
})

const duplexReadable = new ReadableStream({
  start(controller: any): void {
    const dynamicController: any = controller
    dynamicController.enqueue('duplex-in')
    dynamicController.close()
  }
})
const duplexWrites: string[] = []
const duplexWritable = new WritableStream({
  write(chunk: any): void { duplexWrites.push(String(chunk)) },
  close(): void { duplexWrites.push('closed') }
})
const duplex = Duplex.fromWeb({ readable: duplexReadable, writable: duplexWritable }, { objectMode: true })
const duplexReads: string[] = []
duplex.on('data', (chunk?: any) => duplexReads.push(String(chunk)))
duplex.once('end', () => console.log(`duplex-read:${duplexReads.join(',')}`))
duplex.write('duplex-out')
duplex.end(() => console.log(`duplex-write:${duplexWrites.join(',')}`))

const disposable = new Readable()
const disposed: Promise<void> = disposable[Symbol.asyncDispose]()
disposed.then(() => console.log(`dispose:${disposable.destroyed},${disposable.closed}`))
