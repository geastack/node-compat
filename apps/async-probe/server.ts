// Isolates the async-handler question from Request/Response: same shape as
// raw-http-hello/server.ts but with an async callback, no fetch globals at
// all -- to tell whether an emission gap traces to createServer's async
// dispatch specifically or only shows up alongside Request/Response.
import { createServer } from 'node:http'

const server = createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Hello, World! ' + req.method + ' ' + req.url)
})

server.listen(3103, () => {
  console.log('async-probe listening on http://127.0.0.1:3103')
})
