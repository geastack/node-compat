
const s = 1000
const m = s * 60
const h = m * 60
const d = h * 24
const w = d * 7
const y = d * 365.25

export interface MsOptions {
  long?: boolean
}

const DURATION_REGEXP =
  /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i

function parse(str: string): number | undefined {
  if (str.length > 100) return undefined
  const match = DURATION_REGEXP.exec(str)
  if (match === null) return undefined
  const n = parseFloat(match[1])
  const type = (match[2] || 'ms').toLowerCase()
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y
    case 'weeks':
    case 'week':
    case 'w':
      return n * w
    case 'days':
    case 'day':
    case 'd':
      return n * d
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n
    default:
      return undefined
  }
}

function fmtShort(milliseconds: number): string {
  const msAbs = Math.abs(milliseconds)
  if (msAbs >= d) return Math.round(milliseconds / d) + 'd'
  if (msAbs >= h) return Math.round(milliseconds / h) + 'h'
  if (msAbs >= m) return Math.round(milliseconds / m) + 'm'
  if (msAbs >= s) return Math.round(milliseconds / s) + 's'
  return milliseconds + 'ms'
}

function fmtLong(milliseconds: number): string {
  const msAbs = Math.abs(milliseconds)
  if (msAbs >= d) return plural(milliseconds, msAbs, d, 'day')
  if (msAbs >= h) return plural(milliseconds, msAbs, h, 'hour')
  if (msAbs >= m) return plural(milliseconds, msAbs, m, 'minute')
  if (msAbs >= s) return plural(milliseconds, msAbs, s, 'second')
  return milliseconds + ' ms'
}

function plural(milliseconds: number, msAbs: number, n: number, name: string): string {
  const isPlural = msAbs >= n * 1.5
  return Math.round(milliseconds / n) + ' ' + name + (isPlural ? 's' : '')
}

function ms(value: string, options?: MsOptions): number | undefined
function ms(value: number, options?: MsOptions): string
function ms(value: string | number, options: MsOptions = {}): string | number | undefined {
  if (typeof value === 'string') {
    if (value.length > 0) return parse(value)
  } else if (isFinite(value)) {
    return options.long ? fmtLong(value) : fmtShort(value)
  }
  throw new Error('val is not a non-empty string or a valid number. val=' + JSON.stringify(value))
}

export default ms
