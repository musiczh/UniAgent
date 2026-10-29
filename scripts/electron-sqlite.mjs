import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cleanupRendererPackage } from './package-files.mjs'

const execFileAsync = promisify(execFile)
const probe = `
let db
try {
  const assert = require('node:assert/strict')
  const Database = require(process.argv[1])
  db = new Database(':memory:', { nativeBinding: process.argv[2] })
  db.exec('CREATE TABLE probe (value TEXT NOT NULL)')
  db.prepare('INSERT INTO probe VALUES (?)').run('sqlite-ready')
  assert.equal(db.prepare('SELECT value FROM probe').get().value, 'sqlite-ready')
  console.log(JSON.stringify({ electron: process.versions.electron, modules: process.versions.modules }))
} catch (error) {
  console.error(error.code + ': ' + error.message)
  process.exitCode = 1
} finally { db?.close() }
`

export async function verifySqlite(executable, modulePath, nativeBinding) {
  const { stdout } = await execFileAsync(executable, ['-e', probe, modulePath, nativeBinding], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, timeout: 20_000, maxBuffer: 64 * 1024
  }).catch(error => { throw new Error('SQLite runtime verification failed: ' + (error.stderr?.trim() || error.message)) })
  return JSON.parse(stdout.trim())
}

export async function beforeBuild({ appDir, electronVersion, arch }) {
  const require = createRequire(join(appDir, 'package.json'))
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const { rebuild } = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/rebuild')
  // Node test rebuilds can leave Electron's .forge-meta behind with a stale ABI.
  await rebuild({ buildPath: appDir, electronVersion, arch, onlyModules: ['better-sqlite3'], force: true })
  return true
}

export async function afterPack({ appOutDir, packager }) {
  try {
    const contents = join(appOutDir, packager.appInfo.productFilename + '.app', 'Contents')
    const runtime = await verifySqlite(
      join(contents, 'MacOS', packager.appInfo.productFilename),
      join(contents, 'Resources/app.asar/node_modules/better-sqlite3'),
      join(contents, 'Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
    )
    console.log(`Packaged SQLite read/write verified: Electron ${runtime.electron}, ABI ${runtime.modules}`)
  } finally { await cleanupRendererPackage(packager) }
}
