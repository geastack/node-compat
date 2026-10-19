import cluster from 'node:cluster'
import os from 'node:os'

if (cluster.isPrimary) {
  const n = Number(process.env.NODE_WORKERS || os.availableParallelism())
  for (let i = 0; i < n; i++) cluster.fork()
  console.log(`nest-node cluster: ${n} workers on http://127.0.0.1:3900`)
} else {
  await import('./dist-node/server.js')
}
