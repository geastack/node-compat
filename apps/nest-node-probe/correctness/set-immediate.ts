import { setImmediate as setImmediateFromTimers } from 'node:timers'

const log = (line: string): void => {
  console.log(line)
}

log('start')
const a = setImmediate(() => {
  log('immediate a')
  setImmediate(() => log('immediate queued by a (next turn)'))
  process.nextTick(() => log('tick from a'))
  Promise.resolve().then(() => log('microtask from a'))
})
setImmediate(() => log('immediate b'))
const c = setImmediate(() => log('immediate c (cleared)'))
clearImmediate(c)
log(`hasRef ${a.hasRef()} ${a.unref().hasRef()} ${a.ref().hasRef()}`)
setTimeout(() => {
  log('timer 10ms')
  setImmediate(() => log('immediate from timer'))
  setTimeout(() => log('timer 0 from timer'), 0)
}, 10)
setImmediate(() => {
  const d = setImmediate(() => log('immediate d (cleared from immediate b2)'))
  clearImmediate(d)
  log('immediate b2')
})
setImmediateFromTimers(() => log('immediate from node:timers'))
setTimeout(() => {
  // Only an unreferenced immediate and the 20ms timer remain: the loop must not
  // wait for the timer before running the check phase.
  setImmediate(() => {
    setImmediate(() => log('unref immediate before timer 20ms')).unref()
  })
}, 15)
setTimeout(() => {
  setImmediate(() => log('unref immediate ran')).unref()
  log('timer 20ms, last referenced work')
}, 20)
log('end')
