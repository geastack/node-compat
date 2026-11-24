import { createReadStream, type ReadStreamOptions } from 'node:fs'

interface RangeCase {
  label: string
  file: string | URL
  options: ReadStreamOptions
}

const directory = 'apps/nest-node-probe/dist/fs-read-stream-range.fixtures'
const small = directory + '/small.bin'
const sparse = directory + '/sparse.bin'
const marker = 768 * 1024 * 1024

const cases: RangeCase[] = [
  { label: 'whole', file: small, options: {} },
  { label: 'start only', file: small, options: { start: 10 } },
  { label: 'start and end', file: small, options: { start: 10, end: 19 } },
  { label: 'end only', file: small, options: { end: 0 } },
  { label: 'single byte', file: small, options: { start: 5, end: 5 } },
  { label: 'end past eof', file: small, options: { start: 1000, end: 5000 } },
  { label: 'start past eof', file: small, options: { start: 2000 } },
  { label: 'start at eof', file: small, options: { start: 1024, end: 2000 } },
  { label: 'file url range', file: new URL(`file://${process.cwd()}/${small}`), options: { start: 250, end: 261 } },
  { label: 'sparse marker', file: sparse, options: { start: marker, end: marker + 11 } },
  { label: 'sparse tail', file: sparse, options: { start: 1024 * 1024 * 1024 - 4 } }
]

function readRange(range: RangeCase): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(range.file, range.options)
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    stream.on('error', () => resolve(`${range.label}: error`))
    stream.on('end', () => {
      const bytes = Buffer.concat(chunks)
      resolve(`${range.label}: ${bytes.length} ${bytes.subarray(0, 16).toString('hex')}`)
    })
  })
}

async function main(): Promise<void> {
  for (const range of cases) console.log(await readRange(range))
  console.log(await readRange({ label: 'missing', file: directory + '/missing.bin', options: { start: 1, end: 2 } }))
}

main()
