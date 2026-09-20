import { Buffer } from 'buffer'
import { createServer } from 'http'
import type { Server } from 'http'
import { createConnection, Socket } from 'net'
import { Transform } from 'stream'
import type { TransformCallback } from 'stream'
import { setTimeout } from 'timers'

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

async function verifyTopLevelPump(): Promise<void> {
  const delayed = promiseWithResolvers<number>()
  setTimeout(() => delayed.resolve(42), 1)
  const value = await delayed.promise
  expect(value === 42, 'top-level host pump lost the typed Promise value')
  console.log(`promise-host-pump-top=${value}`)
}

class ResponseCollector extends Transform {
  private socket_: Socket
  private server_: Server
  private response_ = ''

  constructor(socket: Socket, server: Server) {
    super()
    this.socket_ = socket
    this.server_ = server
  }

  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    this.response_ += chunk.toString('utf8')
    // The compatibility server uses chunked transfer encoding when no content
    // length is supplied, so the wire body is preceded by its hexadecimal
    // chunk size rather than immediately following the header terminator.
    if (this.response_.includes('nested-pump-ok')) {
      console.log('promise-host-pump-nested=nested-pump-ok')
      this.socket_.destroy()
      this.server_.close()
    }
    callback()
  }
}

void verifyTopLevelPump()

const server = createServer(async (_request, response) => {
  const delayed = promiseWithResolvers<string>()
  setTimeout(() => delayed.resolve('nested-pump-ok'), 1)
  const value = await delayed.promise
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(value)
})

server.listen(37125, () => {
  // The compatibility Server invokes its listen callback immediately before
  // entering the native blocking reactor. Defer the self-client by one tick so
  // the native listener has been bound before connect() runs.
  setTimeout(() => {
    const socket = createConnection({ host: '127.0.0.1', port: 37125 })
    socket.pipe(new ResponseCollector(socket, server))
    socket.setTimeout(3000)
    socket.once('connect', () => {
      socket.write(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
    })
    socket.once('timeout', () => {
      throw new Error('nested host-pump probe timed out')
    })
  }, 1)
})
