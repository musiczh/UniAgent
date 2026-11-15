import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

const root = join(tmpdir(), `uniagent-side-running-fork-${process.pid}-${Date.now()}`)
const store = new SessionStore(join(root, 'sessions.json'))
const agent: AgentDef = {
  id: 'traex',
  name: 'TraeX',
  bin: '/usr/bin/true',
  adapter: 'traex',
  icon: '',
  builtin: true,
  installed: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    streaming: true,
    permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
  },
  models: []
}
const session: Session = {
  id: 'running-main',
  title: '运行中的主会话',
  config: { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
  status: 'running',
  createdAt: 1,
  nativeSessionId: 'main-thread',
  origin: 'created'
}
store.saveOrThrow([session])
const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
orchestrator.loadPersisted()
const internals = orchestrator as any
let capturedEvents: unknown
let capturedPriorSideEvents: unknown
const parent = {
  forkSideSnapshot: async (events: unknown, priorSideEvents: unknown) => {
    capturedEvents = events
    capturedPriorSideEvents = priorSideEvents
    return 'prepared-side-thread'
  },
  removeAllListeners: () => {},
  dispose: () => {}
}
internals.streamers.set(session.id, parent)
internals.events.set(session.id, [
  { sessionId: session.id, seq: 0, ts: 1, type: 'user_message', payload: { text: '主问题' } },
  { sessionId: session.id, seq: 1, ts: 2, type: 'agent_message', state: 'running', payload: { id: 'a', text: '部分回答' } }
])

const originalStartTurn = AppServerRunner.prototype.startTurn
let preparedId: string | undefined
try {
  AppServerRunner.prototype.startTurn = async function (): Promise<void> {
    preparedId = (await (this as any).forkPreparation((this as any).forkTranscript)).threadId
  }
  await orchestrator.sendSideMessage(session.id, '追问')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(preparedId, 'prepared-side-thread')
  assert.equal(internals.streamers.get(session.id), parent, 'the live parent runner must own the fork')
  assert.deepEqual(capturedEvents, internals.events.get(session.id))
  assert.deepEqual(capturedPriorSideEvents, [],
    'the first side prompt added after runner creation must be sent only by turn/start')
  assert.equal(internals.sideStreamers.get(session.id)?.forkFromThreadId, undefined,
    'the side runner must not fork the active parent from a second process')
  assert.equal(orchestrator.getSideStatus(session.id), 'running')

  internals.sideNativeSessionIds.set(session.id, 'old-side-thread')
  orchestrator.closeSideChat(session.id)
  const newState = orchestrator.getSideState(session.id)
  assert.equal(newState.hasLiveStreamer, false, '新对话按钮和状态读取不能提前冻结主会话上下文')
  assert.equal(internals.sideNativeSessionIds.has(session.id), false, '新对话不能复用旧侧边原生线程')
  assert.deepEqual(orchestrator.getSideEvents(session.id), [])
  const latest = { sessionId: session.id, seq: 2, ts: 3, type: 'agent_message', state: 'running', payload: { id: 'latest', text: '点击新对话后、发送前主会话新增的结果' } }
  internals.events.get(session.id).push(latest)
  await orchestrator.sendSideMessage(session.id, '基于最新进展追问')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(capturedEvents, internals.events.get(session.id), '第一次发送时才读取当前主会话数据')
  assert.ok((capturedEvents as unknown[]).includes(latest))
  assert.deepEqual(capturedPriorSideEvents, [], '新分支不能带入上一次侧边对话')

  const owner = orchestrator.getSessionById(session.id)!
  internals.streamers.delete(session.id)
  const runner = internals.ensureMainStreamer(owner, agent) as AppServerRunner
  const queued = {
    id: 'failed-head', prompt: 'provider startup input', acceptedAt: 1, state: 'dispatching', attempts: 1
  }
  internals.queues.set(session.id, [queued])
  owner.pendingQueue = [queued]
  owner.status = 'running'
  internals.activeQueueItems.set(session.id, queued.id)
  internals.record(session.id, { type: 'user_message', payload: { text: queued.prompt } })
  internals.record(session.id, { type: 'error', state: 'failed', payload: { message: 'provider startup failed' } })
  internals.record(session.id, { type: 'turn_completed', state: 'failed', payload: {} })
  runner.emit('done', { nativeSessionId: 'main-thread', failed: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(orchestrator.getSessionById(session.id)?.status, 'error')
  assert.deepEqual(orchestrator.getQueue(session.id), [], 'failed input leaves the sent queue without automatic retry')
  assert.deepEqual(store.load()[0].pendingQueue || [], [], 'restart cannot restore the failed input as pending')
  assert.equal(internals.activeQueueItems.has(session.id), false)
  assert.equal(internals.deferredDispatches.has(session.id), false, 'failure does not schedule another turn')
  const failedEvents = await orchestrator.getEvents(session.id)
  assert.equal(failedEvents.filter(event => event.type === 'user_message' && event.payload.text === queued.prompt).length, 1)
  assert.ok(failedEvents.some(event => event.type === 'error' && event.payload.message === 'provider startup failed'))
  assert.ok(failedEvents.some(event => event.type === 'turn_completed' && event.state === 'failed'))
  console.log('side-chat-running-fork: ok')
} finally {
  AppServerRunner.prototype.startTurn = originalStartTurn
  orchestrator.disposeAll()
  await rm(root, { recursive: true, force: true })
}
