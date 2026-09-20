// Parity driver: runs the SAME app under gea-native and Node, fires a battery
// of raw-socket HTTP requests at each, and diffs the responses byte-for-byte
// (normalizing only the Date header VALUE — clocks differ).
//
// Usage: node driver.mjs <gea-binary> <node-entry>
import net from 'node:net'
import { spawn } from 'node:child_process'

const PORT = 3000
const geaBinary = process.argv[2]
const nodeEntry = process.argv[3]

const CASES = [
  { name: 'get-root', raw: 'GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'get-plain-implicit-headers', raw: 'GET /plain HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'get-404', raw: 'GET /nope HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'head-root', raw: 'HEAD / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'post-echo-content-length', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello world' },
  { name: 'post-echo-empty', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' },
  {
    name: 'post-echo-chunked',
    raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nabcde\r\n3\r\nfgh\r\n0\r\n\r\n'
  },
  {
    name: 'req-headers-join',
    raw: 'GET /req-info HTTP/1.1\r\nHost: h\r\nX-One: single\r\nX-Dup: a\r\nX-Dup: b\r\nCookie: k1=v1\r\nCookie: k2=v2\r\nConnection: close\r\n\r\n'
  },
  { name: 'stream-chunked', raw: 'GET /stream HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'async-handler', raw: 'GET /async HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'timer-handler', raw: 'GET /timer HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'status-message', raw: 'GET /status HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'status-204', raw: 'GET /codes HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'headers-api', raw: 'GET /headers-api HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'finish-event', raw: 'GET /finish-event HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'keep-alive-pair', raw: 'GET / HTTP/1.1\r\nHost: h\r\n\r\nGET /plain HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', idleMs: 400 },
  { name: 'http10-default-close', raw: 'GET / HTTP/1.0\r\nHost: h\r\n\r\n' },
  { name: 'http10-keep-alive', raw: 'GET / HTTP/1.0\r\nHost: h\r\nConnection: keep-alive\r\n\r\nGET /plain HTTP/1.0\r\nHost: h\r\n\r\n', idleMs: 400 },
  {
    name: 'expect-100-continue',
    raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\nworld',
    idleMs: 400
  },
  { name: 'bad-request-line', raw: 'GARBAGE\r\n\r\n', idleMs: 400 },
  { name: 'unknown-transfer-encoding', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: gzip\r\nConnection: close\r\n\r\n', idleMs: 400 },
  { name: 'oversized-headers', raw: 'GET / HTTP/1.1\r\nHost: h\r\nX-Big: ' + 'a'.repeat(20000) + '\r\nConnection: close\r\n\r\n', idleMs: 400 },
  { name: 'query-url', raw: 'GET /nope?a=1&b=two%20three HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'set-cookie-array', raw: 'GET /set-cookie HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'head-implicit-length', raw: 'HEAD /head-implicit HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'remote-address', raw: 'GET /remote HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'big-body-1mb', raw: 'POST /big-echo HTTP/1.1\r\nHost: h\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n' + 'x'.repeat(1048576), idleMs: 1500 },
  { name: 'double-end', raw: 'GET /double-end HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'write-after-end', raw: 'GET /write-after-end HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'chunk-extension', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5;ext=1\r\nabcde\r\n0\r\n\r\n' },
  { name: 'chunked-with-trailers', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\nX-Trailer: t\r\n\r\n' },
  { name: 'malformed-chunk-size', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\nabcde\r\n0\r\n\r\n', idleMs: 400 },
  { name: 'header-space-in-name', raw: 'GET / HTTP/1.1\r\nHost: h\r\nBad Header: v\r\nConnection: close\r\n\r\n', idleMs: 400 },
  { name: 'obsolete-line-folding', raw: 'GET /req-info HTTP/1.1\r\nHost: h\r\nX-One: a\r\n b\r\nConnection: close\r\n\r\n', idleMs: 400 },
  { name: 'pipelined-post-then-get', raw: 'POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabcGET /plain HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', idleMs: 500 },
  { name: 'delete-method', raw: 'DELETE /nope HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'named-group-param', raw: 'GET /user/alice/edit HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' },
  { name: 'named-group-optional-absent', raw: 'GET /user/bob HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n' }
]

function fire(testCase) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1')
    let data = Buffer.alloc(0)
    let idleTimer = null
    const idleMs = testCase.idleMs ?? 900
    const done = () => {
      socket.destroy()
      resolve(data.toString('latin1'))
    }
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(done, idleMs)
    }
    socket.on('connect', () => {
      socket.write(Buffer.from(testCase.raw, 'latin1'))
      bumpIdle()
    })
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      bumpIdle()
    })
    socket.on('close', done)
    socket.on('error', done)
  })
}

function normalize(response) {
  return response.replace(/^Date: [^\r\n]+/gim, 'Date: DATE')
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(PORT, '127.0.0.1')
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (up) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function runBattery(label, command, args) {
  // One server per case: a case that crashes the server (Node kills the
  // process on an uncaught handler exception) must not contaminate the rest.
  const results = {}
  for (const testCase of CASES) {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    if (!(await waitForServer())) {
      child.kill('SIGKILL')
      throw new Error(`${label}: server did not come up for ${testCase.name}`)
    }
    results[testCase.name] = normalize(await fire(testCase))
    child.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 150))
  }
  return results
}

const gea = await runBattery('gea', geaBinary, [])
const node = await runBattery('node', process.execPath, [nodeEntry])

let passed = 0
let failed = 0
for (const testCase of CASES) {
  const g = gea[testCase.name]
  const n = node[testCase.name]
  if (g === n) {
    passed++
    console.log(`PASS ${testCase.name}`)
  } else {
    failed++
    console.log(`FAIL ${testCase.name}`)
    console.log(`  --- node ---\n${JSON.stringify(n)}`)
    console.log(`  --- gea ----\n${JSON.stringify(g)}`)
  }
}
console.log(`\n${passed}/${CASES.length} parity, ${failed} diffs`)
process.exit(failed === 0 ? 0 : 1)
