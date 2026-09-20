import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { geatscNodePlugin } from '../plugin/index.mjs'
import { runtimeRootsForReachableGlobalNeeds } from './builtin-modules.mjs'

const root = resolve(import.meta.dirname, '..')
const compilerRequire = createRequire(import.meta.resolve('@geastack/compiler/plugin'))
const ts = compilerRequire('typescript')
const globalsFile = resolve(root, 'runtime/node/globals.ts')
const whatwgFacade = resolve(root, 'runtime/node/whatwg-url.ts')
const providers = [
  {
    file: globalsFile,
    names: new Set(['Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'FormData'])
  }
]

test('Fastify bare resolution reaches the URL declarations used by light-my-request', () => {
  const entry = resolve(root, 'apps/fastify-hello/server.ts')
  const reachable = runtimeRootsForReachableGlobalNeeds({
    entryFiles: [entry],
    providers,
    ts
  })

  assert.ok(reachable.imports.some((edge) => edge.from === entry && edge.specifier === 'fastify'))
  assert.ok(
    [...reachable.files].some((file) => file.endsWith('/light-my-request/lib/parse-url.js')),
    'the real Fastify runtime graph must reach light-my-request rather than stopping at its .d.ts'
  )
  assert.deepEqual([...reachable.names].filter((name) => name === 'URL' || name === 'URLSearchParams').sort(), ['URL', 'URLSearchParams'])
  assert.deepEqual([...reachable.roots], [globalsFile])
  assert.equal(reachable.files.has(globalsFile), false, 'the provider is selected from reachability, not force-loaded into the scan')
})

test('a transitive bare whatwg-url import selects its concrete global provider', () => {
  const entry = resolve(root, 'vendored-sources/mongodb/src/connection_string.ts')
  const connectionStringPackage = resolve(root, 'vendored-sources/mongodb-connection-string-url/src/index.ts')
  const reachable = runtimeRootsForReachableGlobalNeeds({
    entryFiles: [entry],
    moduleOverrides: new Map([
      ['mongodb-connection-string-url', connectionStringPackage],
      ['whatwg-url', whatwgFacade]
    ]),
    providers,
    ts
  })

  assert.ok(
    reachable.imports.some(
      (edge) => edge.from === entry && edge.specifier === 'mongodb-connection-string-url' && edge.to === connectionStringPackage
    )
  )
  assert.ok(
    reachable.imports.some((edge) => edge.from === connectionStringPackage && edge.specifier === 'whatwg-url' && edge.to === whatwgFacade)
  )
  assert.deepEqual([...reachable.roots], [globalsFile])
})

test('an app with no reachable WHATWG declaration need does not root browser globals', () => {
  const entry = resolve(root, 'apps/raw-http-hello/server.ts')
  const reachable = runtimeRootsForReachableGlobalNeeds({ entryFiles: [entry], providers, ts })
  assert.deepEqual([...reachable.roots], [])
})

test('ProcessEnv stays structural while its authenticated Process owner has a native host carrier', () => {
  const capabilities = geatscNodePlugin().instantiate().capabilities
  assert.equal(capabilities.nativeTypesByDeclaration.has('ProcessEnv'), false)
  assert.deepEqual(capabilities.nativeTypesByDeclaration.get('Process'), {
    declarationName: 'Process',
    declarationFileName: resolve(root, 'runtime/node/node-globals.ts'),
    native: 'gea::node::Process'
  })
  assert.deepEqual(capabilities.hostMembers.get('gea::node::Process.env'), {
    kind: 'property',
    emit: 'gea::node::process::env()',
    store: null
  })
})
