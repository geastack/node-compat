import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist', 'http-server-options.out')
const source = resolve(root, 'apps/nest-node-probe/correctness/http-server-options.ts')
const executable = resolve(output, 'http-server-options')
mkdirSync(output, { recursive: true })
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  cwd: root,
  env: { ...process.env, TMPDIR: output },
  stdio: ['ignore', 'ignore', 'inherit']
})

const get = (port, path) =>
  new Promise((accept, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: path === '/head' ? 'HEAD' : 'GET', agent: false, timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('error', reject)
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => accept({ status: res.statusCode, type: res.headers['content-type'], body }))
    })
    req.on('timeout', () => req.destroy(new Error(`${path}: no response in 5s`)))
    req.on('error', reject)
    req.end()
  })

const paths = ['/', '/users/7?x=1&y=2', '/a%20b/../c', '/head', '/deep/path/with?query=only']
const bound = async (port) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((accept, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.destroy()
          accept()
        })
        socket.on('error', reject)
      })
      return
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' || attempt >= 50) throw error
      await delay(100)
    }
  }
}

const started = (child, command) =>
  new Promise((accept, reject) => {
    let stdout = ''
    const deadline = setTimeout(() => reject(new Error(`${command} did not print listening within 10s`)), 10000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!stdout.includes('listening')) return
      clearTimeout(deadline)
      accept()
    })
    child.on('exit', (code) => {
      clearTimeout(deadline)
      reject(new Error(`${command} exited with ${code} before listening`))
    })
  })

const stop = async (child, closed, failed) => {
  try {
    child.kill()
    await closed
  } catch (error) {
    if (!failed) throw error
  }
}

const serve = async (command, args, port) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close')
  let failed = false
  try {
    await started(child, command)
    await bound(port)
    const answers = []
    for (const path of paths) answers.push(await get(port, path))
    return answers
  } catch (error) {
    failed = true
    throw error
  } finally {
    await stop(child, closed, failed)
  }
}

const expected = await serve(process.execPath, ['--experimental-strip-types', source], 3316)
const actual = await serve(executable, [], 3317)
for (const [i, path] of paths.entries()) {
  assert.deepEqual(actual[i], expected[i], `${path}\n--- node\n${JSON.stringify(expected[i])}\n--- compiled\n${JSON.stringify(actual[i])}`)
}
assert.match(expected[0].body, /^request true true\nresponse true true\nreq true \/\n/)
console.log(`HTTP_SERVER_OPTIONS_PARITY_OK:${paths.length}`)
