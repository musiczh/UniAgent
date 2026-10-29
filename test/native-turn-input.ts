import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInput } from '../src/main/maxMode.ts'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import * as orchestratorModule from '../src/main/orchestrator.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { appendFeishuContext } from '../src/shared/feishuContext.ts'
import { handoffMcpArgs } from '../src/main/handoff.ts'
import type {
  AgentDef,
  DurableQueueItem,
  ResolvedNativeTurnContext,
  Session
} from '../src/shared/types.ts'

const context: ResolvedNativeTurnContext = {
  skills: [{ name: 'openai-docs', path: '/skills/openai-docs/SKILL.md' }],
  mcpServers: [{ name: 'figma' }]
}

assert.deepEqual(
  buildInput(
    '检查 API',
    [{ kind: 'file', name: 'api.ts', path: '/repo/api.ts' }],
    context
  ),
  [
    { type: 'text', text: '检查 API', text_elements: [] },
    { type: 'mention', name: 'api.ts', path: '/repo/api.ts' },
    { type: 'skill', name: 'openai-docs', path: '/skills/openai-docs/SKILL.md' }
  ]
)
const structuredInput = buildInput('检查 API', undefined, context)
assert.doesNotMatch(JSON.stringify(structuredInput), /@openai-docs|@mcp:figma/)
assert.equal(JSON.stringify(structuredInput).includes('mcpServers'), false)

const buildDurableQueueItem = (orchestratorModule as unknown as {
  buildDurableQueueItem?: (
    prompt: string,
    attachments?: undefined,
    nativeContext?: ResolvedNativeTurnContext,
    acceptedAt?: number
  ) => DurableQueueItem
}).buildDurableQueueItem
assert.equal(typeof buildDurableQueueItem, 'function')
const queued = buildDurableQueueItem!('检查 API', undefined, context, 100)
assert.match(queued.id, /^q_/)
assert.deepEqual(queued.nativeContext, context)
assert.equal(queued.acceptedAt, 100)
assert.equal(queued.state, 'pending')
assert.equal(queued.attempts, 0)

function streamingAgent(): AgentDef {
  return {
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
      steer: true,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models: []
  }
}

function persistedSession(queue: DurableQueueItem[]): Session {
  return {
    id: 'persisted-native-context',
    title: 'persisted-native-context',
    config: { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' },
    status: 'idle',
    createdAt: 1,
    origin: 'created',
    nativeSessionId: 'native-thread',
    pendingQueue: queue
  }
}

async function sessionStoreRoundTrip(): Promise<void> {
  const storePath = join(tmpdir(), `uniagent-native-context-store-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(storePath)
  try {
    store.saveOrThrow([persistedSession([{
      id: 'q-roundtrip',
      prompt: 'roundtrip',
      nativeContext: {
        skills: [
          { name: 'openai-docs', path: '/skills/openai-docs/SKILL.md' },
          { name: '', path: '/skills/invalid/SKILL.md' }
        ],
        mcpServers: [{ name: 'figma', startupStatus: 'ready' }, { name: '' }],
        candidateIds: ['skill:/forged/SKILL.md']
      } as any,
      acceptedAt: 10,
      state: 'steering',
      attempts: 2
    }])])
    const restored = store.load()[0]?.pendingQueue?.[0]
    assert.deepEqual(restored?.nativeContext, context)
    assert.equal(restored?.state, 'pending', 'restart recovery must still replay in-flight rows')
    assert.equal(restored?.attempts, 2, 'restart recovery must preserve attempts')

    store.saveOrThrow([persistedSession([{
      id: 'q-empty-context',
      prompt: 'empty context',
      nativeContext: {
        skills: [{ name: '', path: '' }],
        mcpServers: [{ name: '' }]
      },
      acceptedAt: 11,
      state: 'pending',
      attempts: 0
    }])])
    assert.equal(
      Object.hasOwn(store.load()[0]?.pendingQueue?.[0] || {}, 'nativeContext'),
      false,
      'a context with no valid provider-native entries must be omitted'
    )
  } finally {
    await rm(storePath, { force: true })
  }
}

async function appServerWireContract(): Promise<void> {
  class RecordingTransport extends EventEmitter {
    calls: Array<{ method: string; params: any }> = []
    failSteer = false
    async start(): Promise<void> {}
    async request(method: string, params: any): Promise<any> {
      this.calls.push({ method, params })
      if (method === 'initialize') return {}
      if (method === 'thread/resume') return { thread: { id: 'native-thread' } }
      if (method === 'turn/start') return { turn: { id: 'native-turn' } }
      if (method === 'turn/steer' && this.failSteer) throw new Error('steer rejected')
      return {}
    }
    notify(): void {}
    respond(): void {}
    interrupt(): void {}
    async dispose(): Promise<void> {}
  }
  const transport = new RecordingTransport()
  const agent = streamingAgent()
  const runner = new AppServerRunner(
    'wire-contract',
    { n: 0 },
    agent,
    { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
    'native-thread',
    undefined,
    () => transport as never
  )
  const steerFallbacks: Array<{ nativeContext?: ResolvedNativeTurnContext }> = []
  runner.on('steerFailed', (item) => steerFallbacks.push(item))
  try {
    await runner.startTurn('start', undefined, context)
    await runner.steer('steer', undefined, context)
    const turnStart = transport.calls.find((call) => call.method === 'turn/start')
    const turnSteer = transport.calls.find((call) => call.method === 'turn/steer')
    assert.deepEqual(turnStart?.params.input, [
      { type: 'text', text: 'start', text_elements: [] },
      { type: 'skill', name: 'openai-docs', path: '/skills/openai-docs/SKILL.md' }
    ])
    assert.deepEqual(turnSteer?.params.input, [
      { type: 'text', text: 'steer', text_elements: [] },
      { type: 'skill', name: 'openai-docs', path: '/skills/openai-docs/SKILL.md' }
    ])
    assert.equal(JSON.stringify([turnStart, turnSteer]).includes('mcpServers'), false)
    transport.failSteer = true
    await runner.steer('fallback', undefined, context)
    assert.deepEqual(steerFallbacks.at(-1)?.nativeContext, context)
    const fallbackCount = steerFallbacks.length
    await assert.rejects(
      runner.steerStrict('strict-force', undefined, context),
      /steer rejected/,
    )
    assert.equal(steerFallbacks.length, fallbackCount, 'strict force-send must never emit the queue fallback event')
  } finally {
    runner.dispose()
  }
}

async function orchestratorDataPlane(): Promise<void> {
  const storePath = join(tmpdir(), `uniagent-native-context-orchestrator-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(storePath)
  const agent = streamingAgent()
  const originalStartTurn = AppServerRunner.prototype.startTurn
  const originalSteer = AppServerRunner.prototype.steer
  const originalSteerStrict = AppServerRunner.prototype.steerStrict
  const starts: Array<{ prompt: string; nativeContext?: ResolvedNativeTurnContext }> = []
  const steers: Array<{ prompt: string; nativeContext?: ResolvedNativeTurnContext }> = []
  AppServerRunner.prototype.startTurn = async function (
    prompt: string,
    _attachments?: unknown,
    nativeContext?: ResolvedNativeTurnContext
  ): Promise<void> {
    starts.push({ prompt, nativeContext })
  } as typeof AppServerRunner.prototype.startTurn
  AppServerRunner.prototype.steer = async function (
    prompt: string,
    _attachments?: unknown,
    nativeContext?: ResolvedNativeTurnContext
  ): Promise<void> {
    steers.push({ prompt, nativeContext })
  } as typeof AppServerRunner.prototype.steer
  AppServerRunner.prototype.steerStrict = AppServerRunner.prototype.steer

  let orchestrator: Orchestrator | undefined
  let restarted: Orchestrator | undefined
  try {
    orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
    const session = orchestrator.createSession(
      { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
      'first',
      undefined,
      { handoffId: 'handoff-1', handoffWaiting: true },
      context
    )
    assert.equal(session.handoffId, 'handoff-1')
    assert.equal(session.handoffWaiting, true)
    assert.equal(session.handoffUserContinued, undefined, 'the initial MCP prompt does not enable Feishu notifications')
    assert.equal(new SessionStore(storePath).load()[0]?.handoffUserContinued, undefined)
    assert.equal(session.submittedUserMessages?.at(-1)?.source, 'mcp')
    assert.deepEqual(starts, [{ prompt: 'first', nativeContext: context }])
    assert.deepEqual(
      (await orchestrator.getEvents(session.id)).find((event) => event.type === 'user_message')?.payload.nativeContext,
      context,
      'the audit event for the first turn must retain nativeContext'
    )

    session.status = 'idle'
    await orchestrator.sendMessage(session.id, 'send-tail', undefined, context, false, { source: 'mcp' })
    assert.equal(session.handoffUserContinued, undefined, 'an MCP follow-up stays silent')
    assert.equal(new SessionStore(storePath).load()[0]?.handoffUserContinued, undefined)
    assert.equal(session.submittedUserMessages?.at(-1)?.source, 'mcp')
    assert.deepEqual(starts.at(-1), { prompt: 'send-tail', nativeContext: context })
    assert.deepEqual(
      (await orchestrator.getEvents(session.id)).filter((event) => event.type === 'user_message').at(-1)?.payload.nativeContext,
      context,
      'history-hydrated send tails must retain nativeContext in their audit event'
    )
    assert.equal(
      (await orchestrator.getEvents(session.id)).filter((event) => event.type === 'user_message').at(-1)?.payload.appendedToTurn,
      undefined,
      'an idle follow-up starts a normal visual turn'
    )

    await assert.rejects(orchestrator.forceSend(session.id, 'forced', undefined, context), /启用/)
    orchestrator.enableToolSession(session.id)
    await orchestrator.forceSend(session.id, 'forced', undefined, context)
    assert.equal(session.submittedUserMessages?.at(-1)?.source, 'app')
    assert.equal(session.submittedUserMessages?.at(-1)?.appendedToTurn, true)
    assert.deepEqual(steers.at(-1), { prompt: 'forced', nativeContext: context })

    await orchestrator.forceSendStrict(session.id, 'mcp-forced')
    assert.equal(session.handoffUserContinued, true)
    assert.equal(session.submittedUserMessages?.at(-1)?.source, 'mcp', 'a later MCP force-send is silent again')
    assert.equal(session.submittedUserMessages?.at(-1)?.appendedToTurn, true)
    assert.equal(new SessionStore(storePath).load()[0]?.submittedUserMessages?.at(-1)?.source, 'mcp')
    assert.equal(new SessionStore(storePath).load()[0]?.submittedUserMessages?.at(-1)?.appendedToTurn, true)

    await orchestrator.sendMessage(session.id, 'queued', undefined, context)
    assert.deepEqual(orchestrator.getQueue(session.id)[0]?.nativeContext, context)
    assert.deepEqual(new SessionStore(storePath).load()[0]?.pendingQueue?.[0]?.nativeContext, context)

    orchestrator.promoteQueueItem(session.id, orchestrator.getQueue(session.id)[0].id)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(session.submittedUserMessages?.at(-1)?.source, 'app', 'the delivered desktop turn opts into notifications')
    assert.equal(session.submittedUserMessages?.at(-1)?.appendedToTurn, true)
    assert.deepEqual(steers.at(-1), { prompt: 'queued', nativeContext: context })

    const streamer = (orchestrator as any).streamers.get(session.id) as AppServerRunner
    streamer.emit('steerFailed', { prompt: 'fallback', nativeContext: context })
    assert.deepEqual(orchestrator.getQueue(session.id)[0]?.nativeContext, context)
    streamer.emit('event', {
      sessionId: session.id,
      seq: 99,
      ts: Date.now(),
      type: 'turn_started',
      payload: { threadId: 'native-thread' }
    })
    orchestrator.disposeSession(session.id)

    restarted = new Orchestrator((id) => id === agent.id ? agent : undefined, new SessionStore(storePath))
    restarted.loadPersisted()
    const recovered = restarted.listSessions().find((entry) => entry.id === session.id)
    assert.ok(recovered)
    assert.equal(recovered.handoffUserContinued, true, 'manual continuation survives an app restart')
    assert.equal(recovered.submittedUserMessages?.at(-1)?.source, 'app', 'the latest turn source survives an app restart')
    assert.deepEqual(restarted.getQueue(session.id)[0]?.nativeContext, context)
    const replayed: Array<{ prompt: string; nativeContext?: ResolvedNativeTurnContext }> = []
    ;(restarted as any).run = (
      _session: Session,
      prompt: string,
      _attachments?: unknown,
      nativeContext?: ResolvedNativeTurnContext
    ): boolean => {
      replayed.push({ prompt, nativeContext })
      return true
    }
    ;(restarted as any).dispatchPendingQueue(recovered)
    assert.deepEqual(replayed, [{ prompt: 'fallback', nativeContext: context }])
    assert.equal(
      (await restarted.getEvents(session.id)).find((event) => event.type === 'user_message' && event.payload.text === 'fallback')?.payload.appendedToTurn,
      undefined,
      'a sequential queue delivery starts a normal visual turn'
    )
    assert.equal(recovered.submittedUserMessages?.at(-1)?.appendedToTurn, undefined)
    assert.equal(new SessionStore(storePath).load()[0]?.submittedUserMessages?.at(-1)?.appendedToTurn, undefined)
  } finally {
    if (orchestrator) {
      for (const session of orchestrator.listSessions()) orchestrator.disposeSession(session.id)
    }
    if (restarted) {
      for (const session of restarted.listSessions()) restarted.disposeSession(session.id)
    }
    AppServerRunner.prototype.startTurn = originalStartTurn
    AppServerRunner.prototype.steer = originalSteer
    AppServerRunner.prototype.steerStrict = originalSteerStrict
    await rm(storePath, { force: true })
  }
}

async function feishuTurnSources(): Promise<void> {
  const storePath = join(tmpdir(), `uniagent-feishu-source-${process.pid}-${Date.now()}.json`)
  const store = new SessionStore(storePath)
  const agent = streamingAgent()
  const startTurn = AppServerRunner.prototype.startTurn
  const steer = AppServerRunner.prototype.steer
  const steerStrict = AppServerRunner.prototype.steerStrict
  AppServerRunner.prototype.startTurn = async () => {}
  AppServerRunner.prototype.steer = async () => {}
  AppServerRunner.prototype.steerStrict = AppServerRunner.prototype.steer
  const orchestrator = new Orchestrator(() => agent, store)
  const restarted = new Orchestrator(() => agent, new SessionStore(storePath))
  try {
    const session = orchestrator.createSession(
      { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
      appendFeishuContext('飞书首条消息'), undefined, undefined, undefined, undefined, { source: 'feishu' }
    )
    const initial = orchestrator.getFeishuSendTurn(session.id)
    assert.ok(initial)
    await orchestrator.sendMessage(session.id, appendFeishuContext('桌面粘贴旧 context'))
    await orchestrator.sendMessage(session.id, appendFeishuContext('飞书排队'), undefined, undefined, false, { source: 'feishu' })
    assert.equal(orchestrator.getFeishuSendTurn(session.id), initial, 'enqueueing does not change the live turn source')
    const [desktop, feishu] = orchestrator.getQueue(session.id)
    assert.equal(store.load()[0].pendingQueue?.find((item) => item.id === feishu.id)?.source, 'feishu')
    assert.equal(store.load()[0].submittedUserMessages?.[0]?.source, 'feishu')

    orchestrator.promoteQueueItem(session.id, desktop.id)
    await new Promise(setImmediate)
    assert.equal(orchestrator.getFeishuSendTurn(session.id), undefined, 'desktop input cannot inherit permission from prompt text')
    orchestrator.promoteQueueItem(session.id, feishu.id)
    await new Promise(setImmediate)
    assert.ok(orchestrator.getFeishuSendTurn(session.id), 'the queued Feishu source is applied on delivery')
    await orchestrator.forceSend(session.id, '桌面强制插话')
    assert.equal(orchestrator.getFeishuSendTurn(session.id), undefined)

    const liveStreamer = (orchestrator as any).streamers.get(session.id) as AppServerRunner
    ;(liveStreamer as any).steerStrict = steerStrict
    const followUp = appendFeishuContext('飞书直接插话')
    const image = { kind: 'image' as const, name: 'follow-up.png', path: '/repo/follow-up.png' }
    await assert.rejects(
      orchestrator.forceSend(session.id, followUp, [image], undefined, { source: 'feishu' }, false),
      /force_send_requires_active_turn/
    )
    assert.equal(orchestrator.getQueue(session.id).length, 0, 'a starting turn must not queue Feishu follow-ups')
    assert.equal(orchestrator.getFeishuSendTurn(session.id), undefined, 'failed delivery must not change the turn source')
    assert.equal((await orchestrator.getEvents(session.id)).some((event) => event.payload.text === followUp), false)

    ;(liveStreamer as any).threadId = 'feishu-thread'
    ;(liveStreamer as any).curTurnId = 'feishu-turn'
    let rejectSteer = true
    let acknowledge: (() => void) | undefined
    ;(liveStreamer as any).rpc = async (method: string, params: unknown) => {
      assert.equal(method, 'turn/steer')
      assert.deepEqual(params, {
        threadId: 'feishu-thread', expectedTurnId: 'feishu-turn',
        input: [
          { type: 'text', text: followUp, text_elements: [] },
          { type: 'localImage', path: '/repo/follow-up.png' }
        ]
      })
      if (rejectSteer) throw new Error('steer rejected')
      await new Promise<void>((resolve) => { acknowledge = resolve })
    }
    await assert.rejects(
      orchestrator.forceSend(session.id, followUp, [image], undefined, { source: 'feishu' }, false),
      /steer rejected/
    )
    assert.equal(orchestrator.getQueue(session.id).length, 0, 'a rejected steer must not create a queue entry')
    rejectSteer = false
    const delivery = orchestrator.forceSend(session.id, followUp, [image], undefined, { source: 'feishu' }, false)
    await new Promise(setImmediate)
    assert.equal(orchestrator.getFeishuSendTurn(session.id), undefined, 'delivery waits for the provider acknowledgement')
    acknowledge!()
    await delivery
    assert.equal(orchestrator.getQueue(session.id).length, 0)
    assert.ok(orchestrator.getFeishuSendTurn(session.id), 'direct Feishu input retains permission to reply')
    const delivered = (await orchestrator.getEvents(session.id)).filter((event) => event.payload.text === followUp)
    assert.equal(delivered.length, 1, 'only the accepted follow-up is recorded')
    assert.deepEqual(delivered[0].payload.attachments, [image])
    assert.equal(delivered[0].payload.source, 'feishu')
    assert.equal(delivered[0].payload.asyncQuestion, undefined, 'ordinary additions must still rotate the Feishu card')

    liveStreamer.emit('event', {
      sessionId: session.id, seq: 100, ts: Date.now(), type: 'agent_message', state: 'success',
      payload: { id: 'question-history', phase: 'final_answer', delivery: 'async', text: '是否继续？',
        questions: [{ id: 'continue', question: '是否继续？', options: ['继续'] }] }
    })
    const answer = { answers: { continue: { answers: ['继续'] } } }
    const strict = liveStreamer.steerStrict
    const beforeAnswer = (await orchestrator.getEvents(session.id)).filter(event => event.type === 'user_message').length
    liveStreamer.steerStrict = async () => { throw new Error('answer rejected') }
    await assert.rejects(
      orchestrator.respondToRequest(session.id, 'async-question:question-history', answer, { source: 'feishu' }) as Promise<unknown>,
      /answer rejected/
    )
    assert.equal((await orchestrator.getEvents(session.id)).filter(event => event.type === 'user_message').length, beforeAnswer,
      'a rejected answer cannot publish a continuation event')
    liveStreamer.steerStrict = async () => {}
    try {
      const result = await orchestrator.respondToRequest(session.id, 'async-question:question-history', answer, { source: 'feishu' })
      assert.equal(result?.handled, true)
      const reply = (await orchestrator.getEvents(session.id)).findLast(event => event.type === 'user_message')!
      assert.equal(reply.payload.source, 'feishu')
      assert.equal(reply.payload.appendedToTurn, true)
      assert.equal(reply.payload.asyncQuestion, true, 'an accepted question answer is distinguished from a new task addition')
    } finally { liveStreamer.steerStrict = strict }

    const skipQuestion = {
      sessionId: session.id, seq: 101, ts: Date.now(), type: 'agent_message' as const, state: 'success' as const,
      payload: { id: 'skip-question', delivery: 'async', questions: [
        { id: 'device', question: '设备是否已解锁？', options: ['已解锁'] },
        { id: 'note', question: '补充说明？' },
      ] }
    }
    const skipAnswer = { action: 'skip' }
    const forceSend = orchestrator.forceSend
    let skipDispatches = 0
    orchestrator.forceSend = async () => { skipDispatches++; throw new Error('跳过不应发送消息') }
    try {
      for (const status of ['running', 'completed', 'awaiting-approval'] as const) {
        session.status = status
        const question = { ...skipQuestion, payload: { ...skipQuestion.payload, id: `skip-${status}` } }
        const other = { ...question, seq: 102, payload: { ...question.payload, id: `other-${status}` } }
        liveStreamer.emit('event', question)
        liveStreamer.emit('event', other)
        const requestId = `async-question:${question.payload.id}`
        const beforeSkip = (await orchestrator.getEvents(session.id)).filter(event => event.type === 'user_message' || event.type === 'turn_started')
        const queue = orchestrator.getQueue(session.id)
        const pending = orchestrator.respondToRequest(session.id, requestId, skipAnswer)
        await assert.rejects(orchestrator.respondToRequest(session.id, requestId, skipAnswer) as Promise<unknown>, /正在提交/)
        assert.equal((await pending)?.handled, true)
        const afterSkip = await orchestrator.getEvents(session.id)
        assert.deepEqual(afterSkip.findLast(event => event.payload.id === question.payload.id)?.payload.submittedAnswer, skipAnswer)
        assert.equal(afterSkip.findLast(event => event.payload.id === other.payload.id)?.payload.submittedAnswer, undefined, '跳过只关闭当前提问')
        assert.deepEqual(afterSkip.filter(event => event.type === 'user_message' || event.type === 'turn_started'), beforeSkip, '跳过不新增聊天消息或回合')
        assert.deepEqual(orchestrator.getQueue(session.id), queue, '跳过不新增排队消息')
        assert.equal(session.status, status, '跳过不改变会话运行状态')
        assert.equal(skipDispatches, 0, '跳过不依赖 Agent 发送链路')
        await assert.rejects(orchestrator.respondToRequest(session.id, requestId, skipAnswer) as Promise<unknown>, /已处理/)
        liveStreamer.emit('event', question)
        assert.deepEqual((await orchestrator.getEvents(session.id)).findLast(event => event.payload.id === question.payload.id)?.payload.submittedAnswer, skipAnswer)
      }
    } finally { orchestrator.forceSend = forceSend }

    session.status = 'cancelling'
    await assert.rejects(
      orchestrator.forceSend(session.id, followUp, undefined, undefined, { source: 'feishu' }, false),
      /session_not_idle/
    )
    session.status = 'running'
    ;(orchestrator as any).streamers.delete(session.id)
    try {
      await assert.rejects(
        orchestrator.forceSend(session.id, followUp, undefined, undefined, { source: 'feishu' }, false),
        /session_not_idle/
      )
      assert.equal(orchestrator.getQueue(session.id).length, 0, 'a runner without steering support must not queue')
    } finally {
      ;(orchestrator as any).streamers.set(session.id, liveStreamer)
    }
    session.status = 'completed'
    await orchestrator.forceSend(session.id, appendFeishuContext('飞书新一轮'), undefined, undefined, { source: 'feishu' }, false)
    assert.equal(orchestrator.getQueue(session.id).length, 0, 'idle follow-ups start normally')
    assert.ok(orchestrator.getFeishuSendTurn(session.id))

    await orchestrator.sendMessage(session.id, appendFeishuContext('待编辑'), undefined, undefined, false, { source: 'feishu' })
    const editing = orchestrator.getQueue(session.id)[0]
    orchestrator.editQueueItem(session.id, editing.id, editing.prompt)
    assert.equal(orchestrator.getQueue(session.id)[0].source, 'app')
    assert.equal(orchestrator.getQueue(session.id)[0].prompt, '待编辑')

    await orchestrator.sendMessage(session.id, appendFeishuContext('结束前'), undefined, undefined, false, { source: 'feishu' })
    orchestrator.promoteQueueItem(session.id, orchestrator.getQueue(session.id)[1].id)
    await new Promise(setImmediate)
    assert.ok(orchestrator.getFeishuSendTurn(session.id))
    const streamer = (orchestrator as any).streamers.get(session.id) as AppServerRunner
    streamer.emit('event', { sessionId: session.id, seq: 99, ts: Date.now(), type: 'turn_completed', state: 'success', payload: {} })
    assert.equal(orchestrator.getFeishuSendTurn(session.id), undefined, 'terminal events revoke permission before async cleanup')
    restarted.loadPersisted()
    assert.equal(restarted.getFeishuSendTurn(session.id), undefined, 'restored source metadata grants no live permission')

    const sideArgs = handoffMcpArgs('codex', session.id, false)
    assert.ok(sideArgs.includes('mcp_servers.uniagent.env.UNIAGENT_FEISHU_OUTBOX=""'))
    assert.ok(sideArgs.includes(`mcp_servers.uniagent.env.UNIAGENT_CALLER_SESSION="${session.id}"`), 'other handoff tools retain caller attribution')
  } finally {
    for (const owner of [orchestrator, restarted]) for (const session of owner.listSessions()) owner.disposeSession(session.id)
    AppServerRunner.prototype.startTurn = startTurn
    AppServerRunner.prototype.steer = steer
    AppServerRunner.prototype.steerStrict = steerStrict
    await rm(storePath, { force: true })
  }
}

await sessionStoreRoundTrip()
await appServerWireContract()
await orchestratorDataPlane()
await feishuTurnSources()
console.log('native-turn-input: ok')
