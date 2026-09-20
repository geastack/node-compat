import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const entry = path.join(repo, 'apps', 'net-server-overloads', 'server.ts')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-net-server-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')

const build = spawnSync(
  process.execPath,
  [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable],
  { cwd: repo, encoding: 'utf8' }
)
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

function run(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [mode], {
      cwd: repo,
      env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: '1' }
    })
    let stdout = ''
    let stderr = ''
    let connected = false
    let client
    const timeout = setTimeout(() => {
      client?.destroy()
      child.kill('SIGKILL')
      reject(new Error(`Server probe timed out in ${mode}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10000)

    function consume(chunk, stream) {
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
      if (connected) return
      const match = `${stdout}\n${stderr}`.match(/^listening:(\{[^\n]+\}),true,true$/m)
      if (!match) return
      connected = true
      const address = JSON.parse(match[1])
      client = net.createConnection({ host: '127.0.0.1', port: address.port }, () => {
        client.end('gea-server-probe')
      })
      let response = ''
      client.setEncoding('utf8')
      client.on('data', (data) => {
        response += data
      })
      client.on('end', () => {
        assert.equal(response, 'gea-server-response')
      })
      client.on('error', reject)
    }
    child.stdout.on('data', (chunk) => consume(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => {
      consume(chunk, 'stderr')
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      try {
        assert.equal(code, 0, `signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        const output = `${stdout}\n${stderr}`
        assert.match(output, /^listening:\{"address":"127\.0\.0\.1","family":"IPv4","port":\d+\},true,true$/m)
        assert.match(output, /^connection:false,false,false,\{"address":"127\.0\.0\.1","family":"IPv4","port":\d+\}$/m)
        assert.match(output, /^data:gea-server-probe$/m)
        assert.match(output, /^connections:true,1,1$/m)
        assert.match(output, /^server-close$/m)
        assert.match(output, /^close-callback:true$/m)
        assert.doesNotMatch(output, /server-error|ERR_GEA_NODE_NOT_IMPLEMENTED/)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
}

try {
  for (const mode of ['options', 'positional', 'paused']) await run(mode)
  console.log('Verified node:net Server TCP listen overloads, accepted sockets, state, and close lifecycle')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
