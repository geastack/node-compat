// The same routes as hono-hello, served through a hand-written node:http
// bridge instead of @hono/node-server. This is the shape the July and
// September 4 benchmarks measured (28-50k rps on the bench box); keeping it
// beside hono-hello isolates what the real adapter costs on the same
// compiler, runtime and Hono.
import { Hono } from 'hono'
import { createServer } from 'node:http'

const app = new Hono()
app.get('/', (c) => c.text('Hello Hono!'))
app.get('/json', (c) => c.json({ hello: 'world' }))
app.post('/body/json', async (c) => {
  const value = await c.req.json()
  if (typeof value !== 'object' || value === null) return c.text('invalid', 400)
  const body = value as Record<string, unknown>
  return c.text(typeof body.name === 'string' ? body.name : 'invalid')
})

app.post('/body/text', async (c) => {
  const text = await c.req.text()
  return c.text(`len=${text.length} text=${text}`)
})

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'
  const init: RequestInit = { method, headers: req.headers }
  // `readBodyBytes` rather than `Buffer.from(...)`: a bare `Buffer` read in the
  // entry script is refused (the global is installed through the global object).
  if (method !== 'GET' && method !== 'HEAD') init.body = req.readBodyBytes()
  const request = new Request('http://localhost' + req.url, init)
  const response = await app.fetch(request)
  const body = await response.text()
  const ct = response.headers.get('content-type') || 'text/plain; charset=utf-8'
  res.writeHead(response.status, { 'content-type': ct })
  res.end(body)
})

server.listen(3901, () => {
  console.log('hono-bridge listening on http://127.0.0.1:3901')
})
