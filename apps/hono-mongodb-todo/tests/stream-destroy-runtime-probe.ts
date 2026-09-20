import { Readable } from 'node:stream'

let hook = ''

class ProbeReadable extends Readable {
  override _read(_size: number): void {}

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    hook = error === null ? 'hook:null' : 'hook:error'
    callback(error)
  }
}

export function main(): string {
  const stream = new ProbeReadable()
  let closes = 0
  let errors = 0
  stream.on('close', () => closes++)
  stream.on('error', () => errors++)

  const same = stream.destroy() === stream
  stream.destroy()
  return `${same}:${stream.destroyed}:${stream.closed}:${hook}:${closes}:${errors}`
}
