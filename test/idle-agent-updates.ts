import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { IdleAgentUpdater } from '../src/main/idleAgentUpdater'
import { Orchestrator } from '../src/main/orchestrator'
import { TeamService } from '../src/main/teamService'
import type { AgentDef, AppSettings } from '../src/shared/types'

const IDLE = 5 * 60_000
const HOUR = 60 * 60_000
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function agent(id: string): AgentDef {
  return {
    id, name: id, bin: `/safe/${id}`, adapter: 'codex', icon: '', builtin: true, installed: true,
    models: [], capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] },
    lifecycle: { availability: 'available', auth: 'authenticated', health: 'healthy', selfUpdateSupported: true, updateStatus: 'idle', checkedAt: 0 }
  }
}
function fixture(t: TestContext) {
  const state = {
    now: 0, busy: false, checked: [] as string[], updated: [] as string[], published: 0,
    settings: { schemaVersion: 1, autoCheckUpdate: true, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: true, enabledAgentIds: ['codex', 'kimi'] } as AppSettings,
    agents: [agent('codex'), agent('kimi'), agent('grok')],
    checking: undefined as Promise<void> | undefined,
    installing: undefined as Promise<void> | undefined
  }
  const updater = new IdleAgentUpdater({
    settings: () => state.settings, isBusy: () => state.busy, now: () => state.now,
    lifecycle: {
      snapshot: () => state.agents,
      checkUpdate: async id => {
        state.checked.push(id)
        await state.checking
        const item = state.agents.find(item => item.id === id)!
        item.lifecycle!.updateStatus = 'available'
        return item
      },
      updateOne: async (id, isActive) => {
        assert.equal(isActive(id), false)
        state.updated.push(id)
        const item = state.agents.find(item => item.id === id)!
        item.lifecycle!.updateStatus = 'updating'
        await state.installing
        item.lifecycle!.updateStatus = 'current'
        return item
      }
    },
    onUpdated: () => { state.published += 1 }
  })
  t.after(() => updater.stop())
  updater.start()
  return { updater, state }
}

test('idle updates wait five minutes, check only enabled supported agents, and throttle hourly', async t => {
  const { updater, state } = fixture(t)
  state.agents.push({ ...agent('unsupported'), lifecycle: { ...agent('unsupported').lifecycle!, selfUpdateSupported: false } })
  state.agents.push({ ...agent('offline'), lifecycle: { ...agent('offline').lifecycle!, availability: 'needs-auth' } })
  state.settings.enabledAgentIds!.push('unsupported', 'offline')
  state.now = IDLE - 1
  await updater.tick()
  assert.deepEqual(state.checked, [])
  state.now = IDLE
  await updater.tick()
  assert.deepEqual(state.checked, ['codex', 'kimi'])
  assert.deepEqual(state.updated, ['codex', 'kimi'])
  state.now += HOUR - 1
  await updater.tick()
  assert.equal(state.checked.length, 2)
  state.now += 1
  await updater.tick()
  assert.equal(state.checked.length, 4)
})

test('the disabled switch prevents checks even after a long idle period', async t => {
  const { updater, state } = fixture(t)
  state.settings.autoUpdateAgentsWhenIdle = false
  state.now = HOUR
  await updater.tick()
  assert.deepEqual(state.checked, [])
  assert.deepEqual(state.updated, [])
  state.settings.autoUpdateAgentsWhenIdle = true
  await updater.tick()
  state.now += IDLE - 1
  await updater.tick()
  assert.deepEqual(state.checked, [])
  state.now += 1
  await updater.tick()
  assert.equal(state.updated.length, 2)
})

test('busy work resets the continuous idle countdown', async t => {
  const { updater, state } = fixture(t)
  state.now = IDLE - 1
  state.busy = true
  await updater.tick()
  state.now += IDLE
  state.busy = false
  await updater.tick()
  assert.deepEqual(state.checked, [])
  state.now += IDLE - 1
  await updater.tick()
  assert.deepEqual(state.checked, [])
  state.now += 1
  await updater.tick()
  assert.equal(state.updated.length, 2)
})

test('activity while version checks are pending prevents updates even if the short task already finished', async t => {
  const { updater, state } = fixture(t)
  const check = deferred()
  state.checking = check.promise
  state.now = IDLE
  const flight = updater.tick()
  updater.markActivity()
  check.resolve()
  await flight
  assert.deepEqual(state.updated, [])
  assert.equal(state.published, 1)
})

test('turning the switch off and on invalidates the previous check instead of continuing its updates', async t => {
  const { updater, state } = fixture(t)
  const check = deferred()
  state.checking = check.promise
  state.now = IDLE
  const flight = updater.tick()
  state.settings.autoUpdateAgentsWhenIdle = false
  updater.stop()
  state.settings.autoUpdateAgentsWhenIdle = true
  updater.start()
  check.resolve()
  await flight
  assert.deepEqual(state.updated, [])
})

test('an active install completes after disabling but no later agent update starts', async t => {
  const { updater, state } = fixture(t)
  const install = deferred()
  state.installing = install.promise
  state.now = IDLE
  const flight = updater.tick()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(state.updated, ['codex'])
  state.settings.autoUpdateAgentsWhenIdle = false
  updater.stop()
  install.resolve()
  await flight
  assert.equal(state.agents[0].lifecycle!.updateStatus, 'current')
  assert.deepEqual(state.updated, ['codex'])
  state.now += HOUR
  await updater.tick()
  assert.equal(state.checked.length, 2)
})

test('the scheduler does not cancel its own batch when a timer tick observes its active install', async t => {
  const { updater, state } = fixture(t)
  const install = deferred()
  state.installing = install.promise
  state.now = IDLE
  const flight = updater.tick()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(state.agents[0].lifecycle!.updateStatus, 'updating')
  assert.equal(updater.tick(), flight)
  install.resolve()
  await flight
  assert.deepEqual(state.updated, ['codex', 'kimi'])
})

test('an agent disabled during a version check is not upgraded', async t => {
  const { updater, state } = fixture(t)
  const check = deferred()
  state.checking = check.promise
  state.now = IDLE
  const flight = updater.tick()
  state.settings.enabledAgentIds = ['codex']
  check.resolve()
  await flight
  assert.deepEqual(state.updated, ['codex'])
})

test('update guards cover idle-looking sessions with branch work or pending dispatch', () => {
  const session = { id: 's', config: { agentId: 'codex' }, status: 'idle' }
  const internals = {
    sessions: new Map([['s', session]]), queues: new Map(), editingQueueItems: new Map(), activeQueueItems: new Map(),
    nativeActionReservations: new Set(), rewinding: new Set(), pendingSends: new Map(), teamQuestions: new Map(),
    protocolPendingStarts: new Map(), deferredDispatches: new Map(), sideStatus: new Map(), sideQueues: new Map(), detailStatus: new Map()
  }
  const orchestrator = Object.assign(Object.create(Orchestrator.prototype), internals) as Orchestrator
  assert.equal(orchestrator.hasActiveAgentSessions(), false)
  for (const [map, value] of [
    [internals.queues, [{}]], [internals.editingQueueItems, 'edited'], [internals.pendingSends, 1],
    [internals.protocolPendingStarts, Symbol()], [internals.deferredDispatches, Symbol()],
    [internals.sideStatus, 'running'], [internals.sideStatus, 'awaiting-approval'],
    [internals.sideQueues, [{}]], [internals.detailStatus, 'running']
  ] as Array<[Map<string, unknown>, unknown]>) {
    map.set('s', value)
    assert.equal(orchestrator.hasActiveAgentSessions(), true)
    assert.equal(orchestrator.hasActiveAgentSessions('codex'), true)
    assert.equal(orchestrator.hasActiveAgentSessions('kimi'), false)
    map.clear()
  }
  for (const status of ['running', 'queued', 'awaiting-approval', 'cancelling']) {
    session.status = status
    assert.equal(orchestrator.hasActiveAgentSessions(), true)
  }
})

test('queued or blocked team assignments count as work before an agent session starts', () => {
  const project = { archivedAt: undefined as number | undefined, status: 'waiting_members', runId: 2, assignments: [{ runId: 2, status: 'queued' }] }
  const teams = Object.assign(Object.create(TeamService.prototype), {
    delivering: new Set(), scheduling: new Set(), reservations: new Set(), store: { catalog: () => ({ projects: [project] }) }
  }) as TeamService
  assert.equal(teams.hasActiveWork(), true)
  project.assignments[0].status = 'blocked'
  assert.equal(teams.hasActiveWork(), true)
  project.assignments[0].runId = 1
  assert.equal(teams.hasActiveWork(), false, 'previous runs cannot prevent idle updates')
  project.assignments[0].runId = 2
  project.archivedAt = 1
  assert.equal(teams.hasActiveWork(), false, 'archived teams cannot prevent idle updates')
})
