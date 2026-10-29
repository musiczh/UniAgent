import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderOpenChains } from './regression/open-chain'
import { renderToStaticMarkup } from 'react-dom/server'
import { estimateQueueWait, QueueWaitHistoryStore, type QueueWaitSample } from '../src/main/queueWaitHistory.ts'
import { parseQueueWaitQualityQuery, QueueWaitQualityStore } from '../src/main/queueWaitQuality.ts'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import { EventStream, TurnStatusBar } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

function event(
  seq: number,
  ts: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state?: UAEvent['state']
): UAEvent {
  return { sessionId: 'queue-wait', seq, ts, type, payload, state }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const now = new Date(2026, 8, 3, 10).getTime()

function sample(
  id: string,
  at: number,
  remainingMs: number,
  model = 'GPT-5.6-Sol',
  position = 316
): QueueWaitSample {
  return {
    id,
    model,
    startedAt: at - 5_000,
    completedAt: at + remainingMs,
    waitedMs: remainingMs + 5_000,
    observations: [{ at, position, waitedMs: 5_000 }]
  }
}

assert.equal(
  estimateQueueWait([
    sample('morning-1', now - DAY, 10_000),
    sample('morning-2', now - 2 * DAY, 20_000),
    sample('morning-3', now - 3 * DAY, 30_000),
    sample('night-1', now - DAY + 12 * HOUR, 100_000),
    sample('night-2', now - 2 * DAY + 12 * HOUR, 110_000),
    sample('night-3', now - 3 * DAY + 12 * HOUR, 120_000)
  ], { model: 'GPT-5.6-Sol', position: 316, at: now }),
  20_000,
  'the estimate must use the median of nearby historical trajectories, including time of day'
)

const nonLinearSamples: QueueWaitSample[] = [1_000, 2_000, 3_000].map((remainingMs, index) => {
  const observedAt = now - (index + 1) * DAY
  return {
    id: `non-linear-${index}`,
    model: 'GPT-5.6-Sol',
    startedAt: observedAt - 60_000,
    completedAt: observedAt + remainingMs,
    waitedMs: 60_000 + remainingMs,
    observations: [
      { at: observedAt - 60_000, position: 900, waitedMs: 0 },
      { at: observedAt, position: 800, waitedMs: 60_000 }
    ]
  }
})
assert.equal(
  estimateQueueWait(nonLinearSamples, { model: 'GPT-5.6-Sol', position: 800, at: now }),
  2_000,
  'the estimate must follow historical remaining time instead of scaling linearly from queue position'
)
assert.equal(
  estimateQueueWait(nonLinearSamples, { model: 'GPT-5.6-Sol', position: 850, at: now }),
  32_000,
  'interpolate between observed positions instead of switching to the nearest point'
)
for (const position of [950, 750, -1, Infinity]) {
  assert.equal(
    estimateQueueWait(nonLinearSamples, { model: 'GPT-5.6-Sol', position, at: now }),
    undefined,
    'never extrapolate beyond the observed trajectory or accept invalid positions'
  )
}

assert.equal(
  estimateQueueWait([
    sample('other-model-1', now - DAY, 10_000, 'GPT-5.6-Luna'),
    sample('same-model-1', now - DAY, 20_000),
    sample('same-model-2', now - 2 * DAY, 30_000)
  ], { model: 'GPT-5.6-Sol', position: 316, at: now }),
  undefined,
  'fewer than three completed waits for the current model must not produce an estimate'
)

const historyDir = mkdtempSync(join(tmpdir(), 'uniagent-queue-wait-'))
const historyFile = join(historyDir, 'queue-wait-history.json')
try {
  writeFileSync(historyFile, JSON.stringify([1, 2, 3].map((index) =>
    sample(`legacy-${index}`, now - index * DAY, 1_000)
  )))
  const store = new QueueWaitHistoryStore(historyFile)
  assert.equal(store.estimate({ model: 'GPT-5.6-Sol', position: 316, at: now }), undefined,
    'legacy history cannot distinguish cancelled waits or multiple phases and must not train estimates')
  store.record(sample('expired', now - 8 * DAY, 99_000), now)
  store.record(sample('recent-1', now - DAY, 10_000), now)
  store.record(sample('recent-2', now - 2 * DAY, 20_000), now)
  store.record(sample('recent-3', now - 3 * DAY, 30_000), now)
  assert.equal(store.estimate({ model: 'GPT-5.6-Sol', position: 316, at: now }), 20_000)
  assert.deepEqual(
    store.observe('active-turn', 'GPT-5.6-Sol', {
      state: 'waiting', position: 316, startedAt: now, waitedMs: 0
    }, now),
    { estimatedRemainingMs: 20_000, estimatedAt: now },
    'a live queue snapshot must be enriched from persisted history'
  )
  store.observe('active-turn', 'GPT-5.6-Sol', { state: 'ready', acquired: true, waitedMs: 25_000 }, now + 25_000)
  assert.deepEqual(
    store.observe('active-turn', 'GPT-5.6-Sol', {
      state: 'waiting', position: 316, startedAt: now + 30_000, waitedMs: 25_000
    }, now + 30_000),
    { estimatedRemainingMs: 20_000, estimatedAt: now + 30_000 },
    'a later wait phase must not use its own partial sample as estimation history'
  )
  store.observe('active-turn', 'GPT-5.6-Sol', { state: 'ready', acquired: true, waitedMs: 35_000 }, now + 40_000)
  const persisted = JSON.parse(readFileSync(historyFile, 'utf8')).samples as QueueWaitSample[]
  assert.deepEqual(
    persisted.map((entry) => entry.id),
    ['recent-3', 'recent-2', 'recent-1', 'active-turn', 'active-turn'],
    'persisted history must retain the latest seven days and each completed phase'
  )
  assert.deepEqual(
    persisted.slice(-2).map(({ waitedMs, observations }) => [waitedMs, observations[0].waitedMs]),
    [[25_000, 0], [10_000, 0]],
    'each sample must contain only its own phase duration, excluding prior and future waits'
  )
  assert.equal(new QueueWaitHistoryStore(historyFile).estimate({
    model: 'GPT-5.6-Sol', position: 316, at: now + 40_000
  }), 20_000, 'valid phase history must survive restart')
} finally {
  rmSync(historyDir, { recursive: true, force: true })
}

const qualityDir = mkdtempSync(join(tmpdir(), 'uniagent-queue-quality-'))
try {
  const history = new QueueWaitHistoryStore(join(qualityDir, 'history.json'))
  const model = 'quality-model'
  for (let day = 1; day <= 3; day++) {
    const startedAt = now - day * DAY
    history.record({
      id: 'baseline-' + day, model, startedAt, completedAt: startedAt + 100_000, waitedMs: 100_000,
      observations: [
        { at: startedAt, position: 900, waitedMs: 0 },
        { at: startedAt + 60_000, position: 700, waitedMs: 60_000 }
      ]
    }, now)
  }
  const observe = (id: string, elapsed: number, position: number | null, startedAt = now) =>
    history.observe(id, model, { state: 'waiting', position, startedAt }, now + elapsed)
  observe('first', 0, null)
  assert.equal(observe('first', 10_000, 900)?.estimatedRemainingMs, 100_000)
  observe('first', 15_000, 900) // heartbeat is not another prediction
  assert.equal(observe('first', 30_000, 700)?.estimatedRemainingMs, 40_000)
  assert.equal(observe('first', 80_000, 700), undefined) // expired forecasts still count
  history.observe('first', model, { state: 'ready', acquired: true, waitedMs: 130_000 }, now + 130_000)
  // A duplicate ready event cannot count the phase twice.
  history.observe('first', model, { state: 'ready', acquired: true, waitedMs: 130_000 }, now + 130_001)
  observe('no-estimate', 140_000, 950, now + 140_000)
  history.observe('no-estimate', model, { state: 'ready', acquired: true, waitedMs: 10_000 }, now + 150_000)
  observe('second', 160_000, 700, now + 160_000)
  history.observe('second', model, { state: 'ready', acquired: true, waitedMs: 20_000 }, now + 180_000)
  observe('cancelled', 190_000, 900, now + 190_000)
  history.observe('cancelled', model, { state: 'ready', acquired: false, endReason: 'cancelled' }, now + 200_000)
  observe('ongoing', 210_000, 900, now + 210_000)
  const report = history.quality.report({}, now + 220_000)
  assert.equal(report.successfulCount, 3)
  assert.equal(report.evaluatedCount, 2)
  assert.equal(report.meanAbsoluteErrorMs, 20_000)
  assert.equal(report.meanErrorMs, 0)
  assert.equal(report.p90AbsoluteErrorMs, 20_000)
  assert.equal(report.coverage, 2 / 3)
  assert.equal(report.interruptedCount, 1)
  assert.equal(report.unfinishedCount, 1)
  const first = report.recent.find((entry) => entry.id === 'first')!
  assert.equal(first.predictionCount, 2)
  assert.equal(first.firstPrediction?.estimatedRemainingMs, 100_000)
  assert.equal(first.actualWaitMs, 130_000)
  assert.equal(first.actualRemainingMs, 120_000, 'compare from prediction time, not phase start')
  assert.equal(first.errorMs, -20_000, 'the later 40s correction must not replace the first prediction')
  const file = history.quality.file
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.filter((row) => row.id === 'first' && row.event === 'prediction').length, 2)
  assert.equal(rows.filter((row) => row.id === 'first' && row.event === 'finished').length, 1)
  assert.deepEqual(new QueueWaitQualityStore(file).report({}, now + 220_000), report, 'metrics survive restart')
  assert.equal(history.quality.report({ model: 'different' }, now + 220_000).coverage, null)
  assert.equal(history.quality.report({ algorithmVersion: 'future' }, now + 220_000).meanAbsoluteErrorMs, null)
  assert.equal(history.quality.report({}, now + 31 * DAY).evaluatedCount, 0)
  assert.ok(readFileSync(file, 'utf8').length > 0, '30-day metric window does not discard the 90-day journal')
  // A partial tail left by a crash must not swallow the next appended event.
  appendFileSync(file, '{partial')
  const restarted = new QueueWaitQualityStore(file)
  restarted.record({ event: 'started', at: now + 32 * DAY, startedAt: now + 32 * DAY, phaseId: 'new', id: 'new', model })
  assert.equal(new QueueWaitQualityStore(file).report({}, now + 32 * DAY).unfinishedCount, 1)
  restarted.report({}, now + 123 * DAY)
  assert.equal(readFileSync(file, 'utf8'), '', 'journal retention prunes after 90 days')
  assert.throws(() => parseQueueWaitQualityQuery({ model: [] }))
  assert.throws(() => parseQueueWaitQualityQuery(null))
} finally {
  rmSync(qualityDir, { recursive: true, force: true })
}

const liveDir = mkdtempSync(join(tmpdir(), 'uniagent-queue-live-'))
try {
  const store = new QueueWaitHistoryStore(join(liveDir, 'history.json'))
  for (let index = 1; index <= 3; index++) {
    store.record(sample(`baseline-${index}`, now - index * DAY, 689_000, 'stable', 600), now)
  }
  const observe = (id: string, model: string, position: number, elapsed: number) =>
    store.observe(id, model, { state: 'waiting', position, startedAt: now, waitedMs: 0 }, now + elapsed)
  const first = observe('heartbeat', 'stable', 600, 0)!
  for (const elapsed of [250, 1_000, 1_250, 15_000, 30_000, 59_000, 60_000, 61_000]) {
    const estimate = observe('heartbeat', 'stable', 600, elapsed)!
    assert.deepEqual(estimate, first, 'queue heartbeats must preserve the countdown deadline')
  }
  assert.deepEqual(store.observe('heartbeat', 'stable', { state: 'waiting', position: null }, now + 62_000), first,
    'a heartbeat without a position must retain the current countdown')
  store.observe('heartbeat', 'stable', { state: 'ready', acquired: true, waitedMs: 70_000 }, now + 70_000)
  const stationary = (JSON.parse(readFileSync(join(liveDir, 'history.json'), 'utf8')).samples as QueueWaitSample[])
    .find(({ id }) => id === 'heartbeat')!
  assert.deepEqual(stationary.observations.map(({ waitedMs }) => waitedMs), [0, 30_000, 60_000],
    'an unchanged queue position must still collect periodic wait-time samples')

  assert.equal(observe('live', 'new-model', 600, 0), undefined)
  assert.equal(observe('live', 'new-model', 590, 10_000), undefined)
  assert.equal(observe('live', 'new-model', 570, 30_000), undefined,
    'short-term progress cannot predict the whole queue without completed history')
  assert.equal(observe('live', 'new-model', 570, 31_000), undefined)
  assert.equal(observe('live', 'new-model', 500, 60_000), undefined)
  store.observe('live', 'new-model', { state: 'ready', acquired: true, waitedMs: 90_000 }, now + 90_000)
  const recorded = (JSON.parse(readFileSync(join(liveDir, 'history.json'), 'utf8')).samples as QueueWaitSample[])
    .find(({ id }) => id === 'live')!
  assert.deepEqual(recorded.observations.map(({ position }) => position), [600, 590, 570, 500],
    'every intermediate queue position must be retained for later waits')
  assert.equal(store.observe('live', 'new-model', {
    state: 'waiting', position: 490, startedAt: now + 100_000, waitedMs: 90_000
  }, now + 100_000), undefined, 'a new wait phase must not reuse the previous phase speed or countdown')

  observe('reordered', 'new-model', 600, 0)
  observe('reordered', 'new-model', 590, 10_000)
  assert.equal(observe('reordered', 'new-model', 610, 30_000), undefined,
    'a backward queue jump must not manufacture a forecast')
  assert.equal(observe('reordered', 'new-model', 600, 40_000), undefined)
  assert.equal(observe('reordered', 'new-model', 580, 60_000), undefined)
  store.observe('reordered', 'new-model', { state: 'ready', acquired: true, waitedMs: 70_000 }, now + 70_000)
  assert.ok(!(JSON.parse(readFileSync(join(liveDir, 'history.json'), 'utf8')).samples as QueueWaitSample[])
    .some(({ id }) => id === 'reordered'), 'reordered trajectories cannot train position interpolation')
  assert.equal(observe('invalid', 'new-model', Infinity, 0), undefined)

  for (let index = 1; index <= 3; index++) {
    const at = now - index * DAY
    store.record({
      id: `trajectory-${index}`, model: 'trajectory', startedAt: at,
      completedAt: at + 1_200_000, waitedMs: 1_200_000,
      observations: [
        { at, position: 900, waitedMs: 0 },
        { at: at + 300_000, position: 700, waitedMs: 300_000 }
      ]
    }, now)
  }
  let previousDeadline = Infinity
  for (const [position, elapsed] of [[900, 0], [880, 30_000], [800, 60_000], [738, 120_000], [738, 181_000], [731, 241_000], [700, 300_000]]) {
    const estimate = observe('slowing', 'trajectory', position, elapsed)!
    assert.ok(estimate, 'covered positions should retain an estimate while it remains valid')
    const deadline = estimate.estimatedAt + estimate.estimatedRemainingMs
    assert.ok(deadline <= previousDeadline, 'a slowdown must not push the same phase deadline back')
    previousDeadline = deadline
  }
  assert.equal(observe('slowing', 'trajectory', 700, 1_300_000), undefined,
    'an expired forecast must disappear instead of displaying zero or restarting')
  assert.equal(store.observe('slowing', 'trajectory', { state: 'waiting', position: null }, now + 1_400_000), undefined)

  for (const acquired of [false, undefined]) {
    const file = join(liveDir, `aborted-${acquired}.json`)
    const aborted = new QueueWaitHistoryStore(file)
    aborted.observe('abort', 'stable', { state: 'waiting', position: 600, startedAt: now }, now)
    aborted.observe('abort', 'stable', { state: 'ready', acquired, waitedMs: 10_000 }, now + 10_000)
    assert.equal(existsSync(file), false, 'cancelled or unconfirmed waits must not enter estimation history')
  }
} finally {
  rmSync(liveDir, { recursive: true, force: true })
}

const completedEvents = [
  event(1, 1_000, 'user_message', { text: 'run' }),
  event(2, 2_000, 'queue_status', {
    id: 'queue-turn',
    queue: { state: 'waiting', turnId: 'turn', startedAt: 2_000, waitedMs: 0 }
  }, 'running'),
  event(3, 7_000, 'queue_status', {
    id: 'queue-turn',
    queue: { state: 'ready', turnId: 'turn', waitedMs: 5_000 }
  }, 'success'),
  // Same-millisecond historical progress must not close the second wait after
  // mergeSessionEvent moves its newer queue snapshot to the first queue slot.
  event(4, 8_000, 'reasoning', { id: 'old-reasoning', text: '' }, 'success'),
  event(5, 8_000, 'queue_status', {
    id: 'queue-turn',
    queue: { state: 'waiting', turnId: 'turn', startedAt: 8_000, waitedMs: 5_000 }
  }, 'running'),
  event(6, 15_000, 'command_exec', { id: 'work', command: 'work' }, 'success'),
  event(7, 15_500, 'system_notice', {
    kind: 'usage',
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0 }
  }),
  event(8, 16_000, 'turn_completed', { turnId: 'turn' }, 'success')
].reduce<UAEvent[]>(mergeSessionEvent, [])

const completedMarkup = renderToStaticMarkup(createElement(EventStream, {
  events: completedEvents,
  status: 'idle'
}))

assert.match(
  completedMarkup,
  /process-step-meta[^>]*aria-expanded="false"[^>]*>1 命令/,
  'completed work stays folded with its command count'
)
assert.doesNotMatch(
  completedMarkup,
  /queue-wait-record/,
  'completed compute wait details stay folded until the call chain is opened'
)
assert.doesNotMatch(
  completedMarkup,
  /queue-banner/,
  'a completed compute wait must leave the live banner and move into the call chain'
)
assert.match(
  completedMarkup,
  /本轮 · 输入 120 · 输出 30[\s\S]*?等待算力 12s/,
  'the token footer must include this turn total compute wait'
)

const completedOpenMarkup = renderOpenChains(createElement(EventStream, { events: completedEvents, status: 'idle' }))
assert.match(completedOpenMarkup, /process-queue[^]*?等待算力[^]*?12 秒 · 已结束/, 'opening completed work reveals its accumulated queue wait')
assert.match(completedOpenMarkup, /process-queue/)

const continuedGoalEvents = [
  event(1, 1_000, 'goal_message', { text: 'run goal' }),
  event(2, 61_000, 'queue_status', {
    id: 'continued-goal-queue',
    queue: { state: 'ready', waitedMs: 60_000 }
  }, 'success'),
  event(3, 66_000, 'agent_message', { text: 'checkpoint', phase: 'final_answer' }, 'success'),
  event(4, 71_000, 'user_message', { text: 'continue' }),
  event(5, 72_000, 'queue_status', {
    id: 'continued-goal-queue',
    queue: { state: 'waiting', startedAt: 72_000, waitedMs: 60_000 }
  }, 'running'),
  event(6, 77_000, 'queue_status', {
    id: 'continued-goal-queue',
    queue: { state: 'ready', waitedMs: 65_000 }
  }, 'success'),
  event(7, 79_000, 'system_notice', {
    kind: 'usage', usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 }
  }),
  event(8, 80_000, 'agent_message', { text: 'done', phase: 'final_answer' }, 'success'),
  event(9, 81_000, 'turn_completed', {}, 'success')
].reduce<UAEvent[]>(mergeSessionEvent, [])
const continuedGoalMarkup = renderOpenChains(createElement(EventStream, {
  events: continuedGoalEvents,
  status: 'idle'
}))
assert.match(continuedGoalMarkup, /process-queue[^]*?1 分 00 秒 · 已结束/,
  'the preceding visual turn must retain its own queue wait')
assert.match(continuedGoalMarkup, /本轮 · 输入 20 · 输出 10[\s\S]*?等待算力 5s/,
  'a completed continued Goal turn must display only its queue-wait delta')
const continuedGoalNow = Date.now
try {
  Date.now = () => 81_000
  // 计时胶囊重构 — the capsule reports only the continued turn's total wall time
  // (from its own user message), never a per-bucket split.
  const continuedGoalTiming = renderToStaticMarkup(createElement(TurnStatusBar, {
    events: continuedGoalEvents,
    status: 'running'
  }))
  assert.match(continuedGoalTiming, /turn-timer-text">10s</,
    'a continued Goal turn must time only from its own user message')
  assert.doesNotMatch(continuedGoalTiming, /tt-stack|tt-d">/,
    'the per-turn timing buckets are removed')
} finally {
  Date.now = continuedGoalNow
}

// Queue snapshots replace in place: the last event gap is only 11s, but two
// completed waits total 158.8s. Both timing surfaces must use that total.
const timingEvents = [
  event(1, 1_000, 'user_message', { text: 'run' }),
  event(2, 2_000, 'queue_status', {
    id: 'timing-queue', queue: { state: 'waiting', startedAt: 2_000, waitedMs: 0 }
  }, 'running'),
  event(3, 62_000, 'queue_status', {
    id: 'timing-queue', queue: { state: 'ready', waitedMs: 60_000 }
  }, 'success'),
  event(4, 68_000, 'command_exec', { id: 'work', command: 'work', durationMs: 6_000 }, 'success'),
  event(5, 70_000, 'hook', { id: 'hook', durationMs: 2_000 }, 'success'),
  event(6, 90_000, 'queue_status', {
    id: 'timing-queue', queue: { state: 'waiting', startedAt: 90_000, waitedMs: 60_000 }
  }, 'running'),
  event(7, 177_800, 'system_notice', { kind: 'context' }),
  event(8, 188_800, 'queue_status', {
    id: 'timing-queue', queue: { state: 'ready', waitedMs: 158_800 }
  }, 'success'),
  event(9, 190_000, 'agent_message', { text: 'working', phase: 'commentary' }, 'success')
]
const realNow = Date.now
try {
  Date.now = () => 427_000
  for (const events of [timingEvents, timingEvents.reduce<UAEvent[]>(mergeSessionEvent, [])]) {
    const stream = renderOpenChains(createElement(EventStream, { events, status: 'running' }))
    const timing = renderToStaticMarkup(createElement(TurnStatusBar, { events, status: 'running' }))
    assert.match(stream, /process-queue[^]*?2 分 39 秒 · 已结束/, 'the call chain must round the same accumulated wait as before')
    // 计时胶囊重构 — the capsule counts the whole turn (queue waits included).
    assert.match(timing, /turn-timer-text">7m 6s</, 'the capsule must include every queue phase, before and after snapshot merging')
    assert.doesNotMatch(timing, /tt-stack|tt-d">/, 'the per-bucket timing split is removed')
  }
  const fallbackTiming = renderToStaticMarkup(createElement(TurnStatusBar, {
    events: completedEvents, status: 'running'
  }))
  assert.match(fallbackTiming, /turn-timer-text">7m 6s</,
    'the capsule keeps counting the whole turn when the wait lacks a ready notification')

  Date.now = () => 100_000
  const activeEvents = timingEvents.slice(0, 6).reduce<UAEvent[]>(mergeSessionEvent, [])
  const activeStream = renderToStaticMarkup(createElement(EventStream, { events: activeEvents, status: 'queued' }))
  const activeTiming = renderToStaticMarkup(createElement(TurnStatusBar, { events: activeEvents, status: 'queued' }))
  assert.match(activeStream, /已等待 1 分 10 秒/, 'live wait must include completed phases plus the current phase')
  // 计时胶囊重构 — queued still counts as the blue running capsule.
  assert.match(activeTiming, /turn-timer st-running/, 'a queued turn must show the blue running capsule')
  assert.match(activeTiming, /turn-timer-text">1m 39s</,
    'the queued capsule counts from the user message')
} finally {
  Date.now = realNow
}

const estimateObservedAt = Date.now()
const activeMarkup = renderToStaticMarkup(createElement(EventStream, {
  events: [
    event(1, 1_000, 'user_message', { text: 'run' }),
    event(2, 2_000, 'queue_status', {
      id: 'queue-active',
      queue: {
        state: 'waiting',
        turnId: 'active',
        startedAt: 2_000,
        waitedMs: 0,
        estimatedRemainingMs: 23_000,
        estimatedAt: estimateObservedAt
      }
    }, 'running')
  ],
  status: 'queued'
}))

assert.match(activeMarkup, /process-queue active[^>]*>[\s\S]*?等待算力/)
assert.match(activeMarkup, /预计还需 (22|23)s/, 'an active wait must show the dynamic estimate in seconds')
assert.doesNotMatch(
  activeMarkup,
  /queue-wait-record/,
  'an active compute wait must not render a duplicate call-chain record'
)

const noEstimateMarkup = renderToStaticMarkup(createElement(EventStream, {
  events: [
    event(1, 1_000, 'user_message', { text: 'run' }),
    event(2, 2_000, 'queue_status', {
      id: 'queue-without-history',
      queue: { state: 'waiting', turnId: 'active', position: 4, startedAt: 2_000, waitedMs: 0 }
    }, 'running')
  ],
  status: 'queued'
}))
assert.doesNotMatch(
  noEstimateMarkup,
  /预计还需/,
  'an active wait without enough historical data must hide the estimate'
)

const expiredEstimateMarkup = renderToStaticMarkup(createElement(EventStream, {
  events: [
    event(1, 1_000, 'user_message', { text: 'run' }),
    event(2, 2_000, 'queue_status', {
      id: 'queue-changing-position',
      queue: {
        state: 'waiting', turnId: 'active', position: 9, startedAt: 2_000, waitedMs: 0,
        estimatedRemainingMs: 23_000, estimatedAt: estimateObservedAt
      }
    }, 'running'),
    event(3, 3_000, 'queue_status', {
      id: 'queue-changing-position',
      queue: { state: 'waiting', turnId: 'active', position: 4, startedAt: 2_000, waitedMs: 0 }
    }, 'running')
  ],
  status: 'queued'
}))
assert.doesNotMatch(
  expiredEstimateMarkup,
  /预计还需/,
  'a newer queue snapshot without a valid estimate must clear the previous estimate'
)

const deadlineMarkup = renderToStaticMarkup(createElement(EventStream, {
  events: [
    event(1, 1_000, 'user_message', { text: 'run' }),
    event(2, 2_000, 'queue_status', {
      id: 'expired-deadline',
      queue: { state: 'waiting', position: 600, startedAt: 2_000, waitedMs: 0,
        estimatedRemainingMs: 1_000, estimatedAt: Date.now() - 2_000 }
    }, 'running')
  ],
  status: 'queued'
}))
assert.doesNotMatch(deadlineMarkup, /预计还需/,
  'an expired countdown must disappear even when no new queue heartbeat arrives')
