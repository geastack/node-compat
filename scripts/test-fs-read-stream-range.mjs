import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'apps/nest-node-probe/dist')
const source = resolve(root, 'apps/nest-node-probe/correctness/fs-read-stream-range.ts')
const executable = resolve(output, 'fs-read-stream-range')
const fixtures = join(output, 'fs-read-stream-range.fixtures')
rmSync(fixtures, { recursive: true, force: true })
mkdirSync(fixtures, { recursive: true })

try {
  writeFileSync(join(fixtures, 'small.bin'), Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256)))
  const sparse = openSync(join(fixtures, 'sparse.bin'), 'w')
  ftruncateSync(sparse, 1024 * 1024 * 1024)
  writeSync(sparse, Buffer.from('range-marker'), 0, 12, 768 * 1024 * 1024)
  closeSync(sparse)

  const options = { cwd: root, encoding: 'utf8', env: process.env }
  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs'), source, '--out', output, '--exe', executable], { ...options, stdio: 'inherit' })
  const expected = execFileSync(process.execPath, ['--experimental-strip-types', source], options)

  const timed = process.platform === 'darwin' ? ['-l', executable] : ['-v', executable]
  const run = spawnSync('/usr/bin/time', timed, { ...options, timeout: 30000 })
  assert.equal(run.status, 0, `compiled probe exited ${run.status}\n${run.stderr}`)
  assert.equal(run.stdout, expected, `--- node\n${expected}\n--- compiled\n${run.stdout}`)

  const rss = process.platform === 'darwin'
    ? Number(/(\d+)\s+maximum resident set size/.exec(run.stderr)?.[1])
    : Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(run.stderr)?.[1]) * 1024
  assert.ok(Number.isFinite(rss), `no peak RSS in /usr/bin/time output\n${run.stderr}`)
  assert.ok(rss < 256 * 1024 * 1024, `ranged reads of a 1 GiB file peaked at ${Math.round(rss / 1024 / 1024)} MiB`)
  console.log(`FS_READ_STREAM_RANGE_PARITY_OK:${expected.trim().split('\n').length} peak=${Math.round(rss / 1024 / 1024)}MiB`)
} finally {
  rmSync(fixtures, { recursive: true, force: true })
}
