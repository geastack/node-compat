import {
  ByteLengthQueuingStrategy,
  CompressionStream,
  CountQueuingStrategy,
  ReadableStream,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  WritableStream
} from 'node:stream/web'

const count = new CountQueuingStrategy({ highWaterMark: 4 })
const bytes = new ByteLengthQueuingStrategy({ highWaterMark: 8 })
console.log(`strategy:${count.highWaterMark},${count.size('x')},${bytes.size({ byteLength: 5 } as any)}`)

const readable = new ReadableStream({
  start(controller: any): void {
    const dynamicController: any = controller
    dynamicController.enqueue('first')
    dynamicController.close()
  }
})
const reader: any = readable.getReader()
const firstRead: Promise<any> = reader.read()
firstRead.then((result: any) => {
  console.log(`read:${result.done},${result.value},${readable.locked}`)
  const endRead: Promise<any> = reader.read()
  endRead.then((end: any) => {
    console.log(`read-end:${end.done}`)
    reader.releaseLock()
    console.log(`read-unlocked:${readable.locked}`)
  })
})

const written: string[] = []
const writable = new WritableStream({
  write(chunk: any): void { written.push(String(chunk)) },
  close(): void { written.push('closed') }
})
const writer: any = writable.getWriter()
const writePromise: Promise<any> = writer.write('value')
writePromise.then(() => {
  const closePromise: Promise<any> = writer.close()
  closePromise.then(() => {
    writer.releaseLock()
    console.log(`write:${written.join(',')},${writable.locked}`)
  })
})

const transform = new TransformStream({
  transform(chunk: any, controller: any): void {
    const dynamicController: any = controller
    dynamicController.enqueue(String(chunk).toUpperCase())
  }
})
const transformWriter: any = transform.writable.getWriter()
const transformReader: any = transform.readable.getReader()
transformWriter.write('mixed')
const transformed: Promise<any> = transformReader.read()
transformed.then((result: any) => console.log(`transform:${result.value}`))

const encoder = new TextEncoderStream()
const encoderWriter: any = encoder.writable.getWriter()
const encoderReader: any = encoder.readable.getReader()
encoderWriter.write('hello')
const encoded: Promise<any> = encoderReader.read()
encoded.then((result: any) => console.log(`encode:${encoder.encoding},${result.value.length}`))

const decoder = new TextDecoderStream()
const decoderWriter: any = decoder.writable.getWriter()
const decoderReader: any = decoder.readable.getReader()
decoderWriter.write([111, 107])
const decoded: Promise<any> = decoderReader.read()
decoded.then((result: any) => console.log(`decode:${decoder.encoding},${result.value}`))

const compression = new CompressionStream('gzip')
const compressionWriter: any = compression.writable.getWriter()
const compressionReader: any = compression.readable.getReader()
compressionWriter.write('bytes')
const compressed: Promise<any> = compressionReader.read()
compressed.then((result: any) => console.log(`compression:${result.value}`))
