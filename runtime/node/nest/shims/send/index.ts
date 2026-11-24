import { Buffer } from 'node:buffer'
import { createReadStream, stat, type ReadStream, type Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import encodeUrl from '../encodeurl/index'
import escapeHtml from '../escape-html/index'
import etag from '../etag/index'
import fresh from '../fresh/index'
import createError, { HttpError, type HttpErrorProperties } from '../http-errors/index'
import { contentType } from '../mime-types/index'
import ms from '../ms/index'
import onFinished from '../on-finished/index'
import parseRange, { type Range } from '../range-parser/index'
import { statusMessage } from '../statuses/index'

const BYTES_RANGE_REGEXP = /^ *bytes=/

const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000

const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/

export type DotfilesPolicy = 'allow' | 'deny' | 'ignore'

export interface SendOptions {
  acceptRanges?: boolean
  cacheControl?: boolean
  dotfiles?: DotfilesPolicy
  end?: number
  etag?: boolean
  extensions?: readonly string[] | string | false
  immutable?: boolean
  index?: readonly string[] | string | false
  lastModified?: boolean
  maxAge?: string | number
  root?: string
  start?: number
}

interface SystemError extends Error {
  code?: string | undefined
}

export type DirectoryListener = (res: ServerResponse, path: string) => void
export type EndListener = () => void
export type ErrorListener = (error: HttpError) => void
export type FileListener = (path: string, stats: Stats) => void
export type HeadersListener = (res: ServerResponse, path: string, stats: Stats) => void
export type StreamListener = (stream: ReadStream) => void

export type SendEvent = 'directory' | 'end' | 'error' | 'file' | 'headers' | 'stream'
type SendListener = DirectoryListener | EndListener | ErrorListener | FileListener | HeadersListener | StreamListener

interface Registration<Listener> {
  listener: Listener
  once: boolean
  fired: boolean
}

function fire<Listener>(registrations: Registration<Listener>[], call: (listener: Listener) => void): void {
  for (const registration of registrations.slice()) {
    if (registration.once) {
      if (registration.fired) continue
      registration.fired = true
      const index = registrations.indexOf(registration)
      if (index !== -1) registrations.splice(index, 1)
    }
    call(registration.listener)
  }
}

function unregister<Listener>(registrations: Registration<Listener>[], listener: SendListener): void {
  for (let index = registrations.length - 1; index >= 0; index--) {
    if (registrations[index].listener === listener) {
      registrations.splice(index, 1)
      return
    }
  }
}

export class SendStream {
  readonly req: IncomingMessage
  readonly path: string
  readonly options: SendOptions
  private res: ServerResponse | undefined = undefined

  private readonly acceptRanges: boolean
  private readonly cacheControl: boolean
  private readonly etagEnabled: boolean
  private readonly dotfiles: DotfilesPolicy
  private readonly extensions: string[]
  private readonly immutable: boolean
  private readonly index: string[]
  private readonly lastModified: boolean
  private readonly maxage: number
  private readonly root: string | null

  private readonly directoryListeners: Registration<DirectoryListener>[] = []
  private readonly endListeners: Registration<EndListener>[] = []
  private readonly errorListeners: Registration<ErrorListener>[] = []
  private readonly fileListeners: Registration<FileListener>[] = []
  private readonly headersListeners: Registration<HeadersListener>[] = []
  private readonly streamListeners: Registration<StreamListener>[] = []

  constructor(req: IncomingMessage, path: string, options: SendOptions = {}) {
    this.options = options
    this.path = path
    this.req = req

    this.acceptRanges = options.acceptRanges !== undefined ? options.acceptRanges : true
    this.cacheControl = options.cacheControl !== undefined ? options.cacheControl : true
    this.etagEnabled = options.etag !== undefined ? options.etag : true
    this.dotfiles = options.dotfiles !== undefined ? options.dotfiles : 'ignore'
    if (this.dotfiles !== 'ignore' && this.dotfiles !== 'allow' && this.dotfiles !== 'deny') {
      throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"')
    }
    this.extensions = normalizeList(options.extensions, [], 'extensions option')
    this.immutable = options.immutable !== undefined ? options.immutable : false
    this.index = normalizeList(options.index, ['index.html'], 'index option')
    this.lastModified = options.lastModified !== undefined ? options.lastModified : true

    const maxAge = options.maxAge
    let maxage: number
    if (typeof maxAge === 'string') maxage = maxAge === '' ? NaN : (ms(maxAge) ?? NaN)
    else maxage = maxAge === undefined ? NaN : maxAge
    this.maxage = Number.isNaN(maxage) ? 0 : Math.min(Math.max(0, maxage), MAX_MAXAGE)

    this.root = options.root !== undefined && options.root !== '' ? resolve(options.root) : null
  }

  on(event: 'directory', listener: DirectoryListener): this
  on(event: 'end', listener: EndListener): this
  on(event: 'error', listener: ErrorListener): this
  on(event: 'file', listener: FileListener): this
  on(event: 'headers', listener: HeadersListener): this
  on(event: 'stream', listener: StreamListener): this
  on(event: SendEvent, listener: SendListener): this {
    return this.register(event, listener, false)
  }

  once(event: 'directory', listener: DirectoryListener): this
  once(event: 'end', listener: EndListener): this
  once(event: 'error', listener: ErrorListener): this
  once(event: 'file', listener: FileListener): this
  once(event: 'headers', listener: HeadersListener): this
  once(event: 'stream', listener: StreamListener): this
  once(event: SendEvent, listener: SendListener): this {
    return this.register(event, listener, true)
  }

  off(event: SendEvent, listener: SendListener): this {
    switch (event) {
      case 'directory':
        unregister(this.directoryListeners, listener)
        break
      case 'end':
        unregister(this.endListeners, listener)
        break
      case 'error':
        unregister(this.errorListeners, listener)
        break
      case 'file':
        unregister(this.fileListeners, listener)
        break
      case 'headers':
        unregister(this.headersListeners, listener)
        break
      case 'stream':
        unregister(this.streamListeners, listener)
        break
    }
    return this
  }

  removeListener(event: SendEvent, listener: SendListener): this {
    return this.off(event, listener)
  }

  private register(event: SendEvent, listener: SendListener, once: boolean): this {
    switch (event) {
      case 'directory':
        this.directoryListeners.push({ listener: listener as DirectoryListener, once, fired: false })
        break
      case 'end':
        this.endListeners.push({ listener: listener as EndListener, once, fired: false })
        break
      case 'error':
        this.errorListeners.push({ listener: listener as ErrorListener, once, fired: false })
        break
      case 'file':
        this.fileListeners.push({ listener: listener as FileListener, once, fired: false })
        break
      case 'headers':
        this.headersListeners.push({ listener: listener as HeadersListener, once, fired: false })
        break
      case 'stream':
        this.streamListeners.push({ listener: listener as StreamListener, once, fired: false })
        break
    }
    return this
  }

  pipe(res: ServerResponse): ServerResponse {
    const root = this.root
    this.res = res

    const decoded = decodePath(this.path)
    if (decoded === null) {
      this.fail(400)
      return res
    }

    if (decoded.indexOf('\0') !== -1) {
      this.fail(400)
      return res
    }

    let path = decoded
    let parts: string[]
    if (root !== null) {
      if (path !== '') path = normalize('.' + sep + path)

      if (UP_PATH_REGEXP.test(path)) {
        this.fail(403)
        return res
      }

      parts = path.split(sep)

      path = normalize(join(root, path))
    } else {
      if (UP_PATH_REGEXP.test(path)) {
        this.fail(403)
        return res
      }

      parts = normalize(path).split(sep)

      path = resolve(path)
    }

    if (containsDotFile(parts)) {
      switch (this.dotfiles) {
        case 'allow':
          break
        case 'deny':
          this.fail(403)
          return res
        case 'ignore':
          this.fail(404)
          return res
      }
    }

    if (this.index.length > 0 && this.hasTrailingSlash()) {
      this.sendIndex(path, 0, null)
      return res
    }

    this.sendFile(path)
    return res
  }

  private response(): ServerResponse {
    if (this.res === undefined) throw new Error('send: the stream has not been piped to a response')
    return this.res
  }

  private fail(status: number, cause?: Error, properties?: HttpErrorProperties): void {
    if (this.errorListeners.length > 0) {
      const error =
        cause !== undefined
          ? createError(status, cause, { expose: false })
          : properties !== undefined
            ? createError(status, properties)
            : createError(status)
      fire(this.errorListeners, (listener) => listener(error))
      return
    }

    const res = this.response()
    const msg = statusMessage(status) ?? String(status)
    const doc = createHtmlDocument('Error', escapeHtml(msg))

    for (const name of res.getHeaderNames()) res.removeHeader(name)

    const headers = properties !== undefined ? properties.headers : cause instanceof HttpError ? cause.headers : undefined
    if (headers !== undefined) {
      for (const name of Object.keys(headers)) res.setHeader(name, headers[name])
    }

    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=UTF-8')
    res.setHeader('Content-Length', Buffer.byteLength(doc))
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(doc)
  }

  private hasTrailingSlash(): boolean {
    return this.path.endsWith('/')
  }

  private isConditionalGET(): boolean {
    const headers = this.req.headers
    return Boolean(headers['if-match'] || headers['if-unmodified-since'] || headers['if-none-match'] || headers['if-modified-since'])
  }

  private isPreconditionFailure(): boolean {
    const req = this.req
    const res = this.response()

    const match = req.headers['if-match']
    if (match) {
      const etagValue = headerText(res.getHeader('ETag'))
      return (
        etagValue === '' ||
        (match !== '*' &&
          parseTokenList(match).every((token) => token !== etagValue && token !== 'W/' + etagValue && 'W/' + token !== etagValue))
      )
    }

    const unmodifiedSince = parseHttpDate(headerText(req.headers['if-unmodified-since']))
    if (!Number.isNaN(unmodifiedSince)) {
      const lastModified = parseHttpDate(headerText(res.getHeader('Last-Modified')))
      return Number.isNaN(lastModified) || lastModified > unmodifiedSince
    }

    return false
  }

  private removeContentHeaderFields(): void {
    const res = this.response()
    res.removeHeader('Content-Encoding')
    res.removeHeader('Content-Language')
    res.removeHeader('Content-Length')
    res.removeHeader('Content-Range')
    res.removeHeader('Content-Type')
  }

  private notModified(): void {
    const res = this.response()
    this.removeContentHeaderFields()
    res.statusCode = 304
    res.end()
  }

  private headersAlreadySent(): void {
    this.fail(500, new Error("Can't set headers after they are sent."))
  }

  private isCachable(): boolean {
    const statusCode = this.response().statusCode
    return (statusCode >= 200 && statusCode < 300) || statusCode === 304
  }

  private onStatError(error: SystemError): void {
    switch (error.code) {
      case 'ENAMETOOLONG':
      case 'ENOENT':
      case 'ENOTDIR':
        this.fail(404, error)
        break
      default:
        this.fail(500, error)
        break
    }
  }

  private isFresh(): boolean {
    const res = this.response()
    const headers = this.req.headers
    return fresh({
      'if-modified-since': headerText(headers['if-modified-since']),
      'if-none-match': headerText(headers['if-none-match']),
      'cache-control': headerText(headers['cache-control'])
    }, {
      etag: headerText(res.getHeader('ETag')),
      'last-modified': headerText(res.getHeader('Last-Modified'))
    })
  }

  private isRangeFresh(): boolean {
    const ifRange = headerText(this.req.headers['if-range'])
    if (ifRange === '') return true

    if (ifRange.indexOf('"') !== -1) {
      const etagValue = headerText(this.response().getHeader('ETag'))
      return etagValue !== '' && ifRange.indexOf(etagValue) !== -1
    }

    const lastModified = headerText(this.response().getHeader('Last-Modified'))
    return parseHttpDate(lastModified) <= parseHttpDate(ifRange)
  }

  private redirect(path: string): void {
    const res = this.response()

    if (this.directoryListeners.length > 0) {
      fire(this.directoryListeners, (listener) => listener(res, path))
      return
    }

    if (this.hasTrailingSlash()) {
      this.fail(403)
      return
    }

    const loc = encodeUrl(collapseLeadingSlashes(this.path + '/'))
    const doc = createHtmlDocument('Redirecting', 'Redirecting to ' + escapeHtml(loc))

    res.statusCode = 301
    res.setHeader('Content-Type', 'text/html; charset=UTF-8')
    res.setHeader('Content-Length', Buffer.byteLength(doc))
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Location', loc)
    res.end(doc)
  }

  private send(path: string, stats: Stats): void {
    const res = this.response()
    const req = this.req
    const options = this.options
    let len = stats.size
    let offset = options.start ?? 0
    const rangeHeader = req.headers.range

    if (res.headersSent) {
      this.headersAlreadySent()
      return
    }

    this.writeHeaders(path, stats)

    this.type(path)

    if (this.isConditionalGET()) {
      if (this.isPreconditionFailure()) {
        this.fail(412)
        return
      }

      if (this.isCachable() && this.isFresh()) {
        this.notModified()
        return
      }
    }

    len = Math.max(0, len - offset)
    if (options.end !== undefined) {
      const bytes = options.end - offset + 1
      if (len > bytes) len = bytes
    }

    if (this.acceptRanges && rangeHeader !== undefined && BYTES_RANGE_REGEXP.test(rangeHeader)) {
      let ranges = parseRange(len, rangeHeader, { combine: true })

      if (!this.isRangeFresh()) ranges = -2

      if (ranges === -1) {
        res.setHeader('Content-Range', contentRange('bytes', len))

        this.fail(416, undefined, { headers: { 'Content-Range': headerText(res.getHeader('Content-Range')) } })
        return
      }

      if (typeof ranges !== 'number' && ranges.ranges.length === 1) {
        const range = ranges.ranges[0]

        res.statusCode = 206
        res.setHeader('Content-Range', contentRange('bytes', len, range))

        offset += range.start
        len = range.end - range.start + 1
      }
    }

    res.setHeader('Content-Length', len)

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    this.stream(path, offset, Math.max(offset, offset + len - 1))
  }

  private sendFile(path: string): void {
    stat(path, (err, stats) => {
      const pathEndsWithSep = path.endsWith(sep)
      if (err !== null) {
        if (err.code === 'ENOENT' && extname(path) === '' && !pathEndsWithSep) {
          this.sendWithExtension(path, 0, err)
          return
        }
        this.onStatError(err)
        return
      }
      if (stats === undefined) return
      if (stats.isDirectory()) {
        this.redirect(path)
        return
      }
      if (pathEndsWithSep) {
        this.fail(404)
        return
      }
      this.emitFile(path, stats)
      this.send(path, stats)
    })
  }

  private sendWithExtension(path: string, index: number, error: SystemError | null): void {
    if (index >= this.extensions.length) {
      if (error !== null) this.onStatError(error)
      else this.fail(404)
      return
    }

    const candidate = path + '.' + this.extensions[index]
    stat(candidate, (err, stats) => {
      if (err !== null) {
        this.sendWithExtension(path, index + 1, err)
        return
      }
      if (stats === undefined || stats.isDirectory()) {
        this.sendWithExtension(path, index + 1, null)
        return
      }
      this.emitFile(candidate, stats)
      this.send(candidate, stats)
    })
  }

  private sendIndex(path: string, index: number, error: SystemError | null): void {
    if (index >= this.index.length) {
      if (error !== null) this.onStatError(error)
      else this.fail(404)
      return
    }

    const candidate = join(path, this.index[index])
    stat(candidate, (err, stats) => {
      if (err !== null) {
        this.sendIndex(path, index + 1, err)
        return
      }
      if (stats === undefined || stats.isDirectory()) {
        this.sendIndex(path, index + 1, null)
        return
      }
      this.emitFile(candidate, stats)
      this.send(candidate, stats)
    })
  }

  private emitFile(path: string, stats: Stats): void {
    fire(this.fileListeners, (listener) => listener(path, stats))
  }

  private stream(path: string, start: number, end: number): void {
    const res = this.response()

    const stream = createReadStream(path, { start, end })
    fire(this.streamListeners, (listener) => listener(stream))
    stream.pipe(res)

    const cleanup = () => {
      stream.destroy()
    }

    onFinished(res, cleanup)

    stream.on('error', (error: Error) => {
      cleanup()

      this.onStatError(error)
    })

    stream.on('end', () => {
      fire(this.endListeners, (listener) => listener())
    })
  }

  private type(path: string): void {
    const res = this.response()
    if (headerText(res.getHeader('Content-Type')) !== '') return
    const type = contentType(extname(path))
    res.setHeader('Content-Type', type === false ? 'application/octet-stream' : type)
  }

  private writeHeaders(path: string, stats: Stats): void {
    const res = this.response()

    fire(this.headersListeners, (listener) => listener(res, path, stats))

    if (this.acceptRanges && headerText(res.getHeader('Accept-Ranges')) === '') {
      res.setHeader('Accept-Ranges', 'bytes')
    }

    if (this.cacheControl && headerText(res.getHeader('Cache-Control')) === '') {
      let cacheControl = 'public, max-age=' + Math.floor(this.maxage / 1000)
      if (this.immutable) cacheControl += ', immutable'
      res.setHeader('Cache-Control', cacheControl)
    }

    if (this.lastModified && headerText(res.getHeader('Last-Modified')) === '') {
      res.setHeader('Last-Modified', stats.mtime.toUTCString())
    }

    if (this.etagEnabled && headerText(res.getHeader('ETag')) === '') {
      res.setHeader('ETag', etag(stats))
    }
  }
}

function collapseLeadingSlashes(str: string): string {
  let i = 0
  for (; i < str.length; i++) {
    if (str[i] !== '/') break
  }
  return i > 1 ? '/' + str.slice(i) : str
}

function containsDotFile(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.length > 1 && part.startsWith('.')) return true
  }
  return false
}

function contentRange(type: string, size: number, range?: Range): string {
  return type + ' ' + (range !== undefined ? range.start + '-' + range.end : '*') + '/' + size
}

function createHtmlDocument(title: string, body: string): string {
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>' +
    title +
    '</title>\n' +
    '</head>\n' +
    '<body>\n' +
    '<pre>' +
    body +
    '</pre>\n' +
    '</body>\n' +
    '</html>\n'
  )
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path)
  } catch {
    return null
  }
}

function headerText(value: string | number | readonly string[] | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return value.join(', ')
}

function normalizeList(value: readonly string[] | string | false | undefined, fallback: string[], name: string): string[] {
  if (value === undefined) return fallback
  if (!value) return []
  const list: readonly unknown[] = Array.isArray(value) ? value : [value]
  const strings: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') throw new TypeError(`${name} must be array of strings or false`)
    strings.push(item)
  }
  return strings
}

function parseHttpDate(date: string): number {
  if (date === '') return NaN
  return Date.parse(date)
}

function parseTokenList(str: string): string[] {
  let end = 0
  const list: string[] = []
  let start = 0

  for (let i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20:
        if (start === end) start = end = i + 1
        break
      case 0x2c:
        if (start !== end) list.push(str.substring(start, end))
        start = end = i + 1
        break
      default:
        end = i + 1
        break
    }
  }

  if (start !== end) list.push(str.substring(start, end))
  return list
}

function send(req: IncomingMessage, path: string, options?: SendOptions): SendStream {
  return new SendStream(req, path, options)
}

type SendOptionsShape = SendOptions
type SendStreamInstance = SendStream

namespace send {
  export type SendOptions = SendOptionsShape
  export type SendStream = SendStreamInstance
}

export default send
