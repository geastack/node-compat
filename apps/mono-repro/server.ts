// Minimal reproduction of hono's boxing shape, independent of hono's (currently
// externally-broken) build — a fast, isolated dev loop for the typed-dispatch /
// monomorphization feature. Mirrors: a generic container `Router<T>` whose T is a
// typed-signature handler `(c: Ctx) => string`, the handler stored then invoked
// with a typed class instance `Ctx`. geatsc currently erases Router<T>'s generic
// to gea_cpp_value, so `run(c)` boxes `c` to invoke the boxed handler and
// `c.text()` becomes dynamic record_get. Goal: monomorphize so box_getfn == 0.
// Measure: GEA_PROFILE=1 ./dist/server  →  box_getfn per-req must reach 0.

class Ctx {
  msg: string = 'hi'
  text(s: string): string {
    return s + '!'
  }
}

type Handler = (c: Ctx) => string

class Router<T> {
  routes: T[] = []
  add(h: T): void {
    this.routes.push(h)
  }
  run(c: Ctx): string {
    const h = this.routes[0] as Handler
    return h(c)
  }
}

const r = new Router<Handler>()
r.add((c: Ctx) => c.text(c.msg))

const ITERS = 200000
let acc = 0
for (let i = 0; i < ITERS; i++) {
  const out = r.run(new Ctx())
  acc = acc + out.length
}
console.log('done iters=' + ITERS + ' acc=' + acc)
