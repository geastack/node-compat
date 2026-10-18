import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PIN = {
  repository: 'nestjs/nest',
  branch: 'feat/platform-node',
  commit: '2b10fb228353fcaedd2817cc22f89ad1cca9a900',
  version: '12.1.3',
  packages: ['common', 'core', 'platform-node']
}

const root = path.resolve(import.meta.dirname, '../..')
const vendorDir = path.join(root, 'vendor')
const sourceDir = path.join(vendorDir, 'nest-src')
const sourceFile = path.join(vendorDir, 'SOURCE')
const nestDir = path.resolve(process.env.GEA_NEST_DIR ?? path.join(root, '..', 'nest'))
const check = process.argv.includes('--check')

const tarball = (name) => path.join(vendorDir, `nestjs-${name}-${PIN.version}.tgz`)
const sourceText = () =>
  `${PIN.repository} branch ${PIN.branch} commit ${PIN.commit}\n` +
  `built by tools/nest/build-platform-node.mjs from a detached worktree of that commit: ` +
  `npm install --legacy-peer-deps && npm run build, then npm pack in packages/{${PIN.packages.join(',')}}\n`

const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(' ')}  (${path.relative(root, cwd) || '.'})`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}
const git = (args, cwd = nestDir) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const fail = (message) => {
  console.error(`build-platform-node: ${message}`)
  process.exit(1)
}

if (check) {
  const missing = PIN.packages.map(tarball).filter((file) => !fs.existsSync(file))
  if (missing.length > 0) fail(`missing ${missing.map((file) => path.relative(root, file)).join(', ')}; run without --check to build them`)
  if (!fs.existsSync(sourceFile) || fs.readFileSync(sourceFile, 'utf8') !== sourceText()) fail(`${path.relative(root, sourceFile)} does not match the pin ${PIN.commit}`)
  console.log(`ok: ${PIN.packages.length} tarballs at ${PIN.commit.slice(0, 7)}`)
  process.exit(0)
}

if (!fs.existsSync(path.join(nestDir, '.git'))) fail(`no nest clone at ${nestDir} (set GEA_NEST_DIR)`)
let type = ''
try {
  type = git(['cat-file', '-t', PIN.commit])
} catch {}
if (type !== 'commit') fail(`${nestDir} does not contain commit ${PIN.commit}; fetch ${PIN.repository} ${PIN.branch} into it first`)

fs.mkdirSync(vendorDir, { recursive: true })
if (fs.existsSync(path.join(sourceDir, '.git'))) {
  const head = git(['rev-parse', 'HEAD'], sourceDir)
  if (head !== PIN.commit) fail(`${path.relative(root, sourceDir)} is at ${head}, not the pin; remove it (git -C ${nestDir} worktree remove --force ${sourceDir}) and rerun`)
} else {
  run('git', ['worktree', 'add', '--detach', sourceDir, PIN.commit], nestDir)
}

run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], sourceDir)
run('npm', ['run', 'build'], sourceDir)

for (const name of PIN.packages) {
  const packageDir = path.join(sourceDir, 'packages', name)
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  if (manifest.name !== `@nestjs/${name}` || manifest.version !== PIN.version) fail(`${name} is ${manifest.name}@${manifest.version}, expected @nestjs/${name}@${PIN.version}`)
  run('npm', ['pack', '--pack-destination', vendorDir], packageDir)
  if (!fs.existsSync(tarball(name))) fail(`npm pack did not produce ${path.relative(root, tarball(name))}`)
}

fs.writeFileSync(sourceFile, sourceText())
console.log(`packed ${PIN.packages.map((name) => path.relative(root, tarball(name))).join(', ')}`)
