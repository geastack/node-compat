import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { geatscNodePlugin } from '@geastack/node-compat'
import { displayPathFrom } from './path-display.mjs'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

test('target package publishes publicly and exposes stable entry points', () => {
  assert.equal(manifest.publishConfig.access, 'public')
  assert.notEqual(manifest.private, true)
  assert.equal(require.resolve('@geastack/node-compat/build'), resolve(root, 'scripts/build.mjs'))
  assert.equal(manifest.peerDependenciesMeta['@geastack/compiler'].optional, true)
  assert.equal(manifest.dependencies?.['@geastack/compiler'], undefined)
  assert.equal(geatscNodePlugin().name, 'node-compat')
})

test('build output paths are relative to the application instead of the installed target package', () => {
  const installedTarget = resolve(root, 'node_modules', '@geastack', 'compiler', 'node_modules', '@geastack', 'node-compat')
  const project = resolve(root, 'tutorials', 'hello-world')
  const entry = resolve(project, 'src', 'index.ts')
  assert.match(relative(installedTarget, entry), new RegExp(`^\\.\\.${sep === '\\' ? '\\\\' : '/'}\\.\\.`))
  assert.equal(displayPathFrom(project, entry), join('src', 'index.ts'))
  assert.equal(displayPathFrom(project, resolve(project, 'dist', 'geatsc', 'hello-world')), join('dist', 'geatsc', 'hello-world'))
  assert.equal(displayPathFrom(project, installedTarget), installedTarget)
})

test('the npm archive contains the runtime and driver, and no vendored package sources', () => {
  const [archive] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8'
    })
  )
  const paths = new Set(archive.files.map((file) => file.path))
  for (const file of [
    'scripts/build.mjs',
    'scripts/builtin-modules.mjs',
    'scripts/path-display.mjs',
    'plugin/index.mjs',
    'plugin/index.mjs',
    'runtime/gea_node.cpp',
    'runtime/gea_node.hpp',
    'runtime/node/standard-library.ts'
  ])
    assert.ok(paths.has(file), `Missing ${file}`)
  // No package source ships in this archive. A checked-in copy pinned to one
  // version answered for whatever version an application had installed, and
  // went on answering after the dependency moved; the compiler now acquires
  // each dependency's typed source for the exact installed version instead.
  assert.deepEqual(
    [...paths].filter((file) => /^(apps|bench|node_modules|vendored-sources)/.test(file)),
    []
  )
  assert.equal(
    [...paths].some((file) => file.includes('/.git/')),
    false
  )
})

test('the compiler depends on the package through npm versions and the public plugin API', () => {
  const compiler = JSON.parse(readFileSync(require.resolve('@geastack/compiler/package.json'), 'utf8'))
  const dependency = compiler.dependencies['@geastack/node-compat']
  assert.match(dependency, /^\^\d+\.\d+\.\d+$/)
  const [minimumMajor, minimumMinor, minimumPatch] = dependency.slice(1).split('.').map(Number)
  const [packageMajor, packageMinor, packagePatch] = manifest.version.split('.').map(Number)
  assert.equal(packageMajor, minimumMajor)
  assert.ok(
    packageMinor > minimumMinor || (packageMinor === minimumMinor && packagePatch >= minimumPatch),
    `${manifest.version} must satisfy ${dependency}`
  )
  assert.equal(compiler.publishConfig.access, 'public')
  assert.notEqual(compiler.private, true)
  for (const name of ['@geastack/apple', '@geastack/geatsc-plugin-apple-native', '@geastack/geatsc-plugin-gea']) {
    // OPTIONAL PEERS, not dependencies. Each of these depends on the compiler,
    // so a hard dependency would close a cycle. An app that wants one installs
    // it beside the compiler and npm resolves a single copy; an app that does
    // not is never made to download a native target it will not build.
    assert.match(compiler.peerDependencies[name], /^>=\d+\.\d+\.\d+$/)
    assert.equal(compiler.peerDependenciesMeta[name].optional, true)
  }
  const declared = { ...compiler.dependencies, ...compiler.peerDependencies }
  for (const version of Object.values(declared))
    assert.ok(!version.startsWith('file:'), 'Published dependencies must not require sibling repositories')
})
