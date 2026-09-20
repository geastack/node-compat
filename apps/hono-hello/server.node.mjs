import { Hono } from 'hono/tiny'
import { createServer } from 'node:http'
const app = new Hono()
app.get('/', (c) => c.text('Hello Hono!'))
app.get('/json', (c) => c.json({ hello: 'world' }))
const server = createServer(async (req, res) => {
  const request = new Request('http://localhost' + req.url, { method: req.method })
  const response = await app.fetch(request)
  const body = await response.text()
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain' })
  res.end(body)
})
server.listen(3000, () => console.log('hono-node listening on http://127.0.0.1:3000'))
