// saslprep's code-point tables (`memory-code-points.ts`): each table is a
// sparse-bitfield over memory-pager -- both CommonJS JavaScript -- built from
// a slice of the packed code-point data with `bitfield({ buffer })`, then
// queried bit by bit.
import bitfield from 'sparse-bitfield'

const packed = Buffer.from([0b00001000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0b00000100])
const table = bitfield({ buffer: packed })
console.log(table.get(3), table.get(4), table.get(170), table.get(9000))
