import { Buffer } from 'buffer'
import { createConnection, Socket } from 'net'
import { Transform, TransformCallback } from 'stream'

class EchoCollector extends Transform {
  private socket_: Socket

  constructor(socket: Socket) {
    super()
    this.socket_ = socket
  }

  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    if (chunk.toString('utf8') !== 'gea-net-ok') {
      throw new Error('node:net probe received the wrong bytes')
    }
    console.log('node-net-runtime-ok')
    this.socket_.destroy()
    callback()
  }
}

const socket = createConnection({ host: '127.0.0.1', port: 37123 })
socket.pipe(new EchoCollector(socket))
socket.setNoDelay(true)
socket.setKeepAlive(true, 1000)
socket.setTimeout(3000)
socket.once('connect', () => {
  socket.write(Buffer.from('gea-net-ok'))
})
socket.once('timeout', () => {
  throw new Error('node:net probe timed out')
})
