import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function run({ shim, original, assert }) {
  let count = 0
  const both = (label, ...args) => {
    assert.equal(shim.default(...args), original(...args), label)
    count++
  }

  const strings = ['', 'a', 'hello world', 'héllo wörld', '😀 emoji', 'x'.repeat(10000), '\u0000\u0001', 'line\nbreak', JSON.stringify({ a: 1, b: [1, 2, 3] })]
  for (const str of strings) {
    both(`etag(${JSON.stringify(str.slice(0, 20))})`, str)
    both(`etag(${JSON.stringify(str.slice(0, 20))}, {weak: true})`, str, { weak: true })
    both(`etag(${JSON.stringify(str.slice(0, 20))}, {weak: false})`, str, { weak: false })
    both(`etag(Buffer ${JSON.stringify(str.slice(0, 20))})`, Buffer.from(str, 'utf8'))
    both(`etag(Buffer ${JSON.stringify(str.slice(0, 20))}, {weak: true})`, Buffer.from(str, 'utf8'), { weak: true })
  }
  both('etag(Buffer.alloc(0))', Buffer.alloc(0))
  both('etag(binary Buffer)', Buffer.from([0, 255, 128, 1, 2, 3]))
  both('etag(latin1 Buffer)', Buffer.from('héllo', 'latin1'))

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etag-parity-'))
  try {
    const files = { 'empty.txt': '', 'hello.txt': 'hello world', 'big.bin': 'z'.repeat(123456) }
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(directory, name)
      fs.writeFileSync(file, content)
      const stats = fs.statSync(file)
      both(`etag(stat ${name})`, stats)
      both(`etag(stat ${name}, {weak: false})`, stats, { weak: false })
      both(`etag(stat ${name}, {weak: true})`, stats, { weak: true })
      both(`etag(stat ${name}, {})`, stats, {})
      both(`etag(stat ${name}, {weak: undefined})`, stats, { weak: undefined })
    }
    const stats = fs.statSync(directory)
    both('etag(stat directory)', stats)
    const old = fs.statSync(path.join(directory, 'hello.txt'))
    old.mtime = new Date(-86400000)
    both('etag(stat negative mtime)', old)
    old.mtime = new Date(1234567890123)
    old.size = 0xabcdef
    both('etag(stat set mtime/size)', old)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }

  return count
}
