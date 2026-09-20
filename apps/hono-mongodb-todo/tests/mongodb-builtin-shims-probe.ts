import { Buffer } from 'buffer'
import { get } from 'http'
import { stderr } from 'process'
import { setTimeout as delay } from 'timers/promises'
import { inspect } from 'util'
import { inflate } from 'zlib'

async function runBuiltinShimProbe(): Promise<void> {
  let promiseTimerFailedLoudly = false
  try {
    await delay(1)
  } catch (error) {
    promiseTimerFailedLoudly =
      error instanceof Error && error.message.includes('Promise continuation support')
  }
  if (!promiseTimerFailedLoudly) {
    throw new Error('timers/promises unsupported path was silent')
  }

  let writeCallbackRan = false
  stderr.write('', 'utf8', error => {
    if (error) throw error
    writeCallbackRan = true
  })
  if (!writeCallbackRan) throw new Error('WriteStream callback did not run')

  if (inspect('logger-value', { compact: true, breakLength: Infinity }) !== 'logger-value') {
    throw new Error('util.inspect did not return a native string')
  }

  const payload = Buffer.from('abc')
  let zlibFailedLoudly = false
  try {
    inflate(payload, (error, result) => {
      if (error === null && result.length === payload.length) return
    })
  } catch (error) {
    zlibFailedLoudly = error instanceof Error && error.message.includes('not supported')
  }
  if (!zlibFailedLoudly) throw new Error('zlib unsupported path was silent')

  let httpFailedLoudly = false
  try {
    get('http://127.0.0.1/', {}, response => {
      response.setEncoding('utf8')
      response.on('data', chunk => {
        if (chunk.length < 0) throw new Error('unreachable')
      })
    })
  } catch (error) {
    httpFailedLoudly = error instanceof Error && error.message.includes('not supported')
  }
  if (!httpFailedLoudly) throw new Error('http client unsupported path was silent')

  console.log('mongodb-builtin-shims-ok')
}

void runBuiltinShimProbe()
