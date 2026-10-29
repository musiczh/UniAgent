import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifySqlite } from '../scripts/electron-sqlite.mjs'

const require = createRequire(import.meta.url)
const modulePath = require.resolve('better-sqlite3')
const binding = require.resolve('better-sqlite3/build/Release/better_sqlite3.node')
const directory = mkdtempSync(join(tmpdir(), 'ua-sqlite-check-'))
try {
  assert.equal((await verifySqlite(process.execPath, modulePath, binding)).modules, process.versions.modules)
  await assert.rejects(verifySqlite(process.execPath, modulePath, join(directory, 'missing.node')), /Cannot find module/)
  const invalid = join(directory, 'better_sqlite3.node')
  writeFileSync(invalid, 'invalid native module')
  writeFileSync(join(directory, '.forge-meta'), process.arch + '--' + process.versions.modules)
  await assert.rejects(verifySqlite(process.execPath, modulePath, invalid), /ERR_DLOPEN_FAILED/)
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('SQLite runtime probe: read/write, missing binding and invalid binding with stale metadata verified')
