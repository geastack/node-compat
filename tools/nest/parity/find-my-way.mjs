export async function run({ shim, original, assert }) {
  let count = 0
  const factories = [shim.default, original]
  const outcome = (call) => {
    try {
      return { value: call() }
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` }
    }
  }
  const normResult = (r) => (r === null || r === undefined ? r : { handler: r.handler.name || '(anonymous)', params: { ...r.params }, store: r.store ?? null, searchParams: { ...r.searchParams } })
  const normRoute = (r) => (r === null ? r : { handler: r.handler.name || '(anonymous)', store: r.store ?? null, params: [...r.params] })
  const both = (label, call) => {
    const results = factories.map((factory) => outcome(() => call(factory)))
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const bothAsync = async (label, call) => {
    const results = []
    for (const factory of factories) {
      try {
        results.push({ value: await call(factory) })
      } catch (error) {
        results.push({ error: `${error.constructor.name}: ${error.message}` })
      }
    }
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  function handlerA() {}
  function handlerB() {}
  function handlerC() {}
  function handlerD() {}

  const scenarios = [
    {
      name: 'static and parametric',
      routes: [
        ['GET', '/', handlerA, { r: 'root' }],
        ['GET', '/users', handlerB, { r: 'users' }],
        ['GET', '/users/:id', handlerC, { r: 'user' }],
        ['GET', '/users/:id/posts/:postId', handlerD, { r: 'post' }],
        ['POST', '/users', handlerA, { r: 'create' }],
        ['GET', '/user', handlerB],
        ['GET', '/usual', handlerC],
        ['GET', '/a/b/c', handlerD],
        ['GET', '/a/:b/c', handlerA],
        ['GET', '/a/:b/:c', handlerB],
        ['GET', '/a/*', handlerC],
        ['HEAD', '/users', handlerD, { r: 'head' }]
      ],
      lookups: [
        ['GET', '/'], ['GET', '/users'], ['GET', '/users/'], ['GET', '/users/42'], ['GET', '/users/42/posts/7'], ['GET', '/users/42/posts'], ['GET', '/users//profile'], ['GET', '/users/'],
        ['POST', '/users'], ['POST', '/users/42'], ['GET', '/user'], ['GET', '/usual'], ['GET', '/usu'], ['GET', '/a/b/c'], ['GET', '/a/x/c'], ['GET', '/a/x/y'], ['GET', '/a/x/y/z'], ['GET', '/a/b/c/d'], ['GET', '/a/'],
        ['GET', '/a'], ['HEAD', '/users'], ['DELETE', '/users'], ['GET', '/users?x=1&y=2&y=3'], ['GET', '/users/42?a=b'], ['GET', '/users/%E2%9C%93'], ['GET', '/users/a%2Fb'], ['GET', '/users/a%20b'], ['GET', '/users/%'],
        ['GET', '/users/%zz'], ['GET', '/USERS'], ['GET', 'http://example.com/users'], ['GET', 'http://example.com'], ['GET', 'http://example.com?x=1'], ['GET', 'https://example.com/users/1#frag'], ['GET', 'ftp://example.com/users'], ['GET', 'users'],
        ['GET', '/users/' + 'x'.repeat(100)], ['GET', '/users/' + 'x'.repeat(101)], ['GET', '/a/' + 'x'.repeat(200)], ['GET', '/users;a=b'], ['GET', '/users/1;a=b'], ['GET', '/users/caf%C3%A9'], ['GET', '/a//b/c'], ['GET', '//users'], ['GET', '/users#frag'], ['GET', '/users?']
      ]
    },
    {
      name: 'regex, multi-param and suffix nodes',
      routes: [
        ['GET', '/items/:id(\\d+)', handlerA, 'num'],
        ['GET', '/items/:slug', handlerB, 'slug'],
        ['GET', '/files/:name.:ext', handlerC, 'file'],
        ['GET', '/files/:name', handlerD, 'plainfile'],
        ['GET', '/range/:from-:to', handlerA, 'range'],
        ['GET', '/date/:year(\\d{4})-:month(\\d{2})-:day(\\d{2})', handlerB, 'date'],
        ['GET', '/pre:id', handlerC, 'prefixed'],
        ['GET', '/hex/:h([a-f0-9]+)$', handlerD, 'hex'],
        ['GET', '/anchored/:x(^\\d+$)', handlerA, 'anchored'],
        ['GET', '/mixed/:a(\\d+)-:b', handlerB, 'mixed'],
        ['GET', '/suffix/:a.json', handlerC, 'json'],
        ['GET', '/suffix/:a.xml', handlerD, 'xml'],
        ['GET', '/suffix/:a.tar.gz', handlerA, 'targz'],
        ['GET', '/dotted/:a.:b.:c', handlerB, 'dotted'],
        ['GET', '/escaped/::literal', handlerC, 'colon'],
        ['GET', '/escaped/:x::y', handlerD, 'paramcolon'],
        ['GET', '/percent/%', handlerA, 'percent'],
        ['GET', '/percent/%25', handlerB, 'percent25'],
        ['GET', '/group/:g((?:a|b)+)', handlerC, 'group']
      ],
      lookups: [
        ['GET', '/items/42'], ['GET', '/items/abc'], ['GET', '/items/42abc'], ['GET', '/items/'], ['GET', '/files/readme.md'], ['GET', '/files/readme'], ['GET', '/files/a.b.c'], ['GET', '/files/.md'], ['GET', '/files/readme.'],
        ['GET', '/range/1-9'], ['GET', '/range/1-2-3'], ['GET', '/range/-'], ['GET', '/range/a'], ['GET', '/date/2024-01-31'], ['GET', '/date/2024-1-31'], ['GET', '/date/20240131'], ['GET', '/pre123'], ['GET', '/pre'],
        ['GET', '/hex/deadbeef'], ['GET', '/hex/xyz'], ['GET', '/anchored/123'], ['GET', '/anchored/12a'], ['GET', '/mixed/12-ab'], ['GET', '/mixed/ab-12'], ['GET', '/mixed/12-a-b'], ['GET', '/suffix/a.json'], ['GET', '/suffix/a.xml'],
        ['GET', '/suffix/a.tar.gz'], ['GET', '/suffix/a.b.json'], ['GET', '/suffix/a.gz'], ['GET', '/dotted/a.b.c'], ['GET', '/dotted/a.b'], ['GET', '/dotted/a.b.c.d'], ['GET', '/escaped/:literal'], ['GET', '/escaped/x:y'], ['GET', '/escaped/x'],
        ['GET', '/escaped/%3Aliteral'], ['GET', '/percent/%'], ['GET', '/percent/%25'], ['GET', '/percent/%2525'], ['GET', '/group/abab'], ['GET', '/group/abc'], ['GET', '/items/%31%32'], ['GET', '/files/a%2Eb'], ['GET', '/range/1%2D2'],
        ['GET', '/items/' + '1'.repeat(101)], ['GET', '/files/' + 'a'.repeat(101) + '.md'], ['GET', '/range/' + 'a'.repeat(60) + '-' + 'b'.repeat(60)]
      ]
    },
    {
      name: 'wildcard and root wildcard',
      routes: [
        ['GET', '*', handlerA, 'all'],
        ['GET', '/static/*', handlerB, 'static'],
        ['GET', '/static/index.html', handlerC, 'index'],
        ['GET', '/static/:file.css', handlerD, 'css'],
        ['POST', '/*', handlerA, 'postall'],
        ['GET', '/deep/:a/*', handlerB, 'deep']
      ],
      lookups: [['GET', '/'], ['GET', '/anything/at/all'], ['GET', '/static/'], ['GET', '/static/a/b.js'], ['GET', '/static/index.html'], ['GET', '/static/site.css'], ['GET', '/static/a/site.css'], ['POST', '/'], ['POST', '/x'], ['GET', '/deep/1/2/3'], ['GET', '/deep/1/'], ['GET', '/deep/1'], ['GET', '/static/%E2%9C%93/x'], ['GET', 'http://h/static/x']]
    },
    {
      name: 'optional parameters',
      routes: [
        ['GET', '/opt/:a?', handlerA, 'opt'],
        ['GET', '/opt2/:a/:b?', handlerB, 'opt2'],
        ['GET', '/:root?', handlerC, 'rootopt'],
        ['GET', '/trail/:a?/', handlerD, 'trail']
      ],
      lookups: [['GET', '/opt'], ['GET', '/opt/'], ['GET', '/opt/x'], ['GET', '/opt2/1'], ['GET', '/opt2/1/2'], ['GET', '/opt2/1/'], ['GET', '/'], ['GET', '/x'], ['GET', '/trail'], ['GET', '/trail/'], ['GET', '/trail/x'], ['GET', '/trail/x/']]
    }
  ]

  const register = (router, routes) => {
    for (const [method, path, handler, store] of routes) {
      if (store === undefined) router.on(method, path, handler)
      else router.on(method, path, handler, store)
    }
  }

  const optionSets = [
    {}, { ignoreTrailingSlash: true }, { ignoreDuplicateSlashes: true }, { ignoreTrailingSlash: true, ignoreDuplicateSlashes: true }, { caseSensitive: false }, { maxParamLength: 5 }, { maxParamLength: 5, onMaxParamLength: function tooLong() {} },
    { onBadUrl: function badUrl() {} }, { useSemicolonDelimiter: true }, { querystringParser: function custom(q) { return { raw: q } } }, { allowUnsafeRegex: true }
  ]
  for (const scenario of scenarios) {
    for (const options of optionSets) {
      const label = `${scenario.name} ${JSON.stringify(Object.keys(options))}`
      both(`${label}: registration`, (factory) => {
        const router = factory(options)
        register(router, scenario.routes)
        return router.routes.map((r) => ({ method: r.method, path: r.path, pattern: r.pattern, params: r.params, constraints: r.opts.constraints ?? null, store: r.store ?? null }))
      })
      for (const [method, url] of scenario.lookups) {
        both(`${label}: find(${method} ${url})`, (factory) => {
          const router = factory(options)
          register(router, scenario.routes)
          return normResult(router.find(method, url))
        })
      }
      both(`${label}: prettyPrint`, (factory) => {
        const router = factory(options)
        register(router, scenario.routes)
        return [router.prettyPrint(), router.prettyPrint({ commonPrefix: false }), router.prettyPrint({ method: 'GET' }), router.prettyPrint({ method: 'POST', commonPrefix: false }), router.prettyPrint({ method: 'PATCH' })]
      })
      both(`${label}: findRoute/hasRoute`, (factory) => {
        const router = factory(options)
        register(router, scenario.routes)
        return scenario.routes.map(([method, path]) => [normRoute(router.findRoute(method, path)), router.hasRoute(method, path), router.hasRoute(method, path + '/x'), router.hasRoute('PUT', path)])
      })
      both(`${label}: off each then find`, (factory) => {
        const out = []
        for (const [method, path] of scenario.routes) {
          const router = factory(options)
          register(router, scenario.routes)
          router.off(method, path)
          out.push(router.routes.map((r) => r.pattern), scenario.lookups.map(([m, u]) => normResult(router.find(m, u))))
        }
        return out
      })
    }
  }

  both('onBadUrl result', (factory) => {
    const router = factory({ onBadUrl: function badUrl() {} })
    router.on('GET', '/a/:b', handlerA)
    const r = router.find('GET', '/a/%zz')
    return r && { handler: typeof r.handler, params: { ...r.params }, store: r.store, searchParams: { ...r.searchParams } }
  })
  both('onMaxParamLength result', (factory) => {
    const router = factory({ maxParamLength: 3, onMaxParamLength: function tooLong() {} })
    router.on('GET', '/a/:b', handlerA, { s: 1 })
    router.on('GET', '/a/:b(\\d+)', handlerB, { s: 2 })
    router.on('GET', '/c/:d-:e', handlerC, { s: 3 })
    return ['/a/xxxx', '/a/1234', '/a/xx', '/c/xxxx-y', '/c/x-y'].map((p) => {
      const r = router.find('GET', p)
      return r && { handler: typeof r.handler, params: { ...r.params }, store: r.store, searchParams: { ...r.searchParams } }
    })
  })

  const statics = (factory) => (factory === original ? original : shim)
  for (const p of ['/', '/a//b', '//', '/a/', '/a/b/', 'a/', '/a%2Fb', '/a%20b', '/a;b', '/caf%C3%A9', '/%', '/a///b//c/']) {
    both(`sanitizeUrlPath(${p})`, (factory) => [statics(factory).sanitizeUrlPath(p), statics(factory).sanitizeUrlPath(p, true)])
    both(`removeDuplicateSlashes(${p})`, (factory) => statics(factory).removeDuplicateSlashes(p))
    both(`trimLastSlash(${p})`, (factory) => statics(factory).trimLastSlash(p))
  }

  const badRegistrations = [
    ['GET', ''], ['GET', 'users'], ['FETCH', '/a'], ['GET', '/a/*/b'], ['GET', '/a/:b?/c'], ['GET', '/a/:b(\\d+'], ['GET', '/a/:b((a+)+)'], ['GET', '/a/:b((a+)+)', { allowUnsafeRegex: true }], [['GET', 'POST'], '/ok'], [['GET', 'NOPE'], '/a'],
    ['GET', '/a', { constraints: 'x' }], ['GET', '/a', { constraints: { version: 1 } }], ['GET', '/a', { constraints: { host: 1 } }], ['GET', '/a', { constraints: { unknown: 'x' } }], ['GET', '/a', { constraints: { version: undefined } }], ['GET', '/a', { constraints: { version: 'x.y' } }], ['GET', '/a', { constraints: { host: /x/g } }]
  ]
  for (const [method, path, optsOrConfig] of badRegistrations) {
    both(`on(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${JSON.stringify(optsOrConfig)})`, (factory) => {
      const config = optsOrConfig && 'allowUnsafeRegex' in optsOrConfig ? optsOrConfig : {}
      const opts = optsOrConfig && 'constraints' in optsOrConfig ? optsOrConfig : null
      const router = factory(config)
      if (opts) router.on(method, path, opts, handlerA)
      else router.on(method, path, handlerA)
      return router.routes.map((r) => [r.method, r.pattern])
    })
  }
  both('handler not a function', (factory) => factory().on('GET', '/a', {}, 'nope'))
  both('handler not a function (3 args)', (factory) => factory().on('GET', '/a', 'nope'))
  both('duplicate route', (factory) => {
    const router = factory()
    router.on('GET', '/a/:b', handlerA)
    router.on('GET', '/a/:c', handlerB)
  })
  both('duplicate route with constraints', (factory) => {
    const router = factory()
    router.on('GET', '/a', { constraints: { host: 'x', version: '1.0.0' } }, handlerA)
    router.on('GET', '/a', { constraints: { version: '1.0.0', host: 'x' } }, handlerB)
  })
  both('duplicate route with regex constraint', (factory) => {
    const router = factory()
    router.on('GET', '/a', { constraints: { host: /x/ } }, handlerA)
    router.on('GET', '/a', { constraints: { host: /x/ } }, handlerB)
  })
  both('same path different constraints is fine', (factory) => {
    const router = factory()
    router.on('GET', '/a', { constraints: { host: 'x' } }, handlerA)
    router.on('GET', '/a', { constraints: { host: 'y' } }, handlerB)
    router.on('GET', '/a', handlerC)
    return router.routes.length
  })
  both('31 handler limit', (factory) => {
    const router = factory()
    for (let i = 0; i < 32; i++) router.on('GET', '/a', { constraints: { host: `h${i}` } }, handlerA, i)
  })
  both('31 handler limit reached exactly', (factory) => {
    const router = factory()
    for (let i = 0; i < 31; i++) router.on('GET', '/a', { constraints: { host: `h${i}` } }, handlerA, i)
    return ['h0', 'h15', 'h30', 'h31'].map((host) => normResult(router.find('GET', '/a', { host })))
  })
  both('off validation', (factory) => factory().off('GET', 'nope'))
  both('off constraints validation', (factory) => factory().off('GET', '/a', []))
  both('off unknown method', (factory) => factory().off('NOPE', '/a'))
  both('off with optional param', (factory) => {
    const router = factory()
    router.on('GET', '/a/:b?', handlerA)
    router.off('GET', '/a/:b?')
    return router.routes.length
  })
  both('off with constraints only removes that one', (factory) => {
    const router = factory()
    router.on('GET', '/a', { constraints: { host: 'x' } }, handlerA, 1)
    router.on('GET', '/a', { constraints: { host: 'y' } }, handlerB, 2)
    router.on('GET', '/a', handlerC, 3)
    router.off('GET', '/a', { host: 'x' })
    const withY = router.routes.map((r) => r.store)
    router.off('GET', '/a')
    return [withY, router.routes.length]
  })
  both('off array of methods and ignoreTrailingSlash', (factory) => {
    const router = factory({ ignoreTrailingSlash: true })
    router.on(['GET', 'POST'], '/a/', handlerA)
    router.on('PUT', '/a', handlerB)
    router.off(['GET', 'PUT'], '/a')
    return router.routes.map((r) => [r.method, r.path, r.pattern])
  })
  both('reset', (factory) => {
    const router = factory()
    router.on('GET', '/a', handlerA)
    router.reset()
    return [router.routes.length, router.find('GET', '/a'), router.prettyPrint()]
  })

  const constrained = (factory, config = {}) => {
    const router = factory(config)
    router.on('GET', '/v', { constraints: { version: '1.0.0' } }, handlerA, 'v1.0.0')
    router.on('GET', '/v', { constraints: { version: '1.2.0' } }, handlerB, 'v1.2.0')
    router.on('GET', '/v', { constraints: { version: '1.2.3' } }, handlerC, 'v1.2.3')
    router.on('GET', '/v', { constraints: { version: '2.0.0' } }, handlerD, 'v2.0.0')
    router.on('GET', '/v', { constraints: { version: '2.1.0' } }, handlerA, 'v2.1.0')
    router.on('GET', '/v', { constraints: { version: '10.0.0' } }, handlerB, 'v10')
    router.on('GET', '/h', { constraints: { host: 'fastify.dev' } }, handlerA, 'dev')
    router.on('GET', '/h', { constraints: { host: 'fastify.io' } }, handlerB, 'io')
    router.on('GET', '/h', { constraints: { host: /.+\.example\.com$/ } }, handlerC, 'regex')
    router.on('GET', '/h', handlerD, 'nohost')
    router.on('GET', '/hv', { constraints: { host: 'fastify.dev', version: '1.0.0' } }, handlerA, 'dev1')
    router.on('GET', '/hv', { constraints: { host: 'fastify.dev', version: '2.0.0' } }, handlerB, 'dev2')
    router.on('GET', '/hv', { constraints: { host: 'fastify.io' } }, handlerC, 'io')
    router.on('GET', '/hv', { constraints: { version: '3.0.0' } }, handlerD, 'v3')
    router.on('GET', '/plain', handlerA, 'plain')
    router.on('GET', '/onlyv', { constraints: { version: '1.0.0' } }, handlerA, 'onlyv')
    router.on('GET', '/p/:x', { constraints: { host: 'a' } }, handlerA, 'pa')
    router.on('GET', '/p/:x', { constraints: { host: 'b' } }, handlerB, 'pb')
    router.on('GET', '/p/:x(\\d+)', handlerC, 'pnum')
    router.on('GET', '/p/*', handlerD, 'pwild')
    return router
  }
  const versions = [undefined, '1.0.0', '1.2.0', '1.2.3', '1.2.x', '1.x', 'x', '*', '1.x.x', '2.x', '2.1.x', '10.x', '3.0.0', '1.2.4', '0.0.0', 'x.x', 'x.x.x', '1.2', '1', '2.0.x', 'junk']
  const hosts = [undefined, 'fastify.dev', 'fastify.io', 'a.example.com', 'b.example.com', 'example.com', 'other', 'a', 'b', '']
  for (const version of versions) {
    for (const host of hosts) {
      const derived = {}
      if (version !== undefined) derived.version = version
      if (host !== undefined) derived.host = host
      both(`constraints ${JSON.stringify(derived)}`, (factory) => {
        const router = constrained(factory)
        return ['/v', '/h', '/hv', '/plain', '/onlyv', '/p/12', '/p/ab', '/p/a/b'].map((p) => normResult(router.find('GET', p, derived)))
      })
    }
  }
  both('constraints with undefined object', (factory) => {
    const router = constrained(factory)
    return ['/v', '/h', '/plain'].map((p) => normResult(router.find('GET', p)))
  })
  both('constrained prettyPrint', (factory) => {
    const router = constrained(factory)
    return [router.prettyPrint(), router.prettyPrint({ method: 'GET' }), router.prettyPrint({ commonPrefix: false })]
  })
  both('constrained findRoute', (factory) => {
    const router = constrained(factory)
    return [
      normRoute(router.findRoute('GET', '/v', { version: '1.2.0' })), normRoute(router.findRoute('GET', '/v')), normRoute(router.findRoute('GET', '/h', { host: /.+\.example\.com$/ })), normRoute(router.findRoute('GET', '/h')),
      router.hasRoute('GET', '/hv', { version: '1.0.0', host: 'fastify.dev' }), router.hasRoute('GET', '/hv', { host: 'fastify.dev', version: '1.0.0' }), router.hasRoute('GET', '/hv', { host: 'fastify.dev' }), router.hasRoute('GET', '/p/:y(\\d+)'), router.hasRoute('GET', '/p/:x(\\d+)')
    ]
  })
  both('constrained off', (factory) => {
    const router = constrained(factory)
    router.off('GET', '/v', { version: '1.2.0' })
    router.off('GET', '/h')
    return [router.routes.map((r) => r.store), normResult(router.find('GET', '/v', { version: '1.2.x' })), normResult(router.find('GET', '/h', { host: 'fastify.dev' }))]
  })
  both('version store maxima', (factory) => {
    const router = factory()
    router.on('GET', '/v', { constraints: { version: '2.0.0' } }, handlerA, 'v2')
    router.on('GET', '/v', { constraints: { version: '1.0.0' } }, handlerB, 'v1')
    router.on('GET', '/v', { constraints: { version: '1.5.0' } }, handlerC, 'v1.5')
    router.on('GET', '/v', { constraints: { version: '1.5' } }, handlerD, 'v1.5short')
    return ['x', '1.x', '1.5.x', '1.0.x', '2.x', '1.5.0', '1.5'].map((version) => normResult(router.find('GET', '/v', { version })))
  })

  const makeStorage = () => {
    const store = new Map()
    return { get: (v) => store.get(v) || null, set: (v, h) => store.set(v, h) }
  }
  const secretSync = { name: 'secret', storage: makeStorage, deriveConstraint: (req) => req.headers['x-secret'], validate(v) { if (typeof v !== 'string') throw new Error('secret must be a string') } }
  const mustSync = { name: 'tenant', mustMatchWhenDerived: true, storage: makeStorage, deriveConstraint: (req) => req.headers['x-tenant'] }
  const asyncStrategy = (factory) =>
    factory === original
      ? { name: 'async', storage: makeStorage, deriveConstraint: (req, _ctx, done) => setTimeout(() => (req.headers['x-fail'] ? done(new Error('boom')) : done(null, req.headers['x-async'])), 1) }
      : { name: 'async', storage: makeStorage, deriveConstraintAsync: (req, done) => setTimeout(() => (req.headers['x-fail'] ? done(new Error('boom')) : done(null, req.headers['x-async'])), 1) }
  const custom = (factory, useAsync) => {
    const constraints = { secret: secretSync, tenant: mustSync }
    if (useAsync) constraints.async = asyncStrategy(factory)
    const router = factory({ constraints })
    router.on('GET', '/s', { constraints: { secret: 'alpha' } }, handlerA, 'alpha')
    router.on('GET', '/s', { constraints: { secret: 'beta' } }, handlerB, 'beta')
    router.on('GET', '/s', handlerC, 'open')
    router.on('GET', '/t', { constraints: { tenant: 'acme' } }, handlerA, 'acme')
    router.on('GET', '/t', handlerB, 'notenant')
    router.on('GET', '/st', { constraints: { secret: 'alpha', tenant: 'acme' } }, handlerA, 'alpha-acme')
    router.on('GET', '/st', { constraints: { secret: 'alpha' } }, handlerB, 'alpha-any')
    router.on('GET', '/st', { constraints: { host: 'h', secret: 'beta', version: '1.0.0' } }, handlerC, 'everything')
    if (useAsync) router.on('GET', '/a', { constraints: { async: 'yes' } }, handlerA, 'async-yes')
    if (useAsync) router.on('GET', '/a', handlerB, 'async-no')
    return router
  }
  const derivedSets = [{}, { secret: 'alpha' }, { secret: 'beta' }, { secret: 'gamma' }, { tenant: 'acme' }, { tenant: 'other' }, { secret: 'alpha', tenant: 'acme' }, { secret: 'alpha', tenant: 'other' }, { secret: 'beta', host: 'h', version: '1.0.0' }, { secret: 'beta', host: 'h', version: '1.x' }, { secret: 'beta', host: 'x', version: '1.0.0' }]
  for (const derived of derivedSets) {
    both(`custom constraints ${JSON.stringify(derived)}`, (factory) => {
      const router = custom(factory, false)
      return ['/s', '/t', '/st'].map((p) => normResult(router.find('GET', p, derived)))
    })
  }
  both('custom strategy validate', (factory) => custom(factory, false).on('GET', '/x', { constraints: { secret: 1 } }, handlerA))
  both('custom strategy registration errors', (factory) => {
    const errors = []
    const attempts = [{}, { name: '' }, { name: 'x' }, { name: 'x', storage: makeStorage }, { name: 'secret', storage: makeStorage, deriveConstraint: () => 'x' }, { name: 'version', storage: makeStorage, deriveConstraint: () => 'x' }, { name: 'host', storage: makeStorage, deriveConstraint: () => 'x' }]
    for (const attempt of attempts) {
      const router = custom(factory, false)
      router.on('GET', '/usesversion', { constraints: { version: '1.0.0' } }, handlerA)
      errors.push(outcome(() => router.addConstraintStrategy(attempt)))
    }
    return errors
  })
  both('custom host strategy before use is fine', (factory) => {
    const router = factory()
    router.addConstraintStrategy({ name: 'host', storage: makeStorage, deriveConstraint: (req) => req.headers['x-host'] })
    router.on('GET', '/h', { constraints: { host: 'custom' } }, handlerA, 'custom')
    return [router.hasConstraintStrategy('host'), router.hasConstraintStrategy('version'), router.hasConstraintStrategy('nope'), normResult(router.find('GET', '/h', { host: 'custom' })), router.prettyPrint()]
  })
  both('hasConstraintStrategy', (factory) => {
    const router = custom(factory, false)
    return ['secret', 'tenant', 'version', 'host', 'async', 'nope'].map((n) => router.hasConstraintStrategy(n))
  })
  both('addConstraintStrategy after routes rebuilds', (factory) => {
    const router = factory()
    router.on('GET', '/a', handlerA, 'plain')
    router.addConstraintStrategy(secretSync)
    router.on('GET', '/a', { constraints: { secret: 'alpha' } }, handlerB, 'alpha')
    return [normResult(router.find('GET', '/a', { secret: 'alpha' })), normResult(router.find('GET', '/a', {})), normResult(router.find('GET', '/a'))]
  })
  both('custom prettyPrint', (factory) => {
    const router = custom(factory, false)
    return [router.prettyPrint(), router.prettyPrint({ commonPrefix: false }), router.prettyPrint({ method: 'GET' })]
  })

  const makeReq = (method, url, headers = {}) => ({ method, url, headers })
  const makeRes = () => ({ statusCode: 200, ended: false, end() { this.ended = true } })
  const recording = (factory, useAsync) => {
    const calls = []
    const rec = (name) => {
      const fn = function (req, res, params, store, searchParams) {
        calls.push({ name, url: req.url, params: { ...params }, store: store ?? null, searchParams: { ...searchParams } })
      }
      Object.defineProperty(fn, 'name', { value: name })
      return fn
    }
    const router = factory({ constraints: useAsync ? { async: asyncStrategy(factory) } : {}, defaultRoute: (req, res) => { calls.push({ name: 'default', url: req.url }); res.statusCode = 404 } })
    router.on('GET', '/a/:id', rec('a'), 'storeA')
    router.on('GET', '/v', { constraints: { version: '1.0.0' } }, rec('v1'), 'v1')
    router.on('GET', '/v', { constraints: { version: '2.0.0' } }, rec('v2'), 'v2')
    router.on('GET', '/h', { constraints: { host: 'fastify.dev' } }, rec('hdev'), 'hdev')
    router.on('GET', '/h', rec('hany'), 'hany')
    router.on('GET', '/plain', rec('plain'))
    if (useAsync) router.on('GET', '/as', { constraints: { async: 'yes' } }, rec('as-yes'), 'yes')
    if (useAsync) router.on('GET', '/as', rec('as-no'), 'no')
    return { router, calls }
  }
  const requests = [
    makeReq('GET', '/a/1?x=1'), makeReq('GET', '/plain'), makeReq('GET', '/missing'), makeReq('POST', '/plain'), makeReq('GET', '/v', { 'accept-version': '1.x' }), makeReq('GET', '/v', { 'accept-version': '2.0.0' }), makeReq('GET', '/v'),
    makeReq('GET', '/v', { 'accept-version': '3.0.0' }), makeReq('GET', '/h', { host: 'fastify.dev' }), makeReq('GET', '/h', { host: 'other' }), makeReq('GET', '/h'), makeReq('GET', '/h', { ':authority': 'fastify.dev' }), makeReq('GET', '/a/%zz'), makeReq(undefined, '/plain'), makeReq('GET', 'http://fastify.dev/plain')
  ]
  for (const req of requests) {
    both(`lookup ${req.method} ${req.url} ${JSON.stringify(req.headers)}`, (factory) => {
      const { router, calls } = recording(factory, false)
      const res = makeRes()
      router.lookup({ ...req }, res)
      return { calls, statusCode: res.statusCode, ended: res.ended }
    })
  }
  both('lookup without defaultRoute ends with 404', (factory) => {
    const router = factory()
    const res = makeRes()
    router.lookup(makeReq('GET', '/nope'), res)
    return { statusCode: res.statusCode, ended: res.ended }
  })
  both('lookup with onBadUrl', (factory) => {
    const seen = []
    const router = factory({ onBadUrl: (path, req, res) => { seen.push(path); res.statusCode = 400 } })
    router.on('GET', '/a/:id', handlerA)
    const res = makeRes()
    router.lookup(makeReq('GET', '/a/%zz'), res)
    router.lookup(makeReq('GET', 'nope'), res)
    return { seen, statusCode: res.statusCode }
  })
  both('lookup with onMaxParamLength', (factory) => {
    const seen = []
    const router = factory({ maxParamLength: 2, onMaxParamLength: (path, req, res) => { seen.push(path); res.statusCode = 414 } })
    router.on('GET', '/a/:id', handlerA)
    const res = makeRes()
    router.lookup(makeReq('GET', '/a/xyz'), res)
    return { seen, statusCode: res.statusCode }
  })
  for (const req of [makeReq('GET', '/as', { 'x-async': 'yes' }), makeReq('GET', '/as', { 'x-async': 'no' }), makeReq('GET', '/as'), makeReq('GET', '/plain'), makeReq('GET', '/v', { 'accept-version': '1.0.0' }), makeReq('GET', '/as', { 'x-fail': '1' }), makeReq('GET', '/missing')]) {
    await bothAsync(`async lookup ${req.url} ${JSON.stringify(req.headers)}`, async (factory) => {
      const { router, calls } = recording(factory, true)
      const res = makeRes()
      const err = await new Promise((resolve) => router.lookup({ ...req }, res, (e) => resolve(e ? `${e.constructor.name}: ${e.message}` : null)))
      return { err, calls, statusCode: res.statusCode }
    })
  }
  both('async strategy find without derived', (factory) => {
    const { router } = recording(factory, true)
    return [normResult(router.find('GET', '/as')), normResult(router.find('GET', '/as', { async: 'yes' })), normResult(router.find('GET', '/as', {}))]
  })

  both('prettyPrint includeMeta', (factory) => {
    const router = factory({ buildPrettyMeta: (route) => ({ store: route.store ?? null, path: route.path, re: /x/g, list: [1, 'a', /y/], nothing: null, skip: undefined, nested: ['a', ['b']] }) })
    router.on('GET', '/a/:id', handlerA, { kind: 'A' })
    router.on('POST', '/a/:id', handlerB, { kind: 'B' })
    router.on('GET', '/a/:id', { constraints: { host: 'x' } }, handlerC, { kind: 'C' })
    router.on('GET', '/b', handlerD)
    router.on(['PUT', 'PATCH'], '/b', handlerD)
    router.on('GET', '/c/*', handlerA, { kind: 'wild' })
    router.on('GET', '/d/:x(\\d+)-:y', handlerB, { kind: 'regex' })
    router.on('GET', '/d/:x', handlerC, { kind: 'param' })
    return [
      router.prettyPrint({ includeMeta: true }), router.prettyPrint({ includeMeta: ['store', 'path'] }), router.prettyPrint({ includeMeta: ['missing'] }), router.prettyPrint({ includeMeta: true, commonPrefix: false }),
      router.prettyPrint({ method: 'GET', includeMeta: true }), router.prettyPrint({ method: 'GET', includeMeta: ['list'], commonPrefix: false }), router.prettyPrint()
    ]
  })
  both('prettyPrint merges methods with same constraints and meta', (factory) => {
    const router = factory({ buildPrettyMeta: (route) => ({ s: route.store ?? null }) })
    router.on('GET', '/x', handlerA, 1)
    router.on('POST', '/x', handlerB, 1)
    router.on('PUT', '/x', handlerC, 2)
    router.on('DELETE', '/x', { constraints: { version: '1.0.0' } }, handlerD, 1)
    router.on('HEAD', '/x', { constraints: { version: '1.0.0' } }, handlerD, 1)
    return [router.prettyPrint({ includeMeta: true }), router.prettyPrint()]
  })
  both('prettyPrint root wildcard and empty root', (factory) => {
    const router = factory()
    router.on('GET', '*', handlerA)
    router.on('GET', '/a', handlerB)
    const empty = factory()
    return [router.prettyPrint(), router.prettyPrint({ method: 'GET' }), router.prettyPrint({ commonPrefix: false }), empty.prettyPrint(), empty.prettyPrint({ method: 'GET' })]
  })

  both('verb shorthands', (factory) => {
    const router = factory()
    const verbs = ['acl', 'bind', 'checkout', 'connect', 'copy', 'delete', 'get', 'head', 'link', 'lock', 'm-search', 'merge', 'mkactivity', 'mkcalendar', 'mkcol', 'move', 'notify', 'options', 'patch', 'post', 'propfind', 'proppatch', 'purge', 'put', 'query', 'rebind', 'report', 'search', 'source', 'subscribe', 'trace', 'unbind', 'unlink', 'unlock', 'unsubscribe']
    for (const verb of verbs) router[verb]('/' + verb, handlerA, verb)
    router.all('/all', handlerB, 'all')
    router.get('/nostore', handlerC)
    return [router.routes.map((r) => [r.method, r.path, r.store ?? null]), verbs.map((verb) => normResult(router.find(verb.toUpperCase(), '/' + verb))), normResult(router.find('QUERY', '/all')), normResult(router.find('GET', '/nostore'))]
  })

  return count
}
