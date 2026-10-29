import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'

function writeSettings(directory: string, idleThresholdSec?: number): AppSettingsStore {
  writeFileSync(join(directory, 'app-settings.json'), JSON.stringify({
    schemaVersion: 1,
    autoUpdateAgentsOnLaunch: false,
    feishu: {
      enabled: true,
      appId: '',
      appSecret: '',
      notifyOnlyWhenLocked: true,
      ...(idleThresholdSec === undefined ? {} : { idleThresholdSec })
    }
  }))
  return new AppSettingsStore(directory)
}

const directory = mkdtempSync(join(tmpdir(), 'uniagent-feishu-settings-'))
try {
  assert.equal(
    writeSettings(directory).get().feishu?.idleThresholdSec,
    300,
    'missing idle threshold defaults to five minutes'
  )
  assert.equal(
    writeSettings(directory, 90).get().feishu?.idleThresholdSec,
    300,
    'the legacy ninety-second default migrates to five minutes'
  )
  assert.equal(
    writeSettings(directory, 0).get().feishu?.idleThresholdSec,
    0,
    'zero disables idle-time notification without disabling lock or display-sleep notification'
  )
  assert.equal(
    writeSettings(directory, 600).get().feishu?.idleThresholdSec,
    600,
    'a user-selected idle threshold is preserved'
  )
  // 需求 — the bound话题群 (notifyChatId/Name) survives sanitize on read and on a
  // shallow patch; clearing it (empty string) drops the binding → private-chat fallback.
  const store = writeSettings(directory)
  const bound = store.set({ feishu: { notifyChatId: 'oc_abc', notifyChatName: '发布通知群' } })
  assert.equal(bound.feishu?.notifyChatId, 'oc_abc', 'notifyChatId persists through a patch')
  assert.equal(bound.feishu?.notifyChatName, '发布通知群', 'notifyChatName persists through a patch')
  assert.equal(store.get().feishu?.notifyChatId, 'oc_abc', 'the binding is read back from disk')
  assert.equal(store.get().feishu?.notifyChatType, 'group', 'legacy group targets retain their type')
  store.set({ feishu: { notifyChatId: 'oc_private', notifyChatType: 'private', notifyChatName: '' } })
  assert.equal(new AppSettingsStore(directory).get().feishu?.notifyChatType, 'private', 'a private target survives restart without a session')
  const unbound = store.set({ feishu: { notifyChatId: '', notifyChatName: '' } })
  assert.equal(unbound.feishu?.notifyChatId, undefined, 'an empty notifyChatId drops the binding')
  assert.equal(unbound.feishu?.notifyChatName, undefined, 'an empty notifyChatName drops the binding')
  assert.equal(unbound.feishu?.notifyChatType, undefined, 'an unbound target has no stale type')
  store.set({ feishu: { appId: 'cli_remote', appSecret: 'remote-fixture' } })
  store.set({ assistantFeishu: { enabled: true, appId: 'cli_assistant', appSecret: 'assistant-fixture' } })
  assert.equal(store.get().feishu?.appId, 'cli_remote')
  store.set({ feishu: { notifyChatId: 'oc_old', notifyChatType: 'private' } })
  store.set({ feishu: { appId: 'cli_replacement' } })
  assert.equal(store.get().feishu?.notifyChatId, undefined, 'changing bots clears the previous bot destination')
  store.set({ feishu: { appId: 'cli_remote' } })
  assert.equal(store.get().assistantFeishu?.appId, 'cli_assistant')
  assert.throws(() => store.set({ assistantFeishu: { appId: 'cli_remote' } }), /独立的飞书机器人/)
  assert.equal(store.get().assistantFeishu?.appId, 'cli_assistant', 'invalid rebind preserves the previous bot')
  store.set({ assistantFeishu: null })
  assert.equal(store.get().assistantFeishu, undefined)
  assert.equal(store.get().feishu?.appId, 'cli_remote', 'unbinding the assistant keeps remote-control credentials')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('feishu-notification-settings: ok')
