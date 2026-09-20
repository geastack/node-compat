import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-events-advanced-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')
const entry = path.join(repo, 'apps', 'events-advanced', 'server.ts')

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
    'symbol:value',
    'error-order:monitor,handler',
    'statics:true,true,true',
    'resource:true,7,advanced',
    'destroyed:true',
    'abort:1',
    'capture:rejected',
    'iterator:false,first,2',
    'iterator-close:true',
    'iterator-return:true'
  ])
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  console.log('Verified node:events symbols, abort listener, async resource, rejection capture, and async iterator')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
