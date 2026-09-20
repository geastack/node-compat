// Repro #3: hono's remaining boxing complications on top of the (now unboxed)
// generic-container + compose shape — (a) an ASYNC handler returning a Promise,
// (b) a Context method that returns ANOTHER class instance (hono `c.text()` →
// Response), (c) nested-tuple storage like compose's `[[Function,_],_][]`.
// Measure: GEA_PROFILE=1 ./dist/server → which of these still boxes (box_getfn>0).

class Resp {
  body: string
  constructor(body: string) {
    this.body = body
  }
  text(): string {
    return this.body
  }
}

class Ctx {
  msg: string = 'hi'
  text(s: string): Resp {
    return new Resp(s + '!')
  }
}

type Handler = (c: Ctx) => Promise<Resp>

function compose(middleware: [[Function, unknown], unknown][]): (c: Ctx) => Promise<Resp> {
  return async (c: Ctx): Promise<Resp> => {
    const h = middleware[0][0][0] as Handler
    return await h(c)
  }
}

const handler: Handler = async (c: Ctx) => c.text(c.msg)
const dispatch = compose([[[handler, 0], 0]])

const ITERS = 200000
let acc = 0
for (let i = 0; i < ITERS; i++) {
  const resp = dispatch(new Ctx()) as unknown as Resp
  const body = resp.text() as unknown as string
  acc = acc + body.length
}
console.log('done iters=' + ITERS + ' acc=' + acc)
