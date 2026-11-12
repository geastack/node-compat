import http from 'node:http'
import { once } from 'node:events'

const sequence = async (mod, assert) => {
  const onFinished = mod.default ?? mod
  const log = []
  const server = http.createServer((req, res) => {
    log.push(['req isFinished at start', mod.isFinished(req)])
    log.push(['res isFinished at start', mod.isFinished(res)])
    onFinished(res, (err, msg) => log.push(['res listener 1', err, msg === res]))
    onFinished(res, (err, msg) => log.push(['res listener 2', err, msg === res]))
    onFinished(req, (err, msg) => {
      log.push(['req listener', err, msg === req, mod.isFinished(req)])
      onFinished(req, (err2) => log.push(['req late listener', err2, mod.isFinished(req)]))
      log.push(['after late attach (sync)'])
    })
    req.on('data', () => {})
    req.on('end', () => {
      res.setHeader('x-a', '1')
      res.end('done', () => {
        log.push(['res end callback', mod.isFinished(res)])
        onFinished(res, (err) => log.push(['res late listener', err, mod.isFinished(res)]))
        log.push(['after res late attach (sync)'])
      })
    })
  })
  server.listen(0)
  await once(server, 'listening')
  const { port } = server.address()
  const request = http.request({ port, method: 'POST', path: '/', headers: { 'content-length': '5' } })
  request.end('hello')
  const [response] = await once(request, 'response')
  response.resume()
  await once(response, 'end')
  await new Promise((resolve) => setTimeout(resolve, 50))
  server.close()
  await once(server, 'close')
  assert.equal(mod.isFinished({}), undefined)
  assert.equal(mod.isFinished(new http.ServerResponse(new http.IncomingMessage(null))), false)
  return log
}

export async function run({ shim, original, assert }) {
  const [a, b] = [await sequence(shim, assert), await sequence(original, assert)]
  assert.deepEqual(a, b, 'event log')
  for (const mod of [shim, original]) {
    const onFinished = mod.default ?? mod
    let calls = []
    const server = http.createServer((req, res) => {
      onFinished(res, (err) => calls.push(err ?? null))
      onFinished(req, (err) => calls.push(err ?? null))
      res.write('partial')
      setTimeout(() => req.socket.destroy(), 5)
    })
    server.listen(0)
    await once(server, 'listening')
    const request = http.get({ port: server.address().port, path: '/' })
    request.on('error', () => {})
    await new Promise((resolve) => setTimeout(resolve, 80))
    server.close()
    await once(server, 'close')
    assert.deepEqual(calls, [null, null], `${mod === shim ? 'shim' : 'original'} socket-close calls`)
  }
  return a.length + 3
}
