import { createHmac, timingSafeEqual } from 'node:crypto'

export function sign(val: string, secret: string | Uint8Array): string {
  if (typeof val !== 'string') throw new TypeError('Cookie value must be provided as a string.')
  if (secret == null) throw new TypeError('Secret key must be provided.')
  return val + '.' + createHmac('sha256', secret).update(val).digest('base64').replace(/=+$/, '')
}

export function unsign(input: string, secret: string | Uint8Array): string | false {
  if (typeof input !== 'string') throw new TypeError('Signed cookie string must be provided.')
  if (secret == null) throw new TypeError('Secret key must be provided.')
  const tentativeValue = input.slice(0, input.lastIndexOf('.'))
  const expectedInput = sign(tentativeValue, secret)
  const expectedBuffer = Buffer.from(expectedInput)
  const inputBuffer = Buffer.from(input)
  return expectedBuffer.length === inputBuffer.length && timingSafeEqual(expectedBuffer, inputBuffer) ? tentativeValue : false
}
