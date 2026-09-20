import { Buffer } from 'buffer'

function expect(condition: boolean, label: string): void {
  if (!condition) throw new Error('Buffer runtime probe failed: ' + label)
}

expect(typeof Buffer === 'function', 'Buffer is a constructor')
expect(Buffer.prototype?._isBuffer !== true, 'BSON prototype reflection')

const packet = Buffer.alloc(12, 0)
expect(packet.writeInt32LE(-1234567, 0) === 4, 'writeInt32LE offset')
expect(packet.readInt32LE(0) === -1234567, 'readInt32LE round trip')

// Mongo's command builder keeps a concrete Buffer in a class field but uses a
// defensive optional chain when it patches the message length. The native
// member-call plugin must still own this call; a raw `.writeInt32LE` is not a
// method on the C++ Buffer carrier.
class MessageHeader {
  private header: Buffer

  constructor() {
    this.header = Buffer.alloc(8, 0)
  }

  writeLength(value: number): number {
    this.header?.writeInt32LE(value, 1)
    return this.header.readInt32LE(1)
  }
}

expect(new MessageHeader().writeLength(-7654321) === -7654321, 'optional class-field writeInt32LE')

const source = Buffer.from('hello', 'utf8')
// This is deliberately the ambient Node `Buffer` name as well as the imported
// value above: its declared interface is host-owned and must retain the
// Uint8Array carrier, rather than becoming a structural record or dynamic
// value at the global alias boundary.
const ambientBuffer: Buffer = Buffer.from('ambient', 'utf8')
const ambientBytes: Uint8Array = ambientBuffer
expect(ambientBytes.length === 7 && Buffer.isBuffer(ambientBuffer), 'ambient Buffer Uint8Array provenance')
expect(source.copy(packet, 4) === 5, 'copy count')
expect(packet.toString('utf8', 4, 9) === 'hello', 'copy contents')

const view = packet.subarray(4, 9)
expect(view.buffer === packet.buffer && view.byteOffset === 4, 'subarray backing')
expect(view.write('Hello', 0, 'utf8') === 5, 'write count')
expect(packet.toString('utf8', 4, 9) === 'Hello', 'shared backing')
expect(Buffer.isBuffer(packet) && Buffer.isBuffer(view), 'Buffer identity')
expect(!Buffer.isBuffer(new Uint8Array(1)), 'Uint8Array is not Buffer')

// Buffer views alias their bytes, while Buffer.from(Uint8Array) deliberately
// snapshots them. Both sides keep the same native Uint8Array carrier.
const slice = source.slice(1, 4)
slice.writeUInt8(65, 0)
expect(source.toString('utf8') === 'hAllo', 'Buffer.slice aliases')
const plain = new Uint8Array([1, 2, 3])
const copied = Buffer.from(plain)
plain[0] = 9
expect(copied[0] === 1 && !Buffer.isBuffer(plain), 'Buffer.from(Uint8Array) copies without branding input')

const backing = new ArrayBuffer(4)
const aliased = Buffer.from(backing, 1, 2)
aliased.writeUInt8(0x7f, 0)
expect(new Uint8Array(backing)[1] === 0x7f && Buffer.isBuffer(aliased), 'Buffer.from(ArrayBuffer) aliases and brands')

expect(Buffer.from('ff80', 'hex').toString('hex') === 'ff80', 'hex round trip')
expect(Buffer.from('Zm9v', 'base64').toString('utf8') === 'foo', 'base64 decode')
expect(Buffer.from('é', 'latin1').toString('latin1') === 'é', 'latin1 round trip')
expect(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString() === 'ab', 'concat')
expect(Buffer.from('a').equals(Buffer.from('a')) && Buffer.from('a').compare(Buffer.from('b')) < 0, 'comparison')

function expectThrow(callback: () => void, label: string): void {
  try {
    callback()
  } catch {
    return
  }
  throw new Error('Buffer runtime probe failed: expected error for ' + label)
}

expectThrow(() => Buffer.alloc(-1), 'negative allocation')
expectThrow(() => Buffer.alloc(NaN), 'NaN allocation')
expectThrow(() => Buffer.alloc(Infinity), 'infinite allocation')
expectThrow(() => Buffer.from(backing, 5), 'out-of-range ArrayBuffer offset')
expect(Buffer.from(backing, -0.5).length === 4, 'fractional negative ArrayBuffer offset truncates to zero')
expect(Buffer.from(backing, 1.5).length === 3, 'fractional ArrayBuffer offset truncates')
expect(Buffer.from(backing, 0, NaN).length === 0, 'NaN ArrayBuffer length becomes zero')
expect(Buffer.from(backing, 0, -0.5).length === 0, 'negative fractional ArrayBuffer length becomes zero')
expectThrow(() => Buffer.from(backing, 0, -1), 'negative integer ArrayBuffer length')
expectThrow(() => Buffer.from(backing, -1), 'negative integer ArrayBuffer offset')
expectThrow(() => Buffer.from(backing, Infinity), 'infinite ArrayBuffer offset')
expectThrow(() => Buffer.from(backing, 0, Infinity), 'infinite ArrayBuffer length')
expectThrow(() => Buffer.from(backing, 2 ** 53), '2^53 ArrayBuffer offset exceeds ToIndex')
expectThrow(() => Buffer.from(backing, 0, 2 ** 64), '2^64 ArrayBuffer length exceeds ToIndex')
expectThrow(() => source.readUInt8(source.length), 'out-of-range byte read')
expectThrow(() => source.readUInt8(0.5), 'fractional byte read offset')
expectThrow(() => source.write('x', NaN), 'NaN write offset')
expectThrow(() => source.write('x', 0, 6), 'write length larger than buffer')
expect(source.toString('utf8', -2) === source.toString(), 'negative toString start clamps to zero')
expect(source.toString('utf8', Infinity) === '', 'infinite toString start clamps to length')
expect(source.copy(packet, Infinity) === source.length, 'infinite copy target start coerces to zero')
expectThrow(() => source.copy(packet, -0.5), 'negative fractional copy target start')
expectThrow(() => Buffer.from('x', 'not-an-encoding' as BufferEncoding), 'unknown encoding')

console.log('buffer-runtime-probe=ok')
