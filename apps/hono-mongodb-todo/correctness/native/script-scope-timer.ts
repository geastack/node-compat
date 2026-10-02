// A plain SCRIPT -- no import, no export -- arming timers from its top level.
// `runtime/node/global-timers.ts` is a script too, and the entry reads its
// declarations, so it runs first and its `Timeout` class is initialized before
// the entry's first `setTimeout`.
console.log('start')
setTimeout(() => console.log('timer ran'), 1)
const interval = setInterval(() => {
  console.log('interval ran')
  clearInterval(interval)
}, 2)
console.log('end')
