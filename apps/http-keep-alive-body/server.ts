import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { env } from 'node:process'

const port = Number(env.PORT ?? '3315')

createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk: string) => {
    body += chunk
  })
  req.on('end', () => {
    res.setHeader('content-type', 'text/plain')
    res.end(`${req.method} ${req.url} ${body} destroyed ${req.destroyed}`)
  })
}).listen(port)
