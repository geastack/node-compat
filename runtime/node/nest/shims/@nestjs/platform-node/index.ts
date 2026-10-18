import { type IncomingMessage, Server, type ServerResponse } from 'node:http'
import { endWithoutBody, NodeRequest, NodeResponse, ROUTE_ERROR_HANDLER } from '../../../platform-node/adapters/node-request'
import { json, urlencoded } from '../../../platform-node/body-parser/body-parser'
import { PARAM_TOO_LONG, type RouteMatch, RouteTable } from '../../../platform-node/router/route-table'
import { getRoutingPath } from '../../../platform-node/router/utils'

export { NodeRequest, NodeResponse }

export interface NodeAdapterOptions {
  maxParamLength?: number
}

export type NodeRouteHandler = (req: NodeRequest, res: NodeResponse) => void
export type NodeErrorHandler = (error: unknown, req: NodeRequest, res: NodeResponse) => void

type BodyParser = (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void) => void

export class UriTooLongError extends Error {
  status = 414
  statusCode = 414
  expose = true
  constructor() {
    super('Route parameter too long')
    this.name = 'Error'
  }
}

function rejectUnset(req: NodeRequest, res: NodeResponse): void {
  res.statusCode = 404
  res.end()
}
function failUnset(error: unknown, req: NodeRequest, res: NodeResponse): void {
  res.statusCode = 500
  res.end()
}

class AdapterServer extends Server {
  readonly [ROUTE_ERROR_HANDLER]: NodeErrorHandler
  constructor(listener: (req: IncomingMessage, res: ServerResponse) => void, onRouteError: NodeErrorHandler) {
    super({ IncomingMessage: NodeRequest, ServerResponse: NodeResponse }, listener)
    this[ROUTE_ERROR_HANDLER] = onRouteError
  }
}

export class NodeAdapter {
  private readonly routes: RouteTable
  private readonly parseJson: BodyParser
  private readonly parseUrlencoded: BodyParser
  private parsers = true
  private notFound: NodeRouteHandler = rejectUnset
  private onError: NodeErrorHandler = failUnset
  private httpServer: Server | undefined = undefined

  constructor(options?: NodeAdapterOptions) {
    this.routes = new RouteTable(options === undefined ? {} : { maxParamLength: options.maxParamLength })
    this.parseJson = json()
    this.parseUrlencoded = urlencoded({ extended: true })
  }

  init(notFound: NodeRouteHandler, onError: NodeErrorHandler, bodyParser: boolean): void {
    this.notFound = notFound
    this.onError = onError
    this.parsers = bodyParser
  }

  route(method: string, path: string, handler: NodeRouteHandler): void {
    this.routes.add(method === 'ALL' ? null : method, path, handler)
  }

  handle(req: NodeRequest, res: NodeResponse): void {
    if (req.originalUrl === undefined) req.originalUrl = req.url ?? '/'
    if (!this.parsers) return this.dispatch(req, res)
    this.parseJson(req, res, (err?: unknown) => {
      if (err !== undefined) return this.onError(err, req, res)
      this.parseUrlencoded(req, res, (err2?: unknown) => {
        if (err2 !== undefined) return this.onError(err2, req, res)
        this.dispatch(req, res)
      })
    })
  }

  private dispatch(req: NodeRequest, res: NodeResponse): void {
    let matched: RouteMatch | null
    try {
      matched = this.routes.lookup(req.method ?? 'GET', getRoutingPath(req.url ?? '/'))
    } catch (err) {
      return this.onError(err, req, res)
    }
    if (matched === PARAM_TOO_LONG) return this.onError(new UriTooLongError(), req, res)
    if (matched === null) return this.notFound(req, res)
    req.params = matched.params
    const handler = matched.handlers[0]
    try {
      handler(req, res, (err?: unknown) => (err === undefined ? this.notFound(req, res) : this.onError(err, req, res)))
    } catch (err) {
      this.onError(err, req, res)
    }
  }

  private writeHead(res: NodeResponse, contentLength: number, defaultContentType: string, statusCode: number): boolean {
    res.statusCode = statusCode
    if (endWithoutBody(res)) return false
    const framed = !res.hasHeader('Transfer-Encoding')
    if (res.hasHeader('Content-Type')) {
      if (framed) res.writeHead(statusCode, { 'Content-Length': contentLength })
      else res.writeHead(statusCode)
    } else if (framed) res.writeHead(statusCode, { 'Content-Type': defaultContentType, 'Content-Length': contentLength })
    else res.writeHead(statusCode, { 'Content-Type': defaultContentType })
    return true
  }

  replyText(res: NodeResponse, text: string, statusCode: number): void {
    if (this.writeHead(res, Buffer.byteLength(text), 'text/plain; charset=utf-8', statusCode)) res.end(text)
  }

  replyJson(res: NodeResponse, json: string, statusCode: number): void {
    if (this.writeHead(res, Buffer.byteLength(json), 'application/json; charset=utf-8', statusCode)) res.end(json)
  }

  replyBytes(res: NodeResponse, bytes: Uint8Array, statusCode: number): void {
    if (this.writeHead(res, bytes.byteLength, 'application/octet-stream', statusCode)) res.end(bytes)
  }

  replyEmpty(res: NodeResponse, statusCode: number): void {
    res.statusCode = statusCode
    if (!endWithoutBody(res)) res.end()
  }

  private createHttpServer(): Server {
    const server = new AdapterServer(
      (incoming: IncomingMessage, outgoing: ServerResponse) => this.handle(incoming as NodeRequest, outgoing as NodeResponse),
      (error: unknown, req: NodeRequest, res: NodeResponse) => ((error as { code?: unknown } | null)?.code === 'EISDIR' ? this.notFound(req, res) : this.onError(error, req, res))
    )
    this.httpServer = server
    return server
  }

  listen(port: number, hostname: string | undefined, callback: () => void): Server {
    const server = this.httpServer ?? this.createHttpServer()
    if (hostname === undefined) server.listen(port, callback)
    else server.listen(port, hostname, callback)
    return server
  }

  getHttpServer(): Server | undefined {
    return this.httpServer
  }

  close(callback: () => void): void {
    const server = this.httpServer
    if (server === undefined) return callback()
    server.close(() => callback())
  }
}
