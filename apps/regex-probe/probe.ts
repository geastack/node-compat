// Differential regex probe: run under node (`node probe.ts`, type-free TS) and
// compiled by geatsc; outputs must be byte-identical. Guards the literal
// fast path in the runtime's Pattern (router-style `^/json/?$` patterns) —
// every line prints exec/test results including index/input/lastIndex state.
const show = (label: string, m: any) => {
  if (m === null) return console.log(label + ' null')
  console.log(label + ' [0]=' + JSON.stringify(m[0]) + ' index=' + m.index + ' input=' + JSON.stringify(m.input) + ' len=' + m.length)
}

// hono PatternRouter shapes: literal + optional trailing slash + anchors
const root = /^\/?$/
show('root ""', root.exec(''))
show('root "/"', root.exec('/'))
show('root "//"', root.exec('//'))
show('root "x"', root.exec('x'))
const json = /^\/json\/?$/
show('json "/json"', json.exec('/json'))
show('json "/json/"', json.exec('/json/'))
show('json "/json//"', json.exec('/json//'))
show('json "/jsonx"', json.exec('/jsonx'))
show('json "a/json"', json.exec('a/json'))
console.log('json test', json.test('/json'), json.test('/nope'))

// anchors / empty
const empty = /^$/
show('empty ""', empty.exec(''))
show('empty "x"', empty.exec('x'))
const bare = new RegExp('')
show('bare "ab"', bare.exec('ab'))

// optional char inside anchored literal
const opt = /^ab?$/
show('opt "a"', opt.exec('a'))
show('opt "ab"', opt.exec('ab'))
show('opt "abb"', opt.exec('abb'))

// unanchored literal: leftmost + index
const found = /json/
show('find "/a/json/x"', found.exec('/a/json/x'))
show('find "nope"', found.exec('nope'))

// end-anchored only
const end = /json$/
show('end "ajson"', end.exec('ajson'))
show('end "json/"', end.exec('json/'))
const endOpt = /jso?n?$/
show('endOpt "ajson"', endOpt.exec('ajson'))

// start-anchored only
const start = /^ab/
show('start "abc"', start.exec('abc'))
show('start "zab"', start.exec('zab'))

// global: lastIndex progression + reset
const g = /o/g
show('g#1 "foo"', g.exec('foo'))
console.log('g.lastIndex', g.lastIndex)
show('g#2 "foo"', g.exec('foo'))
console.log('g.lastIndex', g.lastIndex)
show('g#3 "foo"', g.exec('foo'))
console.log('g.lastIndex', g.lastIndex)

// sticky
const y = /o/y
y.lastIndex = 1
show('y@1 "foo"', y.exec('foo'))
console.log('y.lastIndex', y.lastIndex)
const y0 = /o/y
show('y@0 "foo"', y0.exec('foo'))
console.log('y0.lastIndex', y0.lastIndex)
const yA = /^f/y
show('yA@0 "foo"', yA.exec('foo'))

// escapes: literal-fast-path escapes vs regex metachars
const esc1 = /a\?b/
show('esc? "a?b"', esc1.exec('a?b'))
show('esc? "ab"', esc1.exec('ab'))
const esc2 = /a\.b/
show('esc. "a.b"', esc2.exec('a.b'))
show('esc. "axb"', esc2.exec('axb'))
const esc3 = /^\/x\-y$/
show('esc/- "/x-y"', esc3.exec('/x-y'))

// non-literal shapes must still route through the real engine
const dot = /a.b/
show('dot "axb"', dot.exec('axb'))
const cls = /[0-9]+/
show('cls "a42"', cls.exec('a42'))
const ic = /ABC/i
show('ic "xabc"', ic.exec('xabc'))
const two = /ab?c?/
show('two "ac"', two.exec('ac'))
const midopt = /a?b/
show('midopt "b"', midopt.exec('b'))

// String.prototype call sites over literal patterns
console.log('split', JSON.stringify('a-b-c'.split(/-/)))
console.log('replace', 'aaa'.replace(/a/g, 'b'))
console.log('match', JSON.stringify('xay'.match(/a/)))
console.log('search', 'xay'.search(/a/))
