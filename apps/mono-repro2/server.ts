// Repro #2: hono's `compose` boxing layer. hono stores handlers in the router
// with a typed signature (Router<[Handler, RouterRoute]>), but `compose`'s param
// is annotated with the BARE TS `Function` type (compose.ts: `middleware:
// [[Function, unknown], unknown][]`) — no call signature — so geatsc lowers it to
// gea_cpp_value and `handler(context)` boxes context. This isolates whether the
// bare-`Function` boundary can stay unboxed when the flowing value has a known
// concrete signature. Measure: GEA_PROFILE=1 ./dist/server → box_getfn.

class Ctx {
  msg: string = 'hi'
  text(s: string): string {
    return s + '!'
  }
}

type Handler = (c: Ctx) => string

// Mimic hono compose: receive handlers via the bare `Function` type (signature
// erased), then invoke with a typed Ctx — exactly hono's compose boundary.
function compose(middleware: Function[]): (c: Ctx) => string {
  return (c: Ctx): string => {
    const h = middleware[0] as Handler
    return h(c)
  }
}

const handler: Handler = (c: Ctx) => c.text(c.msg)
const dispatch = compose([handler])

const ITERS = 200000
let acc = 0
for (let i = 0; i < ITERS; i++) {
  const out = dispatch(new Ctx())
  acc = acc + out.length
}
console.log('done iters=' + ITERS + ' acc=' + acc)
