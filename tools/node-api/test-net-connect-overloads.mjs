import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const entry = path.join(repo, 'apps', 'net-connect-overloads', 'server.ts')
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-net-overloads-'))
const outDir = path.join(rootDir, 'dist')
const executable = path.join(outDir, 'server')

function run(mode, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [mode, String(port)], {
      cwd: repo,
      env: { ...process.env, GEA_CPP_PRINT_UNCAUGHT: '1' }
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `Node TCP overload probe timed out in ${mode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      )
    }, 10000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

const server = net.createServer((socket) => {
  socket.on('error', () => {})
  socket.pipe(socket)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, resolve)
})
const address = server.address()
assert.ok(address && typeof address === 'object')

try {
  const build = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'build.mjs'), entry, '--out', outDir, '--exe', executable],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

  for (const input of [
    '',
    '127.0.0.1',
    '01.2.3.4',
    '255.255.255.255',
    '256.0.0.1',
    '::1',
    '2001:db8::1',
    '::ffff:192.0.2.128',
    'fe80::1%lo0',
    'not-an-address',
    ' 127.0.0.1 '
  ]) {
    const output = await run('ip', input)
    assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`)
    const expected = `${net.isIP(input)},${net.isIPv4(input) ? 1 : 0},${net.isIPv6(input) ? 1 : 0}`
    assert.equal(output.stdout.trim(), expected, `IP classification mismatch for ${JSON.stringify(input)}`)
  }

  const idle = await run('constructor-only', address.port)
  assert.equal(idle.code, 0, `${idle.stdout}\n${idle.stderr}`)
  assert.match(idle.stdout, /node-net-constructor-idle-ok/)
  assert.doesNotMatch(`${idle.stdout}\n${idle.stderr}`, /Error|ERR_GEA_NODE_NOT_IMPLEMENTED/)

  const defaults = await run('defaults', address.port)
  assert.equal(defaults.code, 0, `${defaults.stdout}\n${defaults.stderr}`)
  assert.equal(defaults.stdout.trim(), 'true,250\nfalse,10\ntrue,2147483647')

  const socketAddressValues = [
    new net.SocketAddress(),
    new net.SocketAddress({
      address: '0:0:0:0:0:0:0:1',
      family: 'ipv6',
      port: 1234,
      flowlabel: 42
    }),
    net.SocketAddress.parse('192.0.2.1:1234'),
    net.SocketAddress.parse('[2001:db8::1]:443')
  ]
  const expectedSocketAddress = [
    ...socketAddressValues.map(
      (value) => `${value.address},${value.family},${value.port},${value.flowlabel}`
    ),
    (() => {
      const value = net.SocketAddress.parse('192.0.2.1:80')
      return `${value.address},${value.family},${value.port}`
    })(),
    String(net.SocketAddress.parse('localhost:1234'))
  ].join('\n')
  const socketAddress = await run('socket-address', address.port)
  assert.equal(socketAddress.code, 0, `${socketAddress.stdout}\n${socketAddress.stderr}`)
  assert.equal(socketAddress.stdout.trim(), expectedSocketAddress)

  function blockListOracle() {
    const blockList = new net.BlockList()
    blockList.addAddress('192.168.1.1')
    blockList.addAddress(new net.SocketAddress({ address: '::1', family: 'ipv6' }))
    blockList.addRange('10.0.0.1', '10.0.0.10')
    blockList.addSubnet('172.16.10.20', 16)
    blockList.addSubnet('2001:db8:1::1234', 64, 'ipv6')
    const restored = new net.BlockList()
    restored.fromJSON(['Address: IPv4 1.2.3.4', 'Subnet: IPv4 10.0.0.0/8'])
    restored.fromJSON('["Address: IPv6 ::1"]')
    return [
      blockList.rules.join('|'),
      [
        blockList.check('192.168.1.1'),
        blockList.check('192.168.1.2'),
        blockList.check('10.0.0.10'),
        blockList.check('10.0.0.11'),
        blockList.check('172.16.99.1'),
        blockList.check('2001:db8:1::abcd', 'ipv6'),
        blockList.check('::ffff:192.168.1.1', 'ipv6')
      ].join(','),
      restored.toJSON().join('|'),
      `${restored.check('1.2.3.4')},${restored.check('10.2.3.4')},${restored.check('::1', 'ipv6')}`,
      `${net.BlockList.isBlockList(blockList)},${net.BlockList.isBlockList({})}`
    ].join('\n')
  }
  const blockList = await run('block-list', address.port)
  assert.equal(blockList.code, 0, `${blockList.stdout}\n${blockList.stderr}`)
  assert.equal(blockList.stdout.trim(), blockListOracle())

  const socketMethods = await run('socket-methods', address.port)
  assert.equal(
    socketMethods.code,
    0,
    `signal=${socketMethods.signal}\n${socketMethods.stdout}\n${socketMethods.stderr}`
  )
  assert.match(
    socketMethods.stdout,
    /socket-address:\{"address":"127\.0\.0\.1","family":"IPv4","port":\d+\},1/
  )
  assert.match(
    socketMethods.stdout,
    /socket-events:prepend-once,prepend,listener,prepend,listener/
  )
  assert.match(socketMethods.stdout, /socket-reference:true/)
  assert.match(socketMethods.stdout, /socket-write:true,4,true/)
  assert.match(socketMethods.stdout, /socket-write-callback:true/)
  assert.match(socketMethods.stdout, /socket-finish/)
  assert.match(socketMethods.stdout, /socket-end:gea-socket-methods/)
  assert.match(socketMethods.stdout, /socket-close/)
  assert.doesNotMatch(`${socketMethods.stdout}\n${socketMethods.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)

  for (const mode of ['options', 'positional-host', 'positional-default-host', 'socket-connect']) {
    const output = await run(mode, address.port)
    assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`)
    assert.match(output.stdout, new RegExp(`node-net-overload-ok:${mode}`))
    assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /ERR_GEA_NODE_NOT_IMPLEMENTED/)
  }

  const unsupported = new Map([
    ['unsupported-path', 'node:net.Socket.connect.path'],
    ['unsupported-lookup', 'node:net.Socket.connect.lookup'],
    ['unsupported-auto-family', 'node:net.Socket.connect.autoSelectFamily'],
    ['unsupported-fd', 'node:net.Socket.constructor.fd']
  ])
  for (const [mode, operation] of unsupported) {
    const output = await run(mode, address.port)
    assert.match(
      `${output.stdout}\n${output.stderr}`,
      new RegExp(
        `ERR_GEA_NODE_NOT_IMPLEMENTED: ${operation.replaceAll('.', '\\.')} is not implemented for geastack target node@24`
      )
    )
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(rootDir, { recursive: true, force: true })
}

process.stdout.write(
  'Verified node:net defaults, SocketAddress, BlockList, IP classification, Socket stream methods, TCP overloads, and explicit unsupported-option errors\n'
)
