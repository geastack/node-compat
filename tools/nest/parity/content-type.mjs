export async function run({ shim, original, assert }) {
  let count = 0
  const result = (fn) => {
    try {
      return { value: fn() }
    } catch (error) {
      return { error: `${error.name}: ${error.message}` }
    }
  }
  const plain = (r) => (r.value === undefined ? r : { value: { ...r.value, parameters: { ...r.value.parameters } } })
  const both = (label, call) => {
    assert.deepEqual(plain(result(() => call(shim))), plain(result(() => call(original))), label)
    count++
  }

  const headers = [
    'text/html',
    'TEXT/HTML',
    '  text/html  ',
    'text/html; charset=utf-8',
    'text/html;charset=utf-8',
    'text/html ; charset = utf-8 ',
    'text/html; charset=UTF-8; foo=bar',
    'text/html; charset="utf-8"',
    'text/html; charset="ut\\"f-8"',
    'text/html; charset="a\\\\b"',
    'text/html; charset="unterminated',
    'text/html; charset=utf-8; charset=iso-8859-1',
    'text/html; CHARSET=utf-8',
    'text/html; charset',
    'text/html; =utf-8',
    'text/html; charset=; foo=bar',
    'text/html;;; charset=utf-8',
    'text/html; charset="utf-8" junk; foo=bar',
    'text/html; charset=utf-8, text/plain',
    'text/html, text/plain; q=0.5',
    'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW',
    'application/json;charset=utf-8;q=0.9',
    '',
    ';',
    '; charset=utf-8',
    'text/html;\tcharset=utf-8',
    'text/html; charset=\t utf-8 \t',
    'text/html; a=1; b="2"; c=3'
  ]
  const optionSets = [undefined, {}, { parameters: false }, { comma: true }, { comma: true, parameters: false }, { start: 5 }, { start: 0, comma: true }]
  for (const header of headers) {
    for (const options of optionSets) {
      both(`parse(${JSON.stringify(header)}, ${JSON.stringify(options)})`, (m) => m.parse(header, options))
    }
  }

  const inputs = [
    { type: 'text/html' },
    { type: 'text/html', parameters: {} },
    { type: 'text/html', parameters: { charset: 'utf-8' } },
    { type: 'text/html', parameters: { charset: 'utf-8', foo: 'bar baz' } },
    { type: 'text/html', parameters: { foo: 'a"b' } },
    { type: 'text/html', parameters: { foo: 'a\\b' } },
    { type: 'text/html', parameters: { foo: '' } },
    { type: 'text/html', parameters: { foo: 'tab\there' } },
    { type: 'text/html', parameters: { foo: 'new\nline' } },
    { type: 'text/html', parameters: { foo: 'é' } },
    { type: 'text/html', parameters: { foo: 'Ā' } },
    { type: 'text/html', parameters: { 'bad name': 'x' } },
    { type: 'text/html', parameters: { 'b@d': 'x' } },
    { type: 'text/html', parameters: { ok: 'x', 'bad name': 'y' } },
    { type: 'text' },
    { type: 'text/' },
    { type: 'text/ht ml' },
    { type: '' },
    {},
    { type: 'TEXT/HTML', parameters: { Charset: 'UTF-8' } }
  ]
  for (const input of inputs) {
    both(`format(${JSON.stringify(input)})`, (m) => m.format(input))
  }
  return count
}
