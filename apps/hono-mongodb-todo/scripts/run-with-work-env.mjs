import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Compiler scratch belongs to the app's established, ignored build output.
const buildDir = path.join(appRoot, 'dist')
mkdirSync(buildDir, { recursive: true })

const [requestedCommand, ...args] = process.argv.slice(2)
if (!requestedCommand) {
  console.error('usage: node scripts/run-with-work-env.mjs <command> [...args]')
  process.exit(2)
}

const command = requestedCommand === 'node' ? process.execPath : requestedCommand
// npm and npx are .cmd scripts on Windows, which node starts only through a
// shell (spawning a .cmd directly is EINVAL since node's CVE-2024-27980 fix).
// Their arguments here are script names and flags, so joining them loses nothing.
const viaShell = process.platform === 'win32' && (command === 'npm' || command === 'npx')

const child = spawn(viaShell ? [command, ...args].join(' ') : command, viaShell ? [] : args, {
  shell: viaShell,
  cwd: appRoot,
  env: {
    ...process.env,
    TMPDIR: buildDir,
    TMP: buildDir,
    TEMP: buildDir
  },
  stdio: 'inherit'
})

const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const signalHandlers = new Map()
for (const signal of forwardedSignals) {
  const handler = () => child.kill(signal)
  signalHandlers.set(signal, handler)
  process.on(signal, handler)
}

child.once('error', (error) => {
  console.error(`failed to start ${requestedCommand}: ${error.message}`)
  process.exitCode = 1
})

child.once('close', (code, signal) => {
  for (const [name, handler] of signalHandlers) process.off(name, handler)
  if (signal && process.platform !== 'win32') {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
