import { Buffer } from 'buffer'

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// OP_MSG response layout starts with flags, followed by a one-byte payload
// type and the first BSON document's unsigned little-endian length.
const responseBody = Buffer.alloc(13, 0)
expect(responseBody.writeUInt32LE(0, 0) === 4, 'flags next offset')
expect(responseBody.writeUInt8(0, 4) === 5, 'payload type next offset')
expect(responseBody.writeUInt32LE(0xfedcba98, 5) === 9, 'BSON length next offset')
expect(responseBody.writeUInt8(0xff, 12) === 13, 'last-byte write boundary')

expect(responseBody.readUInt8(4) === 0, 'payload type read')
expect(responseBody.readUInt32LE(5) === 0xfedcba98, 'unsigned BSON length read')
expect(responseBody.readUInt8(12) === 0xff, 'last-byte read boundary')
expect(responseBody[5] === 0x98, 'little-endian byte 0')
expect(responseBody[6] === 0xba, 'little-endian byte 1')
expect(responseBody[7] === 0xdc, 'little-endian byte 2')
expect(responseBody[8] === 0xfe, 'little-endian byte 3')

// Views must retain their native owner and offset rather than copying or
// routing a byte through gea_cpp_value.
const payloadView = responseBody.subarray(4, 9)
expect(payloadView.readUInt32LE(1) === 0xfedcba98, 'view offset read')
expect(payloadView.writeUInt8(7, 0) === 1, 'view write next offset')
expect(responseBody.readUInt8(4) === 7, 'view aliases packet owner')

console.log('buffer-op-msg-runtime-probe=ok')
