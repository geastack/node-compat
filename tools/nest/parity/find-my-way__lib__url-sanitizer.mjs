export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, call) => {
    const results = [shim, original].map((m) => { try { return { value: call(m) } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } } })
    assert.deepEqual(results[0], results[1], label)
    count++
  }
  assert.equal(shim.MIN_NATIVE_SCAN_LENGTH, original.MIN_NATIVE_SCAN_LENGTH); count++
  const paths = [
    '/', '/a', '/a/b/c', '/a?b=c', '/a#frag', '/a?b#c', '/a#b?c', '/a;jsessionid=1', '/a;b?c', '/a%20b', '/a%2Fb', '/a%2fb', '/a%25b', '/a%2525b',
    '/a%23b', '/a%24b', '/a%26b', '/a%2Bb', '/a%2Cb', '/a%3Ab', '/a%3Bb', '/a%3Db', '/a%3Fb', '/a%40b', '/a%C3%A9', '/a%E2%9C%93', '/%', '/%2', '/%zz', '/a%',
    '/a%20b?c=%20d', '/caf%C3%A9/na%C3%AFve/thing', '/users/%3A1/posts', '/x?%2F', '/a%2Fb/longer/path/here', '/longer/path/without/encoding', '/longer/path/with/%20/encoding',
    '/longer/path/with/%2F/encoding?q=1', '/longer/path/with/%25/encoding', '/longer/path/with/%2525/encoding', '/longer/path/with/%2F%25%23/encoding', '/longer/path/?q=%2F',
    '/longer/path/#frag%2F', '/longer/path/;sess%2F', '/short%2F;x', '/%2F%2F%2F', '/a%E0%A4%A', '/%C3%A9', '/%E9', '/%ZZ', '//a', '/a//b', '/a/b/', '/a?', '/a#', '/a;', '?a=b', '#x', ';x',
    '/%25%32%30', '/%2%2F', '/a%2Fb%zz', '/a%2fb%2Fc%2Fd%2Fe%2Ff%2Fg%2Fh', '/' + 'x'.repeat(50) + '%2F' + 'y'.repeat(50), '/a%2Fb?c%2Fd#e%2Ff', '/a%3F?b%3F', '/a%23#b%23'
  ]
  for (const p of paths) {
    for (const semicolon of [false, true]) {
      both(`safeDecodeURI(${JSON.stringify(p)}, ${semicolon})`, (m) => m.safeDecodeURI(p, semicolon))
      both(`safeDecodeURICharScan(${JSON.stringify(p)}, ${semicolon})`, (m) => m.safeDecodeURICharScan(p, semicolon, 1))
      both(`safeDecodeURINativeScan(${JSON.stringify(p)}, ${semicolon})`, (m) => m.safeDecodeURINativeScan(p, semicolon))
    }
  }
  const components = ['a', 'a%2Fb', 'a%2fb', 'a%23%24%25%26%2B%2C%2F%3A%3B%3D%3F%40', '%2F', 'a%2F', '%2Fa', 'a%2F%2Fb', 'a%', 'a%2', 'a%zz', '%', '', 'no-encoding', 'a%25b', 'a%E2%9C%93b', 'a%20b', 'a%2Fb%20c%2Fd', '%2F%20%2F']
  for (const c of components) both(`safeDecodeURIComponent(${JSON.stringify(c)})`, (m) => m.safeDecodeURIComponent(c))
  both('default export shape', (m) => Object.keys(m.default ?? m).sort())
  return count
}
