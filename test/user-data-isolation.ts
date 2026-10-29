import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'
import { resolveUserDataHome } from '../src/main/userData.ts'

const previous = process.env.UNIAGENT_USER_DATA
const directory = mkdtempSync(join(tmpdir(), 'uniagent-user-data-'))
try {
  delete process.env.UNIAGENT_USER_DATA
  assert.equal(resolveUserDataHome('/legacy-default'), '/legacy-default')
  process.env.UNIAGENT_USER_DATA = '/isolated-home'
  assert.equal(resolveUserDataHome('/legacy-default'), '/isolated-home')

  writeFileSync(join(directory, 'app-settings.json'), JSON.stringify({
    schemaVersion: 1,
    autoUpdateAgentsOnLaunch: false
  }))
  const store = new AppSettingsStore(directory)
  assert.equal(store.get().autoCheckUpdate, true)
  assert.equal(store.set({ autoCheckUpdate: false }).autoCheckUpdate, false)
} finally {
  if (previous === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previous
  rmSync(directory, { recursive: true, force: true })
}

console.log('user-data-isolation: ok')
