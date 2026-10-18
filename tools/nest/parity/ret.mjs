export async function run({ shim, original, assert }) {
  let count = 0
  const outcome = (call) => {
    try {
      return { value: JSON.parse(JSON.stringify(call())) }
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` }
    }
  }
  const both = (label, call) => {
    assert.deepEqual(outcome(() => call(shim)), outcome(() => call(original)), label)
    count++
  }

  for (const name of Object.keys(shim.types)) assert.equal(shim.types[name], original.types[name], `types.${name}`)
  assert.deepEqual(Object.keys(shim.types).sort(), Object.keys(original.types).filter((k) => Number.isNaN(Number(k))).sort())
  count++
  assert.equal(shim.default, shim.tokenizer)
  count++

  const sources = [
    '', 'a', 'abc', '.', '..', 'a.b', '\\.', '\\/', '\\\\', '\\d', '\\D', '\\w', '\\W', '\\s', '\\S', '\\b', '\\B', '^', '$', '^abc$', '^$',
    '\\d+', '\\d*', '\\d?', '\\d{3}', '\\d{3,}', '\\d{3,5}', '\\d{0,1}', 'a{2}b{3,}c{1,2}', 'a*?', 'a+?', 'a??', 'a{2,3}?', 'a{,2}', 'a{2', 'a{}', 'a{x}',
    '[a-z]', '[a-z]+', '[A-Za-z0-9_-]', '[^abc]', '[^a-z]', '[]', '[^]', '[a-]', '[-a]', '[a-b-c]', '[\\]]', '[\\[]', '[.]', '[\\d]', '[\\D\\w\\W\\s\\S]', '[\\b]', '[a\\-z]', '[\\^]', '[\\\\]',
    '[\\u0041-\\u005A]', '[\\x41]', '[\\cA]', '\\u0041', '\\x41', '\\cA', '\\c@', '\\c[', '\\c?', '\\0', '\\t\\n\\v\\f\\r', '[\\t\\n]', '\\u00e9', '\\uD83D\\uDE00', 'caf\\u00e9',
    '(a)', '(ab)', '(a)(b)', '((a)(b))', '(a(b(c)))', '(?:a)', '(?:ab)+', '(?=a)', '(?!a)', '(?!a)b', '(?<=a)', '(?<!a)', '(?<name>a)', '(?P<name>a)', '(?i)a',
    'a|b', 'a|b|c', '(a|b)', '(a|b|c)+', '(a|(b|c))', '(|a)', '(a|)', '|', 'a||b', '^(a|b)$', '(.*?)', '(.+)', '(.*?)-(.*?)', '(.*?)\\.(.*?)', '(?:(?!-).)*', '(-|(?:(?!-).)*)',
    '\\1', '(a)\\1', '(a)(b)\\2', '(a)\\2', '\\10', '(a)\\0', '\\k<name>', 'a\\', '\\(', '\\)', '\\[', '\\]', '\\{', '\\}', '\\|', '\\*', '\\+', '\\?', '\\^', '\\$',
    '(', ')', '(()', '())', '*', '+', '?', '*a', 'a**', 'a++', 'a*+', '{1}', 'a{1}{2}', '[a', '[a-', 'a]', '^*', '$+', '(?:)', '(?:*)', '(*)', '(|*)', '\\b*', '\\B+',
    '[a-z]{1,3}', '[0-9]{4}-[0-9]{2}-[0-9]{2}', '^(\\d{4})-(\\d{2})$', '^[a-f0-9]{32}$', '^v\\d+(\\.\\d+)*$', '^\\w+@\\w+\\.\\w+$', '^(?:[a-z]+-)*[a-z]+$', '(\\d+)\\.(\\d+)',
    '/users/:id', ':id', '::', '*', '/*', '/a/*', 'ab\\u00e9+', '[^/]+', '[^/]*', '(?:[^/]+)', 'x{10}y{20}z{30}', '(a+)+', '(a|a)+', '(a*)*', '(a*)+', '((a+)+)+'
  ]
  for (const source of sources) both(`tokenizer(${JSON.stringify(source)})`, (m) => (m === shim ? m.tokenizer(source) : m(source)))

  const regexps = [/\d+/, /[a-z]+/i, /^\/?$/, /(.*?)/, /A/, /\x41/, /[A-Z]/, /(a|b)c/, /\bword\b/, /\\/, /\//, /[/]/, /\p{L}/u, /(?<y>\d{4})/]
  for (const regexp of regexps) both(`tokenizer(${regexp}.source)`, (m) => (m === shim ? m.tokenizer(regexp.source) : m(regexp.source)))

  return count
}
