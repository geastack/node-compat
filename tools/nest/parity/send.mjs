import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const IGNORED_HEADERS = new Set(['date', 'connection', 'keep-alive'])

export async function run({ shim, original, assert }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-parity-'))
  const write = (relative, content) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  write('hello.txt', 'hello world')
  write('index.html', '<h1>root index</h1>')
  write('nested/index.html', '<h1>nested index</h1>')
  write('nested/page.html', '<p>page</p>')
  write('nested/deeper/index.htm', 'deeper htm index')
  write('.hidden', 'secret')
  write('.dot/inside.txt', 'inside a dot directory')
  write('noext', 'no extension')
  write('withext.txt', 'found through extensions')
  write('withext.html', '<p>html alternative</p>')
  write('empty-dir/.keep', '')
  write('file.unknownext', 'unknown type')
  write('empty.txt', '')
  write('bin.dat', Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)))
  write('space name.txt', 'a file with a space')
  write('unicode-é.txt', 'unicode name')
  const absolute = (relative) => path.join(root, relative)

  const cases = []
  const add = (name, spec) => cases.push({ name, method: 'GET', headers: {}, options: { root }, ...spec })

  add('hello', { path: '/hello.txt' })
  add('html', { path: '/index.html' })
  add('unknown ext', { path: '/file.unknownext' })
  add('empty file', { path: '/empty.txt' })
  add('binary', { path: '/bin.dat' })
  add('space in name', { path: '/space%20name.txt' })
  add('unicode name', { path: '/unicode-%C3%A9.txt' })
  add('absolute path, no root', { path: absolute('hello.txt'), options: {} })
  add('absolute path, explicit root undefined', { path: absolute('hello.txt'), options: { root: undefined } })
  add('empty path with root', { path: '', options: { root } })
  add('HEAD', { path: '/hello.txt', method: 'HEAD' })
  add('HEAD missing', { path: '/missing.txt', method: 'HEAD' })
  add('preset content type', { path: '/hello.txt', presetHeaders: { 'Content-Type': 'application/x-custom' } })
  add('preset cache headers', { path: '/hello.txt', presetHeaders: { 'Cache-Control': 'private', 'Last-Modified': 'Mon, 01 Jan 2001 00:00:00 GMT', ETag: '"preset"', 'Accept-Ranges': 'none' } })

  add('bad percent', { path: '/%zz' })
  add('null byte', { path: '/hello%00.txt' })
  add('null byte raw', { path: '/hello\0.txt' })
  add('dot dot', { path: '/../hello.txt' })
  add('dot dot inside', { path: '/nested/../hello.txt' })
  add('dot dot encoded', { path: '/%2e%2e/hello.txt' })
  add('dot dot no root', { path: absolute('nested/../hello.txt'), options: {} })
  add('dot dot no root leading', { path: '../' + path.basename(root) + '/hello.txt', options: {} })
  add('missing', { path: '/missing.txt' })
  add('missing no ext', { path: '/missing' })
  add('missing directory', { path: '/missing/' })
  add('file as directory', { path: '/hello.txt/' })
  add('file as parent', { path: '/hello.txt/child' })
  add('long name', { path: '/' + 'a'.repeat(300) })

  for (const dotfiles of [undefined, 'ignore', 'allow', 'deny']) {
    const label = dotfiles ?? 'default'
    add(`dotfile ${label}`, { path: '/.hidden', options: { root, dotfiles } })
    add(`dot directory ${label}`, { path: '/.dot/inside.txt', options: { root, dotfiles } })
    add(`dot directory ${label} no root`, { path: absolute('.dot/inside.txt'), options: { dotfiles } })
    add(`dot index ${label}`, { path: '/.dot/', options: { root, dotfiles, index: 'inside.txt' } })
  }
  add('dotfile in root path, with root', { path: '/hello.txt', options: { root: absolute('.dot/..') } })

  add('root index', { path: '/' })
  add('nested index', { path: '/nested/' })
  add('nested no slash', { path: '/nested' })
  add('nested no slash, double leading', { path: '//nested' })
  add('nested no slash, triple leading', { path: '///nested' })
  add('nested no slash, query-ish', { path: '/nested%3Fa=1' })
  add('nested no slash with directory listener', { path: '/nested', listenDirectory: true })
  add('nested slash with directory listener', { path: '/nested/', listenDirectory: true, options: { root, index: false } })
  add('empty dir index', { path: '/empty-dir/' })
  add('deeper index custom', { path: '/nested/deeper/', options: { root, index: ['index.html', 'index.htm'] } })
  add('deeper index single', { path: '/nested/deeper/', options: { root, index: 'index.htm' } })
  add('index false slash', { path: '/nested/', options: { root, index: false } })
  add('index false root', { path: '/', options: { root, index: false } })
  add('index empty list', { path: '/nested/', options: { root, index: [] } })
  add('index on file path', { path: '/hello.txt/', options: { root, index: 'index.html' } })
  add('index pointing at directory', { path: '/', options: { root, index: ['nested', 'index.html'] } })
  add('index missing then found', { path: '/', options: { root, index: ['nope.html', 'index.html'] } })

  add('extensions found txt', { path: '/withext', options: { root, extensions: ['txt', 'html'] } })
  add('extensions found html', { path: '/withext', options: { root, extensions: ['html', 'txt'] } })
  add('extensions single string', { path: '/withext', options: { root, extensions: 'html' } })
  add('extensions none match', { path: '/withext', options: { root, extensions: ['md', 'json'] } })
  add('extensions false', { path: '/withext', options: { root, extensions: false } })
  add('extensions with existing file', { path: '/noext', options: { root, extensions: ['txt'] } })
  add('extensions with extension in path', { path: '/withext.md', options: { root, extensions: ['txt'] } })
  add('extensions directory candidate', { path: '/nested', options: { root, extensions: ['txt'] } })
  add('extensions trailing slash', { path: '/withext/', options: { root, extensions: ['txt'], index: false } })

  add('maxAge string', { path: '/hello.txt', options: { root, maxAge: '1d' } })
  add('maxAge number', { path: '/hello.txt', options: { root, maxAge: 3600000 } })
  add('maxAge fractional', { path: '/hello.txt', options: { root, maxAge: 1500 } })
  add('maxAge over a year', { path: '/hello.txt', options: { root, maxAge: '10y' } })
  add('maxAge negative', { path: '/hello.txt', options: { root, maxAge: -5000 } })
  add('maxAge garbage', { path: '/hello.txt', options: { root, maxAge: 'soon' } })
  add('maxAge empty', { path: '/hello.txt', options: { root, maxAge: '' } })
  add('maxAge zero', { path: '/hello.txt', options: { root, maxAge: 0 } })
  add('immutable', { path: '/hello.txt', options: { root, maxAge: '1h', immutable: true } })
  add('cacheControl false', { path: '/hello.txt', options: { root, cacheControl: false, maxAge: '1h', immutable: true } })
  add('etag false', { path: '/hello.txt', options: { root, etag: false } })
  add('lastModified false', { path: '/hello.txt', options: { root, lastModified: false } })
  add('acceptRanges false', { path: '/hello.txt', options: { root, acceptRanges: false } })
  add('acceptRanges false with range', { path: '/bin.dat', options: { root, acceptRanges: false }, headers: { range: 'bytes=0-4' } })
  add('start', { path: '/hello.txt', options: { root, start: 6 } })
  add('start end', { path: '/hello.txt', options: { root, start: 2, end: 6 } })
  add('end only', { path: '/hello.txt', options: { root, end: 4 } })
  add('end past size', { path: '/hello.txt', options: { root, end: 100 } })
  add('start past size', { path: '/hello.txt', options: { root, start: 100 } })
  add('start end with range', { path: '/bin.dat', options: { root, start: 100, end: 299 }, headers: { range: 'bytes=0-9' } })
  add('start end with suffix range', { path: '/bin.dat', options: { root, start: 100, end: 299 }, headers: { range: 'bytes=-10' } })

  for (const range of ['bytes=0-4', 'bytes=-5', 'bytes=5-', 'bytes=0-0', 'bytes=999-', 'bytes=0-999', 'bytes=0-1500', 'bytes=1000-', 'bytes=2000-3000', 'bytes=-0', 'bytes=0-4,6-9', 'bytes=0-4,3-9', 'bytes=0-4,5-9', 'bytes=abc', 'bytes=', 'bytes', 'items=0-4', ' bytes=0-4', 'bytes=0-4, 2000-', 'bytes=2000-,0-4']) {
    add(`range ${range}`, { path: '/bin.dat', headers: { range } })
    add(`range HEAD ${range}`, { path: '/bin.dat', method: 'HEAD', headers: { range } })
  }
  add('range empty file', { path: '/empty.txt', headers: { range: 'bytes=0-4' } })
  add('range unsatisfiable with error listener', { path: '/bin.dat', headers: { range: 'bytes=2000-' }, listenError: true })
  add('range on missing', { path: '/missing.dat', headers: { range: 'bytes=0-4' } })

  add('error listener missing', { path: '/missing.txt', listenError: true })
  add('error listener missing no ext', { path: '/missing', listenError: true, options: { root, extensions: ['txt'] } })
  add('error listener file as parent', { path: '/hello.txt/child', listenError: true })
  add('error listener dotfile', { path: '/.hidden', listenError: true })
  add('error listener dotfile deny', { path: '/.hidden', listenError: true, options: { root, dotfiles: 'deny' } })
  add('error listener dot dot', { path: '/../x', listenError: true })
  add('error listener bad percent', { path: '/%zz', listenError: true })
  add('error listener directory slash no index', { path: '/nested/', listenError: true, options: { root, index: false } })
  add('error listener empty dir', { path: '/empty-dir/', listenError: true })
  add('error listener with directory listener', { path: '/nested', listenError: true, listenDirectory: true })

  const servers = { shim: await serve(shim.default, cases, root), original: await serve(original, cases, root) }
  try {
    let count = 0
    const compare = async (index) => {
      const [fromShim, fromOriginal] = await Promise.all([request(servers.shim, cases[index], index), request(servers.original, cases[index], index)])
      assert.deepEqual(fromShim, fromOriginal, `case ${cases[index].name}`)
      count++
    }
    for (let index = 0; index < cases.length; index++) await compare(index)

    const probe = await request(servers.original, cases[0], 0)
    const etag = probe.headers.etag
    const lastModified = probe.headers['last-modified']
    const earlier = new Date(Date.parse(lastModified) - 3600000).toUTCString()
    const later = new Date(Date.parse(lastModified) + 3600000).toUTCString()
    const strong = etag.replace(/^W\//, '')
    const conditional = [
      ['inm match', { 'if-none-match': etag }],
      ['inm strong', { 'if-none-match': strong }],
      ['inm star', { 'if-none-match': '*' }],
      ['inm other', { 'if-none-match': '"other"' }],
      ['inm list', { 'if-none-match': '"other", ' + etag }],
      ['inm no-cache', { 'if-none-match': etag, 'cache-control': 'no-cache' }],
      ['ims equal', { 'if-modified-since': lastModified }],
      ['ims later', { 'if-modified-since': later }],
      ['ims earlier', { 'if-modified-since': earlier }],
      ['ims garbage', { 'if-modified-since': 'garbage' }],
      ['inm other with ims equal', { 'if-none-match': '"other"', 'if-modified-since': lastModified }],
      ['if-match match', { 'if-match': etag }],
      ['if-match strong', { 'if-match': strong }],
      ['if-match star', { 'if-match': '*' }],
      ['if-match other', { 'if-match': '"other"' }],
      ['if-match list', { 'if-match': '"other", ' + etag }],
      ['if-match with inm', { 'if-match': '"other"', 'if-none-match': etag }],
      ['ius equal', { 'if-unmodified-since': lastModified }],
      ['ius later', { 'if-unmodified-since': later }],
      ['ius earlier', { 'if-unmodified-since': earlier }],
      ['ius garbage', { 'if-unmodified-since': 'garbage' }],
      ['ius earlier with inm', { 'if-unmodified-since': earlier, 'if-none-match': etag }]
    ]
    const conditionalCases = []
    for (const [name, headers] of conditional) {
      conditionalCases.push({ name: `conditional ${name}`, method: 'GET', headers, path: '/hello.txt', options: { root } })
      conditionalCases.push({ name: `conditional HEAD ${name}`, method: 'HEAD', headers, path: '/hello.txt', options: { root } })
      conditionalCases.push({ name: `conditional ${name} etag off`, method: 'GET', headers, path: '/hello.txt', options: { root, etag: false } })
      conditionalCases.push({ name: `conditional ${name} lastModified off`, method: 'GET', headers, path: '/hello.txt', options: { root, lastModified: false } })
      conditionalCases.push({ name: `conditional ${name} missing`, method: 'GET', headers, path: '/missing.txt', options: { root } })
    }
    const binIndex = cases.findIndex((spec) => spec.name === 'binary')
    const binProbe = await request(servers.original, cases[binIndex], binIndex)
    const binEtag = binProbe.headers.etag
    const binLastModified = binProbe.headers['last-modified']
    const binEarlier = new Date(Date.parse(binLastModified) - 3600000).toUTCString()
    const binLater = new Date(Date.parse(binLastModified) + 3600000).toUTCString()
    for (const [name, ifRange] of [
      ['etag match', binEtag],
      ['etag other', '"other"'],
      ['etag list containing', '"other", ' + binEtag],
      ['date equal', binLastModified],
      ['date later', binLater],
      ['date earlier', binEarlier],
      ['garbage', 'garbage'],
      ['empty', '']
    ]) {
      conditionalCases.push({ name: `if-range ${name}`, method: 'GET', headers: { range: 'bytes=0-9', 'if-range': ifRange }, path: '/bin.dat', options: { root } })
      conditionalCases.push({ name: `if-range ${name} unsatisfiable`, method: 'GET', headers: { range: 'bytes=5000-', 'if-range': ifRange }, path: '/bin.dat', options: { root } })
      conditionalCases.push({ name: `if-range ${name} lastModified off`, method: 'GET', headers: { range: 'bytes=0-9', 'if-range': ifRange }, path: '/bin.dat', options: { root, lastModified: false } })
    }
    cases.push(...conditionalCases)
    for (let index = cases.length - conditionalCases.length; index < cases.length; index++) await compare(index)

    return count
  } finally {
    servers.shim.server.close()
    servers.original.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function serve(impl, cases, root) {
  const relative = (file) => path.relative(root, file)
  const events = new Map()
  const server = http.createServer((req, res) => {
    const index = Number(req.headers['x-case'])
    const spec = cases[index]
    const recorded = []
    events.set(index, recorded)
    if (spec.presetHeaders) for (const [name, value] of Object.entries(spec.presetHeaders)) res.setHeader(name, value)
    const stream = impl(req, spec.path, spec.options)
    if (spec.listenError) {
      stream.on('error', (error) => {
        res.statusCode = 599
        res.setHeader(
          'x-error',
          JSON.stringify({
            name: error.name,
            message: error.message.split(root).join('<root>'),
            status: error.status,
            statusCode: error.statusCode,
            expose: error.expose,
            code: error.code ?? null,
            syscall: error.syscall ?? null,
            headers: error.headers ?? null
          })
        )
        res.end()
      })
    }
    if (spec.listenDirectory) {
      stream.on('directory', (response, directory) => {
        response.statusCode = 200
        response.end('directory:' + relative(directory))
      })
    }
    stream.on('headers', (response, file, stats) => response.setHeader('x-headers-event', `${relative(file)}:${stats.size}`))
    stream.on('file', (file, stats) => recorded.push(`file:${relative(file)}:${stats.size}`))
    stream.on('stream', (readable) => recorded.push(`stream:${typeof readable.pipe}`))
    stream.on('end', () => recorded.push('end'))
    stream.pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, events }))
  })
}

function request(target, spec, index) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: target.port, method: spec.method, path: '/', headers: { ...spec.headers, 'x-case': String(index) } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          setImmediate(() => {
            const headers = {}
            for (const [name, value] of Object.entries(res.headers)) if (!IGNORED_HEADERS.has(name)) headers[name] = value
            resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString('base64'), events: target.events.get(index) ?? [] })
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}
