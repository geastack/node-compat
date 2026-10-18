export async function run({ shim, original, assert }) {
  let count = 0
  const both = (str) => {
    assert.equal(shim.default(str), original(str), `encodeUrl(${JSON.stringify(str)})`)
    count++
  }
  const strings = [
    '', '/', '/foo/bar', '/foo bar', '/foo%20bar', '/foo%zzbar', '/foo%2', '/foo%', '/foo%%20', '/path?a=1&b=2#frag', '/héllo', '/日本語', '/😀', '/\uD83D', '/\uDE00', '/😀',
    '/\uD83Dx', 'x\uDE00', '\uD83D', '\uDE00', '/a😀b\uD83Dc', 'http://example.com/path with spaces', 'http://example.com/%E6%97%A5', '/foo"bar', "/foo'bar", '/foo<bar>',
    '/foo\\bar', '/foo`bar', '/foo{bar}', '/foo|bar', '/foo^bar', '/foo[bar]', '/foo~bar', '/foo-bar_baz.qux', '/foo\nbar', '/foo\tbar', '/foo\u0000bar', '/foo%00bar', '//double//slash/',
    '/nested/', '/a/b/../c', '/%E2%82%AC', '/€', '%', '%%', '%2', '%2G', '%20%20', '/foo%E2%82', '/foo%E2%82%AC', 'ftp://[::1]/path', '/a?b=c d&e=f%20g', '/a#b c'
  ]
  for (const str of strings) both(str)
  return count
}
