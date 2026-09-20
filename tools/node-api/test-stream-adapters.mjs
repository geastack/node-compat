import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-stream-adapters-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')
const entry = path.join(repo, 'apps', 'stream-adapters', 'server.ts')

try {
  const build = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

  const run = spawnSync(executable, [], { cwd: repo, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.stdout.trim().split('\n').sort(), [
    'iterator-next:false,one',
    'iterator-return:true,false',
    'readable-from:from-web',
    'readable-to:false,to-web',
    'writable-from:from-node,closed',
    'writable-to:from-web,true',
    'duplex-read:duplex-in',
    'duplex-write:duplex-out,closed',
    'dispose:true,true'
  ].sort())
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  console.log('Verified node:stream async iteration, disposal, and Web Stream adapters')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
