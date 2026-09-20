// Variant of server.ts with only the string form of `app.request()`, to
// isolate which input arm (string / URL / Request) raises the wall.
import { Hono } from 'hono/tiny'

const app = new Hono()
app.get('/', (c) => c.text('Hello Hono!'))

const main = async () => {
  const a = await app.request('/')
  console.log(a.status + ' ' + (await a.text()))
}
main()
