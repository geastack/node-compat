// Differential correctness for `correctness/native/*.ts`: each probe runs
// under node (`npx tsx`) and as a native binary built by node-compat's
// `scripts/build.mjs`, and the two stdouts (and exit codes) must match.
// The mongodb probes talk to a mongod at 127.0.0.1:27017 (the
// `geastack-mongod-ping` docker container).
//
// The driver compiles from its published package source: a probe that imports
// `mongodb` is built with `--source-project node_modules/mongodb/tsconfig.json`
// and a larger V8 heap (the emit needs ~8 GB). There is no vendored checkout.
//
// usage: node scripts/native-mongodb-correctness.mjs [probe...] [mode]
//   probe      basename under correctness/native (with or without `.ts`);
//              default: every probe
//   mode       (default) compile + link, then diff
//              --emit-only   compile and emit C++ only; no link, no run
//              --link-only   link an earlier --emit-only emission, then diff
//              --skip-build  diff against the binaries already built
//
// Output lands in dist/correctness/<probe>/ (dist is the app's ignored build
// output), binary dist/correctness/<probe>/<probe>, build report beside it.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeCompatRoot = path.resolve(appRoot, '../..')
const probeDir = path.join(appRoot, 'correctness/native')
const buildRoot = path.join(appRoot, 'dist/correctness')
const mongodbSourceProject = path.join(appRoot, 'node_modules/mongodb/tsconfig.json')
const runTimeoutMs = 30_000
const buildTimeoutMs = Number(process.env.MONGODB_CORRECTNESS_BUILD_TIMEOUT_MS ?? 30 * 60_000)

const modes = ['--emit-only', '--link-only', '--skip-build']
const args = process.argv.slice(2)
const selectedModes = args.filter((value) => modes.includes(value))
const unknownFlags = args.filter((value) => value.startsWith('-') && !modes.includes(value))
const available = fs
  .readdirSync(probeDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => name.slice(0, -3))
  .sort()

function usage(message) {
  if (message) console.error(message)
  console.error(
    `usage: node scripts/native-mongodb-correctness.mjs [probe...] [${modes.join('|')}]\n` +
      `probes: ${available.join(', ')}`
  )
  process.exit(2)
}

if (unknownFlags.length > 0) usage(`unknown option(s): ${unknownFlags.join(' ')}`)
if (selectedModes.length > 1) usage(`choose one of ${modes.join(', ')}`)
const mode = selectedModes[0] ?? null
const requested = args.filter((value) => !value.startsWith('-')).map((value) => value.replace(/\.ts$/, ''))
const missing = requested.filter((name) => !available.includes(name))
if (missing.length > 0) usage(`unknown probe(s): ${missing.join(', ')}`)
const probes = requested.length > 0 ? requested : available

// The same TMPDIR discipline as scripts/run-with-work-env.mjs: compiler
// scratch goes to the app's ignored build output, never the system tmp.
const scratch = path.join(appRoot, 'dist')
fs.mkdirSync(scratch, { recursive: true })
const baseEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }

function buildProbe(name) {
  const entry = path.join(probeDir, `${name}.ts`)
  const outDir = path.join(buildRoot, name)
  const executable = path.join(outDir, name)
  const report = path.join(outDir, 'report.json')
  const importsMongodb = /from\s+['"]mongodb['"]/.test(fs.readFileSync(entry, 'utf8'))
  const nodeOptions = [baseEnv.NODE_OPTIONS, importsMongodb ? '--max-old-space-size=8192' : null]
    .filter(Boolean)
    .join(' ')
  const buildArgs = [
    path.join(nodeCompatRoot, 'scripts/build.mjs'),
    entry,
    ...(importsMongodb ? ['--source-project', mongodbSourceProject] : []),
    '--out', outDir,
    '--exe', executable,
    '--report', report,
    // The probes use globals (`URL`, timers, ...) the way the hono app does.
    '--globals',
    ...(mode === '--emit-only' ? ['--emit-only'] : []),
    ...(mode === '--link-only' ? ['--link-only'] : [])
  ]
  console.log(`[correctness] build ${name}${mode ? ` ${mode}` : ''}`)
  const started = Date.now()
  const build = spawnSync(process.execPath, buildArgs, {
    cwd: appRoot,
    env: { ...baseEnv, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
    stdio: 'inherit',
    timeout: buildTimeoutMs
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (build.error || build.status !== 0) {
    return { ok: false, detail: `build failed after ${seconds}s: ${build.error?.message ?? build.signal ?? `exit ${build.status}`}` }
  }
  return { ok: true, detail: `built in ${seconds}s`, executable }
}

function run(command, commandArgs, label) {
  return new Promise((resolve) => {
    // node-compat root: probes name repo-relative paths (`apps/hono-mongodb-todo/...`).
    const child = spawn(command, commandArgs, { cwd: nodeCompatRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, runTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ label, code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ label, code, signal, stdout, stderr, timedOut })
    })
  })
}

function describe(result) {
  if (result.timedOut) return `timed out after ${runTimeoutMs}ms`
  return result.signal ? `signal ${result.signal}` : `exit ${result.code}`
}

function diffLines(expected, actual) {
  const left = expected.split('\n')
  const right = actual.split('\n')
  const lines = []
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue
    if (left[index] !== undefined) lines.push(`  ${index + 1} node:   ${JSON.stringify(left[index])}`)
    if (right[index] !== undefined) lines.push(`  ${index + 1} native: ${JSON.stringify(right[index])}`)
  }
  return lines.join('\n')
}

const results = []
for (const name of probes) {
  let executable = path.join(buildRoot, name, name)
  if (mode !== '--skip-build') {
    const build = buildProbe(name)
    if (!build.ok) {
      results.push({ name, status: 'BUILD_ERROR', detail: build.detail })
      continue
    }
    if (mode === '--emit-only') {
      results.push({ name, status: 'EMIT_OK', detail: build.detail })
      continue
    }
    executable = build.executable
  }
  if (!fs.existsSync(executable)) {
    results.push({ name, status: 'BUILD_ERROR', detail: `no binary at ${path.relative(appRoot, executable)}` })
    continue
  }

  const entry = path.join(probeDir, `${name}.ts`)
  const tsx = path.join(appRoot, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const reference = fs.existsSync(tsx) ? await run(tsx, [entry], 'node') : await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', entry], 'node')
  const native = await run(executable, [], 'native')
  const problems = []
  if (reference.timedOut || reference.code !== 0) {
    problems.push(`node reference ${describe(reference)}\n${reference.stderr.trimEnd()}`)
  }
  if (native.timedOut || native.code !== reference.code || native.signal !== reference.signal) {
    problems.push(`native ${describe(native)} (node: ${describe(reference)})\n${native.stderr.trimEnd()}`)
  }
  if (native.stdout !== reference.stdout) {
    problems.push(`stdout differs:\n${diffLines(reference.stdout, native.stdout)}`)
  }
  results.push({
    name,
    status: problems.length === 0 ? 'OK' : 'MISMATCH',
    detail: problems.length === 0 ? `${reference.stdout.split('\n').filter(Boolean).length} line(s) identical` : problems.join('\n'),
    stdout: reference.stdout
  })
}

for (const result of results) {
  console.log(`MONGODB_NATIVE_CORRECTNESS_${result.status}:${result.name}: ${result.detail}`)
  if (result.status === 'OK' && result.stdout) process.stdout.write(result.stdout.replace(/^/gm, '  | '))
}
const failed = results.filter((result) => result.status !== 'OK' && result.status !== 'EMIT_OK')
console.log(`MONGODB_NATIVE_CORRECTNESS_SUMMARY: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
