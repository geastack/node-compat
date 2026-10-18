import { statusMessage } from '../statuses/index'

export interface HttpErrorHeaders {
  [name: string]: string
}

export interface HttpErrorProperties {
  expose?: boolean
  headers?: HttpErrorHeaders
}

export class HttpError extends Error {
  status: number
  statusCode: number
  expose: boolean
  headers: HttpErrorHeaders | undefined
  code: string | undefined
  syscall: string | undefined
  errno: number | undefined
  path: string | undefined
  original: Error | undefined

  constructor(status: number, message: string, name: string, expose: boolean) {
    super(message)
    this.name = name
    this.status = status
    this.statusCode = status
    this.expose = expose
    this.headers = undefined
    this.code = undefined
    this.syscall = undefined
    this.errno = undefined
    this.path = undefined
    this.original = undefined
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError
}

function codeClass(status: number): number {
  return Number(String(status).charAt(0) + '00')
}

function toIdentifier(str: string): string {
  return str
    .split(' ')
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join('')
    .replace(/[^ _0-9a-z]/gi, '')
}

function toClassName(name: string): string {
  return name.slice(-5) === 'Error' ? name : name + 'Error'
}

function hasConstructor(status: number): boolean {
  const cls = codeClass(status)
  return (cls === 400 || cls === 500) && statusMessage(status) !== undefined
}

function constructorStatus(status: number): number | undefined {
  if (hasConstructor(status)) return status
  const cls = codeClass(status)
  return hasConstructor(cls) ? cls : undefined
}

type CreateErrorArgument = number | string | Error | HttpErrorProperties

class CreateErrorArguments {
  error: Error | undefined = undefined
  message: string | undefined = undefined
  status = 500
  properties: HttpErrorProperties = {}

  consume(argument: CreateErrorArgument | undefined, index: number): void {
    if (argument === undefined) return
    if (typeof argument === 'number') {
      if (index !== 0) throw new TypeError('argument #' + (index + 1) + ' unsupported type number')
      this.status = argument
    } else if (typeof argument === 'string') {
      this.message = argument
    } else if (argument instanceof Error) {
      this.error = argument
      if (argument instanceof HttpError) this.status = argument.status || argument.statusCode || this.status
    } else {
      this.properties = argument
    }
  }
}

function wrapError(original: Error, status: number): HttpError {
  const wrapped = new HttpError(status, original.message, original.name, status < 500)
  wrapped.original = original
  if (original instanceof HttpError) {
    wrapped.headers = original.headers
    wrapped.code = original.code
    wrapped.syscall = original.syscall
    wrapped.errno = original.errno
    wrapped.path = original.path
    wrapped.original = original.original ?? original
    return wrapped
  }
  if ('code' in original && typeof original.code === 'string') wrapped.code = original.code
  if ('syscall' in original && typeof original.syscall === 'string') wrapped.syscall = original.syscall
  if ('errno' in original && typeof original.errno === 'number') wrapped.errno = original.errno
  if ('path' in original && typeof original.path === 'string') wrapped.path = original.path
  return wrapped
}

function createError(): HttpError
function createError(status: number, message?: string, properties?: HttpErrorProperties): HttpError
function createError(status: number, properties: HttpErrorProperties): HttpError
function createError(status: number, error: Error, properties?: HttpErrorProperties): HttpError
function createError(error: Error, properties?: HttpErrorProperties): HttpError
function createError(message: string, properties?: HttpErrorProperties): HttpError
function createError(properties: HttpErrorProperties): HttpError
function createError(first?: CreateErrorArgument, second?: CreateErrorArgument, third?: HttpErrorProperties): HttpError {
  const args = new CreateErrorArguments()
  args.consume(first, 0)
  args.consume(second, 1)
  args.consume(third, 2)

  let status = args.status
  if (statusMessage(status) === undefined && (status < 400 || status >= 600)) status = 500

  const ctor = constructorStatus(status)
  let error: HttpError
  if (args.error === undefined) {
    let message: string
    let name: string
    if (ctor !== undefined) {
      message = args.message !== undefined ? args.message : (statusMessage(ctor) ?? '')
      name = toClassName(toIdentifier(statusMessage(ctor) ?? ''))
    } else {
      message = args.message || statusMessage(status) || ''
      name = 'Error'
    }
    error = new HttpError(status, message, name, status < 500)
  } else if (args.error instanceof HttpError && args.error.status === status) {
    error = args.error
  } else {
    error = wrapError(args.error, status)
  }

  const properties = args.properties
  if (properties.expose !== undefined) error.expose = properties.expose
  if (properties.headers !== undefined) error.headers = properties.headers
  return error
}

export default createError
