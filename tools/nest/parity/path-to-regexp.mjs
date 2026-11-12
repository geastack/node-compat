export async function run({ shim, original, assert }) {
  let count = 0
  const result = (fn) => {
    try {
      return { value: fn() }
    } catch (error) {
      return { error: `${error.name}: ${error.message}`, originalPath: error.originalPath }
    }
  }
  const json = (value) => JSON.parse(JSON.stringify(value))
  const both = (label, call) => {
    assert.deepEqual(json(result(() => call(shim))), json(result(() => call(original))), label)
    count++
  }

  const paths = [
    '/',
    '',
    '/users',
    '/users/:id',
    '/users/:id/posts/:postId',
    '/users/:id.json',
    '/users/:id-:other',
    '/users/:id:other',
    '/files/*path',
    '/files/*path.txt',
    '/:a/*b',
    '/*a/:b',
    '/:a*b',
    '/users{/:id}',
    '/users{/:id}{/:action}',
    '/a{b{c}}',
    '{/:a}{/:b}',
    '/users/:"my-id"',
    '/users/:"quoted \\"name\\""',
    '/users/:"",',
    '/users/:',
    '/users/*',
    '/users/\\:id',
    '/a\\{b\\}',
    '/a\\\\b',
    '/trailing\\',
    '/users/:id(',
    '/users/:id)',
    '/users/:id?',
    '/users/:id+',
    '/users/[id]',
    '/users/:id!',
    '/users/{unclosed',
    '/users/}',
    '/:id/:id',
    '/café/:id',
    '/:$id/:_id/:id9',
    '/emoji/😀/:id',
    '/:a:b',
    '/:a-:b/*c'
  ]

  for (const path of paths) {
    both(`parse(${JSON.stringify(path)})`, (m) => m.parse(path))
    both(`parse(${JSON.stringify(path)}, encodePath)`, (m) => m.parse(path, { encodePath: (s) => s.toUpperCase() }))
    both(`stringify(parse(${JSON.stringify(path)}))`, (m) => m.stringify(m.parse(path)))
    both(`pathToRegexp(${JSON.stringify(path)})`, (m) => {
      const { regexp, keys } = m.pathToRegexp(path)
      return { source: regexp.source, flags: regexp.flags, keys }
    })
  }

  const optionSets = [
    {},
    { end: false },
    { trailing: false },
    { sensitive: true },
    { end: false, trailing: false, sensitive: true },
    { delimiter: '.' },
    { delimiter: '/.' },
    { decode: false },
    { decode: (s) => s.toUpperCase() }
  ]
  const inputs = [
    '/',
    '/users',
    '/users/',
    '/users/42',
    '/users/42/',
    '/users/42/posts/7',
    '/users/42.json',
    '/users/a-b',
    '/users/a%20b',
    '/users/a%2Fb',
    '/users/%E2%9C%93',
    '/users/%',
    '/USERS/42',
    '/files/a/b/c.txt',
    '/files/a%2Fb/c',
    '/files/',
    '/users/42/extra',
    'users/42',
    '/a/b',
    '/a.b.c',
    '/café/9',
    '/emoji/😀/1'
  ]
  const matchPaths = [
    '/',
    '/users',
    '/users/:id',
    '/users/:id/posts/:postId',
    '/users/:id.json',
    '/users/:id-:other',
    '/files/*path',
    '/files/*path.txt',
    '/users{/:id}',
    '/users{/:id}{/:action}',
    '/:a/*b',
    '/café/:id',
    '/emoji/😀/:id',
    ['/users/:id', '/people/:id'],
    '/a.:ext',
    '/:a.:b.:c'
  ]
  for (const path of matchPaths) {
    for (const options of optionSets) {
      const label = `match(${JSON.stringify(path)}, ${options.decode ? 'decode' : JSON.stringify(options)})`
      both(label, (m) => {
        const matcher = m.match(path, options)
        return inputs.map((input) => {
          const r = result(() => matcher(input))
          return r.value === undefined || r.value === false ? r : { path: r.value.path, params: { ...r.value.params } }
        })
      })
    }
  }

  both('match route-table options', (m) => {
    const matcher = m.match('/users/:id{/:rest}', { decode: decodeURIComponent, end: true, sensitive: true })
    return inputs.map((input) => {
      const r = result(() => matcher(input))
      return r.value === undefined || r.value === false ? r : { path: r.value.path, params: { ...r.value.params } }
    })
  })

  const compiled = [
    ['/users/:id', [{ id: '42' }, { id: 'a b' }, { id: 'a/b' }, {}, { id: 42 }, { id: ['a'] }, undefined]],
    ['/files/*path', [{ path: ['a', 'b'] }, { path: [] }, { path: 'a' }, { path: ['a', 1] }, {}]],
    ['/users{/:id}', [{ id: '42' }, {}, { id: 'x y' }]],
    ['/users{/:id}{/:action}', [{ id: '1', action: 'edit' }, { action: 'edit' }, { id: '1' }]],
    ['/café/:id', [{ id: 'é' }]],
    ['/a\\:b/:c', [{ c: '1' }]]
  ]
  const compileOptionSets = [{}, { encode: false }, { encode: (s) => s.toUpperCase() }, { delimiter: '.' }]
  for (const [path, datas] of compiled) {
    for (const options of compileOptionSets) {
      both(`compile(${JSON.stringify(path)}, ${options.encode ? 'encode' : JSON.stringify(options)})`, (m) => {
        const fn = m.compile(path, options)
        return datas.map((data) => result(() => fn(data)))
      })
    }
  }

  both('match(TokenData)', (m) => {
    const matcher = m.match(m.parse('/users/:id'))
    return inputs.map((input) => result(() => matcher(input)))
  })
  both('compile(TokenData)', (m) => m.compile(m.parse('/users/:id'))({ id: '7' }))

  both('pathToRegexp too many combinations', (m) => {
    const r = result(() => m.pathToRegexp('{/:a}{/:b}{/:c}{/:d}{/:e}{/:f}{/:g}{/:h}{/:i}'))
    return r.value === undefined ? r : 'ok'
  })

  assert.deepEqual(json(original.parse('/:név').tokens), [{ type: 'text', value: '/' }, { type: 'param', name: 'név' }])
  assert.deepEqual(json(shim.parse('/:név').tokens), [{ type: 'text', value: '/' }, { type: 'param', name: 'n' }, { type: 'text', value: 'év' }])
  assert.deepEqual(json(shim.parse('/:"név"').tokens), json(original.parse('/:"név"').tokens))
  assert.equal(shim.stringify(shim.parse('/:"név"')), '/:"név"')
  assert.equal(original.stringify(original.parse('/:"név"')), '/:név')
  count++

  return count
}
