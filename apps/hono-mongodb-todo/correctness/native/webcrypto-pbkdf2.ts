// Web Crypto PBKDF2 as a database driver's SCRAM authentication calls it: a raw
// password imported as a PBKDF2 key, `deriveBits` with an algorithm object,
// then HMAC over the result. Errors print their DOMException name only: the
// messages are Node's and vary between Node releases.

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('hex')

const failure = async (label: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run()
    console.log(label, 'resolved')
  } catch (error) {
    console.log(label, error instanceof DOMException ? error.name : 'not a DOMException')
  }
}

async function HI(data: string, salt: Uint8Array, iterations: number, method: 'sha1' | 'sha256'): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(data), { name: 'PBKDF2' }, false, ['deriveBits'])
  const params = { name: 'PBKDF2', salt: salt, iterations: iterations, hash: { name: method === 'sha256' ? 'SHA-256' : 'SHA-1' } }
  const derivedBits = await crypto.subtle.deriveBits(params, keyMaterial, (method === 'sha256' ? 32 : 20) * 8)
  return new Uint8Array(derivedBits)
}

async function main(): Promise<void> {
  const salt = new Uint8Array([0x41, 0x25, 0xc2, 0x47, 0xe4, 0x3a, 0xb1, 0xe9, 0x3c, 0x6d, 0xff, 0x76])
  const sha256 = await HI('pencil', salt, 4096, 'sha256')
  console.log('sha256', Buffer.from(sha256).toString('hex'))
  const sha1 = await HI('pencil', salt, 4096, 'sha1')
  console.log('sha1', Buffer.from(sha1).toString('hex'))

  // The salt is read through its view, not its whole backing buffer.
  const window = new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('pāss\0word'), { name: 'PBKDF2' }, false, ['deriveBits'])
  console.log('subarray salt', hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: window, iterations: 2, hash: 'SHA-512' }, key, 128)))
  console.log('zero bits', (await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: window, iterations: 1, hash: 'SHA-1' }, key, 0)).byteLength)
  console.log('algorithm', JSON.stringify(key.algorithm), key.type, key.extractable, key.usages.join(','))

  // The HMAC the SCRAM proof computes over the salted password.
  const clientKey = await crypto.subtle.importKey(
    'raw',
    sha256,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign', 'verify']
  )
  console.log('client key', hex(await crypto.subtle.sign('HMAC', clientKey, new TextEncoder().encode('Client Key'))))

  await failure('length 7', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-1' }, key, 7))
  await failure('zero iterations', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 0, hash: 'SHA-1' }, key, 8))
  await failure('unknown hash', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1, hash: 'MD5' }, key, 8))
  await failure('hmac key', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-1' }, clientKey, 8))
  await failure('sign with pbkdf2 key', () => crypto.subtle.sign('HMAC', key, salt))
  await failure('extractable', () => crypto.subtle.importKey('raw', salt, { name: 'PBKDF2' }, true, ['deriveBits']))
  await failure('sign usage', () => crypto.subtle.importKey('raw', salt, { name: 'PBKDF2' }, false, ['sign']))
  const deriveKeyOnly = await crypto.subtle.importKey('raw', salt, { name: 'PBKDF2' }, false, ['deriveKey'])
  await failure('no deriveBits usage', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-1' }, deriveKeyOnly, 8))
}

main()
