import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { analyzeNestApplication, NestAnalysisError } from './aot/analyze.mjs'
import { generateNestApplication } from './aot/generate.mjs'
import { entryReachesNestCore } from './aot/reach.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const nestModules = path.join(root, 'apps/hello-nest/node_modules')
assert.ok(fs.existsSync(path.join(nestModules, '@nestjs/core')), `${nestModules} has no @nestjs/core; run npm install in apps/hello-nest`)

const compilerOptions = {
  module: 'nodenext',
  moduleResolution: 'nodenext',
  target: 'ES2023',
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useDefineForClassFields: false,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  strict: true
}

const bootstrap = (module = 'AppModule', from = './app.module.ts') => `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { ${module} } from '${from}'
const app = await NestFactory.create(${module}, new NodeAdapter(), { logger: false })
await app.listen(3000)
`

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-aot-'))
let fixtures = 0
const fixture = (files, tsconfig = { compilerOptions, files: ['main.ts'] }) => {
  const dir = path.join(scratch, String(fixtures++))
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(nestModules, path.join(dir, 'node_modules'), 'dir')
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}

const diagnosticsOf = (dir) => {
  try {
    generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
    return []
  } catch (error) {
    if (error instanceof NestAnalysisError) return error.diagnostics.map((d) => d.message)
    return [error.message]
  }
}

const emittedName = (name) => name.replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs')
const runtimeNode = path.join(root, 'runtime/node')
const shimPaths = (() => {
  const paths = {}
  for (const name of ['common', 'core', 'platform-node']) paths[`@nestjs/${name}`] = [path.join(runtimeNode, `nest/shims/@nestjs/${name}/index.ts`)]
  for (const file of fs.readdirSync(runtimeNode)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
    const name = file.slice(0, -'.ts'.length)
    paths[`node:${name}`] = [path.join(runtimeNode, file)]
    paths[name] = [path.join(runtimeNode, file)]
  }
  return paths
})()

const fixtureDiagnostics = (dir, program) =>
  ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file === undefined || (d.file.fileName.startsWith(dir + path.sep) && !d.file.fileName.split(path.sep).includes('node_modules')))
    .map((d) => (d.file === undefined ? '' : `${path.basename(d.file.fileName)}: `) + ts.flattenDiagnosticMessageText(d.messageText, ' '))

const sourceTypeErrors = (dir) => {
  const fixture = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, dir)
  return fixtureDiagnostics(dir, ts.createProgram({ rootNames: [path.join(dir, 'main.ts'), ...fixture.fileNames], options: { ...fixture.options, types: ['node'], typeRoots: [path.join(nestModules, '@types')] } }))
}

const rewrittenTypeErrors = (dir, rewrites) => {
  const configFile = path.join(dir, 'tsconfig.json')
  const fixture = ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, dir)
  const options = { ...fixture.options, paths: { ...fixture.options.paths, ...shimPaths }, pathsBasePath: fixture.options.pathsBasePath ?? dir, types: [] }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile
  host.readFile = (fileName) => rewrites.get(fileName) ?? readFile(fileName)
  return fixtureDiagnostics(dir, ts.createProgram({ rootNames: [path.join(dir, 'main.ts'), ...fixture.fileNames], options, host }))
}

const driver = `import { writeFileSync } from 'node:fs'
const [modulePath, functionName, requests, resultFile] = JSON.parse(process.argv[2])
const routes = new Map()
const out = []
const reply = (res, kind, body, status) => out.push({ route: res.route, kind, status, body })
const app = {
  route: (method, path, handler) => {
    if (!routes.has(method + ' ' + path)) routes.set(method + ' ' + path, handler)
  },
  header: (res, name, value) => out.push({ route: res.route, header: [name, value] }),
  status: (res, status) => out.push({ route: res.route, status }),
  text: (res, body, status) => reply(res, 'text', body, status),
  json: (res, body, status) => reply(res, 'json', body, status),
  bytes: (res, body, status) => reply(res, 'bytes', body.constructor.name + ' ' + Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('hex'), status),
  empty: (res, status) => reply(res, 'empty', null, status),
  param: (req, key) => req.params[key],
  query: (req, key) => req.query[key],
  fail: (res, error) => reply(res, 'fail', error instanceof Error ? error.constructor.name : String(error), 500)
}
process.on('unhandledRejection', (error) => out.push({ unhandled: error instanceof Error ? error.constructor.name : String(error) }))
const module = await import(modulePath)
module[functionName](app)
for (const request of requests) {
  const { route, query = {}, headers = {} } = typeof request === 'string' ? { route: request } : request
  const handler = routes.get(route)
  if (handler === undefined) out.push({ route, missing: [...routes.keys()] })
  else handler({ params: {}, query, headers }, { route, end: () => out.push({ route, ended: true }) })
}
process.once('beforeExit', () => writeFileSync(resultFile, JSON.stringify(out)))
`

const escapeName = (name) => name.replace(/\$/g, '\\$')
const initializerOf = (main) => {
  let name = main.match(/NestFactory(?:\.create|\['create'\])\(\s*([\w$]+)/)?.[1]
  for (let seen = new Set(); name !== undefined && !seen.has(name); seen.add(name)) {
    const imported = main.match(new RegExp(`import \\{ ([\\w$]+) as ${escapeName(name)} \\} from `))?.[1]
    if (imported !== undefined) return imported
    const forwarded = main.match(new RegExp(`function ${escapeName(name)}\\([^)]*\\)[^{]*\\{\\s*return ([\\w$]+)\\(`))?.[1]
    if (forwarded === undefined) return name
    name = forwarded
  }
  return name
}

const served = (dir, requests, file = 'app.module.ts') => {
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  const typeErrors = rewrittenTypeErrors(dir, rewrites)
  if (typeErrors.length > 0) return [{ typeErrors }]
  const outDir = `${dir}-out`
  fs.mkdirSync(outDir)
  fs.symlinkSync(nestModules, path.join(outDir, 'node_modules'), 'dir')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const emitted = (target) => (target === null ? null : typeof target === 'string' ? emittedName(target) : Array.isArray(target) ? target.map(emitted) : Object.fromEntries(Object.entries(target).map(([condition, value]) => [condition, emitted(value)])))
  if (manifest.imports) manifest.imports = emitted(manifest.imports)
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(manifest))
  const projectOptions = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, dir).options
  const { verbatimModuleSyntax = false } = projectOptions
  const useDefineForClassFields = ts.getUseDefineForClassFields(projectOptions)
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!(/\.[cm]?js$/.test(name) || (path.basename(name) === 'package.json' && name !== 'package.json')) || name.split(path.sep).includes('node_modules')) continue
    fs.mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true })
    fs.copyFileSync(path.join(dir, name), path.join(outDir, name))
  }
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!/\.m?ts$/.test(name) || /\.d\.m?ts$/.test(name) || name.split(path.sep).includes('node_modules')) continue
    const fileName = path.join(dir, name)
    const text = rewrites.get(fileName) ?? fs.readFileSync(fileName, 'utf8')
    const { outputText } = ts.transpileModule(text, { fileName, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, useDefineForClassFields, rewriteRelativeImportExtensions: true, verbatimModuleSyntax } })
    fs.mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true })
    fs.writeFileSync(path.join(outDir, emittedName(name)), outputText)
  }
  fs.writeFileSync(path.join(outDir, 'driver.mjs'), driver)
  const resultFile = path.join(outDir, 'result.json')
  try {
    execFileSync(process.execPath, ['driver.mjs', JSON.stringify([`./${emittedName(file)}`, initializerOf([...rewrites.values()].find((text) => /NestFactory(?:\.create|\['create'\])\(/.test(text)) ?? ''), requests, resultFile])], {
      cwd: outDir,
      encoding: 'utf8',
      timeout: 20000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ETIMEDOUT') return [{ timedOut: error.signal }]
    if (typeof error.code === 'string') return [{ crashed: error.code }]
    if (error.signal) return [{ killed: error.signal }]
    return [{ crashed: String(error.stderr).split('\n').find((line) => /Error/.test(line)) ?? String(error.stderr) }]
  }
}

const cases = []
const test = (name, body) => cases.push({ name, body })

test('a subclass without its own constructor injects what a decorated base constructor takes, as Nest does', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'configured'
}
@Injectable()
class Base {
  constructor(readonly config: Config) {}
}
@Injectable()
export class Child extends Base {}
@Controller()
export class AppController {
  constructor(private readonly child: Child) {}
  @Get()
  name(): string {
    return this.child.config.name
  }
}
@Module({ controllers: [AppController], providers: [Config, Child] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'configured' }])
})

test('@Injectable options are refused, @Injectable() is accepted', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module, Scope } from '@nestjs/common'
@Injectable({ scope: Scope.REQUEST })
export class Service {}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ controllers: [AppController], providers: [Service] })
export class AppModule {}
`
  })
  assert.deepEqual(diagnosticsOf(dir).filter((m) => m.includes('@Injectable')), ['@Injectable on class Service takes no options in phase 1 (provider scopes are not generated)'])
})

test('a module exports only providers it registers or modules it imports', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Service {}
@Module({ exports: [Service] })
export class Feature {}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ imports: [Feature], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.ok(diagnosticsOf(dir).includes('Feature exports Service, which it neither provides nor imports as a module'))
})

test('member decorators on a provider are refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Config {}
@Injectable()
export class Service {
  @Inject(Config) config!: Config
}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ controllers: [AppController], providers: [Config, Service] })
export class AppModule {}
`
  })
  assert.ok(diagnosticsOf(dir).includes('@Inject on Service.config is not in phase 1; providers are injected through the constructor'))
})

test('a module import cycle is refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Module } from '@nestjs/common'
@Module({ imports: [AppModule] })
export class AppModule {}
`
  })
  assert.ok(diagnosticsOf(dir).includes('module import cycle: AppModule -> AppModule (forwardRef is not in phase 1)'))
})

test('a provider class named App does not shadow the app parameter', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class App {
  readonly name: string = 'app'
}
@Controller()
export class AppController {
  constructor(private readonly provided: App) {}
  @Get()
  hello(): string {
    return this.provided.name
  }
}
@Module({ controllers: [AppController], providers: [App] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'app' }])
})

test('two imports exporting the same provider class resolve to the first, as analysis does', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
let created = 0
@Injectable()
export class Service {
  readonly id: number = ++created
}
@Module({ providers: [Service], exports: [Service] })
export class Left {}
@Module({ providers: [Service], exports: [Service] })
export class Right {}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  id(): number {
    return this.service.id
  }
}
@Module({ imports: [Left, Right], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: '1' }])
})

test('aliased provider and controller imports keep their local bindings', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'service.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = 'aliased'
}
`,
    'controller.ts': `import { Controller, Get } from '@nestjs/common'
import { Service } from './service.ts'
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Service as LocalService } from './service.ts'
import { AppController as LocalController } from './controller.ts'
@Module({ controllers: [LocalController], providers: [LocalService] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'aliased' }])
})

test('a module re-exporting an imported module hands its providers on', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = 'leaf'
}
@Module({ providers: [Service], exports: [Service] })
export class Leaf {}
@Module({ imports: [Leaf], exports: [Leaf] })
export class Middle {}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
@Module({ imports: [Middle], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'leaf' }])
})

test('a quoted route method name is called through bracket access', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class AppController {
  @Get('hello')
  'hello-world'(): string {
    return 'quoted'
  }
}
@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /hello']), [{ route: 'GET /hello', kind: 'text', status: 200, body: 'quoted' }])
})

test('an async reply that fails to serialize reaches app.fail', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
interface Node {
  self?: Node
}
@Controller()
export class AppController {
  @Get()
  async cyclic(): Promise<Node> {
    const node: Node = {}
    node.self = node
    return node
  }
}
@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'fail', status: 500, body: 'TypeError' }])
})

test('a tsconfig whose extends target is missing is reported', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': `import { Module } from '@nestjs/common'\n@Module({})\nexport class AppModule {}\n` }, { extends: './missing.json', compilerOptions, files: ['main.ts'] })
  const [message] = diagnosticsOf(dir)
  assert.match(message ?? '', /missing\.json/)
})

test('a static route handler is refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class AppController {
  @Get()
  static ping(): string {
    return 'pong'
  }
}
@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  assert.ok(diagnosticsOf(dir).includes('route handler AppController.ping is static; Nest calls handlers on the controller instance'))
})

test('whole @Query() and @Headers() accept the Record types the diagnostics name', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Headers, Module, Query } from '@nestjs/common'
@Controller()
export class AppController {
  @Get()
  pair(@Query() query: Record<string, string | string[]>, @Headers() headers: Record<string, string | undefined>): string {
    return String(query['q']) + '|' + String(headers['x-probe'])
  }
}
@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, [{ route: 'GET /', query: { q: 'from-query' }, headers: { 'x-probe': 'from-headers' } }]), [{ route: 'GET /', kind: 'text', status: 200, body: 'from-query|from-headers' }])
})

const featureModule = (name) => `import { Injectable, Module } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = '${name}'
}
@Module({ providers: [Service], exports: [Service] })
export class Feature {}
`

const routedFeature = (name) => `import { Controller, Get, Module } from '@nestjs/common'
@Controller('${name}')
export class FeatureController {
  @Get()
  name(): string {
    return '${name}'
  }
}
@Module({ controllers: [FeatureController] })
export class Feature {}
`

test('two imported modules with the same class name get distinct initializers', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'left/feature.ts': featureModule('left'),
    'right/feature.ts': featureModule('right'),
    'left/routes.ts': routedFeature('left'),
    'right/routes.ts': routedFeature('right'),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { Feature as LeftFeature } from './left/feature.ts'
import { Feature as RightFeature } from './right/feature.ts'
import { Feature as LeftRoutes } from './left/routes.ts'
import { Feature as RightRoutes } from './right/routes.ts'
@Controller()
export class AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ imports: [LeftFeature, RightFeature, LeftRoutes, RightRoutes], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /', 'GET /left', 'GET /right']), [
    { route: 'GET /', kind: 'text', status: 200, body: 'hello' },
    { route: 'GET /left', kind: 'text', status: 200, body: 'left' },
    { route: 'GET /right', kind: 'text', status: 200, body: 'right' }
  ])
})

test('two exported provider classes with the same name reach their own consumers', () => {
  const service = (name) => `import { Injectable } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = '${name}'
}
`
  const dir = fixture({
    'main.ts': bootstrap(),
    'left/service.ts': service('left'),
    'right/service.ts': service('right'),
    'shared.module.ts': `import { Module } from '@nestjs/common'
import { Service as LeftService } from './left/service.ts'
import { Service as RightService } from './right/service.ts'
@Module({ providers: [LeftService, RightService], exports: [LeftService, RightService] })
export class Shared {}
`,
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { Shared } from './shared.module.ts'
import { Service as LeftService } from './left/service.ts'
import { Service as RightService } from './right/service.ts'
@Controller()
export class AppController {
  constructor(private readonly left: LeftService, private readonly right: RightService) {}
  @Get()
  names(): string {
    return this.left.name + ' ' + this.right.name
  }
}
@Module({ imports: [Shared], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'left right' }])
})

test('a re-exported provider comes from the first exported import, as Nest resolves it', () => {
  const middle = (imports, exports) => {
    const dir = fixture({
      'main.ts': bootstrap(),
      'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Service {
  owner: string = ''
}
@Module({ providers: [Service], exports: [Service] })
export class Left {}
@Module({ providers: [Service], exports: [Service] })
export class Right {}
@Module({ imports: [${imports}], exports: [${exports}] })
export class Middle {}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  @Get()
  owner(): string {
    return this.service.owner
  }
}
@Module({ imports: [Middle], controllers: [AppController] })
export class AppModule {}
`
    })
    const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
    const text = rewrites.get(path.join(dir, 'app.module.ts'))
    const returned = text.match(/function __nestAot_Middle\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)[1].match(/return \{ Service: ([\w$]+)\.Service \}/)[1]
    const variables = Object.fromEntries([...text.matchAll(/const ([\w$]+) = __nestAot_(Left|Right)\(app\)/g)].map((m) => [m[1], m[2]]))
    return variables[returned]
  }
  assert.equal(middle('Left, Right', 'Right'), 'Right')
  assert.equal(middle('Left, Right', 'Right, Left'), 'Left')
  assert.equal(middle('Right, Left', 'Left, Right'), 'Right')
})

const helloController = (route = `@Get()
  hello(): string {
    return 'hello'
  }`) => `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class AppController {
  ${route}
}
@Module({ controllers: [AppController] })
export class AppModule {}
`

test('quoted metadata keys read as their names', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { AppModule } from './app.module.ts'
const app = await NestFactory.create(AppModule, new NodeAdapter({ 'maxParamLength': 100 }), { 'logger': false })
await app.listen(3000)
`,
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller({ 'path': 'cats' })
export class AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ 'controllers': [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(diagnosticsOf(dir), [])
  assert.deepEqual(served(dir, ['GET /cats']), [{ route: 'GET /cats', kind: 'text', status: 200, body: 'hello' }])
})

test('lifecycle hooks Nest would call are refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Service {
  ready: boolean = false
  onModuleInit(): void {
    this.ready = true
  }
}
@Controller()
export class AppController {
  constructor(private readonly service: Service) {}
  onApplicationBootstrap(): void {}
  @Get()
  ready(): boolean {
    return this.service.ready
  }
}
@Module({ providers: [Service], controllers: [AppController] })
export class AppModule {
  onApplicationShutdown(): void {}
}
`
  })
  const diagnostics = diagnosticsOf(dir)
  for (const hook of ['Service.onModuleInit', 'AppController.onApplicationBootstrap', 'AppModule.onApplicationShutdown']) {
    assert.ok(diagnostics.includes(`${hook} is a Nest lifecycle hook; phase 1 does not call lifecycle hooks`), diagnostics.join('\n'))
  }
})

test('a Promise subclass reply is awaited, a bare thenable is refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': helloController(`@Get()
  hello(): Deferred {
    return new Deferred((resolve) => resolve('ok'))
  }`).replace('@Controller()', 'export class Deferred extends Promise<string> {}\n@Controller()')
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'ok' }])
  const thenable = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': helloController(`@Get()
  hello(): PromiseLike<string> {
    return Promise.resolve('ok')
  }`)
  })
  assert.ok(diagnosticsOf(thenable).some((d) => d.startsWith('result type PromiseLike<string> is not in phase 1')), diagnosticsOf(thenable).join('\n'))
})

test('a # import resolves with the importing file\'s module format', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#feature': { import: './feature.ts', require: './feature-require.ts' } } }),
    'main.ts': bootstrap(),
    'feature.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class FeatureController {
  @Get()
  hello(): string {
    return 'import'
  }
}
@Module({ controllers: [FeatureController] })
export class Feature {}
`,
    'feature-require.ts': `export class Feature {}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Feature } from '#feature'
@Module({ imports: [Feature] })
export class AppModule {}
`
  })
  assert.deepEqual(diagnosticsOf(dir), [])
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'import' }])
  const reexported = fixture({
    'main.ts': bootstrap(),
    'feature.ts': `import { Module } from '@nestjs/common'
@Module({})
export class Feature {}
`,
    'index.ts': `export { Feature } from './feature.ts'
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Feature } from './index.ts'
@Module({ imports: [Feature] })
export class AppModule {}
`
  })
  assert.ok(diagnosticsOf(reexported).some((d) => d.startsWith('Feature is imported from ./index.ts, which is not the file declaring it')), diagnosticsOf(reexported).join('\n'))
})

test('a Nest class declared inside a function is refused', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { Controller, Get, Module } from '@nestjs/common'
async function bootstrap(): Promise<void> {
  @Controller()
  class AppController {
    @Get()
    hello(): string {
      return 'hello'
    }
  }
  @Module({ controllers: [AppController] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
  await app.listen(3000)
}
await bootstrap()
`
  })
  const diagnostics = diagnosticsOf(dir)
  for (const name of ['AppController', 'AppModule']) assert.ok(diagnostics.includes(`class ${name} is not declared at the top level of its file; phase 1 generates module functions at file scope`), diagnostics.join('\n'))
})

test('private and protected route handlers are refused', () => {
  for (const modifier of ['private', 'protected']) {
    const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  ${modifier} hello(): string {
    return 'hello'
  }`) })
    assert.ok(diagnosticsOf(dir).includes(`route handler AppController.hello is ${modifier}; the generated application calls handlers from outside the class`), diagnosticsOf(dir).join('\n'))
  }
})

test('a controller inheriting a route handler is refused', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller('base')
export class BaseController {
  @Get('ping')
  ping(): string {
    return 'pong'
  }
}
@Controller('child')
export class ChildController extends BaseController {}
@Module({ controllers: [BaseController, ChildController] })
export class AppModule {}
`
  })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes('ChildController inherits route handler BaseController.ping; phase 1 registers only a controller\'s own handlers'), diagnostics.join('\n'))
})

test('more than one @HttpCode on a handler is refused', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Post()
  @HttpCode(202)
  @HttpCode(201)
  hello(): string {
    return 'hello'
  }`).replace('Get, Module', 'Get, HttpCode, Module, Post') })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes('AppController.hello has more than one @HttpCode; Nest keeps the topmost'), diagnostics.join('\n'))
})

test('a module with construction effects is refused, an empty module is accepted', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
export class Base {
  constructor() {}
}
@Controller()
export class AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({})
export class Child extends Base {}
@Module({ imports: [Child], controllers: [AppController] })
export class AppModule {
  ready: boolean = true
  declared?: string
  static readonly tag = 'app'
}
`
  })
  const diagnostics = diagnosticsOf(dir)
  for (const message of ['module AppModule initializes instance field ready; phase 1 does not construct modules', 'module Child extends Base; phase 1 does not construct modules']) assert.ok(diagnostics.includes(message), diagnostics.join('\n'))
  assert.equal(diagnostics.length, 2, diagnostics.join('\n'))
})

test('a NestFactory.create in a file the entry reaches only for types is not counted', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { AppModule } from './app.module.ts'
import type { Port } from './other.ts'
const port: Port = 3000
const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
await app.listen(port)
`,
    'other.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { AppModule } from './app.module.ts'
export type Port = number
const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
await app.listen(3001)
`,
    'app.module.ts': helloController()
  })
  assert.deepEqual(diagnosticsOf(dir), [])
  const both = fixture({
    'main.ts': `import './other.ts'
` + bootstrap(),
    'other.ts': bootstrap(),
    'app.module.ts': helloController()
  })
  assert.ok(diagnosticsOf(both).includes('found 2 NestFactory.create(...) calls; phase 1 generates one application'), diagnosticsOf(both).join('\n'))
})

test('typed-array replies go out as their bytes, a DataView is refused', () => {
  const views = { Uint16Array: 'new Uint16Array([258])', Float64Array: 'new Float64Array([1])', Int8Array: 'new Int8Array([-1])', Uint8Array: 'new Uint8Array([104, 105])' }
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class AppController {
${Object.entries(views).map(([type, value]) => `  @Get('${type}')
  ${type.toLowerCase()}(): ${type} {
    return ${value}
  }`).join('\n')}
}
@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, Object.keys(views).map((type) => `GET /${type}`)), [
    { route: 'GET /Uint16Array', kind: 'bytes', status: 200, body: `Uint8Array ${Buffer.from(new Uint16Array([258]).buffer).toString('hex')}` },
    { route: 'GET /Float64Array', kind: 'bytes', status: 200, body: `Uint8Array ${Buffer.from(new Float64Array([1]).buffer).toString('hex')}` },
    { route: 'GET /Int8Array', kind: 'bytes', status: 200, body: 'Uint8Array ff' },
    { route: 'GET /Uint8Array', kind: 'bytes', status: 200, body: 'Uint8Array 6869' }
  ])
  const dataView = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): DataView {
    return new DataView(new ArrayBuffer(2))
  }`) })
  assert.ok(diagnosticsOf(dataView).some((d) => d.startsWith('result type DataView<ArrayBufferLike> is not in phase 1')), diagnosticsOf(dataView).join('\n'))
})

test('a manual @Res() handler starts from the route status', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Post()
  @HttpCode(202)
  hello(@Res() res: NodeResponse): void {
    res.end()
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, HttpCode, Module, Post, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'") })
  assert.deepEqual(served(dir, ['POST /']), [{ route: 'POST /', status: 202 }, { route: 'POST /', ended: true }])
})

test('a bootstrap local named like the generated initializer does not shadow it', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { AppModule } from './app.module.ts'
async function bootstrap(): Promise<void> {
  const __nestAot_AppModule = (): void => {}
  __nestAot_AppModule()
  const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
  await app.listen(3000)
}
await bootstrap()
`,
    'app.module.ts': helloController()
  })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  const main = rewrites.get(path.join(dir, 'main.ts'))
  const passed = main.match(/NestFactory\.create\((\w+),/)[1]
  assert.notEqual(passed, '__nestAot_AppModule')
  assert.ok(new RegExp(`import \\{ __nestAot_AppModule as ${passed} \\} from "\\./app\\.module\\.ts"`).test(main), main)
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites), [])
})

test('a parameter decorator on an unmapped controller method is refused', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`helper(@Query('x') x: string): string {
    return x
  }
  @Get()
  hello(): string {
    return 'hello'
  }`).replace('Get, Module', 'Get, Module, Query') })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes('@Query on a parameter of AppController.helper has no request-mapping decorator'), diagnostics.join('\n'))
})

test('without strictNullChecks a nullable reply is checked before it is sent', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): string {
    return null
  }`) }, { compilerOptions: { ...compilerOptions, strict: false }, files: ['main.ts'] })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'empty', status: 200, body: null }])
})

test('an initializer name already bound in the declaring file is not reused', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController() + 'export const __nestAot_AppModule = 1\n' })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites), [])
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('a provider named like a reserved word gets a valid local', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Default {
  readonly name: string = 'default'
}
@Controller()
export class AppController {
  constructor(private readonly provider: Default) {}
  @Get()
  hello(): string {
    return this.provider.name
  }
}
@Module({ providers: [Default], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'default' }])
})

test('a required @Param inside an optional path group is refused, a plain one is accepted', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(@Param('id') id: string): string {
    return id
  }`).replace('Get, Module', 'Get, Module, Param')
  const optional = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users{/:id}') }))
  assert.ok(optional.includes('route /users{/:id} has no :id parameter in its variant /users; Nest would pass undefined'), optional.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users/:id') })), [])
})

test('a JSON reply that serializes to undefined sends an empty JSON body', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): { toJSON(): undefined } {
    return { toJSON: () => undefined }
  }`) })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'json', status: 200, body: '' }])
})

test('an unnamed legacy wildcard is refused, a named wildcard is accepted', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(): string {
    return 'hello'
  }`)
  const legacy = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('files/*') }))
  assert.ok(legacy.includes('route /files/* has an unnamed wildcard; name it ({*path}) as Nest\'s legacy route converter would'), legacy.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('files/{*path}') })), [])
})

test('response headers are set in decorator application order', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  @Header('X-Mode', 'outer')
  @Header('X-Mode', 'inner')
  hello(): string {
    return 'hello'
  }`).replace('Get, Module', 'Get, Header, Module') })
  assert.deepEqual(served(dir, ['GET /']), [
    { route: 'GET /', header: ['X-Mode', 'inner'] },
    { route: 'GET /', header: ['X-Mode', 'outer'] },
    { route: 'GET /', kind: 'text', status: 200, body: 'hello' }
  ])
})

test('an undecorated base constructor with parameters is refused, a parameterless one is accepted', () => {
  const module = (base) => `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'configured'
}
class Base {
  ${base}
}
@Injectable()
export class Child extends Base {}
@Controller()
export class AppController {
  constructor(private readonly child: Child) {}
  @Get()
  name(): string {
    return 'child'
  }
}
@Module({ controllers: [AppController], providers: [Config, Child] })
export class AppModule {}
`
  const refused = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('constructor(readonly config: Config) {}') }))
  assert.ok(refused.includes('Child inherits constructor parameters from Base, which has no decorator; Nest reads them from design:paramtypes metadata and would pass undefined'), refused.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('constructor() {}') })), [])
})

test('an escaped colon is literal text, not a @Param capture', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(@Param('id') id: string): string {
    return id
  }`).replace('Get, Module', 'Get, Module, Param')
  const escaped = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users/\\\\:id') }))
  assert.ok(escaped.includes('route /users/\\:id has no :id parameter; Nest would pass undefined'), escaped.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users/:id') })), [])
})

test('a thenable with its own catch but no Promise chain is refused', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): PromiseLike<string> & { catch: () => void } {
    return Object.assign(Promise.resolve('ok'), { catch: () => {} })
  }`) })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.some((d) => d.startsWith('result type PromiseLike<string> & { catch: () => void; } is not in phase 1')), diagnostics.join('\n'))
})

test('decorators in a file the entry reaches only for types are left alone', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { AppModule } from './app.module.ts'
import type { Port } from './other.ts'
const port: Port = 3000
const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
await app.listen(port)
`,
    'other.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { Controller, Get, Module } from '@nestjs/common'
export type Port = number
@Controller()
export class OtherController {
  @Get()
  other(): string {
    return 'other'
  }
}
@Module({ controllers: [OtherController] })
export class OtherModule {}
const app = await NestFactory.create(OtherModule, new NodeAdapter(), { logger: false })
await app.listen(3001)
`,
    'app.module.ts': helloController()
  })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual([...rewrites.keys()].map((fileName) => path.basename(fileName)).sort(), ['app.module.ts', 'main.ts'])
})

test('a provider imported under the name app does not collide with the initializer parameter', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'service.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = 'service'
}
`,
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { Service as app } from './service.ts'
@Controller()
export class AppController {
  constructor(private readonly service: app) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
@Module({ providers: [app], controllers: [AppController] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'service' }])
})

test('an entry reaches @nestjs/core through a tsconfig path alias', () => {
  const dir = fixture({
    'main.ts': `import '@app/bootstrap'
`,
    'bootstrap.ts': bootstrap()
  }, { compilerOptions: { ...compilerOptions, paths: { '@app/bootstrap': ['./bootstrap.ts'] } }, files: ['main.ts'] })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(dir, 'main.ts') }), true)
  const external = fixture({ 'main.ts': `import '@nestjs/common'
` })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(external, 'main.ts') }), false)
})

test('a decorated base supplying constructor parameters must use @Injectable() with no options', () => {
  const module = (decorator) => `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'configured'
}
${decorator}
class Base {
  constructor(readonly config: Config) {}
}
@Injectable()
export class Child extends Base {}
@Controller()
export class AppController {
  constructor(private readonly child: Child) {}
  @Get()
  name(): string {
    return this.child.config.name
  }
}
@Module({ controllers: [AppController], providers: [Config, Child] })
export class AppModule {}
`
  const refused = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('@Injectable({})') }))
  assert.ok(refused.includes('@Injectable(...) on base class Base is not in phase 1; a base supplies constructor metadata through @Injectable() with no options'), refused.join('\n'))
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('@Injectable()') }), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'configured' }])
})

test('a constructor parameter typed through a type-only import is refused', () => {
  const files = (specifier) => ({
    'main.ts': bootstrap(),
    'config.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'configured'
}
`,
    'app.controller.ts': `import { Controller, Get } from '@nestjs/common'
${specifier} from './config.ts'
@Controller()
export class AppController {
  constructor(private readonly config: Config) {}
  @Get()
  name(): string {
    return this.config.name
  }
}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { AppController } from './app.controller.ts'
import { Config } from './config.ts'
@Module({ controllers: [AppController], providers: [Config] })
export class AppModule {}
`
  })
  for (const specifier of ['import type { Config }', 'import { type Config }']) {
    const refused = diagnosticsOf(fixture(files(specifier)))
    assert.ok(refused.includes('constructor parameter config of AppController is typed through the type-only import Config; TypeScript emits no runtime class for Nest to inject'), `${specifier}\n${refused.join('\n')}`)
  }
  assert.deepEqual(served(fixture(files('import { Config }')), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'configured' }])
})

test('a typed-array subclass reply is refused, not sent as JSON', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): Payload {
    return new Payload([65])
  }`).replace('@Controller()', 'class Payload extends Uint8Array {}\n@Controller()') }))
  assert.ok(diagnostics.some((d) => d.startsWith('result type Payload is not in phase 1')), diagnostics.join('\n'))
})

test('a provider class named __proto__ is exported as an own key', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'feature.ts': `import { Injectable, Module } from '@nestjs/common'
@Injectable()
export class __proto__ {
  readonly name: string = 'proto'
}
@Module({ providers: [__proto__], exports: [__proto__] })
export class Feature {}
`,
    'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { Feature, __proto__ } from './feature.ts'
@Controller()
export class AppController {
  constructor(private readonly service: __proto__) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
@Module({ imports: [Feature], controllers: [AppController] })
export class AppModule {}
`
  })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  const feature = rewrites.get(path.join(dir, 'feature.ts')).match(/export function (__nestAot_[\w$]+)\(/)[1]
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'proto' }])
  const probe = `const exported = (await import('./feature.js')).${feature}({})
console.log(JSON.stringify({ plain: Object.getPrototypeOf(exported) === Object.prototype, own: Object.values(exported).map((value) => value.name) }))`
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: `${dir}-out`, encoding: 'utf8' })), { plain: true, own: ['proto'] })
})

test('generated type aliases avoid names the module already imports', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'app.module.ts': helloController().replace("from '@nestjs/common'\n", "from '@nestjs/common'\nimport type { NodeRequest as __NestAotRequest } from '@nestjs/platform-node'\nexport type Incoming = __NestAotRequest\n")
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('an overloaded route handler is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`hello(id: 'special'): string
  hello(id: string): string | number
  @Get(':id')
  hello(@Param('id') id: string): string | number {
    return id === 'special' ? 'special' : 1
  }`).replace('Get, Module', 'Get, Module, Param') }))
  assert.ok(diagnostics.includes('route handler AppController.hello is overloaded; phase 1 classifies the reply from one signature'), diagnostics.join('\n'))
})

test('a JSON reply in a module that declares its own JSON is refused', () => {
  const route = `@Get()
  hello(): { ok: boolean } {
    return { ok: true }
  }`
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': `const JSON = { stringify: (_: unknown) => 'shadowed' }\nexport const shadow = JSON\n` + helloController(route) }))
  assert.ok(diagnostics.some((d) => d.startsWith('JSON is declared in ') && d.endsWith('app.module.ts; phase 1 serializes replies with the global JSON')), diagnostics.join('\n'))
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(route) }), ['GET /']), [{ route: 'GET /', kind: 'json', status: 200, body: '{"ok":true}' }])
})

test('a named re-export whose specifiers are all type-only is erased unless verbatimModuleSyntax keeps it', () => {
  const entry = `export { type INestApplication } from '@nestjs/core'
`
  assert.equal(entryReachesNestCore({ ts, entry: path.join(fixture({ 'main.ts': entry }), 'main.ts') }), false)
  assert.equal(entryReachesNestCore({ ts, entry: path.join(fixture({ 'main.ts': entry }, { compilerOptions: { ...compilerOptions, verbatimModuleSyntax: true }, files: ['main.ts'] }), 'main.ts') }), true)
  assert.equal(entryReachesNestCore({ ts, entry: path.join(fixture({ 'main.ts': `export { NestFactory } from '@nestjs/core'
` }), 'main.ts') }), true)
})

test('the rewrite type-check keeps the fixture path aliases', () => {
  const dir = fixture({
    'main.ts': bootstrap('AppModule', '@app/app.module'),
    'app.module.ts': helloController()
  }, { compilerOptions: { ...compilerOptions, paths: { '@app/*': ['./*.ts'] } }, files: ['main.ts'] })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites), [])
})

test('ambient declarations listed in the project files are visible to the checker', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'payload.d.ts': `interface Payload {
  ok: boolean
}
`,
    'app.module.ts': helloController(`@Get()
  hello(): Payload {
    return { ok: true }
  }`)
  }, { compilerOptions, files: ['main.ts', 'payload.d.ts'] })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'json', status: 200, body: '{"ok":true}' }])
})

test('a cyclic base class chain is refused instead of looping', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Left extends Right {}
@Injectable()
export class Right extends Left {}
@Controller()
export class AppController extends AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ controllers: [AppController], providers: [Left] })
export class AppModule {}
` }))
  assert.ok(diagnostics.includes('AppController has a cyclic base class chain through AppController'), diagnostics.join('\n'))
  assert.ok(diagnostics.includes('Left has a cyclic base class chain through Left'), diagnostics.join('\n'))
})

test('a leading optional group keeps its slash inside the group, as Nest joins it', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get('{/details}')
  hello(): string {
    return 'hello'
  }`).replace('@Controller()', "@Controller('users')") })
  assert.deepEqual(served(dir, ['GET /users{/details}']), [{ route: 'GET /users{/details}', kind: 'text', status: 200, body: 'hello' }])
})

test('keyed query and header parameters typed string are accepted when strict null checks are off', () => {
  const module = helloController(`@Get()
  hello(@Query('q') q: string | string[], @Headers('x-name') name: string): string {
    return String(q) + name
  }`).replace('Get, Module', 'Get, Headers, Module, Query')
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module }, { compilerOptions: { ...compilerOptions, strict: false }, files: ['main.ts'] })), [])
  const strict = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module }))
  assert.ok(strict.some((d) => d.startsWith("@Query('q') parameter q is typed string | string[];")), strict.join('\n'))
  assert.ok(strict.some((d) => d.startsWith("@Headers('x-name') parameter name is typed string;")), strict.join('\n'))
})

test('the bootstrap alias avoids generated initializer imports', () => {
  const dir = fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import { Controller, Get, Module } from '@nestjs/common'
import { AppModule_2 } from './feature.ts'
@Controller()
export class AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ imports: [AppModule_2], controllers: [AppController] })
export class AppModule {}
async function main() {
  const __nestAot_AppModule = 0
  const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
  await app.listen(3000 + __nestAot_AppModule)
}
await main()
`,
    'feature.ts': `import { Module } from '@nestjs/common'
@Module({})
export class AppModule_2 {}
`
  })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites), [])
  const main = rewrites.get(path.join(dir, 'main.ts'))
  assert.ok(main.includes('export function __nestAot_AppModule(') && main.includes('import { __nestAot_AppModule_2 } from'), main)
  assert.equal(initializerOf(main), '__nestAot_AppModule')
})

test('the gate and the analyzer read the selected source project', () => {
  const dir = fixture({
    'main.ts': `import '@app/bootstrap'
`,
    'bootstrap.ts': bootstrap(),
    'app.module.ts': helloController(),
    'tsconfig.source.json': JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { '@app/bootstrap': ['./bootstrap.ts'] } }, files: ['main.ts'] })
  })
  const entry = path.join(dir, 'main.ts')
  assert.equal(entryReachesNestCore({ ts, entry }), false)
  assert.equal(entryReachesNestCore({ ts, entry, project: path.join(dir, 'tsconfig.source.json') }), true)
  assert.equal(analyzeNestApplication({ ts, entry, project: path.join(dir, 'tsconfig.source.json') }).bootstrap !== undefined, true)
})

test('declaration files in .d.mts and .d.cts are not walked by the gate, executable .mts modules are', () => {
  const declared = fixture({
    'main.ts': `import { helper } from './helper.mjs'
helper()
`,
    'helper.mjs': `export const helper = () => {}
`,
    'helper.d.mts': `import { INestApplication } from '@nestjs/core'
export declare const helper: (app?: INestApplication) => void
`
  })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(declared, 'main.ts') }), false)
  const commonDeclared = fixture({
    'main.ts': `import { helper } from './helper.cjs'
helper()
`,
    'helper.cjs': `exports.helper = () => {}
`,
    'helper.d.cts': `import { INestApplication } from '@nestjs/core'
export declare const helper: (app?: INestApplication) => void
`
  })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(commonDeclared, 'main.ts') }), false)
  const executable = fixture({ 'main.ts': `import './boot.mts'
`, 'boot.mts': bootstrap() })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(executable, 'main.ts') }), true)
})

test('the rewrite type-check reads the fixture config with its inherited path aliases', () => {
  const dir = fixture({
    'main.ts': bootstrap('AppModule', '@app/app.module'),
    'app.module.ts': helloController(),
    'config/base.json': JSON.stringify({ compilerOptions: { ...compilerOptions, paths: { '@app/*': ['../*.ts'] } } }),
    'tsconfig.json': JSON.stringify({ extends: './config/base.json', files: ['main.ts'] })
  })
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites), [])
})

test('--paths overrides take precedence over the source project in the gate and the analyzer', () => {
  const dir = fixture({
    'main.ts': `import '@app/start'
`,
    'nest.ts': bootstrap(),
    'plain.ts': `export const plain = 1
`,
    'app.module.ts': helloController()
  }, { compilerOptions: { ...compilerOptions, paths: { '@app/start': ['./nest.ts'] } }, files: ['main.ts'] })
  const entry = path.join(dir, 'main.ts')
  assert.equal(entryReachesNestCore({ ts, entry }), true)
  assert.equal(entryReachesNestCore({ ts, entry, paths: { '@app/start': [path.join(dir, 'plain.ts')] } }), false)
  const reversed = fixture({
    'main.ts': `import '@app/start'
`,
    'nest.ts': bootstrap(),
    'plain.ts': `export const plain = 1
`,
    'app.module.ts': helloController()
  }, { compilerOptions: { ...compilerOptions, paths: { '@app/start': ['./plain.ts'] } }, files: ['main.ts'] })
  const reversedEntry = path.join(reversed, 'main.ts')
  assert.equal(analyzeNestApplication({ ts, entry: reversedEntry, paths: { '@app/start': [path.join(reversed, 'nest.ts')] } }).bootstrap !== undefined, true)
})

test('Nest is identified by the innermost node_modules package, as in a pnpm layout', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController() })
  const modules = path.join(dir, 'node_modules')
  fs.unlinkSync(modules)
  fs.mkdirSync(path.join(modules, '@nestjs'), { recursive: true })
  for (const name of fs.readdirSync(nestModules)) if (name !== '@nestjs' && name !== '.bin') fs.symlinkSync(path.join(nestModules, name), path.join(modules, name))
  for (const name of fs.readdirSync(path.join(nestModules, '@nestjs'))) {
    const store = path.join(modules, `.pnpm/@nestjs+${name}@12.5.1/node_modules/@nestjs/${name}`)
    fs.cpSync(fs.realpathSync(path.join(nestModules, '@nestjs', name)), store, { recursive: true })
    fs.symlinkSync(store, path.join(modules, '@nestjs', name))
  }
  const program = ts.createProgram({ rootNames: [path.join(dir, 'main.ts')], options: ts.convertCompilerOptionsFromJson(compilerOptions, dir).options })
  assert.ok(program.getSourceFiles().some((file) => file.fileName.includes('/node_modules/.pnpm/@nestjs+core@12.5.1/node_modules/@nestjs/core/')), 'fixture resolves through .pnpm')
  assert.deepEqual(diagnosticsOf(dir), [])
})

test('anonymous default-exported classes get generated names from their local bindings', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'service.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export default class {
  readonly name: string = 'anonymous'
}
`,
    'feature.ts': `import { Module } from '@nestjs/common'
import Service from './service.ts'
@Module({ providers: [Service], exports: [Service] })
export class Feature {}
`,
    'hello.controller.ts': `import { Controller, Get } from '@nestjs/common'
import Service from './service.ts'
@Controller()
export default class {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import Hello from './hello.controller.ts'
import { Feature } from './feature.ts'
@Module({ imports: [Feature], controllers: [Hello] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'anonymous' }])
})

test('an Error returned on an error status is replaced by the status body, as the NodeAdapter does', () => {
  const route = (status) => `@Get()
  @HttpCode(${status})
  hello(): { message: string } {
    return Object.assign(new Error('boom'), { secret: 'token' })
  }`
  const module = (status) => helloController(route(status)).replace('Get, Module', 'Get, HttpCode, Module')
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module(500) }), ['GET /']), [{ route: 'GET /', kind: 'json', status: 500, body: '{"statusCode":500,"message":"Internal Server Error"}' }])
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module(200) }), ['GET /']), [{ route: 'GET /', kind: 'json', status: 200, body: '{"secret":"token"}' }])
  const shadowed = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': `class Error {}\nexport const shadow = Error\n` + module(500) }))
  assert.ok(shadowed.some((d) => d.startsWith('Error is declared in ') && d.endsWith('app.module.ts; phase 1 serializes replies with the global Error')), shadowed.join('\n'))
})

test('without strictNullChecks a handler returning null instead of a Promise sends an empty reply', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): Promise<string> {
    return null
  }`) }, { compilerOptions: { ...compilerOptions, strict: false }, files: ['main.ts'] })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'empty', status: 200, body: null }])
})

test('without a tsconfig the analyzer resolves with the same NodeNext fallback as the gate', () => {
  const dir = fixture({ 'main.ts': `import '#bootstrap'
`, 'bootstrap.ts': bootstrap(), 'app.module.ts': helloController() })
  fs.unlinkSync(path.join(dir, 'tsconfig.json'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: { '#bootstrap': './bootstrap.ts' } }))
  const entry = path.join(dir, 'main.ts')
  assert.equal(entryReachesNestCore({ ts, entry }), true)
  assert.equal(analyzeNestApplication({ ts, entry }).bootstrap !== undefined, true)
})

test('an unreadable tsconfig leaves the gate on the NodeNext fallback', () => {
  const dir = fixture({ 'main.ts': `import '#bootstrap'
`, 'bootstrap.ts': bootstrap(), 'app.module.ts': helloController() })
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": ')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: { '#bootstrap': './bootstrap.ts' } }))
  assert.equal(entryReachesNestCore({ ts, entry: path.join(dir, 'main.ts') }), true)
})

test('given resolution options, the gate and the analyzer resolve like the staged Bundler project', () => {
  const dir = fixture({ 'main.ts': `import './bootstrap'
`, 'bootstrap.ts': bootstrap(), 'app.module.ts': helloController() })
  const entry = path.join(dir, 'main.ts')
  const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, experimentalDecorators: true, strict: true, noEmit: true }
  assert.equal(entryReachesNestCore({ ts, entry }), false)
  assert.equal(entryReachesNestCore({ ts, entry, options }), true)
  assert.equal(analyzeNestApplication({ ts, entry, options }).bootstrap !== undefined, true)
})

test('given root names, the analyzer sees the ambient declarations the staged build carries', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'payload.d.ts': `interface Payload {
  ok: boolean
}
`,
    'app.module.ts': helloController(`@Get()
  hello(): Payload {
    return { ok: true }
  }`)
  })
  const entry = path.join(dir, 'main.ts')
  const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, experimentalDecorators: true, strict: true, noEmit: true }
  assert.throws(
    () => generateNestApplication({ ts, entry, options }),
    (error) => error instanceof NestAnalysisError && error.diagnostics.some((d) => d.message.includes('Payload'))
  )
  assert.equal(generateNestApplication({ ts, entry, options, rootNames: [path.join(dir, 'payload.d.ts')] }).rewrites.size > 0, true)
})

test('an empty method-path array registers the controller route, as Nest does', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get([])
  hello(): string {
    return 'hello'
  }`).replace('@Controller()', "@Controller('users')") })
  assert.deepEqual(served(dir, ['GET /users']), [{ route: 'GET /users', kind: 'text', status: 200, body: 'hello' }])
})

test("an empty @Headers('') or @Query('') key binds the whole record, as Nest does", () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(@Headers('') headers: Record<string, string | undefined>, @Query('') query: Record<string, string | string[]>): string {
    return String(query['q']) + '|' + String(headers['x-probe'])
  }`).replace('Get, Module', 'Get, Headers, Module, Query') })
  assert.deepEqual(served(dir, [{ route: 'GET /', query: { q: 'from-query' }, headers: { 'x-probe': 'from-headers' } }]), [{ route: 'GET /', kind: 'text', status: 200, body: 'from-query|from-headers' }])
})

test('an error-status JSON reply evaluates the handler once', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`private count = 0
  @Get()
  @HttpCode(400)
  hello(): { attempt: number } {
    return { attempt: ++this.count }
  }`).replace('Get, Module', 'Get, HttpCode, Module') })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'json', status: 400, body: '{"attempt":1}' }])
})

test('without strictNullChecks a handled async route returning null sends nothing more', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(@Res() res: NodeResponse): Promise<void> {
    res.end()
    return null
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'") }, { compilerOptions: { ...compilerOptions, strict: false }, files: ['main.ts'] })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', status: 200 }, { route: 'GET /', ended: true }])
})

const injected = (annotation, prelude = '') => `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'config'
}
${prelude}@Controller()
export class AppController {
  constructor(private readonly config: ${annotation}) {}
  @Get()
  hello(): string {
    return this.config.name
  }
}
@Module({ controllers: [AppController], providers: [Config] })
export class AppModule {}
`

test('constructor injection is refused when emitDecoratorMetadata is off', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('Config') }, { compilerOptions: { ...compilerOptions, emitDecoratorMetadata: false }, files: ['main.ts'] }))
  assert.ok(diagnostics.includes('AppController takes constructor parameters, but emitDecoratorMetadata is off; Nest reads them from design:paramtypes metadata and would pass none'), diagnostics.join('\n'))
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('Config') }), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'config' }])
})

test('a constructor parameter annotated through a type alias is refused, as it emits Object', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('Settings', 'type Settings = Config\n') }))
  assert.ok(diagnostics.includes('constructor parameter config of AppController is annotated Settings, which names no class value; TypeScript emits Object as its design:paramtypes token, not the class Nest injects'), diagnostics.join('\n'))
  const inferred = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('Config').replace('private readonly config: Config', 'private readonly config = new Config()') }))
  assert.ok(inferred.includes('constructor parameter config of AppController is unannotated, which names no class value; TypeScript emits Object as its design:paramtypes token, not the class Nest injects'), inferred.join('\n'))
})

test('a structural result type that admits a typed array or a string is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): { length: number } {
    return new Uint8Array([65])
  }`) }))
  assert.ok(diagnostics.includes('result type { length: number; } also admits strings, numbers, booleans or typed arrays, which Nest replies by their runtime value; phase 1 replies from the declared type'), diagnostics.join('\n'))
})

test('a handler resolving through a nested Promise is refused', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): Promise<Promise<string>> {
    return new Promise<Promise<string>>((resolve) => resolve(Promise.resolve('hello')))
  }`) })
  assert.deepEqual(sourceTypeErrors(dir), [])
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes('result type Promise<Promise<string>> resolves through a nested Promise; phase 1 replies from the value of one Promise'), diagnostics.join('\n'))
})

const barrelled = (barrel) => ({
  'main.ts': bootstrap(),
  'config.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export class Config {
  readonly name: string = 'config'
}
`,
  'barrel.ts': barrel,
  'controller.ts': `import { Controller, Get } from '@nestjs/common'
import { Config } from './barrel.ts'
@Controller()
export class AppController {
  constructor(private readonly config: Config) {}
  @Get()
  hello(): string {
    return this.config.name
  }
}
`,
  'app.module.ts': `import { Module } from '@nestjs/common'
import { Config } from './config.ts'
import { AppController } from './controller.ts'
@Module({ controllers: [AppController], providers: [Config] })
export class AppModule {}
`
})

test('a constructor parameter typed through a type-only re-export is refused, a value re-export is injected', () => {
  for (const barrel of ["export type { Config } from './config.ts'\n", "export type * from './config.ts'\n"]) {
    const dir = fixture(barrelled(barrel))
    const diagnostics = diagnosticsOf(dir)
    assert.ok(diagnostics.includes(`constructor parameter config of AppController is typed through the type-only re-export in ${path.join(dir, 'barrel.ts')} Config; TypeScript emits no runtime class for Nest to inject`), diagnostics.join('\n'))
  }
  assert.deepEqual(served(fixture(barrelled("export { Config } from './config.ts'\n")), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'config' }])
})

test('an error-status JSON reply under a non-JSON Content-Type is relabelled JSON, as Nest does', () => {
  const module = (type) => helloController(`@Get()
  @Header('Content-Type', '${type}')
  @HttpCode(400)
  hello(): { reason: string } {
    return { reason: 'invalid' }
  }`).replace('Get, Module', 'Get, Header, HttpCode, Module')
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('text/plain') }), ['GET /']), [
    { route: 'GET /', header: ['Content-Type', 'text/plain'] },
    { route: 'GET /', header: ['Content-Type', 'application/json; charset=utf-8'] },
    { route: 'GET /', kind: 'json', status: 400, body: '{"reason":"invalid"}' }
  ])
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': module('application/problem+json') }), ['GET /']), [
    { route: 'GET /', header: ['Content-Type', 'application/problem+json'] },
    { route: 'GET /', kind: 'json', status: 400, body: '{"reason":"invalid"}' }
  ])
  const success = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  @Header('Content-Type', 'text/plain')
  hello(): { statusCode: number } {
    return { statusCode: 404 }
  }`).replace('Get, Module', 'Get, Header, Module') }))
  assert.ok(success.includes('result type { statusCode: number; } has a statusCode, which Nest checks at runtime to replace the text/plain Content-Type with JSON; phase 1 replies from the declared type'), success.join('\n'))
})

test('a default-imported root module keeps its diagnostic when the bootstrap shadows the generated name', () => {
  const diagnostics = diagnosticsOf(fixture({
    'main.ts': `import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'
import AppModule from './app.module.ts'
async function main(): Promise<void> {
  const __nestAot_AppModule = 0
  const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
  await app.listen(3000 + __nestAot_AppModule)
}
await main()
`,
    'app.module.ts': helloController().replace('export class AppModule', 'export default class AppModule')
  }))
  assert.ok(diagnostics.some((d) => d.startsWith('AppModule is not imported into ') && d.endsWith(' by name; phase 1 finds the generated module function through the same import')), diagnostics.join('\n'))
})

test('an overloaded constructor is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('Config').replace('  constructor(private readonly config: Config) {}', `  private readonly config: Config
  constructor()
  constructor(config: Config = new Config()) {
    this.config = config
  }`) }))
  assert.ok(diagnostics.includes('AppController declares constructor overloads; phase 1 calls the implementation, which the public signatures may not admit'), diagnostics.join('\n'))
})

test('a class listed twice in one metadata list is registered once, as Nest does', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'feature.ts': `import { Module } from '@nestjs/common'
@Module({})
export class Feature {}
`,
    'app.module.ts': helloController().replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module } from '@nestjs/common'\nimport { Feature } from './feature.ts'").replace('@Module({ controllers: [AppController] })', '@Module({ imports: [Feature, Feature], controllers: [AppController, AppController] })')
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.equal([...rewrites.values()].join('\n').split('new AppController(').length - 1, 1)
})

test('a module declaring configure() is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController().replace('export class AppModule {}', `export class AppModule {
  configure(): void {}
}`) }))
  assert.ok(diagnostics.includes('module AppModule declares configure(), which Nest calls to register middleware; phase 1 does not construct modules or apply middleware'), diagnostics.join('\n'))
})

test('a numeric reply refuses a module-level String binding', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': `const String = (_: number): string => 'local'\nexport const shadow = String\n` + helloController(`@Get()
  hello(): number {
    return 42
  }`) })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes(`String is declared in ${path.join(dir, 'app.module.ts')}; phase 1 serializes replies with the global String`), diagnostics.join('\n'))
})

test('a parenthesized constructor class type is injected like the bare class', () => {
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': injected('(Config)') }), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'config' }])
})

const featureFiles = (controller = '') => ({
  'service.ts': `import { Injectable } from '@nestjs/common'
@Injectable()
export class Service {
  readonly name: string = 'service'
}
`,
  'feature.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { Service } from './service.ts'
${controller}@Module({ providers: [Service], exports: [Service]${controller ? ', controllers: [FeatureController]' : ''} })
export class Feature {}
`
})

test('a module re-exporting an imported provider refuses a module-level ReturnType binding', () => {
  const module = (prelude) => `import { Controller, Get, Module } from '@nestjs/common'
import { Feature } from './feature.ts'
${prelude}@Controller()
export class AppController {
  @Get()
  hello(): string {
    return 'hello'
  }
}
@Module({ imports: [Feature], exports: [Feature], controllers: [AppController] })
export class AppModule {}
`
  const dir = fixture({ 'main.ts': bootstrap(), ...featureFiles(), 'app.module.ts': module('type ReturnType<T> = number\nexport type Shadow = ReturnType<string>\n') })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes(`ReturnType is declared in ${path.join(dir, 'app.module.ts')}; phase 1 types generated module functions with the global ReturnType`), diagnostics.join('\n'))
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), ...featureFiles(), 'app.module.ts': module('') }), ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('a route an imported module also serves is refused, as registration order differs from Nest', () => {
  const featureController = `@Controller()
export class FeatureController {
  @Get(':name')
  hello(): string {
    return 'feature'
  }
}
`
  const dir = fixture({ 'main.ts': bootstrap(), ...featureFiles(featureController), 'app.module.ts': helloController().replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module } from '@nestjs/common'\nimport { Feature } from './feature.ts'").replace("@Get()", "@Get(':id')").replace('@Module({ controllers: [AppController] })', '@Module({ imports: [Feature], controllers: [AppController] })') })
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes('GET /:id of AppController in module AppModule matches a route of FeatureController in module Feature; Nest registers an importing module\'s routes first, phase 1 registers an imported module\'s routes first'), diagnostics.join('\n'))
})

test('two controllers of one module serving the same route reply from the first, as Nest does', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController().replace('@Module({ controllers: [AppController] })', `@Controller()
export class SecondController {
  @Get()
  hello(): string {
    return 'second'
  }
}
@Module({ controllers: [AppController, SecondController] })`) })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('a manual @Res() route is not checked for the automatic Content-Type reply', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  @Header('Content-Type', 'text/plain')
  hello(@Res() res: NodeResponse): { statusCode: number } {
    res.end()
    return { statusCode: 400 }
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Header, Module, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'") })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', header: ['Content-Type', 'text/plain'] }, { route: 'GET /', status: 200 }, { route: 'GET /', ended: true }])
})

test('the driver records handler work that settles after a later timer', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(@Res() res: NodeResponse): Promise<void> {
    res.end()
    return new Promise((_, reject) => setTimeout(() => reject(new TypeError('late')), 200))
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'") })
  const result = served(dir, ['GET /'])
  assert.deepEqual(result.slice(0, 2), [{ route: 'GET /', status: 200 }, { route: 'GET /', ended: true }])
  assert.equal(result.length, 3, JSON.stringify(result))
})

test('a module re-exporting a class through a barrel alias keeps the binding of its direct import', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    ...featureFiles(),
    'index.ts': `export { Feature as PublicFeature } from './feature.ts'
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Feature } from './feature.ts'
import { PublicFeature } from './index.ts'
@Module({ imports: [Feature], exports: [PublicFeature] })
export class AppModule {}
`,
    'root.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
import { AppModule } from './app.module.ts'
import { Service } from './service.ts'
@Controller()
export class ConsumerController {
  constructor(private readonly service: Service) {}
  @Get()
  hello(): string {
    return this.service.name
  }
}
@Module({ imports: [AppModule], controllers: [ConsumerController] })
export class RootModule {}
`
  })
  fs.writeFileSync(path.join(dir, 'main.ts'), bootstrap('RootModule', './root.module.ts'))
  assert.deepEqual(served(dir, ['GET /'], 'root.module.ts'), [{ route: 'GET /', kind: 'text', status: 200, body: 'service' }])
})

test('an exported generic provider is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController().replace("import { Controller, Get, Module } from '@nestjs/common'", `import { Controller, Get, Injectable, Module } from '@nestjs/common'
@Injectable()
export class Cache<T> {
  value?: T
}`).replace('@Module({ controllers: [AppController] })', '@Module({ controllers: [AppController], providers: [Cache], exports: [Cache] })') }))
  assert.ok(diagnostics.includes("exported provider Cache is generic; phase 1 types a module's exports by their class name"), diagnostics.join('\n'))
})

const conflicting = (rootPath, featurePath) => {
  const featureController = `@Controller()
export class FeatureController {
  @Get('${featurePath}')
  hello(): string {
    return 'feature'
  }
}
`
  return fixture({ 'main.ts': bootstrap(), ...featureFiles(featureController), 'app.module.ts': helloController().replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module } from '@nestjs/common'\nimport { Feature } from './feature.ts'").replace('@Get()', `@Get('${rootPath}')`).replace('@Module({ controllers: [AppController] })', '@Module({ imports: [Feature], controllers: [AppController] })') })
}

test('the cross-module route check keeps literal suffixes and expands optional groups', () => {
  assert.deepEqual(served(conflicting('files/:name.json', 'files/:name.csv'), ['GET /files/:name.json', 'GET /files/:name.csv']), [
    { route: 'GET /files/:name.json', kind: 'text', status: 200, body: 'hello' },
    { route: 'GET /files/:name.csv', kind: 'text', status: 200, body: 'feature' }
  ])
  const suffix = diagnosticsOf(conflicting(':id.json', ':name.json'))
  assert.ok(suffix.includes("GET /:id.json of AppController in module AppModule matches a route of FeatureController in module Feature; Nest registers an importing module's routes first, phase 1 registers an imported module's routes first"), suffix.join('\n'))
  const grouped = diagnosticsOf(conflicting('files', 'files{/details}'))
  assert.ok(grouped.includes("GET /files of AppController in module AppModule matches a route of FeatureController in module Feature; Nest registers an importing module's routes first, phase 1 registers an imported module's routes first"), grouped.join('\n'))
})

test('array-index handler names register first in numeric order, as Nest scans them', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  2(): string {
    return 'two'
  }
  @Get()
  1(): string {
    return 'one'
  }`) })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'one' }])
})

test('a route expanding to more than 256 optional-group variants is refused', () => {
  const route = (groups) => helloController(`@Get('a${Array.from({ length: groups }, (_, i) => `{/g${i}}`).join('')}')
  hello(): string {
    return 'hello'
  }`)
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route(8) })), [])
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route(9) }))
  assert.ok(diagnostics.includes('route /a{/g0}{/g1}{/g2}{/g3}{/g4}{/g5}{/g6}{/g7}{/g8} expands to more than 256 optional-group variants; path-to-regexp refuses it as too many path combinations'), diagnostics.join('\n'))
})

test('the handler captured at registration keeps serving after it replaces itself', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): string {
    this.hello = (): string => 'replaced'
    return 'original'
  }`) })
  assert.deepEqual(served(dir, ['GET /', 'GET /']), [
    { route: 'GET /', kind: 'text', status: 200, body: 'original' },
    { route: 'GET /', kind: 'text', status: 200, body: 'original' }
  ])
})

test('an error-status binary reply under a non-JSON Content-Type is relabelled JSON, as Nest does', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  @Header('Content-Type', 'text/plain')
  @HttpCode(400)
  hello(): Uint8Array {
    return new Uint8Array([65])
  }`).replace('Get, Module', 'Get, Header, HttpCode, Module') })
  assert.deepEqual(served(dir, ['GET /']), [
    { route: 'GET /', header: ['Content-Type', 'text/plain'] },
    { route: 'GET /', header: ['Content-Type', 'application/json; charset=utf-8'] },
    { route: 'GET /', kind: 'bytes', status: 400, body: 'Uint8Array 41' }
  ])
})

test('the served fixture keeps an empty import that verbatimModuleSyntax evaluates', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'init.ts': `export type Marker = string
;(globalThis as { marker?: Marker }).marker = 'initialized'
`,
    'app.module.ts': `import { type Marker } from './init.ts'
` + helloController(`@Get()
  hello(): string {
    return (globalThis as { marker?: Marker }).marker ?? 'missing'
  }`)
  }, { compilerOptions: { ...compilerOptions, verbatimModuleSyntax: true }, files: ['main.ts'] })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'initialized' }])
})

test('a TypeScript this parameter is not a route binding', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(this: AppController): string {
    return 'hello'
  }`) })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('escaped braces are literal text, not optional groups, in the variant cap', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get('a\\\\{x\\\\}${Array.from({ length: 8 }, (_, i) => `{/g${i}}`).join('')}')
  hello(): string {
    return 'hello'
  }`) })
  assert.deepEqual(diagnosticsOf(dir), [])
})

test('a void handler that returns a value is refused, one that returns nothing is an empty reply', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': `const make: () => void = () => 'ok'\n` + helloController(`@Get()
  hello(): void {
    return make()
  }`) }))
  assert.ok(diagnostics.includes('result type void is void, but the handler returns a value, which Nest would send; phase 1 replies from the declared type'), diagnostics.join('\n'))
  assert.deepEqual(served(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): void {
    const ignored = (): string => 'ignored'
    ignored()
  }`) }), ['GET /']), [{ route: 'GET /', kind: 'empty', status: 200, body: null }])
})

test('a manual @Res() handler is not checked for reply kinds', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(@Res() res: NodeResponse): string | number {
    res.end()
    return Math.random() > 2 ? 'never' : 0
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'") })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', status: 200 }, { route: 'GET /', ended: true }])
})

test('a null target in a fixture import map is kept', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#feature': { import: './feature.ts', default: null } } }),
    'main.ts': bootstrap(),
    'feature.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class FeatureController {
  @Get()
  hello(): string {
    return 'feature'
  }
}
@Module({ controllers: [FeatureController] })
export class Feature {}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Feature } from '#feature'
@Module({ imports: [Feature] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'feature' }])
})

test('a constructor parameter typed through a namespace member of a type-only re-export is refused', () => {
  const files = barrelled("export type { Config } from './config.ts'\n")
  files['controller.ts'] = files['controller.ts'].replace("import { Config } from './barrel.ts'", "import * as tokens from './barrel.ts'").replace('config: Config', 'config: tokens.Config')
  const dir = fixture(files)
  const diagnostics = diagnosticsOf(dir)
  assert.ok(diagnostics.includes(`constructor parameter config of AppController is typed through the type-only re-export in ${path.join(dir, 'barrel.ts')} tokens.Config; TypeScript emits no runtime class for Nest to inject`), diagnostics.join('\n'))
})

test('an explicit NestFactory.create type argument is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap().replace("import { NestFactory } from '@nestjs/core'", "import type { INestApplication } from '@nestjs/common'\nimport { NestFactory } from '@nestjs/core'").replace('NestFactory.create(', 'NestFactory.create<INestApplication>('), 'app.module.ts': helloController() }))
  assert.ok(diagnostics.includes('NestFactory.create<INestApplication>() has an explicit type argument; phase 1 rewrites the call to a non-generic create()'), diagnostics.join('\n'))
})

test('a manual @Res() handler whose result type admits a Promise is refused unless it declares one', () => {
  const manual = (result, body) => helloController(`@Get()
  hello(@Res() res: NodeResponse): ${result} {
    ${body}
  }`).replace("import { Controller, Get, Module } from '@nestjs/common'", "import { Controller, Get, Module, Res } from '@nestjs/common'\nimport type { NodeResponse } from '@nestjs/platform-node'")
  for (const result of ['unknown', 'object', '{}']) {
    const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': manual(result, "return Promise.reject(new Error('failed'))") }))
    assert.ok(diagnostics.includes(`result type ${result} of a manual @Res() handler may be a Promise or other thenable; phase 1 catches a rejection only from a declared Promise`), diagnostics.join('\n'))
  }
  const declared = fixture({ 'main.ts': bootstrap(), 'app.module.ts': manual('Promise<void>', 'res.end()\n    return Promise.resolve()') })
  assert.deepEqual(sourceTypeErrors(declared), [])
  assert.deepEqual(diagnosticsOf(declared), [])
})

test('route handlers are captured after every controller of the module is constructed', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
const constructed: { first?: AppController } = {}
@Controller()
export class AppController {
  constructor() {
    constructed.first = this
  }
  @Get()
  hello(): string {
    return 'original'
  }
}
@Controller('second')
export class SecondController {
  constructor() {
    if (constructed.first) constructed.first.hello = (): string => 'replaced'
  }
  @Get()
  hello(): string {
    return 'second'
  }
}
@Module({ controllers: [AppController, SecondController] })
export class AppModule {}
` })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'replaced' }])
})

test('a bootstrap reached through a literal import() is counted, a non-literal import() is refused', () => {
  const second = diagnosticsOf(fixture({ 'main.ts': bootstrap() + "await import('./second.ts')\n", 'second.ts': bootstrap(), 'app.module.ts': helloController() }))
  assert.ok(second.includes('found 2 NestFactory.create(...) calls; phase 1 generates one application'), second.join('\n'))
  const opaque = diagnosticsOf(fixture({ 'main.ts': bootstrap() + "const second: string = './second.ts'\nawait import(second)\n", 'second.ts': bootstrap(), 'app.module.ts': helloController() }))
  assert.ok(opaque.includes('import() with a non-literal specifier may load a NestFactory.create bootstrap; phase 1 follows only literal module specifiers'), opaque.join('\n'))
})

test("@Headers('Set-Cookie') is refused, the compiled runtime cannot supply Node's string[]", () => {
  const cookie = (type) => fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(@Headers('Set-Cookie') cookies: ${type}): string {
    return 'hello'
  }`).replace('Get, Module', 'Get, Headers, Module') })
  for (const type of ['string | undefined', 'string[] | undefined']) {
    const diagnostics = diagnosticsOf(cookie(type))
    assert.ok(diagnostics.includes("@Headers('Set-Cookie') is not in phase 1; Node supplies set-cookie as a string[], the compiled runtime joins repeated values into one string"), diagnostics.join('\n'))
  }
})

test("NestFactory['create'] counts as a bootstrap call", () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap() + "const second = await NestFactory['create'](AppModule, new NodeAdapter(), { logger: false })\nawait second.listen(3001)\n", 'app.module.ts': helloController() }))
  assert.ok(diagnostics.includes('found 2 NestFactory.create(...) calls; phase 1 generates one application'), diagnostics.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap().replace('NestFactory.create(', "NestFactory['create']("), 'app.module.ts': helloController() })), [])
})

test('the build gate follows a literal import() to @nestjs/core', () => {
  const dir = fixture({ 'main.ts': "await import('./bootstrap.ts')\n", 'bootstrap.ts': bootstrap(), 'app.module.ts': helloController() })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(dir, 'main.ts') }), true)
})

test('a typed-array reply under a module-level Uint8Array binding is refused', () => {
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': `const Uint8Array = function (): globalThis.Uint8Array {
  return new globalThis.Uint8Array(0)
} as unknown as Uint8ArrayConstructor
` + helloController(`@Get()
  hello(): Uint16Array {
    return new Uint16Array([258])
  }`) }))
  assert.ok(diagnostics.some((d) => d.endsWith('; phase 1 serializes replies with the global Uint8Array') && d.includes('Uint8Array is declared in')), diagnostics.join('\n'))
})

test('reply globals are checked in the module file the route callback is emitted in', () => {
  const shadowing = { Uint8Array: 'const Uint8Array = globalThis.Uint8Array\n', JSON: 'const JSON = globalThis.JSON\n' }
  const split = (moduleShadow, controllerShadow, result, body) => fixture({
    'main.ts': bootstrap(),
    'controller.ts': `import { Controller, Get } from '@nestjs/common'
${controllerShadow}@Controller()
export class AppController {
  @Get()
  hello(): ${result} {
    return ${body}
  }
}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { AppController } from './controller.ts'
${moduleShadow}@Module({ controllers: [AppController] })
export class AppModule {}
`
  })
  for (const [global, result, body] of [['Uint8Array', 'Uint16Array', 'new Uint16Array([258])'], ['JSON', '{ ok: boolean }', '{ ok: true }']]) {
    const dir = split(shadowing[global], '', result, body)
    const diagnostics = diagnosticsOf(dir)
    assert.ok(diagnostics.includes(`${global} is declared in ${path.join(dir, 'app.module.ts')}; phase 1 serializes replies with the global ${global}`), diagnostics.join('\n'))
  }
  assert.deepEqual(diagnosticsOf(split('', shadowing.Uint8Array, 'Uint16Array', 'new Uint16Array([258])')), [])
})

test('a capture keeps its name next to a literal optional group, an omitted-group capture is still refused', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(@Param('id') id: string): string {
    return id
  }`).replace('Get, Module', 'Get, Module, Param')
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('items/:id{suffix}') })), [])
  const omitted = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('items{/:id}') }))
  assert.ok(omitted.includes('route /items{/:id} has no :id parameter in its variant /items; Nest would pass undefined'), omitted.join('\n'))
})

test('a route the runtime path-to-regexp cannot parse is refused at build time', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(): string {
    return 'hello'
  }`)
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users/:') }))
  assert.ok(diagnostics.includes('route /users/: does not parse as a path-to-regexp pattern (Missing parameter name at index 8: /users/:); the router would throw at startup'), diagnostics.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route('users/:id') })), [])
})

test('a route whose expansion puts two captures side by side is refused, a separated pair is accepted', () => {
  const route = (path) => helloController(`@Get('${path}')
  hello(): string {
    return 'hello'
  }`)
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route(':left{-}:right') }))
  assert.ok(diagnostics.includes('route /:left{-}:right has the variant /:left:right with two captures and no text between them; the router would throw at startup'), diagnostics.join('\n'))
  assert.deepEqual(diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': route(':left-:right') })), [])
})

test('the optional-group cap counts groups the parser sees, not braces inside quoted names', () => {
  const groups = Array.from({ length: 9 }, (_, i) => `{/g${i}}`).join('')
  const diagnostics = diagnosticsOf(fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get('a/:"{"${groups}')
  hello(): string {
    return 'hello'
  }`) }))
  assert.ok(diagnostics.includes(`route /a/:"{"${groups} expands to more than 256 optional-group variants; path-to-regexp refuses it as too many path combinations`), diagnostics.join('\n'))
})

test("whole-record @Headers() under Node's IncomingHttpHeaders is refused", () => {
  const headers = (type) => fixture({ 'main.ts': bootstrap(), 'app.module.ts': "import type { IncomingHttpHeaders } from 'node:http'\n" + helloController(`@Get()
  hello(@Headers() headers: ${type}): string {
    return String(headers['host'])
  }`).replace('Get, Module', 'Get, Headers, Module') })
  const diagnostics = diagnosticsOf(headers('IncomingHttpHeaders'))
  assert.ok(diagnostics.includes("@Headers() parameter headers is typed IncomingHttpHeaders; the headers are a Record<string, string | undefined>; Node's IncomingHttpHeaders types set-cookie as a string[], the compiled runtime joins repeated values into one string"), diagnostics.join('\n'))
  assert.deepEqual(diagnosticsOf(headers('Record<string, string | undefined>')), [])
})

test('an .mts package-import target is emitted as .mjs and served', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#feature': './feature.mts' } }),
    'main.ts': bootstrap(),
    'feature.mts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class FeatureController {
  @Get()
  hello(): string {
    return 'feature'
  }
}
@Module({ controllers: [FeatureController] })
export class Feature {}
`,
    'app.module.ts': `import { Module } from '@nestjs/common'
import { Feature } from '#feature'
@Module({ imports: [Feature] })
export class AppModule {}
`
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'feature' }])
})

test('the rewrite type check resolves bare builtins to the runtime, as the build does', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': "import { maxHeaderSize } from 'http'\n" + helloController(`@Get()
  hello(): string {
    return String(maxHeaderSize)
  }`) })
  const [result] = served(dir, ['GET /'])
  assert.ok(result.typeErrors?.some((error) => error.includes('maxHeaderSize')), JSON.stringify(result))
})

test('the native type check covers fixture files the rewrite leaves unchanged', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'limits.ts': "import { maxHeaderSize } from 'http'\nexport const limit = (): string => String(maxHeaderSize)\n",
    'app.module.ts': "import { limit } from './limits.ts'\n" + helloController(`@Get()
  hello(): string {
    return limit()
  }`)
  })
  const [result] = served(dir, ['GET /'])
  assert.ok(result.typeErrors?.some((error) => error.startsWith('limits.ts: ') && error.includes('maxHeaderSize')), JSON.stringify(result))
})

test('a fixture that logs while serving still reports its replies', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController(`@Get()
  hello(): string {
    console.log('serving hello')
    return 'hello'
  }`) })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('a JavaScript module a controller imports is copied next to the emitted fixture', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'helper.mjs': "export const greeting = () => 'from-js'\n",
    'helper.d.mts': 'export declare const greeting: () => string\n',
    'app.module.ts': "import { greeting } from './helper.mjs'\n" + helloController(`@Get()
  hello(): string {
    return greeting()
  }`)
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'from-js' }])
})

test("class fields are emitted with the fixture's effective useDefineForClassFields", () => {
  const files = { 'main.ts': bootstrap(), 'app.module.ts': `import { Controller, Get, Module } from '@nestjs/common'
@Controller()
export class AppController {
  seen = 'none'
  label = 'own'
  @Get()
  hello(): string {
    return this.seen
  }
}
Object.defineProperty(AppController.prototype, 'label', {
  set(this: AppController, value: string) {
    this.seen = value
  }
})
@Module({ controllers: [AppController] })
export class AppModule {}
` }
  const reply = (useDefineForClassFields) => served(fixture(files, { compilerOptions: { ...compilerOptions, useDefineForClassFields }, files: ['main.ts'] }), ['GET /'])
  assert.deepEqual(reply(true), [{ route: 'GET /', kind: 'text', status: 200, body: 'none' }])
  assert.deepEqual(reply(false), [{ route: 'GET /', kind: 'text', status: 200, body: 'own' }])
})

test('a fixture that ignores SIGTERM is still stopped at the deadline', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': "(globalThis as unknown as { process: { on(signal: string, listener: () => void): void } }).process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)\n" + helloController() })
  assert.deepEqual(served(dir, ['GET /']), [{ timedOut: 'SIGKILL' }])
})

test('a child killed for overflowing its output buffer is a crash, not a deadline', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': "(globalThis as unknown as { process: { stdout: { write(text: string): void } } }).process.stdout.write('x'.repeat(4 * 1024 * 1024))\n" + helloController() })
  assert.deepEqual(served(dir, ['GET /']), [{ crashed: 'ENOBUFS' }])
})

test('type checks keep diagnostics that have no source file', () => {
  const dir = fixture({ 'main.ts': bootstrap(), 'app.module.ts': helloController() }, { compilerOptions: { ...compilerOptions, noEmit: false }, files: ['main.ts'] })
  const expected = "Option 'allowImportingTsExtensions' can only be used when either 'noEmit' or 'emitDeclarationOnly' is set."
  assert.ok(sourceTypeErrors(dir).includes(expected), sourceTypeErrors(dir).join('\n'))
  const { rewrites } = generateNestApplication({ ts, entry: path.join(dir, 'main.ts') })
  assert.deepEqual(rewrittenTypeErrors(dir, rewrites).filter((error) => error === expected), [expected])
})

test('a nested package manifest is copied with the JavaScript it scopes', () => {
  const dir = fixture({
    'main.ts': bootstrap(),
    'legacy/package.json': JSON.stringify({ type: 'commonjs' }),
    'legacy/helper.js': "exports.greeting = () => 'from-cjs'\n",
    'legacy/helper.d.ts': 'export declare const greeting: () => string\n',
    'app.module.ts': "import { greeting } from './legacy/helper.js'\n" + helloController(`@Get()
  hello(): string {
    return greeting()
  }`)
  })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'from-cjs' }])
})

test('a bootstrap in a separate file is served through its initializer', () => {
  const dir = fixture({ 'main.ts': "import './bootstrap.ts'\n", 'bootstrap.ts': bootstrap(), 'app.module.ts': helloController() })
  assert.deepEqual(served(dir, ['GET /']), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('an .mts root module is emitted and served', () => {
  const dir = fixture({ 'main.ts': bootstrap('AppModule', './app.module.mts'), 'app.module.mts': helloController() }, { compilerOptions: { ...compilerOptions }, files: ['main.ts'] })
  assert.deepEqual(served(dir, ['GET /'], 'app.module.mts'), [{ route: 'GET /', kind: 'text', status: 200, body: 'hello' }])
})

test('an entry reaches @nestjs/core through a # package import', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#bootstrap': './bootstrap.ts' } }),
    'main.ts': `import '#bootstrap'
`,
    'bootstrap.ts': bootstrap()
  })
  assert.equal(entryReachesNestCore({ ts, entry: path.join(dir, 'main.ts') }), true)
})

test('an entry reaches @nestjs/core through a value import, directly or through a local module', () => {
  const reaches = (files) => entryReachesNestCore({ ts, entry: path.join(fixture(files), 'main.ts') })
  assert.equal(reaches({ 'main.ts': bootstrap() }), true)
  assert.equal(reaches({ 'main.ts': `import './bootstrap.js'\n`, 'bootstrap.ts': bootstrap() }), true)
  assert.equal(reaches({ 'main.ts': `export { start } from './bootstrap.ts'\n`, 'bootstrap.ts': `export { NestFactory as start } from '@nestjs/core'\n` }), true)
  assert.equal(reaches({ 'main.ts': `import type { INestApplication } from '@nestjs/core'\nexport const app: INestApplication | null = null\n` }), false)
  assert.equal(reaches({ 'main.ts': `import { type INestApplication } from '@nestjs/core'\nexport const app: INestApplication | null = null\n` }), false)
  assert.equal(reaches({ 'main.ts': `import { start } from './types.ts'\nexport const app = start\n`, 'types.ts': `export type { INestApplication } from '@nestjs/core'\nexport const start = 1\n` }), false)
})

let failed = 0
for (const { name, body } of cases) {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n${String(error.message).split('\n').map((line) => `     ${line}`).join('\n')}`)
  }
}
fs.rmSync(scratch, { recursive: true, force: true })
console.log(`${cases.length - failed} AOT case(s) passed, ${failed} failed`)
if (failed > 0) process.exit(1)
