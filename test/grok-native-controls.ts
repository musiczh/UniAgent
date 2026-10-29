import assert from 'node:assert/strict'
import { GrokNativeControls } from '../src/main/grokNativeControls.ts'

const calls: Array<{ method: string; params: any; timeout?: number }> = []
const update = { sessionUpdate: 'goal_updated', goal_id: 'native-goal', objective: 'Native controlled goal', status: 'active',
  token_budget: 100, tokens_used: 4, elapsed_ms: 50, last_event: 'goal_created', last_event_timestamp: '2026-10-11T13:23:39.183Z' }
let latest: any = { goal: { ...update, created_at: '2026-10-11T13:23:39.167Z', tokens_used_high_water: 4 },
  summary: { updated_at: '2026-10-11T13:23:39.183Z' } }
let promptCount = 0, notifyDuringSnapshot = false
const changes: unknown[] = []
const controls = new GrokNativeControls({ request: async (method, params, timeout) => {
  calls.push({ method, params, timeout })
  if (method === '_x.ai/session/state') {
    if (notifyDuringSnapshot) controls.acceptNotification({ params: { sessionId: 'session', update: { ...update, status: 'infra_paused',
      last_event: 'goal_paused', last_event_timestamp: '2026-10-11T13:24:00Z' }, _meta: { agentTimestampMs: 1791725040000 } } })
    return latest
  }
  if (method === 'session/prompt') {
    promptCount++
    if (params.prompt[0].text === '/goal clear') controls.acceptNotification({ params: { sessionId: 'session', update: { sessionUpdate: 'goal_updated', status: 'cleared' } } })
    else controls.acceptNotification({ params: { sessionId: 'session', update, _meta: { agentTimestampMs: 1791725019183 } } })
    return { stopReason: 'end_turn' }
  }
  if (method === '_x.ai/interject') return { result: { status: 'queued' } }
  throw Error('Unexpected native method')
} }, 'session', '/trusted/cwd', goal => changes.push(goal))

const goal = await controls.setGoal({ objective: update.objective, tokenBudget: 100 })
assert.equal(goal.tokenBudget, 100)
assert.equal(promptCount, 1, 'native Goal creation uses one slash command without an extra parent prompt')
assert.deepEqual(calls.find(call => call.method === 'session/prompt')!.params, { sessionId: 'session', prompt: [{ type: 'text', text: '/goal Native controlled goal --budget 100' }] })
assert.equal(calls.find(call => call.method === 'session/prompt')!.timeout, 0)
assert.equal(controls.acceptNotification({ params: { sessionId: 'foreign', update: { ...update, status: 'cleared' } } }), false)
assert.equal(controls.goal?.objective, update.objective)
notifyDuringSnapshot = true
assert.equal((await controls.getGoal())?.status, 'paused', 'a state response cannot overwrite a notification accepted while it was in flight')
notifyDuringSnapshot = false
const acceptedPause = controls.goal
latest = { summary: { updated_at: '2026-10-11T13:25:00Z' } }
assert.equal(await controls.getGoal(), acceptedPause, 'a persisted state with no goal cannot erase a newer accepted native notification')
latest = { goal: { ...update, created_at: '2026-10-11T13:23:39.167Z', tokens_used_high_water: 4 }, summary: {} }
await assert.rejects(controls.steer('idle fallback prohibited', false), /可引导/)
const beforeSteer = promptCount
await controls.steer('UA_STEER_SENTINEL', true)
assert.equal(promptCount, beforeSteer, 'steer only interjects into the active native prompt')
assert.deepEqual(calls.find(call => call.method === '_x.ai/interject')!.params, { sessionId: 'session', text: 'UA_STEER_SENTINEL' })
await controls.updateGoal({ action: 'clear' })
assert.equal(controls.goal, undefined, 'clear notification wins over an older persisted state response')
assert.equal(await controls.getGoal(), undefined, 'a later read of the cleared native goal cannot resurrect its stale persisted snapshot')
latest = { summary: { updated_at: '2026-10-11T13:25:00Z' } }
assert.equal(await controls.getGoal(), undefined)
for (const action of ['edit', 'complete', 'block', 'disarm'] as const) {
  await assert.rejects(controls.updateGoal({ action }), /不支持/)
}
assert.equal(changes.length > 0, true)
let finishPrompt!: (value: unknown) => void
let failPrompt!: (error: Error) => void
let announce!: () => void
const started = new Promise<void>(resolve => { announce = resolve })
const backgroundFailures: Error[] = []
const early = new GrokNativeControls({ request: async (method) => {
  if (method === 'session/prompt') {
    announce()
    return new Promise((resolve, reject) => { finishPrompt = resolve; failPrompt = reject })
  }
  throw new Error('A Goal notification already acknowledged the command; no extra state prompt is allowed')
} }, 'session', '/trusted/cwd', () => {}, error => backgroundFailures.push(error))
const setting = early.setGoal({ objective: update.objective, tokenBudget: 100 })
await started
assert.equal(early.hasPendingCommand, true)
early.acceptNotification({ params: { sessionId: 'session', update } })
const acknowledged = await Promise.race([setting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Goal creation waited for the entire native workflow')), 50))])
assert.equal(acknowledged.autonomous, true, 'notification acknowledgement releases host controls while native workflow still owns its prompt')
failPrompt(new Error('Native workflow failed after acknowledgement'))
await new Promise<void>(resolve => setImmediate(resolve))
assert.deepEqual(backgroundFailures.map(error => error.message), ['Native workflow failed after acknowledgement'])
assert.equal(early.hasPendingCommand, false)
let simultaneous!: GrokNativeControls
const immediateFailures: Error[] = []
simultaneous = new GrokNativeControls({ request: async () => {
  simultaneous.acceptNotification({ params: { sessionId: 'session', update } })
  throw new Error('Native workflow failed in the acknowledgement tick')
} }, 'session', '/trusted/cwd', () => {}, error => immediateFailures.push(error))
await simultaneous.setGoal({ objective: update.objective, tokenBudget: 100 })
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(immediateFailures[0]?.message, 'Native workflow failed in the acknowledgement tick', 'a race between acknowledgement and failure must not swallow the workflow error')
const resumed = new GrokNativeControls({ request: async () => latest }, 'session', '/trusted/cwd', () => {})
latest = { goal: { ...update, tokens_used_high_water: 4 }, summary: {} }
await resumed.getGoal()
resumed.acceptNotification({ params: { sessionId: 'session', update: { sessionUpdate: 'goal_updated', status: 'cleared' } } })
assert.equal(await resumed.getGoal(), undefined, 'clearing a Goal loaded from native history must also retain its tombstone')
assert.equal(resumed.acceptNotification({ params: { sessionId: 'session', update } }), false, 'a delayed active notification cannot resurrect a cleared native id')
const rejected = new GrokNativeControls({ request: async method => method === 'session/prompt' ? { stopReason: 'end_turn' } : { goal: { ...update, tokens_used_high_water: 4 } } }, 'session', '/trusted/cwd', () => {})
await assert.rejects(rejected.updateGoal({ action: 'pause' }), /确认|暂停|操作/, 'an end_turn response alone cannot falsely acknowledge a rejected native control')
console.log('grok-native-controls: slash ownership, in-flight epoch reconciliation, clear and active steer passed')
