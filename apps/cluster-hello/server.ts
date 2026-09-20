// node:cluster parity probe. The SAME file runs under Node (`node server.ts`)
// and compiles to a native binary (`node scripts/build.mjs
// apps/cluster-hello/server.ts`). The primary forks NODE_WORKERS workers
// (default: every online CPU) that all serve http://127.0.0.1:3102; a worker
// that dies on its own is replaced, one that was told to leave is not.
//
//   GET /        -> "worker <id> pid <pid> GET /"
//   GET /exit    -> the worker answers, then exits with code 3 (replaced)
//   SIGTERM to a worker -> exit with signal SIGTERM (replaced)
//   SIGTERM to the primary -> every worker exits (no orphans)
import cluster, { Worker } from 'node:cluster'
import { createServer } from 'node:http'
import { availableParallelism } from 'node:os'
import { env, pid, exit } from 'node:process'
import { setTimeout } from 'node:timers'

const PORT = 3102

if (cluster.isPrimary) {
  const requested = env.NODE_WORKERS
  const count = requested === undefined ? availableParallelism() : Number(requested)
  for (let index = 0; index < count; index += 1) cluster.fork()
  cluster.on('online', (worker: Worker) => {
    console.log('primary: worker ' + worker.id + ' online')
  })
  cluster.on('exit', (worker: Worker, code: number | null, signal: string | null) => {
    const codeText = code === null ? 'null' : String(code)
    const signalText = signal === null ? 'null' : signal
    const voluntary = worker.exitedAfterDisconnect === true
    console.log(
      'primary: worker ' + worker.id + ' exited code=' + codeText + ' signal=' + signalText + ' voluntary=' + (voluntary ? 'true' : 'false')
    )
    if (!voluntary) cluster.fork()
  })
  console.log('primary ' + pid + ': ' + count + ' workers on http://127.0.0.1:' + PORT)
} else {
  const self = cluster.worker
  const id = self === undefined ? 0 : self.id
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('worker ' + id + ' pid ' + pid + ' ' + req.method + ' ' + req.url + '\n')
    if (req.url === '/exit') setTimeout(() => exit(3), 20)
  })
  server.listen(PORT, () => {
    console.log('worker ' + id + ' pid ' + pid + ' listening')
  })
}
