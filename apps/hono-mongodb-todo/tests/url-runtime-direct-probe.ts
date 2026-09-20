import { URL, URLSearchParams } from '../../../runtime/node/globals.ts'

function expect(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
  console.log(label + '=' + actual)
}

const params = new URLSearchParams('?A=1+2&A=x%2Fy&empty&eq=a=b')
expect('params.duplicates', params.getAll('A').join('|'), '1 2|x/y')
expect('params.empty', params.get('empty') ?? '<null>', '')
expect('params.equals', params.get('eq') ?? '<null>', 'a=b')
expect('params.missing', params.get('missing') ?? '<null>', '<null>')

params.set('A', 'reset value')
params.append('slash', 'x/y')
params.append('delete-me', '1')
params.delete('delete-me')
expect('params.serialized', params.toString(), 'A=reset+value&empty=&eq=a%3Db&slash=x%2Fy')

const keys: string[] = []
for (const key of params.keys()) keys.push(key)
expect('params.keys', keys.join('|'), 'A|empty|eq|slash')

const entries: string[] = []
for (const entry of params.entries()) entries.push(entry[0] + ':' + entry[1])
expect('params.entries', entries.join('|'), 'A:reset value|empty:|eq:a=b|slash:x/y')

const iterated: string[] = []
for (const entry of params) iterated.push(entry[0] + ':' + entry[1])
expect('params.iterator', iterated.join('|'), 'A:reset value|empty:|eq:a=b|slash:x/y')

const url = new URL('mongodb://user%20x:p%40ss@127.0.0.1:27017/db?a=1+2')
expect('url.protocol', url.protocol, 'mongodb:')
expect('url.username', url.username, 'user%20x')
expect('url.password', url.password, 'p%40ss')
expect('url.host', url.host, '127.0.0.1:27017')
expect('url.hostname', url.hostname, '127.0.0.1')
expect('url.port', url.port, '27017')
expect('url.pathname', url.pathname, '/db')
expect('url.origin', url.origin, 'null')
url.username = 'new user'
url.password = 'new@password'
url.searchParams.set('a', 'x/y')
expect('url.mutated', url.toString(), 'mongodb://new%20user:new%40password@127.0.0.1:27017/db?a=x%2Fy')

const hostAddress = new URL('iLoveJS://[::1]:27018')
expect('ipv6.protocol', hostAddress.protocol, 'ilovejs:')
expect('ipv6.hostname', hostAddress.hostname, '[::1]')
expect('ipv6.port', hostAddress.port, '27018')
