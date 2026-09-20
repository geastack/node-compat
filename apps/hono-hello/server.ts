import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hello Hono!'))
app.get('/json', (c) => c.json({ hello: 'world' }))
app.post('/body/json', async (c) => {
  const value = await c.req.json()
  if (typeof value !== 'object' || value === null) return c.text('invalid', 400)
  const body = value as Record<string, unknown>
  return c.text(typeof body.name === 'string' ? body.name : 'invalid')
})
app.post('/body/form', async (c) => {
  const form = await c.req.formData()
  const field = form.get('field')
  const asset = form.get('asset')
  if (typeof field !== 'string' || !(asset instanceof File)) return c.text('invalid', 400)
  return c.text(field + ':' + asset.name + ':' + asset.type + ':' + String(asset.size))
})

// Port 3900, not 3000: this Mac's port 3000 is reserved for the user's own
// dev server. The reactor binds every interface regardless of what is asked
// (see runtime/node/http.ts), so only the port number is a real lever here.
serve({ fetch: (request, _env) => app.fetch(request), port: 3900 }, () => {
  console.log('hono-native listening on http://127.0.0.1:3900')
})
