type HR = Record<string, string | string[]>
const direct: HR = { 'Content-Type': 'x' }
console.log('direct=' + Object.keys(direct).join(','))
const plain: Record<string, string> = { a: 'b' }
console.log('plain=' + Object.keys(plain).join(','))
