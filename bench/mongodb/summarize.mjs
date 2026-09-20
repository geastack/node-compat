#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
let expectedRounds = null
if (args[0] === '--expect-rounds') {
  args.shift()
  expectedRounds = Number(args.shift())
}
const input = args.shift()
if (!input || args.length > 0 || (expectedRounds !== null && (!Number.isInteger(expectedRounds) || expectedRounds < 1))) {
  console.error('usage: node summarize.mjs [--expect-rounds N] <samples.tsv>')
  process.exit(2)
}

const DRIVERS = ['node', 'rust', 'cpp']
const WORKLOADS = ['insert-one', 'insert-many']
const WRITE_CONCERNS = ['w1-jfalse', 'w1-jtrue']

function fail(message) {
  throw new Error(message)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function key(driver, workload, writeConcern) {
  return `${driver}\0${workload}\0${writeConcern}`
}

const text = await readFile(input, 'utf8')
const lines = text.trim().split(/\r?\n/)
if (lines.length < 2) fail('sample file has no rows')
const header = lines[0].split('\t')
const indexes = Object.fromEntries(header.map((name, index) => [name, index]))
for (const name of [
  'round',
  'driver',
  'workload',
  'write_concern',
  'documents',
  'operations',
  'elapsed_ns',
  'documents_per_second',
  'operations_per_second',
  'count',
]) {
  if (indexes[name] === undefined) fail(`missing column ${name}`)
}

const samples = lines.slice(1).map((line, rowIndex) => {
  const fields = line.split('\t')
  const get = (name) => fields[indexes[name]]
  const sample = {
    round: Number(get('round')),
    driver: get('driver'),
    workload: get('workload'),
    writeConcern: get('write_concern'),
    documents: Number(get('documents')),
    operations: Number(get('operations')),
    elapsedNs: Number(get('elapsed_ns')),
    documentsPerSecond: Number(get('documents_per_second')),
    operationsPerSecond: Number(get('operations_per_second')),
    count: Number(get('count')),
  }
  if (
    !Number.isInteger(sample.round) ||
    !DRIVERS.includes(sample.driver) ||
    !WORKLOADS.includes(sample.workload) ||
    !WRITE_CONCERNS.includes(sample.writeConcern) ||
    !Number.isFinite(sample.elapsedNs) ||
    sample.elapsedNs <= 0 ||
    sample.count !== sample.documents
  ) {
    fail(`invalid sample at TSV line ${rowIndex + 2}`)
  }
  return sample
})

const groups = new Map()
for (const sample of samples) {
  const sampleKey = key(sample.driver, sample.workload, sample.writeConcern)
  const group = groups.get(sampleKey) ?? []
  if (group.some((other) => other.round === sample.round)) fail(`duplicate round for ${sampleKey}`)
  group.push(sample)
  groups.set(sampleKey, group)
}

if (expectedRounds !== null) {
  const expectedRows = DRIVERS.length * WORKLOADS.length * WRITE_CONCERNS.length * expectedRounds
  if (samples.length !== expectedRows) fail(`expected ${expectedRows} rows, found ${samples.length}`)
  for (const driver of DRIVERS) {
    for (const workload of WORKLOADS) {
      for (const writeConcern of WRITE_CONCERNS) {
        const group = groups.get(key(driver, workload, writeConcern))
        if (!group || group.length !== expectedRounds) {
          fail(`expected ${expectedRounds} samples for ${driver}/${workload}/${writeConcern}`)
        }
        for (let round = 1; round <= expectedRounds; round += 1) {
          if (!group.some((sample) => sample.round === round)) {
            fail(`missing round ${round} for ${driver}/${workload}/${writeConcern}`)
          }
        }
      }
    }
  }
}

const summaries = new Map(
  [...groups].map(([groupKey, group]) => [
    groupKey,
    {
      count: group.length,
      documents: group[0].documents,
      operations: group[0].operations,
      medianDocumentsPerSecond: median(group.map((sample) => sample.documentsPerSecond)),
      minDocumentsPerSecond: Math.min(...group.map((sample) => sample.documentsPerSecond)),
      maxDocumentsPerSecond: Math.max(...group.map((sample) => sample.documentsPerSecond)),
      medianOperationsPerSecond: median(group.map((sample) => sample.operationsPerSecond)),
      medianElapsedMs: median(group.map((sample) => sample.elapsedNs / 1e6)),
    },
  ]),
)

console.log(`MongoDB direct-write benchmark summary: ${input}`)
console.log('Timing excludes connection setup, BSON/document generation, warmup, validation, and cleanup.')
console.log('All writes are acknowledged w:1; throughput is timed API-return throughput on one client thread.')

for (const workload of WORKLOADS) {
  for (const writeConcern of WRITE_CONCERNS) {
    console.log(`\n${workload} / ${writeConcern}`)
    console.log(
      'driver\tn\tdocuments\toperations\tmedian_docs_s\tmin_docs_s\tmax_docs_s\tmedian_ops_s\tmedian_elapsed_ms\tvs_node',
    )
    const node = summaries.get(key('node', workload, writeConcern))
    for (const driver of DRIVERS) {
      const value = summaries.get(key(driver, workload, writeConcern))
      if (!value) continue
      console.log(
        [
          driver,
          value.count,
          value.documents,
          value.operations,
          value.medianDocumentsPerSecond.toFixed(2),
          value.minDocumentsPerSecond.toFixed(2),
          value.maxDocumentsPerSecond.toFixed(2),
          value.medianOperationsPerSecond.toFixed(2),
          value.medianElapsedMs.toFixed(2),
          node ? `${(value.medianDocumentsPerSecond / node.medianDocumentsPerSecond).toFixed(3)}x` : 'n/a',
        ].join('\t'),
      )
    }
  }
}
