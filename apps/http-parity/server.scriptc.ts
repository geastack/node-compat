// http-parity test app, the scriptc 0.1.3 variant. scriptc refuses server.ts
// as written (11 errors), so this file is the closest program it accepts:
//
// - type-level rewrites with identical behavior under Node: the `'data'`
//   chunk is declared `Buffer` (scriptc runs `any` only in its embedded
//   dynamic engine), request header values are narrowed by hand before
//   string concatenation (scriptc cannot stringify `string | string[] |
//   undefined`), and `remoteAddress`/`url` get `?? ''` because scriptc
//   type-checks under strictNullChecks;
// - three routes REMOVED because scriptc has no lowering for the members they
//   use: `/finish-event` (`res.on('finish')`), `/set-cookie`
//   (`setHeader(string[])`, `appendHeader`) and `/remote`
//   (`socket.remotePort`). The driver's cases for those routes therefore fail
//   against Node by construction, and are reported as "no lowering".
//
// The driver runs Node on the ORIGINAL server.ts, so every other case tests
// scriptc's node:http against Node's wire bytes. bench/parity-node-variant.sh
// runs Node on this file instead, to prove the rewrites change nothing.
import { createServer } from 'node:http'

const headerText = (value: string | string[] | undefined): string => {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  return value.join(',')
}

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Hello, World! ' + req.method + ' ' + url)
    return
  }
  if (url === '/plain') {
    // No explicit content-type: parity for implicit-header behavior.
    res.end('plain body')
    return
  }
  if (url === '/echo') {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body = body + chunk.toString()
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('echo:' + body + ':len=' + String(body.length))
    })
    return
  }
  if (url === '/req-info') {
    // Manual header serialization (portable across both runtimes).
    let out = 'method=' + req.method + ';url=' + url + ';ver=' + req.httpVersion
    const h = req.headers
    out += ';x-one=' + headerText(h['x-one'])
    out += ';x-dup=' + headerText(h['x-dup'])
    out += ';cookie=' + headerText(h['cookie'])
    out += ';host=' + headerText(h['host'])
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(out)
    return
  }
  if (url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('part1|')
    res.write('part2|')
    res.end('part3')
    return
  }
  if (url === '/async') {
    Promise.resolve('async-value').then((value) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('got:' + value)
    })
    return
  }
  if (url === '/timer') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('timer-fired')
    }, 30)
    return
  }
  if (url === '/status') {
    res.statusCode = 418
    res.statusMessage = 'Short and Stout'
    res.end('teapot')
    return
  }
  if (url === '/codes') {
    res.writeHead(204)
    res.end()
    return
  }
  if (url === '/headers-api') {
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
  if (url === '/head-implicit') {
    res.end('implicit body')
    return
  }
  if (url === '/throw') {
    throw new Error('handler exploded')
  }
  if (url === '/big-echo') {
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total = total + chunk.length
    })
    req.on('end', () => {
      res.end('received:' + String(total))
    })
    return
  }
  if (url === '/double-end') {
    res.end('first')
    res.end('second')
    return
  }
  if (url === '/write-after-end') {
    res.end('done')
    res.write('ignored')
    return
  }
  const userMatch = /^\/user\/(?<id>\w+)(?:\/(?<action>\w+))?$/.exec(url)
  if (userMatch && userMatch.groups) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('id=' + userMatch.groups.id + ';action=' + String(userMatch.groups.action))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found: ' + url)
})

server.listen(3000, () => {
  console.log('parity server up')
})
