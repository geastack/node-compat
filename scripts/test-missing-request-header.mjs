import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/missing-request-header.ts')
const executable = resolve(output, 'missing-request-header')
mkdirSync(output, { recursive: true })
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], {
  cwd: root,
  env: { ...process.env, TMPDIR: output },
  stdio: ['ignore', 'ignore', 'inherit']
})

const get = (port) =>
  new Promise((accept, reject) => {
    const headers = { 'x-present': 'v', 'x-empty': '' }
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', headers, agent: false, timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => accept({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('no response in 5s')))
    req.on('error', reject)
    req.end()
  })

const serve = async (command, args, port) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = once(child, 'exit')
  await new Promise((accept, reject) => {
    child.stdout.on('data', (chunk) => String(chunk).includes('listening') && accept())
    child.on('exit', (code) => reject(new Error(`${command} exited with ${code} before listening`)))
  })
  try {
    return await get(port)
  } finally {
    child.kill()
    await exited
  }
}

const expected = await serve(process.execPath, [source], 3318)
const actual = await serve(executable, [], 3319)
assert.equal(expected.body, 'missing true undefined fallback\npresent false string v\nempty false string \n')
assert.deepEqual(actual, expected, `--- node\n${expected.body}\n--- compiled\n${actual.body}`)
console.log('MISSING_REQUEST_HEADER_PARITY_OK')
