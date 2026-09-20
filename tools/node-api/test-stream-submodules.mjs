import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-stream-submodules-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')
const entry = path.join(repo, 'apps', 'stream-submodules', 'server.ts')

try {
  const build = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable, '--debug'],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

  const run = spawnSync(executable, [], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: '1' }
  })
  assert.equal(
    run.status,
    0,
    `${run.stdout}\n${run.stderr}\n${JSON.stringify({ signal: run.signal, error: run.error?.message })}`
  )
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'promise-pipeline:promise,true',
    'promise-finished:true',
    'text:hello world',
    'buffer:buffer,6',
    'json:42',
    'array-buffer:5',
    'blob-size:4',
    'blob-text:blob'
  ])
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  console.log('Verified node:stream/promises and node:stream/consumers promise, buffer, text, JSON, ArrayBuffer, and Blob behavior')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
