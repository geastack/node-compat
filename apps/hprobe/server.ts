import type { H, Handler, MiddlewareHandler } from '../../vendored-sources/hono/src/types'
import type { RouterRoute } from '../../vendored-sources/hono/src/types'

const handler: Handler = (c) => c.text('x')
const mw: MiddlewareHandler = async (c, next) => { await next() }
const h: H = handler
const pair: [H, RouterRoute] = [h, { basePath: '/', path: '/', method: 'GET', handler: h }]
console.log(typeof handler, typeof mw, typeof h, typeof pair)
