import { STATUS_CODES } from 'node:http'

export const message: { [code: string]: string } = {}
export const code: { [message: string]: number } = {}
export const codes: number[] = []

for (const key of Object.keys(STATUS_CODES)) {
  const text = STATUS_CODES[key]
  if (text === undefined) continue
  message[key] = text
  code[text.toLowerCase()] = Number(key)
  codes.push(Number(key))
}

export const redirect: { [code: string]: boolean } = {
  '300': true,
  '301': true,
  '302': true,
  '303': true,
  '305': true,
  '307': true,
  '308': true
}

export const empty: { [code: string]: boolean } = {
  '204': true,
  '205': true,
  '304': true
}

export const retry: { [code: string]: boolean } = {
  '502': true,
  '503': true,
  '504': true
}

export function statusMessage(statusCode: number): string | undefined {
  const key = String(statusCode)
  return Object.hasOwn(message, key) ? message[key] : undefined
}

function getStatusCode(text: string): number {
  const msg = text.toLowerCase()
  if (!Object.hasOwn(code, msg)) throw new Error('invalid status message: "' + text + '"')
  return code[msg]
}

function getStatusMessage(statusCode: number): string {
  const text = statusMessage(statusCode)
  if (text === undefined) throw new Error('invalid status code: ' + statusCode)
  return text
}

export default function status(value: number | string): string | number {
  if (typeof value === 'number') return getStatusMessage(value)
  const n = parseInt(value, 10)
  if (!Number.isNaN(n)) return getStatusMessage(n)
  return getStatusCode(value)
}
