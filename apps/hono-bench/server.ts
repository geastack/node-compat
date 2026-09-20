import { Hono } from 'hono/tiny'

const app = new Hono()
app.get('/', (c: any) => c.text('Hello Hono!'))
app.get('/json', (c: any) => c.json({ hello: 'world' }))

// Load-independent dispatch-count harness: loop app.fetch without any network,
// then exit so the runtime's GEA_PROFILE atexit dumper prints operation counts.
// N is a compile-time constant so no `process`/argv is needed; one-time app and
// router setup is negligible against a large N, so counts / N ≈ per-request cost.
const ITERS = 200000
let acc = 0
for (let i = 0; i < ITERS; i++) {
  const request = new Request('http://localhost/', { method: 'GET' })
  const response = app.fetch(request) as Response
  const body = response.text() as unknown as string
  acc = acc + body.length
}
console.log('done iters=' + ITERS + ' acc=' + acc)
