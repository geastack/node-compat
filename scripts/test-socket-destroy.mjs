import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist', 'socket-destroy.out')
const source = resolve(root, 'apps/nest-node-probe/correctness/socket-destroy.ts')
const executable = resolve(output, 'socket-destroy')
mkdirSync(output, { recursive: true })
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  cwd: root,
  env: { ...process.env, TMPDIR: output },
  stdio: ['ignore', 'ignore', 'inherit']
})

const request = (port, path, agent = false) =>
  new Promise((accept, reject) => {
    let body = ''
    const req = http.request({ hostname: '127.0.0.1', port, path, agent, timeout: 5000 }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => accept(body))
    })
    req.on('timeout', () => {
      reject(new Error(`${path}: the connection stayed open for 5s`))
      req.destroy()
    })
    req.on('error', () => accept(body))
    req.on('close', () => accept(body))
    req.end()
  })

const unreadUntilDestroyed = (port, path) =>
  new Promise((accept, reject) => {
    let bytes = 0
    const deadline = setTimeout(() => {
      reject(new Error(`${path}: the connection stayed open for 10s`))
      socket.destroy()
    }, 10000)
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
      socket.pause()
      setTimeout(() => socket.resume(), 1000)
    })
    socket.on('data', (chunk) => (bytes += chunk.length))
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(deadline)
      accept(`${path} unread body truncated=${bytes < 32 * 1024 * 1024}`)
    })
  })

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
  let stdout = ''
  const observed = []
  let failed = false
  child.stdout.on('data', (chunk) => (stdout += chunk))
  try {
    await started(child, command)
    await bound(port)
    for (const path of ['/socket', '/response', '/response-before-socket', '/request', '/kept']) {
      await request(port, path)
      await delay(300)
    }
    const keepAlive = new http.Agent({ keepAlive: true })
    await request(port, '/kept-alive', keepAlive)
    await delay(300)
    keepAlive.destroy()
    await delay(300)
    await request(port, '/stash')
    for (let i = 0; i < 80; i++) assert.equal(await request(port, '/fill'), 'false')
    await request(port, '/stashed')
    observed.push(await unreadUntilDestroyed(port, '/destroy-after-end'))
  } catch (error) {
    failed = true
    throw error
  } finally {
    await stop(child, closed, failed)
  }
  return [...stdout.split('\n').filter((line) => line.length > 0 && !line.includes('listening')), ...observed]
}

const expected = await serve(process.execPath, ['--experimental-strip-types', source], 3320)
const actual = await serve(executable, [], 3321)
assert.deepEqual(actual, expected, `--- node\n${expected.join('\n')}\n--- compiled\n${actual.join('\n')}`)
console.log(`SOCKET_DESTROY_PARITY_OK:${expected.length}`)
