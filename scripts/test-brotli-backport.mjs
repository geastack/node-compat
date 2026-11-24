import assert from 'node:assert/strict'
import test from 'node:test'

import { BROTLI_DECODER_CVE, brotliVersionIsPatched, debianBrotliBackport, loadedBrotliDecoder } from './native-libraries.mjs'

// The libbrotlidec acceptance rule: an affected version number is accepted only
// when the loaded library belongs to one dpkg package whose own changelog names
// the CVE. Every other answer refuses.
const library = '/usr/lib/x86_64-linux-gnu/libbrotlidec.so.1'
const real = '/usr/lib/x86_64-linux-gnu/libbrotlidec.so.1.1.0'
const patchedChangelog = `brotli (1.1.0-2ubuntu0.1) noble-security; urgency=medium

  * SECURITY UPDATE: DoS or code exec via buffer overflow
    - debian/patches/${BROTLI_DECODER_CVE}.patch: Detect and report invalid stream
    - ${BROTLI_DECODER_CVE}
`
const unpatchedChangelog = `brotli (1.1.0-2build2) noble; urgency=medium

  * No-change rebuild for CVE-2024-3094
`
const host = (overrides = {}) => ({
  realpath: (file) => (file === library ? real : file),
  owner: (file) => (file === library || file === real ? `libbrotli1:amd64: ${file}\n` : null),
  version: () => '1.1.0-2ubuntu0.1\n',
  changelog: (pkg) => (pkg === 'libbrotli1' ? patchedChangelog : null),
  ...overrides
})

test('a dpkg-owned library whose changelog names the CVE is accepted', () => {
  assert.deepEqual(debianBrotliBackport(library, host()), {
    package: 'libbrotli1',
    version: '1.1.0-2ubuntu0.1',
    changelog: '/usr/share/doc/libbrotli1/changelog.Debian.gz'
  })
})

test('the owner is looked up through the real path when the soname link is not listed', () => {
  const ownsOnlyReal = host({ owner: (file) => (file === real ? `libbrotli1:amd64: ${real}\n` : null) })
  assert.equal(debianBrotliBackport(library, ownsOnlyReal)?.package, 'libbrotli1')
})

test('a changelog without the CVE refuses', () => {
  assert.equal(debianBrotliBackport(library, host({ changelog: () => unpatchedChangelog })), null)
})

test('a package without a changelog refuses', () => {
  assert.equal(debianBrotliBackport(library, host({ changelog: () => null })), null)
})

test('a library no package owns (a self-built prefix, or no dpkg) refuses', () => {
  assert.equal(debianBrotliBackport('/home/user/brotli-1.1.0/lib/libbrotlidec.so.1', host({ owner: () => null })), null)
})

test('an unknown loaded library refuses', () => {
  assert.equal(debianBrotliBackport(null, host()), null)
})

test('a diverted or multiply-owned path refuses', () => {
  assert.equal(debianBrotliBackport(library, host({ owner: (file) => `libbrotli1:amd64, other:amd64: ${file}\n` })), null)
  assert.equal(debianBrotliBackport(library, host({ owner: (file) => `diversion by local-brotli: ${file}\n` })), null)
})

test('the loaded libbrotlidec is read from the loader listing', () => {
  const listing = `\tlinux-vdso.so.1 (0x00007ffc)\n\tlibbrotlidec.so.1 => ${library} (0x000072ca4bd36000)\n\tlibbrotlicommon.so.1 => /usr/lib/x86_64-linux-gnu/libbrotlicommon.so.1 (0x0000)\n`
  assert.equal(
    loadedBrotliDecoder('version', {}, () => listing),
    library
  )
  assert.equal(
    loadedBrotliDecoder('version', {}, () => '\tlibbrotlidec.so.1 => not found\n'),
    null
  )
  assert.equal(
    loadedBrotliDecoder('version', {}, () => null),
    null
  )
})

test('only upstream fixed releases pass the version check alone', () => {
  const version = (major, minor, patch) => (major << 24) | (minor << 12) | patch
  assert.equal(brotliVersionIsPatched(version(1, 1, 0)), false)
  assert.equal(brotliVersionIsPatched(version(1, 0, 9)), false)
  assert.equal(brotliVersionIsPatched(version(1, 0, 10)), true)
  assert.equal(brotliVersionIsPatched(version(1, 1, 1)), true)
  assert.equal(brotliVersionIsPatched(version(1, 2, 0)), false)
  assert.equal(brotliVersionIsPatched(version(1, 2, 1)), true)
})
