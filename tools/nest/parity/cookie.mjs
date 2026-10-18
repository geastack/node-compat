const same = (assert, fn, args, label) => {
  const [shimResult, originalResult] = args.map((f) => {
    try { return { value: f() } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } }
  })
  assert.deepEqual(shimResult, originalResult, label)
}

export async function run({ shim, original, assert }) {
  let count = 0
  const check = (label, call) => {
    same(assert, null, [() => call(shim), () => call(original)], label)
    count++
  }
  const parseInputs = [
    '', 'a', 'a=b', 'a=b; c=d', 'a=b;c=d', '  a  =  b  ;c=d', 'a="b"', 'a="b', 'a=b=c', 'a=%20b', 'a=%E0%A4%A', 'a=b; a=c',
    '=b', ';=b', 'a; b=c', 'foo=bar; equation=E%3Dmc%5E2', 'a=\tb\t;c=d', 'x=1;', '; a=b', 'a=b;;c=d', 'a=b=;c', 'a==b',
    '__proto__=x; constructor=y', 'a=b; a', 'a', 'a=', 'a="";b=1', 'a=" b "', 'k=v; q="1;2"'
  ]
  for (const input of parseInputs) check(`parse(${JSON.stringify(input)})`, (m) => m.parse(input))
  check('parse non-string', (m) => m.parse(42))
  check('parse custom decode', (m) => m.parse('a=%41%42', { decode: (v) => v.toLowerCase() }))
  check('parse decode throws', (m) => m.parse('a=%', { decode: () => { throw new Error('boom') } }))

  const serializeCases = [
    ['a', 'b'], ['a', ''], ['a', 'b c'], ['a', '"quoted"'], ['a', 'ünïcode'], ['a', 'x;y'],
    ['a b', 'c'], ['', 'c'], ['a=', 'c'], ['a', 'b', { maxAge: 10 }], ['a', 'b', { maxAge: 10.9 }], ['a', 'b', { maxAge: -1 }],
    ['a', 'b', { maxAge: Infinity }], ['a', 'b', { maxAge: NaN }], ['a', 'b', { maxAge: null }], ['a', 'b', { maxAge: 0 }],
    ['a', 'b', { domain: 'example.com' }], ['a', 'b', { domain: '.example.com' }], ['a', 'b', { domain: 'ex ample.com' }],
    ['a', 'b', { domain: '' }], ['a', 'b', { path: '/' }], ['a', 'b', { path: '/a;b' }], ['a', 'b', { path: '' }],
    ['a', 'b', { expires: new Date(0) }], ['a', 'b', { expires: new Date(NaN) }], ['a', 'b', { expires: '2020' }],
    ['a', 'b', { expires: null }], ['a', 'b', { httpOnly: true }], ['a', 'b', { httpOnly: false }], ['a', 'b', { secure: true }],
    ['a', 'b', { partitioned: true }], ['a', 'b', { priority: 'low' }], ['a', 'b', { priority: 'MEDIUM' }], ['a', 'b', { priority: 'high' }],
    ['a', 'b', { priority: 'urgent' }], ['a', 'b', { priority: '' }], ['a', 'b', { sameSite: true }], ['a', 'b', { sameSite: 'lax' }],
    ['a', 'b', { sameSite: 'Strict' }], ['a', 'b', { sameSite: 'none' }], ['a', 'b', { sameSite: 'other' }], ['a', 'b', { sameSite: false }],
    ['a', 'b', { encode: (v) => v.toUpperCase() }], ['a', 'b', { encode: (v) => v + ';' }], ['a', 'b', { encode: 'nope' }],
    ['a', 'b', { maxAge: 3600, domain: 'example.com', path: '/x', expires: new Date(Date.UTC(2030, 0, 1)), httpOnly: true, secure: true, partitioned: true, priority: 'high', sameSite: 'strict' }],
    ['a', 'b', {}], ['a', 'b', undefined]
  ]
  for (const [name, value, options] of serializeCases) {
    check(`serialize(${JSON.stringify(name)}, ${JSON.stringify(value)}, ${JSON.stringify(options)})`, (m) => m.serialize(name, value, options))
  }
  return count
}
