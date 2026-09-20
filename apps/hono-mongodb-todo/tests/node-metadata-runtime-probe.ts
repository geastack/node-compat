import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as process from 'process'

function expect(condition: boolean, label: string): void {
  if (!condition) throw new Error('Node metadata runtime probe failed: ' + label)
}

async function run(): Promise<void> {
  expect(process.version.startsWith('v'), 'process.version')
  expect(process.platform === os.platform(), 'process/os platform parity')
  expect(os.arch().length > 0, 'os.arch')
  expect(os.release().length > 0, 'os.release')
  expect(os.type().length > 0, 'os.type')
  expect(os.endianness() === 'LE', 'os.endianness')
  expect(process.env.PATH !== undefined && process.env.PATH.length > 0, 'process.env')

  const first = randomBytes(32)
  const second = randomBytes(32)
  expect(first.length === 32 && second.length === 32, 'randomBytes length')
  expect(!first.equals(second), 'randomBytes entropy')

  await new Promise<void>((resolve, reject) => {
    randomBytes(8, (error, value) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (value.length !== 8) {
        reject(new Error('callback randomBytes length'))
        return
      }
      resolve()
    })
  })

  await fs.access('.')
  let missingRejected = false
  try {
    await fs.access('./definitely-missing-gea-node-runtime-probe')
  } catch {
    missingRejected = true
  }
  expect(missingRejected, 'fs.access rejection')

  const packageJson = await fs.readFile('apps/hono-mongodb-todo/package.json')
  expect(packageJson.length > 0, 'fs.readFile')

  process.stdout.write(
    `node-metadata-runtime-probe=ok:${process.platform}:${os.arch()}:${packageJson.length}\n`
  )
}

run().catch((error: Error) => {
  process.stderr.write('node-metadata-runtime-probe=ERROR:' + error.message + '\n')
})
