import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeCompatRoot = path.resolve(appRoot, '../..')
const runTimeoutMs = 30_000

const probes = {
  ping: {
    entry: path.join(appRoot, 'correctness/native/mongodb-cmap-ping.ts'),
    outDir: path.join(appRoot, 'dist'),
    expectedOutput: 'PING:1'
  },
  crud: {
    entry: path.join(appRoot, 'correctness/native/mongodb-source-crud.ts'),
    outDir: path.join(appRoot, 'dist'),
    expectedOutput: '0123456789abcdef01234567:created:false:updated:true:1:absent'
  }
}

function usage() {
  console.error(
    'usage: node scripts/native-mongodb-correctness.mjs <ping|crud> [--emit-only|--run]'
  )
  process.exit(2)
}

const probeName = process.argv[2]
if (probeName !== 'ping' && probeName !== 'crud') usage()

const emitOnly = process.argv.includes('--emit-only')
const runAfterBuild = process.argv.includes('--run')
if (emitOnly && runAfterBuild) usage()

const unknownArguments = process.argv.slice(3).filter((value) => {
  return value !== '--emit-only' && value !== '--run'
})
if (unknownArguments.length > 0) usage()

const probe = probes[probeName]
const executablePath = path.join(probe.outDir, `mongodb-${probeName}`)

const build = spawnSync(process.execPath, [
  path.join(nodeCompatRoot, 'scripts/build.mjs'),
  probe.entry,
  '--from-source=mongodb,bson,mongodb-connection-string-url',
  '--source-project', path.join(nodeCompatRoot, 'vendored-sources/mongodb/tsconfig.json'),
  '--globals', '--out', probe.outDir, '--exe', executablePath,
  ...(emitOnly ? ['--emit-only'] : [])
], { cwd: appRoot, env: process.env, stdio: 'inherit' })
if (build.error || build.status !== 0) {
  console.error(`MONGODB_NATIVE_CORRECTNESS_BUILD_ERROR:${probeName}:${build.error?.message ?? build.status ?? build.signal}`)
  process.exit(build.status ?? 1)
}

if (emitOnly) {
  console.log(`MONGODB_NATIVE_CORRECTNESS_EMIT_OK:${probeName}:${probe.outDir}`)
  process.exit(0)
}

console.log(`MONGODB_NATIVE_CORRECTNESS_BUILD_OK:${probeName}:${executablePath}`)

if (runAfterBuild) {
  try {
    await runProbe(probeName, probe, executablePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`MONGODB_NATIVE_CORRECTNESS_RUN_ERROR:${probeName}:${message}`)
    process.exit(1)
  }
}

async function runProbe(name, definition, executable) {
  const child = spawn(executable, [], {
    cwd: appRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let timedOut = false
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdout = `${stdout}${text}`.slice(-65_536)
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
  })

  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, runTimeoutMs)

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timeout))

  if (timedOut) {
    throw new Error(`native ${name} probe exceeded ${runTimeoutMs}ms`)
  }
  if (code !== 0) {
    throw new Error(`native ${name} probe exited with ${code ?? signal ?? 'unknown status'}`)
  }

  const outputLines = stdout.split(/\r?\n/)
  if (!outputLines.includes(definition.expectedOutput)) {
    throw new Error(
      `native ${name} probe did not print ${JSON.stringify(definition.expectedOutput)}`
    )
  }

  console.log(`MONGODB_NATIVE_CORRECTNESS_RUN_OK:${name}`)
}
