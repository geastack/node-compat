import { Buffer as ModuleBuffer } from 'buffer'

const globalBuffer: Buffer = Buffer.from('global')
const moduleBuffer: Buffer = ModuleBuffer.from(new Uint8Array([1, 2, 3]))
const arrayBuffer = new ArrayBuffer(4)
const aliased: Uint8Array = ModuleBuffer.from(arrayBuffer, 1, 2)
const copied = ModuleBuffer.from([4, 5, 6] as const)

void [globalBuffer, moduleBuffer, aliased, copied]

const arrayLike = { 0: 1, length: 1 }
// @ts-expect-error Arbitrary ArrayLike records have no native Buffer boundary.
ModuleBuffer.from(arrayLike)
// @ts-expect-error SharedArrayBuffer is not carried by the ArrayBuffer overload.
ModuleBuffer.from(new SharedArrayBuffer(4))
// @ts-expect-error The deprecated callable Buffer constructor is not implemented.
ModuleBuffer('x')
