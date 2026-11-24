import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { erasedEdge, projectOptions } from './reach.mjs'

export const REQUEST_MAPPINGS = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Delete', 'DELETE'],
  ['Patch', 'PATCH'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
  ['Search', 'SEARCH'],
  ['Propfind', 'PROPFIND'],
  ['Proppatch', 'PROPPATCH'],
  ['Mkcol', 'MKCOL'],
  ['Copy', 'COPY'],
  ['Move', 'MOVE'],
  ['Lock', 'LOCK'],
  ['Unlock', 'UNLOCK'],
  ['QueryMethod', 'QUERY']
])

const LIFECYCLE_HOOKS = ['onModuleInit', 'onApplicationBootstrap', 'onModuleDestroy', 'beforeApplicationShutdown', 'onApplicationShutdown']
const PARAM_SOURCES = new Map([
  ['Param', 'param'],
  ['Query', 'query'],
  ['Body', 'body'],
  ['Headers', 'headers'],
  ['Req', 'request'],
  ['Request', 'request'],
  ['Res', 'response'],
  ['Response', 'response']
])

export class NestAnalysisError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.message}`).join('\n'))
    this.name = 'NestAnalysisError'
    this.diagnostics = diagnostics
  }
}

export const analyzeNestApplication = ({ ts, entry, options, rootNames, project, paths }) => {
  const selected = options ? { options, fileNames: rootNames ?? [], errors: [] } : projectOptions(ts, entry, project, paths)
  if (selected.errors.length > 0) throw new Error(selected.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const program = ts.createProgram({ rootNames: [entry, ...selected.fileNames], options: selected.options })
  const checker = program.getTypeChecker()
  const diagnostics = []
  const location = (node) => {
    const file = node.getSourceFile()
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart())
    return { file: file.fileName, line: line + 1, column: character + 1 }
  }
  const refuse = (node, message) => diagnostics.push({ ...location(node), message })

  const declaringPackage = (symbol) => {
    const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = resolved?.declarations?.[0]
    if (!declaration) return null
    const fileName = declaration.getSourceFile().fileName
    const match = fileName.match(/.*node_modules\/(@[^/]+\/[^/]+|[^@][^/]*)\//)
    return { name: match ? match[1] : null, resolved, fileName }
  }
  const classOfType = (type) => {
    const symbol = type.getSymbol()
    const declaration = symbol?.declarations?.find((d) => ts.isClassDeclaration(d))
    return declaration ?? null
  }
  const classOfExpression = (node) => {
    if (!ts.isIdentifier(node)) return null
    const symbol = checker.getSymbolAtLocation(node)
    const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    return resolved?.declarations?.find((d) => ts.isClassDeclaration(d)) ?? null
  }

  const nestDecorators = (node) => {
    const found = []
    for (const decorator of ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []) {
      const expression = decorator.expression
      const callee = ts.isCallExpression(expression) ? expression.expression : expression
      const origin = declaringPackage(checker.getSymbolAtLocation(callee))
      if (origin?.name !== '@nestjs/common') {
        refuse(decorator, `decorator ${callee.getText()} is not from @nestjs/common; phase 1 reads only Nest's own decorators`)
        continue
      }
      found.push({ name: origin.resolved.name, args: ts.isCallExpression(expression) ? [...expression.arguments] : [], node: decorator })
    }
    return found
  }

  const stringLiteral = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null)
  const stringOrStrings = (node, what) => {
    const single = stringLiteral(node)
    if (single !== null) return [single]
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map(stringLiteral)
      if (items.every((item) => item !== null)) return items
    }
    refuse(node, `${what} must be a string literal or an array of string literals; the AOT resolver reads it at build time`)
    return null
  }

  const classModels = new Map()
  const className = (declaration) => declaration.name?.text ?? '<anonymous class>'
  const propertyKey = (property) => (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined)
  const baseClassOf = (declaration) => {
    const extended = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (!extended) return null
    const base = classOfExpression(extended.expression)
    if (!base) refuse(extended, `${className(declaration)} extends ${extended.getText()}, which is not a class declaration the resolver can read constructor parameters from`)
    return base
  }
  const leftmostIdentifier = (name) => (ts.isQualifiedName(name) ? leftmostIdentifier(name.left) : name)
  const typeOnlyAlias = (declaration) =>
    declaration !== undefined &&
    ((ts.isImportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
      (ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
      (ts.isImportClause(declaration) && declaration.isTypeOnly) ||
      (ts.isNamespaceImport(declaration) && declaration.parent.isTypeOnly))
  const typeOnlyStar = (specifier) => {
    const from = ts.isImportSpecifier(specifier) ? specifier.parent.parent.parent.moduleSpecifier : specifier.parent.parent.moduleSpecifier
    const module = from ? checker.getSymbolAtLocation(from) : undefined
    const name = (specifier.propertyName ?? specifier.name).text
    if (!module || module.exports?.has(name) || !module.valueDeclaration || !ts.isSourceFile(module.valueDeclaration)) return undefined
    return module.valueDeclaration.statements.find((statement) => {
      if (!ts.isExportDeclaration(statement) || !statement.isTypeOnly || statement.exportClause || !statement.moduleSpecifier) return false
      const target = checker.getSymbolAtLocation(statement.moduleSpecifier)
      return target !== undefined && checker.getExportsOfModule(target).some((exported) => exported.name === name)
    })
  }
  const typeOnlyChain = (symbol) => {
    for (let current = symbol; current && (current.flags & ts.SymbolFlags.Alias) !== 0; current = checker.getImmediateAliasedSymbol(current)) {
      const declaration = current.declarations?.[0]
      if (typeOnlyAlias(declaration)) return declaration
      const star = declaration && (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) ? typeOnlyStar(declaration) : undefined
      if (star) return star
    }
    return null
  }
  const inheritedConstructors = new Set()
  const baseChain = (declaration) => {
    const chain = []
    for (let base = baseClassOf(declaration); base; base = baseClassOf(base)) {
      if (base === declaration || chain.includes(base)) {
        refuse(declaration, `${className(declaration)} has a cyclic base class chain through ${className(base)}`)
        return []
      }
      chain.push(base)
    }
    return chain
  }
  const constructorDependencies = (owner) => {
    const declaration = [owner, ...baseChain(owner)].find((c) => c.members.some((m) => ts.isConstructorDeclaration(m) && m.body))
    if (!declaration) return []
    const constructor = declaration.members.find((m) => ts.isConstructorDeclaration(m) && m.body)
    if (declaration.members.some((m) => ts.isConstructorDeclaration(m) && !m.body)) {
      refuse(constructor, `${className(declaration)} declares constructor overloads; phase 1 calls the implementation, which the public signatures may not admit`)
      return []
    }
    if (declaration !== owner && constructor.parameters.length > 0) {
      const decorators = nestDecorators(declaration)
      if (decorators.length === 0) {
        refuse(owner, `${className(owner)} inherits constructor parameters from ${className(declaration)}, which has no decorator; Nest reads them from design:paramtypes metadata and would pass undefined`)
        return []
      }
      for (const d of decorators) {
        if (d.name !== 'Injectable' || d.args.length > 0) refuse(d.node, `@${d.name}${d.args.length > 0 ? '(...)' : '()'} on base class ${className(declaration)} is not in phase 1; a base supplies constructor metadata through @Injectable() with no options`)
      }
      inheritedConstructors.add(declaration)
    }
    if (constructor.parameters.length > 0 && !program.getCompilerOptions().emitDecoratorMetadata) {
      refuse(owner, `${className(owner)} takes constructor parameters, but emitDecoratorMetadata is off; Nest reads them from design:paramtypes metadata and would pass none`)
      return []
    }
    return constructor.parameters.map((parameter) => {
      for (const decorator of nestDecorators(parameter)) {
        refuse(decorator.node, `@${decorator.name} on a constructor parameter is not in phase 1; dependencies are resolved from the parameter's class type`)
      }
      let annotation = parameter.type
      while (annotation && ts.isParenthesizedTypeNode(annotation)) annotation = annotation.type
      const annotated = annotation && ts.isTypeReferenceNode(annotation) ? leftmostIdentifier(annotation.typeName) : null
      const alias = annotated ? checker.getSymbolAtLocation(annotated) : undefined
      const typeOnly = alias ? typeOnlyChain(alias) : null
      if (typeOnly) {
        refuse(parameter, `constructor parameter ${parameter.name.getText()} of ${className(owner)} is typed through the type-only ${typeOnly === alias.declarations?.[0] ? 'import' : `re-export in ${typeOnly.getSourceFile().fileName}`} ${annotated.text}; TypeScript emits no runtime class for Nest to inject`)
        return null
      }
      const type = checker.getTypeAtLocation(parameter)
      const target = classOfType(type)
      if (!target) {
        refuse(parameter, `constructor parameter ${parameter.name.getText()} of ${className(owner)} is typed ${checker.typeToString(type)}, not a class the module provides`)
        return null
      }
      const named = annotation && ts.isTypeReferenceNode(annotation) ? checker.getSymbolAtLocation(ts.isQualifiedName(annotation.typeName) ? annotation.typeName.right : annotation.typeName) : undefined
      const memberTypeOnly = named && named !== alias && named.flags & ts.SymbolFlags.Alias ? typeOnlyChain(named) : null
      if (memberTypeOnly) {
        refuse(parameter, `constructor parameter ${parameter.name.getText()} of ${className(owner)} is typed through the type-only re-export in ${memberTypeOnly.getSourceFile().fileName} ${annotation.typeName.getText()}; TypeScript emits no runtime class for Nest to inject`)
        return null
      }
      const token = named && named.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(named) : named
      if (!token || (token.flags & ts.SymbolFlags.Class) === 0) {
        refuse(parameter, `constructor parameter ${parameter.name.getText()} of ${className(owner)} is ${parameter.type ? `annotated ${parameter.type.getText()}` : 'unannotated'}, which names no class value; TypeScript emits Object as its design:paramtypes token, not the class Nest injects`)
        return null
      }
      return { name: parameter.name.getText(), target }
    })
  }

  const controllerModel = (declaration, decorator) => {
    let prefixes = ['/']
    const [argument] = decorator.args
    if (argument !== undefined) {
      if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          const key = propertyKey(property)
          if (key === 'path' && ts.isPropertyAssignment(property)) prefixes = stringOrStrings(property.initializer, '@Controller path') ?? prefixes
          else refuse(property, `@Controller option ${key ?? property.getText()} is not in phase 1 (only path)`)
        }
      } else prefixes = stringOrStrings(argument, '@Controller prefix') ?? prefixes
    }
    for (const base of baseChain(declaration)) {
      for (const member of base.members) {
        if (ts.isMethodDeclaration(member) && nestDecorators(member).some((d) => REQUEST_MAPPINGS.has(d.name))) {
          refuse(declaration, `${className(declaration)} inherits route handler ${className(base)}.${member.name.getText()}; phase 1 registers only a controller's own handlers`)
        }
      }
    }
    const routes = []
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member)) {
        for (const d of nestDecorators(member)) refuse(d.node, `@${d.name} on a ${ts.SyntaxKind[member.kind]} is not in phase 1`)
        continue
      }
      const decorators = nestDecorators(member)
      const mappings = decorators.filter((d) => REQUEST_MAPPINGS.has(d.name))
      const methodName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name) ? member.name.text : null
      if (mappings.length > 0 && methodName === null) {
        refuse(member.name, `route handler ${member.name.getText()} has a computed or private name; phase 1 calls handlers by a static name`)
        continue
      }
      const hidden = member.modifiers?.find((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
      if (mappings.length > 0 && hidden) {
        refuse(member.name, `route handler ${className(declaration)}.${methodName} is ${hidden.getText()}; the generated application calls handlers from outside the class`)
        continue
      }
      if (mappings.length > 0 && declaration.members.filter((m) => ts.isMethodDeclaration(m) && m.name.getText() === member.name.getText()).length > 1) {
        refuse(member.name, `route handler ${className(declaration)}.${methodName} is overloaded; phase 1 classifies the reply from one signature`)
        continue
      }
      if (mappings.length > 0 && member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
        refuse(member.name, `route handler ${className(declaration)}.${methodName} is static; Nest calls handlers on the controller instance`)
        continue
      }
      if (mappings.length === 0) {
        for (const d of decorators) refuse(d.node, `@${d.name} on ${className(declaration)}.${member.name.getText()} has no request-mapping decorator`)
        for (const parameter of member.parameters) for (const d of nestDecorators(parameter)) refuse(d.node, `@${d.name} on a parameter of ${className(declaration)}.${member.name.getText()} has no request-mapping decorator`)
        continue
      }
      if (mappings.length > 1) refuse(mappings[1].node, `${className(declaration)}.${member.name.getText()} has more than one request-mapping decorator; Nest keeps one`)
      const mapping = mappings[0]
      const declaredPaths = mapping.args[0] === undefined ? ['/'] : (stringOrStrings(mapping.args[0], `@${mapping.name} path`) ?? ['/'])
      const paths = declaredPaths.length === 0 ? ['/'] : declaredPaths
      let httpCode = null
      const headers = []
      const httpCodes = decorators.filter((d) => d.name === 'HttpCode')
      if (httpCodes.length > 1) refuse(httpCodes[1].node, `${className(declaration)}.${methodName} has more than one @HttpCode; Nest keeps the topmost`)
      for (const d of decorators) {
        if (REQUEST_MAPPINGS.has(d.name)) continue
        if (d.name === 'HttpCode') {
          if (d.args.length === 1 && ts.isNumericLiteral(d.args[0])) httpCode = Number(d.args[0].text)
          else refuse(d.node, '@HttpCode takes a numeric literal in phase 1')
        } else if (d.name === 'Header') {
          const name = d.args[0] && stringLiteral(d.args[0])
          const value = d.args[1] && stringLiteral(d.args[1])
          if (name !== null && name !== undefined && value !== null && value !== undefined) headers.push({ name, value })
          else refuse(d.node, '@Header takes two string literals in phase 1')
        } else refuse(d.node, `@${d.name} on a route handler is not in phase 1`)
      }
      const params = member.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this')).map((parameter, index) => {
        const pds = nestDecorators(parameter)
        if (pds.length !== 1) {
          refuse(parameter, pds.length === 0
            ? `handler parameter ${parameter.name.getText()} has no Nest parameter decorator; Nest would pass undefined`
            : `handler parameter ${parameter.name.getText()} has ${pds.length} decorators`)
          return null
        }
        const [pd] = pds
        const source = PARAM_SOURCES.get(pd.name)
        if (source === undefined) {
          refuse(pd.node, `@${pd.name} is not in phase 1 (Param, Query, Body, Headers, Req, Res)`)
          return null
        }
        let key = null
        if (pd.args.length > 0) {
          const first = stringLiteral(pd.args[0])
          if (first === '' && pd.args.length === 1 && source !== 'request' && source !== 'response') return { index, name: parameter.name.getText(), source, key: null, type: checker.typeToString(checker.getTypeAtLocation(parameter)), typeNode: parameter.type ?? null, parameter, location: location(parameter) }
          if (first === null || pd.args.length > 1 || source === 'request' || source === 'response' || (source === 'body' && first !== null)) {
            refuse(pd.node, `@${pd.name}(${pd.args.map((a) => a.getText()).join(', ')}) is not in phase 1: ${source === 'body' ? 'only the whole body' : source === 'request' || source === 'response' ? 'no options' : 'a string literal key, no pipes'}`)
            return null
          }
          key = first
        }
        const type = checker.getTypeAtLocation(parameter)
        return { index, name: parameter.name.getText(), source, key, type: checker.typeToString(type), typeNode: parameter.type ?? null, parameter, location: location(parameter) }
      })
      const returnType = checker.getTypeAtLocation(member)
      const signature = checker.getSignaturesOfType(returnType, ts.SignatureKind.Call)[0]
      const resultType = signature ? checker.getReturnTypeOfSignature(signature) : null
      routes.push({
        method: methodName,
        access: ts.isIdentifier(member.name) ? `.${methodName}` : `[${JSON.stringify(methodName)}]`,
        verb: REQUEST_MAPPINGS.get(mapping.name),
        paths,
        httpCode,
        headers,
        params,
        resultType: resultType ? checker.typeToString(resultType) : 'unknown',
        location: location(member)
      })
    }
    const arrayIndex = (name) => /^(0|[1-9]\d*)$/.test(name) && Number(name) < 4294967295
    routes.sort((a, b) => (arrayIndex(a.method) ? (arrayIndex(b.method) ? Number(a.method) - Number(b.method) : -1) : arrayIndex(b.method) ? 1 : 0))
    return { kind: 'controller', name: className(declaration), declaration, prefixes, routes, dependencies: constructorDependencies(declaration), location: location(declaration) }
  }

  const classReferences = (node, what, localNames) => {
    if (!ts.isArrayLiteralExpression(node)) {
      refuse(node, `@Module ${what} must be an array literal of class references`)
      return []
    }
    const targets = []
    for (const element of node.elements) {
      const target = classOfExpression(element)
      if (target && targets.includes(target)) continue
      if (target) {
        targets.push(target)
        localNames?.set(target, element.getText())
      }
      else refuse(element, `@Module ${what} entry ${element.getText()} is not a class reference (dynamic modules and custom providers are not in phase 1)`)
    }
    return targets
  }

  const moduleModel = (declaration, decorator) => {
    const model = { kind: 'module', name: className(declaration), declaration, imports: [], controllers: [], providers: [], exports: [], localNames: new Map(), location: location(declaration) }
    const [argument] = decorator.args
    if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
      refuse(decorator.node, '@Module takes an object literal')
      return model
    }
    for (const property of argument.properties) {
      const key = propertyKey(property)
      if (!ts.isPropertyAssignment(property) || !['imports', 'controllers', 'providers', 'exports'].includes(key)) {
        refuse(property, `@Module option ${key ?? property.getText()} is not in phase 1`)
        continue
      }
      model[key] = classReferences(property.initializer, key, key === 'exports' ? null : model.localNames)
    }
    if (declaration.members.some((m) => ts.isConstructorDeclaration(m))) refuse(declaration, `module ${model.name} has a constructor; module injection is not in phase 1`)
    const extended = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (extended) refuse(extended, `module ${model.name} extends ${extended.expression.getText()}; phase 1 does not construct modules`)
    for (const member of declaration.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer && !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
        refuse(member, `module ${model.name} initializes instance field ${member.name.getText()}; phase 1 does not construct modules`)
      }
    }
    const configure = checker.getPropertyOfType(checker.getTypeAtLocation(declaration), 'configure')
    if (configure) refuse(configure.valueDeclaration?.name ?? declaration, `module ${model.name} declares configure(), which Nest calls to register middleware; phase 1 does not construct modules or apply middleware`)
    refuseMemberDecorators(declaration, 'modules are not injected')
    return model
  }

  const refuseMemberDecorators = (declaration, reason) => {
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member)) continue
      for (const d of nestDecorators(member)) refuse(d.node, `@${d.name} on ${className(declaration)}.${member.name?.getText() ?? ts.SyntaxKind[member.kind]} is not in phase 1; ${reason}`)
      if (ts.isMethodDeclaration(member)) for (const parameter of member.parameters) for (const d of nestDecorators(parameter)) refuse(d.node, `@${d.name} on a parameter of ${className(declaration)}.${member.name.getText()} is not in phase 1; ${reason}`)
    }
  }

  const providerModel = (declaration, decorator) => {
    if (decorator.args.length > 0) refuse(decorator.node, `@Injectable on class ${className(declaration)} takes no options in phase 1 (provider scopes are not generated)`)
    refuseMemberDecorators(declaration, 'providers are injected through the constructor')
    return { kind: 'provider', name: className(declaration), declaration, dependencies: constructorDependencies(declaration), location: location(declaration) }
  }

  const refuseLifecycleHooks = (declaration) => {
    const instance = checker.getTypeAtLocation(declaration)
    for (const hook of LIFECYCLE_HOOKS) {
      const property = checker.getPropertyOfType(instance, hook)
      if (property) refuse(property.valueDeclaration?.name ?? declaration, `${className(declaration)}.${hook} is a Nest lifecycle hook; phase 1 does not call lifecycle hooks`)
    }
  }

  const modelOf = (declaration) => {
    if (classModels.has(declaration)) return classModels.get(declaration)
    const decorators = nestDecorators(declaration)
    const kinds = decorators.filter((d) => ['Module', 'Controller', 'Injectable'].includes(d.name))
    let model
    if (kinds.length !== 1) {
      refuse(declaration, `class ${className(declaration)} is referenced by a module but carries ${kinds.length === 0 ? 'no' : 'more than one of'} @Module/@Controller/@Injectable`)
      model = { kind: 'unknown', name: className(declaration), declaration, location: location(declaration) }
    } else if (kinds[0].name === 'Module') model = moduleModel(declaration, kinds[0])
    else if (kinds[0].name === 'Controller') model = controllerModel(declaration, kinds[0])
    else model = providerModel(declaration, kinds[0])
    for (const d of decorators) if (!kinds.includes(d)) refuse(d.node, `@${d.name} on class ${className(declaration)} is not in phase 1`)
    if (!ts.isSourceFile(declaration.parent)) refuse(declaration, `class ${className(declaration)} is not declared at the top level of its file; phase 1 generates module functions at file scope`)
    if (model.kind !== 'unknown') refuseLifecycleHooks(declaration)
    classModels.set(declaration, model)
    return model
  }

  const entryFile = program.getSourceFile(entry)
  if (!entryFile) throw new Error(`entry ${entry} is not in the program`)
  const bootstraps = []
  const visit = (node) => {
    const callee = ts.isCallExpression(node) ? node.expression : undefined
    if (callee && ((ts.isPropertyAccessExpression(callee) && callee.name.text === 'create') || (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'create'))) {
      const origin = declaringPackage(checker.getSymbolAtLocation(node.expression.expression))
      if (origin?.name === '@nestjs/core' && origin.resolved.name === 'NestFactory') bootstraps.push(node)
    }
    ts.forEachChild(node, visit)
  }
  const executed = new Set()
  const pendingFiles = [entryFile]
  while (pendingFiles.length > 0) {
    const file = pendingFiles.pop()
    if (executed.has(file) || file.isDeclarationFile || file.fileName.includes('/node_modules/')) continue
    executed.add(file)
    for (const statement of file.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || statement.moduleSpecifier === undefined) continue
      if (erasedEdge(ts, statement, program.getCompilerOptions().verbatimModuleSyntax === true)) continue
      const target = checker.getSymbolAtLocation(statement.moduleSpecifier)?.valueDeclaration
      if (target && ts.isSourceFile(target)) pendingFiles.push(target)
    }
    const dynamicImports = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const target = checker.getSymbolAtLocation(specifier)?.valueDeclaration
          if (target && ts.isSourceFile(target)) pendingFiles.push(target)
        } else refuse(node, 'import() with a non-literal specifier may load a NestFactory.create bootstrap; phase 1 follows only literal module specifiers')
      }
      ts.forEachChild(node, dynamicImports)
    }
    ts.forEachChild(file, dynamicImports)
  }
  for (const file of executed) visit(file)
  if (bootstraps.length !== 1) {
    const message = `found ${bootstraps.length} NestFactory.create(...) calls; phase 1 generates one application`
    if (bootstraps.length === 0) diagnostics.push({ file: entry, line: 1, column: 1, message })
    else bootstraps.slice(1).forEach((call) => refuse(call, message))
  }
  let root = null
  const bootstrap = bootstraps[0]
  if (bootstrap) {
    if (bootstrap.typeArguments?.length) refuse(bootstrap.typeArguments[0], `NestFactory.create<${bootstrap.typeArguments.map((t) => t.getText()).join(', ')}>() has an explicit type argument; phase 1 rewrites the call to a non-generic create()`)
    const [moduleArg, adapterArg, optionsArg, ...rest] = bootstrap.arguments
    const rootDeclaration = moduleArg && classOfExpression(moduleArg)
    if (!rootDeclaration) refuse(moduleArg ?? bootstrap, 'NestFactory.create: the first argument must be a reference to a @Module class')
    else root = modelOf(rootDeclaration)
    const adapterClass = adapterArg && ts.isNewExpression(adapterArg) ? declaringPackage(checker.getSymbolAtLocation(adapterArg.expression)) : null
    if (adapterClass?.name !== '@nestjs/platform-node' || adapterClass.resolved.name !== 'NodeAdapter') {
      refuse(adapterArg ?? bootstrap, 'NestFactory.create: the second argument must be `new NodeAdapter(...)` from @nestjs/platform-node')
    } else if ((adapterArg.arguments?.length ?? 0) > 0) {
      const [adapterOptions] = adapterArg.arguments
      if (!ts.isObjectLiteralExpression(adapterOptions)) refuse(adapterOptions, 'new NodeAdapter(...) takes an object literal in phase 1')
      else for (const property of adapterOptions.properties) {
        if (ts.isPropertyAssignment(property) && propertyKey(property) === 'maxParamLength' && ts.isNumericLiteral(property.initializer)) continue
        refuse(property, `NodeAdapter option ${property.name?.getText() ?? property.getText()} is not in phase 1 (maxParamLength as a numeric literal)`)
      }
    }
    if (optionsArg !== undefined) {
      if (!ts.isObjectLiteralExpression(optionsArg)) refuse(optionsArg, 'NestFactory.create options must be an object literal in phase 1')
      else for (const property of optionsArg.properties) {
        const key = propertyKey(property)
        if (key === 'logger' && ts.isPropertyAssignment(property) && (property.initializer.kind === ts.SyntaxKind.FalseKeyword || property.initializer.kind === ts.SyntaxKind.TrueKeyword)) continue
        refuse(property, `NestFactory.create option ${key ?? property.getText()} is not in phase 1 (logger: true | false)`)
      }
    }
    for (const extra of rest) refuse(extra, 'NestFactory.create takes at most three arguments')
  }

  const modules = []
  const seen = new Set()
  const active = []
  const walkModule = (model) => {
    if (model.kind !== 'module') {
      refuse(model.declaration, `${model.name} is imported as a module but is not a @Module class`)
      return
    }
    if (active.includes(model)) {
      refuse(model.declaration, `module import cycle: ${[...active.slice(active.indexOf(model)), model].map((m) => m.name).join(' -> ')} (forwardRef is not in phase 1)`)
      return
    }
    if (seen.has(model)) return
    seen.add(model)
    active.push(model)
    model.importModels = model.imports.map(modelOf)
    model.controllerModels = model.controllers.map(modelOf)
    model.providerModels = model.providers.map(modelOf)
    model.exportModels = model.exports.map(modelOf)
    for (const c of model.controllerModels) if (c.kind !== 'controller') refuse(c.declaration, `${c.name} is listed under controllers but is not a @Controller class`)
    for (const p of model.providerModels) if (p.kind !== 'provider') refuse(p.declaration, `${p.name} is listed under providers but is not an @Injectable class`)
    for (const e of model.exportModels) {
      if (e.kind !== 'provider' && e.kind !== 'module') refuse(e.declaration, `${e.name} is exported but is neither a provider nor a module`)
      else if (!(e.kind === 'provider' ? model.providerModels : model.importModels).includes(e)) refuse(model.declaration, `${model.name} exports ${e.name}, which it neither provides nor imports as a module`)
    }
    for (const imported of model.importModels) walkModule(imported)
    active.pop()
    modules.push(model)
  }
  if (root) walkModule(root)

  const exportedProviders = (model, trail = new Set()) => {
    if (trail.has(model)) return []
    trail.add(model)
    const out = []
    for (const e of model.exportModels ?? []) {
      if (e.kind === 'provider') out.push(e)
      else if (e.kind === 'module') out.push(...exportedProviders(e, trail))
    }
    return out
  }
  for (const model of modules) {
    model.scope = new Map()
    for (const p of model.providerModels) if (p.kind === 'provider') model.scope.set(p.declaration, p)
    for (const imported of model.importModels) for (const p of exportedProviders(imported)) if (!model.scope.has(p.declaration)) model.scope.set(p.declaration, p)
    for (const consumer of [...model.providerModels, ...model.controllerModels]) {
      if (!consumer.dependencies) continue
      consumer.resolved = consumer.dependencies.map((dependency) => {
        if (dependency === null) return null
        const provider = model.scope.get(dependency.target)
        if (!provider) {
          refuse(consumer.declaration, `Nest can't resolve dependencies of ${consumer.name}: ${className(dependency.target)} is not provided in module ${model.name} (phase 1 resolves providers by class)`)
          return null
        }
        return provider
      })
    }
  }
  const order = []
  const state = new Map()
  const place = (provider, trail) => {
    const s = state.get(provider)
    if (s === 'done') return
    if (s === 'active') {
      refuse(provider.declaration, `circular dependency: ${[...trail, provider].map((p) => p.name).join(' -> ')} (forwardRef is not in phase 1)`)
      return
    }
    state.set(provider, 'active')
    for (const dependency of provider.resolved ?? []) if (dependency) place(dependency, [...trail, provider])
    state.set(provider, 'done')
    order.push(provider)
  }
  for (const model of modules) for (const p of model.providerModels) if (p.kind === 'provider') place(p, [])
  const controllers = modules.flatMap((m) => m.controllerModels.filter((c) => c.kind === 'controller'))
  for (const c of controllers) for (const dependency of c.resolved ?? []) if (dependency) place(dependency, [])

  if (diagnostics.length > 0) throw new NestAnalysisError(diagnostics)
  return { entry, program, checker, bootstrap, root, modules, providers: order, controllers, executedFiles: executed, inheritedConstructors }
}

export const describeModel = (model) => ({
  entry: model.entry,
  root: model.root.name,
  modules: model.modules.map((m) => ({
    name: m.name,
    imports: m.importModels.map((x) => x.name),
    controllers: m.controllerModels.map((x) => x.name),
    providers: m.providerModels.map((x) => x.name),
    exports: m.exportModels.map((x) => x.name)
  })),
  providers: model.providers.map((p) => ({ name: p.name, dependencies: p.resolved.map((d) => d.name), location: p.location })),
  controllers: model.controllers.map((c) => ({
    name: c.name,
    prefixes: c.prefixes,
    dependencies: c.resolved.map((d) => d.name),
    routes: c.routes.map((r) => ({ ...r, params: r.params.map(({ parameter, typeNode, ...rest }) => rest) }))
  }))
})

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ts = (await import('typescript')).default
  const entry = path.resolve(process.argv[2])
  try {
    console.log(JSON.stringify(describeModel(analyzeNestApplication({ ts, entry })), null, 2))
  } catch (error) {
    if (error instanceof NestAnalysisError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}
