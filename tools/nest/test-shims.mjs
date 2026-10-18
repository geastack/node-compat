import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const shimsDir = path.join(root, 'runtime/node/nest/shims')
const parityDir = path.join(import.meta.dirname, 'parity')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-shims-'))

const walk = (directory, visit) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file, visit)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) visit(file)
  }
}

const transpileAll = () => {
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
  }
  walk(shimsDir, (file) => {
    const relative = path.relative(shimsDir, file)
    const source = fs.readFileSync(file, 'utf8')
    const { outputText, diagnostics } = ts.transpileModule(source, { compilerOptions, fileName: file, reportDiagnostics: true })
    assert.equal(diagnostics?.length ?? 0, 0, `${relative}: ${diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`)
    const rewritten = outputText.replace(/(from\s+|import\()\s*(['"])([^'"]+)\2/g, (whole, lead, q, specifier) => {
      if (specifier.startsWith('node:')) return whole
      if (/^\.{1,2}\//.test(specifier)) return /\.[cm]?js$/.test(specifier) ? whole : `${lead}${q}${specifier}.js${q}`
      assert.fail(`${relative}: imports the npm package ${specifier}; shims import other shims by relative path`)
    })
    const target = path.join(scratch, relative.replace(/\.ts$/, '.js'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, rewritten)
  })
}

const shimNames = () => {
  const names = []
  walk(shimsDir, (file) => {
    if (file.endsWith('.generated.ts')) return
    const relative = path.relative(shimsDir, file).replace(/\.ts$/, '')
    names.push(relative.endsWith('/index') ? relative.slice(0, -'/index'.length) : relative)
  })
  return names.sort()
}

const selected = process.argv.slice(2)
transpileAll()
let ran = 0
let failed = 0
for (const name of shimNames()) {
  if (selected.length > 0 && !selected.includes(name)) continue
  const table = path.join(parityDir, `${name.replace(/\//g, '__')}.mjs`)
  if (!fs.existsSync(table)) {
    console.log(`skip  ${name}: no parity table at tools/nest/parity/${path.basename(table)}`)
    continue
  }
  const moduleFile = fs.existsSync(path.join(scratch, name, 'index.js')) ? path.join(scratch, name, 'index.js') : path.join(scratch, `${name}.js`)
  const shim = await import(pathToFileURL(moduleFile).href)
  const original = require(moduleFile.endsWith('/index.js') ? name : `${name}.js`)
  const { run } = await import(pathToFileURL(table).href)
  try {
    const count = await run({ shim, original, require, assert })
    ran++
    console.log(`ok    ${name}: ${count ?? 'all'} cases`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}: ${error?.stack ?? error}`)
  }
}
fs.rmSync(scratch, { recursive: true, force: true })
console.log(`${ran} shim table(s) passed, ${failed} failed`)
if (failed > 0) process.exit(1)
