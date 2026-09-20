// Isolation test for the `new Function` AOT evaluator — now covering the
// expression forms fastify's find-my-way codegen uses.
const add = new Function('a', 'b', 'return a + b') as any
const cmp = new Function('x', 'return x === 47') as any
const seg = new Function('s', 'return s.charCodeAt(0) === 104') as any            // 'h' === 104
const clz = new Function('c', 'return 31 - Math.clz32(c)') as any                 // find-my-way handler math
const guard = new Function('d', 'if (d === 9) return 100; return 200') as any     // if-return guard
const mk = new Function('NullObject', 'const params = new NullObject(); return params') as any
console.log(
  'add=[' + add(2, 3) + '] cmp=[' + cmp(47) + '] seg=[' + seg('hi') +
  '] clz1=[' + clz(1) + '] clz4=[' + clz(4) + '] g9=[' + guard(9) + '] g1=[' + guard(1) +
  '] mk=[' + (typeof mk(0)) + ']'
)
