import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { AgentDef, Session } from '../src/shared/types'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function agent(id: string): AgentDef {
  return {
    id,
    name: id,
    bin: '/usr/bin/true',
    adapter: 'generic',
    icon: '',
    builtin: false,
    installed: true,
    capabilities: {
      modelSelect: false,
      reasoningEffort: false,
      permissionModes: []
    },
    models: []
  }
}

function streamingAgent(id: string): AgentDef {
  const base = agent(id)
  return { ...base, adapter: 'codex', capabilities: { ...base.capabilities, streaming: true } }
}

function queuedSession(id: string, agentId: string): Session {
  return {
    id,
    title: id,
    config: { agentId, workdir: tmpdir() },
    status: 'idle',
    createdAt: Date.now(),
    origin: 'created',
    readOnly: false,
    pendingQueue: [{
      id: `queue-${id}`,
      prompt: `prompt-${id}`,
      acceptedAt: Date.now(),
      state: 'pending',
      attempts: 0
    }]
  }
}

async function fixture(sessions: Session[]): Promise<{
  orchestrator: Orchestrator
  storePath: string
}> {
  const storePath = join(
    tmpdir(),
    `uniagent-scoped-queue-resume-${process.pid}-${Date.now()}-${Math.random()}.json`
  )
  const store = new SessionStore(storePath)
  store.save(sessions)
  const agents = new Map(sessions.map((session) => [
    session.config.agentId,
    agent(session.config.agentId)
  ]))
  const orchestrator = new Orchestrator((id) => agents.get(id), store)
  orchestrator.loadPersisted()
  return { orchestrator, storePath }
}

async function scopedSelectionAndCompatibility(): Promise<void> {
  const { orchestrator, storePath } = await fixture([
    queuedSession('ready-session', 'ready-agent'),
    queuedSession('late-session', 'late-agent')
  ])
  const dispatched: string[] = []
  ;(orchestrator as any).getEvents = async (): Promise<[]> => []
  ;(orchestrator as any).dispatchPendingQueue = (session: Session): void => {
    dispatched.push(session.id)
  }

  try {
    orchestrator.resumePendingQueues(new Set(['ready-agent']))
    const readyTail = (orchestrator as any).sendTails.get('ready-session') as
      | Promise<void>
      | undefined
    assert.ok(readyTail, 'an eligible recovery tail must be installed synchronously')
    assert.equal(
      (orchestrator as any).sendTails.has('late-session'),
      false,
      'a Set filter must leave later agents untouched'
    )
    await readyTail
    assert.deepEqual(dispatched, ['ready-session'])

    orchestrator.resumePendingQueues((agentId) => agentId === 'late-agent')
    const lateTail = (orchestrator as any).sendTails.get('late-session') as Promise<void>
    await lateTail
    assert.deepEqual(dispatched, ['ready-session', 'late-session'])

    const all = await fixture([queuedSession('legacy-session', 'legacy-agent')])
    try {
      ;(all.orchestrator as any).getEvents = async (): Promise<[]> => []
      ;(all.orchestrator as any).dispatchPendingQueue = (session: Session): void => {
        dispatched.push(session.id)
      }
      all.orchestrator.resumePendingQueues()
      await ((all.orchestrator as any).sendTails.get('legacy-session') as Promise<void>)
      assert.deepEqual(dispatched, ['ready-session', 'late-session', 'legacy-session'])
    } finally {
      await rm(all.storePath, { force: true })
    }
  } finally {
    await rm(storePath, { force: true })
  }
}

async function lateEligibilityRechecks(): Promise<void> {
  const mutations: Array<{
    name: string
    mutate: (orchestrator: Orchestrator, session: Session) => void
  }> = [
    {
      name: 'deleted owner',
      mutate: (orchestrator, session) => orchestrator.deleteSession(session.id)
    },
    {
      name: 'replacement owner',
      mutate: (orchestrator, session) => {
        const replacement = { ...session, title: 'replacement' }
        ;(orchestrator as any).sessions.set(session.id, replacement)
      }
    },
    {
      name: 'archived owner',
      mutate: (orchestrator, session) => {
        orchestrator.setArchived(session.id, true)
      }
    },
    {
      name: 'read-only owner',
      mutate: (_orchestrator, session) => {
        session.readOnly = true
      }
    },
    {
      name: 'empty queue',
      mutate: (orchestrator, session) => {
        orchestrator.dequeue(session.id, `queue-${session.id}`)
      }
    }
  ]

  for (const { name, mutate } of mutations) {
    const sessionId = `late-${name.replaceAll(' ', '-')}`
    const { orchestrator, storePath } = await fixture([queuedSession(sessionId, 'ready-agent')])
    const gate = deferred()
    const entered = deferred()
    const dispatched: string[] = []
    ;(orchestrator as any).getEvents = async (): Promise<[]> => {
      entered.resolve()
      await gate.promise
      return []
    }
    ;(orchestrator as any).dispatchPendingQueue = (session: Session): void => {
      dispatched.push(session.id)
    }

    try {
      orchestrator.resumePendingQueues(new Set(['ready-agent']))
      const tail = (orchestrator as any).sendTails.get(sessionId) as Promise<void> | undefined
      assert.ok(tail, `${name}: recovery tail must exist before resumePendingQueues returns`)
      await entered.promise
      const session = orchestrator.listSessions().find((entry) => entry.id === sessionId)
      assert.ok(session, `${name}: fixture session must exist before mutation`)
      mutate(orchestrator, session)
      gate.resolve()
      await tail
      assert.deepEqual(dispatched, [], `${name}: stale async recovery must not dispatch`)
    } finally {
      gate.resolve()
      await rm(storePath, { force: true })
    }
  }

  const { orchestrator, storePath } = await fixture([
    queuedSession('revoked-agent-session', 'ready-agent')
  ])
  const gate = deferred()
  const entered = deferred()
  const dispatched: string[] = []
  let allowed = true
  ;(orchestrator as any).getEvents = async (): Promise<[]> => {
    entered.resolve()
    await gate.promise
    return []
  }
  ;(orchestrator as any).dispatchPendingQueue = (session: Session): void => {
    dispatched.push(session.id)
  }
  try {
    orchestrator.resumePendingQueues((agentId) => allowed && agentId === 'ready-agent')
    const tail = (orchestrator as any).sendTails.get('revoked-agent-session') as Promise<void>
    await entered.promise
    allowed = false
    gate.resolve()
    await tail
    assert.deepEqual(dispatched, [], 'agent readiness must be re-evaluated after hydration')
  } finally {
    gate.resolve()
    await rm(storePath, { force: true })
  }
}

async function appServerThreadIdPersistsBeforeTurnCompletes(): Promise<void> {
  const session = queuedSession('streaming-session', 'streaming-agent')
  session.pendingQueue = []
  const { orchestrator, storePath } = await fixture([session])
  const liveSession = orchestrator.listSessions().find((entry) => entry.id === session.id)
  assert.ok(liveSession, 'persisted streaming session must be loaded')
  const startTurn = (await import('../src/main/appServerAdapter')).AppServerRunner.prototype.startTurn
  ;(await import('../src/main/appServerAdapter')).AppServerRunner.prototype.startTurn = async () => {}

  try {
    ;(orchestrator as any).runStreaming(liveSession, agent('streaming-agent'), 'first prompt')
    const streamer = (orchestrator as any).streamers.get(liveSession.id)
    assert.ok(streamer, 'streaming runner must be installed')
    streamer.emit('event', {
      sessionId: liveSession.id,
      seq: 0,
      ts: Date.now(),
      type: 'turn_started',
      payload: { threadId: 'native-thread-before-done' }
    })

    assert.equal(
      new SessionStore(storePath).load()[0]?.nativeSessionId,
      'native-thread-before-done',
      'app-server thread id must be durable before the done event'
    )
  } finally {
    ;(await import('../src/main/appServerAdapter')).AppServerRunner.prototype.startTurn = startTurn
    orchestrator.disposeSession(liveSession.id)
    await rm(storePath, { force: true })
  }
}

async function missingNativeThreadDoesNotReplay(): Promise<void> {
  const session = queuedSession('missing-native', 'streaming-agent')
  const { orchestrator, storePath } = await fixture([session])
  const dispatched: string[] = []
  ;(orchestrator as any).getAgent = (id: string) => streamingAgent(id)
  ;(orchestrator as any).dispatchPendingQueue = (owner: Session) => dispatched.push(owner.id)
  try {
    orchestrator.resumePendingQueues()
    assert.equal(
      (orchestrator as any).sendTails.has(session.id),
      false,
      'a missing native thread must be rejected before installing a recovery tail'
    )
    assert.deepEqual(dispatched, [], 'a resumable agent must not replay without its native thread id')
  } finally {
    await rm(storePath, { force: true })
  }
}

async function forkPathRunnerForwardsSkillsChangedExactlyOnceWhenReused(): Promise<void> {
  const session = queuedSession('fork-scope', 'streaming-agent')
  session.pendingQueue = []
  const { orchestrator, storePath } = await fixture([session])
  const liveSession = orchestrator.listSessions().find((entry) => entry.id === session.id)
  assert.ok(liveSession, 'fork fixture session must be loaded')
  const { AppServerRunner } = await import('../src/main/appServerAdapter')
  const startTurn = AppServerRunner.prototype.startTurn
  AppServerRunner.prototype.startTurn = async () => {}
  const changes: Array<{ agentId: string; workdir: string }> = []
  orchestrator.on('nativeCapabilitiesChanged', (change) => changes.push(change))

  try {
    const forkRunner = (orchestrator as any).ensureStreamerForFork(liveSession, streamingAgent('streaming-agent'))
    assert.equal(
      (orchestrator as any).ensureStreamerForFork(liveSession, streamingAgent('streaming-agent')),
      forkRunner,
      'fork retry must reuse its retained main runner'
    )
    forkRunner.emit('skillsChanged')
    assert.deepEqual(changes, [{ agentId: 'streaming-agent', workdir: liveSession.config.workdir }])

    ;(orchestrator as any).runStreaming(liveSession, streamingAgent('streaming-agent'), 'reused after fork failure')
    forkRunner.emit('skillsChanged')
    assert.deepEqual(changes, [
      { agentId: 'streaming-agent', workdir: liveSession.config.workdir },
      { agentId: 'streaming-agent', workdir: liveSession.config.workdir }
    ], 'reusing the fork-path runner must retain exactly one invalidation listener')
  } finally {
    AppServerRunner.prototype.startTurn = startTurn
    orchestrator.disposeSession(liveSession.id)
    await rm(storePath, { force: true })
  }
}

await scopedSelectionAndCompatibility()
await lateEligibilityRechecks()
await appServerThreadIdPersistsBeforeTurnCompletes()
await missingNativeThreadDoesNotReplay()
await forkPathRunnerForwardsSkillsChangedExactlyOnceWhenReused()
console.log('orchestrator-scoped-queue-resume: ok')
