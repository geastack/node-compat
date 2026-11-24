import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseCompileJobs, chooseSplitLto, chooseTranslationUnits } from './build-shape.mjs'

const GB = 1e9
const MB = 1e6

// The populations the coefficients were measured on: an HTTP framework's hello
// world, a web framework with a plugin system, and a database driver server.
const helloWorld = 0.152 * MB
const webFramework = 1.326 * MB
const databaseServer = 2.19 * MB

test('an explicit layout always wins', () => {
  assert.deepEqual(chooseTranslationUnits({ requested: 'single', reachableSourceBytes: databaseServer, totalMemoryBytes: 8 * GB }), {
    layout: 'single',
    reason: null
  })
  assert.deepEqual(chooseTranslationUnits({ requested: 'per-file', reachableSourceBytes: helloWorld, totalMemoryBytes: 64 * GB }), {
    layout: 'per-file',
    reason: null
  })
})

test('a small program keeps one unit on a small machine', () => {
  for (const memory of [8, 16, 20, 64]) {
    assert.deepEqual(chooseTranslationUnits({ requested: null, reachableSourceBytes: helloWorld, totalMemoryBytes: memory * GB }), {
      layout: 'single',
      reason: null
    })
  }
})

test('a large program is split per file whatever the memory', () => {
  for (const memory of [16, 20, 128]) {
    const choice = chooseTranslationUnits({ requested: null, reachableSourceBytes: databaseServer, totalMemoryBytes: memory * GB })
    assert.equal(choice.layout, 'per-file')
    assert.match(choice.reason, /2\.2 MB of reachable package source is a large program/)
  }
})

test('a mid-sized program is split only where one unit would not fit', () => {
  assert.equal(chooseTranslationUnits({ requested: null, reachableSourceBytes: webFramework, totalMemoryBytes: 32 * GB }).layout, 'single')
  assert.equal(chooseTranslationUnits({ requested: null, reachableSourceBytes: webFramework, totalMemoryBytes: 20 * GB }).layout, 'single')
  const tight = chooseTranslationUnits({ requested: null, reachableSourceBytes: webFramework, totalMemoryBytes: 16 * GB })
  assert.equal(tight.layout, 'per-file')
  assert.match(tight.reason, /needs about 14\.6 GB, more than 12\.8 GB of this machine's 16\.0 GB/)
})

test('a split build keeps the default LTO while the full-LTO link fits', () => {
  assert.deepEqual(chooseSplitLto({ emittedBytes: 5 * MB, totalMemoryBytes: 16 * GB, cxxIsClang: true }), { lto: undefined, reason: null })
  assert.deepEqual(chooseSplitLto({ emittedBytes: 45 * MB, totalMemoryBytes: 64 * GB, cxxIsClang: true }), { lto: undefined, reason: null })
})

test('a split build whose full-LTO link would not fit takes ThinLTO under clang and no LTO under gcc', () => {
  const clang = chooseSplitLto({ emittedBytes: 45 * MB, totalMemoryBytes: 20 * GB, cxxIsClang: true })
  assert.equal(clang.lto, 'thin')
  assert.match(clang.reason, /full-LTO link of 45\.0 MB of C\+\+ needs about 24\.8 GB, more than 16\.0 GB .*: ThinLTO/)
  const gcc = chooseSplitLto({ emittedBytes: 45 * MB, totalMemoryBytes: 20 * GB, cxxIsClang: false })
  assert.equal(gcc.lto, null)
  assert.match(gcc.reason, /: no LTO/)
})

test('an explicit GEA_JOBS always wins', () => {
  assert.deepEqual(chooseCompileJobs({ requested: '6', cores: 20, totalMemoryBytes: 17 * GB, availableMemoryBytes: 16 * GB }), {
    jobs: 6,
    reason: null
  })
})

test('compile jobs are capped by memory, not only cores', () => {
  // The box that OOM-killed six jobs: 20 cores under a 17 GB limit.
  const capped = chooseCompileJobs({ requested: undefined, cores: 20, totalMemoryBytes: 17 * GB, availableMemoryBytes: 16 * GB })
  assert.equal(capped.jobs, 2)
  assert.match(capped.reason, /GEA_JOBS overrides/)
  assert.equal(chooseCompileJobs({ requested: '', cores: 20, totalMemoryBytes: 19 * GB, availableMemoryBytes: 18 * GB }).jobs, 3)
  // Memory already in use lowers the cap below the physical share.
  assert.equal(chooseCompileJobs({ requested: undefined, cores: 20, totalMemoryBytes: 64 * GB, availableMemoryBytes: 11 * GB }).jobs, 2)
  // Never below one job.
  assert.equal(chooseCompileJobs({ requested: undefined, cores: 8, totalMemoryBytes: 4 * GB, availableMemoryBytes: 2 * GB }).jobs, 1)
})

test('a machine with memory to spare uses every core', () => {
  assert.deepEqual(chooseCompileJobs({ requested: undefined, cores: 8, totalMemoryBytes: 128 * GB, availableMemoryBytes: 120 * GB }), {
    jobs: 8,
    reason: null
  })
})
