export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    assert.deepEqual(call(shim), call(original), label)
    count++
  }

  assert.equal(shim.default, shim.safeRegex)
  count++

  const sources = [
    '', 'a', 'abc', '\\d+', '\\d*', '[a-z]+', '(.*?)', '(.+)', '^\\d{3}$', '^[a-f0-9]{32}$', '(\\d+)\\.(\\d+)', '(a|b)+', '(a|b)*', '(?:(?!-).)*', '(-|(?:(?!-).)*)',
    '(a+)+', '(a*)*', '(a|a)+', '((a+)+)+', '(a|aa)+', '(\\w+\\s?)*', '(.*a){10}', '(.*a){26}', '(x+x+)+y', '^(([a-z])+.)+[A-Z]([a-z])+$', '(a+){2}', '(?:a+)+',
    'a{2,3}', 'a{2,3}b{4}', 'a*b*c*', 'a+b+c+', 'a?b?c?', 'a*?b+?', '(a)(b)(c)', '(a)+(b)+', '[a-z]*[0-9]*',
    'a*'.repeat(10), 'a*'.repeat(25), 'a*'.repeat(26), 'a*'.repeat(30), '(a*)'.repeat(5), 'a+b*c?d{2}e{3,}', '(a+)(b+)(c+)(d+)',
    '(', ')', '*', '+a', 'a**', '[a', 'a{2', '\\', '(?:', '(a|)', '(|)', '\\1', '(a)\\1+', '\\k<x>', '(?<x>a)\\k<x>', '.*', '.*.*', '(.*)*', '(.*)+', '(.*?)+', '(?=a+)+', '(?!a+)+',
    '[^/]+', '(?:[^/]+)+', '[^/]*', '^/users/(\\d+)$', '^v(\\d+)(?:\\.(\\d+))*$', '^(\\d{4})-(\\d{2})-(\\d{2})$', '^\\w+@\\w+\\.\\w+$', '^(?:[a-z]+-)*[a-z]+$', '\\u0041+', '[\\u0041-\\u005a]+'
  ]
  for (const source of sources) {
    both(`safeRegex(${JSON.stringify(source)})`, (m) => m.safeRegex(source))
    both(`default(${JSON.stringify(source)})`, (m) => m.default(source))
    for (const limit of [0, 1, 2, 5, 10, 25, 100]) both(`safeRegex(${JSON.stringify(source)}, {limit: ${limit}})`, (m) => m.safeRegex(source, { limit }))
    both(`safeRegex(${JSON.stringify(source)}, {})`, (m) => m.safeRegex(source, {}))
  }

  const regexps = [/\d+/, /[a-z]+/i, /(a+)+/, /(.*?)/, /(a|b)+/g, /^\/?$/, /(\d+)\.(\d+)/, /(x+x+)+y/, /\p{L}+/u, /(?<y>\d{4})/, /a*b*c*/, /(a*)*/]
  for (const regexp of regexps) {
    both(`safeRegex(${regexp})`, (m) => m.safeRegex(regexp))
    both(`safeRegex(${regexp}, {limit: 1})`, (m) => m.safeRegex(regexp, { limit: 1 }))
  }

  return count
}
