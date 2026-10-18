export async function run({ shim, original, assert }) {
  let count = 0
  const both = (str) => {
    assert.equal(shim.default(str), original(str), `escapeHtml(${JSON.stringify(str)})`)
    count++
  }
  const strings = [
    '', 'plain text', '"', '&', "'", '<', '>', '<script>alert("x")</script>', "it's & that's", 'a < b > c', '&amp;', '&&&&', '""""', '<<>>', 'x"y&z\'w<v>u',
    'héllo <wörld> & "ünïcode"', '😀 <emoji> & "x"', 'no escape here!', '\n<\n>\n', 'tab\t<\t>', '/path/to/file?a=1&b=2', 'Redirecting to /foo/', '<', 'end<', '<start', 'a&', '&a'
  ]
  for (const str of strings) both(str)
  return count
}
