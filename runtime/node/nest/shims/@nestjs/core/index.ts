import { BadRequestException, HttpException, NotFoundException } from '../common/index'
import { NodeAdapter, type NodeRequest, type NodeResponse, UriTooLongError } from '../platform-node/index'
import { BodyParserError } from '../../../platform-node/body-parser/body-parser'
import type { ParsedQuery } from '../../fast-querystring/index'
import { HttpError } from '../../http-errors/index'
import type { Server } from 'node:http'

export interface NestApplicationOptions {
  logger?: boolean
  bodyParser?: boolean
}

export type NestModuleDefinition = (app: NestApplication) => void

export type NestRouteHandler = (req: NodeRequest, res: NodeResponse) => void

const UNKNOWN_EXCEPTION_BODY = '{"statusCode":500,"message":"Internal server error"}'

export class NestApplication {
  private readonly adapter: NodeAdapter
  private readonly logging: boolean
  private readonly bodyParser: boolean

  constructor(adapter: NodeAdapter, options: NestApplicationOptions) {
    this.adapter = adapter
    this.logging = options.logger !== false
    this.bodyParser = options.bodyParser !== false
  }

  init(definition: NestModuleDefinition): void {
    this.adapter.init(
      (req: NodeRequest, res: NodeResponse) => this.fail(res, new NotFoundException(`Cannot ${req.method} ${req.url}`)),
      (error: unknown, req: NodeRequest, res: NodeResponse) => this.fail(res, error),
      this.bodyParser
    )
    definition(this)
  }

  route(method: string, path: string, handler: NestRouteHandler): void {
    this.adapter.route(method, path, handler)
  }

  header(res: NodeResponse, name: string, value: string): void {
    res.setHeader(name, value)
  }

  text(res: NodeResponse, body: string, statusCode: number): void {
    this.adapter.replyText(res, body, statusCode)
  }

  json(res: NodeResponse, json: string, statusCode: number): void {
    this.adapter.replyJson(res, json, statusCode)
  }

  bytes(res: NodeResponse, body: Uint8Array, statusCode: number): void {
    this.adapter.replyBytes(res, body, statusCode)
  }

  empty(res: NodeResponse, statusCode: number): void {
    this.adapter.replyEmpty(res, statusCode)
  }

  param(req: NodeRequest, key: string): string {
    const value = req.params[key]
    if (typeof value === 'string') return value
    throw new Error(`route parameter ${key} is a wildcard`)
  }

  query(req: NodeRequest, key: string): string | string[] | undefined {
    const query: ParsedQuery = req.query
    return key in query ? query[key] : undefined
  }

  fail(res: NodeResponse, raw: unknown): void {
    const error = mapException(raw)
    let statusCode: number
    let body: string
    if (error instanceof HttpException) {
      statusCode = error.getStatus()
      body = error.toJson()
    } else if (error instanceof BodyParserError) {
      statusCode = error.statusCode
      body = httpErrorBody(error.statusCode, error.message)
    } else if (error instanceof HttpError) {
      statusCode = error.statusCode
      body = httpErrorBody(error.statusCode, error.message)
    } else if (error instanceof UriTooLongError) {
      statusCode = error.statusCode
      body = httpErrorBody(error.statusCode, error.message)
    } else {
      statusCode = 500
      body = UNKNOWN_EXCEPTION_BODY
      if (this.logging) console.error(error)
    }
    if (res.headersSent) res.end()
    else this.adapter.replyJson(res, body, statusCode)
  }

  listen(port: number, hostname?: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.adapter.listen(port, hostname, () => resolve())
    })
  }

  getHttpServer(): Server | undefined {
    return this.adapter.getHttpServer()
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.adapter.close(() => resolve())
    })
  }
}

function httpErrorBody(statusCode: number, message: string): string {
  return '{"statusCode":' + String(statusCode) + ',"message":' + JSON.stringify(message) + '}'
}

function mapException(error: unknown): unknown {
  if (error instanceof HttpException) return error
  if (error instanceof SyntaxError || error instanceof URIError) return new BadRequestException(error.message)
  if (error instanceof BodyParserError && error.name === 'SyntaxError') return new BadRequestException(error.message)
  return error
}

export class NestFactoryStatic {
  async create(definition: NestModuleDefinition, adapter: NodeAdapter, options?: NestApplicationOptions): Promise<NestApplication> {
    const app = new NestApplication(adapter, options === undefined ? {} : options)
    app.init(definition)
    return app
  }
}

export const NestFactory = new NestFactoryStatic()
