// Isolate the indirect native call used by @hono/node-server 2.1.1.
// No sockets are opened; compare this exact file under Node and Perry.
import { createServer } from 'node:http'

const direct = createServer({}, (_req, res) => res.end('direct'))
console.log('direct server:', typeof direct, 'listen:', typeof direct?.listen)

const options: { createServer?: typeof createServer } = {}
const indirect = (options.createServer || createServer)({}, (_req, res) => res.end('indirect'))
console.log('indirect server:', typeof indirect, 'listen:', typeof indirect?.listen)
