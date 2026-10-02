import { MongoClient, ObjectId, type WithId } from 'mongodb'

// The CRUD surface of the real driver over TYPED documents, the way the app
// holds them: `collection<Todo>` and results read field by field, so every
// value the driver hands back reaches the program at its declared type. The
// node run is the oracle for the native one; every id and date is fixed.
// `mongodb-crud-untyped-documents.ts` covers the same surface over `Document`.

interface Todo {
  _id?: ObjectId
  title: string
  done: boolean
  createdAt: Date
  tags: string[]
  meta: { priority: number }
}

interface DoneTotal {
  _id: boolean
  priority: number
  count: number
}

function todoLine(todo: WithId<Todo>): string {
  return (
    `${todo._id.toHexString()} title=${todo.title} done=${todo.done} createdAt=${todo.createdAt.toISOString()} ` +
    `year=${todo.createdAt.getUTCFullYear()} tags=${todo.tags.join('|')} tagCount=${todo.tags.length} priority=${todo.meta.priority}`
  )
}

function printTodos(label: string, todos: WithId<Todo>[]): void {
  console.log(`${label} count=${todos.length}`)
  for (const todo of todos) console.log(`  ${todoLine(todo)}`)
}

async function run(): Promise<void> {
  const client = new MongoClient('mongodb://127.0.0.1:27017', {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 10_000
  })
  try {
    await client.connect()
    const todos = client.db('gea_crud_typed_probe').collection<Todo>('todos')
    await todos.drop().catch(() => false)

    const firstId = new ObjectId('64c000000000000000000001')
    const inserted = await todos.insertOne({
      _id: firstId,
      title: 'write probe',
      done: false,
      createdAt: new Date('2024-01-02T03:04:05.006Z'),
      tags: ['work', 'native'],
      meta: { priority: 2 }
    })
    console.log(`insertOne acknowledged=${inserted.acknowledged} insertedId=${inserted.insertedId.toHexString()}`)

    const many = await todos.insertMany([
      {
        _id: new ObjectId('64c000000000000000000002'),
        title: 'review diff',
        done: true,
        createdAt: new Date('2023-06-07T08:09:10.011Z'),
        tags: ['work'],
        meta: { priority: 1 }
      },
      {
        _id: new ObjectId('64c000000000000000000003'),
        title: 'buy milk',
        done: false,
        createdAt: new Date('2025-12-31T23:59:59.999Z'),
        tags: [],
        meta: { priority: 5 }
      },
      {
        _id: new ObjectId('64c000000000000000000004'),
        title: 'ship release',
        done: true,
        createdAt: new Date('2022-02-03T04:05:06.007Z'),
        tags: ['work', 'release', 'late'],
        meta: { priority: 3 }
      }
    ])
    console.log(`insertMany acknowledged=${many.acknowledged} insertedCount=${many.insertedCount}`)
    for (const key of Object.keys(many.insertedIds).sort()) {
      const id = many.insertedIds[Number(key)]
      console.log(`  insertedIds[${key}]=${id === undefined ? 'missing' : id.toHexString()}`)
    }

    const first = await todos.findOne({ _id: firstId })
    console.log(`findOne ${first === null ? 'null' : todoLine(first)}`)
    const missing = await todos.findOne({ title: 'no such todo' })
    console.log(`findOne missing=${missing === null}`)

    printTodos('find open by priority desc', await todos.find({ done: false }).sort({ 'meta.priority': -1 }).toArray())
    printTodos('find limit 2 by createdAt', await todos.find({}).sort({ createdAt: 1 }).limit(2).toArray())

    console.log(`countDocuments done=${await todos.countDocuments({ done: true })}`)
    console.log(`countDocuments tagged work=${await todos.countDocuments({ tags: 'work' })}`)

    const one = await todos.updateOne(
      { _id: firstId },
      {
        $set: { title: 'write typed probe', done: true, 'meta.priority': 9 },
        $push: { tags: 'typed' }
      }
    )
    console.log(
      `updateOne acknowledged=${one.acknowledged} matched=${one.matchedCount} modified=${one.modifiedCount} ` +
        `upserted=${one.upsertedCount} upsertedId=${one.upsertedId === null ? 'null' : one.upsertedId.toHexString()}`
    )
    const updated = await todos.findOne({ _id: firstId })
    console.log(`afterUpdateOne ${updated === null ? 'null' : todoLine(updated)}`)

    const bumped = await todos.updateMany({ done: true }, { $inc: { 'meta.priority': 10 } })
    console.log(`updateMany acknowledged=${bumped.acknowledged} matched=${bumped.matchedCount} modified=${bumped.modifiedCount}`)
    printTodos('afterUpdateMany', await todos.find({}).sort({ _id: 1 }).toArray())

    const totals = await todos
      .aggregate<DoneTotal>([
        {
          $group: {
            _id: '$done',
            priority: { $sum: '$meta.priority' },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ])
      .toArray()
    for (const total of totals) console.log(`aggregate done=${total._id} priority=${total.priority} count=${total.count}`)

    const deletedOne = await todos.deleteOne({ _id: firstId })
    console.log(`deleteOne acknowledged=${deletedOne.acknowledged} deleted=${deletedOne.deletedCount}`)
    const deletedMany = await todos.deleteMany({ done: true })
    console.log(`deleteMany acknowledged=${deletedMany.acknowledged} deleted=${deletedMany.deletedCount}`)
    printTodos('remaining', await todos.find({}).toArray())
  } finally {
    await client.close()
  }
  console.log('CRUD:done')
}

run().catch((error: unknown) => {
  console.log(`CRUD:failed ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
