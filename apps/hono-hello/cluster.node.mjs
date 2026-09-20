// Multi-core node comparator: the SAME hono bridge (server.node.mjs), forked
// across N workers via node:cluster — the canonical node deployment shape
// (primary round-robins accepted connections to workers on Linux). Mirrors
// the gea binary's GEA_WORKERS=N reuseport mode.
import cluster from 'node:cluster'
import os from 'node:os'

if (cluster.isPrimary) {
  const n = Number(process.env.NODE_WORKERS || os.availableParallelism())
  for (let i = 0; i < n; i++) cluster.fork()
  console.log(`hono-node cluster: ${n} workers on http://127.0.0.1:3000`)
} else {
  await import('./server.node.mjs')
}
