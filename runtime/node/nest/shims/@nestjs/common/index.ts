

export type ClassDecoratorLike = (target: unknown) => void
export type MethodDecoratorLike = (target: unknown, propertyKey: string, descriptor: unknown) => void
export type ParameterDecoratorLike = (target: unknown, propertyKey: string | undefined, parameterIndex: number) => void

export interface ControllerOptions {
  path?: string | string[]
  host?: string | string[]
}

export interface ModuleMetadata {
  imports?: unknown[]
  controllers?: unknown[]
  providers?: unknown[]
  exports?: unknown[]
}

export interface InjectableOptions {
  scope?: number
}

const classDecorator: ClassDecoratorLike = () => {}
const methodDecorator: MethodDecoratorLike = () => {}
const parameterDecorator: ParameterDecoratorLike = () => {}

export function Controller(prefixOrOptions?: string | string[] | ControllerOptions): ClassDecoratorLike {
  return classDecorator
}
export function Module(metadata: ModuleMetadata): ClassDecoratorLike {
  return classDecorator
}
export function Injectable(options?: InjectableOptions): ClassDecoratorLike {
  return classDecorator
}

export function Get(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Post(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Put(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Delete(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Patch(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Options(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Head(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function All(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Search(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Propfind(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Proppatch(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Mkcol(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Copy(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Move(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Lock(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function Unlock(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function QueryMethod(path?: string | string[]): MethodDecoratorLike {
  return methodDecorator
}
export function HttpCode(statusCode: number): MethodDecoratorLike {
  return methodDecorator
}
export function Header(name: string, value: string): MethodDecoratorLike {
  return methodDecorator
}

export function Param(property?: string): ParameterDecoratorLike {
  return parameterDecorator
}
export function Query(property?: string): ParameterDecoratorLike {
  return parameterDecorator
}
export function Body(property?: string): ParameterDecoratorLike {
  return parameterDecorator
}
export function Headers(property?: string): ParameterDecoratorLike {
  return parameterDecorator
}
export function Req(): ParameterDecoratorLike {
  return parameterDecorator
}
export function Request(): ParameterDecoratorLike {
  return parameterDecorator
}
export function Res(): ParameterDecoratorLike {
  return parameterDecorator
}
export function Response(): ParameterDecoratorLike {
  return parameterDecorator
}

export enum HttpStatus {
  CONTINUE = 100,
  SWITCHING_PROTOCOLS = 101,
  PROCESSING = 102,
  EARLYHINTS = 103,
  OK = 200,
  CREATED = 201,
  ACCEPTED = 202,
  NON_AUTHORITATIVE_INFORMATION = 203,
  NO_CONTENT = 204,
  RESET_CONTENT = 205,
  PARTIAL_CONTENT = 206,
  MULTI_STATUS = 207,
  ALREADY_REPORTED = 208,
  CONTENT_DIFFERENT = 210,
  AMBIGUOUS = 300,
  MOVED_PERMANENTLY = 301,
  FOUND = 302,
  SEE_OTHER = 303,
  NOT_MODIFIED = 304,
  TEMPORARY_REDIRECT = 307,
  PERMANENT_REDIRECT = 308,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  PAYMENT_REQUIRED = 402,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  NOT_ACCEPTABLE = 406,
  PROXY_AUTHENTICATION_REQUIRED = 407,
  REQUEST_TIMEOUT = 408,
  CONFLICT = 409,
  GONE = 410,
  LENGTH_REQUIRED = 411,
  PRECONDITION_FAILED = 412,
  PAYLOAD_TOO_LARGE = 413,
  URI_TOO_LONG = 414,
  UNSUPPORTED_MEDIA_TYPE = 415,
  REQUESTED_RANGE_NOT_SATISFIABLE = 416,
  EXPECTATION_FAILED = 417,
  I_AM_A_TEAPOT = 418,
  MISDIRECTED = 421,
  UNPROCESSABLE_ENTITY = 422,
  LOCKED = 423,
  FAILED_DEPENDENCY = 424,
  PRECONDITION_REQUIRED = 428,
  TOO_MANY_REQUESTS = 429,
  UNRECOVERABLE_ERROR = 456,
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504,
  HTTP_VERSION_NOT_SUPPORTED = 505,
  INSUFFICIENT_STORAGE = 507,
  LOOP_DETECTED = 508
}

export interface HttpExceptionOptions {
  cause?: unknown
  description?: string
  errorCode?: string
}

export class HttpExceptionBody {
  message: string
  error: string | undefined
  statusCode: number
  errorCode: string | undefined

  constructor(message: string, error: string | undefined, statusCode: number, errorCode: string | undefined) {
    this.message = message
    this.error = error
    this.statusCode = statusCode
    this.errorCode = errorCode
  }

  toJson(): string {
    let json = '{"message":' + JSON.stringify(this.message)
    if (this.error !== undefined) json += ',"error":' + JSON.stringify(this.error)
    json += ',"statusCode":' + String(this.statusCode)
    if (this.errorCode !== undefined) json += ',"errorCode":' + JSON.stringify(this.errorCode)
    return json + '}'
  }
}

export type HttpExceptionResponse = string | HttpExceptionBody

export class IntrinsicException extends Error {}

export class HttpException extends IntrinsicException {
  private readonly response: HttpExceptionResponse
  private readonly status: number
  errorCode: string | undefined

  constructor(response: HttpExceptionResponse, status: number, options?: HttpExceptionOptions) {
    super(typeof response === 'string' ? response : response.message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.response = response
    this.status = status
    this.errorCode = options?.errorCode
    this.name = 'HttpException'
  }

  getResponse(): HttpExceptionResponse {
    return this.response
  }

  getStatus(): number {
    return this.status
  }

  toJson(): string {
    const response = this.response
    if (typeof response === 'string') {
      let json = '{"statusCode":' + String(this.status) + ',"message":' + JSON.stringify(response)
      if (this.errorCode !== undefined) json += ',"errorCode":' + JSON.stringify(this.errorCode)
      return json + '}'
    }
    return response.toJson()
  }

  static createBody(objectOrError: HttpExceptionResponse | undefined, description: string, statusCode: number, errorCode: string | undefined): HttpExceptionBody {
    if (objectOrError === undefined || objectOrError === '') return new HttpExceptionBody(description, undefined, statusCode, errorCode)
    if (typeof objectOrError === 'string') return new HttpExceptionBody(objectOrError, description, statusCode, errorCode)
    return objectOrError
  }

  static getDescriptionFrom(descriptionOrOptions: string | HttpExceptionOptions, fallback: string): string {
    if (typeof descriptionOrOptions === 'string') return descriptionOrOptions
    return descriptionOrOptions.description ?? fallback
  }

  static getHttpExceptionOptionsFrom(descriptionOrOptions: string | HttpExceptionOptions): HttpExceptionOptions {
    return typeof descriptionOrOptions === 'string' ? {} : descriptionOrOptions
  }
}

function defaultException(objectOrError: HttpExceptionResponse | undefined, descriptionOrOptions: string | HttpExceptionOptions, fallback: string, status: number): [HttpExceptionBody, HttpExceptionOptions] {
  const description = HttpException.getDescriptionFrom(descriptionOrOptions, fallback)
  const options = HttpException.getHttpExceptionOptionsFrom(descriptionOrOptions)
  return [HttpException.createBody(objectOrError, description, status, options.errorCode), options]
}

export class BadRequestException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Bad Request') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Bad Request', HttpStatus.BAD_REQUEST)
    super(body, HttpStatus.BAD_REQUEST, options)
    this.name = 'BadRequestException'
  }
}

export class UnauthorizedException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Unauthorized') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Unauthorized', HttpStatus.UNAUTHORIZED)
    super(body, HttpStatus.UNAUTHORIZED, options)
    this.name = 'UnauthorizedException'
  }
}

export class ForbiddenException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Forbidden') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Forbidden', HttpStatus.FORBIDDEN)
    super(body, HttpStatus.FORBIDDEN, options)
    this.name = 'ForbiddenException'
  }
}

export class NotFoundException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Not Found') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Not Found', HttpStatus.NOT_FOUND)
    super(body, HttpStatus.NOT_FOUND, options)
    this.name = 'NotFoundException'
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Method Not Allowed') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Method Not Allowed', HttpStatus.METHOD_NOT_ALLOWED)
    super(body, HttpStatus.METHOD_NOT_ALLOWED, options)
    this.name = 'MethodNotAllowedException'
  }
}

export class ConflictException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Conflict') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Conflict', HttpStatus.CONFLICT)
    super(body, HttpStatus.CONFLICT, options)
    this.name = 'ConflictException'
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Payload Too Large') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Payload Too Large', HttpStatus.PAYLOAD_TOO_LARGE)
    super(body, HttpStatus.PAYLOAD_TOO_LARGE, options)
    this.name = 'PayloadTooLargeException'
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Unsupported Media Type') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Unsupported Media Type', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    super(body, HttpStatus.UNSUPPORTED_MEDIA_TYPE, options)
    this.name = 'UnsupportedMediaTypeException'
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Unprocessable Entity') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Unprocessable Entity', HttpStatus.UNPROCESSABLE_ENTITY)
    super(body, HttpStatus.UNPROCESSABLE_ENTITY, options)
    this.name = 'UnprocessableEntityException'
  }
}

export class InternalServerErrorException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Internal Server Error') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR)
    super(body, HttpStatus.INTERNAL_SERVER_ERROR, options)
    this.name = 'InternalServerErrorException'
  }
}

export class NotImplementedException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Not Implemented') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Not Implemented', HttpStatus.NOT_IMPLEMENTED)
    super(body, HttpStatus.NOT_IMPLEMENTED, options)
    this.name = 'NotImplementedException'
  }
}

export class BadGatewayException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Bad Gateway') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Bad Gateway', HttpStatus.BAD_GATEWAY)
    super(body, HttpStatus.BAD_GATEWAY, options)
    this.name = 'BadGatewayException'
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Service Unavailable') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Service Unavailable', HttpStatus.SERVICE_UNAVAILABLE)
    super(body, HttpStatus.SERVICE_UNAVAILABLE, options)
    this.name = 'ServiceUnavailableException'
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(objectOrError?: HttpExceptionResponse, descriptionOrOptions: string | HttpExceptionOptions = 'Gateway Timeout') {
    const [body, options] = defaultException(objectOrError, descriptionOrOptions, 'Gateway Timeout', HttpStatus.GATEWAY_TIMEOUT)
    super(body, HttpStatus.GATEWAY_TIMEOUT, options)
    this.name = 'GatewayTimeoutException'
  }
}
