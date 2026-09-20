import { createServer, Server, Socket } from 'node:net'

const mode = process.argv[2] ?? 'options'
let received = ''

function log(message: string): void {
  console.error(message)
}

function onConnection(socket: Socket): void {
  log(
    `connection:${socket.connecting},${socket.pending},${socket.destroyed},${JSON.stringify(socket.address())}`
  )
  socket.setEncoding('utf8')
  if (mode === 'paused') socket.resume()
  socket.on('error', (_error?: any, _b?: any, _c?: any) => {})
  socket.on('data', (chunk?: any, _b?: any, _c?: any) => {
    received += chunk
    if (received !== 'gea-server-probe') return
    server.getConnections((error, count) => {
      log(`connections:${error === null},${count},${server.connections}`)
    })
    log(`data:${received}`)
    socket.end('gea-server-response')
    server.close((error?: Error) => log(`close-callback:${error === undefined}`))
  })
}

const server: Server =
  mode === 'options'
    ? createServer(
        {
          noDelay: true,
          keepAlive: true,
          keepAliveInitialDelay: 1000
        },
        onConnection
      )
    : createServer({ pauseOnConnect: mode === 'paused' }, onConnection)

server.maxConnections = 2
server.on('error', (error?: any, _b?: any, _c?: any) => {
  log(`server-error:${error}`)
})
server.on('close', (_a?: any, _b?: any, _c?: any) => log('server-close'))

const onListening = () => {
  const sameReference = server.unref() === server && server.ref() === server
  log(`listening:${JSON.stringify(server.address())},${server.listening},${sameReference}`)
}

if (mode === 'positional') {
  server.listen(0, '127.0.0.1', 16, onListening)
} else {
  server.listen(
    {
      port: 0,
      host: '127.0.0.1',
      backlog: 16,
      reusePort: true
    },
    onListening
  )
}
