import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// The native libraries a Windows build links (zlib for node:zlib) come from
// vcpkg's static triplet -- static libraries over the static CRT, what a plain
// clang++ link uses -- found under VCPKG_ROOT, else C:\vcpkg, the same way the
// compiler's release checks find them (its scripts/host-toolchain.mjs).
// Install with `vcpkg install zlib --triplet x64-windows-static`. Null
// elsewhere: Linux and macOS link the system's libraries.
export function windowsLibraries() {
  if (process.platform !== 'win32') return null
  for (const root of [process.env.VCPKG_ROOT, 'C:\\vcpkg'].filter(Boolean)) {
    const installed = path.join(root, 'installed', 'x64-windows-static')
    if (fs.existsSync(path.join(installed, 'lib'))) return installed
  }
  return null
}

export function brotliPrefix() {
  if (brotliPrefix.cache !== undefined) return brotliPrefix.cache
  const candidates = []
  if (process.env.BROTLI_DIR) candidates.push(path.resolve(process.env.BROTLI_DIR))
  else if (process.platform === 'win32') {
    if (windowsLibraries()) candidates.push(windowsLibraries())
  } else if (process.platform === 'darwin') {
    try {
      candidates.push(execFileSync('brew', ['--prefix', 'brotli'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch {}
    candidates.push('/opt/homebrew/opt/brotli', '/usr/local/opt/brotli')
  }
  brotliPrefix.cache = candidates.find((prefix) => fs.existsSync(path.join(prefix, 'include', 'brotli', 'decode.h'))) ?? null
  if (brotliPrefix.cache === null && (process.platform !== 'linux' || process.env.BROTLI_DIR)) {
    const install =
      process.platform === 'darwin'
        ? 'Install with `brew install brotli`'
        : process.platform === 'win32'
          ? 'Install with `vcpkg install brotli --triplet x64-windows-static`'
          : 'Install libbrotli-dev (Debian/Ubuntu) or brotli-devel (Fedora)'
    throw new Error(
      `brotli (libbrotlidec) not found: node:zlib's brotli decoder needs its headers and library. ${install}, or set BROTLI_DIR to a prefix holding include/brotli/decode.h and lib/.`
    )
  }
  return brotliPrefix.cache
}
