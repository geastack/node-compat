import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { RouteTable } from '@nestjs/platform-node/router/route-table'
import { NodeRequest, NodeResponse } from '@nestjs/platform-node/adapters/node-request'
import { json } from '@nestjs/platform-node/body-parser/body-parser'

class AppService {
  hello(): string {
    return 'Hello Nest!'
  }
  user(id: string): { id: string; name: string } {
    return { id, name: `user-${id}` }
  }
}

const service = new AppService()
const routes = new RouteTable()
const parseJson = json()

routes.add('GET', '/', (req: NodeRequest, res: NodeResponse) => {
  res.send(service.hello())
})
routes.add('GET', '/json', (req: NodeRequest, res: NodeResponse) => {
  res.json({ hello: 'world' })
})
routes.add('GET', '/users/:id', (req: NodeRequest, res: NodeResponse) => {
  const id = req.params.id
  res.json(service.user(typeof id === 'string' ? id : id.join('/')))
})
routes.add('POST', '/echo', (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void) => {
  parseJson(req, res, (err?: unknown) => {
    if (err !== undefined) return next(err)
    res.json(req.body)
  })
})

function notFound(req: NodeRequest, res: NodeResponse): void {
  res.status(404).json({ message: `Cannot ${req.method} ${req.path}`, error: 'Not Found', statusCode: 404 })
}

function failed(err: unknown, req: NodeRequest, res: NodeResponse): void {
  console.error(`failed ${req.method} ${req.path}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 500
  res.status(status).json({ statusCode: status, message: status === 500 ? 'Internal server error' : String((err as Error).message) })
}

const server = createServer(
  { IncomingMessage: NodeRequest, ServerResponse: NodeResponse },
  (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const req = incoming as NodeRequest
    const res = outgoing as NodeResponse
    const matched = routes.lookup(req.method ?? 'GET', req.path)
    if (matched === null) return notFound(req, res)
    req.params = matched.params
    const handler = matched.handlers[0]
    try {
      handler(req, res, (err?: unknown) => (err === undefined ? notFound(req, res) : failed(err, req, res)))
    } catch (err) {
      failed(err, req, res)
    }
  }
)
server.listen(3902, () => {
  console.log('nest-node-probe listening on http://127.0.0.1:3902')
})
