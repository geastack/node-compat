// Verifies the loop-bound in-bounds proof: typed reads where provable, and
// preserved JS `undefined` semantics where the loop shrinks the array.
const names: string[] = ['alpha', 'beta', 'gamma']
let out = ''
for (let i = 0; i < names.length; i++) {
  out += names[i] + ';'
}
console.log('joined=[' + out + ']')

const shrink: string[] = ['a', 'b', 'c', 'd']
let out2 = ''
for (let i = 0; i < shrink.length; i++) {
  if (i === 1) shrink.pop()
  out2 += shrink[i] + ';'
}
console.log('shrunk=[' + out2 + ']')
