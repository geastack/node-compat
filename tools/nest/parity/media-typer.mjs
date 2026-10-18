export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: JSON.parse(JSON.stringify(call(m))) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  const strings = [
    'text/html', 'TEXT/HTML', ' text/html ', 'application/json', 'application/vnd.api+json', 'image/svg+xml', 'a/b+c+d',
    'text/html; charset=utf-8', 'text', 'text/', '/html', 'text//html', 'text/ht ml', 'te xt/html', '*/*', 'text/*',
    'a-b/c.d_e!f#g$h&i^j', '0/0', 'x/' + 'y'.repeat(127), 'x/' + 'y'.repeat(128), '', 'application/x-www-form-urlencoded',
    'multipart/form-data', 'text/plain+', 'text/+json', 'a/b+', '-a/b', 'a/-b'
  ]
  for (const s of strings) {
    both(`test(${JSON.stringify(s)})`, (m) => m.test(s))
    both(`parse(${JSON.stringify(s)})`, (m) => m.parse(s))
  }
  both('test non-string', (m) => m.test(1))
  both('parse non-string', (m) => m.parse(null))
  const objects = [
    { type: 'text', subtype: 'html' }, { type: 'application', subtype: 'vnd.api', suffix: 'json' }, { type: 'text', subtype: 'ht ml' },
    { type: 'te xt', subtype: 'html' }, { type: 'text' }, { subtype: 'html' }, { type: 'text', subtype: 'html', suffix: 'x y' },
    { type: 'text', subtype: 'html', suffix: '' }, { type: 'a.b', subtype: 'c' }, { type: 'a', subtype: 'b.c' }, null, 'text/html', 42
  ]
  for (const o of objects) both(`format(${JSON.stringify(o)})`, (m) => m.format(o))
  both('format(parse(x))', (m) => m.format(m.parse('Application/VND.API+JSON')))
  return count
}
