import fs from 'node:fs'
import path from 'node:path'

export const sourceProject = (ts, entry, project) => {
  const configFile = project ?? ts.findConfigFile(path.dirname(entry), ts.sys.fileExists)
  if (!configFile) return null
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  return { configFile, parsed: ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile)) }
}

const nodeNext = (ts) => ({ module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true })
const withPaths = (options, paths) => ({ ...options, ...(paths ? { paths: { ...options.paths, ...paths } } : {}), noEmit: true })

export const projectOptions = (ts, entry, project, paths) => {
  const selected = sourceProject(ts, entry, project)
  return {
    options: withPaths(selected ? selected.parsed.options : nodeNext(ts), paths),
    fileNames: selected ? selected.parsed.fileNames : [],
    errors: selected ? selected.parsed.errors : []
  }
}

const resolution = (ts, entry, project, paths) => {
  try {
    return projectOptions(ts, entry, project, paths).options
  } catch {
    return withPaths(nodeNext(ts), paths)
  }
}

const allTypeOnly = (elements) => elements.length > 0 && elements.every((element) => element.isTypeOnly)

export const erasedEdge = (ts, statement, verbatimModuleSyntax) => {
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return true
    return !verbatimModuleSyntax && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && allTypeOnly(statement.exportClause.elements)
  }
  const clause = statement.importClause
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  return !verbatimModuleSyntax && clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && allTypeOnly(clause.namedBindings.elements)
}

const dynamicSpecifiers = (ts, node) => {
  const found = []
  const visit = (child) => {
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0])) found.push(child.arguments[0].text)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

const valueSpecifiers = (ts, file, options) => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const declared = source.statements.flatMap((statement) => {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) return []
    if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    if (erasedEdge(ts, statement, options.verbatimModuleSyntax === true)) return []
    return [statement.moduleSpecifier.text]
  })
  return [...declared, ...dynamicSpecifiers(ts, source)]
}

export function entryReachesNestCore({ ts, entry, project, paths, options: given }) {
  const options = given ?? resolution(ts, entry, project, paths)
  const pending = [entry]
  const seen = new Set()
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of valueSpecifiers(ts, file, options)) {
      if (specifier === '@nestjs/core') return true
      const mode = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options)
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, undefined, undefined, mode).resolvedModule
      if (resolved !== undefined && !resolved.isExternalLibraryImport && !ts.isDeclarationFileName(resolved.resolvedFileName)) pending.push(resolved.resolvedFileName)
    }
  }
  return false
}
