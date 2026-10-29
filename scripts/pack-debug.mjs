import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Debug 打包需要 Apple silicon macOS')
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const appName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build.productName + '.app'
const historical = join(root, 'release/mac-arm64', appName, 'Contents/Resources/app.asar')
const before = hash(historical)
const debugRoot = join(root, 'debug')
mkdirSync(debugRoot, { recursive: true })
// Keep every generated build local, including when this script runs in a fresh checkout.
if (!existsSync(join(debugRoot, '.gitignore'))) writeFileSync(join(debugRoot, '.gitignore'), '*\n')
const output = mkdtempSync(join(debugRoot, 'roundtable-' + new Date().toISOString().replace(/[:.]/g, '-') + '-'))
console.log('Debug output: ' + output)
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || 'pnpm ' + args.join(' ') + ' failed: ' + result.status)
}
try {
  run(['run', 'build'])
  run(['exec', 'electron-builder', '--dir', '--arm64', '--config.directories.output=' + output])
  const app = join(output, 'mac-arm64', appName)
  const asar = join(app, 'Contents/Resources/app.asar')
  if (!existsSync(asar) || statSync(asar).size === 0) throw new Error('Debug App 产物缺失')
  const manifest = { createdAt: new Date().toISOString(), app, asarSha256: hash(asar), historicalAsarSha256: before, historicalUnchanged: hash(historical) === before }
  writeFileSync(join(output, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (!manifest.historicalUnchanged) throw new Error('历史 release 产物发生变化')
  console.log('Debug App ready: ' + app)
  console.log('Historical release unchanged: ' + (before || '(absent)'))
} finally {
  if (hash(historical) !== before) throw new Error('历史 release 产物发生变化')
}
