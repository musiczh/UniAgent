import assert from 'node:assert/strict'
import type { UAEvent } from '../src/shared/types.ts'
import { mergeHydratedSessionEvents, mergeSessionEvent } from '../src/renderer/App.tsx'
import { contextCompactionAvailability } from '../src/renderer/contextCompaction.ts'
import { deriveActivity } from '../src/renderer/components/EventStream.tsx'

const event = (seq: number, type: UAEvent['type'], text: string): UAEvent => ({
  sessionId: 'session', seq, ts: seq, type, state: 'success', payload: { id: `event-${seq}`, text }
})

const snapshot = [
  event(1, 'user_message', 'prompt'),
  event(2, 'agent_message', 'snapshot-old')
]
const live = [
  event(2, 'agent_message', 'live-new'),
  event(3, 'reasoning', 'delta')
]

const merged = mergeHydratedSessionEvents(snapshot, live)
assert.deepEqual(merged.map(({ seq }) => seq), [1, 2, 3])
assert.equal(merged[1].payload.text, 'live-new', 'live state wins an overlapping snapshot seq')
assert.equal(merged[2].payload.text, 'delta', 'a delta received during hydration is retained')

const goal = event(4, 'goal_message', 'same text')
const ordinary = event(Number.MAX_SAFE_INTEGER, 'user_message', 'same text')
ordinary.payload.optimistic = true
const separateKinds = mergeHydratedSessionEvents([goal], [ordinary])
assert.equal(
  separateKinds.filter((item) => item.type === 'user_message' || item.type === 'goal_message').length,
  2,
  'an ordinary optimistic message must not be replaced by an equally worded Goal'
)
const lateGoal = event(4, 'goal_message', 'Goal')
assert.deepEqual(
  mergeSessionEvent([event(5, 'agent_message', 'reply')], lateGoal).map(({ seq }) => seq),
  [4, 5],
  'a confirmed Goal keeps its reserved timeline position when provider output arrived first'
)
const optimisticGoal = event(Number.MAX_SAFE_INTEGER, 'goal_message', 'Goal')
optimisticGoal.ts = 3
optimisticGoal.payload.optimistic = true
assert.deepEqual(
  mergeHydratedSessionEvents([lateGoal], [optimisticGoal]),
  [lateGoal],
  'hydration keeps the confirmed Goal when it arrives before its optimistic bubble'
)

// A steer message does not end the native turn or split an item's lifecycle.
for (const type of ['tool_call', 'command_exec', 'hook', 'file_change', 'reasoning', 'agent_message', 'context_compaction'] as const) {
  const running: UAEvent = {
    ...event(2, type, ''), state: 'running',
    payload: { id: `${type}-1`, name: 'sleep', command: 'pwd', eventName: 'preToolUse' }
  }
  for (const state of ['success', 'failed', 'cancelled'] as const) {
    for (const messageType of ['user_message', 'goal_message'] as const) {
      const terminal = { ...running, seq: 5, ts: 5, state }
      const beforeCompletion = [
        event(1, 'user_message', 'prompt'),
        running,
        event(3, messageType, 'follow-up'),
        { ...running, seq: 4, ts: 4 }
      ]
      const live = [...beforeCompletion, terminal].reduce<UAEvent[]>(
        (events, update) => mergeSessionEvent(events, update), []
      )
      const hydrated = mergeHydratedSessionEvents(beforeCompletion, [terminal])
      for (const events of [live, hydrated]) {
        assert.deepEqual(
          events.filter((item) => item.type === type).map((item) => item.state),
          [state],
          `${type} must settle across a ${messageType} in both live events and hydration`
        )
        assert.equal(deriveActivity(events), '正在思考…', 'finished items cannot remain the live activity')
        assert.equal(events.filter((item) => item.type === 'user_message' || item.type === 'goal_message').length, 2)
        if (type === 'context_compaction') {
          assert.equal(contextCompactionAvailability(true, 'idle', events, true).compacting, false)
          assert.equal(events.find(item => item.type === type)?.payload.startedAt, 2,
            '实时合并与历史恢复均保留插话前的压缩开始时间')
          assert.equal(events.find(item => item.type === type)?.payload.durationMs, 3,
            '压缩耗时不因插话或重复开始快照而缩短')
        }
      }
    }
  }
  const nextTurn = [
    event(1, 'user_message', 'prompt'),
    { ...running, state: 'success' as const },
    event(3, 'turn_completed', ''),
    event(4, 'user_message', 'new turn'),
    { ...running, seq: 5, ts: 5 }
  ]
  for (const events of [nextTurn.reduce<UAEvent[]>((events, update) => mergeSessionEvent(events, update), []), mergeHydratedSessionEvents(nextTurn, [])]) {
    assert.deepEqual(
      events.filter((item) => item.type === type).map((item) => item.state),
      ['success', 'running'],
      `a new turn reusing an id must preserve the previous completed ${type}`
    )
  }
}

for (const boundary of ['user_message', 'goal_message', 'turn_completed'] as const) {
  const priorWait: UAEvent = {
    ...event(2, 'queue_status', ''),
    payload: { id: 'goal-queue', queue: { state: 'ready', waitedMs: 60_000 } }
  }
  const resumedWait: UAEvent = {
    ...event(4, 'queue_status', ''), state: 'running',
    payload: { id: 'goal-queue', queue: { state: 'waiting', waitedMs: 60_000 } }
  }
  const ready: UAEvent = {
    ...event(5, 'queue_status', ''),
    payload: { id: 'goal-queue', queue: { state: 'ready', waitedMs: 65_000 } }
  }
  const snapshot = [event(1, 'goal_message', 'Goal'), priorWait, event(3, boundary, 'continue'), resumedWait]
  for (const events of [
    [...snapshot, ready].reduce<UAEvent[]>((events, update) => mergeSessionEvent(events, update), []),
    mergeHydratedSessionEvents(snapshot, [ready])
  ]) {
    assert.deepEqual(
      events.filter((item) => item.type === 'queue_status'),
      [priorWait, ready],
      `queue snapshots must merge within a segment and retain prior totals across ${boundary}`
    )
  }
}

const sleeping: UAEvent = {
  ...event(2, 'tool_call', ''), state: 'running', payload: { id: 'sleep-1', name: 'sleep' }
}
const otherTool: UAEvent = {
  ...event(3, 'tool_call', ''), state: 'running', payload: { id: 'other-tool', name: 'read_file' }
}
const activeTools = mergeHydratedSessionEvents([
  event(1, 'user_message', 'prompt'), sleeping, otherTool,
  event(4, 'user_message', 'follow-up')
], [])
assert.equal(deriveActivity(activeTools), '正在调用 read_file', 'a follow-up cannot hide a running tool')
const afterSleep = mergeSessionEvent(activeTools, { ...sleeping, seq: 5, ts: 5, state: 'success' })
assert.equal(deriveActivity(afterSleep), '正在调用 read_file', 'finishing sleep cannot clear another running tool')
assert.equal(activeTools.find((item) => item.payload.id === 'sleep-1')?.state, 'running', 'live merging cannot mutate the previous React state')
const afterTools = mergeSessionEvent(afterSleep, { ...otherTool, seq: 6, ts: 6, state: 'success' })
assert.equal(deriveActivity(afterTools), '正在思考…', 'sleep interrupted by a follow-up cannot leave stale activity')

console.log('hydration event merge: ok')

const firstReply = { ...event(11, 'agent_message', 'First'), ts: 1100, state: 'running' as const, payload: { id: 'stream-item', text: 'First' } }
const laterReply = { ...firstReply, seq: 14, ts: 1400, payload: { ...firstReply.payload, text: 'First complete' } }
assert.equal(mergeSessionEvent([firstReply, event(12, 'tool_call', 'dispatch')], laterReply)[0].ts, 1100, 'stream deltas keep replies before tasks dispatched after the first token')
