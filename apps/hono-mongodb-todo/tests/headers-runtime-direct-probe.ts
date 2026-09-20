import { Headers } from '../../../runtime/node/globals.ts'

function expect(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
  console.log(label + '=' + actual)
}

const headers = new Headers()
headers.set('Content-Type', 'application/json')
headers.append('X-Amz-Date', '20260713T120000Z')
headers.set('content-type', 'text/plain')

expect('headers.keys', headers.keys().join('|'), 'content-type|x-amz-date')
expect(
  'headers.entries',
  headers
    .entries()
    .map(entry => entry[0] + ':' + entry[1])
    .join('|'),
  'content-type:text/plain|x-amz-date:20260713T120000Z'
)
