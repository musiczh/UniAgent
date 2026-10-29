import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore } from '../src/main/sessionStore'
import { PresetStore } from '../src/main/presetStore'
import { computeCost, priceFor, type PricingFile } from '../src/main/pricing'
import { normalizeCodexRateLimits, rememberCodexRateLimits } from '../src/main/codexRateLimits'
import { orderedWindows, quotaView } from '../src/renderer/codexRateLimits'
import { displayedContextWindow } from '../src/renderer/contextWindow'
import type { Session, UAEvent } from '../src/shared/types'

// Regression risks: restart loses metadata/input; cache hits double-billed;
// sparse quota pushes erase a window; a model switch reuses the old context limit.
const root = mkdtempSync(join(tmpdir(), 'uniagent-core-regression-'))
try {
  const file = join(root, 'sessions.json')
  const store = new SessionStore(file)
  const base: Session = {
    id: 'one', title: '保留标题', createdAt: 1, updatedAt: 2, status: 'running',
    config: { agentId: 'codex', workdir: root, permissionMode: 'ask' },
    pinned: true, archived: true, titleLocked: true, nativeSessionId: 'native-one',
    pendingQueue: [{ id: 'q', prompt: '重启后发送', state: 'dispatching', attempts: 1, acceptedAt: 1 }]
  }
  store.saveOrThrow([base])
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const restored = new SessionStore(file).load()[0]
  assert.equal(restored.status, 'idle')
  assert.equal(restored.title, base.title)
  assert.equal(restored.nativeSessionId, base.nativeSessionId)
  assert.equal(restored.pinned && restored.archived && restored.titleLocked, true)
  assert.equal(restored.pendingQueue?.[0].state, 'pending')
  assert.equal(restored.pendingQueue?.[0].prompt, '重启后发送')
  for (const status of ['draft', 'running', 'queued', 'awaiting-approval', 'cancelling', 'completed', 'error', 'interrupted', 'cancelled'] as const) {
    store.saveOrThrow([{ ...base, status }])
    assert.equal(store.load()[0].status, ['completed', 'error', 'interrupted', 'cancelled'].includes(status) ? status : 'idle')
  }
  const valid = JSON.parse(readFileSync(file, 'utf8'))[0]
  writeFileSync(file, JSON.stringify([null, { ...valid, config: { agentId: 'codex' } }, valid, { ...valid, createdAt: -1 }]))
  assert.equal(store.load().length, 1, 'a corrupt sibling must not erase a valid session')
  store.saveOrThrow([{ ...base, config: { ...base.config, projectId: 'project-one', requirementId: 'req-one', requirementDir: '/runtime/req', requirementName: 'runtime' } }])
  const config = JSON.parse(readFileSync(file, 'utf8'))[0].config
  assert.equal(config.projectId, 'project-one')
  assert.equal(config.requirementId, 'req-one')
  assert.equal(config.workdir, undefined)
  assert.equal(config.requirementDir, undefined, 'transient paths are re-resolved, never persisted')
  writeFileSync(file, '{broken')
  assert.deepEqual(store.load(), [])

  const presetFile = join(root, 'presets.json')
  const presets = new PresetStore(presetFile)
  const seeded = presets.list()
  assert.ok(seeded.length > 0)
  const saved = presets.save({ id: '', name: '回归检查', prompt: '只检查临时项目', agentId: 'codex' })
  const custom = saved.find(p => p.name === '回归检查')!
  assert.ok(custom.id)
  presets.save({ ...custom, prompt: '修改后的模板' })
  assert.equal(new PresetStore(presetFile).list().length, seeded.length + 1)
  assert.equal(presets.list().find(p => p.id === custom.id)?.prompt, '修改后的模板')
  for (const preset of presets.list()) presets.remove(preset.id)
  assert.deepEqual(new PresetStore(presetFile).list(), [], 'deleting all templates must not reseed defaults')
  writeFileSync(presetFile, JSON.stringify([null, { id: 1 }, custom]))
  assert.deepEqual(presets.list(), [custom])
} finally { rmSync(root, { recursive: true, force: true }) }

const pricing: PricingFile = { version: 1, models: {
  exact: { input: 10, cachedInput: 1, output: 20, source: 'manual' },
  free: { input: 0, cachedInput: 0, output: 0, source: 'manual' },
  uncached: { input: 10, cachedInput: null, output: 20, source: 'auto' },
  unknown: { input: null, cachedInput: null, output: null, source: 'auto' },
  'claude-opus': { input: 1, cachedInput: 1, output: 1, source: 'auto' },
  opus: { input: 2, cachedInput: 1, output: 2, source: 'manual' }
} }
const usage = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 }
assert.equal(computeCost(usage, 'exact', pricing), 4.8)
assert.equal(computeCost(usage, 'uncached', pricing), 12)
assert.equal(computeCost(usage, 'free', pricing), 0)
assert.equal(computeCost(usage, 'unknown', pricing), null)
assert.equal(computeCost(usage, undefined, pricing), null)
assert.equal(computeCost({ ...usage, outputTokens: NaN }, 'exact', pricing), null)
assert.equal(priceFor('claude-opus-4-8', pricing), pricing.models.opus)
assert.equal(priceFor('claude-opus', pricing), pricing.models['claude-opus'], 'exact price beats aliases')

const now = Date.UTC(2026, 8, 20, 4)
const primary = { usedPercent: 80, windowMinutes: 300, resetsAt: now / 1000 + 3600 }
const weekly = { usedPercent: 95, windowMinutes: 10080, resetsAt: now / 1000 - 1 }
assert.equal(normalizeCodexRateLimits(null), null)
assert.equal(normalizeCodexRateLimits({}), null)
const raw = normalizeCodexRateLimits({ primary: { used_percent: 80, window_minutes: 300, resets_at: primary.resetsAt }, plan_type: 'plus' }, now)!
assert.deepEqual(raw.primary, primary)
rememberCodexRateLimits(raw)
const sparse = rememberCodexRateLimits({ secondary: weekly, capturedAt: now + 1 })
assert.deepEqual(sparse.primary, primary)
assert.deepEqual(orderedWindows(sparse), [primary, weekly])
assert.equal(quotaView(primary, now).level, 'warn')
assert.equal(quotaView(weekly, now).level, 'danger')
assert.equal(quotaView(weekly, now).resetRelative, '即将刷新')
assert.equal(quotaView(primary, now).resetRelative, '约 1 小时后刷新')
for (const [usedPercent, remaining] of [[-1, 100], [101, 0], [NaN, 100]]) {
  assert.equal(quotaView({ ...primary, usedPercent }, now).remainPercent, remaining)
}
// 额度耗尽后推送全 null 空快照：normalize 判为无信息，remember 保留最近已知窗口。
assert.equal(normalizeCodexRateLimits({ primary: null, secondary: null, plan_type: null }), null)
assert.deepEqual(rememberCodexRateLimits({ primary: null, capturedAt: now + 2 }).primary, primary)
const events: UAEvent[] = [
  { sessionId: 'one', seq: 1, ts: 1, type: 'system_notice', payload: { usage: { contextWindow: 100_000 } } },
  { sessionId: 'one', seq: 2, ts: 2, type: 'user_message', payload: { text: 'new turn' } }
]
assert.equal(displayedContextWindow(events, 'running', 200_000), 200_000)
events.push({ sessionId: 'one', seq: 3, ts: 3, type: 'system_notice', payload: { usage: { contextWindow: 300_000 } } })
assert.equal(displayedContextWindow(events, 'running', 200_000), 300_000)
assert.equal(displayedContextWindow(events, 'idle', 200_000), 200_000)
assert.equal(displayedContextWindow(events, 'running', 200_000, 3), 200_000)
console.log('core regression: persistence, presets, billing, quota and context boundaries ok')
