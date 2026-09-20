import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-events-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')
const entry = path.join(repo, 'apps', 'events-overlays', 'server.ts')

try {
  const build = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

  const run = spawnSync(executable, [], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: '1' }
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  const output = run.stdout.trim().split('\n')
  assert.deepEqual(output, [
    'listeners-before:4,4,4',
    'order:prepend-once,prepended,regular,once,prepended,regular',
    'listeners-after:2,1',
    'max:4,4',
    'max-instance:0',
    'meta:add:work,add:work,add:work,add:work,remove:work,remove:work,remove:work,remove:work',
    'events:newListener,removeListener',
    'error:boom',
    'range:ERR_OUT_OF_RANGE',
    'once:value,2'
  ])
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  console.log('Verified node:events listener lifecycle, inspection, max-listener helpers, and once promise')
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true })
}
