import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { geatscNodePlugin } from '../plugin/index.mjs'

const root = resolve(import.meta.dirname, '..')
const compilerRequire = createRequire(import.meta.resolve('@geastack/compiler/plugin'))
const ts = compilerRequire('typescript')
const compilerRoot = dirname(compilerRequire.resolve('@geastack/compiler/package.json'))
const { createCommonJsWrapperIdentity } = await import(
  pathToFileURL(resolve(compilerRoot, 'dist/semantics/commonjs-wrapper.js')).href
)
const { resolveHostMethod } = await import(pathToFileURL(resolve(compilerRoot, 'dist/semantics/host-methods.js')).href)

const capabilities = () => geatscNodePlugin().instantiate().capabilities
const compilerOptions = {
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022
}

/** Build a checker Program without writing or compiling a translation unit. */
const sourceProgram = (fileName, text, extraRoots = [], additionalSources = {}) => {
  const entry = resolve(fileName)
  const sources = new Map([
    [entry, text],
    ...Object.entries(additionalSources).map(([name, source]) => [resolve(name), source])
  ])
  const host = ts.createCompilerHost(compilerOptions, true)
  const readSourceFile = host.getSourceFile.bind(host)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    sources.has(resolve(candidate))
      ? ts.createSourceFile(resolve(candidate), sources.get(resolve(candidate)), languageVersion, true)
      : readSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
  host.readFile = (candidate) => sources.get(resolve(candidate)) ?? readFile(candidate)
  host.fileExists = (candidate) => sources.has(resolve(candidate)) || fileExists(candidate)
  host.writeFile = () => {
    throw new Error('provenance tests must not emit files')
  }
  return ts.createProgram({
    rootNames: [entry, ...extraRoots, ...[...sources.keys()].filter((name) => name !== entry)],
    options: compilerOptions,
    host
  })
}

const find = (sourceFile, predicate) => {
  let result
  const visit = (node) => {
    if (result === undefined && predicate(node)) result = node
    if (result === undefined) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.ok(result, `Expected source node was not found in ${sourceFile.fileName}`)
  return result
}

const resolvedSymbolAt = (checker, node) => {
  const symbol = checker.getSymbolAtLocation(node)
  assert.ok(symbol, `Expected a checker symbol for ${node.getText()}`)
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
}

const declarationFilesOf = (checker, node) =>
  new Set((resolvedSymbolAt(checker, node).declarations ?? []).map((declaration) => resolve(declaration.getSourceFile().fileName)))

test('Node host claims authenticate Require and Buffer by checker declaration identity', () => {
  const host = capabilities()
  const commonJs = host.commonJsGlobals.get('require')
  const bufferFile = resolve(root, 'runtime/node/buffer-types.ts')
  const wrapperFile = resolve(root, 'runtime/node/commonjs-wrapper.d.ts')
  const nodeModuleFile = compilerRequire.resolve('@types/node/module.d.ts')

  assert.deepEqual(commonJs, {
    global: 'require',
    declarationName: 'require',
    declarationFileName: wrapperFile,
    compatibleDeclarations: [{ declarationName: 'require', declarationFileName: nodeModuleFile }]
  })
  assert.deepEqual(host.typedArrayDeclarations, [{ declarationName: 'Buffer', declarationFileName: bufferFile }])
  assert.ok(
    host.hostNamespaceRootDeclarations.some(
      (declaration) => declaration.declarationName === 'Buffer' && declaration.declarationFileName === bufferFile
    )
  )
  assert.equal(host.nativeTypesByDeclaration.has('Require'), false)
  assert.equal(host.nativeTypesByDeclaration.has('Buffer'), false)
})

test('the checker admits only the canonical Require wrapper declaration set', () => {
  const host = capabilities()
  const wrapperFile = resolve(root, 'runtime/node/commonjs-wrapper.d.ts')
  const nodeModuleFile = compilerRequire.resolve('@types/node/module.d.ts')
  const fixture = resolve(root, 'apps/fastify-hello/fastify-require-provenance.fixture.ts')
  const program = sourceProgram(
    fixture,
    "type CanonicalRequire = NodeJS.Require\nrequire('fastify')\n",
    [wrapperFile, nodeModuleFile]
  )
  const sourceFile = program.getSourceFile(fixture)
  const wrapper = program.getSourceFile(wrapperFile)
  const nodeModule = program.getSourceFile(nodeModuleFile)
  assert.ok(sourceFile)
  assert.ok(wrapper)
  assert.ok(nodeModule)
  const checker = program.getTypeChecker()
  const requireCall = find(
    sourceFile,
    (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
  )
  const requireType = find(sourceFile, (node) => ts.isIdentifier(node) && node.text === 'Require')
  const identity = createCommonJsWrapperIdentity(checker, [sourceFile, wrapper, nodeModule], host.commonJsGlobals)

  assert.deepEqual(identity.classify(requireCall.expression), { kind: 'wrapper', global: 'require' })
  assert.deepEqual(declarationFilesOf(checker, requireType), new Set([resolve(wrapperFile), resolve(nodeModuleFile)]))

  const taintedFixture = resolve(root, 'apps/fastify-hello/fastify-require-tainted.fixture.ts')
  const callerDeclaration = resolve(root, 'apps/fastify-hello/fastify-require-caller.d.ts')
  const tainted = sourceProgram(
    taintedFixture,
    "require('fastify')\n",
    [wrapperFile, nodeModuleFile],
    { [callerDeclaration]: 'declare var require: (specifier: string) => unknown\n' }
  )
  const taintedSource = tainted.getSourceFile(taintedFixture)
  const taintedWrapper = tainted.getSourceFile(wrapperFile)
  const taintedNodeModule = tainted.getSourceFile(nodeModuleFile)
  assert.ok(taintedSource)
  assert.ok(taintedWrapper)
  assert.ok(taintedNodeModule)
  const taintedCall = find(
    taintedSource,
    (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
  )
  assert.deepEqual(declarationFilesOf(tainted.getTypeChecker(), taintedCall.expression), new Set([
    resolve(wrapperFile),
    resolve(nodeModuleFile),
    resolve(callerDeclaration)
  ]))
  const taintedIdentity = createCommonJsWrapperIdentity(
    tainted.getTypeChecker(),
    [taintedSource, taintedWrapper, taintedNodeModule],
    host.commonJsGlobals
  )
  assert.deepEqual(taintedIdentity.classify(taintedCall.expression), { kind: 'provenance-failure' })
})

test('Buffer member bindings reject same-named and augmented caller declarations', () => {
  const host = capabilities()
  const fixture = resolve(root, 'scripts/fastify-buffer-provenance.fixture.ts')
  const program = sourceProgram(
    fixture,
    "import type { Buffer } from '../runtime/node/buffer-types'\ndeclare const buffer: Buffer\nbuffer.toString()\n"
  )
  const sourceFile = program.getSourceFile(fixture)
  assert.ok(sourceFile)
  const canonicalAccess = find(
    sourceFile,
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'toString' && node.expression.getText() === 'buffer'
  )
  assert.deepEqual(resolveHostMethod(program.getTypeChecker(), host.hostMethodBindings, canonicalAccess), {
    protocol: 'node:Buffer',
    member: 'toString',
    inheritedDeclarations: [
      {
        declarationFileName: compilerRequire.resolve('typescript/lib/lib.es5.d.ts'),
        owner: 'Uint8Array',
        member: 'toString'
      }
    ]
  })

  const augmented = sourceProgram(
    fixture,
    "import type { Buffer } from '../runtime/node/buffer-types'\ndeclare module '../runtime/node/buffer-types' { interface Buffer { toString(marker: 'caller'): string } }\ndeclare const buffer: Buffer\nbuffer.toString()\n"
  )
  const augmentedSource = augmented.getSourceFile(fixture)
  assert.ok(augmentedSource)
  const augmentedAccess = find(
    augmentedSource,
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'toString' && node.expression.getText() === 'buffer'
  )
  assert.equal(resolveHostMethod(augmented.getTypeChecker(), host.hostMethodBindings, augmentedAccess), null)

  const lookalike = sourceProgram(
    fixture,
    "interface Buffer { toString(): string }\ndeclare const buffer: Buffer\nbuffer.toString()\n"
  )
  const lookalikeSource = lookalike.getSourceFile(fixture)
  assert.ok(lookalikeSource)
  const lookalikeAccess = find(
    lookalikeSource,
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'toString' && node.expression.getText() === 'buffer'
  )
  assert.equal(resolveHostMethod(lookalike.getTypeChecker(), host.hostMethodBindings, lookalikeAccess), null)
})

test('Fastify constructors and warnings retain their package-source declaration identities', () => {
  const host = capabilities()
  const fixture = resolve(root, 'apps/fastify-hello/fastify-package-provenance.fixture.ts')
  const program = sourceProgram(
    fixture,
    "import type { FastifyErrorConstructor } from '@fastify/error'\nimport processWarning = require('process-warning')\ntype ErrorConstructor = FastifyErrorConstructor\ntype Warning = processWarning.WarningItem\n"
  )
  const sourceFile = program.getSourceFile(fixture)
  assert.ok(sourceFile)
  const checker = program.getTypeChecker()
  const errorConstructor = find(sourceFile, (node) => ts.isIdentifier(node) && node.text === 'FastifyErrorConstructor')
  const warningItem = find(sourceFile, (node) => ts.isIdentifier(node) && node.text === 'WarningItem')

  assert.deepEqual(declarationFilesOf(checker, errorConstructor), new Set([
    resolve(root, 'apps/fastify-hello/node_modules/@fastify/error/types/index.d.ts')
  ]))
  assert.deepEqual(declarationFilesOf(checker, warningItem), new Set([
    resolve(root, 'apps/fastify-hello/node_modules/process-warning/types/index.d.ts')
  ]))
  // These are package-created callable values, not Node-owned ABI values. A
  // native-type claim here would manufacture a carrier for JavaScript source.
  for (const name of ['FastifyErrorConstructor', 'WarningItem'])
    assert.equal(host.nativeTypesByDeclaration.has(name), false)
})
