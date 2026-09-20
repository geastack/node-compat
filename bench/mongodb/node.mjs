#!/usr/bin/env node

import { Int32, Long, MongoClient } from 'mongodb'

const [baseUri, workload, journalText, documentsText, batchSizeText, collectionName] = process.argv.slice(2)

if (
  !baseUri ||
  !['insert-one', 'insert-many'].includes(workload) ||
  !['false', 'true'].includes(journalText) ||
  !collectionName
) {
  console.error(
    'usage: node node.mjs <base-uri> <insert-one|insert-many> <false|true> <documents> <batch-size> <collection>',
  )
  process.exit(2)
}

const documents = Number(documentsText)
const batchSize = Number(batchSizeText)
if (!Number.isSafeInteger(documents) || documents < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1) {
  throw new Error('documents and batch-size must be positive safe integers')
}

const journal = journalText === 'true'
const separator = baseUri.includes('?') ? '&' : '?'
const uri = `${baseUri}${separator}w=1&journal=${journalText}`
const databaseName = 'gea_mongodb_write_bench'

function makeDocument(id) {
  return {
    _id: Long.fromNumber(id),
    seq: Long.fromNumber(id),
    title: 'todo item',
    completed: false,
    owner: 'benchmark',
    priority: new Int32(3),
  }
}

function makeBatches(items, size) {
  const batches = []
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, Math.min(offset + size, items.length)))
  }
  return batches
}

async function dropIfPresent(collection) {
  try {
    await collection.drop()
  } catch (error) {
    if (error?.codeName !== 'NamespaceNotFound' && error?.code !== 26) throw error
  }
}

const client = new MongoClient(uri)
try {
  await client.connect()
  const database = client.db(databaseName)
  await database.command({ ping: 1 })

  const target = database.collection(collectionName)
  const warmup = database.collection(`${collectionName}_warmup`)
  await dropIfPresent(target)
  await dropIfPresent(warmup)

  const values = Array.from({ length: documents }, (_, index) => makeDocument(index))
  const batches = makeBatches(values, batchSize)
  const warmupCount = workload === 'insert-one' ? Math.min(documents, 16) : Math.min(documents, batchSize)
  const warmupValues = Array.from({ length: warmupCount }, (_, index) => makeDocument(-index - 1))

  if (workload === 'insert-one') {
    for (const value of warmupValues) {
      const result = await warmup.insertOne(value)
      if (!result.acknowledged) throw new Error('warmup insertOne was not acknowledged')
    }
  } else {
    const result = await warmup.insertMany(warmupValues, { ordered: true })
    if (!result.acknowledged || result.insertedCount !== warmupValues.length) {
      throw new Error(`warmup insertMany inserted ${result.insertedCount}/${warmupValues.length}`)
    }
  }
  await dropIfPresent(warmup)

  let operations = 0
  let acknowledgedDocuments = 0
  const started = process.hrtime.bigint()
  if (workload === 'insert-one') {
    for (const value of values) {
      const result = await target.insertOne(value)
      if (!result.acknowledged) throw new Error('insertOne was not acknowledged')
      operations += 1
      acknowledgedDocuments += 1
    }
  } else {
    for (const batch of batches) {
      const result = await target.insertMany(batch, { ordered: true })
      if (!result.acknowledged || result.insertedCount !== batch.length) {
        throw new Error(`insertMany inserted ${result.insertedCount}/${batch.length}`)
      }
      operations += 1
      acknowledgedDocuments += result.insertedCount
    }
  }
  const elapsedNs = process.hrtime.bigint() - started

  const count = await target.countDocuments({})
  if (acknowledgedDocuments !== documents || count !== documents) {
    throw new Error(`inserted-count mismatch: acknowledged=${acknowledgedDocuments} count=${count} expected=${documents}`)
  }

  const elapsedSeconds = Number(elapsedNs) / 1e9
  console.log(
    JSON.stringify({
      driver: 'node',
      workload,
      write_concern: `w1-j${journalText}`,
      documents,
      operations,
      batch_size: batchSize,
      elapsed_ns: elapsedNs.toString(),
      count,
      documents_per_second: documents / elapsedSeconds,
      operations_per_second: operations / elapsedSeconds,
    }),
  )
} finally {
  await client.close()
}
