import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

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

// libzstd for node:zlib's zstd codecs, found the way brotli is: ZSTD_DIR, else
// Homebrew on macOS, vcpkg on Windows, the system's default search path on
// Linux (libzstd-dev / libzstd-devel). Only a program that reaches zstd asks.
export function zstdPrefix() {
  if (zstdPrefix.cache !== undefined) return zstdPrefix.cache
  const candidates = []
  if (process.env.ZSTD_DIR) candidates.push(path.resolve(process.env.ZSTD_DIR))
  else if (process.platform === 'win32') {
    if (windowsLibraries()) candidates.push(windowsLibraries())
  } else if (process.platform === 'darwin') {
    try {
      candidates.push(execFileSync('brew', ['--prefix', 'zstd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch {}
    candidates.push('/opt/homebrew/opt/zstd', '/usr/local/opt/zstd')
  }
  zstdPrefix.cache = candidates.find((prefix) => fs.existsSync(path.join(prefix, 'include', 'zstd.h'))) ?? null
  if (zstdPrefix.cache === null && (process.platform !== 'linux' || process.env.ZSTD_DIR)) {
    const install =
      process.platform === 'darwin'
        ? 'Install with `brew install zstd`'
        : process.platform === 'win32'
          ? 'Install with `vcpkg install zstd --triplet x64-windows-static`'
          : 'Install libzstd-dev (Debian/Ubuntu) or libzstd-devel (Fedora)'
    throw new Error(
      `zstd (libzstd) not found: node:zlib's zstd codecs need its headers and library. ${install}, or set ZSTD_DIR to a prefix holding include/zstd.h and lib/.`
    )
  }
  return zstdPrefix.cache
}

// CVE-2026-111497, the libbrotlidec out-of-bounds write node:zlib's brotli
// decoder is exposed to. Upstream fixed it in 1.2.1, 1.1.1 and 1.0.10.
export const BROTLI_DECODER_CVE = 'CVE-2026-111497'

export function brotliVersionIsPatched(version) {
  const major = version >>> 24
  const minor = (version >>> 12) & 0xfff
  const patch = version & 0xfff
  if (major !== 1) return major > 1
  if (minor === 0) return patch >= 10
  if (minor === 1 || minor === 2) return patch >= 1
  return minor > 2
}

const quietly = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options })
  } catch {
    return null
  }
}

// The libbrotlidec an executable actually loads, as the dynamic loader
// resolves it (`ldd`), or null when that cannot be determined.
export function loadedBrotliDecoder(executable, env = process.env, run = quietly) {
  const listing = run('ldd', [executable], { env })
  const line = listing?.split('\n').find((entry) => /^\s*libbrotlidec\.so[.\d]*\s+=>\s+\//.test(entry))
  return line ? line.replace(/^.*=>\s+/, '').replace(/\s+\(0x[0-9a-f]+\)\s*$/, '') : null
}

const debianHost = {
  realpath: (file) => {
    try {
      return fs.realpathSync(file)
    } catch {
      return null
    }
  },
  owner: (file) => quietly('dpkg', ['-S', file]),
  version: (pkg) => quietly('dpkg-query', ['-W', '-f=${Version}', pkg]),
  changelog: (pkg) => {
    try {
      return gunzipSync(fs.readFileSync(path.join('/usr/share/doc', pkg, 'changelog.Debian.gz'))).toString('utf8')
    } catch {
      return null
    }
  }
}

// Distributions backport the fix without changing BrotliDecoderVersion(), so
// an affected version number is not proof of an affected library -- but it is
// not proof of a fixed one either. The library is accepted only on positive
// evidence: it belongs to exactly one dpkg package, and that package's own
// changelog names the CVE. Anything else (no dpkg, a self-built prefix, no
// changelog, no mention) is null and the caller refuses.
export function debianBrotliBackport(library, host = debianHost) {
  if (library === null) return null
  for (const file of new Set([library, host.realpath(library)].filter(Boolean))) {
    const listing = host.owner(file)
    const line = listing?.split('\n').find((entry) => entry.endsWith(`: ${file}`))
    if (!line) continue
    const owners = line.slice(0, -`: ${file}`.length).split(', ')
    if (owners.length !== 1 || owners[0].startsWith('diversion by ')) return null
    const pkg = owners[0].replace(/:[^:]+$/, '')
    if (!/^[a-z0-9][a-z0-9+.-]+$/.test(pkg)) return null
    const changelog = host.changelog(pkg)
    if (changelog === null || !changelog.includes(BROTLI_DECODER_CVE)) return null
    return {
      package: pkg,
      version: host.version(pkg)?.trim() || 'unknown',
      changelog: path.join('/usr/share/doc', pkg, 'changelog.Debian.gz')
    }
  }
  return null
}
