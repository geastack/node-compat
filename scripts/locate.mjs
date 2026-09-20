// Turn a geatsc NodeId back into a source location.
//
// geatsc's identities are deliberately free of source offsets (`src/identity/ids.ts`
// says so in its opening comment): a node is `node|f<N>|<Kind>|<ordinal>`, where
// `f<N>` indexes the program's files sorted by name and `<ordinal>` is the node's
// position in a deterministic pre-order walk of that file. That is the right
// choice for the compiler and a poor one for a person reading a diagnostic, so
// this rebuilds the same program and inverts the mapping.
//
// Usage: node scripts/locate.mjs <tsconfig.json> 'node|f60|CallExpression|1969' ...
//        node scripts/build.mjs app.ts --emit-only 2>&1 | node scripts/locate.mjs <tsconfig.json>
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// The compiler's own TypeScript, so this rebuilds the program the compiler saw.
const ts = createRequire(import.meta.resolve('@geastack/compiler/plugin'))('typescript')

const projectFile = path.resolve(process.argv[2])
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(projectFile, ts.sys.readFile).config, ts.sys, path.dirname(projectFile))
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })

const files = program.getSourceFiles().slice().sort((l, r) => (l.fileName < r.fileName ? -1 : l.fileName > r.fileName ? 1 : 0))
const byIdentity = new Map(files.map((file, index) => [`f${index}`, file]))

const ordinalsOf = (file) => {
  const nodes = []
  const visit = (node) => { nodes.push(node); ts.forEachChild(node, visit) }
  visit(file)
  return nodes
}
const cache = new Map()

function locate(id) {
  const parts = id.split('|')
  // `node|fN|Kind|ordinal` and `decl|fN|ordinal` index the same walk: a
  // declaration id is the node id of the declaration, minus the kind.
  const [identity, kind, ordinal] = parts[0] === 'decl' ? [parts[1], null, parts[2]] : [parts[1], parts[2], parts[3]]
  const file = byIdentity.get(identity)
  if (!file) return `${id} (no such file index)`
  if (!cache.has(identity)) cache.set(identity, ordinalsOf(file))
  const node = cache.get(identity)[Number.parseInt(ordinal, 10)]
  if (!node) return `${id} (ordinal out of range)`
  const at = file.getLineAndCharacterOfPosition(node.getStart(file))
  const text = node.getText(file).split('\n')[0].slice(0, 100)
  const actual = ts.SyntaxKind[node.kind]
  const mismatch = kind === null || actual === kind ? ` [${actual}]` : ` [walk says ${actual}]`
  return `${path.relative(process.cwd(), file.fileName)}:${at.line + 1}:${at.character + 1}${mismatch}  ${text}`
}

const ids = process.argv.slice(3)
if (ids.length > 0) { for (const id of ids) console.log(locate(id)); process.exit(0) }

// Filter mode: rewrite every NodeId found in the input stream.
const input = fs.readFileSync(0, 'utf8')
for (const line of input.split('\n')) {
  const found = line.match(/node\|f\d+\|[A-Za-z]+\|\d+/) ?? line.match(/decl\|f\d+\|\d+/)
  console.log(found ? `${line}\n      @ ${locate(found[0])}` : line)
}
