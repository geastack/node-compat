import { MongoClient, ObjectId, type Document } from 'mongodb'

interface ProbeDocument {
  _id: ObjectId
  title: string
  completed: boolean
  revision: number
}

function probeDocumentFrom(document: Document): ProbeDocument {
  return {
    _id: document._id as ObjectId,
    title: document.title as string,
    completed: document.completed as boolean,
    revision: document.revision as number
  }
}

// This probe is compiled as a standalone root outside the app tsconfig, so
// declare the precise process surface used by the native failure path.
declare const process: { exitCode: number | undefined }

async function run(): Promise<void> {
  const client = new MongoClient('mongodb://127.0.0.1:27017', {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 10_000
  })
  const collection = client
    .db('gea_native_mongodb_correctness')
    .collection<ProbeDocument>('source_driver_crud')
  const id = new ObjectId('0123456789abcdef01234567')

  try {
    await client.connect()
    await collection.deleteOne({ _id: id })

    const inserted = await collection.insertOne({
      _id: id,
      title: 'created',
      completed: false,
      revision: 1
    })
    if (!inserted.acknowledged) {
      throw new Error('insert mismatch')
    }

    const createdResult = await collection.findOne({ _id: id })
    const created = createdResult === null ? null : probeDocumentFrom(createdResult)
    if (
      created === null ||
      created.title !== 'created' ||
      created.completed !== false ||
      created.revision !== 1
    ) {
      throw new Error('find after insert mismatch')
    }

    const updated = await collection.updateOne(
      { _id: id },
      { $set: { title: 'updated', completed: true, revision: 2 } }
    )
    if (!updated.acknowledged || updated.matchedCount !== 1 || updated.modifiedCount !== 1) {
      throw new Error('update mismatch')
    }

    const changedResult = await collection.findOne({ _id: id })
    const changed = changedResult === null ? null : probeDocumentFrom(changedResult)
    if (
      changed === null ||
      changed.title !== 'updated' ||
      changed.completed !== true ||
      changed.revision !== 2
    ) {
      throw new Error('find after update mismatch')
    }

    const removed = await collection.deleteOne({ _id: id })
    if (!removed.acknowledged || removed.deletedCount !== 1) {
      throw new Error('delete mismatch')
    }
    if ((await collection.findOne({ _id: id })) !== null) {
      throw new Error('find after delete mismatch')
    }

    console.log(
      [
        id.toHexString(),
        created.title,
        String(created.completed),
        changed.title,
        String(changed.completed),
        String(removed.deletedCount),
        'absent'
      ].join(':')
    )
  } finally {
    await client.close()
  }
}

await run()
