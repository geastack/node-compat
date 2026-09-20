import { clearInterval, clearTimeout, setInterval, setTimeout } from 'timers'

const order: string[] = []

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const cancelled = setTimeout(() => order.push('cancelled'), 1)
clearTimeout(cancelled)

const unreferenced = setTimeout(() => order.push('unref'), 1)
expect(unreferenced.hasRef(), 'timeout starts referenced')
unreferenced.unref()
expect(!unreferenced.hasRef(), 'unref updates the typed handle')

let intervalTicks = 0
const interval = setInterval(() => {
  intervalTicks++
  order.push('interval')
  clearInterval(interval)
}, 3)

setTimeout(() => {
  order.push('ref')
  expect(intervalTicks === 1, 'clearInterval stops the repeating timer')
  expect(order.join(',') === 'unref,interval,ref', 'timer order and cancellation')
  console.log('timers-runtime-probe=' + order.join(','))
}, 10)
