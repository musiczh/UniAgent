import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/shared/subAgentLifecycle.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const {
  SubAgentDispatchTracker,
  finalizeHistoricalSubAgent,
  formatSubAgentElapsed,
  historicalTimestamp,
  isSubAgentGenerationAdvance,
  mergeSubAgentSnapshot,
  reduceHistoricalSubAgent,
  nativeSubAgentName,
  readableSubAgentInput,
  subAgentTaskSummary
} = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

assert.equal(nativeSubAgentName({ agentNickname: '  Dirac  ', name: 'fallback' }), 'Dirac')
assert.equal(nativeSubAgentName({ source: { subagent: { thread_spawn: { agent_nickname: 'Curie' } } } }), 'Curie')
assert.equal(nativeSubAgentName({ agentPath: '/agents/review.md' }), 'review')
assert.equal(nativeSubAgentName({ agentNickname: ' ', name: '  review  ' }), 'review')
for (const value of [undefined, null, {}, { agentNickname: 42 }, { agentPath: '   ' }]) {
  assert.equal(nativeSubAgentName(value), undefined)
}
assert.equal(subAgentTaskSummary('  生成最终报告 v2。不要修改源码。\n其它约束  '), '生成最终报告 v2')
assert.equal(subAgentTaskSummary('Review   the parser\nDo not edit files'), 'Review the parser')
assert.equal(subAgentTaskSummary('😀'.repeat(40)), '😀'.repeat(32) + '…')
assert.equal(subAgentTaskSummary(' \n '), '')
assert.equal(subAgentTaskSummary(), '')
const encryptedInput = `gAAAAA${'B'.repeat(92)}==`
for (const input of [undefined, null, {}, 42, '', ' \n ', encryptedInput,
  encryptedInput.replace(/=+$/, ''), ` \n${encryptedInput}\n `]) {
  assert.equal(readableSubAgentInput(input), undefined, 'empty or opaque inputs must be omitted')
}
assert.equal(subAgentTaskSummary(encryptedInput), '')
for (const input of ['检查接口实现', '  Review the parser\nKeep formatting  ', 'A'.repeat(128),
  'gAAAA', `解释这个字符串：${encryptedInput}`]) {
  assert.equal(readableSubAgentInput(input), input, 'readable instructions must retain their original formatting')
}

const T1 = Date.parse('2026-08-21T00:00:00.000Z')
const T2 = Date.parse('2026-08-21T00:00:05.000Z')
const T3 = Date.parse('2026-08-21T00:00:12.000Z')
const T4 = Date.parse('2026-08-21T00:00:20.000Z')
const T5 = Date.parse('2026-08-21T00:00:31.000Z')
const T6 = Date.parse('2026-08-21T00:00:40.000Z')

assert.equal(historicalTimestamp('2026-08-21T00:00:00.000Z'), T1, 'ISO timestamps must parse')
assert.equal(historicalTimestamp(T2), T2, 'numeric timestamps must be preserved')
for (const invalid of ['', 'not-a-timestamp', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
  assert.equal(historicalTimestamp(invalid), undefined, `invalid timestamp ${String(invalid)} must be ignored`)
}

const historicalDispatches = new SubAgentDispatchTracker()
let historical = reduceHistoricalSubAgent(undefined, {
  agentThreadId: 'history-child',
  kind: 'started',
  occurredAt: T1,
  eventId: 'history-dispatch-1',
  name: 'history-worker'
}, undefined, historicalDispatches)
historical = reduceHistoricalSubAgent(historical, {
  agentThreadId: 'history-child',
  kind: 'progress',
  occurredAt: T2
}, undefined, historicalDispatches)
historical = reduceHistoricalSubAgent(historical, {
  agentThreadId: 'history-child',
  kind: 'completed',
  occurredAt: T3
}, undefined, historicalDispatches)
assert.equal(historical.status, 'completed')
assert.equal(historical.startedAt, T1, 'history updates must preserve the generation start')
assert.equal(historical.endedAt, T3, 'the terminal activity timestamp must become endedAt')
assert.equal(historical.generation, 1)
assert.equal(historical.dispatchId, 'history-dispatch-1')
const historicalGeneration2 = reduceHistoricalSubAgent(historical, {
  agentThreadId: 'history-child',
  kind: 'started',
  occurredAt: T4,
  eventId: 'history-dispatch-2',
  name: 'history-worker'
}, undefined, historicalDispatches)
assert.equal(historicalGeneration2.status, 'running', 'historical redispatch must reopen a terminal thread')
assert.equal(historicalGeneration2.generation, 2)
assert.equal(historicalGeneration2.startedAt, T4)
assert.equal(historicalGeneration2.endedAt, undefined)
const staleHistoricalDispatch = reduceHistoricalSubAgent(historicalGeneration2, {
  agentThreadId: 'history-child',
  kind: 'started',
  occurredAt: T5,
  eventId: 'history-dispatch-1',
  name: 'history-worker'
}, undefined, historicalDispatches)
assert.strictEqual(staleHistoricalDispatch, historicalGeneration2, 'an old replayed dispatch id must stay stale')

const interactionDispatches = new SubAgentDispatchTracker()
let historicalInteraction = reduceHistoricalSubAgent(undefined, {
  agentThreadId: 'history-interacted-child',
  kind: 'started',
  occurredAt: T1,
  eventId: 'history-spawn'
}, undefined, interactionDispatches)
historicalInteraction = reduceHistoricalSubAgent(historicalInteraction, {
  agentThreadId: 'history-interacted-child',
  kind: 'interacted',
  occurredAt: T2,
  eventId: 'history-send-input'
}, undefined, interactionDispatches)
assert.equal(historicalInteraction.status, 'running')
assert.equal(historicalInteraction.generation, 1, 'an appended question must stay in the running generation')
assert.equal(historicalInteraction.dispatchId, 'history-spawn')
assert.equal(historicalInteraction.startedAt, T1, 'an appended question must preserve elapsed time')
assert.equal(historicalInteraction.tool, 'interacted')
const duplicateHistoricalInteraction = reduceHistoricalSubAgent(historicalInteraction, {
  agentThreadId: 'history-interacted-child',
  kind: 'interacted',
  occurredAt: T3,
  eventId: 'history-send-input'
}, undefined, interactionDispatches)
assert.equal(duplicateHistoricalInteraction.generation, 1, 'duplicate historical interactions must stay in the active generation')
assert.equal(duplicateHistoricalInteraction.startedAt, T1)
const laterHistoricalInteraction = reduceHistoricalSubAgent(duplicateHistoricalInteraction, {
  agentThreadId: 'history-interacted-child',
  kind: 'interacted',
  occurredAt: T4,
  eventId: 'history-send-input-2'
}, undefined, interactionDispatches)
assert.equal(laterHistoricalInteraction.generation, 1)
assert.equal(laterHistoricalInteraction.startedAt, T1)
const replayedMiddleInteraction = reduceHistoricalSubAgent(laterHistoricalInteraction, {
  agentThreadId: 'history-interacted-child',
  kind: 'interacted',
  occurredAt: T5,
  eventId: 'history-send-input'
}, undefined, interactionDispatches)
assert.equal(replayedMiddleInteraction.generation, 1)
assert.equal(replayedMiddleInteraction.dispatchId, 'history-spawn')
assert.equal(replayedMiddleInteraction.startedAt, T1)

const terminalCorrelation = new SubAgentDispatchTracker()
let correlatedHistory = reduceHistoricalSubAgent(undefined, {
  agentThreadId: 'correlated-child',
  kind: 'started',
  occurredAt: T1,
  eventId: 'dispatch-a'
}, undefined, terminalCorrelation)
correlatedHistory = reduceHistoricalSubAgent(correlatedHistory, {
  agentThreadId: 'correlated-child',
  kind: 'interrupted',
  occurredAt: T2,
  eventId: 'terminal-a'
}, undefined, terminalCorrelation)
correlatedHistory = reduceHistoricalSubAgent(correlatedHistory, {
  agentThreadId: 'correlated-child',
  kind: 'interacted',
  occurredAt: T3,
  eventId: 'dispatch-b'
}, undefined, terminalCorrelation)
const delayedTerminalA = reduceHistoricalSubAgent(correlatedHistory, {
  agentThreadId: 'correlated-child',
  kind: 'interrupted',
  occurredAt: T2,
  eventId: 'terminal-a'
}, undefined, terminalCorrelation)
assert.strictEqual(
  delayedTerminalA,
  correlatedHistory,
  'a duplicate terminal activity must remain correlated with its original generation'
)
assert.equal(delayedTerminalA.status, 'running')
assert.equal(delayedTerminalA.generation, 2)

const outOfOrderDispatches = new SubAgentDispatchTracker()
let orderedHistory = reduceHistoricalSubAgent(undefined, {
  agentThreadId: 'out-of-order-child',
  kind: 'started',
  occurredAt: T1,
  eventId: 'dispatch-a'
}, undefined, outOfOrderDispatches)
orderedHistory = reduceHistoricalSubAgent(orderedHistory, {
  agentThreadId: 'out-of-order-child',
  kind: 'completed',
  occurredAt: T2,
  eventId: 'terminal-a'
}, undefined, outOfOrderDispatches)
orderedHistory = reduceHistoricalSubAgent(orderedHistory, {
  agentThreadId: 'out-of-order-child',
  kind: 'interacted',
  occurredAt: T3,
  eventId: 'dispatch-c'
}, undefined, outOfOrderDispatches)
const unseenButOlderDispatch = reduceHistoricalSubAgent(orderedHistory, {
  agentThreadId: 'out-of-order-child',
  kind: 'interacted',
  occurredAt: T2,
  eventId: 'dispatch-b'
}, undefined, outOfOrderDispatches)
assert.strictEqual(
  unseenButOlderDispatch,
  orderedHistory,
  'an unseen delayed dispatch must not become current by encounter order'
)
assert.equal(outOfOrderDispatches.current('out-of-order-child')?.dispatchId, 'dispatch-c')

const finalized = finalizeHistoricalSubAgent(
  { agentThreadId: 'dangling-child', status: 'running', startedAt: T2 },
  T4
)
assert.ok(finalized)
assert.equal(finalized.status, 'completed')
assert.equal(finalized.endedAt, T4, 'EOF fallback must use the last real rollout timestamp')

const clamped = finalizeHistoricalSubAgent(
  { agentThreadId: 'clock-skew-child', status: 'running', startedAt: T3 },
  T2
)
assert.ok(clamped)
assert.equal(clamped.endedAt, T3, 'EOF fallback must never end before the child started')

const terminal = {
  agentThreadId: 'live-child',
  status: 'completed',
  generation: 1,
  dispatchId: 'dispatch-1',
  prompt: 'first task',
  message: 'done',
  startedAt: T1,
  endedAt: T3
}
const ordinaryLateTick = mergeSubAgentSnapshot(
  terminal,
  { agentThreadId: 'live-child', status: 'running', message: 'ordinary late tick' },
  T4
)
assert.equal(ordinaryLateTick.status, 'completed', 'an unversioned running tick must not resurrect a terminal child')
assert.equal(ordinaryLateTick.endedAt, T3)

const generation2 = mergeSubAgentSnapshot(
  ordinaryLateTick,
  {
    agentThreadId: 'live-child',
    status: 'running',
    tool: 'sendInput',
    generation: 2,
    dispatchId: 'dispatch-2',
    prompt: 'follow-up task',
    startedAt: T4
  },
  T4
)
assert.equal(generation2.status, 'running', 'an explicit newer dispatch must reopen the child')
assert.equal(generation2.generation, 2)
assert.equal(generation2.dispatchId, 'dispatch-2')
assert.equal(generation2.prompt, 'follow-up task')
assert.equal(generation2.startedAt, T4)
assert.equal(generation2.endedAt, undefined, 'a reopened generation must clear the prior endedAt')
assert.equal(generation2.message, undefined, 'a reopened generation must not leak the prior message')

const staleGeneration1 = mergeSubAgentSnapshot(
  generation2,
  {
    agentThreadId: 'live-child',
    status: 'completed',
    generation: 1,
    dispatchId: 'dispatch-1',
    prompt: 'stale task',
    endedAt: T5
  },
  T5
)
assert.strictEqual(staleGeneration1, generation2, 'a stale generation must be ignored wholesale')
const unversionedLateTick = mergeSubAgentSnapshot(
  generation2,
  { agentThreadId: 'live-child', status: 'completed', prompt: 'legacy stale task', endedAt: T5 },
  T5
)
assert.strictEqual(
  unversionedLateTick,
  generation2,
  'an unversioned snapshot must not mutate an active versioned generation'
)

const sameGenerationTerminal = mergeSubAgentSnapshot(
  generation2,
  { agentThreadId: 'live-child', status: 'completed', generation: 2, endedAt: T5, message: 'done again' },
  T5
)
const sameGenerationLateTick = mergeSubAgentSnapshot(
  sameGenerationTerminal,
  { agentThreadId: 'live-child', status: 'running', generation: 2, message: 'late generation-2 tick' },
  T6
)
assert.equal(sameGenerationLateTick.status, 'completed', 'a same-generation late tick must preserve terminal state')
assert.equal(sameGenerationLateTick.startedAt, T4)
assert.equal(sameGenerationLateTick.endedAt, T5)

const interruptedGeneration = mergeSubAgentSnapshot(
  generation2,
  { agentThreadId: 'live-child', status: 'interrupted', generation: 2, endedAt: T5 },
  T5
)
const parentCleanup = mergeSubAgentSnapshot(
  interruptedGeneration,
  { agentThreadId: 'live-child', status: 'completed', generation: 2, endedAt: T6 },
  T6
)
assert.equal(parentCleanup.status, 'interrupted', 'parent completion must not replace the first terminal outcome')
assert.equal(parentCleanup.endedAt, T5, 'parent completion must not extend a terminal generation')

const missingChild = mergeSubAgentSnapshot(
  undefined,
  { agentThreadId: 'missing-child', status: 'notFound', generation: 1 },
  T5
)
const missingChildLateTick = mergeSubAgentSnapshot(
  missingChild,
  { agentThreadId: 'missing-child', status: 'running', generation: 1 },
  T6
)
assert.equal(missingChild.endedAt, T5, 'notFound must latch its terminal timestamp')
assert.equal(missingChildLateTick.status, 'notFound', 'notFound must reject same-generation running ticks')
assert.equal(missingChildLateTick.endedAt, T5)
const historicalNotFound = reduceHistoricalSubAgent(undefined, {
  agentThreadId: 'historical-missing-child',
  kind: 'not_found',
  occurredAt: T5,
  eventId: 'missing-activity'
})
assert.equal(historicalNotFound.status, 'notFound', 'historical not_found must remain terminal')
assert.equal(historicalNotFound.endedAt, T5)

const tracker = new SubAgentDispatchTracker()
const firstDispatch = tracker.activate('tracked-child', 'dispatch-a', T1)
const duplicateDispatch = tracker.activate('tracked-child', 'dispatch-a', T2)
assert.strictEqual(duplicateDispatch, firstDispatch, 'the same dispatch id must reuse its original stamp')
assert.deepEqual(firstDispatch, { dispatchId: 'dispatch-a', generation: 1, startedAt: T1 })
const nextDispatch = tracker.activate('tracked-child', 'dispatch-b', T2)
assert.deepEqual(nextDispatch, { dispatchId: 'dispatch-b', generation: 2, startedAt: T2 })
assert.strictEqual(tracker.current('tracked-child'), nextDispatch)
assert.equal(tracker.isCurrent('tracked-child', firstDispatch), false)
assert.equal(tracker.isCurrent('tracked-child', nextDispatch), true)
assert.strictEqual(tracker.forDispatch('tracked-child', 'dispatch-a'), firstDispatch)
assert.strictEqual(
  tracker.observeActivity('tracked-child', 'dispatch-a', T3),
  firstDispatch,
  'an activity sharing a dispatch id must remain bound to that dispatch generation'
)

assert.equal(
  isSubAgentGenerationAdvance(true, undefined, 1),
  true,
  'legacy state followed by versioned generation 1 must render a fresh start'
)
assert.equal(isSubAgentGenerationAdvance(false, undefined, 1), false)

assert.equal(
  formatSubAgentElapsed({ startedAt: T1, endedAt: T1 + 12_000 }, T6),
  '12 秒',
  'terminal elapsed time must use the exact persisted seconds rather than now'
)
assert.equal(formatSubAgentElapsed({ startedAt: T1 }, T1 + 61_999), '1 分 01 秒')

console.log('subagent-lifecycle: ok')
