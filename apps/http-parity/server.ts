// http-parity test app — exercises the full node:http surface. The SAME file
// runs under Node (type stripping) and compiled by geatsc, on the port given
// by argv/env; the driver diffs raw responses byte-for-byte.
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Hello, World! ' + req.method + ' ' + req.url)
    return
  }
  if (req.url === '/plain') {
    // No explicit content-type: parity for implicit-header behavior.
    res.end('plain body')
    return
  }
  if (req.url === '/echo') {
    let body = ''
    req.on('data', (chunk) => {
      body = body + chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('echo:' + body + ':len=' + String(body.length))
    })
    return
  }
  if (req.url === '/req-info') {
    // Manual header serialization (portable across both runtimes).
    let out = 'method=' + req.method + ';url=' + req.url + ';ver=' + req.httpVersion
    const h = req.headers
    out += ';x-one=' + h['x-one']
    out += ';x-dup=' + h['x-dup']
    out += ';cookie=' + h['cookie']
    out += ';host=' + h['host']
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(out)
    return
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('part1|')
    res.write('part2|')
    res.end('part3')
    return
  }
  if (req.url === '/async') {
    Promise.resolve('async-value').then((value) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('got:' + value)
    })
    return
  }
  if (req.url === '/timer') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('timer-fired')
    }, 30)
    return
  }
  if (req.url === '/status') {
    res.statusCode = 418
    res.statusMessage = 'Short and Stout'
    res.end('teapot')
    return
  }
  if (req.url === '/codes') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url === '/headers-api') {
    res.setHeader('X-Alpha', 'a')
    res.setHeader('X-Beta', 'b1')
    res.setHeader('X-Beta', 'b2')          // replace
    res.setHeader('X-Gone', 'bye')
    res.removeHeader('X-Gone')
    const probe =
      'has-alpha=' + String(res.hasHeader('X-Alpha')) +
      ';get-beta=' + String(res.getHeader('x-beta')) +
      ';has-gone=' + String(res.hasHeader('X-Gone'))
    res.setHeader('X-Probe', probe)
    res.end('headers-api')
    return
  }
  if (req.url === '/finish-event') {
    let fired = 'no'
    res.on('finish', () => {
      fired = 'yes'
    })
    res.end('finish-event')
    return
  }
  if (req.url === '/set-cookie') {
    res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; HttpOnly'])
    res.appendHeader('X-Extra', 'e1')
    res.appendHeader('X-Extra', 'e2')
    res.end('cookies')
    return
  }
  if (req.url === '/head-implicit') {
    res.end('implicit body')
    return
  }
  if (req.url === '/throw') {
    throw new Error('handler exploded')
  }
  if (req.url === '/remote') {
    // Format-agnostic: Node's dual-stack listener reports ::ffff:127.0.0.1,
    // gea's IPv4 listener reports 127.0.0.1 — both are loopback.
    const isLocal = req.socket.remoteAddress.indexOf('127.0.0.1') >= 0
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('local=' + String(isLocal) + ';portok=' + String(req.socket.remotePort > 0))
    return
  }
  if (req.url === '/big-echo') {
    let total = 0
    req.on('data', (chunk) => {
      total = total + chunk.length
    })
    req.on('end', () => {
      res.end('received:' + String(total))
    })
    return
  }
  if (req.url === '/double-end') {
    res.end('first')
    res.end('second')
    return
  }
  if (req.url === '/write-after-end') {
    res.end('done')
    res.write('ignored')
    return
  }
  // Named capture groups + ES2018 RegExpExecArray.groups — the exact mechanism
  // hono's PatternRouter uses to resolve `:param` routes (`match.groups`). `id`
  // always participates; the optional `action` is absent for `/user/x`, so
  // `groups.action` is undefined there — locking in both the named-capture and
  // the unmatched-group (undefined) cases against Node's byte-for-byte output.
  const userMatch = /^\/user\/(?<id>\w+)(?:\/(?<action>\w+))?$/.exec(req.url)
  if (userMatch && userMatch.groups) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('id=' + userMatch.groups.id + ';action=' + String(userMatch.groups.action))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found: ' + req.url)
})

server.listen(3000, () => {
  console.log('parity server up')
})
