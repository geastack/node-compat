// node:http Server.listen on a port another socket holds: the server emits
// 'error' with node's EADDRINUSE system error and never 'listening', and a
// server on a free port still reports 'listening' before it closes. Printed so
// the compiled program's stdout can be compared byte for byte with `node`
// running this same file (`scripts/test-http-listen-error.mjs`).

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'

interface SystemError extends Error {
  code?: string
  errno?: number
  syscall?: string
  address?: string
  port?: number
}

const busyPort = 3931
const freePort = 3932

const answer = (_req: IncomingMessage, res: ServerResponse): void => {
  res.end()
}

const blocker = createNetServer()
blocker.listen(busyPort, () => {
  const busy = createHttpServer(answer)
  busy.on('listening', () => console.log('busy: listening'))
  busy.on('error', (raw: Error) => {
    const error = raw as SystemError
    console.log(`busy: error ${error.code} ${error.errno} ${error.syscall} ${error.address} ${error.port} listening=${busy.listening}`)
    console.log(`busy: ${error.message}`)
    blocker.close()
    const free = createHttpServer(answer)
    free.listen(freePort, () => {
      console.log(`free: listening=${free.listening}`)
      free.close()
    })
  })
  busy.listen(busyPort)
})
