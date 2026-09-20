import path from 'node:path'

export function displayPathFrom(projectRoot, file) {
  const absolute = path.resolve(file)
  const relative = path.relative(path.resolve(projectRoot), absolute)
  if (relative === '') return '.'
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return absolute
  return relative
}
