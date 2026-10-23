import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Stats } from 'node:fs'

export interface EtagOptions {
  weak?: boolean
}

function entityTag(entity: string | Buffer): string {
  if (entity.length === 0) return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'
  const sha1 = createHash('sha1')
  const hash = (typeof entity === 'string' ? sha1.update(entity, 'utf8') : sha1.update(entity)).digest('base64').substring(0, 27)
  const len = typeof entity === 'string' ? Buffer.byteLength(entity, 'utf8') : entity.length
  return '"' + len.toString(16) + '-' + hash + '"'
}

function statTag(stats: Stats): string {
  const mtime = stats.mtime.getTime().toString(16)
  const size = stats.size.toString(16)
  return '"' + size + '-' + mtime + '"'
}

export default function etag(entity: string | Buffer | Stats, options?: EtagOptions): string {
  const isStats = entity instanceof Stats
  const weak = options !== undefined && typeof options.weak === 'boolean' ? options.weak : isStats
  const tag = entity instanceof Stats ? statTag(entity) : entityTag(entity)
  return weak ? 'W/' + tag : tag
}
