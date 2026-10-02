import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { resolve } from 'node:path'

// Concurrent requests whose async handlers wait on each other through a shared
// one-slot resource (`apps/http-overlapping-awaits/server.ts`). A native build
// completes every `await` by pumping the reactor with the handler still on the
// stack; before `HandlerDispatchGate` (`runtime/gea_node.cpp`) the next request
// was dispatched from inside that pump, on top of the waiting handler, and the
// server spun forever without answering even the first request.
const root = resolve(import.meta.dirname, '..')
const app = resolve(root, 'apps/http-overlapping-awaits')
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), 'server.ts', '--out', 'dist', '--exe', 'dist/server'], {
  cwd: app,
  env: { ...process.env, TMPDIR: resolve(app, 'dist') },
  stdio: ['ignore', 'ignore', 'inherit']
})

const port = 3314
const server = spawn(resolve(app, 'dist/server'), [], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
const stopped = once(server, 'exit')
try {
  await new Promise((accept) => setTimeout(accept, 500))
  // No keep-alive: each request is its own connection, so the requests really
  // do arrive while the first handler is still awaiting.
  const get = (path) =>
    new Promise((accept, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path, agent: false, timeout: 5000 }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => accept({ status: res.statusCode, body }))
      })
      req.on('timeout', () => req.destroy(new Error(`${path}: no response in 5s (handlers nested and livelocked)`)))
      req.on('error', reject)
    })
  const paths = Array.from({ length: 8 }, (_, i) => `/r${i}`)
  const responses = await Promise.all(paths.map(get))
  for (const [i, response] of responses.entries()) {
    assert.equal(response.status, 200)
    assert.match(response.body, new RegExp(`^ok ${paths[i]} [1-8]$`))
  }
  assert.deepEqual(responses.map((r) => Number(r.body.split(' ')[2])).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
} finally {
  server.kill()
  await stopped
}
console.log('PASS: 8 concurrent handlers awaiting a shared one-slot resource all answer')
