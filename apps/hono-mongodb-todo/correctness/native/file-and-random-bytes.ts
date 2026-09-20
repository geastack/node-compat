import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'

async function checkBytes(): Promise<void> {
  const file = 'apps/hono-mongodb-todo/correctness/native/file-and-random-bytes.ts'
  const bytes = await fs.readFile(file)
  const text = await fs.readFile(file, 'utf8')
  console.log(bytes.length > 0, bytes.toString('utf8') === text)
  console.log(randomBytes(32).length, randomBytes(0).length)
}

checkBytes()
