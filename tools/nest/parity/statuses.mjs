export async function run({ shim, original, assert }) {
  let count = 0
  const outcome = (call) => {
    try {
      return { value: call() }
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` }
    }
  }
  const both = (label, call) => {
    assert.deepEqual(outcome(() => call(shim.default)), outcome(() => call(original)), label)
    count++
  }

  const stringKeys = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [String(key), value]))
  assert.deepEqual(stringKeys(shim.message), stringKeys(original.message), 'message')
  assert.deepEqual(shim.code, original.code, 'code')
  assert.deepEqual(shim.codes, original.codes, 'codes')
  assert.deepEqual(stringKeys(shim.redirect), stringKeys(original.redirect), 'redirect')
  assert.deepEqual(stringKeys(shim.empty), stringKeys(original.empty), 'empty')
  assert.deepEqual(stringKeys(shim.retry), stringKeys(original.retry), 'retry')
  count += 6
  for (const code of original.codes) {
    assert.equal(shim.statusMessage(code), original.message[code], `statusMessage(${code})`)
    count++
  }
  for (const code of [0, 99, 100, 199, 299, 399, 499, 599, 600, 1000, -1, NaN, 404.5]) {
    assert.equal(shim.statusMessage(code), original.message[code], `statusMessage(${code})`)
    count++
  }

  const values = [
    ...original.codes, 0, 99, 600, 1000, -404, 404.5, NaN, '404', '200', '0', '999', ' 404', '404abc', '4.04', 'Not Found', 'not found', 'NOT FOUND', 'Not  Found', 'OK', 'ok',
    "I'm a Teapot", "i'm a teapot", 'Internal Server Error', 'Teapot', '', 'abc', 'Found', 'Moved Permanently', 'Unknown'
  ]
  for (const value of values) both(`status(${JSON.stringify(value)})`, (status) => status(value))

  return count
}
