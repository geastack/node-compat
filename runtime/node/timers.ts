// `node:timers` -- the module surface over the timer globals.
//
// The implementations are in `runtime/node/global-timers.ts`, which is a
// SCRIPT: its declarations land in the real global scope, because that is
// where library code reads them from (`setTimeout(forceClose, ms)` with no
// import in sight). See that file's header for why a script, and for the
// ambient declaration this replaced.
//
// Node exposes the same functions twice -- as globals AND as `node:timers`
// exports -- so this file is the second half of that, not a second
// implementation. Each name below is a local ALIAS of the one global:
// `const x = globalX` keeps the value identity and `type X = GlobalX` keeps
// the type identity, and a single `export { x as name }` specifier carries
// both meanings. The alias is what a module can do at all: `export
// { setTimeout }` on a name this file does not declare is "Cannot export
// 'setTimeout'. Only local declarations can be exported from a module."

const TimeoutAlias = Timeout
type TimeoutAlias = Timeout

const setTimeoutAlias = setTimeout
const setIntervalAlias = setInterval
const clearTimeoutAlias = clearTimeout
const clearIntervalAlias = clearInterval

export {
  TimeoutAlias as Timeout,
  setTimeoutAlias as setTimeout,
  setIntervalAlias as setInterval,
  clearTimeoutAlias as clearTimeout,
  clearIntervalAlias as clearInterval
}
