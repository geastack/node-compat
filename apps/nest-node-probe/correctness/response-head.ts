import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { env } from 'node:process'

function answer(res: ServerResponse, attempt: () => void): void {
  let outcome = 'accepted'
  try {
    attempt()
  } catch (error) {
    const code = (error as Error & { code: string }).code
    outcome = `${code} ${code === 'ERR_INVALID_ARG_VALUE' ? 'headers' : (error as Error).message} ${res.headersSent} ${res.writableEnded}`
  }
  res.statusMessage = ''
  if (!res.headersSent) res.writeHead(200, { 'Content-Length': String(outcome.length) })
  res.end(outcome)
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/'
  if (url === '/pairs') {
    res.writeHead(200, ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '2'])
    res.end('ok')
  } else if (url === '/staged') {
    res.setHeader('X-A', '0')
    res.setHeader('X-Keep', 'k')
    res.writeHead(200, ['X-A', '1', 'X-A', '2', 'Content-Length', '2'])
    res.end('ok')
  } else if (url === '/reason') {
    let outcome = 'accepted'
    try {
      res.writeHead(200, 'OK\r\nX-Injected: yes')
    } catch (error) {
      outcome = `${(error as Error & { code: string }).code} ${(error as Error).message} ${res.headersSent}`
      res.statusMessage = ''
    }
    res.writeHead(200, { 'Content-Length': String(outcome.length) })
    res.end(outcome)
  } else if (url === '/reason-ok') {
    res.writeHead(200, 'Fine Thanks', { 'Content-Length': '2' })
    res.end('ok')
  } else if (url === '/pair-inject') {
    answer(res, () => res.writeHead(200, ['X-Note', 'ok\r\nSet-Cookie: injected=1']))
  } else if (url === '/staged-inject') {
    res.setHeader('X-Keep', 'k')
    answer(res, () => res.writeHead(200, ['X-Note', 'ok\r\nSet-Cookie: injected=1']))
  } else if (url === '/object-inject') {
    answer(res, () => res.writeHead(200, { 'X-Note': 'ok\r\nSet-Cookie: injected=1' }))
  } else if (url === '/set-inject') {
    answer(res, () => res.setHeader('X-Note', 'ok\r\nSet-Cookie: injected=1'))
  } else if (url === '/append-inject') {
    answer(res, () => res.appendHeader('X-Note', ['ok', 'no\r\nSet-Cookie: injected=1']))
  } else if (url === '/bad-name') {
    answer(res, () => res.writeHead(200, ['Bad Name', 'v']))
  } else if (url === '/nested-pairs') {
    res.writeHead(200, [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['Content-Length', '2']])
    res.end('ok')
  } else if (url === '/odd-pairs') {
    answer(res, () => res.writeHead(200, ['X-A', '1', 'Content-Length']))
  } else if (url === '/odd-staged') {
    res.setHeader('X-Keep', 'k')
    answer(res, () => res.writeHead(200, ['X-Keep', '1', 'Content-Length']))
  } else if (url === '/end-recover') {
    res.statusMessage = 'Bad\r\nX-Injected: yes'
    answer(res, () => res.end('ok'))
  } else {
    res.writeHead(404, { 'Content-Length': '0' })
    res.end()
  }
})

const PORT = Number(env.PORT ?? '3324')
server.listen(PORT, () => {
  console.log(`response-head listening on http://127.0.0.1:${PORT}`)
})
