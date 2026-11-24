// What the benchmark runners need from the host, on macOS and Linux alike:
// where results go, peak-RSS accounting through /usr/bin/time, tool versions,
// and which optional comparison arms (Rust, C++) this machine can build.

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

/**
 * Where a runner writes its reports. BENCH_RESULTS_DIR redirects them, so a
 * run on another machine does not overwrite the tracked `results/` files.
 */
export const resultRootFor = (benchmarkRoot) =>
  process.env.BENCH_RESULTS_DIR ? path.resolve(process.env.BENCH_RESULTS_DIR) : path.join(benchmarkRoot, 'results')

/** True when `command` runs on this machine. */
export const commandExists = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.error === undefined && result.status === 0
}

/** The trimmed output of a version command, or null when the tool is absent. */
export const versionOf = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** The MongoDB server version: mongosh when installed, otherwise the local mongod binary's. */
export const mongodbVersion = () => {
  const shell = versionOf('mongosh', ['--quiet', '--eval', 'db.version()'])
  if (shell) return shell.split(/\r?\n/).at(-1)
  const server = versionOf('mongod', ['--version'])
  return server?.match(/db version v(\S+)/)?.[1] ?? 'unknown'
}

/** The installed wrk version (Homebrew on macOS, `wrk -v` elsewhere). */
export const wrkVersion = () => {
  if (process.platform === 'darwin') {
    const brew = versionOf('brew', ['list', '--versions', 'wrk'])
    if (brew) return brew
  }
  // `wrk -v` prints its banner and exits non-zero.
  const result = spawnSync('wrk', ['-v'], { encoding: 'utf8' })
  const line = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/).find((text) => text.startsWith('wrk '))
  return line?.split(' [')[0] ?? 'wrk'
}

/** The /usr/bin/time flag that reports peak RSS: BSD `-l`, GNU `-v`. */
export const timeFlag = process.platform === 'darwin' ? '-l' : '-v'

/** How peak RSS is measured, for the report's methodology. */
export const peakRssSource = process.platform === 'darwin' ? 'macOS `/usr/bin/time -l`' : 'GNU `/usr/bin/time -v`'

/** Peak RSS (bytes) and real/user/system seconds from /usr/bin/time's stderr, BSD or GNU. */
export const parseTime = (stderr) => {
  const bsdRss = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m)?.[1]
  const bsdTimes = stderr.match(/^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys$/m)
  if (bsdRss !== undefined && bsdTimes !== null) {
    return {
      peakRssBytes: Number(bsdRss),
      processSeconds: { real: Number(bsdTimes[1]), user: Number(bsdTimes[2]), system: Number(bsdTimes[3]) }
    }
  }
  const gnuRss = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1]
  const user = stderr.match(/User time \(seconds\): ([\d.]+)/)?.[1]
  const system = stderr.match(/System time \(seconds\): ([\d.]+)/)?.[1]
  const wall = stderr.match(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)/)?.[1]
  if (gnuRss === undefined || user === undefined || system === undefined || wall === undefined) {
    throw new Error(`could not parse /usr/bin/time output:\n${stderr}`)
  }
  const real = wall.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  return { peakRssBytes: Number(gnuRss) * 1024, processSeconds: { real, user: Number(user), system: Number(system) } }
}
