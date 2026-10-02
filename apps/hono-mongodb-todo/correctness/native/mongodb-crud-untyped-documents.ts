import { MongoClient, ObjectId, type Document } from 'mongodb'

// The CRUD surface of the real driver over UNTYPED `Document`s, printed
// deterministically so the node run is the oracle for the native one: keys are
// sorted, ObjectIds and Dates are spelled by value, and every id is fixed.
// `mongodb-crud.ts` is the typed twin (`collection<Todo>`); this one keeps the
// dynamic path covered -- `show(value: unknown)` walks each result through
// `instanceof`/`typeof`/`Array.isArray` guards and `Object.keys`.

// Compiled as a standalone root outside the app tsconfig.
declare const process: { exitCode: number | undefined }

function show(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof ObjectId) return `ObjectId(${value.toHexString()})`
  if (value instanceof Date) return `Date(${value.toISOString()})`
  if (Array.isArray(value)) return `[${value.map((element: unknown) => show(element)).join(',')}]`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${key}:${show(record[key])}`).join(',')}}`
  }
  return typeof value
}

function line(label: string, value: unknown): void {
  console.log(`${label} ${show(value)}`)
}

async function run(): Promise<void> {
  const client = new MongoClient('mongodb://127.0.0.1:27017', {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 10_000
  })
  try {
    await client.connect()
    const collection = client.db('gea_crud_untyped_probe').collection<Document>('items')
    await collection.drop().catch(() => false)

    const first = new ObjectId('64b000000000000000000001')
    const inserted = await collection.insertOne({
      _id: first,
      name: 'alpha',
      kind: 'tool',
      qty: 5,
      active: true,
      tags: ['red', 'small'],
      meta: { owner: 'ann', level: 1 }
    })
    line('insertOne', { acknowledged: inserted.acknowledged, insertedId: inserted.insertedId })

    const ref = new ObjectId('64b0000000000000000000aa')
    const many = await collection.insertMany([
      {
        _id: new ObjectId('64b000000000000000000002'),
        name: 'beta',
        kind: 'tool',
        qty: 12,
        active: false,
        tags: ['blue'],
        meta: { owner: 'bob', level: 2, dims: { w: 3, h: 4 } },
        created: new Date('2024-01-02T03:04:05.006Z'),
        ref
      },
      {
        _id: new ObjectId('64b000000000000000000003'),
        name: 'gamma',
        kind: 'part',
        qty: 7.5,
        active: true,
        tags: [],
        meta: { owner: 'ann', level: 3 },
        created: new Date('2023-06-07T08:09:10.011Z'),
        ref
      },
      {
        _id: new ObjectId('64b000000000000000000004'),
        name: 'delta',
        kind: 'part',
        qty: 1,
        active: true,
        tags: ['green', 'large', 'heavy'],
        meta: { owner: 'cy', level: 1, notes: [1, 2, 3] },
        created: new Date('2025-12-31T23:59:59.999Z'),
        ref
      }
    ])
    line('insertMany', { acknowledged: many.acknowledged, insertedCount: many.insertedCount, insertedIds: many.insertedIds })

    line('findOne', await collection.findOne({ _id: first }))

    const found = await collection.find({ active: true }).sort({ qty: -1 }).limit(2).toArray()
    line('find', found)

    line('countDocuments', await collection.countDocuments({ kind: 'part' }))

    const one = await collection.updateOne({ _id: first }, { $set: { name: 'alpha2', 'meta.level': 9 }, $inc: { qty: 3 } })
    line('updateOne', {
      acknowledged: one.acknowledged,
      matchedCount: one.matchedCount,
      modifiedCount: one.modifiedCount,
      upsertedCount: one.upsertedCount,
      upsertedId: one.upsertedId
    })
    const updatedMany = await collection.updateMany({ kind: 'part' }, { $set: { checked: true }, $inc: { qty: 10 } })
    line('updateMany', {
      acknowledged: updatedMany.acknowledged,
      matchedCount: updatedMany.matchedCount,
      modifiedCount: updatedMany.modifiedCount
    })
    line('afterUpdate', await collection.find({}).sort({ _id: 1 }).toArray())

    const aggregated = await collection
      .aggregate([{ $match: { qty: { $gt: 2 } } }, { $group: { _id: '$kind', total: { $sum: '$qty' }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
      .toArray()
    line('aggregate', aggregated)

    const indexName = await collection.createIndex({ name: 1, qty: -1 }, { name: 'name_qty' })
    line('createIndex', indexName)
    const indexes = await collection.listIndexes().toArray()
    line(
      'listIndexes',
      indexes.map((index) => ({ name: index.name, key: index.key })).sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1))
    )

    const deletedOne = await collection.deleteOne({ _id: first })
    line('deleteOne', { acknowledged: deletedOne.acknowledged, deletedCount: deletedOne.deletedCount })
    const deletedMany = await collection.deleteMany({ kind: 'part' })
    line('deleteMany', { acknowledged: deletedMany.acknowledged, deletedCount: deletedMany.deletedCount })
    line('remaining', await collection.countDocuments({}))
  } finally {
    await client.close()
  }
  console.log('CRUD:done')
}

await run()
