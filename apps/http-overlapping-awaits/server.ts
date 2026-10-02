// Concurrent requests whose handlers await a shared one-slot resource -- the
// shape of a connection pool at its `maxConnecting` limit (the mongodb driver's
// `ConnectionPool.checkOut`). Each handler takes the slot, holds it across a
// timer await, and gives it back.
//
// geatsc completes every `await` by pumping the event loop until the promise
// settles (`gea::detail::waitForPromise`): a handler that awaits stays on the
// C++ stack. If the reactor dispatched the next request from inside that pump,
// the second handler would wait for the slot ON TOP of the first, whose timer
// has fired but whose frame cannot resume until the second returns -- a
// livelock. `scripts/test-http-overlapping-awaits.mjs` drives it.
import { createServer } from 'node:http'
import { env } from 'node:process'

let held = false
const waiters: Array<() => void> = []

function acquire(): Promise<void> {
  if (!held) {
    held = true
    return Promise.resolve()
  }
  return new Promise<void>((resolve): void => {
    waiters.push(resolve)
  })
}

function release(): void {
  const next = waiters.shift()
  if (next !== undefined) next()
  else held = false
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve): void => {
    setTimeout(resolve, ms)
  })
}

let served = 0

const server = createServer(async (req, res) => {
  await acquire()
  await sleep(20)
  release()
  served += 1
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`ok ${req.url ?? '/'} ${served}`)
})

const PORT = Number(env.PORT ?? '3314')
server.listen(PORT, () => {
  console.log(`http-overlapping-awaits listening on http://127.0.0.1:${PORT}`)
})
