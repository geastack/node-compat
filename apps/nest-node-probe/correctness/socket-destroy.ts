import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { env } from 'node:process'

const report = (name: string, req: IncomingMessage, closes: () => number): void => {
  const socket = req.socket
  setTimeout(() => {
    console.log(`${name} closes=${closes()} destroyed=${socket.destroyed} readable=${socket.readable} writable=${socket.writable} state=${socket.readyState}`)
  }, 100)
}

let stashed: IncomingMessage | undefined

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/stash') {
    stashed = req
    res.destroy()
    return
  }
  if (req.url === '/destroy-after-end') {
    const socket = req.socket
    res.end('x'.repeat(32 * 1024 * 1024))
    setTimeout(() => {
      res.destroy()
      console.log(`${req.url} destroyed=${socket.destroyed} state=${socket.readyState}`)
    }, 50)
    return
  }
  if (req.url === '/fill') {
    res.end(String(req.socket.destroyed))
    return
  }
  if (req.url === '/stashed') {
    const socket = stashed === undefined ? req.socket : stashed.socket
    console.log(`stashed after later connections destroyed=${socket.destroyed} readable=${socket.readable} writable=${socket.writable} state=${socket.readyState}`)
    res.end('stashed')
    return
  }
  if (req.url === '/response-before-socket') {
    res.destroy()
    report(req.url, req, () => 0)
    return
  }
  const socket = req.socket
  let closes = 0
  socket.on('close', () => {
    closes++
  })
  if (req.url === '/socket') {
    socket.destroy()
    socket.destroy()
    console.log(`socket closes-before-turn=${closes}`)
  } else if (req.url === '/response') {
    res.destroy()
  } else if (req.url === '/request') {
    req.destroy()
  } else {
    res.end('kept')
    console.log(`${req.url} destroyed=${socket.destroyed} readable=${socket.readable} writable=${socket.writable} state=${socket.readyState}`)
    report(`${req.url} after the response completed`, req, () => closes)
    return
  }
  report(req.url ?? '', req, () => closes)
})

const PORT = Number(env.PORT ?? '3320')
server.listen(PORT, () => {
  console.log(`socket-destroy listening on http://127.0.0.1:${PORT}`)
})
