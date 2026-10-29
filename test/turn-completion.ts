import assert from 'node:assert/strict'
import test from 'node:test'
import { Orchestrator } from '../src/main/orchestrator'
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
    let restored = 0
    const finalization = new Promise<void>(resolve => { release = resolve })
    Object.assign(host, { worktreeTransitions: new Set(), streamers: new Map(), sessions: new Map([['s', session]]),
      seqRefs: new Map(), events: new Map(), activeQueueItems: new Map(failed ? [['s', 'queued-input']] : []),
      turnCapture: new Map([['s', { fileChanges: [], ...(edited ? { latestDiff: 'file diff' } : {}) }]]),
      bindAppServerDiagnostics() {}, bindNativeCapabilityInvalidation() {},
      installMainStreamerOwner(id: string, runner: unknown) { this.streamers.set(id, runner) },
      logSession() {}, currentTurnInput() { return input }, finalizeTurnArtifact() { return finalization },
      restoreQueueItemsToPending() { restored++ },
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
    assert.equal(restored, failed ? 1 : 0)
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
    channelSendTurns: new Map(), feishuTeamInputs: new Map(), deferredDispatches: new Map(), editingQueueItems: new Map(),
    zcodeStarts: new Map(), recoveryStartTokens: new Map(), streamers: new Map(), protocolRunners: new Map([['s', runner]]),
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
