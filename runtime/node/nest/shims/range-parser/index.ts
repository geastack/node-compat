
export interface Range {
  start: number
  end: number
}

export interface Ranges {
  type: string
  ranges: Range[]
}

export interface RangeParserOptions {
  combine?: boolean
}

export const UNSATISFIABLE = -1
export const MALFORMED = -2

interface IndexedRange {
  start: number
  end: number
  index: number
}

export default function parseRange(size: number, str: string, options?: RangeParserOptions): Ranges | -1 | -2 {
  const index = str.indexOf('=')
  if (index === -1) return -2

  const arr = str.slice(index + 1).split(',')
  const ranges: Range[] = []
  const type = str.slice(0, index)

  for (let i = 0; i < arr.length; i++) {
    const indexOf = arr[i].indexOf('-')
    if (indexOf === -1) return -2

    const startStr = arr[i].slice(0, indexOf).trim()
    const endStr = arr[i].slice(indexOf + 1).trim()

    let start = parsePos(startStr)
    let end = parsePos(endStr)

    if (startStr.length === 0) {
      start = size - end
      end = size - 1
    } else if (endStr.length === 0) {
      end = size - 1
    }

    if (end > size - 1) end = size - 1

    if (Number.isNaN(start) || Number.isNaN(end)) return -2

    if (start > end || start < 0) continue

    ranges.push({ start, end })
  }

  if (ranges.length < 1) return -1

  return { type, ranges: options !== undefined && options.combine === true ? combineRanges(ranges) : ranges }
}

function parsePos(str: string): number {
  if (/^\d+$/.test(str)) return Number(str)
  return NaN
}

function combineRanges(ranges: Range[]): Range[] {
  const ordered: IndexedRange[] = ranges.map((range, index) => ({ start: range.start, end: range.end, index })).sort(sortByRangeStart)

  let j = 0
  for (let i = 1; i < ordered.length; i++) {
    const range = ordered[i]
    const current = ordered[j]

    if (range.start > current.end + 1) {
      ordered[++j] = range
    } else if (range.end > current.end) {
      current.end = range.end
      current.index = Math.min(current.index, range.index)
    }
  }

  ordered.length = j + 1

  return ordered.sort(sortByRangeIndex).map((range) => ({ start: range.start, end: range.end }))
}

function sortByRangeIndex(a: IndexedRange, b: IndexedRange): number {
  return a.index - b.index
}

function sortByRangeStart(a: IndexedRange, b: IndexedRange): number {
  return a.start - b.start
}
