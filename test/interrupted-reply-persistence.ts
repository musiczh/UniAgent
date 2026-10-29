import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionLogStore } from '../src/main/sessionLogStore.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, Session, UAEvent } from '../src/shared/types.ts'

const root = join(tmpdir(), `uniagent-interrupted-reply-${process.pid}-${Date.now()}`)
const sessionFile = join(root, 'sessions.json')
const agent: AgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: '/usr/bin/true',
  adapter: 'codex',
  icon: '',
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
  id: 'interrupted-session',
  title: '中断恢复',
  config: { agentId: agent.id, workdir: root, permissionMode: 'read-only' },
  status: 'idle',
  createdAt: 1,
  nativeSessionId: 'missing-native-session',
  origin: 'created'
}
const partialReply: UAEvent = {
  sessionId: session.id,
  seq: 2,
  ts: 3,
  type: 'agent_message',
  state: 'running',
  payload: { id: 'reply-1', text: '进程退出前已经生成的回复' }
}

try {
  const appServerEvents: UAEvent[] = []
  const appServer = new AppServerRunner(session.id, { n: 0 }, agent, session.config)
  ;(appServer as any).threadId = session.nativeSessionId
  appServer.on('event', (event) => appServerEvents.push(event))
  ;(appServer as any).onNotification('item/started', {
    threadId: session.nativeSessionId,
    turnId: 'turn-before-start-response',
    item: { id: 'early-reply', type: 'agentMessage', text: '' }
  })
  ;(appServer as any).onNotification('item/agentMessage/delta', {
    threadId: session.nativeSessionId,
    turnId: 'turn-before-start-response',
    itemId: 'early-reply',
    delta: '提前到达的回复'
  })
  ;(appServer as any).flush()
  ;(appServer as any).onNotification('item/completed', {
    threadId: session.nativeSessionId,
    turnId: 'turn-before-start-response',
    item: { id: 'early-reply', type: 'agentMessage', text: '提前到达的回复' }
  })
  assert.deepEqual(
    appServerEvents.filter(({ type }) => type === 'agent_message').map(({ payload }) => payload.turnId),
    ['turn-before-start-response', 'turn-before-start-response', 'turn-before-start-response']
  )
  appServer.dispose()

  const store = new SessionStore(sessionFile)
  store.saveOrThrow([session])
  const logsRoot = join(root, 'session-logs')
  const first = new Orchestrator(
    (id) => id === agent.id ? agent : undefined,
    store,
    join(root, 'artifacts'),
    logsRoot
  )
  first.loadPersisted()
  const liveSession = first.getSessionById(session.id)!
  const streamer = (first as any).ensureMainStreamer(liveSession, agent)
  ;(first as any).turnCapture.set(session.id, {
    nativeTurnId: 'turn-1',
    nativeThreadId: session.nativeSessionId,
    startSeq: 0,
    startedAt: 1,
    latestDiff: ''
  })
  streamer.emit('event', {
    ...partialReply,
    seq: 0,
    type: 'turn_started',
    state: undefined,
    payload: { turnId: 'turn-1' }
  })
  streamer.emit('event', {
    ...partialReply,
    seq: 1,
    payload: { ...partialReply.payload, text: '进程退出前' }
  })
  streamer.emit('event', partialReply)
  streamer.emit('event', {
    ...partialReply,
    seq: 3,
    state: 'running',
    payload: { id: 'completed-reply', text: '已经完成的回复' }
  })
  streamer.emit('event', {
    ...partialReply,
    seq: 4,
    state: 'success',
    payload: { id: 'completed-reply', text: '已经完成的回复' }
  })
  const logged = new SessionLogStore(logsRoot).loadInterruptedReplies(session.id)
  assert.deepEqual(
    logged.map(({ state, payload }) => ({ state, id: payload.id, text: payload.text, turnId: payload.turnId })),
    [{ state: 'running', id: 'reply-1', text: partialReply.payload.text, turnId: 'turn-1' }]
  )

  const restarted = new Orchestrator(
    (id) => id === agent.id ? agent : undefined,
    new SessionStore(sessionFile),
    join(root, 'artifacts'),
    logsRoot
  )
  restarted.loadPersisted()
  const recovered: UAEvent[] = [
    { ...partialReply, seq: 0, type: 'user_message', state: undefined, payload: { text: '问题' } },
    { ...partialReply, seq: 1, type: 'turn_started', state: undefined, payload: { turnId: 'turn-1' } },
    { ...partialReply, seq: 2, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } }
  ]
  ;(restarted as any).restoreReplyCheckpoints(session.id, recovered)

  assert.deepEqual(
    recovered.map(({ type, state, payload }) => ({ type, state, text: payload.text })),
    [
      { type: 'user_message', state: undefined, text: '问题' },
      { type: 'turn_started', state: undefined, text: undefined },
      { type: 'agent_message', state: 'cancelled', text: partialReply.payload.text },
      { type: 'turn_completed', state: 'success', text: undefined }
    ]
  )

  const nativeFinal: UAEvent[] = [
    { ...partialReply, seq: 0, type: 'turn_started', state: undefined, payload: { turnId: 'turn-1' } },
    { ...partialReply, seq: 1, state: 'success', payload: { id: 'native-final', text: `${partialReply.payload.text}，完整。` } },
    { ...partialReply, seq: 2, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } }
  ]
  ;(restarted as any).restoreReplyCheckpoints(session.id, nativeFinal)
  assert.equal(nativeFinal.length, 3)

  const nativeShort: UAEvent[] = [
    { ...partialReply, seq: 0, type: 'turn_started', state: undefined, payload: { turnId: 'turn-1' } },
    { ...partialReply, seq: 1, state: 'success', payload: { id: 'reply-1', text: '进程退出前' } },
    { ...partialReply, seq: 2, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } }
  ]
  ;(restarted as any).restoreReplyCheckpoints(session.id, nativeShort)
  assert.deepEqual(
    nativeShort.map(({ type, state, payload }) => ({ type, state, text: payload.text })),
    [
      { type: 'turn_started', state: undefined, text: undefined },
      { type: 'agent_message', state: 'cancelled', text: partialReply.payload.text },
      { type: 'turn_completed', state: 'success', text: undefined }
    ]
  )

  const nativeShortWithDifferentId: UAEvent[] = [
    { ...partialReply, seq: 0, type: 'turn_started', state: undefined, payload: { turnId: 'turn-1' } },
    { ...partialReply, seq: 1, state: 'success', payload: { id: 'native-reply', text: '进程退出前' } },
    { ...partialReply, seq: 2, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } }
  ]
  ;(restarted as any).restoreReplyCheckpoints(session.id, nativeShortWithDifferentId)
  assert.equal(nativeShortWithDifferentId.length, 3)
  assert.equal(nativeShortWithDifferentId[1].payload.text, partialReply.payload.text)

  const edgeLogs = new SessionLogStore(join(root, 'edge-logs'), {
    maxFileBytes: 512 * 1_024,
    maxEntryBytes: 512
  })
  const longText = '长'.repeat(70 * 1_024)
  const replyEvent = (turnId: string, state: UAEvent['state'], text: string): UAEvent => ({
    ...partialReply,
    state,
    payload: { id: 'reused-reply-id', turnId, text }
  })
  edgeLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-long', 'running', longText)
  })
  assert.equal(edgeLogs.loadInterruptedReplies(session.id)[0]?.payload.text, longText)
  edgeLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-other', 'success', '另一轮已完成')
  })
  assert.deepEqual(
    edgeLogs.loadInterruptedReplies(session.id).map((event) => event.payload.turnId),
    ['turn-long'],
    '另一个 turn 复用 item id 时不应清除中断回复'
  )
  edgeLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-long', 'success', longText)
  })
  assert.deepEqual(edgeLogs.loadInterruptedReplies(session.id), [])

  const rotatingLogs = new SessionLogStore(join(root, 'rotating-logs'), {
    maxFileBytes: 512,
    maxEntryBytes: 128
  })
  rotatingLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-rotated', 'running', '第一段长回复'.repeat(100))
  })
  rotatingLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-rotated', 'running', '第二段更长回复'.repeat(120))
  })
  for (let index = 0; index < 5; index += 1) {
    rotatingLogs.append(session.id, 'provider_notification', {
      index,
      payload: '诊断'.repeat(200)
    })
  }
  assert.equal(
    rotatingLogs.loadInterruptedReplies(session.id)[0]?.payload.text,
    '第二段更长回复'.repeat(120)
  )
  rotatingLogs.append(session.id, 'ua_event', {
    channel: 'main',
    event: replyEvent('turn-rotated', 'success', '第二段更长回复'.repeat(120))
  })
  assert.deepEqual(rotatingLogs.loadInterruptedReplies(session.id), [])

  streamer.emit('event', {
    sessionId: session.id, seq: 20, ts: 20, type: 'agent_message', state: 'success',
    payload: { id: 'recoverable-question', delivery: 'async', questions: [{ id: 'scope', question: '继续吗？' }] }
  })
  streamer.emit('event', {
    sessionId: session.id, seq: 21, ts: 21, type: 'approval_request', state: 'pending',
    payload: { requestId: 'native-question', kind: 'question', params: { questions: [{ id: 'scope', question: '继续吗？' }] } }
  })
  first.disposeAll()
  await first.flushSessionLogs()
  const restoredQuestions = await restarted.getEvents(session.id)
  const recoverable = restoredQuestions.find(event => event.payload.id === 'recoverable-question')
  const native = restoredQuestions.find(event => event.payload.requestId === 'native-question')
  assert.ok(recoverable && !recoverable.payload.interactionExpired, 'an asynchronous question remains answerable after restart')
  assert.equal(native?.payload.interactionExpired, true, 'a native request tied to the old process is marked expired')
  let continuation = ''
  restarted.forceSend = async (_sessionId, prompt) => { continuation = prompt }
  const answer = { answers: { scope: { answers: ['继续'] } } }
  assert.equal((await restarted.respondToRequest(session.id, 'async-question:recoverable-question', answer))?.handled, true)
  assert.match(continuation, /回答：继续/, 'answering a restored question continues the same session')
  assert.deepEqual((await restarted.getEvents(session.id)).find(event => event.payload.id === 'recoverable-question')?.payload.submittedAnswer,
    answer, 'a restored asynchronous question can be resolved')
  restarted.disposeAll()
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('interrupted-reply-persistence: ok')
