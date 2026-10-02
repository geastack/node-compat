import { MongoClient, ObjectId } from 'mongodb'

// 3000 sequential insertOne + findOne round trips over a client with DEFAULT
// monitoring: no `serverMonitoringMode`, no `heartbeatFrequencyMS`, so the
// server monitor is the streaming one -- an awaitable `hello` held open by
// mongod for the whole heartbeat interval while the operations run.
//
// Under the blocking await model every `await` was a nested reactor pump on
// the C++ stack. The monitor's streaming check is an async loop started from a
// timer; once it began inside an operation's pump, its own await on the held
// `hello` pumped ABOVE the operation's frame, and the operation could not
// resume until that reply came back. The native build hung after ~800 round
// trips. `benchmarks/native-driver.ts` sidestepped it with a polling monitor
// and an hour-long heartbeat; this probe keeps the defaults on purpose.
//
// Output is counts only -- no timings -- so node is the oracle line for line.
// Constants are hard-coded: reading `process.env` pulls a shape the native
// build cannot certify.

interface Todo {
  _id: ObjectId
  index: number
  title: string
  revision: number
}

const roundTrips = 3000
const reportEvery = 500

const idFor = (index: number): ObjectId => new ObjectId(`64d0000000000000${String(index).padStart(8, '0')}`)

async function run(): Promise<void> {
  const client = new MongoClient('mongodb://127.0.0.1:27017', {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 30_000
  })
  try {
    await client.connect()
    const todos = client.db('gea_default_monitoring_probe').collection<Todo>('round_trips')
    await todos.drop().catch(() => false)

    let inserted = 0
    let found = 0
    let mismatched = 0
    let indexSum = 0
    for (let index = 0; index < roundTrips; index += 1) {
      const id = idFor(index)
      const result = await todos.insertOne({ _id: id, index, title: `todo-${index}`, revision: index % 3 })
      if (result.acknowledged && result.insertedId.equals(id)) inserted += 1
      const document = await todos.findOne({ _id: id })
      if (document === null) {
        mismatched += 1
      } else {
        found += 1
        indexSum += document.index
        if (document.title !== `todo-${index}` || document.revision !== index % 3) mismatched += 1
      }
      if ((index + 1) % reportEvery === 0) console.log(`progress ${index + 1} inserted=${inserted} found=${found}`)
    }
    console.log(`roundTrips=${roundTrips} inserted=${inserted} found=${found} mismatched=${mismatched} indexSum=${indexSum}`)
    console.log(`countDocuments=${await todos.countDocuments({})} revisionTwo=${await todos.countDocuments({ revision: 2 })}`)
    await todos.drop()
  } finally {
    await client.close()
  }
  console.log('DEFAULT_MONITORING:done')
}

run().catch((error: unknown) => {
  console.log(`DEFAULT_MONITORING:failed ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
