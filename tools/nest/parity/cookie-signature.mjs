export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: call(m) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const secrets = ['tobiiscool', '', 'ünï', Buffer.from('bytes'), Buffer.alloc(0)]
  const values = ['hello', '', 'a.b.c', 'with=equals', 'ünïcode', 'x'.repeat(500)]
  for (const secret of secrets) for (const value of values) {
    both(`sign ${JSON.stringify(value)}`, (m) => m.sign(value, secret))
    const signed = original.sign(value, secret)
    both(`unsign ok ${JSON.stringify(value)}`, (m) => m.unsign(signed, secret))
    both(`unsign wrong secret`, (m) => m.unsign(signed, 'other'))
    both(`unsign tampered`, (m) => m.unsign(signed.slice(0, -1) + (signed.endsWith('A') ? 'B' : 'A'), secret))
    both(`unsign tampered value`, (m) => m.unsign('z' + signed, secret))
  }
  both('unsign no dot', (m) => m.unsign('nodot', 'secret'))
  both('unsign empty', (m) => m.unsign('', 'secret'))
  both('sign non-string', (m) => m.sign(42, 'secret'))
  both('sign no secret', (m) => m.sign('v', undefined))
  both('sign null secret', (m) => m.sign('v', null))
  both('unsign non-string', (m) => m.unsign(42, 'secret'))
  both('unsign no secret', (m) => m.unsign('v.x', undefined))
  return count
}
