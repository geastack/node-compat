// Minimal repro: typed Headers instance flowing through a dynamic (any) init
// boundary into Response — mirrors hono #newResponse → createResponseInstance.
const h = new Headers()
h.set('content-type', 'application/json')
console.log('direct-get:', h.get('content-type'))

const boxed: any = h
console.log('boxed-count-typeof:', typeof boxed.count)
console.log('boxed-get:', boxed.get('content-type'))

const createResponseInstance = (
  body?: BodyInit | null | undefined,
  init?: globalThis.ResponseInit
): Response => new Response(body, init)

const r = createResponseInstance('x', { status: 201, headers: h })
console.log('resp-status:', r.status)
console.log('resp-ct:', r.headers.get('content-type'))

const hs = r.headers
console.log('hs-typeof:', typeof hs)
console.log('hs-get:', hs.get('content-type'))
const anyR: any = r
console.log('anyr-ct:', anyR.headers.get('content-type'))
console.log('direct-chain:', r.headers.get('content-type'))
