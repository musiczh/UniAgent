import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { DeepSeekHostError } from '../src/main/deepseekHostClient'
import { SessionStore, SessionStoreWriteError } from '../src/main/sessionStore'
import type { AgentDef, Session } from '../src/shared/types'

const agent = { id: 'codex', name: 'Codex', bin: '/usr/bin/true', adapter: 'codex', models: [],
  capabilities: { permissionModes: [], modelSelect: true, reasoningEffort: true } } as unknown as AgentDef

for (const edited of [false, true]) for (const failed of [false, true]) {
  test(`${failed ? 'failed' : 'completed'} turn ${edited ? 'waits for file capture' : 'settles while empty artifact is pending'}`, async () => {
    const host = Object.create(Orchestrator.prototype) as any
    const session = { id: 's', titleLocked: true, status: 'running', config: { agentId: 'codex', workdir: '/tmp' } } as Session
    const input = { type: 'user_message', payload: { text: 'test' } }
    let release!: () => void
    let ended = 0
    let failedTurns = 0
    const finalization = new Promise<void>(resolve => { release = resolve })
    Object.assign(host, { worktreeTransitions: new Set(), streamers: new Map(), sessions: new Map([['s', session]]),
      seqRefs: new Map(), events: new Map(), activeQueueItems: new Map(failed ? [['s', 'queued-input']] : []),
      turnCapture: new Map([['s', { fileChanges: [], ...(edited ? { latestDiff: 'file diff' } : {}) }]]),
      bindAppServerDiagnostics() {}, bindNativeCapabilityInvalidation() {},
      installMainStreamerOwner(id: string, runner: unknown) { this.streamers.set(id, runner) },
      logSession() {}, currentTurnInput() { return input }, finalizeTurnArtifact() { return finalization },
      finishFailedTurn(owner: Session) { failedTurns++; owner.status = 'error' },
      setStatus(owner: Session, status: Session['status']) { owner.status = status },
      afterTurn(owner: Session) { ended++; owner.status = 'idle' }
    })
    const runner = host.ensureMainStreamer(session, agent, session.config, false)
    const finishing = runner.listeners('done')[0]({ interrupted: false, failed })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(ended, edited || failed ? 0 : 1)
      assert.equal(session.status, edited ? 'running' : failed ? 'error' : 'idle')
      if (!edited && !failed) session.status = 'running' // A new turn can start before metadata finishes.
    } finally { release(); await finishing }
    assert.equal(ended, failed ? 0 : 1)
    assert.equal(failedTurns, failed ? 1 : 0)
    assert.equal(session.status, failed ? 'error' : edited ? 'idle' : 'running')
  })
}

test('stopping protocol initialization does not publish a late failure or submit a turn', async () => {
  const host = Object.create(Orchestrator.prototype) as any
  const session = { id: 's', status: 'running', config: { agentId: 'deepseek', workdir: '/tmp' } } as Session
  let reject!: (error: Error) => void
  let submitted = 0
  const errors: unknown[] = []
  const initializing = new Promise<void>((_resolve, fail) => { reject = fail })
  const runner = { updateConfig: () => initializing, startTurn: async () => { submitted++ }, interrupt: () => reject(new Error('initialization-cancelled')) }
  Object.assign(host, { sessions: new Map([['s', session]]), protocolPendingStarts: new Map(), protocolConfigTails: new Map(),
    worktreeStarts: new Map(),
    channelSendTurns: new Map(), feishuTeamInputs: new Map(), deferredDispatches: new Map(), editingQueueItems: new Map(),
    zcodeStarts: new Map(), recoveryStartTokens: new Map(), recoveryTurns: new Map(), streamers: new Map(), protocolRunners: new Map([['s', runner]]),
    runners: new Map(), queues: new Map(), cancelManagementConfirmations() {}, bumpSessionActivity() {},
    ensureProtocolRunner: () => runner, record: (_id: string, event: unknown) => errors.push(event),
    setStatus: (owner: Session, status: Session['status']) => { owner.status = status }
  })
  host.runProtocol(session, { ...agent, id: 'deepseek', adapter: 'deepseek' }, 'test')
  await new Promise(resolve => setImmediate(resolve))
  host.interrupt('s')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.status, 'idle')
  assert.equal(submitted, 0)
  assert.deepEqual(errors, [])
})

for (const failure of [new DeepSeekHostError('connection-lost-reopen-session'), new Error('configuration rejected')]) test(`Router initialization settles the exact input: ${failure.message}`, async () => {
  const host = Object.create(Orchestrator.prototype) as any
  const session = { id: 'router', status: 'running', config: { agentId: 'deepseek', workdir: '/tmp', managedPurpose: 'router' } } as Session
  const errors: any[] = []
  let submitted = 0
  const runner = { updateConfig: async () => { throw failure }, startTurn: async () => { submitted++ } }
  Object.assign(host, { sessions: new Map([['router', session]]), protocolPendingStarts: new Map(), protocolConfigTails: new Map(),
    ensureProtocolRunner: () => runner, events: new Map([['router', [{ type: 'user_message', payload: { routedInputId: 'request-id' } }]]]),
    record: (_id: string, event: unknown) => errors.push(event), finishFailedTurn: (owner: Session) => { owner.status = 'error' }
  })
  host.runProtocol(session, { ...agent, id: 'deepseek', adapter: 'deepseek' }, 'test')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(submitted, 0)
  assert.equal(session.status, 'error')
  if (failure instanceof DeepSeekHostError) {
    assert.equal(errors[0]?.payload.code, 'connection-lost-reopen-session')
    assert.equal(errors[0]?.payload.nativeSubmission, 'not-submitted')
    assert.equal(errors[0]?.payload.routedInputId, 'request-id')
  }
  assert.equal(errors[1]?.type, 'turn_completed')
  assert.equal(errors[1]?.state, 'failed')
  assert.equal(errors[1]?.payload.routedInputId, 'request-id')
  assert.equal(errors.length, 2)
})

for (const adapter of ['codex', /* @internal:start failed-turn-traex */ 'traex', /* @internal:end failed-turn-traex */ 'claude', 'qoder', 'deepseek', 'kimi', 'grok', 'mcode', /* @internal:start failed-turn-nika */ 'nika', /* @internal:end failed-turn-nika */ 'zcode'] as const) {
  test(`${adapter} terminal failure removes only the executed queue item`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'failed-turn-queue-'))
    const store = new SessionStore(join(root, 'sessions.json'))
    const definition = { ...agent, id: adapter, adapter } as AgentDef
    const host = new Orchestrator(() => definition, store, join(root, 'artifacts'), join(root, 'logs'))
    const session: Session = { id: 's', title: 'Failure', createdAt: 1, status: 'running',
      config: { agentId: adapter, workdir: root }, pendingQueue: [
        { id: 'executed', prompt: 'failed input', acceptedAt: 1, state: 'dispatching', attempts: 1 },
        { id: 'untouched', prompt: 'pending input', acceptedAt: 2, state: 'pending', attempts: 0 }
      ] }
    const runtime = host as any
    runtime.sessions.set(session.id, session)
    runtime.events.set(session.id, [])
    runtime.seqRefs.set(session.id, { n: 0 })
    runtime.commitQueue(session, session.pendingQueue)
    runtime.activeQueueItems.set(session.id, 'executed')
    runtime.record(session.id, { type: 'user_message', payload: { text: 'failed input' } })
    runtime.record(session.id, { type: 'error', state: 'failed', payload: { message: 'fixture execution failure' } })
    runtime.record(session.id, { type: 'turn_completed', state: 'failed', payload: {} })
    const runner = Object.assign(new EventEmitter(), { dispose: async () => {}, isRunning: () => false })
    try {
      if (adapter === 'codex' || adapter === 'traex') {
        runtime.ensureMainStreamer(session, definition, session.config, false).emit('done', { failed: true })
      } else if (adapter === 'claude' || adapter === 'qoder') {
        const sdk = runtime.ensureTurnRunner(session, definition)
        runtime.runners.set(session.id, sdk)
        sdk.emit('done', { failed: true })
      } else if (adapter === 'zcode') {
        runtime.zcodeRunners.set(session.id, runner)
        runtime.bindZCodeRunner(session, runner)
        runner.emit('delivery', { queueItemId: 'executed', phase: 'failed' })
        assert.equal(runtime.queues.get(session.id)[0].state, 'dispatching', 'a failure receipt cannot briefly return the input to the visible queue')
        runner.emit('done', { failed: true, delivery: 'observed' })
      } else {
        runtime.protocolRunners.set(session.id, runner)
        runtime.bindProtocolRunner(session, runner)
        runner.emit('done', { failed: true })
      }
      for (let i = 0; session.status !== 'error' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(session.status, 'error')
      assert.deepEqual(host.getQueue(session.id).map(item => item.id), ['untouched'])
      assert.deepEqual(store.load()[0].pendingQueue?.map(item => item.id), ['untouched'])
      assert.equal(runtime.activeQueueItems.has(session.id), false)
      assert.equal(runtime.deferredDispatches.has(session.id), false, 'failure cannot schedule the untouched next input')
      const events = await host.getEvents(session.id)
      assert.equal(events.filter(event => event.type === 'user_message' && event.payload.text === 'failed input').length, 1)
      assert.ok(events.some(event => event.type === 'turn_completed' && event.state === 'failed'))
    } finally {
      host.disposeAll()
      await host.closeSessionLogs()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const stage of ['before-rename', 'after-rename'] as const) test(`failed turn queue removal reports ${stage} persistence failure`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'failed-turn-persist-'))
  class FailingStore extends SessionStore {
    fail = false
    override save(sessions: Session[]): void {
      if (!this.fail) return super.save(sessions)
      if (stage === 'after-rename') super.save(sessions)
      throw new SessionStoreWriteError('fixture persistence failure', stage, undefined)
    }
  }
  const store = new FailingStore(join(root, 'sessions.json'))
  const host = new Orchestrator(() => agent, store, join(root, 'artifacts'), join(root, 'logs'))
  const session: Session = { id: 's', title: 'Failure', createdAt: 1, status: 'running', config: { agentId: 'codex', workdir: root } }
  const runtime = host as any
  runtime.sessions.set(session.id, session)
  runtime.events.set(session.id, [])
  runtime.seqRefs.set(session.id, { n: 0 })
  runtime.commitQueue(session, [
    { id: 'executed', prompt: 'failed input', acceptedAt: 1, state: 'dispatching', attempts: 1 },
    { id: 'untouched', prompt: 'pending input', acceptedAt: 2, state: 'pending', attempts: 0 }
  ])
  runtime.activeQueueItems.set(session.id, 'executed')
  try {
    store.fail = true
    runtime.finishFailedTurn(session)
    assert.equal(session.status, 'error')
    assert.deepEqual(host.getQueue(session.id).map(item => item.id), ['untouched'])
    assert.equal(runtime.activeQueueItems.has(session.id), false)
    assert.ok((await host.getEvents(session.id)).some(event => event.type === 'system_notice' && /持久化未确认/.test(event.payload.text)))
    if (stage === 'after-rename') assert.deepEqual(store.load()[0].pendingQueue?.map(item => item.id), ['untouched'])
  } finally {
    host.disposeAll()
    await host.closeSessionLogs()
    await rm(root, { recursive: true, force: true })
  }
})
