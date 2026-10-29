import assert from 'node:assert/strict'
import { buildGrokGoalCommand, projectGrokGoal } from '../src/main/grokGoalProjection.ts'

const nativeId = 'b9f838ab-fb8e-4031-a7c1-43c9ad8229b6'
const createdAt = Date.parse('2026-10-11T13:23:39.167666+00:00')
const eventAt = Date.parse('2026-10-11T13:23:39.183238+00:00')
const created = { sessionUpdate: 'goal_updated', goal_id: nativeId, objective: 'Confirm isolated goal state',
  status: 'active', phase: 'executing', token_budget: 20, tokens_used: 0, elapsed_ms: 0,
  last_event: 'goal_created', last_event_timestamp: '2026-10-11T13:23:39.183238+00:00' }
const persisted = { goal: { goal_id: nativeId, objective: created.objective, status: 'active', phase: 'Executing',
  token_budget: 20, elapsed_ms: 48, created_at: '2026-10-11T13:23:39.167666+00:00', tokens_used_high_water: 2155,
  token_baseline: 1296, parent_tokens_spent: 42, last_session_tokens_seen: 999999,
  history: [{ timestamp: created.last_event_timestamp, event: 'goal_created' }] },
  usage: { session: { totalTokens: 888888 } }, summary: { updated_at: '2026-10-11T13:23:39.509923Z' } }
const initial = projectGrokGoal(persisted)!
assert.equal(initial.objective, created.objective)
assert.equal(initial.tokenBudget, 20)
assert.equal(initial.tokensUsed, 2155, 'goal use comes from native goal high water, never cumulative session usage')
assert.equal(initial.timeUsedSeconds, 0.048)
assert.equal(initial.createdAt, createdAt)
assert.equal(initial.updatedAt, Date.parse(persisted.summary.updated_at))
assert.equal(initial.continuation, 'native')
assert.equal(initial.autonomous, true)
const creation = projectGrokGoal(created, { nativeTimestamp: eventAt })!
assert.equal(creation.createdAt, eventAt)
const recentCreation = projectGrokGoal(created, { nativeTimestamp: eventAt + 48 })!
const correctedCreation = projectGrokGoal(persisted, { previous: recentCreation })!
assert.equal(correctedCreation.createdAt, createdAt, 'the persisted same-goal creation timestamp is more exact than its later creation notification')
assert.equal(correctedCreation.tokensUsed, recentCreation.tokensUsed, 'a creation correction cannot accept stale usage from an older goal history')
const running = projectGrokGoal({ ...created, tokens_used: 4310, elapsed_ms: 1290, last_event: 'goal_resumed',
  last_event_timestamp: '2026-10-11T13:23:40.517074+00:00' }, { previous: initial, nativeTimestamp: 1791725020517 })!
assert.equal(running.tokensUsed, 4310)
assert.equal(running.timeUsedSeconds, 1.29)
assert.equal(running.createdAt, createdAt, 'notifications preserve creation only for the same native goal identity')
assert.equal(running.updatedAt, 1791725020517)
assert.equal(projectGrokGoal(persisted, { previous: running }), running, 'a lagging persisted goal history must not overwrite a newer native notification')
const planning = projectGrokGoal({ ...created, planning: true }, { previous: creation, nativeTimestamp: eventAt })!
assert.equal(planning.autonomous, true, 'native planner owns the active Goal workflow before the parent model round begins')
assert.equal(projectGrokGoal({ ...created, planning: true }, { previous: initial, nativeTimestamp: initial.updatedAt })?.createdAt, createdAt,
  'repeated goal_created notifications cannot replace the more exact native persisted creation time')
assert.equal(projectGrokGoal({ params: { update: created, _meta: { agentTimestampMs: eventAt } } })?.updatedAt, eventAt)
assert.equal(projectGrokGoal({ result: persisted })?.tokensUsed, 2155)
const paused = projectGrokGoal({ ...created, status: 'infra_paused', tokens_used: 4310, elapsed_ms: 1290,
  pause_message: 'No plan was produced. Retry with /goal resume.', last_event: 'goal_paused', last_event_detail: 'planner' },
  { previous: running, nativeTimestamp: 1791725020518 })!
assert.equal(paused.status, 'paused')
assert.equal(paused.autonomous, false)
assert.deepEqual(paused.blockedReason, { code: 'infra_paused', message: 'No plan was produced. Retry with /goal resume.' })
const noProgress = projectGrokGoal({ ...created, status: 'no_progress_paused', tokens_used: 60, elapsed_ms: 1931,
  pause_message: 'Goal verification flagged the same gaps with no progress across consecutive attempts.' })!
assert.equal(noProgress.status, 'paused')
assert.equal(noProgress.autonomous, false)
assert.deepEqual(noProgress.blockedReason, { code: 'no_progress_paused', message: 'Goal verification flagged the same gaps with no progress across consecutive attempts.' })
for (const [status, projected] of [['complete', 'complete'], ['budget_limited', 'budgetLimited'], ['user_paused', 'paused']] as const) {
  const terminal = projectGrokGoal({ ...created, status, phase: 'idle', tokens_used: 40, elapsed_ms: 2107 })!
  assert.equal(terminal.status, projected)
  assert.equal(terminal.autonomous, false)
}
const blocked = projectGrokGoal({ ...created, status: 'blocked', pause_message: 'Missing isolated prerequisite.' })!
assert.equal(blocked.status, 'blocked')
assert.deepEqual(blocked.blockedReason, { code: 'blocked', message: 'Missing isolated prerequisite.' })
const newGoal = projectGrokGoal({ ...created, goal_id: 'a-different-goal', last_event_timestamp: '2026-10-11T13:24:00Z' },
  { previous: paused, nativeTimestamp: 1791725040000 })!
assert.equal(newGoal.createdAt, 1791725040000, 'repeated objective text cannot reuse another goal creation')
assert.equal(projectGrokGoal({ ...created, goal_id: 'another-goal', last_event: 'goal_resumed', last_event_timestamp: undefined })?.createdAt, 0,
  'missing native creation never fabricates the current clock or derives wall time from active elapsed')
assert.equal(projectGrokGoal({ goal: null }), undefined)
assert.equal(projectGrokGoal({ summary: {} }), undefined)
assert.equal(projectGrokGoal({ sessionUpdate: 'goal_updated', goal_id: '', objective: '', status: 'cleared' }), undefined)
for (const status of ['completed', 'reached', 'unknown', '', null]) {
  assert.throws(() => projectGrokGoal({ ...created, status }), /无效目标状态/, 'unverified native status cannot become success or autonomous work')
}
assert.throws(() => projectGrokGoal({ ...created, objective: '' }), /无效目标状态/)
assert.equal(projectGrokGoal({ ...created, token_budget: -1, tokens_used: -1, elapsed_ms: -1 })?.tokenBudget, null)
assert.equal(projectGrokGoal({ ...created, token_budget: null, tokens_used: NaN, elapsed_ms: Infinity })?.tokensUsed, 0)
assert.equal(projectGrokGoal({ ...created, token_budget: null, tokens_used: NaN, elapsed_ms: Infinity })?.timeUsedSeconds, 0)

assert.equal(buildGrokGoalCommand({ objective: 'Confirm isolated goal state', tokenBudget: 20 }), '/goal Confirm isolated goal state --budget 20')
assert.equal(buildGrokGoalCommand({ objective: 'Confirm native state' }), '/goal Confirm native state')
for (const action of ['status', 'pause', 'resume', 'clear'] as const) assert.equal(buildGrokGoalCommand(action), '/goal ' + action)
for (const request of [{ objective: '' }, { objective: 'work', tokenBudget: 0 }, { objective: 'work', tokenBudget: Infinity },
  { objective: 'work', maxRounds: 2 }, { objective: 'work', tokenBudget: '20' }, { objective: 'work', reason: 'unknown' }]) {
  assert.throws(() => buildGrokGoalCommand(request as any), /无效|不支持/)
}
for (const action of ['edit', 'complete', 'block', 'disarm']) assert.throws(() => buildGrokGoalCommand(action as any), /不支持/)
for (const objective of ['Objective literal --budget 6', '"Objective literal --budget 6"', 'Objective "quote" text', 'Objective newline\nsecond line']) {
  assert.equal(buildGrokGoalCommand({ objective, tokenBudget: 9 }), '/goal ' + objective + ' --budget 9',
    'verified native parser treats quotes literally and only the final budget sets the requested limit')
}
for (const objective of ['work --budget 999', 'work --budget=999', 'work\n--budget 999']) assert.throws(() => buildGrokGoalCommand({ objective }), /无效/)
assert.throws(() => buildGrokGoalCommand({ objective: 'work\u0000injected', tokenBudget: 20 }), /无效/)
for (const objective of ['status', 'pause', 'resume', 'clear']) assert.throws(() => buildGrokGoalCommand({ objective }), /无效/)
console.log('grok-goal-projection: native identity, usage, time, authority, lagging snapshots and command boundaries passed')
