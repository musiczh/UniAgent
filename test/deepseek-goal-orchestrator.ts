import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDurableQueueItem, Orchestrator } from '../src/main/orchestrator.ts'
import { ACPRunner } from '../src/main/acp/acpRunner.ts'
import { SessionStore, sessionMetadata } from '../src/main/sessionStore.ts'
import { parseNativeGoalAction, parseNativeThreadAction } from '../src/shared/nativeCapabilities.ts'
import type { GoalState } from '../src/shared/nativeCapabilities.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

const initialGoal: GoalState = {
  objective: 'native objective', status: 'active', tokenBudget: null, tokensUsed: 12,
  timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  continuation: 'native', autonomous: true, nativeActivation: 'armed',
  roundLimit: { maxRounds: 3, roundsStarted: 1 }
}
const agent: AgentDef = {
  id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin: '/usr/bin/true',
  builtin: true, installed: true, icon: '', models: [],
  capabilities: { nativeGoal: true, streaming: true, modelSelect: true, reasoningEffort: true,
    permissionModes: [{ id: 'ask', label: 'Ask', hint: '' }] }
}
const makeSession = (): Session => ({ id: 'deepseek-goal-test', title: 'Goal',
  config: { agentId: 'deepseek', workdir: tmpdir(), permissionMode: 'ask' },
  status: 'idle', createdAt: 1, updatedAt: 1 })

// Only the provider boundary is substituted; all host lifecycle and persistence run unchanged.
class NativeGoalBoundary extends EventEmitter {
  goal: GoalState | undefined
  calls: Array<Record<string, unknown>> = []
  fail = false
  completesBeforeResponse = false
  running = false
  async updateConfig(): Promise<void> {}
  async getGoal(): Promise<GoalState | undefined> { return this.goal }
  async setGoal(input: { objective: string; maxRounds?: number }): Promise<GoalState> {
    if (this.fail) throw new Error('native goal rejected')
    this.calls.push({ method: 'set', ...input })
    this.goal = { ...initialGoal, objective: input.objective,
      roundLimit: { maxRounds: input.maxRounds ?? null, roundsStarted: 1 } }
    this.emit('goalChanged', this.goal)
    this.running = true
    this.emit('goalTurn', { state: 'running', autonomous: true })
    if (this.completesBeforeResponse) {
      this.goal = { ...this.goal, status: 'complete', autonomous: false, nativeActivation: 'disarmed' }
      this.emit('goalChanged', this.goal)
      this.running = false
      this.emit('done', {})
    }
    return this.goal
  }
  async updateGoal(input: any): Promise<GoalState | undefined> {
    this.calls.push({ method: 'update', ...input })
    if (!this.goal) throw new Error('No current goal')
    const wasAutonomous = this.goal.autonomous
    if (input.action === 'clear') this.goal = undefined
    else this.goal = { ...this.goal,
      ...(input.objective ? { objective: input.objective } : {}),
      ...(input.maxRounds ? { roundLimit: { ...this.goal.roundLimit!, maxRounds: input.maxRounds } } : {}),
      ...(input.action === 'pause' ? { status: 'paused', autonomous: false, nativeActivation: 'disarmed' } : {}),
      ...(input.action === 'resume' ? { status: 'active', autonomous: true, nativeActivation: 'armed' } : {}),
      ...(input.action === 'complete' ? { status: 'complete', autonomous: false, nativeActivation: 'disarmed' } : {}) }
    this.emit('goalChanged', this.goal)
    if (wasAutonomous && !this.goal?.autonomous && !this.running) this.emit('done', {})
    return this.goal
  }
  async startTurn(): Promise<never> { throw new Error('Host must not prompt a native Goal driver') }
  dispose(): void {}
}

function publicContract(): void {
  assert.deepEqual(parseNativeGoalAction({ type: 'goal.set', objective: '  native  ', maxRounds: 4 }),
    { type: 'goal.set', objective: 'native', maxRounds: 4 })
  for (const action of ['pause', 'resume', 'complete', 'clear', 'disarm']) {
    assert.deepEqual(parseNativeThreadAction({ type: 'goal.update', action }), { type: 'goal.update', action })
  }
  assert.deepEqual(parseNativeGoalAction({ type: 'goal.update', action: 'edit', objective: ' revised ', maxRounds: 5 }),
    { type: 'goal.update', action: 'edit', objective: 'revised', maxRounds: 5 })
  assert.deepEqual(parseNativeGoalAction({ type: 'goal.update', action: 'block', reason: { code: 'user', message: 'blocked' } }),
    { type: 'goal.update', action: 'block', reason: { code: 'user', message: 'blocked' } })
  for (const value of [
    { type: 'goal.set', objective: 'x', maxRounds: 0 },
    { type: 'goal.set', objective: 'x', maxRounds: 1.2 },
    { type: 'goal.set', objective: 'x', maxRounds: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'goal.update', action: 'edit' },
    { type: 'goal.update', action: 'edit', objective: ' ' },
    { type: 'goal.update', action: 'resume', objective: 'x' },
    { type: 'goal.update', action: 'pause', maxRounds: 3 },
    { type: 'goal.update', action: 'block', reason: { code: '' } },
    { type: 'goal.update', action: 'block', reason: { code: 'user', secret: 'x' } },
    { type: 'goal.update', action: 'unknown' }
  ]) assert.throws(() => parseNativeGoalAction(value), /invalid_native_goal_action/)
}

function persistenceContract(): void {
  const session = { ...makeSession(), goal: { ...initialGoal, status: 'blocked' as const,
    autonomous: false, nativeActivation: 'disarmed' as const,
    blockedReason: { code: 'round-limit', message: 'Native round limit reached' } } }
  assert.deepEqual(sessionMetadata(session).goal, session.goal)
  const malformed = sessionMetadata({ ...session, goal: { ...session.goal, roundLimit: { maxRounds: 0, roundsStarted: 1 } } })
  assert.equal(malformed.goal, undefined, 'invalid native limits must not persist as an authoritative snapshot')
}

async function nativeLifecycle(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-goal-host-'))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.saveOrThrow([makeSession()])
  const host = new Orchestrator(id => id === agent.id ? agent : undefined, store, join(directory, 'artifacts'))
  await host.loadPersisted()
  const session = host.getSessionById('deepseek-goal-test')!
  const provider = new NativeGoalBoundary()
  ;(host as any).protocolRunners.set(session.id, provider)
  ;(host as any).bindProtocolRunner(session, provider)
  try {
    await assert.rejects(host.runNativeAction(session.id, { type: 'goal.set', objective: 'budget', tokenBudget: 20 }), /exact token budget/)
    assert.equal(provider.calls.length, 0)
    assert.equal((await host.getEvents(session.id)).length, 0)
    await host.runNativeAction(session.id, { type: 'goal.set', objective: 'native objective', maxRounds: 3 })
    assert.equal(session.status, 'running')
    assert.equal((host as any).streamers.size, 0, 'native Goal must never create an app-server runner')
    assert.deepEqual(provider.calls, [{ method: 'set', objective: 'native objective', maxRounds: 3 }])
    assert.equal((await host.getEvents(session.id)).filter(event => event.type === 'goal_message').length, 1)
    const delivered = buildDurableQueueItem('already delivered message')
    const pending = buildDurableQueueItem('pending until native Goal settles')
    ;(host as any).commitQueue(session, [{ ...delivered, state: 'dispatching' }, pending])
    ;(host as any).activeQueueItems.set(session.id, delivered.id)
    provider.emit('done', { interrupted: false })
    provider.running = false
    assert.equal(session.status, 'running', 'native follow-up rounds keep the host busy')
    assert.deepEqual(host.getQueue(session.id).map(item => item.id), [pending.id],
      'native continuation still acknowledges a delivered outbox item without draining the next prompt')
    ;(host as any).commitQueue(session, [])
    provider.emit('goalTurn', { state: 'running', autonomous: true })
    provider.running = true

    await host.runNativeAction(session.id, { type: 'goal.update', action: 'pause' })
    assert.equal(session.goal?.status, 'paused')
    assert.equal(session.status, 'running', 'pause disarms follow-ups while the current native round still owns the session')
    provider.emit('done', {})
    provider.running = false
    assert.equal(session.status, 'idle')
    await host.runNativeAction(session.id, { type: 'goal.update', action: 'edit', objective: 'new objective', maxRounds: 5 })
    assert.equal(session.goal?.objective, 'new objective')
    await host.runNativeAction(session.id, { type: 'goal.update', action: 'resume' })
    assert.equal(session.status, 'running', 'resume arms the native driver without a host prompt')
    const restored = store.load()[0]
    assert.equal(restored.goal?.autonomous, true)
    assert.deepEqual(restored.goal?.roundLimit, { maxRounds: 5, roundsStarted: 1 })
    assert.equal(restored.status, 'idle', 'persisted active session never self-starts before reconnect')
    await host.runNativeAction(session.id, { type: 'goal.update', action: 'pause' })
    assert.equal(session.status, 'idle', 'pausing between native rounds releases host ownership')
    await host.runNativeAction(session.id, { type: 'goal.update', action: 'resume' })
    provider.emit('goalTurn', { state: 'error', autonomous: false, error: 'native model failure' })
    assert.equal(session.status, 'error')

    provider.goal = { ...provider.goal!, status: 'blocked', autonomous: false,
      blockedReason: { code: 'round-limit' }, roundLimit: { maxRounds: 5, roundsStarted: 5 } }
    provider.emit('goalChanged', provider.goal)
    provider.emit('done', {})
    assert.equal(session.goal?.status, 'blocked')
    assert.equal(session.goal?.blockedReason?.code, 'round-limit')
    assert.equal(session.goal?.tokenBudget, null)
    assert.equal(session.status, 'error', 'a later success notification must not hide a native Goal failure')

    session.status = 'idle'
    await host.runNativeAction(session.id, { type: 'goal.clear' })
    assert.equal(session.goal, undefined)
    provider.fail = true
    await assert.rejects(host.runNativeAction(session.id, { type: 'goal.set', objective: 'rejected' }), /native goal rejected/)
    assert.equal((await host.getEvents(session.id)).filter(event => event.type === 'goal_message').length, 1)
    assert.equal((host as any).nativeActionReservations.size, 0)
    provider.fail = false
    provider.completesBeforeResponse = true
    await host.runNativeAction(session.id, { type: 'goal.set', objective: 'instant completion' })
    assert.equal(session.status, 'completed', 'a native round can finish before the goal-set response reaches the host')
  } finally { host.disposeAll(); await host.closeSessionLogs(); await rm(directory, { recursive: true, force: true }) }
}

async function newGoalSession(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-goal-create-'))
  const host = new Orchestrator(id => id === agent.id ? agent : undefined,
    new SessionStore(join(directory, 'sessions.json')), join(directory, 'artifacts'))
  const originalSet = ACPRunner.prototype.setGoal
  const originalUpdateConfig = ACPRunner.prototype.updateConfig
  let reject = false
  let completeImmediately = false
  try {
    ACPRunner.prototype.updateConfig = async function(config) { return { config } }
    ACPRunner.prototype.setGoal = async function(input) {
      if (reject) throw new Error('native create rejected')
      const goal = { ...initialGoal, objective: input.objective }
      this.emit('goalChanged', goal)
      this.emit('goalTurn', { state: 'running', autonomous: true })
      if (completeImmediately) {
        const completed = { ...goal, status: 'complete' as const, autonomous: false, nativeActivation: 'disarmed' as const }
        this.emit('goalChanged', completed)
        this.emit('done', {})
        return completed
      }
      return goal
    }
    const session = await host.createNativeActionSession(makeSession().config,
      { type: 'goal.set', objective: 'new native Goal', maxRounds: 3 })
    assert.equal(session.status, 'running')
    assert.equal((host as any).streamers.size, 0)
    assert.equal((host as any).protocolRunners.size, 1)
    const reopened = new Orchestrator(id => id === agent.id ? agent : undefined,
      new SessionStore(join(directory, 'sessions.json')), join(directory, 'artifacts'))
    await host.flushSessionLogs()
    await reopened.loadPersisted()
    assert.equal((await reopened.getEvents(session.id)).find(event => event.type === 'goal_message')?.payload.text, 'new native Goal')
    assert.equal(reopened.getSessionById(session.id)?.goal?.continuation, 'native')
    reopened.disposeAll()
    await reopened.closeSessionLogs()
    reject = true
    await assert.rejects(host.createNativeActionSession(makeSession().config,
      { type: 'goal.set', objective: 'failed new Goal' }), /native create rejected/)
    assert.equal((host as any).sessions.size, 1)
    assert.equal((host as any).protocolRunners.size, 1)
    reject = false
    completeImmediately = true
    const completed = await host.createNativeActionSession(makeSession().config,
      { type: 'goal.set', objective: 'completed before new Goal acknowledgement' })
    assert.equal(completed.status, 'completed', 'the initial Goal bubble arrives after a fast native completion')
  } finally {
    ACPRunner.prototype.setGoal = originalSet
    ACPRunner.prototype.updateConfig = originalUpdateConfig
    host.disposeAll(); await host.closeSessionLogs(); await rm(directory, { recursive: true, force: true })
  }
}

const selected = process.env.DEEPSEEK_GOAL_TEST_CASE
if (!selected || selected === 'contract') publicContract()
if (!selected || selected === 'persistence') persistenceContract()
if (!selected || selected === 'lifecycle') await nativeLifecycle()
if (!selected || selected === 'create') await newGoalSession()
console.log('deepseek-goal-orchestrator: native driver, lifecycle, round limits and persistence passed')
