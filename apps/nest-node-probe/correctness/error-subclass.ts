class ParseFailure extends Error {
  status: number
  constructor(status: number, message: string, name = 'Error') {
    super(message)
    this.name = name
    this.status = status
  }
}
function fail(): never {
  throw new ParseFailure(400, 'bad body', 'SyntaxError')
}
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
try {
  fail()
} catch (err) {
  console.log('caught instanceof Error', err instanceof Error)
  console.log('caught instanceof ParseFailure', err instanceof ParseFailure)
  console.log('describe', describe(err))
  console.log('String', String(err))
}
const direct: unknown = new ParseFailure(415, 'unsupported', 'Error')
console.log('direct instanceof Error', direct instanceof Error)
console.log('describe direct', describe(direct))
const plain: unknown = new Error('plain')
console.log('plain describe', describe(plain))
const wrapped: unknown = new TypeError('typed')
console.log('typed describe', describe(wrapped))
