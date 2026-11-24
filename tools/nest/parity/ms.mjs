export async function run({ shim, original, assert }) {
  let count = 0
  const outcome = (call) => {
    try {
      return { value: call() }
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` }
    }
  }
  const both = (label, ...args) => {
    assert.deepEqual(outcome(() => shim.default(...args)), outcome(() => original(...args)), label)
    count++
  }

  const strings = [
    '100', '1ms', '1 ms', '2ms', '1s', '1 s', '1sec', '1 secs', '1second', '2 seconds', '1m', '1 min', '1mins', '1 minute', '2 minutes', '1h', '1 hr', '1hrs', '1 hour', '2 hours',
    '1d', '1 day', '2 days', '1w', '1 week', '2 weeks', '1y', '1 yr', '1yrs', '1 year', '2 years', '1.5h', '.5h', '-1h', '-.5d', '-100', '1.5 days', '1 DAY', '1D', '10H', '1 Weeks',
    '0', '0ms', '1x', 'one hour', '1 hours ago', ' 1h', '1h ', '1h30m', 'ms', 's', 'h', '1e3', '1,000', '', 'a'.repeat(101), '1' + 'h'.repeat(100), '1'.repeat(101),
    '5 milliseconds', '5 msecs', '5msec', '5 millisecond'
  ]
  for (const str of strings) both(`ms(${JSON.stringify(str)})`, str)

  const numbers = [
    0, 1, 999, 1000, 1001, 1500, 59999, 60000, 90000, 3599999, 3600000, 5400000, 86399999, 86400000, 129600000, 172800000, 604800000, 31557600000,
    -1, -1000, -90000, -3600000, -86400000, 0.5, 1234.5678, 1e12, Infinity, -Infinity, NaN
  ]
  for (const n of numbers) {
    both(`ms(${n})`, n)
    both(`ms(${n}, {long: true})`, n, { long: true })
    both(`ms(${n}, {long: false})`, n, { long: false })
  }

  return count
}
