import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const workspace = path.resolve(repo, '..')
const surfacePath = path.join(repo, 'runtime', 'node', 'generated', 'node24-surface.json')
const nodeTypesEntry = path.join(here, 'node_modules', '@types', 'node', 'index.d.ts')
const compilerPath = path.join(workspace, 'compiler', 'packages', 'geatsc', 'dist', 'compiler.js')
const { compile } = await import(pathToFileURL(compilerPath).href)
const surface = JSON.parse(fs.readFileSync(surfacePath, 'utf8'))

const lines = [
  '// Generated in-memory probe for the pinned Node 24 declaration contract.',
  '// Type-only imports validate export binding without instantiating generics.'
]
let exportCount = 0
let moduleIndex = 0
for (const [moduleName, module] of Object.entries(surface.modules)) {
  let exportIndex = 0
  for (const entry of module.exports) {
    const alias = `__gea_node24_${moduleIndex}_${exportIndex}`
    lines.push(
      entry.name === 'default'
        ? `import type ${alias} from ${JSON.stringify(moduleName)}`
        : `import type { ${entry.name} as ${alias} } from ${JSON.stringify(moduleName)}`
    )
    exportCount += 1
    exportIndex += 1
  }
  moduleIndex += 1
}
lines.push('export function main(): number { return 24 }', '')

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gea-node24-declarations-'))
const entry = path.join(rootDir, 'surface.ts')
const outDir = path.join(rootDir, 'dist')
fs.writeFileSync(entry, lines.join('\n'))

const result = compile({
  entry,
  outDir,
  emitMain: true,
  nodeResolution: {
    builtinsDir: path.join(repo, 'runtime', 'node'),
    builtinFacadesDir: path.join(repo, 'runtime', 'node', 'generated', 'facades'),
    builtins: Object.keys(surface.modules).map((name) => name.slice('node:'.length)),
    builtinDeclarationFiles: [nodeTypesEntry]
  }
})

assert.deepEqual(
  result.diagnostics,
  [],
  `Pinned Node 24 declaration compilation failed:\n${result.diagnostics
    .map((diagnostic) => `${diagnostic.file ?? ''}:${diagnostic.line ?? ''} ${diagnostic.message}`)
    .join('\n')}`
)
process.stdout.write(
  `Verified geatsc compilation against all ${Object.keys(surface.modules).length} Node 24 modules and ${exportCount} exports\n`
)
