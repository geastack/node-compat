// node:assert. The module is the `ok` function itself -- `require('assert')(value,
// message)` is how fastify, find-my-way, avvio and thread-stream call it -- with
// the rest of the API as its properties. Members not written here are the
// generated facade's, which name themselves when called.
export {
  Assert,
  CallTracker,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  partialDeepStrictEqual,
  rejects,
  throws
} from './generated/facades/assert'

export interface AssertionErrorOptions {
  message?: string
  actual?: unknown
  expected?: unknown
  operator?: string
}

export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  actual: unknown
  expected: unknown
  operator: string
  generatedMessage: boolean

  constructor(options: AssertionErrorOptions) {
    super(options.message === undefined ? 'Failed' : options.message)
    this.name = 'AssertionError'
    this.actual = options.actual
    this.expected = options.expected
    this.operator = options.operator === undefined ? 'fail' : options.operator
    this.generatedMessage = options.message === undefined
  }
}

function raise(message: unknown, generated: string, actual: unknown, expected: unknown, operator: string): never {
  if (message instanceof Error) throw message
  const error = new AssertionError({ message: message === undefined ? generated : String(message), actual, expected, operator })
  error.generatedMessage = message === undefined
  throw error
}

// The primitive half of `util.inspect` the comparison messages quote with.
function shown(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

// Node words the falsy case from the call's own source text, which a compiled
// program does not carry; the message says what was asserted instead.
export function ok(...args: unknown[]): void {
  if (args.length === 0) raise(undefined, 'No value argument passed to `assert.ok()`', undefined, true, '==')
  if (!args[0]) raise(args[1], 'The expression evaluated to a falsy value', args[0], true, '==')
}

export function equal(actual: unknown, expected: unknown, message?: unknown): void {
  if (!(actual == expected || (actual !== actual && expected !== expected)))
    raise(message, `${shown(actual)} == ${shown(expected)}`, actual, expected, '==')
}

export function notEqual(actual: unknown, expected: unknown, message?: unknown): void {
  if (actual == expected || (actual !== actual && expected !== expected))
    raise(message, `${shown(actual)} != ${shown(expected)}`, actual, expected, '!=')
}

export function strictEqual(actual: unknown, expected: unknown, message?: unknown): void {
  if (Object.is(actual, expected)) return
  const comparison = `${shown(actual)} !== ${shown(expected)}\n`
  // A stated message keeps the comparison after it, as Node 24 reports it.
  if (typeof message === 'string') raise(`${message}\n\n${comparison}`, '', actual, expected, 'strictEqual')
  raise(message, `Expected values to be strictly equal:\n\n${comparison}`, actual, expected, 'strictEqual')
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: unknown): void {
  if (Object.is(actual, expected))
    raise(message, `Expected "actual" to be strictly unequal to: ${shown(expected)}`, actual, expected, 'notStrictEqual')
}

export function fail(message?: unknown): never {
  return raise(message, 'Failed', undefined, undefined, 'fail')
}

function assert(...args: unknown[]): void {
  ok(...args)
}
assert.ok = ok
assert.equal = equal
assert.notEqual = notEqual
assert.strictEqual = strictEqual
assert.notStrictEqual = notStrictEqual
assert.fail = fail
assert.AssertionError = AssertionError

export { assert as strict }
export default assert
