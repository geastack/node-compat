export async function run({ shim, original, assert }) {
  let count = 0
  const sorted = (map) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  assert.deepEqual(sorted(shim.types), sorted(original.types), 'types map')
  assert.deepEqual(sorted(shim.extensions), sorted(original.extensions), 'extensions map')
  count += 2
  const both = (label, call) => {
    assert.deepEqual(call(shim), call(original), label)
    count++
  }
  const fns = ['lookup', 'contentType', 'charset', 'extension']
  const inputs = new Set([
    ...Object.keys(original.types), ...Object.keys(original.extensions),
    ...Object.keys(original.types).map((e) => '.' + e), ...Object.keys(original.types).map((e) => 'dir/file.' + e),
    ...Object.keys(original.extensions).map((t) => t + '; charset=utf-8'), ...Object.keys(original.extensions).map((t) => t.toUpperCase()),
    'text/html; charset=iso-8859-1', 'TEXT/HTML', 'application/json', 'application/octet-stream', 'text/x-unknown', 'x/y',
    'json', 'JSON', '.JSON', 'file', 'file.', '.', '..', '', 'a.b.c.json', '/path/to/file.JS', 'no-such-ext', 'C:\\dir\\x.txt', 'a/b', 'a/b/c.md',
    '  text/html', 'text/html ;x=1', 'text/html;', 'text/', '/html', 'text', 'application/vnd.ms-excel',
    'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'image/svg+xml', 'application/javascript', 'text/javascript',
    'application/wasm', 'font/woff2',
    'constructor', '.constructor', 'x.constructor', '__proto__', 'x.__proto__', 'toString', 'hasOwnProperty', 'a/constructor', 'constructor/x', 'text/constructor',
    'application/__proto__', 'valueOf', 'x.valueOf', 'a/toString; charset=utf-8', 'application/x-font-ttf', 'video/mp4', 'audio/ogg', 'markdown', 'md', 'mjs', 'cjs', 'ts', 'tsx', 'map'
  ])
  for (const fn of fns) {
    for (const input of inputs) both(`${fn}(${JSON.stringify(input)})`, (m) => m[fn](input))
    for (const bad of [undefined, null, 42, {}, [], true]) both(`${fn}(${String(bad)})`, (m) => m[fn](bad))
  }
  both('charsets.lookup', (m) => m.charsets.lookup('text/plain'))
  return count
}
