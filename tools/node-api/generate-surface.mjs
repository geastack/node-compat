import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const nodeTypesDir = path.join(here, 'node_modules', '@types', 'node')
const nodeTypesPackage = JSON.parse(
  fs.readFileSync(path.join(nodeTypesDir, 'package.json'), 'utf8')
)
const outputPath = path.resolve(
  here,
  '..',
  '..',
  'runtime',
  'node',
  'generated',
  'node24-surface.json'
)
const runtimeNodeDir = path.resolve(here, '..', '..', 'runtime', 'node')
const facadesDir = path.join(runtimeNodeDir, 'generated', 'facades')
const ledgerPath = path.join(runtimeNodeDir, 'generated', 'node24-compatibility.json')
const checkOnly = process.argv.includes('--check')
const internalOverlayExports = new Map(
  Object.entries({
    'node:buffer': ['default'],
    'node:events': ['EventIterator'],
    'node:fs': ['FsPromises'],
    'node:http': ['Socket', 'default', 'httpMethods'],
    'node:process': ['WriteStream'],
    'node:stream': ['finishedPromise', 'pipelinePromise'],
    'node:stream/promises': ['nodeStreamPromiseFinished', 'nodeStreamPromisePipeline'],
    'node:timers': ['Timeout']
  }).map(([moduleName, names]) => [moduleName, new Set(names)])
)
const overlayPublicExportTargets = new Map([
  [
    'node:stream/promises',
    new Map([
      ['finished', 'nodeStreamPromiseFinished'],
      ['pipeline', 'nodeStreamPromisePipeline']
    ])
  ]
])
const exportEqualsBaseTargets = new Map([
  ['node:events', 'EventEmitter'],
  ['node:module', 'Module'],
  ['node:stream', 'Stream']
])

if (!nodeTypesPackage.version.startsWith('24.')) {
  throw new Error(
    `Node 24 surface generation requires @types/node 24.x, found ${nodeTypesPackage.version}`
  )
}

const probePath = path.join(here, '.node24-surface-probe.ts')
const compilerOptions = {
  lib: ['lib.es2023.d.ts'],
  noEmit: true,
  skipLibCheck: false,
  typeRoots: [path.join(here, 'node_modules', '@types')],
  types: ['node']
}
const baseHost = ts.createCompilerHost(compilerOptions)
const host = {
  ...baseHost,
  fileExists: (fileName) => fileName === probePath || baseHost.fileExists(fileName),
  readFile: (fileName) => (fileName === probePath ? '' : baseHost.readFile(fileName)),
  getSourceFile: (fileName, languageVersion) =>
    fileName === probePath
      ? ts.createSourceFile(fileName, '', languageVersion, true)
      : baseHost.getSourceFile(fileName, languageVersion)
}
const program = ts.createProgram([probePath], compilerOptions, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length > 0) {
  const rendered = diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    .join('\n')
  throw new Error(`Unable to load the pinned Node 24 declarations:\n${rendered}`)
}

const checker = program.getTypeChecker()
const probeSource = program.getSourceFile(probePath)
if (!probeSource) throw new Error('Node 24 inventory probe source was not created')

function normalizePath(fileName) {
  return path.relative(nodeTypesDir, fileName).split(path.sep).join('/')
}

function declarationKinds(symbol) {
  return [
    ...new Set((symbol.declarations ?? []).map((declaration) => ts.SyntaxKind[declaration.kind]))
  ].sort()
}

function declarationFiles(symbol) {
  return [
    ...new Set(
      (symbol.declarations ?? [])
        .map((declaration) => declaration.getSourceFile().fileName)
        .filter((fileName) => fileName.startsWith(nodeTypesDir + path.sep))
        .map(normalizePath)
    )
  ].sort()
}

function signatureStrings(symbol, kind) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return []
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const signatures = checker.getSignaturesOfType(type, kind)
  return signatures.map((signature) =>
    checker.signatureToString(
      signature,
      declaration,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    )
  )
}

function memberInventory(symbol) {
  const members = new Map()
  for (const declaration of symbol.declarations ?? []) {
    if (!('members' in declaration) || !declaration.members) continue
    for (const member of declaration.members) {
      let name = '<constructor>'
      if (!ts.isConstructorDeclaration(member)) {
        if (!member.name) continue
        name = member.name.getText()
      }
      const key = `${name}:${ts.SyntaxKind[member.kind]}:${member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}`
      const existing = members.get(key)
      if (existing) {
        existing.overloads += 1
        continue
      }
      members.set(key, {
        name,
        kind: ts.SyntaxKind[member.kind],
        scope: member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
          ? 'static'
          : 'instance',
        optional: Boolean(member.questionToken),
        overloads: 1
      })
    }
  }
  return [...members.values()].sort((left, right) =>
    `${left.scope}:${left.name}:${left.kind}`.localeCompare(
      `${right.scope}:${right.name}:${right.kind}`
    )
  )
}

function symbolInventory(exportedSymbol, exportedName = exportedSymbol.name) {
  let symbol = exportedSymbol
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  const runtime = Boolean(symbol.flags & ts.SymbolFlags.Value)
  const entry = {
    name: exportedName,
    runtime,
    kinds: declarationKinds(symbol),
    declarations: declarationFiles(symbol)
  }
  if (declaration) {
    const calls = signatureStrings(symbol, ts.SignatureKind.Call)
    const constructors = signatureStrings(symbol, ts.SignatureKind.Construct)
    const members = memberInventory(symbol)
    if (calls.length > 0) entry.callSignatures = calls
    if (constructors.length > 0) entry.constructSignatures = constructors
    if (members.length > 0) entry.members = members
  }
  return entry
}

function exportEqualsInventory(moduleSymbol) {
  const exportEquals = moduleSymbol.exports?.get('export=')
  if (!exportEquals) return []
  let target = exportEquals
  if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target)
  const declaration = target.valueDeclaration ?? target.declarations?.[0]
  if (!declaration) return []
  const type = checker.getTypeOfSymbolAtLocation(target, declaration)
  const properties = checker
    .getPropertiesOfType(type)
    .filter((property) => /^[$A-Z_a-z][$\w]*$/.test(property.name))
    .map((property) => symbolInventory(property))
    .sort((left, right) => left.name.localeCompare(right.name))
  const defaultEntry = symbolInventory(exportEquals, 'default')
  defaultEntry.runtime = true
  defaultEntry.exportEquals = true
  defaultEntry.members = properties.map((property) => ({
    name: property.name,
    kind: property.callSignatures?.length ? 'MethodSignature' : 'PropertySignature',
    scope: 'static',
    optional: false,
    overloads: Math.max(1, property.callSignatures?.length ?? 0)
  }))
  return [...properties, defaultEntry]
}

function isNodeTypesDeclaration(declaration) {
  return declaration.getSourceFile().fileName.startsWith(nodeTypesDir + path.sep)
}

function isInsideAmbientStringModule(declaration) {
  for (let current = declaration; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && current.flags & ts.NodeFlags.GlobalAugmentation)
      return false
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) return true
  }
  return false
}

const ambientModules = new Map(
  checker.getAmbientModules().map((symbol) => [symbol.name.slice(1, -1), symbol])
)
const canonicalModuleNames = [...ambientModules.keys()]
  .filter((name) => name.startsWith('node:'))
  .sort()

const modules = {}
for (const canonicalName of canonicalModuleNames) {
  const moduleSymbol = ambientModules.get(canonicalName)
  const bareName = canonicalName.slice('node:'.length)
  const aliases = ambientModules.has(bareName) ? [bareName] : []
  const exportsByName = new Map()
  for (const entry of checker.getExportsOfModule(moduleSymbol).map((symbol) => symbolInventory(symbol))) {
    exportsByName.set(entry.name, entry)
  }
  for (const entry of exportEqualsInventory(moduleSymbol)) {
    if (!exportsByName.has(entry.name)) exportsByName.set(entry.name, entry)
  }
  const exports = [...exportsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  modules[canonicalName] = {
    aliases,
    declarations: declarationFiles(moduleSymbol),
    exports
  }
}

const globalFlags =
  ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias
const globals = checker
  .getSymbolsInScope(probeSource, globalFlags)
  .filter((symbol) =>
    (symbol.declarations ?? []).some(
      (declaration) =>
        isNodeTypesDeclaration(declaration) && !isInsideAmbientStringModule(declaration)
    )
  )
  .map((symbol) => symbolInventory(symbol))
  .sort((left, right) => left.name.localeCompare(right.name))

const inventory = {
  formatVersion: 1,
  target: {
    nodeMajor: 24,
    typesPackage: '@types/node',
    typesVersion: nodeTypesPackage.version,
    typescriptVersion: ts.version
  },
  modules,
  globals
}

function relativeImport(fromFile, targetFile) {
  let relative = path.relative(path.dirname(fromFile), targetFile).split(path.sep).join('/')
  relative = relative.replace(/\.ts$/, '')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function propertyName(member) {
  if (ts.isConstructorDeclaration(member)) return '<constructor>'
  if (!member.name) return null
  return member.name.getText()
}

function discoverImplementationOverlays() {
  const overlayFiles = canonicalModuleNames
    .map((moduleName) => path.join(runtimeNodeDir, `${moduleName.slice('node:'.length)}.ts`))
    .filter((fileName) => fs.existsSync(fileName))
  const overlayProgram = ts.createProgram(overlayFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true
  })
  const overlayChecker = overlayProgram.getTypeChecker()
  const byModule = new Map()

  for (const moduleName of canonicalModuleNames) {
    const fileName = path.join(runtimeNodeDir, `${moduleName.slice('node:'.length)}.ts`)
    const sourceFile = overlayProgram.getSourceFile(fileName)
    if (!sourceFile) continue
    const moduleSymbol = overlayChecker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) continue
    const sourceText = sourceFile.text
    const exports = new Map()
    for (const exportedSymbol of overlayChecker.getExportsOfModule(moduleSymbol)) {
      let symbol = exportedSymbol
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = overlayChecker.getAliasedSymbol(symbol)
        } catch {
          symbol = exportedSymbol
        }
      }
      if (!(symbol.flags & ts.SymbolFlags.Value)) continue
      const name = exportedSymbol.name
      const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const explicitlyStubbed = new RegExp(
        `nodeNotImplemented\\(\\s*['\"]${escapedModule}['\"]\\s*,\\s*['\"]${escapedName}['\"]`
      ).test(sourceText)
      const members = new Map()
      const memberDeclarations = []
      const collectMemberDeclarations = (declaration, seen = new Set()) => {
        if (!declaration || seen.has(declaration)) return
        seen.add(declaration)
        memberDeclarations.push(declaration)
        if (!('heritageClauses' in declaration) || !declaration.heritageClauses) return
        for (const clause of declaration.heritageClauses) {
          for (const heritageType of clause.types) {
            let baseSymbol = overlayChecker.getSymbolAtLocation(heritageType.expression)
            if (baseSymbol?.flags & ts.SymbolFlags.Alias) {
              try { baseSymbol = overlayChecker.getAliasedSymbol(baseSymbol) } catch {}
            }
            for (const baseDeclaration of baseSymbol?.declarations ?? []) collectMemberDeclarations(baseDeclaration, seen)
          }
        }
      }
      for (const declaration of symbol.declarations ?? []) collectMemberDeclarations(declaration)
      for (const declaration of memberDeclarations.reverse()) {
        if (!('members' in declaration) || !declaration.members) continue
        for (const member of declaration.members) {
          const memberName = propertyName(member)
          if (memberName) members.set(memberName, ts.SyntaxKind[member.kind])
        }
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      const type = declaration
        ? overlayChecker.getTypeOfSymbolAtLocation(symbol, declaration)
        : undefined
      const supportedCallSignatures = type
        ? overlayChecker
            .getSignaturesOfType(type, ts.SignatureKind.Call)
            .map((signature) => overlayChecker.signatureToString(signature, declaration))
        : []
      const supportedConstructSignatures = type
        ? overlayChecker
            .getSignaturesOfType(type, ts.SignatureKind.Construct)
            .map((signature) => overlayChecker.signatureToString(signature, declaration))
        : []
      exports.set(name, {
        explicitlyStubbed,
        members,
        supportedCallSignatures,
        supportedConstructSignatures
      })
    }
    byModule.set(moduleName, { fileName, exports })
  }
  return byModule
}

const overlays = discoverImplementationOverlays()

for (const [moduleName, overlay] of overlays) {
  const declaredRuntimeExports = new Set(
    modules[moduleName].exports.filter((entry) => entry.runtime).map((entry) => entry.name)
  )
  const allowedInternal = internalOverlayExports.get(moduleName) ?? new Set()
  for (const name of overlay.exports.keys()) {
    if (declaredRuntimeExports.has(name) || allowedInternal.has(name)) continue
    throw new Error(
      `Unknown runtime overlay registration ${moduleName}.${name}; add it to the pinned declaration surface or explicitly classify it as internal`
    )
  }
}

function runtimeKind(entry) {
  if (entry.constructSignatures?.length || entry.kinds.includes('ClassDeclaration')) return 'class'
  if (entry.callSignatures?.length || entry.kinds.includes('FunctionDeclaration')) return 'function'
  return 'value'
}

function registeredOverlayMember(registration, inventoryName) {
  if (!registration) return undefined
  const direct = registration.members.get(inventoryName)
  if (direct !== undefined) return direct
  const qualifiedComputed = /^\[[^.]+\.(.+)\]$/.exec(inventoryName)
  return qualifiedComputed ? registration.members.get(`[${qualifiedComputed[1]}]`) : undefined
}

function renderFacade(moduleName, module) {
  const facadePath = path.join(facadesDir, `${moduleName.slice('node:'.length)}.ts`)
  const overlay = overlays.get(moduleName)
  const runtimeEntries = module.exports.filter((entry) => entry.runtime)
  const exportEqualsEntry = runtimeEntries.find((entry) => entry.exportEquals)
  const ordinaryRuntimeEntries = runtimeEntries.filter((entry) => !entry.exportEquals)
  const implemented = []
  const stubbed = []
  for (const entry of ordinaryRuntimeEntries) {
    const registration = overlay?.exports.get(entry.name)
    if (registration && !registration.explicitlyStubbed) implemented.push(entry)
    else stubbed.push(entry)
  }

  const needsNotImplemented = stubbed.some((entry) => runtimeKind(entry) !== 'value')
  const lines = [
    '// Generated from the pinned Node 24 declaration inventory. Do not edit.',
    `// Canonical builtin: ${moduleName}`
  ]
  if (needsNotImplemented) {
    lines.push(`import { nodeNotImplemented } from ${JSON.stringify(relativeImport(facadePath, path.join(runtimeNodeDir, 'not-implemented.ts')))}`)
  }
  if (implemented.length > 0 && overlay) {
    const publicTargets = overlayPublicExportTargets.get(moduleName)
    const named = implemented
      .filter((entry) => entry.name !== 'default')
      .map((entry) => {
        const target = publicTargets?.get(entry.name)
        return target ? `${target} as ${entry.name}` : entry.name
      })
    if (named.length > 0) {
      const overlayImport = JSON.stringify(relativeImport(facadePath, overlay.fileName))
      if (exportEqualsEntry) {
        lines.push(`import { ${named.join(', ')} } from ${overlayImport}`)
        lines.push(`export { ${named.join(', ')} }`)
      } else {
        lines.push(`export { ${named.join(', ')} } from ${overlayImport}`)
      }
    }
    if (implemented.some((entry) => entry.name === 'default')) {
      lines.push(`export { default } from ${JSON.stringify(relativeImport(facadePath, overlay.fileName))}`)
    }
  }
  if (implemented.length > 0 || needsNotImplemented) lines.push('')

  for (const entry of stubbed) {
    const kind = runtimeKind(entry)
    if (entry.name === 'default') {
      lines.push('const __node24Default: unknown = undefined', 'export default __node24Default', '')
    } else if (kind === 'class') {
      lines.push(
        `export class ${entry.name} {`,
        '  constructor(...args: unknown[]) {',
        '    void args',
        `    nodeNotImplemented(${JSON.stringify(moduleName)}, ${JSON.stringify(entry.name)})`,
        '  }',
        '}',
        ''
      )
    } else if (kind === 'function') {
      lines.push(
        `export function ${entry.name}(...args: unknown[]): never {`,
        '  void args',
        `  return nodeNotImplemented(${JSON.stringify(moduleName)}, ${JSON.stringify(entry.name)})`,
        '}',
        ''
      )
    } else {
      lines.push(`export const ${entry.name}: unknown = undefined`, '')
    }
  }
  if (exportEqualsEntry) {
    const baseTarget = exportEqualsBaseTargets.get(moduleName)
    const baseExpression = baseTarget && implemented.some((entry) => entry.name === baseTarget) ? baseTarget : '{}'
    lines.push(
      '// `export =` is a genuinely dynamic CommonJS namespace boundary. Keep',
      '// string-keyed assignments so C/C++ platform macros cannot rewrite Node',
      '// constant names while the generated module is being compiled.',
      `const __node24Default: any = ${baseExpression}`
    )
    for (const member of exportEqualsEntry.members ?? []) {
      lines.push(`__node24Default[${JSON.stringify(member.name)}] = ${member.name}`)
    }
    lines.push('export default __node24Default', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

const facades = new Map(
  Object.entries(modules).map(([moduleName, module]) => [
    path.join(facadesDir, `${moduleName.slice('node:'.length)}.ts`),
    renderFacade(moduleName, module)
  ])
)

const ledger = {
  formatVersion: 1,
  target: inventory.target,
  statusVocabulary: ['conformant', 'partial', 'stubbed', 'plugin'],
  modules: Object.fromEntries(
    Object.entries(modules).map(([moduleName, module]) => {
      const overlay = overlays.get(moduleName)
      return [
        moduleName,
        {
          aliases: module.aliases,
          declarationExports: module.exports.map((entry) => entry.name),
          runtimeExports: module.exports
            .filter((entry) => entry.runtime)
            .map((entry) => {
              const registration = overlay?.exports.get(entry.name)
              const status = entry.exportEquals
                ? 'partial'
                : registration && !registration.explicitlyStubbed
                  ? 'partial'
                  : 'stubbed'
              const result = {
                name: entry.name,
                kind: runtimeKind(entry),
                status
              }
              if (entry.exportEquals) result.composition = 'generated-export-equals'
              if (status === 'partial') {
                if (overlay) {
                  result.overlay = path.relative(runtimeNodeDir, overlay.fileName).split(path.sep).join('/')
                }
                if (registration?.supportedCallSignatures.length) {
                  result.supportedCallSignatures = registration.supportedCallSignatures
                }
                if (registration?.supportedConstructSignatures.length) {
                  result.supportedConstructSignatures = registration.supportedConstructSignatures
                }
              }
              if (entry.members?.length) {
                result.members = entry.members.map((member) => {
                  const memberRegistration = entry.exportEquals
                    ? overlay?.exports.get(member.name)
                    : registration
                  const overlayMemberKind = entry.exportEquals
                    ? undefined
                    : registeredOverlayMember(memberRegistration, member.name)
                  const memberStatus =
                    memberRegistration &&
                    !memberRegistration.explicitlyStubbed &&
                    (entry.exportEquals || overlayMemberKind !== undefined)
                      ? 'partial'
                      : 'stubbed'
                  const memberResult = {
                    name: member.name,
                    kind: member.kind,
                    scope: member.scope,
                    status: memberStatus
                  }
                  if (!entry.exportEquals && memberStatus === 'partial') {
                    memberResult.overlayKind = overlayMemberKind
                  }
                  return memberResult
                })
              }
              return result
            })
        }
      ]
    })
  )
}
const rendered = `${JSON.stringify(inventory, null, 2)}\n`
const renderedLedger = `${JSON.stringify(ledger, null, 2)}\n`

function checkGeneratedFile(fileName, expected, label) {
  if (!fs.existsSync(fileName)) throw new Error(`Missing generated ${label}: ${fileName}`)
  if (fs.readFileSync(fileName, 'utf8') !== expected) {
    throw new Error(`Generated ${label} is stale. Run: npm run generate`)
  }
}

if (checkOnly) {
  checkGeneratedFile(outputPath, rendered, 'Node 24 surface')
  checkGeneratedFile(ledgerPath, renderedLedger, 'Node 24 compatibility ledger')
  for (const [fileName, source] of facades) checkGeneratedFile(fileName, source, 'Node 24 facade')
  const expectedFacadePaths = new Set(facades.keys())
  if (fs.existsSync(facadesDir)) {
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fileName = path.join(dir, entry.name)
        if (entry.isDirectory()) visit(fileName)
        else if (entry.name.endsWith('.ts') && !expectedFacadePaths.has(fileName)) {
          throw new Error(`Unknown generated Node 24 facade: ${fileName}`)
        }
      }
    }
    visit(facadesDir)
  }
  process.stdout.write(
    `Node 24 surface and facades are current: ${Object.keys(modules).length} modules, ${globals.length} globals\n`
  )
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, rendered)
  fs.mkdirSync(facadesDir, { recursive: true })
  for (const [fileName, source] of facades) {
    fs.mkdirSync(path.dirname(fileName), { recursive: true })
    fs.writeFileSync(fileName, source)
  }
  fs.writeFileSync(ledgerPath, renderedLedger)
  process.stdout.write(
    `Generated Node 24 surface, facades, and ledger: ${Object.keys(modules).length} modules, ${globals.length} globals\n`
  )
}
