// Multi-core node comparator for the UNCHANGED app file: server.ts itself
// (full `hono` + `@hono/node-server`, the program geatsc compiles), run by
// Node's built-in type stripping and forked across N workers via node:cluster.
// cluster.node.mjs forks server.node.mjs instead, a hand-written `hono/tiny`
// bridge -- a lighter program than the one the gea row serves.
import cluster from 'node:cluster'
import os from 'node:os'

if (cluster.isPrimary) {
  const n = Number(process.env.NODE_WORKERS || os.availableParallelism())
  for (let i = 0; i < n; i++) cluster.fork()
  console.log(`hono-node-full cluster: ${n} workers on http://127.0.0.1:3900`)
} else {
  await import('./server.ts')
}
