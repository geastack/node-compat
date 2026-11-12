export async function run({ shim, original, assert }) {
  let count = 0
  const normalize = (result) => (typeof result === 'number' ? result : { type: result.type, ranges: result.ranges ?? [...result] })
  const normalizeOriginal = (result) => (typeof result === 'number' ? result : { type: result.type, ranges: result.map((r) => ({ start: r.start, end: r.end })) })
  const both = (size, str, options) => {
    const label = `parseRange(${size}, ${JSON.stringify(str)}${options ? ', ' + JSON.stringify(options) : ''})`
    assert.deepEqual(normalize(shim.default(size, str, options)), normalizeOriginal(original(size, str, options)), label)
    count++
  }

  const headers = [
    'bytes=0-499', 'bytes=0-', 'bytes=-500', 'bytes=500-', 'bytes=0-0', 'bytes=999-', 'bytes=1000-', 'bytes=-0', 'bytes=-1', 'bytes=-1000', 'bytes=-1001', 'bytes=0-1000', 'bytes=0-999',
    'bytes=500-499', 'bytes=0-499,500-999', 'bytes=0-499, 500-999', 'bytes=0-499,1000-1999', 'bytes=0-4,6-9', 'bytes=0-4,3-9', 'bytes=0-4,5-9', 'bytes=5-9,0-4', 'bytes=0-9,2-3',
    'bytes=2-3,0-9', 'bytes=0-1,3-4,6-7,2-2,5-5', 'bytes=-5,0-4', 'bytes=0-4,-5', 'bytes=1-2,1-2', 'bytes=0-4,abc', 'bytes=abc', 'bytes=0', 'bytes=', 'bytes', '', 'bytes=-',
    'bytes=1-2-3', 'bytes= 0-4', 'bytes=0 - 4', 'bytes=0-4 ', 'bytes=0.5-4', 'bytes=0-4.5', 'bytes=-0-4', 'bytes=+1-4', 'bytes=1e1-20', 'items=0-4', 'x=0-4,6-9', 'bytes=0-4,,6-9',
    'bytes=1-', 'bytes=1-0', 'bytes=0-0,0-0', 'bytes=0-4,2-6,8-9', 'bytes=8-9,0-4,2-6', 'bytes=0-1,2-3,5-6', 'bytes=0-1,3-4,2-2', 'bytes=0-9999999999999', 'bytes=9999999999999-',
    'bytes=-9999999999999', 'BYTES=0-4', 'bytes=0-4;foo', 'bytes=0x0-4'
  ]
  const sizes = [0, 1, 10, 1000, 1001]
  for (const size of sizes) {
    for (const str of headers) {
      both(size, str)
      both(size, str, { combine: true })
      both(size, str, { combine: false })
      both(size, str, {})
    }
  }
  both(1000, 'bytes=0-4', undefined)

  return count
}
