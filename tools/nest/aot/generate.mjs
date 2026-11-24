import { STATUS_CODES } from 'node:http'
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
  const addLeading = (p) => (p && p[0] !== '/' && !p.startsWith('{/') ? `/${p}` : p)
  let path = ''
  if (prefix) path = stripEnd(path) + addLeading(prefix)
  if (methodPath) path = stripEnd(path) + addLeading(methodPath)
  path = addLeading(path || '/')
  return path !== '/' ? stripEnd(path) : path
}

const MAX_PATH_VARIANTS = 256
const unnamedWildcard = (path) => /\*(?![A-Za-z_$])|\(\.\*\)|\/\+/.test(path)
const ID_START = /^[$_\p{ID_Start}]$/u
const ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u
const routeTokens = (path) => {
  const chars = [...path]
  let index = 0
  const fail = (message) => {
    throw new Error(`${message}: ${path}`)
  }
  const consumeUntil = (end) => {
    const output = []
    let text = ''
    const writeText = () => {
      if (text) output.push({ type: 'text', value: text })
      text = ''
    }
    while (index < chars.length) {
      const value = chars[index++]
      if (value === end) {
        writeText()
        return output
      }
      if (value === '\\') {
        if (index === chars.length) fail(`Unexpected end after \\ at index ${index}`)
        text += chars[index++]
        continue
      }
      if (value === ':' || value === '*') {
        let name = ''
        if (index < chars.length && ID_START.test(chars[index])) {
          do name += chars[index++]
          while (index < chars.length && ID_CONTINUE.test(chars[index]))
        } else if (index < chars.length && chars[index] === '"') {
          let quoteStart = index
          while (index < chars.length) {
            if (chars[++index] === '"') {
              index++
              quoteStart = 0
              break
            }
            if (chars[index] === '\\') index++
            if (index < chars.length) name += chars[index]
          }
          if (quoteStart) fail(`Unterminated quote at index ${quoteStart}`)
        }
        if (!name) fail(`Missing parameter name at index ${index}`)
        writeText()
        output.push({ type: value === ':' ? 'param' : 'wildcard', name })
        continue
      }
      if (value === '{') {
        writeText()
        output.push({ type: 'group', tokens: consumeUntil('}') })
        continue
      }
      if ('}()[]+?!'.includes(value)) fail(`Unexpected ${value} at index ${index - 1}`)
      text += value
    }
    if (end) fail(`Unexpected end at index ${index}, expected ${end}`)
    writeText()
    return output
  }
  return consumeUntil('')
}
const tokenVariants = (tokens) => {
  const at = tokens.findIndex((token) => token.type === 'group')
  if (at === -1) return [tokens]
  const before = tokens.slice(0, at)
  const rest = tokenVariants(tokens.slice(at + 1))
  const inner = tokenVariants(tokens[at].tokens)
  return [...rest.map((tail) => [...before, ...tail]), ...inner.flatMap((group) => rest.map((tail) => [...before, ...group, ...tail]))]
}
const tokenVariantCount = (tokens) =>
  tokens.reduce((count, token) => (token.type === 'group' ? Math.min(MAX_PATH_VARIANTS + 1, count * (1 + tokenVariantCount(token.tokens))) : count), 1)
const routeText = (tokens) =>
  tokens
    .map((token) => (token.type === 'text' ? token.value.replace(/[\\:*{}()[\]+?!]/g, '\\$&') : (token.type === 'param' ? ':' : '*') + ([...token.name].every((c, i) => (i === 0 ? ID_START : ID_CONTINUE).test(c)) ? token.name : JSON.stringify(token.name))))
    .join('')
const adjacentCaptures = (tokens) => tokens.some((token, i) => token.type !== 'text' && tokens[i + 1] !== undefined && tokens[i + 1].type !== 'text')
const routeKey = (tokens) => tokens.map((token) => (token.type === 'text' ? token.value.replace(/[\\:*{}]/g, '\\$&') : token.type === 'param' ? ':' : '*')).join('')
const routeParameters = (path) => ({
  names: [...path.matchAll(/(?<!\\):([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  wildcard: path.includes('*')
})

const topLevelUnion = (text) => {
  const members = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++
    else if ((c === '>' && text[i - 1] !== '=') || c === ')' || c === ']' || c === '}') depth--
    else if (depth === 0 && text.startsWith(' | ', i)) {
      members.push(text.slice(start, i))
      start = i + 3
    }
  }
  members.push(text.slice(start))
  return members.map((member) => member.trim())
}
const typeSet = (text) => new Set(topLevelUnion(text))
const sameTypeSet = (text, expected) => {
  const actual = typeSet(text)
  return actual.size === expected.length && expected.every((t) => actual.has(t))
}

const TYPED_ARRAYS = new Set(['Int8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'])
const VIEW_NAMES = new Set(['Buffer', 'Uint8Array', 'DataView', ...TYPED_ARRAYS])
const resultReply = ({ ts, checker, type, refuse, node, strictNullChecks, manual }) => {
  const thenable = (t) => checker.getAwaitedType(t) !== t
  const derivesFromView = (t) => {
    const target = t.target ?? t
    if ((target.flags & ts.TypeFlags.Object) === 0 || (target.objectFlags & ts.ObjectFlags.ClassOrInterface) === 0) return false
    return checker.getBaseTypes(target).some((base) => VIEW_NAMES.has((base.target ?? base).getSymbol()?.getName()) || derivesFromView(base))
  }
  const promiseClass = (t) => {
    const target = t.target ?? t
    if (target.getSymbol()?.getName() === 'Promise' && target.getSymbol().getDeclarations()?.every((d) => d.getSourceFile().isDeclarationFile)) return true
    return (target.flags & ts.TypeFlags.Object) !== 0 && (target.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0 && checker.getBaseTypes(target).some(promiseClass)
  }
  const async = !type.isUnion() && thenable(type) && promiseClass(type)
  if (manual) {
    const promise = checker.resolveName('Promise', node, ts.SymbolFlags.Type, false)
    const admitsPromise = (t) => thenable(t) || (promise !== undefined && checker.isTypeAssignableTo(checker.getDeclaredTypeOfSymbol(promise), t))
    if (!async && (type.isUnion() ? type.types : [type]).some(admitsPromise)) {
      refuse(node, `result type ${checker.typeToString(type)} of a manual @Res() handler may be a Promise or other thenable; phase 1 catches a rejection only from a declared Promise`)
      return null
    }
    return { kind: 'manual', async, optional: !strictNullChecks }
  }
  const fulfilledValue = (t) => {
    const then = checker.getPropertyOfType(t, 'then')
    const [signature] = then ? checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(then, node), ts.SignatureKind.Call) : []
    const callback = signature?.parameters[0] ? checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(signature.parameters[0], node)) : undefined
    const [handler] = callback ? checker.getSignaturesOfType(callback, ts.SignatureKind.Call) : []
    return handler?.parameters[0] ? checker.getTypeOfSymbolAtLocation(handler.parameters[0], node) : undefined
  }
  const fulfilled = async ? fulfilledValue(type) : undefined
  if (fulfilled === undefined ? async : thenable(fulfilled)) {
    refuse(node, `result type ${checker.typeToString(type)} resolves through a nested Promise; phase 1 replies from the value of one Promise`)
    return null
  }
  const view = checker.resolveName('Uint8Array', node, ts.SymbolFlags.Type, false)
  const admitted = [checker.getStringType(), checker.getNumberType(), checker.getBooleanType(), ...(view ? [checker.getDeclaredTypeOfSymbol(view)] : [])]
  const inner = async ? checker.getAwaitedType(type) : type
  const parts = inner.isUnion() ? inner.types : [inner]
  const nullish = (t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0
  const present = parts.filter((t) => !nullish(t))
  const optional = present.length !== parts.length || !strictNullChecks
  const returnsValue = (body) => {
    let found = false
    const visit = (child) => {
      if (found || ts.isFunctionLike(child) || ts.isClassLike(child)) return
      if (ts.isReturnStatement(child) && child.expression && !ts.isVoidExpression(child.expression) && !(ts.isIdentifier(child.expression) && child.expression.text === 'undefined')) found = true
      else ts.forEachChild(child, visit)
    }
    if (body) ts.forEachChild(body, visit)
    return found
  }
  if (present.length === 0 && parts.some((t) => (t.flags & ts.TypeFlags.Void) !== 0) && returnsValue(node.body)) {
    refuse(node, `result type ${checker.typeToString(type)} is void, but the handler returns a value, which Nest would send; phase 1 replies from the declared type`)
    return null
  }
  if (present.length === 0) return { kind: 'empty', async, optional: false }
  const kinds = new Set(
    present.map((t) => {
      if (t.flags & (ts.TypeFlags.StringLike)) return 'text'
      if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike)) return 'string-text'
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'any'
      if (thenable(t)) return 'unsupported'
      if (t.flags & ts.TypeFlags.Object) {
        const name = t.getSymbol()?.getName()
        if (name === 'Buffer' || name === 'Uint8Array') return 'bytes'
        if (TYPED_ARRAYS.has(name)) return 'view-bytes'
        if (derivesFromView(t)) return 'unsupported'
        if (name === 'StreamableFile' || name === 'Observable' || name === 'DataView') return 'unsupported'
        if (admitted.some((value) => checker.isTypeAssignableTo(value, t))) return 'structural'
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
  if (kind === 'structural') {
    refuse(node, `result type ${checker.typeToString(type)} also admits strings, numbers, booleans or typed arrays, which Nest replies by their runtime value; phase 1 replies from the declared type`)
    return null
  }
  if (kind === 'unsupported') {
    refuse(node, `result type ${checker.typeToString(type)} is not in phase 1 (string, number, boolean, void, an object, a Buffer or typed array, or a Promise of one)`)
    return null
  }
  return { kind, async, optional }
}

export const generateNestApplication = ({ ts, entry, options, rootNames, project, paths }) => {
  const model = analyzeNestApplication({ ts, entry, options, rootNames, project, paths })
  const { checker, program } = model
  const compilerOptions = program.getCompilerOptions()
  const strictNullChecks = compilerOptions.strictNullChecks ?? compilerOptions.strict ?? false
  const absent = strictNullChecks ? ['undefined'] : []
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
  for (const base of model.inheritedConstructors) consume(base)
  for (const file of model.executedFiles) {
    const visit = (node) => {
      if (ts.isDecorator(node) && !consumed.has(node)) refuse(node, `decorator ${node.expression.getText()} is outside the module graph NestFactory.create reaches; phase 1 strips only the decorators it resolved`)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  const importSpecifierOf = (file, localName) => {
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
      for (const element of statement.importClause.namedBindings.elements) {
        if (element.name.text === localName) return { specifier: statement.moduleSpecifier.text, moduleSpecifier: statement.moduleSpecifier, exported: (element.propertyName ?? element.name).text }
      }
    }
    return null
  }
  const projectFiles = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes('/node_modules/'))
  const boundInProject = (name) => projectFiles.some((file) => checker.resolveName(name, file, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias, false) !== undefined)
  const keys = new Map()
  const takenKeys = new Set(['__proto__'])
  const keyOf = (model) => {
    if (!keys.has(model)) {
      const base = /^[A-Za-z_$][\w$]*$/.test(model.name) ? model.name : 'Anonymous'
      let key = base
      for (let n = 2; takenKeys.has(key) || boundInProject(`__nestAot_${key}`); n++) key = `${base}${n}`
      takenKeys.add(key)
      keys.set(model, key)
    }
    return keys.get(model)
  }
  const functionName = (module) => `__nestAot_${keyOf(module)}`
  const functionReference = (file, module, referencingNode, localName) => {
    const declaringFile = module.declaration.getSourceFile()
    if (declaringFile === file) return functionName(module)
    const imported = importSpecifierOf(file, localName)
    if (!imported) {
      refuse(referencingNode, `${localName} is not imported into ${file.fileName} by name; phase 1 finds the generated module function through the same import`)
      return functionName(module)
    }
    if (checker.getSymbolAtLocation(imported.moduleSpecifier)?.valueDeclaration !== declaringFile) {
      refuse(referencingNode, `${module.name} is imported from ${imported.specifier}, which is not the file declaring it (${declaringFile.fileName}); phase 1 does not follow re-exports`)
    }
    append(file.fileName, `import { ${functionName(module)} } from ${JSON.stringify(imported.specifier)}`)
    return functionName(module)
  }

  const shadowedReturnType = new Set()
  const globalReturnType = (node) => {
    const file = node.getSourceFile()
    const symbol = checker.resolveName('ReturnType', node, ts.SymbolFlags.Type, false)
    if (shadowedReturnType.has(file.fileName) || !symbol?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) return
    shadowedReturnType.add(file.fileName)
    refuse(node, `ReturnType is declared in ${symbol.declarations[0].getSourceFile().fileName}; phase 1 types generated module functions with the global ReturnType`)
  }
  const registeredRoutes = new Map()

  const importedCount = new Map()
  for (const module of model.modules) for (const imported of module.importModels) importedCount.set(imported, (importedCount.get(imported) ?? 0) + 1)
  for (const [module, count] of importedCount) if (count > 1) refuse(module.declaration, `${module.name} is imported by ${count} modules; phase 1 instantiates a module once per importer, Nest once`)

  const typeImported = new Set()
  const typeAliases = new Map()
  const typeAliasesOf = (file) => {
    if (!typeAliases.has(file.fileName)) {
      const bound = (name) => checker.resolveName(name, file, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias, false) !== undefined
      const allocate = (base) => {
        let name = base
        for (let n = 2; bound(name); n++) name = `${base}${n}`
        return name
      }
      typeAliases.set(file.fileName, { application: allocate('__NestAotApplication'), request: allocate('__NestAotRequest'), response: allocate('__NestAotResponse') })
    }
    return typeAliases.get(file.fileName)
  }
  for (const module of model.modules) {
    const file = module.declaration.getSourceFile()
    const aliases = typeAliasesOf(file)
    const lines = []
    const own = model.providers.filter((p) => module.providerModels.includes(p))
    const controllers = module.controllerModels.filter((c) => c.kind === 'controller')
    const localName = (declared) => module.localNames.get(declared.declaration)
    const names = new Set(['req', 'res', 'value', 'result', 'error', ...[...own, ...controllers].map(localName)])
    const uniqueName = (base) => {
      let name = base
      let n = 2
      while (names.has(name)) name = `${base}${n++}`
      names.add(name)
      return name
    }
    for (const imported of module.importModels) names.add(localName(imported))
    const appName = uniqueName('app')
    const providerExpression = new Map()
    const providerType = new Map()
    const importBinding = new Map()
    const fromImport = (imported, provider) => {
      const { variable, reference } = importBinding.get(imported)
      return { expression: `${variable}.${keyOf(provider)}`, type: `ReturnType<typeof ${reference}>[${JSON.stringify(keyOf(provider))}]` }
    }
    for (const imported of module.importModels) {
      const variable = uniqueName(`$${lowerFirst(localName(imported))}`)
      const reference = functionReference(file, imported, module.declaration, localName(imported))
      names.add(reference)
      lines.push(`  const ${variable} = ${reference}(${appName})`)
      importBinding.set(imported, { variable, reference })
      for (const { provider } of exportEdgesOf(imported)) {
        if (providerExpression.has(provider)) continue
        const { expression, type } = fromImport(imported, provider)
        providerExpression.set(provider, expression)
        providerType.set(provider, type)
      }
    }
    for (const provider of own) {
      const variable = uniqueName(`$${lowerFirst(localName(provider))}`)
      const args = provider.resolved.map((d) => providerExpression.get(d) ?? `/* unresolved ${d.name} */ undefined`)
      lines.push(`  const ${variable} = new ${localName(provider)}(${args.join(', ')})`)
      providerExpression.set(provider, variable)
      providerType.set(provider, localName(provider))
    }
    const constructed = controllers.map((controller) => {
      const variable = uniqueName(`$${lowerFirst(localName(controller))}`)
      const args = controller.resolved.map((d) => providerExpression.get(d) ?? `/* unresolved ${d.name} */ undefined`)
      lines.push(`  const ${variable} = new ${localName(controller)}(${args.join(', ')})`)
      return { controller, variable }
    })
    for (const { controller, variable } of constructed) {
      for (const route of controller.routes) {
        const handler = uniqueName(`${variable}Route`)
        lines.push(`  const ${handler} = ${variable}${route.access}`)
        lines.push(...routeLines({ module, controller, variable, handler, route, appName, aliases }))
      }
    }
    if (exportEdgesOf(module).some(({ via }) => via !== null)) globalReturnType(module.declaration)
    for (const { provider, via } of exportEdgesOf(module)) {
      if (via === null && provider.declaration.typeParameters?.length) refuse(provider.declaration, `exported provider ${provider.name} is generic; phase 1 types a module's exports by their class name`)
    }
    const exported = exportEdgesOf(module).map(({ provider, via }) => ({ key: keyOf(provider), ...(via === null ? { expression: providerExpression.get(provider), type: providerType.get(provider) } : fromImport(via, provider)) }))
    lines.push(`  return { ${exported.map((e) => `${e.key}: ${e.expression}`).join(', ')} }`)
    const returnType = `{ ${exported.map((e) => `${e.key}: ${e.type}`).join('; ')} }`
    const header = typeImported.has(file.fileName)
      ? []
      : [
          `import type { NestApplication as ${aliases.application} } from '@nestjs/core'`,
          `import type { NodeRequest as ${aliases.request}, NodeResponse as ${aliases.response} } from '@nestjs/platform-node'`
        ]
    typeImported.add(file.fileName)
    append(
      file.fileName,
      [
        `// Generated by tools/nest/aot (geastack) from this file's Nest decorators: what @nestjs/core resolves at bootstrap, resolved at build time.`,
        ...header,
        `export function ${functionName(module)}(${appName}: ${aliases.application}): ${returnType} {`,
        ...lines,
        `}`
      ].join('\n')
    )
  }

  function exportEdgesOf(module) {
    const edges = []
    const seen = new Set()
    const add = (provider, via) => {
      if (seen.has(provider)) return
      seen.add(provider)
      edges.push({ provider, via })
    }
    for (const e of module.exportModels) if (e.kind === 'provider') add(e, null)
    for (const imported of module.importModels) if (module.exportModels.includes(imported)) for (const { provider } of exportEdgesOf(imported)) add(provider, imported)
    return edges
  }

  function routeLines({ module, controller, variable, handler, route, appName, aliases }) {
    const out = []
    const paths = controller.prefixes.flatMap((prefix) => route.paths.map((methodPath) => joinRoute(prefix, methodPath)))
    const methodNode = controller.declaration.members.find((m) => ts.isMethodDeclaration(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isNumericLiteral(m.name)) && m.name.text === route.method)
    const tokensOf = new Map()
    for (const path of paths) {
      if (unnamedWildcard(path)) {
        refuse(methodNode, `route ${path} has an unnamed wildcard; name it ({*path}) as Nest's legacy route converter would`)
        return out
      }
      try {
        tokensOf.set(path, routeTokens(path))
      } catch (error) {
        refuse(methodNode, `route ${path} does not parse as a path-to-regexp pattern (${error.message}); the router would throw at startup`)
        return out
      }
    }
    const expanded = paths.find((path) => tokenVariantCount(tokensOf.get(path)) > MAX_PATH_VARIANTS)
    if (expanded) {
      refuse(methodNode, `route ${expanded} expands to more than ${MAX_PATH_VARIANTS} optional-group variants; path-to-regexp refuses it as too many path combinations`)
      return out
    }
    for (const path of paths) {
      const adjacent = tokenVariants(tokensOf.get(path)).find(adjacentCaptures)
      if (!adjacent) continue
      refuse(methodNode, `route ${path} has the variant ${routeText(adjacent)} with two captures and no text between them; the router would throw at startup`)
      return out
    }
    for (const path of paths) {
      const keys = tokenVariants(tokensOf.get(path)).map((variant) => `${route.verb} ${routeKey(variant)}`)
      const first = keys.map((key) => registeredRoutes.get(key)).find((registered) => registered && registered.module !== module)
      for (const key of keys) if (!registeredRoutes.has(key)) registeredRoutes.set(key, { module, controller })
      if (first) refuse(methodNode, `${route.verb} ${path} of ${controller.name} in module ${module.name} matches a route of ${first.controller.name} in module ${first.module.name}; Nest registers an importing module's routes first, phase 1 registers an imported module's routes first`)
    }
    const reply = resultReply({ ts, checker, type: checker.getTypeAtLocation(methodNode).getCallSignatures()[0].getReturnType(), refuse, node: methodNode, strictNullChecks, manual: route.params.some((param) => param.source === 'response') })
    if (!reply) return out
    const contentType = route.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value
    const mediaType = contentType?.split(';')[0].trim().toLowerCase()
    const labelledJson = mediaType === undefined || mediaType.startsWith('application/json') || mediaType.endsWith('+json')
    if (reply.kind === 'json' && !labelledJson && !route.params.some((param) => param.source === 'response') && (route.httpCode ?? (route.verb === 'POST' ? 201 : 200)) < 400) {
      const returned = checker.getAwaitedType(checker.getTypeAtLocation(methodNode).getCallSignatures()[0].getReturnType())
      if (returned && (returned.isUnion() ? returned.types : [returned]).some((part) => checker.getPropertyOfType(part, 'statusCode'))) {
        refuse(methodNode, `result type ${checker.typeToString(returned)} has a statusCode, which Nest checks at runtime to replace the ${contentType} Content-Type with JSON; phase 1 replies from the declared type`)
      }
    }
    const replyGlobals = reply.kind === 'json' ? ((route.httpCode ?? (route.verb === 'POST' ? 201 : 200)) >= 400 ? ['JSON', 'Error'] : ['JSON']) : reply.kind === 'string-text' ? ['String'] : reply.kind === 'view-bytes' ? ['Uint8Array'] : []
    for (const global of replyGlobals) {
      const symbol = checker.resolveName(global, module.declaration, ts.SymbolFlags.Value, false)
      if (symbol?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) refuse(methodNode, `${global} is declared in ${symbol.declarations[0].getSourceFile().fileName}; phase 1 serializes replies with the global ${global}`)
    }
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
            if (routeParameters(path).wildcard) {
              refuse(param.parameter, `route ${path} has a wildcard; @Param on a wildcard route is not in phase 1`)
              continue
            }
            const whole = tokenVariants(tokensOf.get(path)).length === 1
            for (const variant of tokenVariants(tokensOf.get(path))) {
              if (variant.some((token) => token.type === 'param' && token.name === param.key)) continue
              refuse(param.parameter, whole ? `route ${path} has no :${param.key} parameter; Nest would pass undefined` : `route ${path} has no :${param.key} parameter in its variant ${routeText(variant)}; Nest would pass undefined`)
            }
          }
          expected(['string'], 'a route parameter is a string')
          return `${appName}.param(req, ${JSON.stringify(param.key)})`
        }
        case 'query':
          if (param.key === null) {
            if (!sameTypeSet(param.type, ['ParsedQuery']) && !sameTypeSet(param.type, ['Record<string, string | string[]>'])) expected(['Record<string, string | string[]>'], 'the parsed query is a Record<string, string | string[]>')
            return 'req.query'
          }
          expected(['string', 'string[]', ...absent], 'a query value is string | string[] | undefined (absent, one, or repeated)')
          return `${appName}.query(req, ${JSON.stringify(param.key)})`
        case 'body':
          expected(['unknown'], 'the parsed body is unknown until the handler narrows it')
          return 'req.body'
        case 'headers':
          if (param.key === null) {
            expected(['Record<string, string | undefined>'], "the headers are a Record<string, string | undefined>; Node's IncomingHttpHeaders types set-cookie as a string[], the compiled runtime joins repeated values into one string")
            return 'req.headers'
          }
          if (param.key.toLowerCase() === 'set-cookie') {
            refuse(param.parameter, `@Headers('${param.key}') is not in phase 1; Node supplies set-cookie as a string[], the compiled runtime joins repeated values into one string`)
            return 'undefined'
          }
          expected(['string', ...absent], 'a header is string | undefined')
          return `req.headers[${JSON.stringify(param.key.toLowerCase())}]`
        case 'request':
          expected(['NodeRequest'], 'the request is a NodeRequest (import it from @nestjs/platform-node)')
          return 'req'
        case 'response':
          handled = true
          if (!sameTypeSet(param.type, ['NodeResponse<NodeRequest>'])) expected(['NodeResponse'], 'the response is a NodeResponse (import it from @nestjs/platform-node)')
          return 'res'
        default:
          refuse(param.parameter, `parameter source ${param.source} is not in phase 1`)
          return 'undefined'
      }
    })
    const status = route.httpCode ?? (route.verb === 'POST' ? 201 : 200)
    const call = `${handler}.call(${[variable, ...args].join(', ')})`
    const replyLines = (resultExpression) => {
      if (handled) return [`      ${resultExpression}`]
      const send = (expression) => {
        switch (reply.kind) {
          case 'text':
            return `${appName}.text(res, ${expression}, ${status})`
          case 'string-text':
            return `${appName}.text(res, String(${expression}), ${status})`
          case 'json':
            if (status >= 400) {
              const json = `${appName}.json(res, JSON.stringify(${expression} instanceof Error ? ${JSON.stringify({ statusCode: status, message: STATUS_CODES[status] ?? 'Error' })} : ${expression}) ?? '', ${status})`
              return labelledJson ? json : `{ ${appName}.header(res, 'Content-Type', 'application/json; charset=utf-8'); ${json} }`
            }
            return `${appName}.json(res, JSON.stringify(${expression}) ?? '', ${status})`
          case 'bytes':
          case 'view-bytes': {
            const bytes = `${appName}.bytes(res, ${reply.kind === 'bytes' ? expression : `new Uint8Array(${expression}.buffer, ${expression}.byteOffset, ${expression}.byteLength)`}, ${status})`
            return status >= 400 && !labelledJson ? `{ ${appName}.header(res, 'Content-Type', 'application/json; charset=utf-8'); ${bytes} }` : bytes
          }
          default:
            return `${appName}.empty(res, ${status})`
        }
      }
      if (reply.kind === 'empty') return [`      ${resultExpression}`, `      ${send('undefined')}`]
      if (!reply.optional && (reply.kind === 'view-bytes' || (reply.kind === 'json' && status >= 400))) return [`      const result = ${resultExpression}`, `      ${send('result')}`]
      if (!reply.optional) return [`      ${send(resultExpression)}`]
      return [`      const result = ${resultExpression}`, `      if (result === undefined || result === null) ${appName}.empty(res, ${status})`, `      else ${send('result')}`]
    }
    for (const path of paths) {
      out.push(`  ${appName}.route(${JSON.stringify(route.verb)}, ${JSON.stringify(path)}, (req: ${aliases.request}, res: ${aliases.response}) => {`)
      for (const header of route.headers.toReversed()) out.push(`    ${appName}.header(res, ${JSON.stringify(header.name)}, ${JSON.stringify(header.value)})`)
      if (handled) out.push(`    ${appName}.status(res, ${status})`)
      if (reply.async) {
        if (strictNullChecks) out.push(`    ${call}`)
        else out.push(`    const pending = ${call}`, `    if (pending === undefined || pending === null) ${handled ? 'return' : `${appName}.empty(res, ${status})`}`, `    else pending`)
        out.push(`      .then((${handled || reply.kind === 'empty' ? '' : 'value'}) => {`)
        out.push(...(handled ? [] : reply.kind === 'empty' ? [`      ${appName}.empty(res, ${status})`] : replyLines('value')))
        out.push(`      })`)
        out.push(`      .catch((error: unknown) => ${appName}.fail(res, error))`)
      } else {
        out.push(`    try {`)
        out.push(...replyLines(call))
        out.push(`    } catch (error) {`)
        out.push(`      ${appName}.fail(res, error)`)
        out.push(`    }`)
      }
      out.push(`  })`)
    }
    return out
  }

  const entryFile = model.bootstrap.getSourceFile()
  const moduleArgument = model.bootstrap.arguments[0]
  let reference = functionReference(entryFile, model.root, moduleArgument, moduleArgument.getText())
  const generatedNames = new Set(model.modules.map(functionName))
  const visibleAtBootstrap = (name) => generatedNames.has(name) || checker.resolveName(name, moduleArgument, ts.SymbolFlags.Value, false) !== undefined
  const rootInEntry = model.root.declaration.getSourceFile() === entryFile
  const bootstrapImport = rootInEntry ? null : importSpecifierOf(entryFile, moduleArgument.getText())
  if ((rootInEntry || bootstrapImport) && checker.resolveName(reference, moduleArgument, ts.SymbolFlags.Value, false) !== undefined) {
    let alias = `${reference}_2`
    for (let n = 3; visibleAtBootstrap(alias); n++) alias = `${reference}_${n}`
    if (rootInEntry) globalReturnType(moduleArgument)
    if (rootInEntry) append(entryFile.fileName, `function ${alias}(app: ${typeAliasesOf(entryFile).application}): ReturnType<typeof ${reference}> {\n  return ${reference}(app)\n}`)
    else append(entryFile.fileName, `import { ${reference} as ${alias} } from ${JSON.stringify(bootstrapImport.specifier)}`)
    reference = alias
  }
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
