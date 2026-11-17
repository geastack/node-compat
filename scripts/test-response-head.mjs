import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist', 'response-head.out')
const source = resolve(root, 'apps/nest-node-probe/correctness/response-head.ts')
const executable = resolve(output, 'response-head')
mkdirSync(output, { recursive: true })
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  cwd: root,
  env: { ...process.env, TMPDIR: output },
  stdio: ['ignore', 'ignore', 'inherit']
})

const get = (port, path) =>
  new Promise((accept, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, agent: false, timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('error', reject)
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        const head = []
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (!/^(date|connection|keep-alive)$/i.test(res.rawHeaders[i])) head.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
        accept({ status: res.statusCode, message: res.statusMessage, head, body })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      accept({ error: 'no response in 5s' })
    })
    req.on('error', (error) => (error.code === undefined || error.code === 'ECONNRESET' ? reject(error) : accept({ error: error.code })))
    req.end()
  })

const paths = ['/pairs', '/staged', '/reason', '/reason-ok', '/pair-inject', '/staged-inject', '/object-inject', '/set-inject', '/append-inject', '/bad-name', '/end-recover', '/nested-pairs', '/odd-pairs', '/odd-staged']
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

const expected = await serve(process.execPath, ['--experimental-strip-types', source], 3324)
const actual = await serve(executable, [], 3325)
for (const [i, path] of paths.entries()) {
  assert.deepEqual(actual[i], expected[i], `${path}\n--- node\n${JSON.stringify(expected[i])}\n--- compiled\n${JSON.stringify(actual[i])}`)
}
assert.deepEqual(expected[0].head.filter((line) => line.startsWith('Set-Cookie')), ['Set-Cookie: a=1', 'Set-Cookie: b=2'], 'the oracle kept both pairs')
assert.match(expected[2].body, /^ERR_INVALID_CHAR /, 'the oracle rejected the reason phrase')
for (const index of [4, 5, 6, 7, 8, 10]) assert.match(expected[index].body, /^ERR_INVALID_CHAR /, `the oracle rejected ${paths[index]}`)
assert.match(expected[9].body, /^ERR_INVALID_HTTP_TOKEN /, 'the oracle rejected the header name')
assert.deepEqual(expected[11].head.filter((line) => line.startsWith('Set-Cookie')), ['Set-Cookie: a=1', 'Set-Cookie: b=2'], 'the oracle kept both nested pairs')
for (const index of [12, 13]) assert.match(expected[index].body, /^ERR_INVALID_ARG_VALUE headers false false$/, `the oracle rejected ${paths[index]}`)
console.log(`RESPONSE_HEAD_PARITY_OK:${paths.length}`)
