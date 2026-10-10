import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { compilerRoot } from './resolve-compiler.mjs'

/** Relative names and contents both authenticate the complete input set. */
export function compilerFilesDigest(entries) {
  const hash = createHash('sha256')
  for (const [name, contents] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(name + '\0')
    hash.update(createHash('sha256').update(contents).digest('hex') + '\0')
  }
  return hash.digest('hex')
}

function filesAt(root, directory, accepts) {
  const entries = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name
      if (entry.isDirectory()) walk(name)
      else if (entry.isFile() && accepts(name)) entries.push([name, readFileSync(join(root, name))])
    }
  }
  walk(directory)
  if (entries.length === 0) throw new Error(`The selected compiler has no ${directory} inputs`)
  return entries
}

export function compilerInputs(root = compilerRoot()) {
  root = realpathSync(root)
  const runtime = filesAt(root, 'src/targets/cpp/runtime', (name) => /\.(h|hpp|cpp)$/.test(name))
  return {
    compilerRoot: root,
    compilerVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    compilerDistHash: compilerFilesDigest(filesAt(root, 'dist', (name) => name.endsWith('.js'))),
    runtimeFiles: runtime.map(([name]) => name.slice('src/targets/cpp/runtime/'.length)).sort(),
    runtimeHash: compilerFilesDigest(runtime)
  }
}

/** Runtime-only benchmark hosts receive generated C++ and these headers,
 * never another compiler build. Verify precisely the emitted native inputs.
 */
export function assertRuntimeInputs(inputs, runtimeDirectory) {
  const entries = inputs.runtimeFiles.map((name) => {
    if (name.split('/').includes('..') || name.startsWith('/')) throw new Error('Invalid saved runtime input name')
    return ['src/targets/cpp/runtime/' + name, readFileSync(join(runtimeDirectory, name))]
  })
  if (compilerFilesDigest(entries) !== inputs.runtimeHash) throw new Error('Native runtime inputs changed after emission')
}

export function assertCompilerInputs(inputs) {
  const current = compilerInputs(inputs.compilerRoot)
  if (JSON.stringify(current) !== JSON.stringify(inputs))
    throw new Error('Compiler JavaScript or native runtime inputs changed during the run')
}
