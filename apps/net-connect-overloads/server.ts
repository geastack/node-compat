import { Buffer } from 'node:buffer'
import {
  BlockList,
  connect,
  createConnection,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  isIP,
  isIPv4,
  isIPv6,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
  Socket,
  SocketAddress
} from 'node:net'
import { Transform, TransformCallback } from 'node:stream'

let listenerFired = false

class EchoCollector extends Transform {
  private socket_: Socket
  private mode_: string

  constructor(socket: Socket, mode: string) {
    super()
    this.socket_ = socket
    this.mode_ = mode
  }

  override _transform(chunk: Buffer, _encoding: unknown, callback: TransformCallback): void {
    if (chunk.toString('utf8') !== 'gea-net-overload') {
      throw new Error('node:net overload probe received the wrong bytes')
    }
    if (!listenerFired) throw new Error('node:net connect listener did not fire')
    console.log(`node-net-overload-ok:${this.mode_}`)
    this.socket_.destroy()
    callback()
  }
}

const mode = process.argv[2] ?? 'options'
const port = Number(process.argv[3] ?? '0')

if (mode === 'ip') {
  const input = process.argv[3] ?? ''
  console.log(`${isIP(input)},${isIPv4(input) ? 1 : 0},${isIPv6(input) ? 1 : 0}`)
} else if (mode === 'constructor-only') {
  const socket = new Socket()
  if (socket.connecting || socket.destroyed || !socket.pending || socket.readyState !== 'opening') {
    throw new Error('new Socket() must create an idle, pending socket')
  }
  console.log('node-net-constructor-idle-ok')
} else if (mode === 'defaults') {
  console.log(`${getDefaultAutoSelectFamily()},${getDefaultAutoSelectFamilyAttemptTimeout()}`)
  setDefaultAutoSelectFamily(false)
  setDefaultAutoSelectFamilyAttemptTimeout(1)
  console.log(`${getDefaultAutoSelectFamily()},${getDefaultAutoSelectFamilyAttemptTimeout()}`)
  setDefaultAutoSelectFamily(true)
  setDefaultAutoSelectFamilyAttemptTimeout(2147483647)
  console.log(`${getDefaultAutoSelectFamily()},${getDefaultAutoSelectFamilyAttemptTimeout()}`)
} else if (mode === 'socket-address') {
  const defaultAddress = new SocketAddress({})
  const ipv6Address = new SocketAddress({
    address: '0:0:0:0:0:0:0:1',
    family: 'ipv6',
    port: 1234,
    flowlabel: 42
  })
  const parsedIpv4 = SocketAddress.parse('192.0.2.1:1234')
  const parsedIpv6 = SocketAddress.parse('[2001:db8::1]:443')
  const parsedPort80 = SocketAddress.parse('192.0.2.1:80')
  const invalid = SocketAddress.parse('localhost:1234')
  console.log(
    `${defaultAddress.address},${defaultAddress.family},${defaultAddress.port},${defaultAddress.flowlabel}`
  )
  console.log(`${ipv6Address.address},${ipv6Address.family},${ipv6Address.port},${ipv6Address.flowlabel}`)
  console.log(
    `${parsedIpv4!.address},${parsedIpv4!.family},${parsedIpv4!.port},${parsedIpv4!.flowlabel}`
  )
  console.log(
    `${parsedIpv6!.address},${parsedIpv6!.family},${parsedIpv6!.port},${parsedIpv6!.flowlabel}`
  )
  console.log(`${parsedPort80!.address},${parsedPort80!.family},${parsedPort80!.port}`)
  console.log(invalid === undefined ? 'undefined' : 'unexpected')
} else if (mode === 'block-list') {
  const blockList = new BlockList()
  blockList.addAddress('192.168.1.1')
  blockList.addAddress(new SocketAddress({ address: '::1', family: 'ipv6' }))
  blockList.addRange('10.0.0.1', '10.0.0.10')
  blockList.addSubnet('172.16.10.20', 16)
  blockList.addSubnet('2001:db8:1::1234', 64, 'ipv6')
  const rules: readonly string[] = blockList.rules
  console.log(rules.join('|'))
  console.log(
    [
      blockList.check('192.168.1.1'),
      blockList.check('192.168.1.2'),
      blockList.check('10.0.0.10'),
      blockList.check('10.0.0.11'),
      blockList.check('172.16.99.1'),
      blockList.check('2001:db8:1::abcd', 'ipv6'),
      blockList.check('::ffff:192.168.1.1', 'ipv6')
    ].join(',')
  )
  const restored = new BlockList()
  restored.fromJSON(['Address: IPv4 1.2.3.4', 'Subnet: IPv4 10.0.0.0/8'])
  restored.fromJSON('["Address: IPv6 ::1"]')
  console.log(restored.toJSON().join('|'))
  console.log(
    `${restored.check('1.2.3.4')},${restored.check('10.2.3.4')},${restored.check('::1', 'ipv6')}`
  )
  console.log(`${BlockList.isBlockList(blockList)},${BlockList.isBlockList({})}`)
} else if (mode === 'socket-methods') {
  const socket = new Socket()
  let received = ''
  const eventOrder: string[] = []
  socket.addListener('probe', (_a?: any, _b?: any, _c?: any) => eventOrder.push('listener'))
  socket.prependListener('probe', (_a?: any, _b?: any, _c?: any) => eventOrder.push('prepend'))
  socket.prependOnceListener('probe', (_a?: any, _b?: any, _c?: any) =>
    eventOrder.push('prepend-once')
  )
  socket.emit('probe')
  socket.emit('probe')
  socket.setEncoding('utf8')
  socket.on('data', (chunk?: any, _b?: any, _c?: any) => {
    received += chunk
  })
  socket.on('end', (_a?: any, _b?: any, _c?: any) => console.log(`socket-end:${received}`))
  socket.on('close', (_a?: any, _b?: any, _c?: any) => console.log('socket-close'))
  socket.connect(port, '127.0.0.1', () => {
    const address = JSON.stringify(socket.address())
    const sameReference = socket.unref() === socket && socket.ref() === socket
    socket.pause()
    socket.resume()
    console.log(`socket-address:${address},${socket.autoSelectFamilyAttemptedAddresses.length}`)
    console.log(`socket-events:${eventOrder.join(',')}`)
    console.log(`socket-reference:${sameReference}`)
    const accepted = socket.write('gea-', (error?: Error | null) => {
      console.log(`socket-write-callback:${error === undefined || error === null}`)
    })
    console.log(`socket-write:${accepted},${socket.bytesWritten},${socket.bufferSize >= 0}`)
    socket.end('socket-methods', 'utf8', () => console.log('socket-finish'))
  })
} else if (mode === 'unsupported-path') {
  createConnection('/tmp/gea-node-net.sock')
} else if (mode === 'unsupported-lookup') {
  createConnection({ port, lookup: () => undefined })
} else if (mode === 'unsupported-auto-family') {
  createConnection({ port, autoSelectFamily: true })
} else if (mode === 'unsupported-fd') {
  new Socket({ fd: 1 })
} else {
  let socket: Socket
  const onConnect = () => {
    listenerFired = true
    socket.write(Buffer.from('gea-net-overload'))
  }

  if (mode === 'options') {
    socket = createConnection(
      {
        host: '127.0.0.1',
        port,
        family: 4,
        noDelay: true,
        keepAlive: true,
        keepAliveInitialDelay: 1000,
        timeout: 3000
      },
      onConnect
    )
  } else if (mode === 'positional-host') {
    socket = createConnection(port, '127.0.0.1', onConnect)
  } else if (mode === 'positional-default-host') {
    socket = connect(port)
    socket.once('connect', onConnect)
  } else if (mode === 'socket-connect') {
    socket = new Socket({ noDelay: true, keepAlive: true })
    socket.connect(port, '127.0.0.1', onConnect)
  } else {
    throw new Error(`Unknown node:net overload probe mode: ${mode}`)
  }

  socket.pipe(new EchoCollector(socket, mode))
}
