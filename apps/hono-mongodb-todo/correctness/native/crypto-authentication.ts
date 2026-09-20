import { createHash, createHmac, pbkdf2Sync, timingSafeEqual, getFips } from 'node:crypto'
import { Buffer } from 'node:buffer'

console.log(createHash('sha256').update('abc').digest('hex'))
console.log(createHash('md5').update('user:mongo:password', 'utf8').digest('hex'))
console.log(createHmac('sha256', Buffer.from('key')).update('hello').digest('hex'))
console.log(pbkdf2Sync('pāss\0word', Buffer.from('salt'), 4096, 32, 'sha256').toString('hex'))
const mutable = Buffer.from('abc')
const hash = createHash('sha1').update(mutable)
mutable[0] = 122
const copied = hash.copy().update('def')
console.log(hash.digest('hex'), copied.digest('hex'))
const hmac = createHmac('sha1', '')
console.log(hmac.digest('hex'), hmac.digest().length)
console.log(timingSafeEqual(Buffer.from('a'), Buffer.from('a')), timingSafeEqual(Buffer.from('a'), Buffer.from('b')))
console.log(pbkdf2Sync('', '', 1, 20, 'sha1').length, getFips())
