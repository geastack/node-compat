import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Run after a bare build.mjs apps/hono-hello/server.ts. The driver supplies
// Hono's pinned typed sources, WHATWG globals, and the Node server target.
// No existing process is reused or stopped: the app currently fixes port 3900
// (not 3000 -- this Mac's port 3000 is reserved for the user's own dev server).
const root = resolve(import.meta.dirname, '..')
const probe = net.createServer()
await new Promise((accept, reject) => {
  probe.once('error', reject)
  probe.listen(3900, '127.0.0.1', accept)
})
await new Promise((accept) => probe.close(accept))

const server = spawn(resolve(root, 'apps/hono-hello/dist/server'), [], {
  stdio: ['ignore', 'pipe', 'pipe']
})
const stopped = once(server, 'exit')
let output = ''
server.stdout.on('data', (chunk) => {
  output += chunk
})
server.stderr.on('data', (chunk) => {
  output += chunk
})
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
const request = (path, options = {}) =>
  new Promise((accept, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3900,
        path,
        agent,
        method: options.method ?? 'GET',
        headers: options.headers ?? {}
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () =>
          accept({
            status: res.statusCode,
            type: res.headers['content-type'],
            body
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP response timed out')))
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
const rssKiB = () =>
  Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], {
      encoding: 'utf8'
    }).trim()
  )

try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited: ${output}`)
    try {
      await request('/')
      ready = true
      break
    } catch {
      await delay(50)
    }
  }
  assert.ok(ready, `Server did not start: ${output}`)
  const routes = [
    ['/', 200, 'text/plain; charset=UTF-8', 'Hello Hono!'],
    ['/json', 200, 'application/json', '{"hello":"world"}'],
    ['/missing', 404, 'text/plain; charset=UTF-8', '404 Not Found'],
    ['/?q=one&q=two', 200, 'text/plain; charset=UTF-8', 'Hello Hono!']
  ]
  for (const [path, status, type, body] of routes) {
    assert.deepEqual(await request(path), { status, type, body }, path)
    console.log(`PASS GET ${path}: ${status}, exact body and content-type`)
  }
  assert.deepEqual(
    await request('/body/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"native-json","count":3}'
    }),
    {
      status: 200,
      type: 'text/plain; charset=UTF-8',
      body: 'native-json'
    }
  )
  console.log('PASS POST /body/json: Request#json through full Hono')

  const boundary = 'gea-hono-body-probe'
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nhello\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="asset"; filename="probe.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ),
    Buffer.from([0, 127, 255]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  assert.deepEqual(
    await request('/body/form', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(multipart.length)
      },
      body: multipart
    }),
    {
      status: 200,
      type: 'text/plain; charset=UTF-8',
      body: 'hello:probe.bin:application/octet-stream:3'
    }
  )
  console.log('PASS POST /body/form: multipart text and binary File through full Hono')
  if (process.argv.includes('--memory')) {
    const countOption = process.argv.find((value) => value.startsWith('--requests='))
    const count = countOption ? Number(countOption.slice('--requests='.length)) : 6000
    assert.ok(Number.isSafeInteger(count) && count > 0 && count % 2 === 0, '--requests must be a positive even integer')
    const pathOption = process.argv.find((value) => value.startsWith('--memory-path='))
    const path = pathOption ? pathOption.slice('--memory-path='.length) : '/'
    const expected = routes.find((route) => route[0] === path)
    assert.ok(expected, '--memory-path must name one of the checked routes')
    const exercise = async () => {
      const result = await request(path)
      assert.deepEqual(result, {
        status: expected[1],
        type: expected[2],
        body: expected[3]
      })
    }
    for (let index = 0; index < 1000; index++) await exercise()
    const samples = [rssKiB()]
    for (let batch = 0; batch < 2; batch++) {
      for (let index = 0; index < count / 2; index++) await exercise()
      samples.push(rssKiB())
    }
    const growth = samples[2] - samples[0]
    console.log(`RSS KiB (${path}) after 1000/${1000 + count / 2}/${1000 + count} requests: ${samples.join(' / ')}`)
    console.log(`RSS growth over last ${count} requests: ${((growth * 1024) / count).toFixed(1)} bytes/request`)
    if (process.argv.includes('--assert-flat')) {
      assert.ok(growth <= 256, `RSS grew by ${growth} KiB after warmup (limit 256 KiB)`)
      console.log('PASS: RSS remains within 256 KiB of the warmed process')
    } else console.log('RSS is diagnostic only; route success does not imply leak-free ownership.')
  }
} finally {
  agent.destroy()
  server.kill('SIGTERM')
  await stopped
}
