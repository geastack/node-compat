export async function run({ shim, original, assert }) {
  let count = 0
  const shape = (error) => ({
    name: error.name,
    message: error.message,
    status: error.status,
    statusCode: error.statusCode,
    expose: error.expose,
    headers: error.headers ?? null,
    code: error.code ?? null,
    syscall: error.syscall ?? null,
    errno: error.errno ?? null,
    path: error.path ?? null,
    isError: error instanceof Error
  })
  const outcome = (call) => {
    try {
      return { value: shape(call()) }
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` }
    }
  }
  const both = (label, make) => {
    assert.deepEqual(outcome(() => make(shim.default)), outcome(() => make(original)), label)
    count++
  }

  const systemError = () => Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), { code: 'ENOENT', errno: -2, syscall: 'stat', path: '/x' })
  const typeError = () => new TypeError('bad type')
  const headers = { 'Content-Range': 'bytes */1000' }

  both('createError()', (create) => create())
  for (const status of [400, 401, 403, 404, 405, 409, 410, 412, 416, 418, 422, 429, 431, 451, 500, 501, 502, 503, 504, 505, 511]) {
    both(`createError(${status})`, (create) => create(status))
    both(`createError(${status}, 'msg')`, (create) => create(status, 'custom message'))
    both(`createError(${status}, '')`, (create) => create(status, ''))
    both(`createError(${status}, {expose})`, (create) => create(status, { expose: !(status < 500) }))
    both(`createError(${status}, {headers})`, (create) => create(status, { headers }))
    both(`createError(${status}, 'msg', {headers})`, (create) => create(status, 'custom message', { headers }))
    both(`createError(${status}, systemError)`, (create) => create(status, systemError()))
    both(`createError(${status}, systemError, {expose: false})`, (create) => create(status, systemError(), { expose: false }))
    both(`createError(${status}, typeError)`, (create) => create(status, typeError()))
  }
  for (const status of [499, 599, 450, 509, 599, 200, 201, 204, 301, 302, 304, 100, 101]) {
    both(`createError(${status})`, (create) => create(status))
    both(`createError(${status}, 'msg')`, (create) => create(status, 'custom message'))
    both(`createError(${status}, systemError)`, (create) => create(status, systemError()))
  }
  for (const status of [0, 99, 199, 299, 399, 600, 601, 999, -1, 1000]) {
    both(`createError(${status})`, (create) => create(status))
    both(`createError(${status}, 'msg')`, (create) => create(status, 'custom message'))
  }
  both("createError('msg')", (create) => create('only a message'))
  both("createError('msg', {headers})", (create) => create('only a message', { headers }))
  both('createError({headers})', (create) => create({ headers }))
  both('createError({expose: true})', (create) => create({ expose: true }))
  both('createError(systemError)', (create) => create(systemError()))
  both('createError(systemError, {headers})', (create) => create(systemError(), { headers }))
  both('createError(typeError)', (create) => create(typeError()))
  both("createError(400, 'a', 'b')", (create) => create(400, 'a', 'b'))

  const sameInstance = (create) => {
    const first = create(404)
    const second = create(404, first)
    assert.equal(second, first, 'same instance for a matching status')
    return second
  }
  both('createError(404, createError(404))', sameInstance)
  both('createError(createError(404))', (create) => create(create(404)))
  both('createError(500, createError(404))', (create) => create(500, create(404)))
  both('createError(createError(404), {expose: false})', (create) => create(create(404), { expose: false }))
  both('createError(404, createError(403, {headers}))', (create) => create(404, create(403, { headers })))
  both("createError(404, createError(404, 'msg'))", (create) => create(404, create(404, 'custom message')))
  both('createError(createError(404, systemError))', (create) => create(create(404, systemError())))

  for (const [label, value, sameInstanceOf] of [
    ['createError(404)', (create) => create(404), true],
    ['createError(500)', (create) => create(500), true],
    ['createError(404, systemError)', (create) => create(404, systemError()), false],
    ['createError(200)', (create) => create(200), false],
    ['new Error', () => new Error('x'), true],
    ['decorated Error', () => Object.assign(new Error('x'), { expose: true, status: 404, statusCode: 404 }), false],
    ['null', () => null, true],
    ['string', () => 'x', true],
    ['{}', () => ({}), true]
  ]) {
    const shimError = value(shim.default)
    const originalError = value(original)
    if (sameInstanceOf) {
      assert.equal(shim.isHttpError(shimError), original.isHttpError(originalError), `isHttpError(${label})`)
      assert.equal(shimError instanceof shim.HttpError, originalError instanceof original.HttpError, `${label} instanceof HttpError`)
    } else {
      assert.equal(shim.isHttpError(shimError), shimError instanceof shim.HttpError, `isHttpError(${label}) is instanceof here`)
      assert.equal(original.isHttpError(originalError), true, `the package duck-types ${label}`)
    }
    count += 2
  }
  assert.throws(() => new original.HttpError(), TypeError, 'the package HttpError is abstract')
  assert.ok(shim.default(404) instanceof Error && shim.default(404) instanceof shim.HttpError)
  count += 2

  return count
}
