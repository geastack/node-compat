import { createServer } from 'node:http'
import { env } from 'node:process'

const server = createServer((req, res) => {
  const missing = req.headers['x-missing']
  const present = req.headers['x-present']
  const empty = req.headers['x-empty']
  const lines = [
    `missing ${missing === undefined} ${typeof missing} ${missing ?? 'fallback'}`,
    `present ${present === undefined} ${typeof present} ${present ?? 'fallback'}`,
    `empty ${empty === undefined} ${typeof empty} ${empty ?? 'fallback'}`
  ]
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(lines.join('\n') + '\n')
})

const PORT = Number(env.PORT ?? '3318')
server.listen(PORT, () => {
  console.log(`missing-request-header listening on http://127.0.0.1:${PORT}`)
})
