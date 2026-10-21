const single: string[] = [
  'http://example.com',
  'https://example.com/a/b?c#d',
  'HTTP://EXAMPLE.COM',
  'http://user:pw@host:8080/p',
  'http://[::1]:3000/',
  'http://[::1',
  'http://',
  'http:///path',
  'http:example.com',
  'http:/example.com',
  'http://exa mple.com',
  'http://a<b',
  'http://host:abc',
  'http://host:65536',
  'http://host:99999999',
  'http://host:',
  'ftp://x',
  'ws://x',
  'wss://x',
  'file:///tmp/x',
  'file://',
  'file:x',
  'file://a:80/',
  'file://u@a/',
  'mailto:a@b',
  'data:text/plain,hi',
  'javascript:alert(1)',
  'a:',
  'a:b',
  '1a:b',
  '-a:b',
  '+a:b',
  'a+b-c.d:x',
  '/users/1?x=1',
  'users/1',
  '',
  '   http://x',
  'http://x   ',
  'http://x\ty',
  '//example.com/p',
  '?x',
  '#f',
  'http://%41.com',
  'http://a%20b.com',
  'http://a_b.com',
  'http://a|b',
  'http://a^b',
  'http://a\\b',
  'http://xn--ls8h.la',
  'http://例え.jp',
  'http://a..b',
  'http://192.168.0.300',
  'http://0x7f.1',
  'http://0x7f.1.',
  'http://1.2.3.4.5',
  'http://1..2',
  'http://[v1.x]',
  'http://a/b c',
  'http://a/\u0007',
  'http://a/%zz',
  'http://:80',
  'http://@a',
  'http://%zz.com',
  'http://012.1.1.1',
  'http://1.1.1.0x',
  'http://999999999999'
]
const pairs: [string, string][] = [
  ['/users/1', 'http://example.com'],
  ['users/1', 'http://example.com/a/'],
  ['?x', 'http://x'],
  ['', 'http://x'],
  ['/p', 'not a base'],
  ['/p', ''],
  ['http://y', 'not a base'],
  ['//z/p', 'http://x'],
  ['//[::1', 'http://x'],
  ['/p', 'mailto:a'],
  ['p', 'mailto:a'],
  ['#f', 'mailto:a'],
  ['/p', 'a:/x'],
  ['p', 'a:/x'],
  ['//z', 'a:/x'],
  ['/p', 'file:///tmp/'],
  ['/p', 'data:text/plain,hi'],
  ['\\\\z\\p', 'http://x']
]
const lines: string[] = []
for (const url of single) lines.push(`${URL.canParse(url)} ${JSON.stringify(url)}`)
for (const [url, base] of pairs) lines.push(`${URL.canParse(url, base)} ${JSON.stringify(url)} base=${JSON.stringify(base)}`)
lines.push(`${URL.canParse(new URL('http://x/'))} URL object`)
lines.push(`${URL.canParse('/p', new URL('http://x/'))} URL base`)
const constructs = (url: string, base?: string): string => {
  try {
    new URL(url, base)
    return 'parses'
  } catch (error) {
    const thrown = error as { name: string; code?: string; message: string; input?: string; base?: string }
    return `throws ${thrown.name} ${thrown.code} ${thrown.message} input=${thrown.input} base=${thrown.base}`
  }
}
for (const url of single) lines.push(`${constructs(url)} ${JSON.stringify(url)}`)
for (const [url, base] of pairs) lines.push(`${constructs(url, base)} ${JSON.stringify(url)} base=${JSON.stringify(base)}`)
console.log(lines.join('\n'))
