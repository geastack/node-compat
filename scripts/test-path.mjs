// node:path is a full reimplementation (pure string manipulation, no native
// binding), so this checks it against real Node: `path.posix` and `path.win32`
// output for the documented edge cases, the host-selected default (posix on a
// posix host, win32 on Windows), plus the target's own contract -- an explicit
// `nodeNotImplemented` refusal for `matchesGlob` rather than a silently wrong
// answer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { posix as nodePosix, win32 as nodeWin32 } from 'node:path'
import vm from 'node:vm'

const modulePath = new URL('../runtime/node/path.ts', import.meta.url)
const source = readFileSync(modulePath, 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const code = stripTypeScriptTypes(source, { mode: 'strip', disableExperimentalWarning: true })

let notImplementedCalls = []
// The module as a given host loads it: `platform` is what the native
// `__gea_node_platform()` answers, `cwd` what `process.cwd()` does.
const loadPath = (platform, cwd) => {
  const context = vm.createContext({
    process: { cwd: () => cwd },
    __gea_node_platform: () => platform,
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
  return vm.runInContext(
    `${code}\n;({
    basename: nodePathBasename, delimiter, dirname: nodePathDirname, extname: nodePathExtname,
    format: nodePathFormat, isAbsolute: nodePathIsAbsolute, join: nodePathJoin,
    matchesGlob: nodePathMatchesGlob, normalize: nodePathNormalize, parse: nodePathParse,
    posix, relative: nodePathRelative, resolve: nodePathResolve, sep,
    toNamespacedPath: nodePathToNamespacedPath, win32
  })`,
    context
  )
}
const path = loadPath('linux', '/home/user/project')

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

// posix is the posix implementation again, whatever the host.
assert.equal(path.posix.join('a', 'b'), path.join('a', 'b'))
assert.equal(path.posix.sep, '/')

// -- exact parity against real Node's path.win32 --

const win32 = path.win32
assert.equal(win32.sep, '\\')
assert.equal(win32.delimiter, ';')
const windowsCwd = 'C:\\Users\\me\\project'
const nodeWin32Resolve = (...args) => {
  // Real Node consults its own cwd; give it ours by resolving against it.
  const absolute = args.some((arg) => nodeWin32.isAbsolute(arg) && /^[\\/]{2}|^[a-zA-Z]:[\\/]/.test(arg))
  return absolute ? nodeWin32.resolve(...args) : nodeWin32.resolve(windowsCwd, ...args)
}
const windowsPath = loadPath('win32', windowsCwd)
const samples = [
  '', '.', '..', '\\', '/', '\\\\', 'C:', 'C:\\', 'C:/', 'c:\\a\\..\\b', 'C:a\\b', 'C:\\a\\b\\', 'C:\\a\\\\b\\.\\c',
  'a/b\\c', '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\dir\\file.txt', '//server/share/x',
  '\\\\.\\PHYSICALDRIVE0', '\\\\?\\C:\\long\\path', 'dir\\file.tar.gz', '.hidden', '..bashrc', 'C:\\.hidden',
  'file.', 'a\\b\\..\\..\\..\\c', 'C:\\..\\..', 'foo:bar', '.\\x:y', 'c:/windows//system32/'
]
for (const input of samples) {
  for (const member of ['normalize', 'dirname', 'basename', 'extname', 'isAbsolute', 'toNamespacedPath']) {
    if (member === 'toNamespacedPath' && !/^[\\/]{2}[^\\/]|^[a-zA-Z]:[\\/]/.test(input)) continue
    assert.deepEqual(win32[member](input), nodeWin32[member](input), `win32.${member}(${JSON.stringify(input)})`)
  }
  assert.deepEqual({ ...win32.parse(input) }, { ...nodeWin32.parse(input) }, `win32.parse(${JSON.stringify(input)})`)
}
assert.equal(win32.basename('C:\\a\\b.txt', '.txt'), nodeWin32.basename('C:\\a\\b.txt', '.txt'))
assert.equal(win32.basename('b.txt', 'b.txt'), nodeWin32.basename('b.txt', 'b.txt'))
for (const args of [[], ['a', 'b'], ['C:\\a', '..\\b'], ['\\\\server', 'share'], ['//server', 'share', 'x'], ['', 'a', ''],
  ['C:', 'a'], ['a', 'C:\\b'], ['\\', 'a'], ['//', 'a']]) {
  assert.equal(win32.join(...args), nodeWin32.join(...args), `win32.join(${JSON.stringify(args)})`)
}
for (const args of [['a', 'b'], ['C:\\a', 'b'], ['C:\\a', 'D:\\b', 'c'], ['\\\\server\\share\\a', '..\\b'], ['C:\\a', '\\b'],
  ['/x/y', 'z'], ['C:\\a\\b\\..']]) {
  assert.equal(windowsPath.win32.resolve(...args), nodeWin32Resolve(...args), `win32.resolve(${JSON.stringify(args)})`)
}
for (const [from, to] of [
  ['C:\\a\\b', 'C:\\a\\c'], ['C:\\a\\b', 'C:\\a\\b\\c\\d'], ['C:\\a\\b\\c', 'C:\\a'], ['C:\\', 'C:\\a'], ['C:\\a', 'C:\\'],
  ['C:\\A\\b', 'c:\\a\\B\\c'], ['C:\\a', 'D:\\a'], ['\\\\server\\share\\a', '\\\\server\\share\\b'], ['C:\\a', 'C:\\a']
]) {
  assert.equal(win32.relative(from, to), nodeWin32.relative(from, to), `win32.relative(${from}, ${to})`)
}
for (const parsed of [{ dir: 'C:\\a', base: 'b.txt' }, { root: 'C:\\', name: 'b', ext: '.txt' }, { root: 'C:\\', name: 'b', ext: 'txt' }, { base: 'b' }]) {
  assert.equal(win32.format(parsed), nodeWin32.format(parsed), `win32.format(${JSON.stringify(parsed)})`)
}

// On a Windows host the default export IS win32, and resolve() starts at the
// process's (drive-letter) working directory.
assert.equal(windowsPath.sep, '\\')
assert.equal(windowsPath.delimiter, ';')
assert.equal(windowsPath.join('a', 'b'), 'a\\b')
assert.equal(windowsPath.resolve('a', 'b'), 'C:\\Users\\me\\project\\a\\b')
assert.equal(windowsPath.resolve('\\x'), 'C:\\x')
assert.equal(windowsPath.isAbsolute('C:\\x'), true)
assert.equal(windowsPath.posix.join('a', 'b'), 'a/b')

// -- explicit refusal: matchesGlob must throw ERR_GEA_NODE_NOT_IMPLEMENTED, never a partial matcher --

notImplementedCalls = []
assert.throws(() => path.matchesGlob('/a/b', '*.js'), { code: 'ERR_GEA_NODE_NOT_IMPLEMENTED' })
assert.throws(() => path.win32.matchesGlob('/a/b', '*.js'), { code: 'ERR_GEA_NODE_NOT_IMPLEMENTED' })
assert.deepEqual(notImplementedCalls, ['node:path.matchesGlob', 'node:path.win32.matchesGlob'])

console.log('PASS: node:path matches Node posix and win32 semantics and the host default; matchesGlob refuses explicitly')
