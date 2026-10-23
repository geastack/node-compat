import type { IncomingMessage, ServerResponse } from 'node:http'
import { parse as parseQuerystring } from '../fast-querystring/index'
import isRegexSafe from '../safe-regex2/index'
import { safeDecodeURI, safeDecodeURIComponent, safeDecodeURINativeScan, safeDecodeURICharScan, MIN_NATIVE_SCAN_LENGTH } from './lib/url-sanitizer'

export type HTTPMethod =
  | 'ACL'
  | 'BIND'
  | 'CHECKOUT'
  | 'CONNECT'
  | 'COPY'
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'LINK'
  | 'LOCK'
  | 'M-SEARCH'
  | 'MERGE'
  | 'MKACTIVITY'
  | 'MKCALENDAR'
  | 'MKCOL'
  | 'MOVE'
  | 'NOTIFY'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PROPFIND'
  | 'PROPPATCH'
  | 'PURGE'
  | 'PUT'
  | 'QUERY'
  | 'REBIND'
  | 'REPORT'
  | 'SEARCH'
  | 'SOURCE'
  | 'SUBSCRIBE'
  | 'TRACE'
  | 'UNBIND'
  | 'UNLINK'
  | 'UNLOCK'
  | 'UNSUBSCRIBE'

export const httpMethods: readonly HTTPMethod[] = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE',
  'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE',
  'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS',
  'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY',
  'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE',
  'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'
]

export type Req = IncomingMessage
export type Res = ServerResponse

export interface Params {
  [name: string]: string | undefined
}

export interface SearchParams {
  [name: string]: string | string[]
}

export type QuerystringParser = (query: string) => SearchParams

export type Handler<Store> = (req: Req, res: Res, params: Params, store: Store | null, searchParams: SearchParams) => void

export type Done = (err: Error | null) => void

const constraintsEqual = (left: Constraints, right: Constraints): boolean => {
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  for (const name of names) {
    if (!Object.hasOwn(right, name)) return false
    const a = left[name]
    const b = right[name]
    if (a instanceof RegExp && b instanceof RegExp) {
      if (a.source !== b.source || a.flags !== b.flags) return false
    } else if (a !== b) {
      return false
    }
  }
  return true
}

export type ConstraintValue = string | number | boolean | RegExp | null

export interface Constraints {
  [name: string]: ConstraintValue
}

export type DerivedValue = string | number | boolean | undefined

export interface DerivedConstraints {
  [name: string]: DerivedValue
}

type HeaderValue = string | string[] | undefined
const headerValue = (value: HeaderValue): DerivedValue => (Array.isArray(value) ? value.join(', ') : value)

export interface ConstraintStorage {
  get(value: ConstraintValue | DerivedValue): number | null | undefined
  set(value: ConstraintValue, handlers: number): void
}

export type DeriveDone = (err: Error | null, value?: DerivedValue) => void

export interface ConstraintStrategy {
  name: string
  mustMatchWhenDerived?: boolean
  storage(): ConstraintStorage
  validate?(value: ConstraintValue): void
  deriveConstraint?(req: Req): DerivedValue
  deriveConstraintAsync?(req: Req, done: DeriveDone): void
}

export interface ConstraintStrategies {
  [name: string]: ConstraintStrategy
}

export interface RouteOptions {
  constraints?: Constraints
}

export interface Route<Store> {
  method: string
  path: string
  pattern: string
  params: string[]
  opts: RouteOptions
  handler: Handler<Store>
  store: Store | null
}

export interface FindResult<Store> {
  handler: Handler<Store>
  params: Params
  store: Store | null
  searchParams: SearchParams
}

export interface FindRouteResult<Store> {
  handler: Handler<Store>
  store: Store | null
  params: string[]
}

export type PrettyMetaValue = string | number | boolean | null | undefined | RegExp | PrettyMetaValue[]

export interface PrettyMeta {
  [key: string]: PrettyMetaValue
}

export interface PrettyPrintOptions {
  method?: HTTPMethod
  commonPrefix?: boolean
  includeMeta?: boolean | string[]
}

export type DefaultRoute = (req: Req, res: Res) => void
export type PathRoute = (path: string, req: Req, res: Res) => void

export interface Config<Store> {
  ignoreTrailingSlash?: boolean
  ignoreDuplicateSlashes?: boolean
  allowUnsafeRegex?: boolean
  caseSensitive?: boolean
  maxParamLength?: number
  useSemicolonDelimiter?: boolean
  querystringParser?: QuerystringParser
  defaultRoute?: DefaultRoute
  onBadUrl?: PathRoute
  onMaxParamLength?: PathRoute
  constraints?: ConstraintStrategies
  buildPrettyMeta?: (route: Route<Store>) => PrettyMeta
}

export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new AssertionError(message)
}

const OPTIONAL_PARAM_REGEXP = /(\/:[^/()]*?)\?(\/?)/
const REMOVE_DUPLICATE_SLASHES_REGEXP = /\/\/+/g
const REGEXP_SPECIAL = '.*+?^${}()|[]\\'

class SemVerStore implements ConstraintStorage {
  private readonly store = new Map<string, number>()
  private maxMajor = 0
  private readonly maxMinors = new Map<number, number>()
  private readonly maxPatches = new Map<string, number>()

  set(version: ConstraintValue, store: number): void {
    if (typeof version !== 'string') throw new TypeError('Version should be a string')
    const parts = version.split('.')
    const majorText = parts[0] ?? ''
    if (Number.isNaN(Number(majorText))) throw new TypeError('Major version must be a numeric value')
    const major = Number(majorText)
    const minor = Number(parts[1]) || 0
    const patch = Number(parts[2]) || 0

    if (major >= this.maxMajor) {
      this.maxMajor = major
      this.store.set('x', store)
      this.store.set('*', store)
      this.store.set('x.x', store)
      this.store.set('x.x.x', store)
    }
    if (minor >= (this.maxMinors.get(major) ?? 0)) {
      this.maxMinors.set(major, minor)
      this.store.set(`${major}.x`, store)
      this.store.set(`${major}.x.x`, store)
    }
    if (patch >= (this.maxPatches.get(`${major}.${minor}`) ?? 0)) {
      this.maxPatches.set(`${major}.${minor}`, patch)
      this.store.set(`${major}.${minor}.x`, store)
    }
    this.store.set(`${major}.${minor}.${patch}`, store)
  }

  get(version: ConstraintValue | DerivedValue): number | undefined {
    return typeof version === 'string' ? this.store.get(version) : undefined
  }
}

const acceptVersionStrategy: ConstraintStrategy = {
  name: 'version',
  mustMatchWhenDerived: true,
  storage: () => new SemVerStore(),
  validate(value: ConstraintValue): void {
    assert(typeof value === 'string', 'Version should be a string')
  },
  deriveConstraint: (req: Req): DerivedValue => headerValue(req.headers['accept-version'])
}

interface RegexHost {
  host: RegExp
  value: number
}

const withoutGlobalFlags = (flags: string): string => {
  let kept = ''
  for (const flag of flags) if (flag !== 'g' && flag !== 'y') kept += flag
  return kept
}

class HostStorage implements ConstraintStorage {
  private readonly hosts = new Map<string, number>()
  private readonly regexHosts: RegexHost[] = []
  private readonly regexCache = new Map<string, number | undefined>()

  get(host: ConstraintValue | DerivedValue): number | undefined {
    const exact = typeof host === 'string' ? this.hosts.get(host) : undefined
    if (exact) return exact
    if (this.regexHosts.length === 0) return undefined
    const key = String(host)
    if (this.regexCache.has(key)) return this.regexCache.get(key)
    for (const regex of this.regexHosts) {
      if (regex.host.test(key)) {
        this.regexCache.set(key, regex.value)
        return regex.value
      }
    }
    this.regexCache.set(key, undefined)
    return undefined
  }

  set(host: ConstraintValue, value: number): void {
    if (host instanceof RegExp) {
      const safeRegex = new RegExp(host.source, withoutGlobalFlags(host.flags))
      this.regexHosts.push({ host: safeRegex, value })
      this.regexCache.clear()
    } else {
      this.hosts.set(String(host), value)
    }
  }
}

const acceptHostStrategy: ConstraintStrategy = {
  name: 'host',
  mustMatchWhenDerived: false,
  storage: () => new HostStorage(),
  validate(value: ConstraintValue): void {
    assert(typeof value === 'string' || value instanceof RegExp, 'Host should be a string or a RegExp')
  },
  deriveConstraint: (req: Req): DerivedValue => headerValue(req.headers.host || req.headers[':authority'])
}

class MethodStorage implements ConstraintStorage {
  private readonly handlers = new Map<string, number>()
  get(type: ConstraintValue | DerivedValue): number | null {
    return this.handlers.get(String(type)) ?? null
  }
  set(type: ConstraintValue, store: number): void {
    this.handlers.set(String(type), store)
  }
}

const httpMethodStrategy: ConstraintStrategy = {
  name: '__fmw_internal_strategy_merged_tree_http_method__',
  storage: () => new MethodStorage(),
  deriveConstraint: (req: Req): DerivedValue => req.method,
  mustMatchWhenDerived: true
}

interface RegisteredStrategy {
  strategy: ConstraintStrategy
  isCustom: boolean
  isAsync: boolean
}

class Constrainer {
  readonly strategies = new Map<string, RegisteredStrategy>()
  readonly strategiesInUse = new Set<string>()
  readonly asyncStrategiesInUse = new Set<string>()

  constructor(customStrategies: ConstraintStrategies | undefined) {
    this.strategies.set('version', { strategy: acceptVersionStrategy, isCustom: false, isAsync: false })
    this.strategies.set('host', { strategy: acceptHostStrategy, isCustom: false, isAsync: false })
    if (customStrategies) for (const strategy of Object.values(customStrategies)) this.addConstraintStrategy(strategy)
  }

  isStrategyUsed(strategyName: string): boolean {
    return this.strategiesInUse.has(strategyName) || this.asyncStrategiesInUse.has(strategyName)
  }

  hasConstraintStrategy(strategyName: string): boolean {
    const registered = this.strategies.get(strategyName)
    if (registered !== undefined) return registered.isCustom || this.isStrategyUsed(strategyName)
    return false
  }

  addConstraintStrategy(strategy: ConstraintStrategy): void {
    assert(typeof strategy.name === 'string' && strategy.name !== '', 'strategy.name is required.')
    assert(typeof strategy.storage === 'function', 'strategy.storage function is required.')
    const isAsync = typeof strategy.deriveConstraintAsync === 'function'
    assert(isAsync || typeof strategy.deriveConstraint === 'function', 'strategy.deriveConstraint function is required.')

    const existing = this.strategies.get(strategy.name)
    if (existing !== undefined && existing.isCustom) throw new Error(`There already exists a custom constraint with the name ${strategy.name}.`)
    if (this.isStrategyUsed(strategy.name)) throw new Error(`There already exists a route with ${strategy.name} constraint.`)

    this.strategies.set(strategy.name, { strategy, isCustom: true, isAsync })
    if (strategy.mustMatchWhenDerived) this.noteUsage([strategy.name])
  }

  deriveConstraints(req: Req): DerivedConstraints | undefined {
    return this.deriveSyncConstraints(req)
  }

  deriveConstraintsAsync(req: Req, done: (err: Error | null, constraints?: DerivedConstraints) => void): void {
    this.deriveAsyncConstraints(this.deriveSyncConstraints(req), req, done)
  }

  private deriveSyncConstraints(req: Req): DerivedConstraints | undefined {
    if (this.strategiesInUse.size === 0) return undefined
    const derived: DerivedConstraints = {}
    for (const key of this.strategiesInUse) {
      const registered = this.strategies.get(key)
      if (registered === undefined) continue
      if (!registered.isCustom) {
        if (key === 'version') derived.version = headerValue(req.headers['accept-version'])
        else derived.host = headerValue(req.headers.host || req.headers[':authority'])
      } else if (registered.strategy.deriveConstraint) {
        derived[registered.strategy.name] = registered.strategy.deriveConstraint(req)
      }
    }
    return derived
  }

  noteUsage(constraintNames: string[]): void {
    for (const key of constraintNames) {
      const registered = this.strategies.get(key)
      if (registered === undefined) continue
      if (registered.isAsync) this.asyncStrategiesInUse.add(key)
      else this.strategiesInUse.add(key)
    }
  }

  newStoreForConstraint(constraint: string): ConstraintStorage {
    const registered = this.strategies.get(constraint)
    if (registered === undefined) throw new Error(`No strategy registered for constraint key ${constraint}`)
    return registered.strategy.storage()
  }

  validateConstraints(constraints: Constraints): void {
    for (const key of Object.keys(constraints)) {
      const value = constraints[key]
      if (value === undefined) throw new Error("Can't pass an undefined constraint value, must pass null or no key at all")
      const registered = this.strategies.get(key)
      if (registered === undefined) throw new Error(`No strategy registered for constraint key ${key}`)
      if (registered.strategy.validate) registered.strategy.validate(value)
    }
  }

  private deriveAsyncConstraints(
    constraints: DerivedConstraints | undefined,
    req: Req,
    done: (err: Error | null, constraints?: DerivedConstraints) => void
  ): void {
    let asyncConstraintsCount = this.asyncStrategiesInUse.size
    if (asyncConstraintsCount === 0) {
      done(null, constraints)
      return
    }
    let errored = false
    const derived: DerivedConstraints = constraints ?? {}
    for (const key of this.asyncStrategiesInUse) {
      const registered = this.strategies.get(key)
      if (registered === undefined || !registered.strategy.deriveConstraintAsync) continue
      registered.strategy.deriveConstraintAsync(req, (err: Error | null, constraintValue?: DerivedValue): void => {
        if (errored) return
        if (err !== null) {
          errored = true
          done(err)
          return
        }
        derived[key] = constraintValue
        if (--asyncConstraintsCount === 0) done(null, derived)
      })
    }
  }
}

interface HandlerSlot<Store> {
  params: string[]
  constraints: Constraints
  handler: Handler<Store>
  store: Store | null
}

const createParamsObject = (names: string[], values: string[]): Params => {
  const params: Params = {}
  for (let i = 0; i < names.length; i++) params[names[i] ?? ''] = values[i]
  return params
}

class HandlerStorage<Store> {
  unconstrainedHandler: HandlerSlot<Store> | null = null
  readonly constraints: string[] = []
  readonly handlers: HandlerSlot<Store>[] = []
  private readonly constrainedHandlerStores = new Map<string, ConstraintStorage>()
  private readonly masks: number[] = []
  private readonly mustMatch: boolean[] = []
  private readonly absentMustMatch: string[] = []
  private compiled = false

  getMatchingHandler(derivedConstraints: DerivedConstraints | undefined): HandlerSlot<Store> | null {
    if (derivedConstraints === undefined) return this.unconstrainedHandler
    return this.getHandlerMatchingConstraints(derivedConstraints)
  }

  addHandler(constrainer: Constrainer, route: Route<Store>): void {
    const constraints = route.opts.constraints ?? {}
    const handlerObject: HandlerSlot<Store> = { params: route.params, constraints, handler: route.handler, store: route.store || null }

    const constraintsNames = Object.keys(constraints)
    if (constraintsNames.length === 0) this.unconstrainedHandler = handlerObject

    for (const constraint of constraintsNames) {
      if (!this.constraints.includes(constraint)) {
        if (constraint === 'version') this.constraints.unshift(constraint)
        else this.constraints.push(constraint)
      }
    }

    const isMergedTree = constraintsNames.includes(httpMethodStrategy.name)
    if (!isMergedTree && this.handlers.length >= 31) {
      throw new Error('find-my-way supports a maximum of 31 route handlers per node when there are constraints, limit reached')
    }

    this.handlers.push(handlerObject)
    this.handlers.sort((a, b) => Object.keys(a.constraints).length - Object.keys(b.constraints).length)

    if (!isMergedTree) this.compileGetHandlerMatchingConstraints(constrainer)
  }

  private getHandlerMatchingConstraints(derivedConstraints: DerivedConstraints): HandlerSlot<Store> | null {
    if (!this.compiled) return null
    let candidates = (1 << this.handlers.length) - 1
    for (let i = 0; i < this.constraints.length; i++) {
      const constraint = this.constraints[i] ?? ''
      const mask = this.masks[i] ?? 0
      const value = derivedConstraints[constraint]
      if (value === undefined) {
        candidates &= mask
      } else {
        const matches = this.constrainedHandlerStores.get(constraint)?.get(value) || 0
        candidates &= this.mustMatch[i] ? matches : matches | mask
      }
      if (candidates === 0) return null
    }
    for (const constraint of this.absentMustMatch) if (derivedConstraints[constraint] !== undefined) return null
    return this.handlers[31 - Math.clz32(candidates)] ?? null
  }

  private compileGetHandlerMatchingConstraints(constrainer: Constrainer): void {
    this.constrainedHandlerStores.clear()
    this.masks.length = 0
    this.mustMatch.length = 0
    this.absentMustMatch.length = 0

    for (const constraint of this.constraints) {
      const store = constrainer.newStoreForConstraint(constraint)
      this.constrainedHandlerStores.set(constraint, store)
      let mask = 0
      for (let i = 0; i < this.handlers.length; i++) {
        const constraintValue = this.handlers[i]?.constraints[constraint]
        if (constraintValue !== undefined) {
          let indexes = store.get(constraintValue) || 0
          indexes |= 1 << i
          store.set(constraintValue, indexes)
          mask |= 1 << i
        }
      }
      this.masks.push(~mask)
      this.mustMatch.push(constrainer.strategies.get(constraint)?.strategy.mustMatchWhenDerived === true)
    }

    for (const [name, registered] of constrainer.strategies) {
      if (registered.strategy.mustMatchWhenDerived && !this.constraints.includes(name)) this.absentMustMatch.push(name)
    }
    this.compiled = true
  }
}

interface BrotherState<Store> {
  paramsCount: number
  brotherPathIndex: number
  brotherNode: TreeNode<Store>
}

type TreeNode<Store> = StaticNode<Store> | ParametricNode<Store> | WildcardNode<Store>

class Node<Store> {
  isLeafNode = false
  routes: Route<Store>[] | null = null
  handlerStorage: HandlerStorage<Store> | null = null

  addRoute(route: Route<Store>, constrainer: Constrainer): void {
    if (this.routes === null) this.routes = []
    if (this.handlerStorage === null) this.handlerStorage = new HandlerStorage<Store>()
    this.isLeafNode = true
    this.routes.push(route)
    this.handlerStorage.addHandler(constrainer, route)
  }
}

class ParentNode<Store> extends Node<Store> {
  readonly staticChildrenCharCodes: number[] = []
  readonly staticChildrenNodes: StaticNode<Store>[] = []

  setStaticChild(label: string, node: StaticNode<Store>): void {
    const charCode = label.charCodeAt(0)
    const index = this.staticChildrenCharCodes.indexOf(charCode)
    if (index === -1) {
      this.staticChildrenCharCodes.push(charCode)
      this.staticChildrenNodes.push(node)
    } else {
      this.staticChildrenNodes[index] = node
    }
  }

  findStaticMatchingChild(path: string, pathIndex: number): StaticNode<Store> | null {
    const charCode = path.charCodeAt(pathIndex)
    const charCodes = this.staticChildrenCharCodes
    for (let i = 0; i < charCodes.length; i++) {
      if (charCodes[i] === charCode) {
        const staticChild = this.staticChildrenNodes[i]
        if (staticChild !== undefined && staticChild.matchPrefix(path, pathIndex)) return staticChild
        return null
      }
    }
    return null
  }

  getStaticChild(path: string, pathIndex = 0): ParentNode<Store> | null {
    if (path.length === pathIndex) return this
    const staticChild = this.findStaticMatchingChild(path, pathIndex)
    if (staticChild) return staticChild.getStaticChild(path, pathIndex + staticChild.prefix.length)
    return null
  }

  createStaticChild(path: string): ParentNode<Store> {
    if (path.length === 0) return this

    const childIndex = this.staticChildrenCharCodes.indexOf(path.charCodeAt(0))
    let staticChild = childIndex === -1 ? undefined : this.staticChildrenNodes[childIndex]
    if (staticChild) {
      let i = 1
      for (; i < staticChild.prefix.length; i++) {
        if (path.charCodeAt(i) !== staticChild.prefix.charCodeAt(i)) {
          staticChild = staticChild.split(this, i)
          break
        }
      }
      return staticChild.createStaticChild(path.slice(i))
    }

    const node = new StaticNode<Store>(path)
    this.setStaticChild(path.charAt(0), node)
    return node
  }
}

class StaticNode<Store> extends ParentNode<Store> {
  prefix: string
  wildcardChild: WildcardNode<Store> | null = null
  readonly parametricChildren: ParametricNode<Store>[] = []

  constructor(prefix: string) {
    super()
    this.prefix = prefix
  }

  matchPrefix(path: string, pathIndex: number): boolean {
    const prefix = this.prefix
    for (let i = 1; i < prefix.length; i++) if (path.charCodeAt(pathIndex + i) !== prefix.charCodeAt(i)) return false
    return true
  }

  getParametricChild(regex: RegExp | null): ParametricNode<Store> | null {
    const regexpSource = regex === null ? null : regex.source
    for (const child of this.parametricChildren) {
      const childRegexSource = child.regex === null ? null : child.regex.source
      if (childRegexSource === regexpSource) return child
    }
    return null
  }

  createParametricChild(regex: RegExp | null, staticSuffix: string | null, nodePath: string): ParametricNode<Store> {
    const existing = this.getParametricChild(regex)
    if (existing) {
      existing.nodePaths.add(nodePath)
      return existing
    }

    const parametricChild = new ParametricNode<Store>(regex, staticSuffix, nodePath)
    this.parametricChildren.push(parametricChild)
    this.parametricChildren.sort((child1, child2) => {
      if (!child1.isRegex) return 1
      if (!child2.isRegex) return -1
      if (child1.staticSuffix === null) return 1
      if (child2.staticSuffix === null) return -1
      if (child2.staticSuffix.endsWith(child1.staticSuffix)) return 1
      if (child1.staticSuffix.endsWith(child2.staticSuffix)) return -1
      return 0
    })
    return parametricChild
  }

  getWildcardChild(): WildcardNode<Store> | null {
    return this.wildcardChild
  }

  createWildcardChild(): WildcardNode<Store> {
    this.wildcardChild = this.wildcardChild ?? new WildcardNode<Store>()
    return this.wildcardChild
  }

  split(parentNode: ParentNode<Store>, length: number): StaticNode<Store> {
    const parentPrefix = this.prefix.slice(0, length)
    const childPrefix = this.prefix.slice(length)

    this.prefix = childPrefix

    const staticNode = new StaticNode<Store>(parentPrefix)
    staticNode.setStaticChild(childPrefix.charAt(0), this)
    parentNode.setStaticChild(parentPrefix.charAt(0), staticNode)
    return staticNode
  }

  getNextNode(path: string, pathIndex: number, nodeStack: BrotherState<Store>[], paramsCount: number): TreeNode<Store> | null {
    let node: TreeNode<Store> | null = this.findStaticMatchingChild(path, pathIndex)
    let parametricBrotherNodeIndex = 0

    if (node === null) {
      if (this.parametricChildren.length === 0) return this.wildcardChild
      node = this.parametricChildren[0] ?? null
      parametricBrotherNodeIndex = 1
    }

    if (this.wildcardChild !== null) nodeStack.push({ paramsCount, brotherPathIndex: pathIndex, brotherNode: this.wildcardChild })

    for (let i = this.parametricChildren.length - 1; i >= parametricBrotherNodeIndex; i--) {
      const brother = this.parametricChildren[i]
      if (brother !== undefined) nodeStack.push({ paramsCount, brotherPathIndex: pathIndex, brotherNode: brother })
    }
    return node
  }
}

class ParametricNode<Store> extends ParentNode<Store> {
  readonly isRegex: boolean
  readonly regex: RegExp | null
  readonly staticSuffix: string | null
  readonly nodePaths: Set<string>

  constructor(regex: RegExp | null, staticSuffix: string | null, nodePath: string) {
    super()
    this.isRegex = regex !== null
    this.regex = regex
    this.staticSuffix = staticSuffix
    this.nodePaths = new Set([nodePath])
  }

  getNextNode(path: string, pathIndex: number, _nodeStack: BrotherState<Store>[], _paramsCount: number): TreeNode<Store> | null {
    return this.findStaticMatchingChild(path, pathIndex)
  }
}

class WildcardNode<Store> extends Node<Store> {
  getNextNode(_path: string, _pathIndex: number, _nodeStack: BrotherState<Store>[], _paramsCount: number): TreeNode<Store> | null {
    return null
  }
}

interface PrintTree {
  readonly children: Map<string, PrintTree>
  data: string
}

interface PrintableRoute {
  method: string
  constraints: Constraints
  metaData: { [key: string]: string }
}

const printObjectTree = (tree: PrintTree, parentPrefix = ''): string => {
  let text = ''
  const keys = [...tree.children.keys()]
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? ''
    const value = tree.children.get(key)
    if (value === undefined) continue
    const isLast = i === keys.length - 1
    const nodePrefix = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '
    const prefixedNodeData = value.data.replaceAll('\n', '\n' + parentPrefix + childPrefix)
    text += parentPrefix + nodePrefix + key + prefixedNodeData + '\n'
    text += printObjectTree(value, parentPrefix + childPrefix)
  }
  return text
}

const parseMeta = (meta: PrettyMetaValue): PrettyMetaValue => {
  if (Array.isArray(meta)) return meta.map((m) => parseMeta(m))
  if (meta instanceof RegExp) return meta.toString()
  return meta
}

const stringifyMeta = (meta: PrettyMetaValue): string => JSON.stringify(parseMeta(meta))

const serializeConstraints = (constraints: Constraints): string => {
  const parts: string[] = []
  for (const key of Object.keys(constraints)) {
    const value = constraints[key]
    const serialized = value instanceof RegExp ? JSON.stringify(value.toString()) : JSON.stringify(value)
    parts.push(`${JSON.stringify(key)}:${serialized}`)
  }
  return `{${parts.join(',')}}`
}

const metaDataEqual = (left: { [key: string]: string }, right: { [key: string]: string }): boolean => {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key) || left[key] !== right[key]) return false
  }
  return true
}

const serializeRoute = (route: PrintableRoute): string => {
  let serializedRoute = ` (${route.method})`
  if (Object.keys(route.constraints).length !== 0) serializedRoute += ' ' + serializeConstraints(route.constraints)
  for (const key of Object.keys(route.metaData)) serializedRoute += `\n• (${key}) ${route.metaData[key]}`
  return serializedRoute
}

const mergeSimilarRoutes = (routes: PrintableRoute[]): PrintableRoute[] => {
  const merged: PrintableRoute[] = []
  for (const route of routes) {
    let found = false
    for (const nodeRoute of merged) {
      if (constraintsEqual(route.constraints, nodeRoute.constraints) && metaDataEqual(route.metaData, nodeRoute.metaData)) {
        nodeRoute.method += ', ' + route.method
        found = true
        break
      }
    }
    if (!found) merged.push(route)
  }
  return merged
}

const escapeRegExp = (text: string): string => {
  let escaped = ''
  for (const char of text) escaped += REGEXP_SPECIAL.includes(char) ? '\\' + char : char
  return escaped
}

const getPathFromAbsoluteUrl = (url: string): string | null => {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) return url

  const scheme = url.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return url

  const authorityStart = schemeEnd + 3
  let authorityEnd = url.length

  const pathStart = url.indexOf('/', authorityStart)
  if (pathStart !== -1) authorityEnd = pathStart

  const queryStart = url.indexOf('?', authorityStart)
  if (queryStart !== -1 && queryStart < authorityEnd) authorityEnd = queryStart

  if (url.indexOf('#', authorityStart) !== -1 || authorityEnd === authorityStart) return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${scheme}:` || parsed.host.length === 0) return null
  } catch {
    return null
  }

  if (authorityEnd === url.length) return '/'
  if (authorityEnd === queryStart) return '/' + url.slice(queryStart)
  return url.slice(pathStart)
}

export function removeDuplicateSlashes(path: string): string {
  return path.indexOf('//') !== -1 ? path.replace(REMOVE_DUPLICATE_SLASHES_REGEXP, '/') : path
}

export function trimLastSlash(path: string): string {
  if (path.length > 1 && path.charCodeAt(path.length - 1) === 47) return path.slice(0, -1)
  return path
}

export function sanitizeUrlPath(url: string, useSemicolonDelimiter = false): string {
  const decoded = safeDecodeURI(url, useSemicolonDelimiter)
  if (decoded.shouldDecodeParam) return safeDecodeURIComponent(decoded.path)
  return decoded.path
}

const trimRegExpStartAndEnd = (regexString: string): string => {
  if (regexString.charCodeAt(1) === 94) regexString = regexString.slice(0, 1) + regexString.slice(2)
  if (regexString.charCodeAt(regexString.length - 2) === 36) {
    regexString = regexString.slice(0, regexString.length - 2) + regexString.slice(regexString.length - 1)
  }
  return regexString
}

const getClosingParenthensePosition = (path: string, idx: number): number => {
  let parentheses = 1
  while (idx < path.length) {
    idx++
    if (path.charCodeAt(idx) === 92) {
      idx++
      continue
    }
    if (path.charCodeAt(idx) === 41) parentheses--
    else if (path.charCodeAt(idx) === 40) parentheses++
    if (!parentheses) return idx
  }
  throw new TypeError('Invalid regexp expression in "' + path + '"')
}

const defaultQuerystringParser: QuerystringParser = (query: string): SearchParams => {
  if (query.length === 0) return {}
  const parsed: SearchParams = parseQuerystring(query)
  return parsed
}

const defaultBuildPrettyMeta = (): PrettyMeta => ({})

interface OptionalParamSplit {
  pathFull: string
  pathOptional: string
}

const splitOptionalParam = (path: string): OptionalParamSplit | null => {
  const match = OPTIONAL_PARAM_REGEXP.exec(path)
  if (match === null) return null
  assert(path.length === match.index + match[0].length, 'Optional Parameter needs to be the last parameter of the path')
  const head = path.slice(0, match.index)
  const param = match[1] ?? ''
  const tail = match[2] ?? ''
  return { pathFull: head + param + tail, pathOptional: head + tail || '/' }
}

export class Router<Store> {
  private readonly opts: Config<Store>
  readonly defaultRoute: DefaultRoute | null
  readonly onBadUrl: PathRoute | null
  readonly onMaxParamLength: PathRoute | null
  readonly buildPrettyMeta: (route: Route<Store>) => PrettyMeta
  readonly querystringParser: QuerystringParser
  readonly caseSensitive: boolean
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  readonly maxParamLength: number
  readonly allowUnsafeRegex: boolean
  readonly useSemicolonDelimiter: boolean
  readonly constrainer: Constrainer
  routes: Route<Store>[] = []
  trees = new Map<string, StaticNode<Store>>()
  private treeGET: StaticNode<Store> | null = null

  constructor(opts: Config<Store> = {}) {
    this.opts = opts
    this.defaultRoute = opts.defaultRoute ?? null
    this.onBadUrl = opts.onBadUrl ?? null
    this.buildPrettyMeta = opts.buildPrettyMeta ?? defaultBuildPrettyMeta
    this.querystringParser = opts.querystringParser ?? defaultQuerystringParser
    this.caseSensitive = opts.caseSensitive === undefined ? true : opts.caseSensitive
    this.ignoreTrailingSlash = opts.ignoreTrailingSlash || false
    this.ignoreDuplicateSlashes = opts.ignoreDuplicateSlashes || false
    this.maxParamLength = opts.maxParamLength || 100
    this.onMaxParamLength = opts.onMaxParamLength ?? null
    this.allowUnsafeRegex = opts.allowUnsafeRegex || false
    this.constrainer = new Constrainer(opts.constraints)
    this.useSemicolonDelimiter = opts.useSemicolonDelimiter || false
  }

  on(method: HTTPMethod | HTTPMethod[], path: string, handler: Handler<Store>): void
  on(method: HTTPMethod | HTTPMethod[], path: string, opts: RouteOptions, handler: Handler<Store>): void
  on(method: HTTPMethod | HTTPMethod[], path: string, handler: Handler<Store>, store: Store): void
  on(method: HTTPMethod | HTTPMethod[], path: string, opts: RouteOptions, handler: Handler<Store>, store: Store): void
  on(method: HTTPMethod | HTTPMethod[], path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store, store?: Store): void {
    if (typeof optsOrHandler === 'function') {
      this.addRoute(method, path, {}, optsOrHandler, handlerOrStore === undefined ? null : (handlerOrStore as Store))
    } else {
      assert(typeof handlerOrStore === 'function', 'Handler should be a function')
      this.addRoute(method, path, optsOrHandler, handlerOrStore as Handler<Store>, store === undefined ? null : store)
    }
  }

  private addRoute(method: HTTPMethod | HTTPMethod[], path: string, opts: RouteOptions, handler: Handler<Store>, store: Store | null): void {
    assert(typeof path === 'string', 'Path should be a string')
    assert(path.length > 0, 'The path could not be empty')
    assert(path[0] === '/' || path[0] === '*', 'The first character of a path should be `/` or `*`')
    assert(typeof handler === 'function', 'Handler should be a function')

    const optional = splitOptionalParam(path)
    if (optional !== null) {
      this.addRoute(method, optional.pathFull, opts, handler, store)
      this.addRoute(method, optional.pathOptional, opts, handler, store)
      return
    }

    if (this.ignoreDuplicateSlashes) path = removeDuplicateSlashes(path)
    if (this.ignoreTrailingSlash) path = trimLastSlash(path)

    const methods: HTTPMethod[] = Array.isArray(method) ? method : [method]
    for (const one of methods) {
      assert(typeof one === 'string', 'Method should be a string')
      assert(httpMethods.includes(one), `Method '${one}' is not an http method.`)
      this.registerRoute(one, path, opts, handler, store)
    }
  }

  private registerRoute(method: string, path: string, opts: RouteOptions, handler: Handler<Store>, store: Store | null): void {
    let constraints: Constraints = {}
    if (opts.constraints !== undefined) {
      assert(typeof opts.constraints === 'object' && opts.constraints !== null, 'Constraints should be an object')
      if (Object.keys(opts.constraints).length !== 0) constraints = opts.constraints
    }

    this.constrainer.validateConstraints(constraints)
    this.constrainer.noteUsage(Object.keys(constraints))

    let tree = this.trees.get(method)
    if (tree === undefined) {
      tree = new StaticNode<Store>('/')
      this.trees.set(method, tree)
    }

    let pattern = path
    if (pattern === '*' && tree.prefix.length !== 0) {
      const currentRoot = tree
      tree = new StaticNode<Store>('')
      tree.setStaticChild('/', currentRoot)
      this.trees.set(method, tree)
    }

    let currentNode: ParentNode<Store> = tree
    if (method === 'GET') this.treeGET = tree
    let parentNodePathIndex = tree.prefix.length

    const params: string[] = []
    for (let i = 0; i <= pattern.length; i++) {
      if (pattern.charCodeAt(i) === 58 && pattern.charCodeAt(i + 1) === 58) {
        i++
        continue
      }

      const isParametricNode = pattern.charCodeAt(i) === 58 && pattern.charCodeAt(i + 1) !== 58
      const isWildcardNode = pattern.charCodeAt(i) === 42

      if (isParametricNode || isWildcardNode || (i === pattern.length && i !== parentNodePathIndex)) {
        let staticNodePath = pattern.slice(parentNodePathIndex, i)
        if (!this.caseSensitive) staticNodePath = staticNodePath.toLowerCase()
        staticNodePath = staticNodePath.replaceAll('::', ':')
        staticNodePath = staticNodePath.replaceAll('%', '%25')
        currentNode = currentNode.createStaticChild(staticNodePath)
      }

      if (isParametricNode) {
        let isRegexNode = false
        let isParamSafe = true
        let backtrack = ''
        const regexps: string[] = []
        let nodePatternParts = ''

        let lastParamStartIndex = i + 1
        for (let j = lastParamStartIndex; ; j++) {
          const charCode = pattern.charCodeAt(j)

          const isRegexParam = charCode === 40
          const isStaticPart = charCode === 45 || charCode === 46
          const isEndOfNode = charCode === 47 || j === pattern.length

          if (isRegexParam || isStaticPart || isEndOfNode) {
            const paramName = pattern.slice(lastParamStartIndex, j)
            params.push(paramName)

            isRegexNode = isRegexNode || isRegexParam || isStaticPart

            if (isRegexParam) {
              const endOfRegexIndex = getClosingParenthensePosition(pattern, j)
              const regexString = pattern.slice(j, endOfRegexIndex + 1)

              if (!this.allowUnsafeRegex) assert(isRegexSafe(new RegExp(regexString)), `The regex '${regexString}' is not safe!`)

              regexps.push(trimRegExpStartAndEnd(regexString))

              j = endOfRegexIndex + 1
              isParamSafe = true
            } else {
              regexps.push(isParamSafe ? '(.*?)' : `(${backtrack}|(?:(?!${backtrack}).)*)`)
              isParamSafe = false
            }

            const staticPartStartIndex = j
            for (; j < pattern.length; j++) {
              const staticCharCode = pattern.charCodeAt(j)
              if (staticCharCode === 47) break
              if (staticCharCode === 58) {
                const nextCharCode = pattern.charCodeAt(j + 1)
                if (nextCharCode === 58) j++
                else break
              }
            }

            let staticPart = pattern.slice(staticPartStartIndex, j)
            if (staticPart) {
              staticPart = staticPart.replaceAll('::', ':')
              staticPart = staticPart.replaceAll('%', '%25')
              backtrack = escapeRegExp(staticPart)
              regexps.push(backtrack)
            }

            lastParamStartIndex = j + 1
            nodePatternParts += '()' + staticPart

            if (isEndOfNode || pattern.charCodeAt(j) === 47 || j === pattern.length) {
              const nodePattern = isRegexNode ? nodePatternParts : staticPart
              const nodePath = pattern.slice(i, j)

              pattern = pattern.slice(0, i + 1) + nodePattern + pattern.slice(j)
              i += nodePattern.length

              const regex = isRegexNode ? new RegExp('^' + regexps.join('') + '$') : null
              if (!(currentNode instanceof StaticNode)) throw new AssertionError('Parametric node must follow a static node')
              currentNode = currentNode.createParametricChild(regex, staticPart || null, nodePath)
              parentNodePathIndex = i + 1
              break
            }
          }
        }
      } else if (isWildcardNode) {
        params.push('*')
        if (!(currentNode instanceof StaticNode)) throw new AssertionError('Wildcard node must follow a static node')
        const wildcard: WildcardNode<Store> = currentNode.createWildcardChild()
        parentNodePathIndex = i + 1

        if (i !== pattern.length - 1) throw new Error('Wildcard must be the last character in the route')

        if (!this.caseSensitive) pattern = pattern.toLowerCase()
        if (pattern === '*') pattern = '/*'
        this.pushRoute(method, path, pattern, params, opts, constraints, handler, store, wildcard)
        return
      }
    }

    if (!this.caseSensitive) pattern = pattern.toLowerCase()
    if (pattern === '*') pattern = '/*'
    this.pushRoute(method, path, pattern, params, opts, constraints, handler, store, currentNode)
  }

  private pushRoute(
    method: string,
    path: string,
    pattern: string,
    params: string[],
    opts: RouteOptions,
    constraints: Constraints,
    handler: Handler<Store>,
    store: Store | null,
    node: Node<Store>
  ): void {
    for (const existRoute of this.routes) {
      const routeConstraints = existRoute.opts.constraints ?? {}
      if (existRoute.method === method && existRoute.pattern === pattern && constraintsEqual(routeConstraints, constraints)) {
        throw new Error(`Method '${method}' already declared for route '${pattern}' with constraints '${serializeConstraintsJson(constraints)}'`)
      }
    }
    const route: Route<Store> = { method, path, pattern, params, opts, handler, store }
    this.routes.push(route)
    node.addRoute(route, this.constrainer)
  }

  hasRoute(method: HTTPMethod, path: string, constraints?: Constraints): boolean {
    return this.findRoute(method, path, constraints) !== null
  }

  findRoute(method: HTTPMethod, path: string, constraints: Constraints = {}): FindRouteResult<Store> | null {
    const tree = this.trees.get(method)
    if (tree === undefined) return null

    let pattern = path
    let currentNode: ParentNode<Store> | null = tree
    let parentNodePathIndex = tree.prefix.length

    for (let i = 0; i <= pattern.length; i++) {
      if (pattern.charCodeAt(i) === 58 && pattern.charCodeAt(i + 1) === 58) {
        i++
        continue
      }

      const isParametricNode = pattern.charCodeAt(i) === 58 && pattern.charCodeAt(i + 1) !== 58
      const isWildcardNode = pattern.charCodeAt(i) === 42

      if (isParametricNode || isWildcardNode || (i === pattern.length && i !== parentNodePathIndex)) {
        let staticNodePath = pattern.slice(parentNodePathIndex, i)
        if (!this.caseSensitive) staticNodePath = staticNodePath.toLowerCase()
        staticNodePath = staticNodePath.replaceAll('::', ':')
        staticNodePath = staticNodePath.replaceAll('%', '%25')
        currentNode = currentNode.getStaticChild(staticNodePath)
        if (currentNode === null) return null
      }

      if (isParametricNode) {
        let isRegexNode = false
        let isParamSafe = true
        let backtrack = ''
        const regexps: string[] = []
        let nodePatternParts = ''

        let lastParamStartIndex = i + 1
        for (let j = lastParamStartIndex; ; j++) {
          const charCode = pattern.charCodeAt(j)

          const isRegexParam = charCode === 40
          const isStaticPart = charCode === 45 || charCode === 46
          const isEndOfNode = charCode === 47 || j === pattern.length

          if (isRegexParam || isStaticPart || isEndOfNode) {
            isRegexNode = isRegexNode || isRegexParam || isStaticPart

            if (isRegexParam) {
              const endOfRegexIndex = getClosingParenthensePosition(pattern, j)
              const regexString = pattern.slice(j, endOfRegexIndex + 1)

              if (!this.allowUnsafeRegex) assert(isRegexSafe(new RegExp(regexString)), `The regex '${regexString}' is not safe!`)

              regexps.push(trimRegExpStartAndEnd(regexString))

              j = endOfRegexIndex + 1
              isParamSafe = true
            } else {
              regexps.push(isParamSafe ? '(.*?)' : `(${backtrack}|(?:(?!${backtrack}).)*)`)
              isParamSafe = false
            }

            const staticPartStartIndex = j
            for (; j < pattern.length; j++) {
              const staticCharCode = pattern.charCodeAt(j)
              if (staticCharCode === 47) break
              if (staticCharCode === 58) {
                const nextCharCode = pattern.charCodeAt(j + 1)
                if (nextCharCode === 58) j++
                else break
              }
            }

            let staticPart = pattern.slice(staticPartStartIndex, j)
            if (staticPart) {
              staticPart = staticPart.replaceAll('::', ':')
              staticPart = staticPart.replaceAll('%', '%25')
              backtrack = escapeRegExp(staticPart)
              regexps.push(backtrack)
            }

            lastParamStartIndex = j + 1
            nodePatternParts += '()' + staticPart

            if (isEndOfNode || pattern.charCodeAt(j) === 47 || j === pattern.length) {
              const nodePattern = isRegexNode ? nodePatternParts : staticPart

              pattern = pattern.slice(0, i + 1) + nodePattern + pattern.slice(j)
              i += nodePattern.length

              const regex = isRegexNode ? new RegExp('^' + regexps.join('') + '$') : null
              if (!(currentNode instanceof StaticNode)) return null
              currentNode = currentNode.getParametricChild(regex)
              if (currentNode === null) return null
              parentNodePathIndex = i + 1
              break
            }
          }
        }
      } else if (isWildcardNode) {
        if (!(currentNode instanceof StaticNode) || currentNode.getWildcardChild() === null) return null
        parentNodePathIndex = i + 1
        if (i !== pattern.length - 1) throw new Error('Wildcard must be the last character in the route')
        break
      }
    }

    if (!this.caseSensitive) pattern = pattern.toLowerCase()

    for (const existRoute of this.routes) {
      const routeConstraints = existRoute.opts.constraints ?? {}
      if (existRoute.method === method && existRoute.pattern === pattern && constraintsEqual(routeConstraints, constraints)) {
        return { handler: existRoute.handler, store: existRoute.store, params: existRoute.params }
      }
    }
    return null
  }

  hasConstraintStrategy(strategyName: string): boolean {
    return this.constrainer.hasConstraintStrategy(strategyName)
  }

  addConstraintStrategy(strategy: ConstraintStrategy): void {
    this.constrainer.addConstraintStrategy(strategy)
    this.rebuild(this.routes)
  }

  reset(): void {
    this.trees = new Map<string, StaticNode<Store>>()
    this.treeGET = null
    this.routes = []
  }

  off(method: HTTPMethod | HTTPMethod[], path: string, constraints?: Constraints): void {
    assert(typeof path === 'string', 'Path should be a string')
    assert(path.length > 0, 'The path could not be empty')
    assert(path[0] === '/' || path[0] === '*', 'The first character of a path should be `/` or `*`')
    assert(
      constraints === undefined || (typeof constraints === 'object' && !Array.isArray(constraints) && constraints !== null),
      'Constraints should be an object or undefined.'
    )

    const optional = splitOptionalParam(path)
    if (optional !== null) {
      this.off(method, optional.pathFull, constraints)
      this.off(method, optional.pathOptional, constraints)
      return
    }

    if (this.ignoreDuplicateSlashes) path = removeDuplicateSlashes(path)
    if (this.ignoreTrailingSlash) path = trimLastSlash(path)

    const methods: HTTPMethod[] = Array.isArray(method) ? method : [method]
    for (const one of methods) this.offOne(one, path, constraints)
  }

  private offOne(method: HTTPMethod, path: string, constraints: Constraints | undefined): void {
    assert(typeof method === 'string', 'Method should be a string')
    assert(httpMethods.includes(method), `Method '${method}' is not an http method.`)

    const newRoutes = this.routes.filter((route) => {
      const differs = method !== route.method || path !== route.path
      if (constraints === undefined) return differs
      return differs || !constraintsEqual(constraints, route.opts.constraints ?? {})
    })
    this.rebuild(newRoutes)
  }

  lookup(req: Req, res: Res, done?: Done): void {
    if (done === undefined) {
      const constraints = this.constrainer.deriveConstraints(req)
      const handle = this.find(req.method ?? '', req.url ?? '', constraints)
      this.callHandler(handle, req, res)
      return
    }

    this.constrainer.deriveConstraintsAsync(req, (err: Error | null, constraints?: DerivedConstraints): void => {
      if (err !== null) {
        done(err)
        return
      }
      try {
        const handle = this.find(req.method ?? '', req.url ?? '', constraints)
        this.callHandler(handle, req, res)
        done(null)
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  callHandler(handle: FindResult<Store> | null, req: Req, res: Res): void {
    if (handle === null) {
      this.runDefaultRoute(req, res)
      return
    }
    handle.handler(req, res, handle.params, handle.store, handle.searchParams)
  }

  find(method: string, path: string, derivedConstraints?: DerivedConstraints): FindResult<Store> | null {
    const tree: StaticNode<Store> | null = method === 'GET' ? this.treeGET : (this.trees.get(method) ?? null)
    if (tree === null) return null
    let currentNode: TreeNode<Store> = tree

    if (path.charCodeAt(0) !== 47) {
      const absolutePath = getPathFromAbsoluteUrl(path)
      if (absolutePath === null) return this.badUrl(path)
      path = absolutePath
    }

    if (this.ignoreDuplicateSlashes) path = removeDuplicateSlashes(path)

    let querystring: string
    let shouldDecodeParam: boolean
    try {
      const sanitizedUrl =
        path.length >= MIN_NATIVE_SCAN_LENGTH
          ? safeDecodeURINativeScan(path, this.useSemicolonDelimiter)
          : safeDecodeURICharScan(path, this.useSemicolonDelimiter, 1)
      path = sanitizedUrl.path
      querystring = sanitizedUrl.querystring
      shouldDecodeParam = sanitizedUrl.shouldDecodeParam
    } catch {
      return this.badUrl(path)
    }

    if (this.ignoreTrailingSlash) path = trimLastSlash(path)

    const originPath = path
    if (this.caseSensitive === false) path = path.toLowerCase()

    const maxParamLength = this.maxParamLength

    let pathIndex = tree.prefix.length
    const params: string[] = []
    const pathLen = path.length

    const brothersNodesStack: BrotherState<Store>[] = []
    let maxParamLengthExceeded = false

    while (true) {
      if (pathIndex === pathLen && currentNode.isLeafNode && currentNode.handlerStorage !== null) {
        const handle = currentNode.handlerStorage.getMatchingHandler(derivedConstraints)
        if (handle !== null) {
          return {
            handler: handle.handler,
            store: handle.store,
            params: createParamsObject(handle.params, params),
            searchParams: this.querystringParser(querystring)
          }
        }
      }

      let node: TreeNode<Store> | null = currentNode.getNextNode(path, pathIndex, brothersNodesStack, params.length)

      if (node === null) {
        const brotherNodeState = brothersNodesStack.pop()
        if (brotherNodeState === undefined) {
          if (maxParamLengthExceeded && this.onMaxParamLength) return this.maxParamLengthResult(originPath)
          return null
        }
        pathIndex = brotherNodeState.brotherPathIndex
        params.splice(brotherNodeState.paramsCount)
        node = brotherNodeState.brotherNode
      }

      currentNode = node

      while (true) {
        if (currentNode instanceof StaticNode) {
          pathIndex += currentNode.prefix.length
          break
        }

        if (currentNode instanceof WildcardNode) {
          let param = originPath.slice(pathIndex)
          if (shouldDecodeParam) param = safeDecodeURIComponent(param)
          params.push(param)
          pathIndex = pathLen
          break
        }

        let paramEndIndex = originPath.indexOf('/', pathIndex)
        if (paramEndIndex === -1) paramEndIndex = pathLen

        let param = originPath.slice(pathIndex, paramEndIndex)
        if (shouldDecodeParam) param = safeDecodeURIComponent(param)

        if (currentNode.regex !== null) {
          const matchedParameters = currentNode.regex.exec(param)
          if (matchedParameters === null) {
            const brotherNodeState = brothersNodesStack.pop()
            if (brotherNodeState === undefined) {
              if (maxParamLengthExceeded && this.onMaxParamLength) return this.maxParamLengthResult(originPath)
              return null
            }
            pathIndex = brotherNodeState.brotherPathIndex
            params.splice(brotherNodeState.paramsCount)
            currentNode = brotherNodeState.brotherNode
            continue
          }

          let regexMaxParamLengthExceeded = false
          for (let i = 1; i < matchedParameters.length; i++) {
            const matchedParam = matchedParameters[i] ?? ''
            if (matchedParam.length > maxParamLength) {
              regexMaxParamLengthExceeded = true
              break
            }
          }

          if (regexMaxParamLengthExceeded) {
            maxParamLengthExceeded = true
            const brotherNodeState = brothersNodesStack.pop()
            if (brotherNodeState === undefined) {
              if (this.onMaxParamLength) return this.maxParamLengthResult(originPath)
              return null
            }
            pathIndex = brotherNodeState.brotherPathIndex
            params.splice(brotherNodeState.paramsCount)
            currentNode = brotherNodeState.brotherNode
            continue
          }

          for (let i = 1; i < matchedParameters.length; i++) params.push(matchedParameters[i] ?? '')
        } else {
          if (param.length > maxParamLength) {
            maxParamLengthExceeded = true
            const brotherNodeState = brothersNodesStack.pop()
            if (brotherNodeState === undefined) {
              if (this.onMaxParamLength) return this.maxParamLengthResult(originPath)
              return null
            }
            pathIndex = brotherNodeState.brotherPathIndex
            params.splice(brotherNodeState.paramsCount)
            currentNode = brotherNodeState.brotherNode
            continue
          }
          params.push(param)
        }

        pathIndex = paramEndIndex
        break
      }
    }
  }

  private rebuild(routes: Route<Store>[]): void {
    this.reset()
    for (const route of routes) this.registerRoute(route.method, route.path, route.opts, route.handler, route.store)
  }

  private runDefaultRoute(req: Req, res: Res): void {
    if (this.defaultRoute !== null) {
      this.defaultRoute(req, res)
    } else {
      res.statusCode = 404
      res.end()
    }
  }

  private badUrl(path: string): FindResult<Store> | null {
    if (this.onBadUrl === null) return null
    const onBadUrl = this.onBadUrl
    return { handler: (req: Req, res: Res): void => onBadUrl(path, req, res), params: {}, store: null, searchParams: {} }
  }

  private maxParamLengthResult(path: string): FindResult<Store> | null {
    if (this.onMaxParamLength === null) return null
    const onMaxParamLength = this.onMaxParamLength
    return { handler: (req: Req, res: Res): void => onMaxParamLength(path, req, res), params: {}, store: null, searchParams: {} }
  }

  prettyPrint(options: PrettyPrintOptions = {}): string {
    const method = options.method
    let tree: StaticNode<Store> | undefined
    let merged = false
    if (method === undefined) {
      const constraints: ConstraintStrategies = {}
      for (const [name, registered] of this.constrainer.strategies) if (registered.isCustom) constraints[name] = registered.strategy
      constraints[httpMethodStrategy.name] = httpMethodStrategy

      const mergedRouter = new Router<Store>({ ...this.opts, constraints })
      for (const route of this.routes) {
        const routeConstraints: Constraints = { ...route.opts.constraints }
        routeConstraints[httpMethodStrategy.name] = route.method
        mergedRouter.registerRoute('MERGED', route.path, { constraints: routeConstraints }, route.handler, route.store)
      }
      tree = mergedRouter.trees.get('MERGED')
      merged = true
    } else {
      tree = this.trees.get(method)
    }

    if (tree === undefined) return '(empty tree)'
    const root: PrintTree = { children: new Map(), data: '' }
    this.buildObjectTree(tree, root, tree.prefix, options, merged)
    return printObjectTree(root)
  }

  private routeMetaData(route: Route<Store>, options: PrettyPrintOptions): { [key: string]: string } {
    const filtered: { [key: string]: string } = {}
    if (!options.includeMeta) return filtered
    const metaDataObject = this.buildPrettyMeta(route)
    const includeMetaKeys = Array.isArray(options.includeMeta) ? options.includeMeta : Object.keys(metaDataObject)
    for (const metaKey of includeMetaKeys) {
      if (!Object.hasOwn(metaDataObject, metaKey)) continue
      const metaValue = metaDataObject[metaKey]
      if (metaValue !== undefined && metaValue !== null) filtered[metaKey] = stringifyMeta(metaValue)
    }
    return filtered
  }

  private serializeNode(node: Node<Store>, prefix: string, options: PrettyPrintOptions, merged: boolean): string {
    let routes: PrintableRoute[] = (node.routes ?? []).map((route) => {
      const routeConstraints = route.opts.constraints ?? {}
      const constraints: Constraints = {}
      let method = route.method
      for (const key of Object.keys(routeConstraints)) {
        const value = routeConstraints[key]
        if (value === undefined) continue
        if (merged && key === httpMethodStrategy.name) method = String(value)
        else constraints[key] = value
      }
      return { method, constraints, metaData: this.routeMetaData(route, options) }
    })
    if (merged) routes = mergeSimilarRoutes(routes)
    return routes.map(serializeRoute).join(`\n${prefix}`)
  }

  private buildObjectTree(node: TreeNode<Store>, tree: PrintTree, prefix: string, options: PrettyPrintOptions, merged: boolean): void {
    if (node.isLeafNode || options.commonPrefix !== false) {
      prefix = prefix || '(empty root node)'
      const child: PrintTree = { children: new Map(), data: '' }
      tree.children.set(prefix, child)
      tree = child
      if (node.isLeafNode) tree.data = this.serializeNode(node, prefix, options, merged)
      prefix = ''
    }

    if (node instanceof WildcardNode) return
    for (const child of node.staticChildrenNodes) this.buildObjectTree(child, tree, prefix + child.prefix, options, merged)
    if (node instanceof StaticNode) {
      for (const child of node.parametricChildren) {
        const childPrefix = [...child.nodePaths].join('|')
        this.buildObjectTree(child, tree, prefix + childPrefix, options, merged)
      }
      if (node.wildcardChild) this.buildObjectTree(node.wildcardChild, tree, '*', options, merged)
    }
  }

  all(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand([...httpMethods], path, handler, store)
  }

  private shorthand(method: HTTPMethod | HTTPMethod[], path: string, handler: Handler<Store>, store: Store | undefined): void {
    if (store === undefined) this.on(method, path, handler)
    else this.on(method, path, handler, store)
  }

  acl(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('ACL', path, handler, store)
  }
  bind(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('BIND', path, handler, store)
  }
  checkout(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('CHECKOUT', path, handler, store)
  }
  connect(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('CONNECT', path, handler, store)
  }
  copy(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('COPY', path, handler, store)
  }
  delete(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('DELETE', path, handler, store)
  }
  get(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('GET', path, handler, store)
  }
  head(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('HEAD', path, handler, store)
  }
  link(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('LINK', path, handler, store)
  }
  lock(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('LOCK', path, handler, store)
  }
  'm-search'(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('M-SEARCH', path, handler, store)
  }
  merge(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('MERGE', path, handler, store)
  }
  mkactivity(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('MKACTIVITY', path, handler, store)
  }
  mkcalendar(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('MKCALENDAR', path, handler, store)
  }
  mkcol(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('MKCOL', path, handler, store)
  }
  move(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('MOVE', path, handler, store)
  }
  notify(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('NOTIFY', path, handler, store)
  }
  options(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('OPTIONS', path, handler, store)
  }
  patch(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('PATCH', path, handler, store)
  }
  post(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('POST', path, handler, store)
  }
  propfind(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('PROPFIND', path, handler, store)
  }
  proppatch(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('PROPPATCH', path, handler, store)
  }
  purge(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('PURGE', path, handler, store)
  }
  put(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('PUT', path, handler, store)
  }
  query(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('QUERY', path, handler, store)
  }
  rebind(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('REBIND', path, handler, store)
  }
  report(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('REPORT', path, handler, store)
  }
  search(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('SEARCH', path, handler, store)
  }
  source(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('SOURCE', path, handler, store)
  }
  subscribe(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('SUBSCRIBE', path, handler, store)
  }
  trace(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('TRACE', path, handler, store)
  }
  unbind(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('UNBIND', path, handler, store)
  }
  unlink(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('UNLINK', path, handler, store)
  }
  unlock(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('UNLOCK', path, handler, store)
  }
  unsubscribe(path: string, handler: Handler<Store>, store?: Store): void {
    this.shorthand('UNSUBSCRIBE', path, handler, store)
  }
}

const serializeConstraintsJson = (constraints: Constraints): string => {
  const parts: string[] = []
  for (const key of Object.keys(constraints)) {
    const value = constraints[key]
    parts.push(`${JSON.stringify(key)}:${value instanceof RegExp ? '{}' : JSON.stringify(value)}`)
  }
  return `{${parts.join(',')}}`
}

function FindMyWay<Store = null>(config?: Config<Store>): Router<Store> {
  return new Router<Store>(config)
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace FindMyWay {
  export type Instance<Store = null> = Router<Store>
  export type HTTPMethod = HTTPMethodName
  export type Handler<Store = null> = RouteHandler<Store>
  export type FindResult<Store = null> = FindResultOf<Store>
  export type Config<Store = null> = ConfigOf<Store>
  export type ConstraintStrategy = ConstraintStrategyOf
  export type RouteOptions = RouteOptionsOf
}

type HTTPMethodName = HTTPMethod
type RouteHandler<Store> = Handler<Store>
type FindResultOf<Store> = FindResult<Store>
type ConfigOf<Store> = Config<Store>
type ConstraintStrategyOf = ConstraintStrategy
type RouteOptionsOf = RouteOptions

export default FindMyWay
