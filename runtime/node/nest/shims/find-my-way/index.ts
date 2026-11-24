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

export type Handler<Store> = (req: Req, res: Res, params: Params, store: Store | null, searchParams: SearchParams | undefined) => void

export type Done = (err: Error | null, result?: unknown) => void

const constraintsEqual = (left: Constraints, right: Constraints): boolean => {
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  for (const name of names) {
    if (!Object.hasOwn(right, name)) return false
    const a = left[name]
    const b = right[name]
    if (a instanceof RegExp && b instanceof RegExp) {
      if (a.source !== b.source || a.flags !== b.flags) return false
    } else if (a !== b && !(a !== a && b !== b)) {
      return false
    }
  }
  return true
}

export type ConstraintValue = string | number | boolean | RegExp | null

export interface Constraints {
  [name: string]: ConstraintValue
}

export type DerivedValue = string | number | boolean | null | undefined | readonly string[]

export interface DerivedConstraints {
  [name: string]: DerivedValue
}


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
  deriveConstraint(req: Req, ctx?: unknown, done?: DeriveDone): DerivedValue
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
  store: Store | undefined
}

export interface FindResult<Store> {
  handler: Handler<Store>
  params: Params
  store: Store | null
  searchParams?: SearchParams
}

export interface FindRouteResult<Store> {
  handler: Handler<Store>
  store: Store | undefined
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
  deriveConstraint: (req: Req): DerivedValue => req.headers['accept-version']
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

const REGEX_CACHE_MAX_SIZE = 1000
const REGEX_CACHE_EVICTION_SIZE = REGEX_CACHE_MAX_SIZE / 2

export class HostStorage implements ConstraintStorage {
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
        this.cacheRegexResult(key, regex.value)
        return regex.value
      }
    }
    this.cacheRegexResult(key, undefined)
    return undefined
  }

  private cacheRegexResult(key: string, value: number | undefined): void {
    if (this.regexCache.size >= REGEX_CACHE_MAX_SIZE) {
      let evicted = 0
      for (const cached of this.regexCache.keys()) {
        if (evicted === REGEX_CACHE_EVICTION_SIZE) break
        this.regexCache.delete(cached)
        evicted++
      }
    }
    this.regexCache.set(key, value)
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
  deriveConstraint: (req: Req): DerivedValue => req.headers.host || req.headers[':authority']
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
    assert(typeof strategy.deriveConstraint === 'function', 'strategy.deriveConstraint function is required.')
    const isAsync = strategy.deriveConstraint.length === 3

    const existing = this.strategies.get(strategy.name)
    if (existing !== undefined && existing.isCustom) throw new Error(`There already exists a custom constraint with the name ${strategy.name}.`)
    if (this.isStrategyUsed(strategy.name)) throw new Error(`There already exists a route with ${strategy.name} constraint.`)

    this.strategies.set(strategy.name, { strategy, isCustom: true, isAsync })
    if (strategy.mustMatchWhenDerived) this.noteUsage([strategy.name])
  }

  deriveConstraints(req: Req, ctx?: unknown): DerivedConstraints | undefined {
    return this.deriveSyncConstraints(req, ctx)
  }

  deriveConstraintsAsync(req: Req, ctx: unknown, done: (err: Error | null, constraints?: DerivedConstraints) => void): void {
    this.deriveAsyncConstraints(this.deriveSyncConstraints(req, ctx), req, ctx, done)
  }

  private deriveSyncConstraints(req: Req, ctx: unknown): DerivedConstraints | undefined {
    if (this.strategiesInUse.size === 0) return undefined
    const derived: DerivedConstraints = {}
    for (const key of this.strategiesInUse) {
      const registered = this.strategies.get(key)
      if (registered === undefined) continue
      if (!registered.isCustom) {
        if (key === 'version') derived.version = req.headers['accept-version']
        else derived.host = req.headers.host || req.headers[':authority']
      } else {
        derived[registered.strategy.name] = registered.strategy.deriveConstraint(req, ctx)
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
    ctx: unknown,
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
      if (registered === undefined) continue
      registered.strategy.deriveConstraint(req, ctx, (err: Error | null, constraintValue?: DerivedValue): void => {
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
  const params: Params = Object.create(null)
  for (let i = 0; i < names.length; i++) params[names[i] ?? ''] = values[i]
  return params
}

class HandlerStorage<Store> {
  unconstrainedHandler: HandlerSlot<Store> | null = null
  readonly constraints: string[] = []
  readonly handlers: HandlerSlot<Store>[] = []
  private readonly constrainedHandlerStores = new Map<string, ConstraintStorage>()
  private compiledConstraints: string[] = []
  private masks: number[] = []
  private mustMatch: boolean[] = []
  private absentMustMatch: string[] = []
  private allCandidates = 0
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

    const isMergedTree = constraintsNames.includes(httpMethodStrategy.name)
    if (!isMergedTree && this.handlers.length >= 31) {
      throw new Error('find-my-way supports a maximum of 31 route handlers per node when there are constraints, limit reached')
    }

    for (const constraint of constraintsNames) {
      if (!this.constraints.includes(constraint)) {
        if (constraint === 'version') this.constraints.unshift(constraint)
        else this.constraints.push(constraint)
      }
    }

    this.handlers.push(handlerObject)
    this.handlers.sort((a, b) => Object.keys(a.constraints).length - Object.keys(b.constraints).length)

    if (!isMergedTree) this.compileGetHandlerMatchingConstraints(constrainer)
  }

  private getHandlerMatchingConstraints(derivedConstraints: DerivedConstraints): HandlerSlot<Store> | null {
    if (!this.compiled) return null
    let candidates = this.allCandidates
    for (let i = 0; i < this.compiledConstraints.length; i++) {
      const constraint = this.compiledConstraints[i] ?? ''
      const mask = this.masks[i] ?? 0
      const value = derivedConstraints[constraint]
      if (value === undefined) {
        candidates &= mask
      } else {
        const store = this.constrainedHandlerStores.get(constraint)
        if (store === undefined) throw new TypeError("Cannot read properties of undefined (reading 'get')")
        const matches = store.get(value) || 0
        candidates &= this.mustMatch[i] ? matches : matches | mask
      }
      if (candidates === 0) return null
    }
    for (const constraint of this.absentMustMatch) if (derivedConstraints[constraint] !== undefined) return null
    return this.handlers[31 - Math.clz32(candidates)] ?? null
  }

  private compileGetHandlerMatchingConstraints(constrainer: Constrainer): void {
    this.constrainedHandlerStores.clear()
    const masks: number[] = []
    const mustMatch: boolean[] = []
    const absentMustMatch: string[] = []

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
      masks.push(~mask)
      mustMatch.push(constrainer.strategies.get(constraint)?.strategy.mustMatchWhenDerived === true)
    }

    for (const [name, registered] of constrainer.strategies) {
      if (registered.strategy.mustMatchWhenDerived && !this.constraints.includes(name)) absentMustMatch.push(name)
    }
    this.compiledConstraints = [...this.constraints]
    this.masks = masks
    this.mustMatch = mustMatch
    this.absentMustMatch = absentMustMatch
    this.allCandidates = (1 << this.handlers.length) - 1
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

const isArrayIndexKey = (key: string): boolean => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295

const inObjectKeyOrder = (keys: string[]): string[] => [
  ...keys.filter((key) => isArrayIndexKey(key)).sort((a, b) => Number(a) - Number(b)),
  ...keys.filter((key) => !isArrayIndexKey(key))
]

const printObjectTree = (tree: PrintTree, parentPrefix = ''): string => {
  let text = ''
  const keys = inObjectKeyOrder([...tree.children.keys()])
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
  private routesByMethodAndPattern = new Map<string, Map<string, Route<Store>[]>>()

  constructor(opts: Config<Store> = {}) {
    this.opts = opts
    if (opts.defaultRoute) assert(typeof opts.defaultRoute === 'function', 'The default route must be a function')
    this.defaultRoute = opts.defaultRoute || null
    if (opts.onBadUrl) assert(typeof opts.onBadUrl === 'function', 'The bad url handler must be a function')
    this.onBadUrl = opts.onBadUrl || null
    if (opts.buildPrettyMeta) assert(typeof opts.buildPrettyMeta === 'function', 'buildPrettyMeta must be a function')
    this.buildPrettyMeta = opts.buildPrettyMeta || defaultBuildPrettyMeta
    if (opts.querystringParser) assert(typeof opts.querystringParser === 'function', 'querystringParser must be a function')
    this.querystringParser = opts.querystringParser || defaultQuerystringParser
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
      this.addRoute(method, path, {}, optsOrHandler, handlerOrStore === undefined ? undefined : (handlerOrStore as Store))
    } else {
      assert(typeof handlerOrStore === 'function', 'Handler should be a function')
      this.addRoute(method, path, optsOrHandler, handlerOrStore as Handler<Store>, store)
    }
  }

  private addRoute(method: HTTPMethod | HTTPMethod[], path: string, opts: RouteOptions, handler: Handler<Store>, store: Store | undefined): void {
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

  private registerRoute(method: string, path: string, opts: RouteOptions, handler: Handler<Store>, store: Store | undefined): void {
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
    store: Store | undefined,
    node: Node<Store>
  ): void {
    const sameRoutes = this.routesByMethodAndPattern.get(method)?.get(pattern)
    for (const existRoute of sameRoutes ?? []) {
      if (constraintsEqual(existRoute.opts.constraints ?? {}, constraints)) {
        throw new Error(`Method '${method}' already declared for route '${pattern}' with constraints '${serializeConstraintsJson(constraints)}'`)
      }
    }
    const route: Route<Store> = { method, path, pattern, params, opts, handler, store }
    this.routes.push(route)
    if (sameRoutes !== undefined) sameRoutes.push(route)
    else {
      let byPattern = this.routesByMethodAndPattern.get(method)
      if (byPattern === undefined) {
        byPattern = new Map<string, Route<Store>[]>()
        this.routesByMethodAndPattern.set(method, byPattern)
      }
      byPattern.set(pattern, [route])
    }
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
        if (i !== pattern.length - 1) throw new Error('Wildcard must be the last character in the route')
        parentNodePathIndex = i + 1
        break
      }
    }

    if (!this.caseSensitive) pattern = pattern.toLowerCase()

    for (const existRoute of this.routesByMethodAndPattern.get(method)?.get(pattern) ?? []) {
      if (constraintsEqual(existRoute.opts.constraints ?? {}, constraints)) {
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
    this.routesByMethodAndPattern = new Map<string, Map<string, Route<Store>[]>>()
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

  lookup(req: Req, res: Res, done?: Done): unknown
  lookup(req: Req, res: Res, ctx: unknown, done?: Done): unknown
  lookup(req: Req, res: Res, ctxOrDone?: unknown, maybeDone?: Done): unknown {
    const done: Done | undefined = typeof ctxOrDone === 'function' ? (ctxOrDone as Done) : maybeDone
    const ctx = typeof ctxOrDone === 'function' ? undefined : ctxOrDone
    if (done === undefined) {
      const constraints = this.constrainer.deriveConstraints(req, ctx)
      const handle = this.find(req.method ?? '', req.url ?? '', constraints)
      return this.callHandler(handle, req, res, ctx)
    }

    this.constrainer.deriveConstraintsAsync(req, ctx, (err: Error | null, constraints?: DerivedConstraints): void => {
      if (err !== null) {
        done(err)
        return
      }
      try {
        const handle = this.find(req.method ?? '', req.url ?? '', constraints)
        done(null, this.callHandler(handle, req, res, ctx))
      } catch (error) {
        done(error as Error | null)
      }
    })
    return undefined
  }

  callHandler(handle: FindResult<Store> | null, req: Req, res: Res, ctx?: unknown): unknown {
    if (handle === null) return this.runDefaultRoute(req, res, ctx)
    return ctx === undefined
      ? handle.handler(req, res, handle.params, handle.store, handle.searchParams)
      : handle.handler.call(ctx, req, res, handle.params, handle.store, handle.searchParams)
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

    if (this.ignoreDuplicateSlashes) path = removeDuplicateSlashes(path)
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

  private runDefaultRoute(req: Req, res: Res, ctx: unknown): unknown {
    if (this.defaultRoute !== null) {
      return ctx === undefined ? this.defaultRoute(req, res) : this.defaultRoute.call(ctx, req, res)
    }
    res.statusCode = 404
    res.end()
    return undefined
  }

  private badUrl(path: string): FindResult<Store> | null {
    if (this.onBadUrl === null) return null
    const onBadUrl = this.onBadUrl
    return { handler: (req: Req, res: Res): void => onBadUrl(path, req, res), params: {}, store: null }
  }

  private maxParamLengthResult(path: string): FindResult<Store> | null {
    if (this.onMaxParamLength === null) return null
    const onMaxParamLength = this.onMaxParamLength
    return { handler: (req: Req, res: Res): void => onMaxParamLength(path, req, res), params: {}, store: null }
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
      const original: Route<Store> = merged ? { ...route, method, opts: { constraints } } : route
      return { method, constraints, metaData: this.routeMetaData(original, options) }
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

  all(path: string, handler: Handler<Store>, store?: Store): void
  all(path: string, opts: RouteOptions, handler: Handler<Store>): void
  all(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand([...httpMethods], path, optsOrHandler, handlerOrStore)
  }

  private shorthand(
    method: HTTPMethod | HTTPMethod[],
    path: string,
    optsOrHandler: RouteOptions | Handler<Store>,
    handlerOrStore: Handler<Store> | Store | undefined
  ): void {
    if (typeof optsOrHandler !== 'function') this.on(method, path, optsOrHandler, handlerOrStore as Handler<Store>)
    else if (handlerOrStore === undefined) this.on(method, path, optsOrHandler)
    else this.on(method, path, optsOrHandler, handlerOrStore as Store)
  }

  acl(path: string, handler: Handler<Store>, store?: Store): void
  acl(path: string, opts: RouteOptions, handler: Handler<Store>): void
  acl(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('ACL', path, optsOrHandler, handlerOrStore)
  }
  bind(path: string, handler: Handler<Store>, store?: Store): void
  bind(path: string, opts: RouteOptions, handler: Handler<Store>): void
  bind(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('BIND', path, optsOrHandler, handlerOrStore)
  }
  checkout(path: string, handler: Handler<Store>, store?: Store): void
  checkout(path: string, opts: RouteOptions, handler: Handler<Store>): void
  checkout(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('CHECKOUT', path, optsOrHandler, handlerOrStore)
  }
  connect(path: string, handler: Handler<Store>, store?: Store): void
  connect(path: string, opts: RouteOptions, handler: Handler<Store>): void
  connect(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('CONNECT', path, optsOrHandler, handlerOrStore)
  }
  copy(path: string, handler: Handler<Store>, store?: Store): void
  copy(path: string, opts: RouteOptions, handler: Handler<Store>): void
  copy(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('COPY', path, optsOrHandler, handlerOrStore)
  }
  delete(path: string, handler: Handler<Store>, store?: Store): void
  delete(path: string, opts: RouteOptions, handler: Handler<Store>): void
  delete(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('DELETE', path, optsOrHandler, handlerOrStore)
  }
  get(path: string, handler: Handler<Store>, store?: Store): void
  get(path: string, opts: RouteOptions, handler: Handler<Store>): void
  get(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('GET', path, optsOrHandler, handlerOrStore)
  }
  head(path: string, handler: Handler<Store>, store?: Store): void
  head(path: string, opts: RouteOptions, handler: Handler<Store>): void
  head(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('HEAD', path, optsOrHandler, handlerOrStore)
  }
  link(path: string, handler: Handler<Store>, store?: Store): void
  link(path: string, opts: RouteOptions, handler: Handler<Store>): void
  link(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('LINK', path, optsOrHandler, handlerOrStore)
  }
  lock(path: string, handler: Handler<Store>, store?: Store): void
  lock(path: string, opts: RouteOptions, handler: Handler<Store>): void
  lock(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('LOCK', path, optsOrHandler, handlerOrStore)
  }
  'm-search'(path: string, handler: Handler<Store>, store?: Store): void
  'm-search'(path: string, opts: RouteOptions, handler: Handler<Store>): void
  'm-search'(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('M-SEARCH', path, optsOrHandler, handlerOrStore)
  }
  merge(path: string, handler: Handler<Store>, store?: Store): void
  merge(path: string, opts: RouteOptions, handler: Handler<Store>): void
  merge(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('MERGE', path, optsOrHandler, handlerOrStore)
  }
  mkactivity(path: string, handler: Handler<Store>, store?: Store): void
  mkactivity(path: string, opts: RouteOptions, handler: Handler<Store>): void
  mkactivity(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('MKACTIVITY', path, optsOrHandler, handlerOrStore)
  }
  mkcalendar(path: string, handler: Handler<Store>, store?: Store): void
  mkcalendar(path: string, opts: RouteOptions, handler: Handler<Store>): void
  mkcalendar(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('MKCALENDAR', path, optsOrHandler, handlerOrStore)
  }
  mkcol(path: string, handler: Handler<Store>, store?: Store): void
  mkcol(path: string, opts: RouteOptions, handler: Handler<Store>): void
  mkcol(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('MKCOL', path, optsOrHandler, handlerOrStore)
  }
  move(path: string, handler: Handler<Store>, store?: Store): void
  move(path: string, opts: RouteOptions, handler: Handler<Store>): void
  move(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('MOVE', path, optsOrHandler, handlerOrStore)
  }
  notify(path: string, handler: Handler<Store>, store?: Store): void
  notify(path: string, opts: RouteOptions, handler: Handler<Store>): void
  notify(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('NOTIFY', path, optsOrHandler, handlerOrStore)
  }
  options(path: string, handler: Handler<Store>, store?: Store): void
  options(path: string, opts: RouteOptions, handler: Handler<Store>): void
  options(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('OPTIONS', path, optsOrHandler, handlerOrStore)
  }
  patch(path: string, handler: Handler<Store>, store?: Store): void
  patch(path: string, opts: RouteOptions, handler: Handler<Store>): void
  patch(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('PATCH', path, optsOrHandler, handlerOrStore)
  }
  post(path: string, handler: Handler<Store>, store?: Store): void
  post(path: string, opts: RouteOptions, handler: Handler<Store>): void
  post(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('POST', path, optsOrHandler, handlerOrStore)
  }
  propfind(path: string, handler: Handler<Store>, store?: Store): void
  propfind(path: string, opts: RouteOptions, handler: Handler<Store>): void
  propfind(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('PROPFIND', path, optsOrHandler, handlerOrStore)
  }
  proppatch(path: string, handler: Handler<Store>, store?: Store): void
  proppatch(path: string, opts: RouteOptions, handler: Handler<Store>): void
  proppatch(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('PROPPATCH', path, optsOrHandler, handlerOrStore)
  }
  purge(path: string, handler: Handler<Store>, store?: Store): void
  purge(path: string, opts: RouteOptions, handler: Handler<Store>): void
  purge(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('PURGE', path, optsOrHandler, handlerOrStore)
  }
  put(path: string, handler: Handler<Store>, store?: Store): void
  put(path: string, opts: RouteOptions, handler: Handler<Store>): void
  put(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('PUT', path, optsOrHandler, handlerOrStore)
  }
  query(path: string, handler: Handler<Store>, store?: Store): void
  query(path: string, opts: RouteOptions, handler: Handler<Store>): void
  query(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('QUERY', path, optsOrHandler, handlerOrStore)
  }
  rebind(path: string, handler: Handler<Store>, store?: Store): void
  rebind(path: string, opts: RouteOptions, handler: Handler<Store>): void
  rebind(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('REBIND', path, optsOrHandler, handlerOrStore)
  }
  report(path: string, handler: Handler<Store>, store?: Store): void
  report(path: string, opts: RouteOptions, handler: Handler<Store>): void
  report(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('REPORT', path, optsOrHandler, handlerOrStore)
  }
  search(path: string, handler: Handler<Store>, store?: Store): void
  search(path: string, opts: RouteOptions, handler: Handler<Store>): void
  search(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('SEARCH', path, optsOrHandler, handlerOrStore)
  }
  source(path: string, handler: Handler<Store>, store?: Store): void
  source(path: string, opts: RouteOptions, handler: Handler<Store>): void
  source(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('SOURCE', path, optsOrHandler, handlerOrStore)
  }
  subscribe(path: string, handler: Handler<Store>, store?: Store): void
  subscribe(path: string, opts: RouteOptions, handler: Handler<Store>): void
  subscribe(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('SUBSCRIBE', path, optsOrHandler, handlerOrStore)
  }
  trace(path: string, handler: Handler<Store>, store?: Store): void
  trace(path: string, opts: RouteOptions, handler: Handler<Store>): void
  trace(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('TRACE', path, optsOrHandler, handlerOrStore)
  }
  unbind(path: string, handler: Handler<Store>, store?: Store): void
  unbind(path: string, opts: RouteOptions, handler: Handler<Store>): void
  unbind(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('UNBIND', path, optsOrHandler, handlerOrStore)
  }
  unlink(path: string, handler: Handler<Store>, store?: Store): void
  unlink(path: string, opts: RouteOptions, handler: Handler<Store>): void
  unlink(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('UNLINK', path, optsOrHandler, handlerOrStore)
  }
  unlock(path: string, handler: Handler<Store>, store?: Store): void
  unlock(path: string, opts: RouteOptions, handler: Handler<Store>): void
  unlock(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('UNLOCK', path, optsOrHandler, handlerOrStore)
  }
  unsubscribe(path: string, handler: Handler<Store>, store?: Store): void
  unsubscribe(path: string, opts: RouteOptions, handler: Handler<Store>): void
  unsubscribe(path: string, optsOrHandler: RouteOptions | Handler<Store>, handlerOrStore?: Handler<Store> | Store): void {
    this.shorthand('UNSUBSCRIBE', path, optsOrHandler, handlerOrStore)
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

function FindMyWay<Store = unknown>(config?: Config<Store>): Router<Store> {
  return new Router<Store>(config)
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace FindMyWay {
  export type Instance<Store = unknown> = Router<Store>
  export type HTTPMethod = HTTPMethodName
  export type Handler<Store = unknown> = RouteHandler<Store>
  export type FindResult<Store = unknown> = FindResultOf<Store>
  export type Config<Store = unknown> = ConfigOf<Store>
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
