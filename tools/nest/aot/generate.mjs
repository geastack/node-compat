import { analyzeNestApplication, NestAnalysisError } from './analyze.mjs'

const BLANK_PATTERN = /[^\n]/g

const blankRanges = (text, ranges) => {
  let out = text
  for (const [start, end] of ranges) out = out.slice(0, start) + out.slice(start, end).replace(BLANK_PATTERN, ' ') + out.slice(end)
  return out
}

const lowerFirst = (name) => name.charAt(0).toLowerCase() + name.slice(1)

const joinRoute = (prefix, methodPath) => {
  const stripEnd = (p) => (p && p[p.length - 1] === '/' ? p.slice(0, -1) : p)
  const addLeading = (p) => (p && p[0] !== '/' ? `/${p}` : p)
  let path = ''
  if (prefix) path = stripEnd(path) + addLeading(prefix)
  if (methodPath) path = stripEnd(path) + addLeading(methodPath)
  path = addLeading(path || '/')
  return path !== '/' ? stripEnd(path) : path
}

const routeParameters = (path) => ({
  names: [...path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  wildcard: path.includes('*')
})

const typeSet = (text) => new Set(text.split(' | ').map((s) => s.trim()))
const sameTypeSet = (text, expected) => {
  const actual = typeSet(text)
  return actual.size === expected.length && expected.every((t) => actual.has(t))
}

const resultReply = ({ ts, checker, type, refuse, node }) => {
  let inner = type
  let async = false
  const symbolName = type.getSymbol()?.getName()
  if (symbolName === 'Promise' && checker.getTypeArguments(type).length === 1) {
    async = true
    inner = checker.getTypeArguments(type)[0]
  }
  const parts = inner.isUnion() ? inner.types : [inner]
  const nullish = (t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0
  const present = parts.filter((t) => !nullish(t))
  const optional = present.length !== parts.length
  if (present.length === 0) return { kind: 'empty', async, optional: false }
  const kinds = new Set(
    present.map((t) => {
      if (t.flags & (ts.TypeFlags.StringLike)) return 'text'
      if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike)) return 'string-text'
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'any'
      if (t.flags & ts.TypeFlags.Object) {
        const name = t.getSymbol()?.getName()
        if (name === 'Buffer' || name === 'Uint8Array' || name === 'Uint8ClampedArray' || name === 'Int8Array' || name === 'DataView') return 'bytes'
        if (name === 'StreamableFile' || name === 'Observable') return 'unsupported'
        return 'json'
      }
      return 'unsupported'
    })
  )
  if (kinds.size !== 1) {
    refuse(node, `result type ${checker.typeToString(type)} mixes reply kinds (${[...kinds].join(', ')}); phase 1 replies one kind per route`)
    return null
  }
  const [kind] = kinds
  if (kind === 'any') {
    refuse(node, `result type ${checker.typeToString(type)} is not declared; the reply is chosen from the declared type at build time`)
    return null
  }
  if (kind === 'unsupported') {
    refuse(node, `result type ${checker.typeToString(type)} is not in phase 1 (string, number, boolean, void, an object, a Buffer, or a Promise of one)`)
    return null
  }
  return { kind, async, optional }
}

export const generateNestApplication = ({ ts, entry, options }) => {
  const model = analyzeNestApplication({ ts, entry, options })
  const { checker, program } = model
  const diagnostics = []
  const location = (node) => {
    const file = node.getSourceFile()
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart())
    return { file: file.fileName, line: line + 1, column: character + 1 }
  }
  const refuse = (node, message) => diagnostics.push({ ...location(node), message })

  const blanks = new Map()
  const blank = (node) => {
    const fileName = node.getSourceFile().fileName
    if (!blanks.has(fileName)) blanks.set(fileName, [])
    blanks.get(fileName).push([node.getStart(), node.getEnd()])
  }
  const appends = new Map()
  const append = (fileName, text) => {
    if (!appends.has(fileName)) appends.set(fileName, [])
    appends.get(fileName).push(text)
  }
  const replacements = new Map()

  const consumed = new Set()
  const consume = (node) => {
    for (const decorator of ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []) {
      consumed.add(decorator)
      blank(decorator)
    }
  }
  const consumeClass = (declaration) => {
    consume(declaration)
    for (const member of declaration.members) {
      consume(member)
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) consume(parameter)
    }
  }
  for (const module of model.modules) consumeClass(module.declaration)
  for (const provider of model.providers) consumeClass(provider.declaration)
  for (const controller of model.controllers) consumeClass(controller.declaration)
  for (const file of program.getSourceFiles()) {
    if (file.fileName.includes('/node_modules/') || file.isDeclarationFile) continue
    const visit = (node) => {
      if (ts.isDecorator(node) && !consumed.has(node)) refuse(node, `decorator ${node.expression.getText()} is outside the module graph NestFactory.create reaches; phase 1 strips only the decorators it resolved`)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  const importSpecifierOf = (file, name) => {
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
      for (const element of statement.importClause.namedBindings.elements) {
        if (element.name.text === name) return { specifier: statement.moduleSpecifier.text, exported: (element.propertyName ?? element.name).text }
      }
    }
    return null
  }
  const functionName = (module) => `__nestAot_${module.name}`
  const functionReference = (file, module, referencingNode) => {
    const declaringFile = module.declaration.getSourceFile()
    if (declaringFile === file) return functionName(module)
    const imported = importSpecifierOf(file, module.name)
    if (!imported) {
      refuse(referencingNode, `${module.name} is not imported into ${file.fileName} by name; phase 1 finds the generated module function through the same import`)
      return functionName(module)
    }
    const resolved = ts.resolveModuleName(imported.specifier, file.fileName, program.getCompilerOptions(), ts.sys).resolvedModule
    if (!resolved || resolved.resolvedFileName !== declaringFile.fileName) {
      refuse(referencingNode, `${module.name} is imported from ${imported.specifier}, which is not the file declaring it (${declaringFile.fileName}); phase 1 does not follow re-exports`)
    }
    append(file.fileName, `import { ${functionName(module)} } from ${JSON.stringify(imported.specifier)}`)
    return functionName(module)
  }

  const importedCount = new Map()
  for (const module of model.modules) for (const imported of module.importModels) importedCount.set(imported, (importedCount.get(imported) ?? 0) + 1)
  for (const [module, count] of importedCount) if (count > 1) refuse(module.declaration, `${module.name} is imported by ${count} modules; phase 1 instantiates a module once per importer, Nest once`)

  for (const module of model.modules) {
    const file = module.declaration.getSourceFile()
    const lines = []
    const names = new Set()
    const uniqueName = (base) => {
      let name = base
      let n = 2
      while (names.has(name)) name = `${base}${n++}`
      names.add(name)
      return name
    }
    const providerExpression = new Map()
    for (const imported of module.importModels) {
      const variable = uniqueName(lowerFirst(imported.name))
      lines.push(`  const ${variable} = ${functionReference(file, imported, module.declaration)}(app)`)
      const exported = exportedProvidersOf(imported)
      for (const provider of exported) providerExpression.set(provider, `${variable}.${provider.name}`)
    }
    const own = model.providers.filter((p) => module.providerModels.includes(p))
    for (const provider of own) {
      const variable = uniqueName(lowerFirst(provider.name))
      const args = provider.resolved.map((d) => providerExpression.get(d) ?? `/* unresolved ${d.name} */ undefined`)
      lines.push(`  const ${variable} = new ${provider.name}(${args.join(', ')})`)
      providerExpression.set(provider, variable)
    }
    for (const controller of module.controllerModels) {
      if (controller.kind !== 'controller') continue
      const variable = uniqueName(lowerFirst(controller.name))
      const args = controller.resolved.map((d) => providerExpression.get(d) ?? `/* unresolved ${d.name} */ undefined`)
      lines.push(`  const ${variable} = new ${controller.name}(${args.join(', ')})`)
      for (const route of controller.routes) lines.push(...routeLines({ controller, variable, route }))
    }
    const returned = module.exportModels.filter((e) => e.kind === 'provider').map((p) => `${p.name}: ${providerExpression.get(p)}`)
    lines.push(`  return { ${returned.join(', ')} }`)
    const returnType = `{ ${module.exportModels.filter((e) => e.kind === 'provider').map((p) => `${p.name}: ${p.name}`).join('; ')} }`
    append(
      file.fileName,
      [
        `// Generated by tools/nest/aot (geastack) from this file's Nest decorators: what @nestjs/core resolves at bootstrap, resolved at build time.`,
        `import type { NestApplication as __NestAotApplication } from '@nestjs/core'`,
        `import type { NodeRequest as __NestAotRequest, NodeResponse as __NestAotResponse } from '@nestjs/platform-node'`,
        `export function ${functionName(module)}(app: __NestAotApplication): ${returnType} {`,
        ...lines,
        `}`
      ].join('\n')
    )
  }

  function exportedProvidersOf(module, trail = new Set()) {
    if (trail.has(module)) return []
    trail.add(module)
    const out = []
    for (const e of module.exportModels) {
      if (e.kind === 'provider') out.push(e)
      else if (e.kind === 'module') out.push(...exportedProvidersOf(e, trail))
    }
    return out
  }

  function routeLines({ controller, variable, route }) {
    const out = []
    const paths = controller.prefixes.flatMap((prefix) => route.paths.map((methodPath) => joinRoute(prefix, methodPath)))
    const methodNode = controller.declaration.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText() === route.method)
    const reply = resultReply({ ts, checker, type: checker.getTypeAtLocation(methodNode).getCallSignatures()[0].getReturnType(), refuse, node: methodNode })
    if (!reply) return out
    let handled = false
    const args = route.params.map((param) => {
      if (param === null) return 'undefined'
      const expected = (types, what) => {
        if (!sameTypeSet(param.type, types)) refuse(param.parameter, `@${param.source === 'param' ? 'Param' : param.source === 'query' ? 'Query' : param.source === 'body' ? 'Body' : param.source === 'headers' ? 'Headers' : param.source === 'request' ? 'Req' : 'Res'}${param.key === null ? '()' : `('${param.key}')`} parameter ${param.name} is typed ${param.type}; ${what}`)
      }
      switch (param.source) {
        case 'param': {
          if (param.key === null) {
            refuse(param.parameter, '@Param() without a key is not in phase 1')
            return 'undefined'
          }
          for (const path of paths) {
            const { names, wildcard } = routeParameters(path)
            if (wildcard) refuse(param.parameter, `route ${path} has a wildcard; @Param on a wildcard route is not in phase 1`)
            if (!names.includes(param.key)) refuse(param.parameter, `route ${path} has no :${param.key} parameter; Nest would pass undefined`)
          }
          expected(['string'], 'a route parameter is a string')
          return `app.param(req, ${JSON.stringify(param.key)})`
        }
        case 'query':
          if (param.key === null) {
            if (!sameTypeSet(param.type, ['ParsedQuery']) && !sameTypeSet(param.type, ['Record<string, string | string[]>'])) expected(['Record<string, string | string[]>'], 'the parsed query is a Record<string, string | string[]>')
            return 'req.query'
          }
          expected(['string', 'string[]', 'undefined'], 'a query value is string | string[] | undefined (absent, one, or repeated)')
          return `app.query(req, ${JSON.stringify(param.key)})`
        case 'body':
          expected(['unknown'], 'the parsed body is unknown until the handler narrows it')
          return 'req.body'
        case 'headers':
          if (param.key === null) {
            if (!sameTypeSet(param.type, ['IncomingHttpHeaders']) && !sameTypeSet(param.type, ['Record<string, string | undefined>'])) expected(['Record<string, string | undefined>'], 'the headers are a Record<string, string | undefined>')
            return 'req.headers'
          }
          expected(['string', 'undefined'], 'a header is string | undefined')
          return `req.headers[${JSON.stringify(param.key.toLowerCase())}]`
        case 'request':
          expected(['NodeRequest'], 'the request is a NodeRequest (import it from @nestjs/platform-node)')
          return 'req'
        case 'response':
          handled = true
          expected(['NodeResponse'], 'the response is a NodeResponse (import it from @nestjs/platform-node)')
          return 'res'
        default:
          refuse(param.parameter, `parameter source ${param.source} is not in phase 1`)
          return 'undefined'
      }
    })
    const status = route.httpCode ?? (route.verb === 'POST' ? 201 : 200)
    const call = `${variable}.${route.method}(${args.join(', ')})`
    const replyLines = (resultExpression) => {
      if (handled) return [`      ${resultExpression}`]
      const send = (expression) => {
        switch (reply.kind) {
          case 'text':
            return `app.text(res, ${expression}, ${status})`
          case 'string-text':
            return `app.text(res, String(${expression}), ${status})`
          case 'json':
            return `app.json(res, JSON.stringify(${expression}), ${status})`
          case 'bytes':
            return `app.bytes(res, ${expression}, ${status})`
          default:
            return `app.empty(res, ${status})`
        }
      }
      if (reply.kind === 'empty') return [`      ${resultExpression}`, `      ${send('undefined')}`]
      if (!reply.optional) return [`      ${send(resultExpression)}`]
      return [`      const result = ${resultExpression}`, `      if (result === undefined || result === null) app.empty(res, ${status})`, `      else ${send('result')}`]
    }
    for (const path of paths) {
      out.push(`  app.route(${JSON.stringify(route.verb)}, ${JSON.stringify(path)}, (req: __NestAotRequest, res: __NestAotResponse) => {`)
      for (const header of route.headers) out.push(`    app.header(res, ${JSON.stringify(header.name)}, ${JSON.stringify(header.value)})`)
      if (reply.async) {
        out.push(`    ${call}.then(`)
        out.push(`      (${handled || reply.kind === 'empty' ? '' : 'value'}) => {`)
        out.push(...(handled ? [] : reply.kind === 'empty' ? [`      app.empty(res, ${status})`] : replyLines('value').map((l) => l.replace(/^      const result = value$/, '      const result = value'))))
        out.push(`      },`)
        out.push(`      (error: unknown) => app.fail(res, error)`)
        out.push(`    )`)
      } else {
        out.push(`    try {`)
        out.push(...replyLines(call))
        out.push(`    } catch (error) {`)
        out.push(`      app.fail(res, error)`)
        out.push(`    }`)
      }
      out.push(`  })`)
    }
    return out
  }

  const entryFile = model.bootstrap.getSourceFile()
  const moduleArgument = model.bootstrap.arguments[0]
  const reference = functionReference(entryFile, model.root, moduleArgument)
  if (!replacements.has(entryFile.fileName)) replacements.set(entryFile.fileName, [])
  replacements.get(entryFile.fileName).push([moduleArgument.getStart(), moduleArgument.getEnd(), reference])

  if (diagnostics.length > 0) throw new NestAnalysisError(diagnostics)

  const rewrites = new Map()
  const files = new Set([...blanks.keys(), ...appends.keys(), ...replacements.keys()])
  for (const fileName of files) {
    const source = program.getSourceFile(fileName)
    let text = blankRanges(source.text, blanks.get(fileName) ?? [])
    for (const [start, end, replacement] of (replacements.get(fileName) ?? []).sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end)
    const extra = appends.get(fileName) ?? []
    if (extra.length > 0) text = `${text}\n${[...new Set(extra)].join('\n')}\n`
    rewrites.set(fileName, text)
  }
  return { rewrites, model }
}

if (process.argv[1] && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url)) {
  const ts = (await import('typescript')).default
  const path = await import('node:path')
  const entry = path.resolve(process.argv[2])
  try {
    const { rewrites } = generateNestApplication({ ts, entry })
    for (const [fileName, text] of rewrites) console.log(`==== ${fileName}\n${text}`)
  } catch (error) {
    if (error instanceof NestAnalysisError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}
