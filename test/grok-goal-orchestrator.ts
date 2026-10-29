import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
import { ACPRunner } from '../src/main/acp/acpRunner.ts'
import { buildDurableQueueItem, Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { grokNativeHandshake,projectGrokContract } from '../src/main/grokNativeCapabilities.ts'
import { projectACPContract } from '../src/main/acp/acpProvider.ts'
import type { GoalState, NativeGoalUpdate } from '../src/shared/nativeCapabilities.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

const goal = (objective: string, tokenBudget: number | null = null): GoalState => ({
  objective, tokenBudget, status: 'active', tokensUsed: 8, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  continuation: 'native', autonomous: true, nativeActivation: 'armed'
})
const agent = (provider: 'grok' | 'kimi'): AgentDef => ({ id: provider, name: provider, adapter: provider,
  bin: '/usr/bin/true', builtin: true, installed: true, icon: '', models: [],
  capabilities: { nativeGoal: true, streaming: true, modelSelect: true, reasoningEffort: true,
    permissionModes: [{ id: 'ask', label: 'Ask', hint: '' }] } })
const session = (provider: 'grok' | 'kimi'): Session => ({ id: `${provider}-native-goal`, title: 'Goal',
  config: { agentId: provider, workdir: tmpdir(), permissionMode: 'ask' }, status: 'idle', createdAt: 1 })

// Substitute only the provider RPC boundary, preserving host reservations, events and persistence.
class NativeGoalBoundary extends EventEmitter {
  goal?: GoalState
  calls: Array<Record<string, unknown>> = []
  running = false
  reject = false
  async updateConfig(): Promise<void> {}
  async setGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalState> {
    if (this.reject) throw new Error('official Goal rejected')
    this.calls.push({ method: 'set', ...input })
    this.goal = goal(input.objective, input.tokenBudget ?? null)
    this.emit('goalChanged', this.goal)
    this.running = true
    this.emit('goalTurn', { state: 'running', autonomous: true })
    return this.goal
  }
  async updateGoal(input: NativeGoalUpdate): Promise<GoalState | undefined> {
    this.calls.push({ method: 'update', ...input })
    assert.ok(this.goal)
    if (input.action === 'clear') this.goal = undefined
    else this.goal = { ...this.goal, status: input.action === 'pause' ? 'paused' : 'active',
      autonomous: input.action === 'resume', nativeActivation: input.action === 'resume' ? 'armed' : 'disarmed' }
    this.emit('goalChanged', this.goal)
    if (!this.running && !this.goal?.autonomous) this.emit('done', {})
    return this.goal
  }
  async startTurn(): Promise<never> { throw new Error('Host added a second prompt to the native Goal') }
  dispose(): void {}
}

async function nativeLifecycle(provider: 'grok' | 'kimi'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `uniagent-${provider}-goal-host-`))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.saveOrThrow([session(provider)])
  const definition = agent(provider)
  const host = new Orchestrator(id => id === provider ? definition : undefined, store, join(directory, 'artifacts'))
  host.loadPersisted()
  const current = host.getSessionById(`${provider}-native-goal`)!
  const boundary = new NativeGoalBoundary()
  ;(host as any).protocolRunners.set(current.id, boundary)
  ;(host as any).bindProtocolRunner(current, boundary)
  try {
    await assert.rejects(host.runNativeAction(current.id, { type: 'goal.set', objective: 'invalid round limit', maxRounds: 4 }), /轮数|round/i)
    if (provider === 'kimi') await assert.rejects(host.runNativeAction(current.id,
      { type: 'goal.set', objective: 'invalid budget', tokenBudget: 100 }), /预算|budget/i)
    assert.equal(boundary.calls.length, 0)
    await host.runNativeAction(current.id, { type: 'goal.set', objective: `${provider} official goal`,
      ...(provider === 'grok' ? { tokenBudget: 12345 } : {}) })
    assert.equal(current.status, 'running')
    assert.equal((host as any).streamers.size, 0)
    assert.deepEqual(boundary.calls, [{ method: 'set', objective: `${provider} official goal`,
      ...(provider === 'grok' ? { tokenBudget: 12345 } : {}) }])
    assert.equal((await host.getEvents(current.id)).filter(event => event.type === 'goal_message').length, 1)
    assert.equal(current.goal?.tokenBudget, provider === 'grok' ? 12345 : null)
    assert.equal(current.goal?.roundLimit, undefined)
    if (provider === 'grok') {
      const initialize={protocolVersion:1,agentInfo:{version:'1.0.62'},agentCapabilities:{}}
      const native=grokNativeHandshake(initialize);native.capabilities.goal.status='verified'
      const contract=projectGrokContract(projectACPContract('grok',initialize,{},current.config),native)
      boundary.emit('contract',contract)
      definition.capabilities.nativeGoal=false;definition.capabilities.sideChat=false
      current.nativeSessionId='owned-native'
      host.reconcileAgentConfigs()
      assert.equal(current.agentContract?.nativeGoal,true,'catalog refresh must preserve confirmed live native fields')
      assert.equal(current.goal?.autonomous,true,'catalog refresh must not disarm an active native workflow')
      assert.equal(host.canOpenSideChat(current.id),true,'Side uses the session contract')
      assert.deepEqual(current.agentContract?.grokNative,contract.grokNative,'contract copying retains native verification state')
      const restored=new Orchestrator(id=>id===provider?definition:undefined,store,join(directory,'restored-artifacts'))
      restored.loadPersisted();restored.reconcileAgentConfigs()
      assert.equal(restored.getSessionById(current.id)?.agentContract?.nativeGoal,false,'persisted capability hints require a new handshake')
      restored.disposeAll()
    }

    const delivered = buildDurableQueueItem('delivered')
    const waiting = buildDurableQueueItem('waiting')
    ;(host as any).commitQueue(current, [{ ...delivered, state: 'dispatching' }, waiting])
    ;(host as any).activeQueueItems.set(current.id, delivered.id)
    boundary.emit('done', {})
    boundary.running = false
    assert.equal(current.status, 'running', 'official Goal owns native continuation after an individual turn ends')
    assert.deepEqual(host.getQueue(current.id).map(item => item.id), [waiting.id])
    ;(host as any).commitQueue(current, [])
    boundary.running = true
    boundary.emit('goalTurn', { state: 'running', autonomous: true })
    await host.runNativeAction(current.id, { type: 'goal.update', action: 'pause' })
    assert.equal(current.goal?.status, 'paused')
    assert.equal(current.status, 'running', 'pause must not release an unfinished native round')
    boundary.running = false
    boundary.emit('done', {})
    assert.equal(current.status, 'idle')
    await host.runNativeAction(current.id, { type: 'goal.update', action: 'resume' })
    assert.equal(current.goal?.autonomous, true)
    assert.equal(current.status, 'running')
    assert.equal(store.load()[0].goal?.tokenBudget, provider === 'grok' ? 12345 : null)
    assert.equal(store.load()[0].status, 'idle')
    await host.runNativeAction(current.id, { type: 'goal.update', action: 'pause' })
    assert.equal(current.status, 'idle', 'between-round pause settles using the official native completion')

    const beforeUnsupported = boundary.calls.length
    for (const action of ['edit', 'complete', 'block', 'disarm'] as const) {
      await assert.rejects(host.runNativeAction(current.id, { type: 'goal.update', action,
        ...(action === 'edit' ? { objective: 'unsupported edit' } : {}) }), /不支持|unsupported/i)
    }
    await assert.rejects(host.runNativeAction(current.id, { type: 'goal.update', action: 'pause', maxRounds: 4 }), /轮数|round/i)
    await assert.rejects(host.runNativeAction(current.id, { type: 'goal.update', action: 'pause', tokenBudget: 2 }), /预算|budget|不支持/i)
    assert.equal(boundary.calls.length, beforeUnsupported, 'unsupported controls cannot reach the official runner')
    await host.runNativeAction(current.id, { type: 'goal.clear' })
    assert.equal(current.goal, undefined)
    boundary.reject = true
    await assert.rejects(host.runNativeAction(current.id, { type: 'goal.set', objective: 'failed' }), /official Goal rejected/)
    assert.equal((await host.getEvents(current.id)).filter(event => event.type === 'goal_message').length, 1)
    assert.equal((host as any).nativeActionReservations.size, 0)
  } finally { host.disposeAll(); await rm(directory, { recursive: true, force: true }) }
}

async function createNativeSession(provider: 'grok' | 'kimi'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `uniagent-${provider}-goal-new-`))
  const definition = agent(provider)
  const host = new Orchestrator(id => id === provider ? definition : undefined,
    new SessionStore(join(directory, 'sessions.json')), join(directory, 'artifacts'))
  const Runner = provider === 'kimi' ? KimiWebRunner : ACPRunner
  const originalSet = Runner.prototype.setGoal
  const originalUpdate = Runner.prototype.updateConfig
  const originalStart = Runner.prototype.startTurn
  let reject = false
  let completeImmediately = false
  try {
    Runner.prototype.updateConfig = async function(config) { return { config } }
    Runner.prototype.startTurn = async function() { throw new Error('Unexpected host prompt') }
    Runner.prototype.setGoal = async function(input) {
      assert.equal((host as any).nativeActionReservations.has((this as any).sessionId), true,
        'new native Goal blocks concurrent host mutations until the official command is acknowledged')
      if (reject) throw new Error('new official Goal rejected')
      const snapshot = goal(input.objective, input.tokenBudget ?? null)
      this.emit('goalChanged', snapshot)
      this.emit('goalTurn', { state: 'running', autonomous: true })
      if (completeImmediately) {
        const completed = { ...snapshot, status: 'complete' as const, autonomous: false, nativeActivation: 'disarmed' as const }
        this.emit('goalChanged', completed); this.emit('done', {})
        return completed
      }
      return snapshot
    }
    const created = await host.createNativeActionSession(session(provider).config, { type: 'goal.set', objective: 'new official Goal',
      ...(provider === 'grok' ? { tokenBudget: 10000 } : {}) })
    assert.equal(created.status, 'running')
    assert.equal((host as any).protocolRunners.size, 1)
    assert.equal((host as any).streamers.size, 0)
    assert.equal((host as any).nativeActionReservations.size, 0)
    reject = true
    await assert.rejects(host.createNativeActionSession(session(provider).config, { type: 'goal.set', objective: 'failed new Goal' }), /new official Goal rejected/)
    assert.equal((host as any).sessions.size, 1)
    assert.equal((host as any).protocolRunners.size, 1)
    reject = false
    completeImmediately = true
    const completed = await host.createNativeActionSession(session(provider).config, { type: 'goal.set', objective: 'instant official completion' })
    assert.equal(completed.status, 'completed')
  } finally {
    Runner.prototype.setGoal = originalSet
    Runner.prototype.updateConfig = originalUpdate
    Runner.prototype.startTurn = originalStart
    host.disposeAll(); await rm(directory, { recursive: true, force: true })
  }
}

for (const provider of ['grok', 'kimi'] as const) {
  await nativeLifecycle(provider)
  await createNativeSession(provider)
}
console.log('grok-goal-orchestrator: Grok/Kimi native Goal lifecycle, limits, controls and single-driver creation passed')
