import { Binary, Long, ObjectId, deserialize, serialize, type Document } from 'bson'
import { Buffer } from 'node:buffer'

const input: Document = {
  _id: new ObjectId('0123456789abcdef01234567'),
  title: 'Native MongoDB',
  completed: false,
  count: Long.fromString('9007199254740993'),
  payload: new Binary(Buffer.from('00ff7f', 'hex')),
  tags: ['gea', 'mongodb'],
  nested: { value: 17 },
}
const encoded = serialize(input)
console.log(Buffer.from(encoded).toString('hex'))
const decoded = deserialize(encoded, { promoteLongs: false })
const id = decoded._id as ObjectId
const count = decoded.count as Long
const payload = decoded.payload as Binary
const tags = decoded.tags as string[]
const nested = decoded.nested as { value: number }
console.log(id.toHexString(), decoded.title, decoded.completed, count.toString())
console.log(payload.toString('hex'), tags.join(','), nested.value)
