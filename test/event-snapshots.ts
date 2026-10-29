import assert from 'node:assert/strict'
import { appendEventSnapshot, coalesceUsageSnapshots, withCompactionTiming } from '../src/shared/eventSnapshots'
import type { UAEvent } from '../src/shared/types'

const events: UAEvent[] = []
const event = (seq: number, type: UAEvent['type'], state?: UAEvent['state'], id = 'reply'): UAEvent =>
  ({ sessionId: 's', seq, ts: 1000 + seq, type, state, payload: { id, turnId: 't', text: String(seq) } })
appendEventSnapshot(events, event(0, 'turn_started'))
for (let i = 1; i <= 10_000; i++) appendEventSnapshot(events, event(i, 'agent_message', 'running'))
assert.equal(events.length, 2, '10,000 cumulative updates retain one reply snapshot')
assert.equal(events[1].payload.text, '10000')
assert.equal(events[1].seq, 1, 'snapshot keeps the first timeline position')
appendEventSnapshot(events, event(10_001, 'tool_call', 'success', 'tool'))
appendEventSnapshot(events, event(10_002, 'agent_message', 'success'))
assert.equal(events.length, 3)
assert.equal(events[1].state, 'success')
assert.equal(events[2].type, 'tool_call', 'completed reply does not move past embedded tool cards')
appendEventSnapshot(events, event(10_003, 'turn_completed', 'success'))
appendEventSnapshot(events, event(10_004, 'user_message'))
appendEventSnapshot(events, event(10_005, 'agent_message', 'running'))
assert.equal(events.length, 6, 'a new user turn must not replace the previous reply')
appendEventSnapshot(events, event(10_006, 'approval_request', 'pending', 'question'))
appendEventSnapshot(events, event(10_007, 'approval_request', 'success', 'question'))
assert.equal(events.length, 8, 'approval transitions remain intact')
const noIds: UAEvent[] = []
appendEventSnapshot(noIds, { ...event(0, 'reasoning', 'running'), payload: {} })
appendEventSnapshot(noIds, { ...event(1, 'reasoning', 'running'), payload: {} })
assert.equal(noIds.length, 2, 'events without an identity must not merge')
const usage = (seq: number, turnId: string | undefined = 'turn-1', id: string | undefined = 'usage'): UAEvent => ({
  ...event(seq, 'system_notice', 'success'),
  payload: { kind: 'usage', id, turnId, usage: { inputTokens: seq, outputTokens: 1, cachedInputTokens: 0 } }
})
const usageUpdates = [usage(1), event(2, 'tool_call', 'success', 'read'), usage(3),
  event(4, 'turn_completed', 'success'), usage(5), usage(6, 'turn-2'),
  { ...usage(7), sessionId: 'another-session' },
  usage(8, 'turn-1', 'compaction-usage'),
  { ...usage(9), payload: { kind: 'usage_report', id: 'usage', turnId: 'turn-1' } },
  { ...usage(10), payload: { kind: 'usage', usage: { inputTokens: 10 } } },
  { ...usage(11), payload: { kind: 'usage', usage: { inputTokens: 11 } } },
  { ...usage(12), payload: { kind: 'usage', id: 'legacy', usage: { inputTokens: 12 } } },
  { ...usage(13), payload: { kind: 'usage', id: 'legacy', usage: { inputTokens: 13 } } }]
const saved = structuredClone(usageUpdates)
const normalized = coalesceUsageSnapshots(usageUpdates)
assert.deepEqual(normalized.map(e => e.seq), [5, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13],
  'late settlement replaces its turn; different turns/sessions, compaction, reports and unidentifiable usage remain independent')
assert.deepEqual(usageUpdates, saved, 'history normalization must not mutate saved events')
const usageBuffer: UAEvent[] = []
usageUpdates.forEach(e => appendEventSnapshot(usageBuffer, e))
assert.deepEqual(usageBuffer, normalized, 'live buffer and history use identical snapshot identities')

const compactStart = event(0, 'context_compaction', 'running', 'compact')
const compactProgress = withCompactionTiming(event(1000, 'context_compaction', 'running', 'compact'), compactStart)
assert.equal(compactProgress.payload.startedAt, 1000, '重复开始快照保留第一次开始时间')
assert.equal(compactStart.payload.startedAt, undefined, '不修改原事件')
for (const state of ['success', 'failed', 'cancelled'] as const) {
  const completed = withCompactionTiming(event(2500, 'context_compaction', state, 'compact'), compactProgress)
  assert.equal(completed.payload.durationMs, 2500, '终态耗时使用结束与首次开始的时间差')
  const repeated = withCompactionTiming(event(6000, 'context_compaction', state, 'compact'), completed)
  assert.equal(repeated.payload.durationMs, 2500, '重复终态通知不延长已完成的耗时')
}
const nativeDuration = { ...event(3000, 'context_compaction', 'success', 'compact'), payload: { id: 'compact', durationMs: 1234 } }
assert.equal(withCompactionTiming(nativeDuration, compactStart).payload.durationMs, 1234, '优先使用原生明确提供的耗时')
const legacy = event(5000, 'context_compaction', 'success', 'legacy')
assert.equal(withCompactionTiming(legacy), legacy, '没有开始时间时不推算历史耗时')
assert.equal(withCompactionTiming({ ...legacy, ts: 900 }, compactStart).payload.durationMs, 0, '时钟回退时耗时不为负数')
assert.equal(withCompactionTiming(events[0]), events[0], '普通事件保持原样')
console.log('event-snapshots: ok; 10,000 streaming snapshots → 1')
