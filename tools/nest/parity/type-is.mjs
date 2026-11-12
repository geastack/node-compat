export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: call(m) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const headerSets = [
    {}, { 'content-length': '0' }, { 'content-length': '12' }, { 'content-length': 'abc' }, { 'content-length': '' }, { 'content-length': ' 1 ' },
    { 'transfer-encoding': 'chunked' }, { 'transfer-encoding': '' }, { 'content-length': ['1', '2'] }, { 'content-length': ['x'] }
  ]
  const contentTypes = [
    undefined, '', 'application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'application/vnd.api+json', 'text/html',
    'text/plain', 'text/x-custom', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=abc', 'image/svg+xml', 'application/ld+json',
    'application/octet-stream', 'text/html;;', 'text/html; charset', 'text/ht ml', 'nonsense', 'text/', 'a/b+c+d', '*/*', 'application/json , text/plain'
  ]
  const candidateLists = [
    [], ['json'], ['application/json'], ['+json'], ['*/json'], ['*/*'], ['text/*'], ['urlencoded'], ['multipart'], ['html'], ['application/*'],
    ['json', 'urlencoded'], ['text/*', '+json'], ['*/*+json'], ['application/*+json'], ['bogus'], ['text/html', 'application/json'], ['*/'], ['a/b/c'],
    [['json', 'urlencoded']], [['json'], 'html'], [undefined], ['+xml'], ['application/vnd.api+json']
  ]
  for (const headers of headerSets) {
    for (const ct of contentTypes) {
      const req = { headers: ct === undefined ? { ...headers } : { ...headers, 'content-type': ct } }
      both(`hasBody ${JSON.stringify(req.headers)}`, (m) => m.hasBody(req))
      for (const candidates of candidateLists) {
        const label = `typeofrequest(${JSON.stringify(req.headers)}, ${JSON.stringify(candidates)})`
        both(label + ' spread', (m) => (m.default ?? m)(req, ...candidates))
        both(label + ' array', (m) => (m.default ?? m)(req, candidates))
        both(label + ' is(header)', (m) => m.is(req.headers['content-type'], candidates))
      }
    }
  }
  for (const type of ['json', 'urlencoded', 'multipart', '+json', 'text/html', 'html', 'bogus', '', 'JSON', 42, undefined]) both(`normalize(${JSON.stringify(type)})`, (m) => m.normalize(type))
  for (const [e, a] of [['text/*', 'text/html'], ['*/*+json', 'application/vnd.api+json'], ['*/*+json', 'application/json'], ['*/*+json', 'application/n'], ['application/json', 'application/json'], [false, 'text/html'], ['a/b/c', 'a/b'], ['*/json', 'text/json'], ['*+json', 'application/json']]) {
    both(`match(${e}, ${a})`, (m) => m.match(e, a))
  }
  return count
}
