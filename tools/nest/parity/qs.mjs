export async function run({ shim, original, assert }) {
  let count = 0
  assert.deepEqual([...shim.OBJECT_PROTOTYPE_KEYS].sort(), Object.getOwnPropertyNames(Object.prototype).sort(), 'Object.prototype own keys')
  count++
  const normalize = (value) => JSON.parse(JSON.stringify(value, (k, v) => (v === undefined ? '<undefined>' : v)))
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: normalize(call(m)) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const inputs = [
    '', 'a', 'a=', 'a=b', 'a=b&c=d', 'a=b&a=c', 'a=b&a=c&a=d', 'a[]=b&a[]=c', 'a[0]=b&a[1]=c', 'a[1]=b&a[0]=c', 'a[1]=b', 'a[3]=b&a[1]=c',
    'a[b]=c', 'a[b][c]=d', 'a[b][c][d][e][f]=g', 'a[b][c][d][e][f][g]=h', 'a[b]=c&a[d]=e', 'a[b]=c&a=d', 'a=d&a[b]=c', 'a[]=b&a[c]=d', 'a[c]=d&a[]=b',
    'a[b][]=c&a[b][]=d', 'a[0][b]=c&a[1][b]=d', 'a[0][b]=c&a[0][d]=e', 'a[0]=b&a=c', 'a=b&a[0]=c', 'a[20]=x', 'a[19]=x', 'a[21]=x&a[0]=y', 'a[]=1&a[]=2&a[]=3',
    'a[b]=1&a[b]=2', 'a[b][]=1&a[b]=2', 'a.b=c', 'a%5Bb%5D=c', 'a%5bb%5d=c', 'a[=b', 'a]=b', 'a[[]b=c', 'a[b=c', '[a]=b', '[]=a', '[]=a&[]=b', 'a[b]]=c',
    'a=%E2%9C%93', 'a=%26%2310003%3B', 'utf8=%E2%9C%93&a=%C3%A9', 'utf8=%26%2310003%3B&a=%C3%A9', 'a=%C3%A9', 'a=%E9', 'a=%zz', 'a=b+c', 'a+b=c',
    'a=&#9786;', 'a=%26%239786%3B', '__proto__[x]=1', 'a[__proto__][x]=1', 'constructor[prototype][x]=1', 'hasOwnProperty=1', 'a[hasOwnProperty]=1',
    'toString=1&a=2', 'a[toString]=1', '__proto__=1', 'a[valueOf][b]=1', 'a=b&c=d&e=f&g=h&i=j', 'a[]=b&a[]=c&a[0]=d', 'a[1]=b&a[]=c', 'a[x]=1&a[2]=2',
    'a=1&a=2&a=3&a=4&a=5&a=6&a=7&a=8&a=9&a=10&a=11&a=12&a=13&a=14&a=15&a=16&a=17&a=18&a=19&a=20&a=21&a=22',
    'a[]=1&a[]=2&a[]=3&a[]=4&a[]=5&a[]=6&a[]=7&a[]=8&a[]=9&a[]=10&a[]=11&a[]=12&a[]=13&a[]=14&a[]=15&a[]=16&a[]=17&a[]=18&a[]=19&a[]=20&a[]=21&a[]=22',
    'a[0]=1&a[1]=2&a[2]=3&a[3]=4&a[4]=5&a[5]=6&a[6]=7&a[7]=8&a[8]=9&a[9]=10&a[10]=11&a[11]=12&a[12]=13&a[13]=14&a[14]=15&a[15]=16&a[16]=17&a[17]=18&a[18]=19&a[19]=20&a[20]=21&a[21]=22',
    'a[25]=x&a[]=y', 'a[]=y&a[25]=x', 'a[25]=x&a=y', 'a=y&a[25]=x', 'a[25][b]=x&a[25][c]=y', 'a[0]=x&a[25]=y&a[1]=z', 'a[-1]=x', 'a[01]=x', 'a[1.5]=x', 'a[ 1]=x',
    '?a=b', 'a=b;c=d', 'a=b&&c=d', '&a=b', 'a=b&', '=', '&', '==', 'a==b', 'a=b=c', 'a[b]=c=d', 'a[]=', 'a[b]=', 'a[]', 'a[b]',
    'a[b][c]=1&a[b][d]=2&a[e]=3&f=4', 'x[y][z][]=1&x[y][z][]=2&x[y][w]=3', 'a[0][0]=1&a[0][1]=2&a[1][0]=3',
    'a%5B%5D=1&a%5B%5D=2', 'a%5B0%5D=1', 'a%20b=c%20d', 'a=%F0%9F%98%80', 'a=%ff%fe', 'a[]=%25', 'a=%2520'
  ]
  const optionSets = [
    {}, { allowPrototypes: true }, { arrayLimit: 0 }, { arrayLimit: 1 }, { arrayLimit: 3 }, { arrayLimit: 100 }, { depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 10 }, { depth: false },
    { depth: 1, strictDepth: true }, { depth: 2, strictDepth: true }, { depth: 0, strictDepth: true }, { depth: 5, strictDepth: true }, { strictDepth: true },
    { charset: 'iso-8859-1' }, { charset: 'iso-8859-1', interpretNumericEntities: true }, { charset: 'utf-8', interpretNumericEntities: true }, { charset: 'utf-8', charsetSentinel: true },
    { charset: 'iso-8859-1', charsetSentinel: true }, { charsetSentinel: true, interpretNumericEntities: true }, { charset: 'iso-8859-1', charsetSentinel: true, interpretNumericEntities: true },
    { parameterLimit: 1 }, { parameterLimit: 2 }, { parameterLimit: 3 }, { parameterLimit: Infinity }, { parameterLimit: 1, charsetSentinel: true },
    { decoder: (s) => s.toUpperCase() }, { decoder: (s, d, cs) => d(s, d, cs) + '!' }, { decoder: (s, d, cs, type) => (type === 'key' ? s : d(s, d, cs)) },
    { decoder: (s, d, cs, type) => (type === 'key' && s === 'a' ? null : d(s, d, cs)) }, { decoder: (s, d, cs, type) => (type === 'value' ? null : s) },
    { allowPrototypes: true, arrayLimit: 100, depth: 10, charset: 'utf-8', charsetSentinel: true, interpretNumericEntities: true, parameterLimit: 1000, strictDepth: true },
    { allowPrototypes: false, arrayLimit: 100, depth: 10, charset: 'iso-8859-1', charsetSentinel: true, interpretNumericEntities: true, parameterLimit: 1000, strictDepth: true },
    { allowPrototypes: true, arrayLimit: 20, depth: 32, parameterLimit: 1000, strictDepth: true, charset: 'utf-8', charsetSentinel: false, interpretNumericEntities: false }
  ]
  for (const input of inputs) {
    for (const options of optionSets) {
      both(`parse(${JSON.stringify(input)}, ${JSON.stringify(options, (k, v) => (typeof v === 'function' ? v.toString() : v))})`, (m) => m.parse(input, options))
      both(`default.parse(${JSON.stringify(input)})`, (m) => (m.default ?? m).parse(input, options))
    }
    both(`parse(${JSON.stringify(input)}) no options`, (m) => m.parse(input))
  }
  both('bad decoder', (m) => m.parse('a=b', { decoder: 'x' }))
  both('bad charset', (m) => m.parse('a=b', { charset: 'latin1' }))
  both('null input', (m) => m.parse(null))
  both('undefined input', (m) => m.parse(undefined))
  return count
}
