// Share the same WHATWG classes between global URLs, node:url and the
// connection-string parser. The generated inventory facade has no implementation.
export { URL, URLSearchParams } from './whatwg-url'

// Preserve explicit failures for the Node URL APIs not implemented by this target.
export {
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  format,
  parse,
  pathToFileURL,
  resolve,
  URLPattern,
  urlToHttpOptions
} from './generated/facades/url'
