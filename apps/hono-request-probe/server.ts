// Probe: does `app.request()` -- Hono's own test-entry method, which does
// `input = input.toString()` on a `Request | string | URL` union inside
// hono-base.ts -- lower natively? Node prints the same three lines.
import { Hono } from 'hono/tiny'

const app = new Hono()
app.get('/', (c) => c.text('Hello Hono!'))
app.get('/json', (c) => c.json({ hello: 'world' }))

const main = async () => {
  const a = await app.request('/')
  console.log(a.status + ' ' + (await a.text()))
  const b = await app.request(new URL('http://localhost/json'))
  console.log(b.status + ' ' + (await b.text()))
  const c = await app.request(new Request('http://localhost/missing'))
  console.log(c.status + ' ' + (await c.text()))
}
main()
