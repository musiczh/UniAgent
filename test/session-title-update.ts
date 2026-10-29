import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Session, SessionConfig } from '../src/shared/types.ts'
import { AppServerRunner, configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter.ts'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'

function agent(adapter: 'codex' | 'traex'): AgentDef {
  return {
    id: adapter,
    name: adapter,
    bin: '/usr/bin/true',
    adapter,
    icon: '',
    builtin: true,
    capabilities: {
      modelSelect: false,
      reasoningEffort: false,
      streaming: true,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models: [],
    installed: true
  }
}

class TitleTransport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []

  constructor(
    private readonly resumedName?: string,
    private readonly configReadError?: Error,
    private readonly mcpServers: Record<string, unknown> = {},
    public titleRequestError?: Error
  ) {
    super()
  }

  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}

  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'initialize') return {} as T
    if (method === 'config/read') {
      if (this.configReadError && this.requests.filter(({ method }) => method === 'config/read').length > 1) throw this.configReadError
      return { config: { mcp_servers: this.mcpServers } } as T
    }
    if (method === 'thread/resume') {
      return { thread: { id: params.threadId, name: this.resumedName ?? null } } as T
    }
    if (method === 'thread/start') {
      const id = params?.ephemeral ? 'title-thread' : 'thread-1'
      return { thread: { id } } as T
    }
    if (method === 'thread/goal/get') return { goal: null } as T
    if (method === 'turn/start') {
      return { turn: { id: params.threadId === 'thread-1' ? 'turn-1' : 'title-turn' } } as T
    }
    if (method === 'thread/name/generate' && this.titleRequestError) throw this.titleRequestError
    if (method === 'thread/name/generate' || method === 'thread/name/set' || method === 'thread/unsubscribe') {
      return {} as T
    }
    throw new Error(`unexpected method: ${method}`)
  }
}

async function nativeResumeNameUpdatesSessionTitle(): Promise<void> {
  const transport = new TitleTransport('  原生线程名称  ')
  const runner = new AppServerRunner(
    'resume-title-codex',
    { n: 0 },
    agent('codex'),
    { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' },
    'thread-1',
    undefined,
    () => transport
  )
  const info: any[] = []
  runner.on('sessionInfo', (value) => info.push(value))
  runner.setInitialTitleSeed('原始请求')

  try {
    await runner.startTurn('继续排查')
    assert.deepEqual(info, [{ title: '原生线程名称' }])
    runner.setInitialTitleSeed('原始请求')
    emitFirstUserMessage(transport)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.equal(transport.requests.filter(({ method }) => method === 'config/read').length, 1, 'only startup provider discovery runs for a named thread')
    assert.equal(transport.requests.some(({ method, params }) => method === 'thread/start' && params.ephemeral), false)
  } finally {
    runner.dispose()
  }
}

async function codexTitleFailureIsDiagnostic(): Promise<void> {
  const transport = new TitleTransport(undefined, new Error('config unavailable'))
  const runner = new AppServerRunner(
    'failed-title-codex',
    { n: 0 },
    agent('codex'),
    { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' },
    undefined,
    undefined,
    () => transport
  )
  const diagnostics: Array<{ kind: string; data: any }> = []
  runner.on('diagnostic', (value) => diagnostics.push(value))

  try {
    await runner.startTurn('排查标题失败原因')
    emitFirstUserMessage(transport)
    await waitFor(() => diagnostics.some(({ kind }) => kind === 'title_generation_failed'))
    assert.deepEqual(
      diagnostics.find(({ kind }) => kind === 'title_generation_failed')?.data,
      { stage: 'config/read', message: 'config unavailable' }
    )
  } finally {
    runner.dispose()
  }
}

async function codexTitlePreservesProviderFailure(): Promise<void> {
  for (const viaNotification of [false, true]) {
    const transport = new TitleTransport()
    const runner = new AppServerRunner('provider-title-failure', { n: 0 }, agent('codex'),
      { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' }, undefined, undefined, () => transport)
    const failures: any[] = []
    runner.on('diagnostic', value => { if (value.kind === 'title_generation_failed') failures.push(value.data) })
    try {
      await runner.startTurn('排查标题原因')
      emitFirstUserMessage(transport)
      await waitFor(() => transport.requests.some(({ method, params }) => method === 'turn/start' && params.threadId === 'title-thread'))
      const error = { message: "You've reached your 5-hour usage limit.", codexErrorInfo: 'usageLimitExceeded' }
      if (viaNotification) transport.emit('notification', 'error', { threadId: 'title-thread', turnId: 'title-turn', error, willRetry: false })
      transport.emit('notification', 'turn/completed', {
        threadId: 'title-thread', turn: { id: 'title-turn', status: 'failed', ...(!viaNotification ? { error } : {}) }
      })
      assert.deepEqual(failures, [{ stage: 'response', message: error.message }], 'retain the cause so quota failures can be filtered without hiding other title errors')
    } finally { runner.dispose() }
  }
}

async function unnamedResumedThreadGeneratesTitleFromOriginalPrompt(): Promise<void> {
  const transport = new TitleTransport()
  const def = agent('codex')
  def.models = [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low'] }]
  def.defaultModel = 'gpt-5.6-luna'
  const runner = new AppServerRunner(
    'resume-unnamed-codex',
    { n: 0 },
    def,
    { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' },
    'thread-1',
    undefined,
    () => transport
  )
  const setInitialTitleSeed = (runner as any).setInitialTitleSeed
  assert.equal(typeof setInitialTitleSeed, 'function')
  setInitialTitleSeed.call(runner, '修复原始会话的图片与标题')

  try {
    await runner.startTurn('继续处理')
    await waitFor(() => transport.requests.some(({ method, params }) =>
      method === 'turn/start' && params.threadId === 'title-thread'
    ))
    const titleTurn = transport.requests.find(({ method, params }) =>
      method === 'turn/start' && params.threadId === 'title-thread')!
    assert.match(titleTurn.params.input[0].text, /修复原始会话的图片与标题/)
    assert.doesNotMatch(titleTurn.params.input[0].text, /继续处理/)
  } finally {
    runner.dispose()
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for title generation')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function emitFirstUserMessage(transport: TitleTransport): void {
  transport.emit('notification', 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      id: 'user-1',
      type: 'userMessage',
      content: [{ type: 'text', text: '排查会话标题为什么没有自动更新' }]
    }
  })
}

async function providerGeneratesTitleDuringFirstTurn(adapter: 'codex' | 'traex'): Promise<void> {
  const transport = new TitleTransport(
    undefined,
    undefined,
    adapter === 'codex'
      ? {
          uniagent: { command: '/usr/bin/true', args: ['server.cjs'] },
          knowledge: { url: 'https://mcp.invalid.test' }
        }
      : {}
  )
  const def = agent(adapter)
  if (adapter === 'codex') {
    def.models = [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low'] }]
    def.defaultModel = 'gpt-5.6-luna'
  }
  const runner = new AppServerRunner(
    `generation-${adapter}`,
    { n: 0 },
    def,
    { agentId: adapter, workdir: '/repo', permissionMode: 'read-only' },
    undefined,
    undefined,
    () => transport
  )
  const info: any[] = []
  const events: any[] = []
  runner.on('sessionInfo', (value) => info.push(value))
  runner.on('event', (value) => events.push(value))

  try {
    await runner.startTurn('排查会话标题为什么没有自动更新')
    emitFirstUserMessage(transport)

    if (adapter === 'traex') {
      await waitFor(() => transport.requests.some(({ method }) => method === 'thread/name/generate'))
      const request = transport.requests.find(({ method }) => method === 'thread/name/generate')!
      transport.emit('notification', 'thread/name/generated', {
        threadId: 'thread-1',
        turnId: request.params.requestId,
        name: '修复会话标题更新'
      })
    } else {
      try {
        await waitFor(() => transport.requests.some(({ method, params }) =>
          method === 'turn/start' && params.threadId === 'title-thread'))
      } catch {
        throw new Error(`Codex title requests: ${JSON.stringify(transport.requests)}`)
      }
      const titleTurn = transport.requests.find(({ method, params }) =>
        method === 'turn/start' && params.threadId === 'title-thread')!
      const titleThread = transport.requests.find(({ method, params }) =>
        method === 'thread/start' && params.ephemeral)!
      assert.equal(titleTurn.params.effort, 'low')
      assert.equal(titleTurn.params.outputSchema.properties.title.maxLength, 36)
      assert.equal(titleThread.params.config.mcp_servers, undefined)
      assert.equal(titleThread.params.config['mcp_servers.uniagent.enabled'], false)
      assert.equal(titleThread.params.config['mcp_servers.knowledge.enabled'], false)
      assert.equal(titleThread.params.config['token_budget.use_history_notes_extension'], undefined)
      transport.emit('notification', 'item/completed', {
        threadId: 'title-thread',
        turnId: 'title-turn',
        item: { id: 'title-answer', type: 'agentMessage', text: '{\"title\":\"修复会话标题更新\"}' }
      })
      transport.emit('notification', 'turn/completed', {
        threadId: 'title-thread',
        turn: { id: 'title-turn', status: 'completed' }
      })
    }

    await waitFor(() => info.length > 0)
    assert.deepEqual(info.at(-1), { title: '修复会话标题更新', persistProvider: true })
    assert.equal(events.some((event) => event.payload?.id === 'title-answer'), false)
    assert.equal(transport.requests.some(({ method }) => method === 'thread/name/set'), false)
    if (adapter === 'codex') {
      await waitFor(() => transport.requests.some(({ method }) => method === 'thread/unsubscribe'))
    }
  } finally {
    runner.dispose()
  }
}

async function providerTitleOnlyUpdatesSessionOnce(adapter: 'codex' | 'traex'): Promise<void> {
  const root = join(tmpdir(), `uniagent-title-${adapter}-${process.pid}-${Date.now()}`)
  const store = new SessionStore(join(root, 'sessions.json'))
  const config: SessionConfig = {
    agentId: adapter,
    workdir: '/repo',
    permissionMode: 'read-only'
  }
  const stored: Session = {
    id: `session-${adapter}`,
    title: '第一句话',
    config,
    status: 'idle',
    createdAt: 1,
    nativeSessionId: 'thread-1',
    origin: 'created'
  }
  store.saveOrThrow([stored])
  const orchestrator = new Orchestrator((id) => id === adapter ? agent(adapter) : undefined, store)
  orchestrator.loadPersisted()
  const session = orchestrator.getSessionById(stored.id)!
  const updates: any[] = []
  const providerTitles: string[] = []
  orchestrator.on('sessionUpdated', (update) => updates.push(update))
  const runner = (orchestrator as any).ensureMainStreamer(session, agent(adapter))
  runner.setThreadTitle = async (title: string) => { providerTitles.push(title) }

  try {
    ;(runner as any).onNotification('thread/name/updated', {
      threadId: 'another-thread',
      threadName: '错误线程标题'
    })
    ;(runner as any).onNotification('thread/name/updated', {
      threadId: 'thread-1',
      threadName: '   '
    })
    assert.equal(session.title, '第一句话')

    ;(runner as any).onNotification('thread/name/updated', {
      threadId: 'thread-1',
      threadName: '  原生生成标题  '
    })
    assert.equal(session.title, '原生生成标题')
    assert.equal(session.titleLocked, true)
    assert.equal(updates.at(-1)?.session, session)
    const persisted = new SessionStore(join(root, 'sessions.json')).load()[0]
    assert.equal(persisted?.title, '原生生成标题')
    assert.equal(persisted?.titleLocked, true)
    assert.deepEqual(providerTitles, [])

    runner.emit('sessionInfo', { title: '原生生成标题', persistProvider: true })
    assert.deepEqual(providerTitles, [])

    runner.emit('sessionInfo', { title: '主动生成标题', persistProvider: true })
    assert.equal(session.title, '原生生成标题')
    assert.deepEqual(providerTitles, [])

    const beforeRename = updates.length
    orchestrator.renameSession(session.id, '手动标题')
    assert.equal(updates.length, beforeRename + 1, 'manual renames notify session subscribers')
    assert.equal(updates.at(-1)?.session.title, '手动标题')
    runner.emit('sessionInfo', { title: '后续原生标题', persistProvider: true })
    assert.equal(session.title, '手动标题')
    assert.deepEqual(providerTitles, [])
  } finally {
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function matchingInitialTitleStillStopsLaterUpdates(): Promise<void> {
  const root = join(tmpdir(), `uniagent-title-match-${process.pid}-${Date.now()}`)
  const store = new SessionStore(join(root, 'sessions.json'))
  const config: SessionConfig = {
    agentId: 'codex',
    workdir: '/repo',
    permissionMode: 'read-only'
  }
  store.saveOrThrow([{
    id: 'session-title-match',
    title: '第一句话',
    config,
    status: 'idle',
    createdAt: 1,
    nativeSessionId: 'thread-1',
    origin: 'created'
  }])
  const orchestrator = new Orchestrator((id) => id === 'codex' ? agent('codex') : undefined, store)
  orchestrator.loadPersisted()
  const session = orchestrator.getSessionById('session-title-match')!
  const runner = (orchestrator as any).ensureMainStreamer(session, agent('codex'))
  const providerTitles: string[] = []
  runner.setThreadTitle = async (title: string) => { providerTitles.push(title) }

  try {
    runner.emit('sessionInfo', { title: '第一句话', persistProvider: true })
    assert.equal(session.titleLocked, true)
    assert.deepEqual(providerTitles, ['第一句话'])
    assert.equal(new SessionStore(join(root, 'sessions.json')).load()[0]?.titleLocked, true)

    runner.emit('sessionInfo', { title: '后续标题', persistProvider: true })
    assert.equal(session.title, '第一句话')
    assert.deepEqual(providerTitles, ['第一句话'])
  } finally {
    orchestrator.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

async function traexEmptyTitleCanRetryWithoutNoise(): Promise<void> {
  const transport = new TitleTransport()
  const runner = new AppServerRunner('empty-title-traex', { n: 0 }, agent('traex'),
    { agentId: 'traex', workdir: '/repo', permissionMode: 'read-only' }, undefined, undefined, () => transport)
  const info: any[] = []
  const failures: any[] = []
  runner.on('sessionInfo', value => info.push(value))
  runner.on('diagnostic', value => { if (['title_generation_failed', 'ignored_provider_event'].includes(value.kind)) failures.push(value) })
  const titleRequests = () => transport.requests.filter(({ method }) => method === 'thread/name/generate')
  try {
    await runner.startTurn('排查标题')
    emitFirstUserMessage(transport)
    await waitFor(() => titleRequests().length === 1)
    const first = titleRequests()[0].params.requestId
    transport.emit('notification', 'thread/name/generated', { threadId: 'thread-1', turnId: first, name: '' })
    assert.deepEqual(info, [])
    assert.deepEqual(failures, [])
    assert.equal(titleRequests().length, 1, 'empty output must not recursively spend quota')
    transport.emit('notification', 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await runner.startTurn('继续')
    emitFirstUserMessage(transport)
    await waitFor(() => titleRequests().length === 2)
    const second = titleRequests()[1].params.requestId
    transport.emit('notification', 'thread/name/generated', { threadId: 'thread-1', turnId: first, name: '过期名称' })
    transport.emit('notification', 'thread/name/generated', { threadId: 'other-thread', turnId: second, name: '别的会话' })
    assert.deepEqual(info, [])
    transport.emit('notification', 'thread/name/generated', { threadId: 'thread-1', turnId: second, name: '重试成功' })
    assert.deepEqual(info, [{ title: '重试成功', persistProvider: true }])
    transport.emit('notification', 'thread/name/generated', { threadId: 'thread-1', name: '未关联通知' })
    assert.equal(info.length, 1, 'missing correlation ids must never overwrite the current title')
  } finally { runner.dispose() }
}

async function traexTitleRequestFailureRemainsActionable(): Promise<void> {
  const transport = new TitleTransport(undefined, undefined, {}, new Error('title service unavailable'))
  const runner = new AppServerRunner('failed-title-traex', { n: 0 }, agent('traex'),
    { agentId: 'traex', workdir: '/repo', permissionMode: 'read-only' }, undefined, undefined, () => transport)
  const failures: any[] = []
  runner.on('diagnostic', value => { if (value.kind === 'title_generation_failed') failures.push(value) })
  try {
    await runner.startTurn('排查标题')
    emitFirstUserMessage(transport)
    await waitFor(() => failures.length === 1)
    assert.deepEqual(failures[0].data, { stage: 'thread/name/generate', message: 'title service unavailable' })
    transport.titleRequestError = undefined
    transport.emit('notification', 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await runner.startTurn('继续')
    emitFirstUserMessage(transport)
    await waitFor(() => transport.requests.filter(({ method }) => method === 'thread/name/generate').length === 2)
  } finally { runner.dispose() }
}

async function supplementalTitleStaysOnSelectedProvider(thirdParty = false): Promise<void> {
  const transport = new TitleTransport()
  const source = thirdParty ? { kind: 'third-party' as const, sourceId: 'kimi' } : { kind: 'local' as const, sourceId: 'bonsai' }
  const provider = thirdParty ? 'uniagent-kimi' : 'uniagent-local'
  const model = codexModelKey('local-only', source)
  const localAgent = agent('codex')
  localAgent.models = [{ id: 'gpt-5.6-luna', label: 'Cloud title model', efforts: [] }, { id: model, label: 'Local', efforts: [] }]
  configureCodexAppServerArgsProvider(() => [
    '-c', 'model="local-only"',
    '-c', `model_provider="${provider}"`,
    '-c', `model_providers.${provider}.base_url="http://127.0.0.1:9/v1"`,
    '-c', `model_providers.${provider}.wire_api="responses"`
  ])
  const runner = new AppServerRunner('local-title', { n: 0 }, localAgent,
    { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only', model, modelSource: source },
    undefined, undefined, () => transport)
  try {
    await runner.startTurn('只使用本地模型')
    emitFirstUserMessage(transport)
    await waitFor(() => transport.requests.filter(({ method }) => method === 'thread/start').length === 2)
    const starts = transport.requests.filter(({ method }) => method === 'thread/start')
    assert.ok(starts.every(({ params }) => params.model === 'local-only' && params.modelProvider === provider))
    assert.equal(transport.requests.find(({ method }) => method === 'turn/start')?.params.model, 'local-only')
    const titleThread = starts.find(({ params }) => params.ephemeral)!
    assert.equal(titleThread.params.config['model_provider'], provider, '标题线程必须携带补充模型 provider 定义')
    assert.equal(titleThread.params.config[`model_providers.${provider}.base_url`], 'http://127.0.0.1:9/v1')
    assert.equal(titleThread.params.config['mcp_servers.uniagent.enabled'], false, '标题线程不需要交接 MCP')
  } finally {
    runner.dispose()
    configureCodexAppServerArgsProvider()
  }
}

await traexTitleRequestFailureRemainsActionable()
await traexEmptyTitleCanRetryWithoutNoise()
await supplementalTitleStaysOnSelectedProvider(true)
await supplementalTitleStaysOnSelectedProvider()
await providerGeneratesTitleDuringFirstTurn('codex')
await providerGeneratesTitleDuringFirstTurn('traex')
await providerTitleOnlyUpdatesSessionOnce('codex')
await providerTitleOnlyUpdatesSessionOnce('traex')
await matchingInitialTitleStillStopsLaterUpdates()
await nativeResumeNameUpdatesSessionTitle()
await codexTitleFailureIsDiagnostic()
await codexTitlePreservesProviderFailure()
await unnamedResumedThreadGeneratesTitleFromOriginalPrompt()
console.log('session-title-update: ok')
