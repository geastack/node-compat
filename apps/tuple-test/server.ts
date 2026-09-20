// Verifies tuple monomorphization: heterogeneous fixed tuples lower to
// std::tuple<...> (not vector<gea_cpp_value>). Shapes mirror hono's router
// storage `Route<T> = [RegExp, string, T]`: push of a tuple literal, literal
// index reads, destructuring, for-of destructuring, calling a function
// element, length, dynamic index, and JSON boxing.
type Handler = (x: number) => string
type Route = [RegExp, string, Handler]

const routes: Route[] = []
routes.push([/^\/a/, 'GET', (x: number) => 'a' + x])
routes.push([/^\/b$/, 'POST', (x) => 'b' + x])

// literal-index reads
const first = routes[0]
console.log('method0=' + first[1])
console.log('handler0=' + first[2](1))

// destructuring declaration
const [pattern, method, handler] = routes[1]
console.log('method1=' + method)
console.log('handler1=' + handler(2))
console.log('match=' + String(pattern.test('/b')))

// for-of with destructuring (elided first element)
let all = ''
for (const [, m, h] of routes) {
  all += m + ':' + h(0) + ';'
}
console.log('all=[' + all + ']')

// length: fixed arity on the tuple, dynamic on the vector of tuples
console.log('len=' + routes.length + ',' + first.length)

// simple pair tuple, dynamic index read
const pair: [string, number] = ['x', 42]
console.log('pair=' + pair[0] + ',' + pair[1])
let j = 0
j = j + 1
console.log('dyn=' + String(pair[j]))

// boxing: JSON.stringify goes through the boxed array form
const kv: [string, number] = ['k', 7]
console.log('json=' + JSON.stringify(kv))

// tuple as function param + return
function swap(p: [string, number]): [number, string] {
  return [p[1], p[0]]
}
const swapped = swap(pair)
console.log('swap=' + swapped[0] + ',' + swapped[1])

// hono-shaped generic router: routes store [RegExp, string, T] where T is
// itself a tuple [handlerFn, meta] — the nested-tuple instantiation that
// hono/tiny's PatternRouter + Hono class produce.
type Meta = { path: string; method: string }
type H = (x: number) => string
class Router<T> {
  routes: [RegExp, string, T][] = []
  add(method: string, path: string, handler: T) {
    this.routes.push([new RegExp(path), method, handler])
  }
  match(method: string, path: string): T[] {
    const out: T[] = []
    for (const [pattern, m, handler] of this.routes) {
      if ((m === method || m === 'ALL') && pattern.test(path)) out.push(handler)
    }
    return out
  }
}
const router = new Router<[H, Meta]>()
router.add('GET', '^/a$', [(x) => 'A' + x, { path: '/a', method: 'GET' }])
router.add('POST', '^/b$', [(x) => 'B' + x, { path: '/b', method: 'POST' }])
const hits = router.match('GET', '/a')
console.log('hits=' + hits.length)
const [h0, meta0] = hits[0]
console.log('routed=' + h0(5) + ' via ' + meta0.method + ' ' + meta0.path)
const misses = router.match('GET', '/b')
console.log('misses=' + misses.length)

// hono's exact Result<T> shape: a UNION of two tuple types (boxed at the
// boundary), consumed by deep chained indexing `matchResult[0][0][0][0]`
// exactly like Hono#dispatch extracts the handler.
type Params = Record<string, string>
type ParamStash = string[]
type MatchResult<T> = [[T, Params][], ParamStash] | [[T, Params][]]
class PRouter<T> {
  routes: [RegExp, string, T][] = []
  add(method: string, path: string, handler: T) {
    this.routes.push([new RegExp(path), method, handler])
  }
  match(method: string, path: string): MatchResult<T> {
    const handlers: [T, Params][] = []
    for (const [pattern, m, handler] of this.routes) {
      if (m === method && pattern.test(path)) {
        handlers.push([handler, {}])
      }
    }
    return [handlers]
  }
}
const pr = new PRouter<[H, Meta]>()
pr.add('GET', '^/x$', [(x) => 'X' + x, { path: '/x', method: 'GET' }])
const mres = pr.match('GET', '/x')
console.log('mlen=' + mres[0].length)
const deep = mres[0][0][0][0]
console.log('deep=' + deep(9))
const [[pairH]] = mres
console.log('pairH=' + pairH[0][0](3) + ' meta=' + pairH[0][1].path)

// hono's real handler signature: class-typed context + function-typed next.
// The handler round-trips boxed through the union-typed match result; calling
// it back must preserve callability and arg identity.
class Ctx {
  status = 200
  tag: string
  constructor(tag: string) {
    this.tag = tag
  }
  body(s: string): string {
    return s + ':' + this.status + ':' + this.tag
  }
}
type Next = () => string
type CH = (c: Ctx, next: Next) => string
const cr = new PRouter<[CH, Meta]>()
cr.add('GET', '^/c$', [(c, next) => c.body('hit') + '|' + next(), { path: '/c', method: 'GET' }])
const cres = cr.match('GET', '/c')
console.log('t1=' + typeof cres[0] + ' t2=' + typeof cres[0][0] + ' t3=' + typeof cres[0][0][0] + ' t4=' + typeof cres[0][0][0][0])
const ch = cres[0][0][0][0]
console.log('ctx=' + ch(new Ctx('T1'), () => 'NEXT'))

// hono's setDefaultContentType + #newResponse header-merge shape:
// spread-literal record, Object.entries (a [string, T][] tuple array),
// for-of pair destructuring, method calls on a boxed class instance.
class HeadersLike {
  entries_: string[] = []
  set(k: string, v: string) {
    this.entries_.push(k.toLowerCase() + '=' + v)
  }
  dump(): string {
    return this.entries_.join(';')
  }
}
const setDefault = (ct: string, headers?: Record<string, string>) => {
  return { 'Content-Type': ct, ...headers }
}
const merged = setDefault('application/json', undefined)
console.log('mkeys=' + Object.keys(merged).join(','))
const merged2 = setDefault('text/plain', { 'X-Extra': 'yes' })
console.log('mkeys2=' + Object.keys(merged2).sort().join(','))
const hl: any = new HeadersLike()
for (const [k, v] of Object.entries(merged2)) {
  hl.set(k, v)
}
console.log('hdump=' + hl.dump())

// hono's exact HeaderRecord shape: union-valued record, declared return
// type, typeof narrowing over Object.entries values.
type HeaderRecord = Record<string, string | string[]>
const setDefault2 = (contentType: string, headers?: HeaderRecord): HeaderRecord => {
  const out: HeaderRecord = { 'Content-Type': contentType, ...headers }
  console.log('inner=' + Object.keys(out).join(','))
  return out
}
const direct: HeaderRecord = { 'Content-Type': 'x' }
console.log('direct=' + Object.keys(direct).join(','))
const hl2: any = new HeadersLike()
const hr = setDefault2('application/json', undefined)
console.log('hrkeys=' + Object.keys(hr).join(',') + ' nentries=' + Object.entries(hr).length)
for (const [k, v] of Object.entries(hr)) {
  if (typeof v === 'string') {
    hl2.set(k, v)
  } else {
    hl2.set(k, '<arr>')
  }
}
console.log('hdump2=' + hl2.dump())

// hono Context#newResponse shape: private method with optional HeaderRecord
// param, `#field ?? new` headers source, entries loop with typeof narrowing,
// invoked through a boxed field arrow.
class Ctx2 {
  prepared: HeadersLike | undefined
  private newResponse(data: string, arg?: number, headers?: HeaderRecord): string {
    const responseHeaders = this.prepared ?? new HeadersLike()
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string') {
          responseHeaders.set(k, v)
        }
      }
    }
    const es = headers === undefined ? [] : Object.entries(headers)
    return data + '|' + (headers === undefined ? 'NOHDR' : 'K:' + Object.keys(headers).join(',')) + '|E' + es.length + (es.length > 0 ? ':' + typeof es[0][1] : '') + '|' + responseHeaders.dump()
  }
  jsonish = (data: string, arg?: number, headers?: HeaderRecord) => {
    return this.newResponse(JSON.stringify({ d: data }), arg, setDefault2('application/json', headers))
  }
}
const cx: any = new Ctx2()
console.log('newresp=' + cx.jsonish('x'))
