import { existsSync, promises as fsPromises, stat, statSync, Stats } from 'node:fs'

interface StatsReport {
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  blksize: number
  blocks: number
  atimePlausible: boolean
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  mtime: string
  ctime: string
  birthtime: string
  isFile: boolean
  isDirectory: boolean
  isBlockDevice: boolean
  isCharacterDevice: boolean
  isSymbolicLink: boolean
  isFIFO: boolean
  isSocket: boolean
}

interface ErrorReport {
  message: string
  code: string
  errno: number
  syscall: string
  path: string
}

function report(stats: Stats, volatileTimes = false): StatsReport {
  const timeMs = (ms: number): number => (volatileTimes ? -1 : ms)
  const time = (date: Date): string => (volatileTimes ? 'volatile' : date.toISOString())
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    rdev: stats.rdev,
    size: stats.size,
    blksize: stats.blksize,
    blocks: stats.blocks,
    atimePlausible: stats.atimeMs > 0 && stats.atime.getTime() === Math.round(stats.atimeMs),
    mtimeMs: timeMs(stats.mtimeMs),
    ctimeMs: timeMs(stats.ctimeMs),
    birthtimeMs: timeMs(stats.birthtimeMs),
    mtime: time(stats.mtime),
    ctime: time(stats.ctime),
    birthtime: time(stats.birthtime),
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isBlockDevice: stats.isBlockDevice(),
    isCharacterDevice: stats.isCharacterDevice(),
    isSymbolicLink: stats.isSymbolicLink(),
    isFIFO: stats.isFIFO(),
    isSocket: stats.isSocket()
  }
}

function errorReport(error: unknown): ErrorReport {
  if (error instanceof Error && 'code' in error && 'errno' in error && 'syscall' in error && 'path' in error) {
    return {
      message: error.message,
      code: String(error.code),
      errno: Number(error.errno),
      syscall: String(error.syscall),
      path: String(error.path)
    }
  }
  return { message: String(error), code: '', errno: 0, syscall: '', path: '' }
}

const file = 'apps/nest-node-probe/correctness/fs-stat.ts'
const directory = 'runtime/node'
const device = '/dev/null'
const missing = 'apps/nest-node-probe/correctness/does-not-exist'
const notDirectory = 'apps/nest-node-probe/correctness/fs-stat.ts/child'

async function main(): Promise<void> {
  console.log(JSON.stringify(report(statSync(file))))
  console.log(JSON.stringify(report(statSync(directory))))
  console.log(JSON.stringify(report(statSync(device), true)))
  console.log(JSON.stringify(report(statSync(new URL(`file://${process.cwd()}/${file}`)))))
  console.log(existsSync(file), existsSync(missing))

  for (const path of [missing, notDirectory]) {
    try {
      statSync(path)
      console.log('no error')
    } catch (error) {
      console.log(JSON.stringify(errorReport(error)))
    }
  }

  console.log(statSync(missing, { throwIfNoEntry: false }) === undefined, statSync(notDirectory, { throwIfNoEntry: false }) === undefined)
  const present = statSync(file, { throwIfNoEntry: false })
  console.log(present === undefined ? 'undefined' : JSON.stringify(report(present)))
  try {
    statSync(missing, { throwIfNoEntry: true })
    console.log('no error')
  } catch (error) {
    console.log(JSON.stringify(errorReport(error)))
  }

  const fromPromise = await fsPromises.stat(directory)
  console.log(JSON.stringify(report(fromPromise)))
  try {
    await fsPromises.stat(missing)
    console.log('no error')
  } catch (error) {
    console.log(JSON.stringify(errorReport(error)))
  }

  await new Promise<void>((resolve) => {
    let ordered = 'callback ran before stat returned'
    stat(file, (err, stats) => {
      console.log(ordered)
      console.log(err === null, stats === undefined ? 'undefined' : JSON.stringify(report(stats)))
      stat(missing, (missingErr, missingStats) => {
        console.log(missingErr === null ? 'null' : JSON.stringify(errorReport(missingErr)), missingStats === undefined)
        resolve()
      })
    })
    ordered = 'callback ran after stat returned'
  })
}

main()
