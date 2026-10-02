import { BSON, Long, ObjectId, type Document } from 'mongodb'
import { BSONType } from '../node_modules/mongodb/src/bson'
import { OnDemandDocument } from '../node_modules/mongodb/src/cmap/wire_protocol/on_demand/document'

// The per-reply and per-id work of one driver command, one mode per argv.
// `parse`/`format` are ObjectId hex round trips (`new ObjectId(hex)`,
// `toHexString`). The rest is the response path: a find reply deserialized
// through bson (`bson`), the same reply read through the driver's
// `OnDemandDocument` the way `CursorResponse` reads it (`ondemand`), and an
// insert/update/delete reply read whole with the validation option the driver
// builds for write results (`write`). Mode and iteration count come from
// argv; run it with 0 iterations to measure the fixed cost, then with N, and
// divide the difference (`perf stat -e instructions:u`).
const mode = process.argv.length > 2 ? (process.argv[2] as string) : 'all'
const iterations = process.argv.length > 3 ? Number(process.argv[3] as string) : 0
const payload = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function findReply(): Uint8Array {
  const todo: Document = {
    _id: new ObjectId('0123456789abcdef01234567'),
    title: 'todo-1',
    completed: false,
    revision: 1,
    payload
  }
  const cursor: Document = {
    firstBatch: [todo],
    id: Long.fromNumber(0),
    ns: 'gea_driver_benchmark.driver_gea'
  }
  return BSON.serialize({ cursor, ok: 1 })
}

function writeReply(): Uint8Array {
  return BSON.serialize({ n: 1, ok: 1 })
}

function viaBson(bytes: Uint8Array): number {
  const document = BSON.deserialize(bytes)
  const ok = document['ok'] as number
  const batch = (document['cursor'] as Document)['firstBatch'] as Document[]
  return ok + batch.length
}

function viaOnDemand(bytes: Uint8Array): number {
  const response = new OnDemandDocument(bytes)
  const ok = response.getNumber('ok') as number
  const cursor = response.get('cursor', BSONType.object, true)
  const ns = cursor.get('ns', BSONType.string) as string
  const batch = cursor.has('firstBatch') ? cursor.get('firstBatch', BSONType.array, true) : cursor.get('nextBatch', BSONType.array, true)
  const first = batch.get(0, BSONType.object, true)
  const object = first.toObject({
    promoteValues: true,
    validation: { utf8: true }
  })
  return ok + ns.length + (object['revision'] as number)
}

function viaWrite(bytes: Uint8Array): number {
  const response = new OnDemandDocument(bytes)
  const object = response.toObject({
    promoteValues: true,
    validation: { utf8: { writeErrors: false } }
  })
  const n = object['n'] as number
  const ok = object['ok'] as number
  return n + ok
}

const samples = ['0123456789abcdef01234567', 'ffffffffffffffffffffffff', 'AABBCCDDEEFF001122334455', '507f1f77bcf86cd799439011']

function run(): void {
  const found = findReply()
  const written = writeReply()
  const reference = new ObjectId(samples[0] as string)
  const ids = samples.map((hex) => new ObjectId(hex))
  let checksum = 0
  if (mode === 'parse') {
    for (let index = 0; index < iterations; index += 1) {
      const id = new ObjectId(samples[index & 3] as string)
      if (id.equals(reference)) checksum += 1
    }
  }
  if (mode === 'format') {
    for (let index = 0; index < iterations; index += 1) checksum += (ids[index & 3] as ObjectId).toHexString().charCodeAt(index % 24)
  }
  if (mode === 'bson' || mode === 'all') for (let index = 0; index < iterations; index += 1) checksum += viaBson(found)
  if (mode === 'ondemand' || mode === 'all') for (let index = 0; index < iterations; index += 1) checksum += viaOnDemand(found)
  if (mode === 'write' || mode === 'all') for (let index = 0; index < iterations; index += 1) checksum += viaWrite(written)
  console.log(
    `BSON_REPLY:${mode},${iterations},${checksum},${viaBson(found)},${viaOnDemand(found)},${viaWrite(written)},${ids.map((id) => id.toHexString()).join(',')}`
  )
}

run()
