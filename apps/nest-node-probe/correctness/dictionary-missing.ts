interface StringMap {
  [name: string]: string
}
interface OptionalStringMap {
  [name: string]: string | undefined
}
const plain: StringMap = { a: 'x' }
const optional: OptionalStringMap = { a: 'x' }
const missing = plain['b']
console.log('plain present', plain['a'] === 'x')
console.log('plain missing === undefined', missing === undefined)
console.log('plain missing typeof', typeof missing)
console.log('plain missing !== undefined', plain['b'] !== undefined)
console.log('plain in', 'b' in plain)
console.log('optional missing === undefined', optional['b'] === undefined)
console.log('optional present', optional['a'] === 'x')
console.log('keys', Object.keys(plain).join(','))
console.log('nullish', plain['b'] ?? 'fallback')
console.log('falsy', plain['b'] ? 'truthy' : 'falsy')
const absent = optional['b']
console.log('optional missing typeof', typeof absent)
console.log('optional missing !== undefined', optional['b'] !== undefined)
console.log('optional nullish', optional['b'] ?? 'fallback')
console.log('optional falsy', optional['b'] ? 'truthy' : 'falsy')
console.log('optional or', optional['b'] || 'or-fallback')
console.log('optional not', !optional['b'])
console.log('optional present nullish', optional['a'] ?? 'fallback')
console.log('optional present or', optional['a'] || 'or-fallback')
const guarded = optional['a']
console.log('optional guarded length', guarded !== undefined ? guarded.length : -1)
function describe(value: string | undefined): string {
  return value === undefined ? 'none' : `some(${value})`
}
console.log('optional passed', describe(optional['a']), describe(optional['b']))
console.log('optional keys', Object.keys(optional).join(','))
optional['c'] = undefined
console.log('optional set undefined in', 'c' in optional, Object.keys(optional).join(','))
