import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = resolve(root, 'apps/http-keep-alive-body')
const exe = process.platform === 'win32' ? 'dist/server.exe' : 'dist/server'
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), 'server.ts', '--out', 'dist', '--exe', exe], {
  cwd: app,
  env: { ...process.env, TMPDIR: resolve(app, 'dist') },
  stdio: ['ignore', 'ignore', 'inherit']
})

async function exchange(command, args, port) {
  const server = spawn(command, args, { cwd: app, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
  const stopped = once(server, 'exit')
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const post = (path, body) =>
    new Promise((accept, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', agent, timeout: 5000 }, (res) => {
        const socketPort = res.socket.localPort
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => accept({ body: text, socketPort }))
      })
      req.on('timeout', () => req.destroy(new Error(`${path}: no response in 5s`)))
      req.on('error', reject)
      req.end(body)
    })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await post('/ready', '')
        break
      } catch (error) {
        if (attempt === 100) throw error
        await new Promise((accept) => setTimeout(accept, 100))
      }
    }
    const responses = []
    for (const [index, body] of ['one', 'two', 'three'].entries()) responses.push(await post(`/r${index}`, body))
    return responses
  } finally {
    agent.destroy()
    server.kill()
    await stopped
  }
}

const expected = await exchange(process.execPath, ['--experimental-strip-types', 'server.ts'], 3316)
const actual = await exchange(resolve(app, exe), [], 3317)
assert.deepEqual(
  actual.map((response) => response.body),
  expected.map((response) => response.body)
)
assert.equal(new Set(expected.map((response) => response.socketPort)).size, 1, 'the oracle reused one keep-alive connection')
assert.equal(new Set(actual.map((response) => response.socketPort)).size, 1, `compiled server reused one keep-alive connection: ${actual.map((response) => response.socketPort)}`)
console.log(`PASS: ${actual.length} POST bodies over one keep-alive connection match Node`)
