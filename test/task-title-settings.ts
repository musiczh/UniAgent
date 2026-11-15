import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'

const directory = mkdtempSync(join(tmpdir(), 'task-title-settings-'))
try {
  const store = new AppSettingsStore(directory)
  assert.equal(store.get().taskTitleGeneration?.enabled, false, 'task title generation defaults to disabled')
  assert.equal(store.get().taskTitleGeneration?.agentId, undefined, 'default config stays unbound until the user selects an agent')
  assert.equal(store.get().quickRepliesEnabled, false, 'quick replies default to disabled')
  for (const [name, value] of Object.entries({
    legacy: JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false }),
    invalid: JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, taskTitleGeneration: { enabled: 'true' }, quickRepliesEnabled: 1 }),
    corrupt: '{',
    future: JSON.stringify({ schemaVersion: 2, autoUpdateAgentsOnLaunch: false, taskTitleGeneration: { enabled: true }, quickRepliesEnabled: true })
  })) {
    const path = join(directory, name)
    mkdirSync(path)
    writeFileSync(join(path, 'app-settings.json'), value)
    const settings = new AppSettingsStore(path)
    settings.set({ autoCheckUpdate: false })
    const restarted = new AppSettingsStore(path).get()
    assert.equal(restarted.taskTitleGeneration?.enabled, false, name + ' title default survives unrelated save')
    assert.equal(restarted.quickRepliesEnabled, false, name + ' reply default survives unrelated save')
    assert.equal(restarted.defaultTaskWorktree, false, name + ' worktree defaults off')
    assert.equal(restarted.autoSyncWorktree, false, name + ' sync defaults off')
    assert.equal(restarted.router?.enabled, false, name + ' router defaults off')
  }
  for (const title of [false, true]) for (const replies of [false, true]) {
    store.set({ taskTitleGeneration: { enabled: title }, quickRepliesEnabled: replies })
    store.set({ autoCheckUpdate: false })
    const restarted = new AppSettingsStore(directory).get()
    assert.equal(restarted.taskTitleGeneration?.enabled, title, 'preserve explicit title choice')
    assert.equal(restarted.quickRepliesEnabled, replies, 'preserve independent explicit reply choice')
  }
  store.set({ quickRepliesEnabled: false })
  assert.equal(new AppSettingsStore(directory).get().quickRepliesEnabled, false, 'reply toggle is durable and independent of title generation')

  const source = { kind: 'third-party' as const, sourceId: 'kimi-code' }
  store.set({
    autoCheckUpdate: false,
    taskTitleGeneration: {
      enabled: true,
      agentId: 'codex',
      model: 'uniagent-model:third-party:kimi-code:title-small',
      modelSource: source,
      effort: 'high'
    }
  })
  const restored = new AppSettingsStore(directory).get()
  assert.equal(restored.autoCheckUpdate, false)
  assert.equal(restored.quickRepliesEnabled, false, 'saving title model preserves the reply toggle')
  assert.deepEqual(restored.taskTitleGeneration, {
    enabled: true,
    agentId: 'codex',
    model: 'uniagent-model:third-party:kimi-code:title-small',
    modelSource: source,
    effort: 'high'
  }, 'settings keep the explicit selected model identity without fallback rewriting')

  store.set({ taskTitleGeneration: { enabled: false } })
  assert.deepEqual(new AppSettingsStore(directory).get().taskTitleGeneration, {
    enabled: false,
    agentId: 'codex',
    model: 'uniagent-model:third-party:kimi-code:title-small',
    modelSource: source,
    effort: 'high'
  }, 'disabling the feature preserves the last explicit model choice')

  store.set({ taskTitleGeneration: { agentId: 'grok', model: 'small', modelSource: undefined, effort: 'low' } })
  assert.deepEqual(new AppSettingsStore(directory).get().taskTitleGeneration, {
    enabled: false, agentId: 'grok', model: 'small', effort: 'low'
  }, 'switching Agent preserves the selected effort and explicitly clears the previous source')
  store.set({ taskTitleGeneration: { agentId: 'kimi', model: 'small', effort: undefined, kimiThinking: 'fast' } })
  assert.deepEqual(new AppSettingsStore(directory).get().taskTitleGeneration, {
    enabled: false, agentId: 'kimi', model: 'small', kimiThinking: 'fast'
  }, 'Kimi native Thinking survives restart and clears the common effort')

  store.set({ taskTitleGeneration: null })
  assert.deepEqual(new AppSettingsStore(directory).get().taskTitleGeneration, { enabled: false }, 'clearing restores the default-off unconfigured state')

  const invalidDirectory = join(directory, 'not-a-directory')
  writeFileSync(invalidDirectory, 'fixture')
  assert.throws(() => new AppSettingsStore(invalidDirectory).set({
    taskTitleGeneration: { enabled: true, agentId: 'codex', model: 'title-small' }
  }), /任务标题设置保存失败/)
  assert.equal(readFileSync(invalidDirectory, 'utf8'), 'fixture')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('task-title-settings: ok')
