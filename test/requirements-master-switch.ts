// Run on request: node scripts/run-ts-test.mjs test/requirements-master-switch.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'

const directory = mkdtempSync(join(tmpdir(), 'uniagent-requirements-switch-'))
try {
  const store = new AppSettingsStore(directory)
  assert.equal(store.get().requirementsEnabled, false, 'new settings default to disabled')

  // 老配置没有 requirementsEnabled 键时使用关闭默认值，保留其它设置。
  writeFileSync(join(directory, 'app-settings.json'), JSON.stringify({
    schemaVersion: 1,
    autoUpdateAgentsOnLaunch: false,
    autoCheckUpdate: false
  }))
  assert.equal(store.get().requirementsEnabled, false, 'missing key must normalize to disabled')
  assert.equal(store.get().autoCheckUpdate, false, 'other fields stay intact')
  assert.equal(store.set({ autoCheckUpdate: false }).requirementsEnabled, false, 'unrelated patches keep the disabled default')
  assert.equal(store.set({ requirementsEnabled: 'yes' as unknown as boolean }).requirementsEnabled, false, 'invalid patches cannot enable requirements')

  assert.equal(store.set({ requirementsEnabled: false }).requirementsEnabled, false)
  assert.equal(store.get().requirementsEnabled, false, 'disabled value persists')
  assert.equal(store.get().autoCheckUpdate, false)

  assert.equal(store.set({ requirementsEnabled: true }).requirementsEnabled, true)
  assert.equal(new AppSettingsStore(directory).get().requirementsEnabled, true, 'explicit enable survives restart')

  // 非法值不覆盖既有设置。
  assert.equal(store.set({ requirementsEnabled: 'yes' as unknown as boolean }).requirementsEnabled, true)
  assert.equal(store.set({ autoCheckUpdate: true }).requirementsEnabled, true, 'unrelated patches keep the switch')

  writeFileSync(join(directory, 'app-settings.json'), JSON.stringify({
    schemaVersion: 1, autoUpdateAgentsOnLaunch: false, requirementsEnabled: 'yes'
  }))
  assert.equal(store.get().requirementsEnabled, false, 'invalid persisted value defaults to disabled')

  // 损坏文件回落默认值（含开关）。
  writeFileSync(join(directory, 'app-settings.json'), 'not-json')
  assert.equal(store.get().requirementsEnabled, false, 'corrupt file falls back to disabled')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('requirements-master-switch: ok')
