import { Binary, BSON, MongoClient, ObjectId } from 'mongodb'
import type { Document } from 'bson'

// The serializer's per-call cost on the documents the driver sends in an
// OP_MSG (`operations/{insert,find,update,delete}.ts`, `cmap/connection.ts`
// `prepareCommand`, `cmap/commands.ts` `OpMsgRequest`): each command with the
// session's `lsid` and `$db`, and the user document that rides in a document
// sequence and is serialized on its own. Constants rather than environment
// reads for the reason `native-driver.ts` gives. Node counterpart:
// `bson-opmsg.mjs`; keep the two in lockstep.
const iterations = 300000
// An optional first argument names the one case to run.
const only = process.argv.length > 2 ? (process.argv[2] as string) : ''
const options = { checkKeys: false, serializeFunctions: false, ignoreUndefined: false }

function hex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef'
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number
    out += digits.charAt(byte >> 4) + digits.charAt(byte & 15)
  }
  return out
}

function time(label: string, document: Document): void {
  if (only !== '' && only !== label) return
  let checksum = 0
  const startedAt = Date.now()
  for (let index = 0; index < iterations; index += 1) checksum += BSON.serialize(document, options).length
  const ms = Date.now() - startedAt
  console.log(`BSON_RESULT:${label},${ms},${checksum},${Math.round((ms * 1e6) / iterations)}`)
  console.log(`BSON_HEX:${label},${hex(BSON.serialize(document, options))}`)
}

function run(): void {
  // Constructing the client pulls the whole driver (and with it `cmap/commands.ts`'s own BSON.Long) in, as in the driver build.
  if (new MongoClient('mongodb://127.0.0.1:27017/') === null) throw new Error('client')
  const id = new ObjectId('0123456789abcdef01234567')
  const createdAt = new Date(1700000000123)
  const lsid = { id: new Binary(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 4) }
  const todo: Document = { _id: id, title: 'x', done: false, createdAt }
  time('empty', {})
  time('str4', { a: 'x', b: 'y', c: 'z', d: 'w' })
  time('num4', { a: 1, b: 2, c: 3, d: 4 })
  time('bool4', { a: true, b: false, c: true, d: false })
  time('date4', { a: createdAt, b: createdAt, c: createdAt, d: createdAt })
  time('oid4', { a: id, b: id, c: id, d: id })
  time('bin1', lsid)
  time('nest3', { a: { b: { c: 1 } } })
  time('arr4', { a: [1, 2, 3, 4] })
  time('insert-doc', todo)
  time('insert-cmd', { insert: 'todos', ordered: true, lsid, $db: 'gea_driver_benchmark' })
  time('insert-cmd-inline', { insert: 'todos', documents: [todo], ordered: true, lsid, $db: 'gea_driver_benchmark' })
  time('find-cmd', { find: 'todos', filter: { _id: id }, limit: 1, singleBatch: true, batchSize: 1, lsid, $db: 'gea_driver_benchmark' })
  time('update-cmd', {
    update: 'todos',
    updates: [{ q: { _id: id }, u: { $set: { done: true, revision: 2 } } }],
    ordered: true,
    lsid,
    $db: 'gea_driver_benchmark'
  })
  time('delete-cmd', { delete: 'todos', deletes: [{ q: { _id: id }, limit: 1 }], ordered: true, lsid, $db: 'gea_driver_benchmark' })
}

run()
