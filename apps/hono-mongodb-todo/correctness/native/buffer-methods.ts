import { Buffer } from 'node:buffer'

const bytes = Buffer.from('hello')
console.log(bytes.toString(), bytes['toString']('hex'))
console.log(bytes.write('ff', 'hex'), bytes.readUInt8())
const shared = bytes.slice(0, 2)
shared.writeUInt8(65)
const plain = new Uint8Array(2)
plain[0] = 7
const copied = plain.slice(0, 1)
copied[0] = 9
console.log(bytes.readUInt8(), plain[0])
const number = Buffer.alloc(4)
number.writeUInt32LE(4294967295)
console.log(number.readInt32LE(), number.readUInt32LE())

// The host owns only the ambient declaration, not every method of this name.
class Other {
  toString(): string { return 'ordinary' }
}
console.log(new Other().toString())
