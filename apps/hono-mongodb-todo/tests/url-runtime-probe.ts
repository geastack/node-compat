import { ConnectionString } from 'mongodb-connection-string-url'
import { URL as WhatwgURL, URLSearchParams as WhatwgURLSearchParams } from 'whatwg-url'

function expect(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
  console.log(label + '=' + actual)
}

const connection = new ConnectionString('mongodb://127.0.0.1:27017/gea_hono_todo')
expect('connection.protocol', connection.protocol, 'mongodb:')
expect('connection.username', connection.username, '')
expect('connection.password', connection.password, '')
expect('connection.hosts', connection.hosts.join(','), '127.0.0.1:27017')
expect('connection.pathname', connection.pathname, '/gea_hono_todo')
expect('connection.origin', connection.origin, 'null')
expect('connection.string', connection.toString(), 'mongodb://127.0.0.1:27017/gea_hono_todo')

const params = new WhatwgURLSearchParams('?A=1+2&A=x%2Fy&empty&eq=a=b')
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

const url = new WhatwgURL('mongodb://user%20x:p%40ss@127.0.0.1:27017/db?a=1+2')
expect('url.username', url.username, 'user%20x')
expect('url.password', url.password, 'p%40ss')
expect('url.host', url.host, '127.0.0.1:27017')
expect('url.hostname', url.hostname, '127.0.0.1')
expect('url.port', url.port, '27017')
expect('url.origin', url.origin, 'null')
url.username = 'new user'
url.password = 'new@password'
url.searchParams.set('a', 'x/y')
expect('url.mutated', url.toString(), 'mongodb://new%20user:new%40password@127.0.0.1:27017/db?a=x%2Fy')
