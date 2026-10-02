// node:net connect: happy eyeballs (`autoSelectFamily`), `family`, the
// `lookup` option, and the ECONNREFUSED error shapes, printed so the compiled
// program's stdout can be compared byte for byte with `node` running this
// same file (`scripts/test-net-auto-select-family.mjs`).
//
// The server binds 127.0.0.1 ONLY. `localhost` resolves to ::1 and 127.0.0.1
// on macOS, so a happy-eyeballs connect to `localhost` must fail fast on ::1
// and win on 127.0.0.1. Ports are printed as PORT: they are ephemeral.

import { connect, createServer, Server, Socket } from 'node:net'
import type { AddressInfo, LookupFunction } from 'node:net'
import type { LookupAddress, LookupOptions } from 'node:dns'

interface SystemError extends Error {
  code?: string
  errno?: number
  syscall?: string
  address?: string
  port?: number
}

interface AggregateSystemError extends Error {
  code?: string
  errors?: SystemError[]
}

let listenPort = 0
let closedPort = 0
let echoPort = 0

function hidePort(text: string): string {
  let out = text
  if (listenPort !== 0) out = out.split(`${listenPort}`).join('PORT')
  if (closedPort !== 0) out = out.split(`${closedPort}`).join('PORT')
  if (echoPort !== 0) out = out.split(`${echoPort}`).join('PORT')
  return out
}

function describeError(error: SystemError): string {
  return hidePort(
    `${error.name}|${error.message}|${error.code}|${error.errno}|${error.syscall}|${error.address}|${error.port === undefined ? 'undefined' : 'PORT'}`
  )
}

function watchAttempts(label: string, socket: Socket): void {
  socket.on('lookup', (error: Error | null, address: string, family: number, host: string) => {
    console.log(`${label}:lookup:${error === null}:${address}:${family}:${host}`)
  })
  socket.on('connectionAttempt', (address: string, _port: number, family: number) => {
    console.log(`${label}:attempt:${address}:${family}`)
  })
  socket.on('connectionAttemptFailed', (address: string, _port: number, family: number, error: SystemError) => {
    console.log(`${label}:attempt-failed:${address}:${family}:${error.code}`)
  })
}

function expectConnect(label: string, socket: Socket, next: () => void): void {
  socket.on('connect', () => {
    console.log(`${label}:connect:${socket.remoteAddress}:${socket.remoteFamily}`)
    console.log(`${label}:attempted:${hidePort((socket.autoSelectFamilyAttemptedAddresses ?? []).join(','))}`)
  })
  socket.on('data', (chunk: Buffer) => {
    console.log(`${label}:data:${chunk.toString('utf8')}`)
  })
  socket.on('error', (error: Error) => {
    console.log(`${label}:unexpected-error:${describeError(error as SystemError)}`)
  })
  socket.on('close', () => {
    console.log(`${label}:close`)
    next()
  })
}

function expectError(label: string, socket: Socket, next: () => void): void {
  socket.on('connect', () => {
    console.log(`${label}:unexpected-connect`)
    socket.destroy()
  })
  socket.on('error', (error: Error) => {
    console.log(`${label}:error:${describeError(error as SystemError)}`)
    const errors = (error as AggregateSystemError).errors
    if (errors !== undefined) {
      for (let index = 0; index < errors.length; index += 1) {
        console.log(`${label}:error[${index}]:${describeError(errors[index])}`)
      }
    }
  })
  socket.on('close', () => {
    console.log(`${label}:close`)
    next()
  })
}

function describeLookupOptions(options: LookupOptions): string {
  return `all=${options.all === true},family=${options.family},hints=${options.hints === undefined ? 'undefined' : options.hints === 0 ? '0' : 'set'}`
}

const steps: ((next: () => void) => void)[] = [
  // Happy eyeballs, Node's default: ::1 is refused, 127.0.0.1 wins.
  (next) => {
    const socket = connect({ host: 'localhost', port: listenPort })
    watchAttempts('auto', socket)
    expectConnect('auto', socket, next)
  },
  // Explicit option plus a custom attempt timeout (clamped to >= 10).
  (next) => {
    const socket = connect({ host: 'localhost', port: listenPort, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1 })
    watchAttempts('auto-timeout', socket)
    expectConnect('auto-timeout', socket, next)
  },
  // Pinned family: only the A record is resolved.
  (next) => {
    const socket = connect({ host: 'localhost', port: listenPort, family: 4 })
    watchAttempts('family4', socket)
    expectConnect('family4', socket, next)
  },
  // A custom lookup is handed `all: true` under happy eyeballs and its list
  // is interleaved and raced.
  (next) => {
    const lookup: LookupFunction = (hostname, options, callback) => {
      console.log(`lookup-all:called:${hostname}:${describeLookupOptions(options)}`)
      const addresses: LookupAddress[] = [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ]
      callback(null, addresses)
    }
    const socket = connect({ host: 'example.invalid', port: listenPort, lookup })
    watchAttempts('lookup-all', socket)
    expectConnect('lookup-all', socket, next)
  },
  // The attempt delay: 192.0.2.1 (TEST-NET-1) never answers, so after 20 ms
  // the next interleaved address (::1, refused) starts, then 127.0.0.1 wins.
  // The unanswered attempt is a loser that must be closed, or it would hold
  // the process open. Only the outcome is printed: whether 192.0.2.1 times
  // out or is rejected outright depends on the host's routes.
  (next) => {
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      const addresses: LookupAddress[] = [
        { address: '192.0.2.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 }
      ]
      callback(null, addresses)
    }
    const socket = connect({ host: 'race.invalid', port: listenPort, lookup, autoSelectFamilyAttemptTimeout: 20 })
    expectConnect('race', socket, next)
  },
  // Writes issued while the lookup and the race are still running are held
  // and go out on the winning connection, in order. (end() is issued once
  // connected: node 24.8 drops an end() made before a multi-address connect
  // completes -- the socket never half-closes -- while its single-address
  // paths honor it. This runtime honors it on every path.)
  (next) => {
    const socket = connect({ host: 'localhost', port: echoPort })
    socket.write('early-')
    socket.write('bytes')
    let echoed = ''
    socket.on('connect', () => {
      console.log(`early-write:connect:${socket.remoteAddress}:${socket.remoteFamily}`)
    })
    socket.on('data', (chunk: Buffer) => {
      echoed += chunk.toString('utf8')
      if (echoed.length === 'early-bytes'.length) {
        console.log(`early-write:echo:${echoed}`)
        socket.end()
      }
    })
    socket.on('error', (error: Error) => {
      console.log(`early-write:unexpected-error:${describeError(error as SystemError)}`)
    })
    socket.on('close', () => {
      console.log('early-write:close')
      next()
    })
  },
  // Without happy eyeballs a custom lookup gets a single-address request.
  (next) => {
    const lookup: LookupFunction = (hostname, options, callback) => {
      console.log(`lookup-one:called:${hostname}:${describeLookupOptions(options)}`)
      callback(null, '127.0.0.1', 4)
    }
    const socket = connect({ host: 'example.invalid', port: listenPort, lookup, autoSelectFamily: false })
    watchAttempts('lookup-one', socket)
    expectConnect('lookup-one', socket, next)
  },
  // autoSelectFamily: false tries the first address only -- ::1, refused.
  (next) => {
    const socket = connect({ host: 'localhost', port: listenPort, autoSelectFamily: false })
    watchAttempts('no-auto', socket)
    expectError('no-auto', socket, next)
  },
  // Nothing listens: every attempt is refused -> AggregateError.
  (next) => {
    const socket = connect({ host: 'localhost', port: closedPort })
    watchAttempts('refused-all', socket)
    expectError('refused-all', socket, next)
  },
  // Nothing listens on an IP literal: one plain ECONNREFUSED.
  (next) => {
    const socket = connect(closedPort, '127.0.0.1')
    watchAttempts('refused-ip', socket)
    expectError('refused-ip', socket, next)
  }
]

let stepIndex = 0
function runNext(server: Server, echo: Server): void {
  if (stepIndex === steps.length) {
    echo.close()
    server.close(() => console.log('done'))
    return
  }
  const step = steps[stepIndex]
  stepIndex += 1
  step(() => runNext(server, echo))
}

// Take an ephemeral port and release it, so nothing listens there.
const probe = createServer()
probe.listen(0, '127.0.0.1', () => {
  closedPort = (probe.address() as AddressInfo).port
  probe.close(() => {
    const server = createServer((socket: Socket) => {
      socket.end('hi')
    })
    server.listen(0, '127.0.0.1', () => {
      listenPort = (server.address() as AddressInfo).port
      const echo = createServer((socket: Socket) => {
        socket.on('data', (chunk: Buffer) => {
          socket.write(chunk)
        })
      })
      echo.listen(0, '127.0.0.1', () => {
        echoPort = (echo.address() as AddressInfo).port
        runNext(server, echo)
      })
    })
  })
})
