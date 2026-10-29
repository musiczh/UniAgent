import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Session, UAEvent } from '../src/shared/types.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'

const root = join(tmpdir(), `uniagent-side-promotion-${process.pid}-${Date.now()}`)
const storePath = join(root, 'sessions.json')
const store = new SessionStore(storePath)
const agent: AgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: '/usr/bin/true',
  adapter: 'codex',
  icon: '',
  builtin: true,
  installed: true,
  capabilities: {
    modelSelect: false,
    reasoningEffort: false,
    streaming: true,
    permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
  },
  models: []
}
const source: Session = {
  id: 'source-session',
  title: '主会话',
  config: { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
  status: 'idle',
  createdAt: 1,
  nativeSessionId: 'main-thread',
  origin: 'created'
}
const sideEvents: UAEvent[] = [
  {
    sessionId: source.id,
    seq: 0,
    ts: 10,
    type: 'user_message',
    payload: { text: '把这个方案单独展开' }
  },
  {
    sessionId: source.id,
    seq: 1,
    ts: 11,
    type: 'agent_message',
    payload: { text: '侧边回答' }
  }
]

store.saveOrThrow([source])
const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
orchestrator.loadPersisted()
let disposed = false
let promotedEvents: UAEvent[] | undefined
const fakeRunner = {
  forkPersistent: async (events: UAEvent[]) => {
    promotedEvents = events
    return 'durable-side-thread'
  },
  removeAllListeners: () => {},
  dispose: () => { disposed = true },
  disposeFork: () => { disposed = true }
}
const internals = orchestrator as any
const sharedOwners: Array<{ sessionId: string; source: unknown }> = []
internals.ensureMainStreamer = (session: Session, _agent: AgentDef, _config: unknown, _announce: boolean, sharedWith?: unknown) => {
  if (sharedWith) sharedOwners.push({ sessionId: session.id, source: sharedWith })
  return {}
}
internals.ensureSideStreamer = () => {
  internals.sideStreamers.set(source.id, fakeRunner)
  return fakeRunner
}
internals.sideEvents.set(source.id, sideEvents)
internals.sideSeqRefs.set(source.id, { n: sideEvents.length })
internals.sideStatus.set(source.id, 'idle')

try {
  assert.equal(typeof internals.promoteSideToSession, 'function')
  const queued = { id: 'queued-during-edit', prompt: '不要丢失', acceptedAt: 2, state: 'pending', attempts: 0 }
  internals.sideQueues.set(source.id, [queued])
  internals.sideEditingItems.set(source.id, queued.id)
  await assert.rejects(internals.promoteSideToSession(source.id), /排队|编辑/)
  assert.deepEqual(internals.sideQueues.get(source.id), [queued])
  internals.sideQueues.set(source.id, [])
  internals.sideEditingItems.delete(source.id)

  const created: Session = await internals.promoteSideToSession(source.id)
  assert.equal(created.title, '把这个方案单独展开')
  assert.equal(created.nativeSessionId, 'durable-side-thread')
  assert.equal(created.status, 'idle')
  assert.deepEqual(created.config, source.config)
  assert.deepEqual(promotedEvents, sideEvents)
  assert.deepEqual(
    await orchestrator.getEvents(created.id),
    sideEvents.map((event, seq) => ({ ...event, sessionId: created.id, seq }))
  )
  assert.equal(internals.sideStreamers.has(source.id), false)
  assert.equal(internals.sideEvents.has(source.id), false)
  assert.equal(disposed, true)
  assert.deepEqual(sharedOwners.at(-1), { sessionId: created.id, source: fakeRunner })
  assert.equal(new SessionStore(storePath).load().some((session) => session.id === created.id), true)

  // Promotion owns the side branch exclusively: a concurrent send must not be
  // accepted into a queue that successful cleanup would immediately discard.
  const lockedEvents = structuredClone(sideEvents)
  internals.sideEvents.set(source.id, lockedEvents)
  internals.sideSeqRefs.set(source.id, { n: lockedEvents.length })
  internals.sideStatus.set(source.id, 'idle')
  let releasePromotion!: (threadId: string) => void
  const promotionPending = new Promise<string>((resolve) => { releasePromotion = resolve })
  const promotionRunner = {
    forkPersistent: async () => promotionPending,
    removeAllListeners: () => {},
    dispose: () => {},
    disposeFork: () => {},
    deleteThread: async () => {}
  }
  internals.ensureSideStreamer = () => {
    internals.sideStreamers.set(source.id, promotionRunner)
    return promotionRunner
  }
  const promoting = internals.promoteSideToSession(source.id)
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    orchestrator.sendSideMessage(source.id, '转换期间的新消息'),
    /正在转换/
  )
  assert.equal(internals.sideQueues.get(source.id)?.length || 0, 0)
  releasePromotion('durable-locked-side-thread')
  await promoting

  // Explaining a selection must save its own branch without replacing a side chat.
  internals.sideEvents.set(source.id, sideEvents)
  const detailEvents: UAEvent[] = [
    { sessionId: source.id, seq: 0, ts: 20, type: 'user_message',
      payload: { text: 'hidden contextual prompt', hidden: true, displayText: '解释：context.Context' } },
    { sessionId: source.id, seq: 1, ts: 21, type: 'agent_message',
      payload: { text: '它传递超时和取消信号。', detailTitle: 'Context 如何传递取消信号' } },
    { sessionId: source.id, seq: 2, ts: 22, type: 'user_message', payload: { text: '超时后呢？' } },
    { sessionId: source.id, seq: 3, ts: 23, type: 'agent_message', payload: { text: '查询会停止。' } },
  ]
  let detailDisposed = false
  const detailRunner = {
    forkPersistent: async (events: UAEvent[]) => {
      assert.deepEqual(events.filter((event) => event.type === 'user_message').map((event) => event.payload.text),
        ['解释：context.Context', '超时后呢？'])
      assert.equal(events.some((event) => event.payload.hidden), false)
      return 'durable-detail-thread'
    },
    removeAllListeners: () => {},
    dispose: () => { detailDisposed = true },
    disposeFork: () => { detailDisposed = true },
  }
  internals.detailStreamers.set(source.id, detailRunner)
  internals.detailEvents.set(source.id, detailEvents)
  internals.detailStatus.set(source.id, 'running')
  await assert.rejects(orchestrator.promoteDetailToSession(source.id), /仍在运行/)
  internals.detailStatus.set(source.id, 'idle')

  const save = store.saveOrThrow.bind(store)
  store.saveOrThrow = () => { throw new Error('disk full') }
  const sessionCountBeforeFailedDetail = orchestrator.listSessions().length
  try {
    await assert.rejects(orchestrator.promoteDetailToSession(source.id), /disk full/)
    assert.equal(orchestrator.listSessions().length, sessionCountBeforeFailedDetail,
      'failed persistence must roll back the new session')
    assert.equal(internals.detailEvents.get(source.id), detailEvents, 'failed persistence keeps the explanation')
    assert.equal(detailDisposed, false)
  } finally {
    store.saveOrThrow = save
  }

  const explanation = await orchestrator.promoteDetailToSession(source.id)
  assert.equal(explanation.title, 'Context 如何传递取消信号')
  assert.equal(explanation.nativeSessionId, 'durable-detail-thread')
  assert.deepEqual(explanation.config, source.config)
  const savedEvents = await orchestrator.getEvents(explanation.id)
  assert.deepEqual(savedEvents.map((event) => event.payload.text),
    ['解释：context.Context', '它传递超时和取消信号。', '超时后呢？', '查询会停止。'])
  assert.ok(savedEvents.every((event, seq) => event.sessionId === explanation.id && event.seq === seq))
  assert.equal(internals.sideEvents.get(source.id), sideEvents, 'existing side chat must survive')
  assert.equal(internals.detailEvents.has(source.id), false)
  assert.equal(detailDisposed, true)
  assert.deepEqual(sharedOwners.at(-1), { sessionId: explanation.id, source: detailRunner })
  assert.equal(new SessionStore(storePath).load().some((session) => session.id === explanation.id), true)
  console.log('side-chat-promotion: ok')
} finally {
  orchestrator.disposeAll()
  await rm(root, { recursive: true, force: true })
}
