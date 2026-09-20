import fs from 'node:fs'
import path from 'node:path'
import { builtinModules as nodeBuiltinModules, createRequire } from 'node:module'

const nodeBuiltins = new Set(nodeBuiltinModules.flatMap((name) => [name, `node:${name}`]))

const internalSourceNames = new Set([
  'globals',
  'standard-library',
  'not-implemented',
  'node-globals',
  'buffer-types',
  'hono-node-server',
  'whatwg-url',
  // A script, not a module: the WHATWG stream classes in global scope. The
  // `node:stream/web` builtin is `stream/web.ts`, which re-exports them.
  'whatwg-streams',
  // A script too: the timer globals and the `Timeout` handle. The
  // `node:timers` builtin is `timers.ts`, which re-exports them.
  'global-timers'
])

function collectModules(root, skipRootDirectories = new Set()) {
  const modules = new Map()
  const walk = (directory, prefix, atRoot) => {
    if (!fs.existsSync(directory)) return
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (atRoot && skipRootDirectories.has(entry.name)) continue
        walk(path.join(directory, entry.name), `${prefix}${entry.name}/`, false)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      modules.set(`${prefix}${entry.name.slice(0, -'.ts'.length)}`, path.join(directory, entry.name))
    }
  }
  walk(root, '', true)
  return modules
}

/**
 * Resolve every Node builtin to one source file. Checked-in implementations
 * are selected explicitly over generated throwing facades; directory walk
 * order cannot change that choice.
 */
export function resolveBuiltinModules(builtinsDir, facadesDir) {
  const facades = collectModules(facadesDir)
  const implementations = collectModules(builtinsDir, new Set(['generated']))
  const names = [...new Set([...facades.keys(), ...implementations.keys()])].sort()
  const modules = new Map()
  for (const name of names) {
    if (internalSourceNames.has(name)) continue
    modules.set(name, implementations.get(name) ?? facades.get(name))
  }
  return modules
}

const isDeclarationName = (ts, node) => {
  const parent = node.parent
  if (!parent) return false
  if (parent.name === node && ts.isDeclaration(parent)) return true
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  )
}

const resolvedRuntimeModule = (specifier, importer, overrides) => {
  const overridden = overrides.get(specifier)
  if (overridden !== undefined) return path.resolve(overridden)
  if (nodeBuiltins.has(specifier)) return null
  try {
    return createRequire(importer).resolve(specifier)
  } catch {
    // TypeScript source commonly imports its sibling with the emitted `.js`
    // suffix. Node cannot resolve that source path before emission, but the
    // declaration graph can: map only that exact missing suffix back to the
    // checked-in `.ts` file.
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = path.resolve(path.dirname(importer), `${specifier.slice(0, -'.js'.length)}.ts`)
      if (fs.existsSync(source)) return source
    }
    return null
  }
}

/**
 * Find host-global declarations required by the real reachable runtime graph.
 *
 * Resolution intentionally follows Node's package entry points, including
 * CommonJS `require()` edges, instead of TypeScript's declaration preference:
 * Fastify's types resolve `light-my-request` to `types/index.d.ts`, while the
 * code that actually runs resolves to `lib/parse-url.js` and constructs both
 * URL classes. `moduleOverrides` models package implementations supplied by
 * this target (currently `whatwg-url`) before consulting installed packages.
 */
export function reachableRuntimeGlobalNeeds({ entryFiles, moduleOverrides = new Map(), names, ts }) {
  const pending = entryFiles.map((file) => path.resolve(file))
  const files = new Set()
  const imports = []
  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || files.has(file) || !fs.existsSync(file)) continue
    if (!/\.(?:[cm]?js|tsx?|d\.ts)$/.test(file)) continue
    files.add(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = resolvedRuntimeModule(imported.fileName, file, moduleOverrides)
      if (resolved === null) continue
      imports.push({ from: file, specifier: imported.fileName, to: resolved })
      pending.push(resolved)
    }
  }
  // Bind the reachable files together without resolving a second module
  // graph. An imported/local `URL` has a Symbol and needs no global provider;
  // Fastify's `new URL(...)` and the whatwg facade's global alias do not.
  const program = ts.createProgram({
    rootNames: [...files],
    options: { allowJs: true, checkJs: false, noEmit: true, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }
  })
  const checker = program.getTypeChecker()
  const required = new Set()
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (source === undefined) continue
    const visit = (node) => {
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        !isDeclarationName(ts, node) &&
        checker.getSymbolAtLocation(node) === undefined
      )
        required.add(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { files, imports, names: required }
}

/** Select declaration roots from the names their reachable consumers use. */
export function runtimeRootsForReachableGlobalNeeds({ entryFiles, moduleOverrides = new Map(), providers, ts }) {
  const names = new Set(providers.flatMap((provider) => [...provider.names]))
  const reachable = reachableRuntimeGlobalNeeds({
    entryFiles,
    moduleOverrides,
    names,
    ts
  })
  const roots = new Set(
    providers
      .filter((provider) => [...provider.names].some((name) => reachable.names.has(name)))
      .map((provider) => path.resolve(provider.file))
  )
  return { ...reachable, roots }
}
