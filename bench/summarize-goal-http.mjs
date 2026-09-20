#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const SERVER_ORDER = [
  'gea-hono-source',
  'node-hono',
  'gea-raw',
  'node-raw',
  'rust-hyper',
  'rust-axum',
  'cpp-drogon',
  'cpp-epoll',
]

const WORKLOADS = [
  {
    title: 'Hono workload (same Hono application)',
    servers: ['gea-hono-source', 'node-hono'],
  },
  {
    title: 'Raw HTTP workload (not Hono)',
    servers: ['gea-raw', 'node-raw', 'rust-hyper', 'rust-axum', 'cpp-drogon', 'cpp-epoll'],
  },
]

const RATIO_TARGETS = [
  ['node-raw', 'Node raw'],
  ['rust-hyper', 'Rust Hyper'],
  ['rust-axum', 'Rust Axum'],
  ['cpp-drogon', 'Drogon'],
  ['cpp-epoll', 'C++ epoll'],
]

function fail(message) {
  throw new Error(message)
}

function parseRate(value, context) {
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmMgGtT]?)$/.exec(value.trim())
  if (!match) fail(`invalid RPS value ${JSON.stringify(value)} at ${context}`)
  const multiplier = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9, t: 1e12, T: 1e12 }[match[2]]
  return Number(match[1]) * multiplier
}

function parseLatencyUs(value, context) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ns|us|[µμ]s|ms|s)$/.exec(value.trim())
  if (!match) fail(`invalid latency value ${JSON.stringify(value)} at ${context}`)
  const multiplier = { ns: 0.001, us: 1, 'µs': 1, 'μs': 1, ms: 1e3, s: 1e6 }[match[2]]
  return Number(match[1]) * multiplier
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function format(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function parseSamples(tsv) {
  const lines = tsv.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length < 2) fail('TSV has no sample rows')

  const header = lines[0].split('\t')
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]))
  for (const name of ['round', 'server', 'path', 'rps', 'p50', 'p90', 'p99']) {
    if (indexes[name] === undefined) fail(`TSV is missing required column ${JSON.stringify(name)}`)
  }

  return lines.slice(1).map((line, index) => {
    const fields = line.split('\t')
    const lineNumber = index + 2
    const at = (name) => {
      const value = fields[indexes[name]]
      if (value === undefined || value === '') fail(`missing ${name} at line ${lineNumber}`)
      return value
    }
    return {
      round: Number(at('round')),
      server: at('server'),
      path: at('path'),
      rps: parseRate(at('rps'), `line ${lineNumber}`),
      p50Us: parseLatencyUs(at('p50'), `line ${lineNumber}`),
      p90Us: parseLatencyUs(at('p90'), `line ${lineNumber}`),
      p99Us: parseLatencyUs(at('p99'), `line ${lineNumber}`),
    }
  })
}

function validateExpectedMatrix(samples, expectedRounds) {
  const paths = ['/', '/json']
  const honoServers = WORKLOADS[0].servers
  const sampleServers = new Set(samples.map((sample) => sample.server))
  const expectedServers = [...sampleServers].every((server) => honoServers.includes(server)) ? honoServers : SERVER_ORDER
  const expectedKeys = new Set(expectedServers.flatMap((server) => paths.map((path) => key(server, path))))
  const seen = new Map()

  for (const sample of samples) {
    if (!Number.isInteger(sample.round) || sample.round < 1 || sample.round > expectedRounds) {
      fail(`invalid round ${JSON.stringify(sample.round)} for ${sample.server} ${sample.path}`)
    }
    const sampleKey = key(sample.server, sample.path)
    if (!expectedKeys.has(sampleKey)) fail(`unexpected sample group ${sample.server} ${sample.path}`)
    const rounds = seen.get(sampleKey) ?? new Set()
    if (rounds.has(sample.round)) fail(`duplicate round ${sample.round} for ${sample.server} ${sample.path}`)
    rounds.add(sample.round)
    seen.set(sampleKey, rounds)
  }

  const expectedRows = expectedKeys.size * expectedRounds
  if (samples.length !== expectedRows) fail(`expected ${expectedRows} sample rows, found ${samples.length}`)
  for (const sampleKey of expectedKeys) {
    const [server, path] = sampleKey.split('\0')
    const rounds = seen.get(sampleKey)
    if (!rounds || rounds.size !== expectedRounds) {
      fail(`expected ${expectedRounds} rounds for ${server} ${path}, found ${rounds?.size ?? 0}`)
    }
    for (let round = 1; round <= expectedRounds; round += 1) {
      if (!rounds.has(round)) fail(`missing round ${round} for ${server} ${path}`)
    }
  }
}

function summarize(samples) {
  const groups = new Map()
  for (const sample of samples) {
    const key = `${sample.server}\0${sample.path}`
    const group = groups.get(key) ?? []
    group.push(sample)
    groups.set(key, group)
  }

  return new Map(
    [...groups].map(([key, group]) => [
      key,
      {
        server: group[0].server,
        path: group[0].path,
        count: group.length,
        medianRps: median(group.map((sample) => sample.rps)),
        minRps: Math.min(...group.map((sample) => sample.rps)),
        maxRps: Math.max(...group.map((sample) => sample.rps)),
        medianP50Us: median(group.map((sample) => sample.p50Us)),
        medianP90Us: median(group.map((sample) => sample.p90Us)),
        medianP99Us: median(group.map((sample) => sample.p99Us)),
      },
    ]),
  )
}

function key(server, path) {
  return `${server}\0${path}`
}

function pathOrder(a, b) {
  const preferred = ['/', '/json']
  const ai = preferred.indexOf(a)
  const bi = preferred.indexOf(b)
  if (ai !== -1 || bi !== -1) return (ai === -1 ? preferred.length : ai) - (bi === -1 ? preferred.length : bi)
  return a.localeCompare(b)
}

function printTable(rows) {
  console.log('server\tpath\tn\tmedian_rps\tmin_rps\tmax_rps\tmedian_p50_us\tmedian_p90_us\tmedian_p99_us')
  for (const row of rows) {
    console.log(
      [
        row.server,
        row.path,
        row.count,
        format(row.medianRps),
        format(row.minRps),
        format(row.maxRps),
        format(row.medianP50Us),
        format(row.medianP90Us),
        format(row.medianP99Us),
      ].join('\t'),
    )
  }
}

function ratio(summary, numerator, denominator, path) {
  const left = summary.get(key(numerator, path))
  const right = summary.get(key(denominator, path))
  return left && right && right.medianRps !== 0 ? left.medianRps / right.medianRps : Number.NaN
}

function main() {
  const args = process.argv.slice(2)
  let expectedRounds = null
  if (args[0] === '--expect-rounds') {
    args.shift()
    expectedRounds = Number(args.shift())
    if (!Number.isInteger(expectedRounds) || expectedRounds < 1) {
      console.error('--expect-rounds must be a positive integer')
      process.exitCode = 2
      return
    }
  }
  const input = args[0]
  if (!input || args.length !== 1) {
    console.error('Usage: node bench/summarize-goal-http.mjs [--expect-rounds N] <samples.tsv>')
    process.exitCode = 2
    return
  }

  return readFile(input, 'utf8').then((tsv) => {
    const samples = parseSamples(tsv)
    if (expectedRounds !== null) validateExpectedMatrix(samples, expectedRounds)
    const summary = summarize(samples)
    const paths = [...new Set(samples.map((sample) => sample.path))].sort(pathOrder)
    const knownServers = new Set(SERVER_ORDER)

    console.log(`HTTP benchmark summary: ${input}`)
    console.log('RPS values are requests/second; all latency percentiles are normalized to microseconds.')

    for (const workload of WORKLOADS) {
      console.log(`\n${workload.title}`)
      const rows = workload.servers.flatMap((server) =>
        paths.map((path) => summary.get(key(server, path))).filter(Boolean),
      )
      printTable(rows)
    }

    const otherRows = [...summary.values()]
      .filter((row) => !knownServers.has(row.server))
      .sort((a, b) => a.server.localeCompare(b.server) || pathOrder(a.path, b.path))
    if (otherRows.length > 0) {
      console.log('\nOther workload rows')
      printTable(otherRows)
    }

    console.log('\nHono workload median-RPS ratios (native source-Hono / Node Hono)')
    console.log('path\tratio')
    for (const path of paths) console.log(`${path}\t${format(ratio(summary, 'gea-hono-source', 'node-hono', path), 3)}x`)

    console.log('\nRaw HTTP workload median-RPS ratios (raw Gea / comparison server)')
    console.log('path\tcomparison\tratio')
    for (const path of paths) {
      for (const [server, label] of RATIO_TARGETS) {
        console.log(`${path}\t${label}\t${format(ratio(summary, 'gea-raw', server, path), 3)}x`)
      }
    }
  })
}

main()?.catch((error) => {
  console.error(`summarize-goal-http: ${error.message}`)
  process.exitCode = 1
})
