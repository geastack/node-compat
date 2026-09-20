import { MongoClient } from 'mongodb'

// This probe is compiled as a standalone root outside the app tsconfig, so
// declare the precise process surface used by the native failure path.
declare const process: { exitCode: number | undefined }

async function run(): Promise<void> {
  const client = new MongoClient('mongodb://127.0.0.1:27017', { socketTimeoutMS: 10_000 })
  try {
    await client.connect()
    const result = await client.db('admin').command({ ping: 1 })
    if (result.ok !== 1) {
      throw new Error(`ping mismatch: ${String(result.ok)}`)
    }
    console.log(`PING:${String(result.ok)}`)
  } finally {
    await client.close()
  }
}

await run()
