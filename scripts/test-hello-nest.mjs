import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const app = resolve(root, 'apps/hello-nest')
const entry = resolve(app, 'server.ts')
const oracle = resolve(app, 'dist/server.js')
const output = resolve(app, 'dist-gea')
const executable = resolve(output, process.platform === 'win32' ? 'server.exe' : 'server')
const port = 3900
const recordDir = process.argv.includes('--record') ? process.argv[process.argv.indexOf('--record') + 1] : null

if (!process.argv.includes('--no-build')) {
  execFileSync('npm', ['run', 'build'], { cwd: app, stdio: 'inherit' })
  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), entry, '--out', output, '--exe', executable], { cwd: root, stdio: 'inherit' })
}

const requests = [
  { name: 'get-root', method: 'GET', path: '/' },
  { name: 'get-json', method: 'GET', path: '/json' },
  { name: 'get-json-slash', method: 'GET', path: '/json/' },
  { name: 'get-json-upper', method: 'GET', path: '/JSON' },
  { name: 'get-missing', method: 'GET', path: '/missing?x=1' },
  { name: 'head-json', method: 'HEAD', path: '/json' },
  { name: 'post-root', method: 'POST', path: '/' },
  { name: 'post-json-body', method: 'POST', path: '/json', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
  { name: 'post-bad-json', method: 'POST', path: '/json', headers: { 'content-type': 'application/json' }, body: '{bad' },
  { name: 'post-form', method: 'POST', path: '/missing', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b[c]=2' },
  { name: 'get-bad-escape', method: 'GET', path: '/%FF' }
]

const assertFreePort = async () => {
  const probe = net.createServer()
  await new Promise((accept, reject) => {
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', accept)
  })
  await new Promise((accept) => probe.close(accept))
}

const request = ({ method, path, headers, body }) =>
  new Promise((accept, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: headers ?? {} }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const rawHeaders = []
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (res.rawHeaders[i].toLowerCase() !== 'date') rawHeaders.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
        accept({ status: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`, headers: rawHeaders, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP response timed out')))
    if (body !== undefined) req.write(body)
    req.end()
  })

const run = async (label, command, args) => {
  await assertFreePort()
  const server = spawn(command, args, { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = once(server, 'exit')
  let log = ''
  server.stdout.on('data', (chunk) => (log += chunk))
  server.stderr.on('data', (chunk) => (log += chunk))
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`${label} exited: ${log}`)
      try {
        await request({ method: 'GET', path: '/' })
        ready = true
        break
      } catch {
        await delay(50)
      }
    }
    assert.ok(ready, `${label} did not start: ${log}`)
    const responses = {}
    for (const r of requests) responses[r.name] = await request(r)
    return { responses, log }
  } finally {
    server.kill('SIGTERM')
    await Promise.race([stopped, delay(3000).then(() => server.kill('SIGKILL'))])
  }
}

const render = (r) => `${r.status}\n${r.headers.join('\n')}\n\n${r.body}`
const expected = await run('node oracle', process.execPath, [oracle])
const actual = await run('compiled', executable, [])
if (recordDir) {
  for (const [side, result] of [['node', expected], ['compiled', actual]]) {
    fs.mkdirSync(resolve(recordDir, side), { recursive: true })
    for (const [name, response] of Object.entries(result.responses)) fs.writeFileSync(resolve(recordDir, side, `${name}.txt`), render(response))
  }
}
let failed = 0
for (const r of requests) {
  const e = render(expected.responses[r.name])
  const a = render(actual.responses[r.name])
  if (e === a) console.log(`PASS ${r.method} ${r.path} (${r.name}): ${expected.responses[r.name].status}, identical headers (minus Date) and body`)
  else {
    failed++
    console.log(`FAIL ${r.method} ${r.path} (${r.name})\n--- node\n${e}\n--- compiled\n${a}`)
  }
}
console.log(`HELLO_NEST_PARITY: ${requests.length - failed} of ${requests.length} identical`)
if (failed > 0) process.exit(1)
