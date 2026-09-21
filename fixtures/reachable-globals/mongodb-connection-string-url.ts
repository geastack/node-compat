// Stand-in for `mongodb-connection-string-url`'s typed source -- see
// `connection-string.ts` next to this file for why a fixture stands in for
// the real package here. The real package's `.d.ts` says `import { URL } from
// 'whatwg-url'` and builds `ConnectionString` on it (`class ConnectionString
// extends URL`); this mirrors that shape.
import { URL } from 'whatwg-url'

export default class ConnectionString extends URL {}
