const show = (label: string, bytes: Buffer) => console.log(`${label}: ${bytes.length} ${bytes.toString('hex')}`)

show('number', Buffer.alloc(4, 0x41))
show('string', Buffer.alloc(5, 'ab'))
show('hex string', Buffer.alloc(4, 'a1b2', 'hex'))
show('buffer', Buffer.alloc(5, Buffer.from([1, 2])))
show('number with encoding', Buffer.alloc(3, 7, 'utf8'))
show('empty string', Buffer.alloc(3, ''))
show('zero size', Buffer.alloc(0, 'x'))

const fills: (string | number | Uint8Array)[] = [0x41, 'xyz', Uint8Array.from([9, 8])]
for (const fill of fills) show(`union ${typeof fill}`, Buffer.alloc(4, fill))
for (const fill of fills) show(`union ${typeof fill} latin1`, Buffer.alloc(4, fill, 'latin1'))
