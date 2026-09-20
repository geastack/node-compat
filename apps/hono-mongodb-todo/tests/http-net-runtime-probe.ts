import { Buffer } from 'buffer'
import { createServer } from 'http'
import { Hono } from 'hono/tiny'
import type { Context } from 'hono'
import { createConnection, Socket } from 'net'
import { Transform, TransformCallback } from 'stream'

class EchoCollector extends Transform {
  private socket_: Socket
  private resolve_: (value: string) => void

  constructor(socket: Socket, resolve: (value: string) => void) {
    super()
    this.socket_ = socket
    this.resolve_ = resolve
  }

  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    const value = chunk.toString('utf8')
    this.resolve_(value)
    this.socket_.destroy()
    callback()
  }
}

function roundTripFromHandler(): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 37123 })
    socket.pipe(new EchoCollector(socket, resolve))
    socket.setTimeout(3000)
    socket.once('connect', () => {
      socket.write(Buffer.from('handler-net-ok'))
    })
    socket.once('timeout', () => {
      throw new Error('HTTP handler node:net probe timed out')
    })
  })
}

const app = new Hono()
app.get('/probe', async (context: Context) => {
  const value = await roundTripFromHandler()
  server.close()
  return context.text(value)
})

const server = createServer(async (request, response) => {
  const fetchRequest = new Request(`http://localhost${request.url}`)
  const fetchResponse = await app.fetch(fetchRequest)
  response.writeHead(fetchResponse.status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(await fetchResponse.text())
})

server.listen(37124, () => console.log('http-net-runtime-ready'))
