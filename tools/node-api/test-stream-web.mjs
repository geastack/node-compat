import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-stream-web-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')
const entry = path.join(repo, 'apps', 'stream-web', 'server.ts')

try {
  const build = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable, '--debug'],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
  const run = spawnSync(executable, [], { cwd: repo, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'strategy:4,1,5',
    'read:false,first,true',
    'transform:MIXED',
    'encode:utf-8,5',
    'decode:utf-8,ok',
    'compression:bytes',
    'read-end:true',
    'read-unlocked:false',
    'write:value,closed,false'
  ])
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  console.log('Verified node:stream/web readers, writers, transforms, codecs, and queuing strategies')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
