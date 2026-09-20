// node:path is a full reimplementation (pure string manipulation, no native
// binding), so this checks it two ways: exact-output parity against real
// Node's own `path.posix` for the documented edge cases, plus the target's
// own contract -- an explicit `nodeNotImplemented` refusal for `win32` and
// `matchesGlob` rather than a silently wrong answer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { posix as nodePosix } from 'node:path'
import vm from 'node:vm'

const modulePath = new URL('../runtime/node/path.ts', import.meta.url)
const source = readFileSync(modulePath, 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const code = stripTypeScriptTypes(source, { mode: 'strip', disableExperimentalWarning: true })

let notImplementedCalls = []
const context = vm.createContext({
  process: { cwd: () => '/home/user/project' },
  nodeNotImplemented(moduleName, memberName) {
    notImplementedCalls.push(`${moduleName}.${memberName}`)
    const error = new Error(`ERR_GEA_NODE_NOT_IMPLEMENTED: ${moduleName}.${memberName}`)
    error.code = 'ERR_GEA_NODE_NOT_IMPLEMENTED'
    throw error
  }
})
// The stripped `export { nodePathBasename as basename, ... }` block becomes a
// bare comma expression (no binding named `basename` survives it), so the
// result object below is built from the internal names it actually declares.
// The leading `;` matters: the module's last statement is `const win32 = {
// ... }` with no trailing semicolon, and without it ASI parses this whole
// thing as one statement -- the object literal *called* with `({...})` as
// its argument -- which reads `win32` while its own declaration is still
// initializing (a TDZ error), not two separate statements.
const path = vm.runInContext(
  `${code}\n;({
    basename: nodePathBasename, delimiter, dirname: nodePathDirname, extname: nodePathExtname,
    format: nodePathFormat, isAbsolute: nodePathIsAbsolute, join: nodePathJoin,
    matchesGlob: nodePathMatchesGlob, normalize: nodePathNormalize, parse: nodePathParse,
    posix, relative: nodePathRelative, resolve: nodePathResolve, sep,
    toNamespacedPath: nodePathToNamespacedPath, win32
  })`,
  context
)

// -- exact parity against real Node's path.posix for the documented edge cases --

assert.equal(path.join(), nodePosix.join())
assert.equal(path.join(), '.')
assert.equal(path.join('a', 'b'), nodePosix.join('a', 'b'))
assert.equal(path.join('/a', '../b'), nodePosix.join('/a', '../b'))
assert.equal(path.join('', 'a', '', 'b', ''), nodePosix.join('', 'a', '', 'b', ''))
assert.equal(path.join('a', 'b/'), nodePosix.join('a', 'b/'))
assert.equal(path.join('/', '..'), nodePosix.join('/', '..'))

for (const input of ['', '.', '..', '/', '//', '/a//b/../c', 'a/b/../../c', 'a/b/', './/a', '/a/b/']) {
  assert.equal(path.normalize(input), nodePosix.normalize(input), `normalize(${JSON.stringify(input)})`)
}

for (const [from, to] of [
  ['/a/b', '/a/c'],
  ['/a/b/c', '/a/b'],
  ['/a/b', '/a/b'],
  ['/', '/a/b'],
  ['a/b', 'a/c']
]) {
  assert.equal(path.relative(from, to), nodePosix.relative(from, to), `relative(${from}, ${to})`)
}

for (const input of ['/a/b', 'a', '/', '//a', 'a/b/', '.', '..']) {
  assert.equal(path.dirname(input), nodePosix.dirname(input), `dirname(${JSON.stringify(input)})`)
}

// basename with the trailing-slash and optional-suffix edge cases named in the task.
assert.equal(path.basename('/a/b/'), 'b')
assert.equal(path.basename('/a/b/'), nodePosix.basename('/a/b/'))
assert.equal(path.basename('/a/b.txt', '.txt'), nodePosix.basename('/a/b.txt', '.txt'))
assert.equal(path.basename('/a/b.txt', '.txt'), 'b')
assert.equal(path.basename('.txt', '.txt'), nodePosix.basename('.txt', '.txt'))
assert.equal(path.basename(''), nodePosix.basename(''))

// extname's documented `.hidden` dotfile case, plus the usual shapes.
assert.equal(path.extname('.hidden'), '')
for (const input of ['index.html', '.hidden', 'index.', 'index', '..bashrc', 'a.b.c', '/a/.b']) {
  assert.equal(path.extname(input), nodePosix.extname(input), `extname(${JSON.stringify(input)})`)
}

for (const input of ['/a', 'a', '', '//a', './a']) {
  assert.equal(path.isAbsolute(input), nodePosix.isAbsolute(input), `isAbsolute(${JSON.stringify(input)})`)
}

for (const input of ['/a/b/c.txt', 'c.txt', '/a/b/c', '.bashrc', '/', 'a/b/']) {
  // Spread into a plain object of the *outer* realm first: the vm context
  // has its own Object.prototype, and `assert/strict`'s deepEqual is
  // deepStrictEqual, which (unlike loose deepEqual) checks prototypes.
  assert.deepEqual({ ...path.parse(input) }, { ...nodePosix.parse(input) }, `parse(${JSON.stringify(input)})`)
}

for (const parsed of [{ dir: '/a/b', base: 'c.txt' }, { root: '/', name: 'c', ext: '.txt' }, { base: 'c.txt' }]) {
  assert.equal(path.format(parsed), nodePosix.format(parsed), `format(${JSON.stringify(parsed)})`)
}

assert.equal(path.sep, '/')
assert.equal(path.delimiter, ':')
assert.equal(path.toNamespacedPath('/a/b'), '/a/b')

// resolve() falls back to process.cwd() -- confirm it actually consults the
// shimmed cwd rather than assuming an absolute input.
assert.equal(path.resolve('a', 'b'), '/home/user/project/a/b')
assert.equal(path.resolve('/a', 'b'), '/a/b')
assert.equal(path.resolve('/a', '/b'), '/b')

// posix is the same implementation again, not a second copy.
assert.equal(path.posix.join, path.join)
assert.equal(path.posix.sep, '/')

// -- explicit refusals: win32 and matchesGlob must throw ERR_GEA_NODE_NOT_IMPLEMENTED, never silently alias to posix --

assert.throws(() => path.matchesGlob('/a/b', '*.js'), { code: 'ERR_GEA_NODE_NOT_IMPLEMENTED' })
assert.deepEqual(notImplementedCalls, ['node:path.matchesGlob'])

notImplementedCalls = []
assert.equal(path.win32.sep, '\\')
assert.equal(path.win32.delimiter, ';')
for (const [member, args] of [
  ['basename', ['/a/b']],
  ['dirname', ['/a/b']],
  ['extname', ['/a/b']],
  ['format', [{ base: 'a' }]],
  ['isAbsolute', ['/a']],
  ['join', ['a', 'b']],
  ['matchesGlob', ['/a', '*']],
  ['normalize', ['/a/b']],
  ['parse', ['/a/b']],
  ['relative', ['/a', '/b']],
  ['resolve', ['/a']],
  ['toNamespacedPath', ['/a']]
]) {
  assert.throws(() => path.win32[member](...args), { code: 'ERR_GEA_NODE_NOT_IMPLEMENTED' }, `win32.${member}`)
}
assert.deepEqual(
  notImplementedCalls.sort(),
  [
    'node:path.win32.basename',
    'node:path.win32.dirname',
    'node:path.win32.extname',
    'node:path.win32.format',
    'node:path.win32.isAbsolute',
    'node:path.win32.join',
    'node:path.win32.matchesGlob',
    'node:path.win32.normalize',
    'node:path.win32.parse',
    'node:path.win32.relative',
    'node:path.win32.resolve',
    'node:path.win32.toNamespacedPath'
  ].sort()
)

console.log('PASS: node:path matches Node posix semantics; win32/matchesGlob refuse explicitly')
