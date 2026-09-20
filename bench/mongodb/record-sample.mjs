#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'

const [
  roundText,
  expectedDriver,
  expectedWorkload,
  expectedWriteConcern,
  documentsText,
  batchSizeText,
  collection,
  rawPath,
  samplesPath,
] = process.argv.slice(2)

if (!samplesPath) {
  console.error(
    'usage: node record-sample.mjs <round> <driver> <workload> <write-concern> <documents> <batch-size> <collection> <raw.json> <samples.tsv>',
  )
  process.exit(2)
}

function fail(message) {
  throw new Error(message)
}

function expectInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}, got ${value}`)
}

const round = Number(roundText)
const expectedDocuments = Number(documentsText)
const expectedBatchSize = Number(batchSizeText)
expectInteger(round, 'round', 1)
expectInteger(expectedDocuments, 'documents', 1)
expectInteger(expectedBatchSize, 'batch-size', 1)

const raw = (await readFile(rawPath, 'utf8')).trim()
if (!raw || raw.includes('\n')) fail(`${rawPath} must contain exactly one JSON line`)

let sample
try {
  sample = JSON.parse(raw)
} catch (error) {
  fail(`${rawPath} is not valid JSON: ${error.message}`)
}

for (const [name, expected] of [
  ['driver', expectedDriver],
  ['workload', expectedWorkload],
  ['write_concern', expectedWriteConcern],
]) {
  if (sample[name] !== expected) fail(`${name} mismatch: got ${sample[name]}, expected ${expected}`)
}

const expectedOperations =
  expectedWorkload === 'insert-one' ? expectedDocuments : Math.ceil(expectedDocuments / expectedBatchSize)
for (const [name, expected] of [
  ['documents', expectedDocuments],
  ['operations', expectedOperations],
  ['batch_size', expectedBatchSize],
  ['count', expectedDocuments],
]) {
  if (sample[name] !== expected) fail(`${name} mismatch: got ${sample[name]}, expected ${expected}`)
}

if (!/^[1-9][0-9]*$/.test(sample.elapsed_ns)) fail(`invalid elapsed_ns: ${sample.elapsed_ns}`)
for (const name of ['documents_per_second', 'operations_per_second']) {
  if (typeof sample[name] !== 'number' || !Number.isFinite(sample[name]) || sample[name] <= 0) {
    fail(`${name} must be a positive finite number`)
  }
}

const elapsedSeconds = Number(BigInt(sample.elapsed_ns)) / 1e9
const expectedDocumentsPerSecond = expectedDocuments / elapsedSeconds
const expectedOperationsPerSecond = expectedOperations / elapsedSeconds
const relativeError = (actual, expected) => Math.abs(actual - expected) / expected
if (relativeError(sample.documents_per_second, expectedDocumentsPerSecond) > 1e-5) {
  fail('documents_per_second is inconsistent with elapsed_ns')
}
if (relativeError(sample.operations_per_second, expectedOperationsPerSecond) > 1e-5) {
  fail('operations_per_second is inconsistent with elapsed_ns')
}

const fields = [
  round,
  expectedDriver,
  expectedWorkload,
  expectedWriteConcern,
  expectedDocuments,
  expectedOperations,
  expectedBatchSize,
  sample.elapsed_ns,
  sample.documents_per_second.toFixed(6),
  sample.operations_per_second.toFixed(6),
  sample.count,
  collection,
]
await appendFile(samplesPath, `${fields.join('\t')}\n`)
console.log(
  `SAMPLE round=${round} driver=${expectedDriver} workload=${expectedWorkload} write_concern=${expectedWriteConcern} documents_per_second=${sample.documents_per_second.toFixed(2)} operations_per_second=${sample.operations_per_second.toFixed(2)} count=${sample.count}`,
)
