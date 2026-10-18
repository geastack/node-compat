export async function run({ shim, original, require, assert }) {
  const decodeOriginal = require('fast-decode-uri-component')
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => {
      try {
        return { value: JSON.parse(JSON.stringify(call(m))) }
      } catch (error) {
        return { error: `${error.constructor.name}: ${error.message}` }
      }
    })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const inputs = [
    '', 'a', 'a=', '=a', '=', '&', '&&', 'a=b', 'a=b&c=d', 'a=b&a=c', 'a=b&a=c&a=d', 'a&a=b', 'a=b&a', 'a=&a=', 'a==b', 'a=b=c', 'a=b&&c=d',
    '&a=b', 'a=b&', 'a+b=c+d', 'a=b+c', '+=+', 'a%20b=c%20d', 'a=%E2%9C%93', 'a=%C3%A9', 'a=%E9', 'a=%zz', 'a=%', 'a=%2', 'a=%25', 'a=%2525',
    'a%5B%5D=1&a%5B%5D=2', '%61=%62', 'a=%F0%9F%98%80', 'a=%ff%fe', 'a=%C0%80', 'a=%ED%A0%80', 'a=%E2%82', 'a=%E2%82%ACx', 'a=b%', 'a=b%2',
    'a=b%20', 'a=%20%20', '%=%', '%25=%25', 'a=b&c', 'a&b&c', 'a=1&b=2&c=3&a=4', 'x[y]=1&x[z]=2', 'a=b;c=d', '?a=b', 'a=b#c', 'a=%2B&b=+',
    'ключ=значение', 'a=😀', '😀=a', 'a=%F0%9F%98%80&a=%F0%9F%98%80', 'a=b&a=c&b=d&a=e', 'constructor=1', '__proto__[x]=1', 'a[__proto__]=1', 'a=null', 'a=undefined',
    'a=%E2%9C%93&b=%26&c=%3D', 'a%3Db=c', 'a=b%26c%3Dd', 'a=%7B%22x%22%3A1%7D', 'q=hello+world&page=2&tags=x&tags=y&tags=z'
  ]
  for (const input of inputs) both(`parse ${JSON.stringify(input)}`, (m) => m.parse(input))
  assert.deepEqual(Object.keys(shim.parse('__proto__=1&a=b')), ['a'])
  assert.deepEqual(Object.keys(original.parse('__proto__=1&a=b')), ['__proto__', 'a'])
  assert.equal(Object.getPrototypeOf(shim.parse('__proto__=1')), Object.prototype)
  count++
  const decodeInputs = ['', 'abc', '%41', '%41%42', 'a%20b', '%E2%9C%93', '%F0%9F%98%80', '%C3%A9', '%E9', '%zz', '%', '%2', 'a%', '%C0%80', '%ED%A0%80', '%E2%82', '%E2%82%AC', '%e2%9c%93', '%2541', '%%41', '%41%']
  for (const input of decodeInputs) {
    assert.equal(shim.decodeURIComponent(input), decodeOriginal(input), `decodeURIComponent ${JSON.stringify(input)}`)
    count++
  }
  const objects = [
    {}, { a: 'b' }, { a: 'b', c: 'd' }, { a: ['b', 'c'] }, { a: [] }, { a: '' }, { a: 1 }, { a: 0 }, { a: -1.5 }, { a: 1e21 }, { a: 1e22 }, { a: Infinity }, { a: NaN },
    { a: true }, { a: false }, { a: null }, { a: undefined }, { a: 10n }, { a: ['x', 1, true, null, undefined, 2n] }, { 'a b': 'c d' }, { 'a&b': 'c=d' },
    { a: 'é' }, { a: '😀' }, { '😀': '😀' }, { a: '!-._~\'()*' }, { a: 'a+b' }, { a: '%' }, { 'ключ': 'значение' }, { a: 'b', c: ['d', 'e'], f: 'g' }
  ]
  for (const object of objects) both(`stringify ${JSON.stringify(object, (k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`, (m) => m.stringify(object))
  assert.throws(() => shim.encodeString('a\ud800'), /URI malformed/)
  assert.throws(() => original.stringify({ a: 'a\ud800' }), /URI malformed/)
  count++
  return count
}
