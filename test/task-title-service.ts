import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../src/main/sessionStore.ts'
import { TaskMetadataStore } from '../src/main/taskMetadataStore.ts'
import { TaskTitleService } from '../src/main/taskTitleService.ts'
import { buildTaskTitlePrompt, parseTaskTitleResult, resolveTaskTitleConfig, sanitizeTaskTitleSeed, taskTitleContextVersion, taskTitleUnsupported } from '../src/shared/taskTitle.ts'
import { codexModelKey } from '../src/shared/codexModelIdentity.ts'
import type { AgentDef, Session, TaskTitleGenerationConfig } from '../src/shared/types.ts'

class FakeClock {
  now = 0
  private nextId = 1
  private timers = new Map<number, { at: number; fn: () => void }>()

  setTimeout = (fn: () => void, ms = 0): number => {
    const id = this.nextId++
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimeout = (id: number): void => {
    this.timers.delete(id)
  }

  tick(ms: number): void {
    const target = this.now + ms
    while (true) {
      const next = [...this.timers.entries()]
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        .find(([, timer]) => timer.at <= target)
      if (!next) break
      const [id, timer] = next
      this.timers.delete(id)
      this.now = timer.at
      timer.fn()
    }
    this.now = target
  }

}

async function testWriteFile(file: string, data: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data, 'utf8')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function session(id: string, title = '临时标题', patch: Partial<Session> = {}): Session {
  return {
    id,
    title,
    status: 'idle',
    createdAt: 1,
    config: { agentId: 'codex', workdir: '/repo' },
    ...patch
  }
}

function agent(models: AgentDef['models']): AgentDef {
  return {
    id: 'codex',
    name: 'Codex',
    bin: '/usr/bin/true',
    adapter: 'codex',
    icon: '',
    builtin: true,
    installed: true,
    capabilities: {
      startupSystemPrompt: true,
      modelSelect: true,
      reasoningEffort: true,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models,
    defaultModel: models[0]?.id
  }
}

const root = await mkdtemp(join(tmpdir(), 'task-title-service-'))
async function cleanup(path: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

async function settle(store: TaskMetadataStore): Promise<void> {
  // Persisted generation history now precedes metadata; drain both asynchronous writers.
  for (let index = 0; index < 4; index++) {
    await new Promise(resolve => setImmediate(resolve))
    await store.flush()
  }
}

async function settleUntil(store: TaskMetadataStore, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return
    await settle(store)
  }
  assert.fail('condition did not settle in time')
}
try {
  const source = { kind: 'third-party' as const, sourceId: 'kimi-code' }
  const selectedModel = codexModelKey('title-small', source)
  const agents = [agent([
    { id: 'title-native', label: 'Native', efforts: ['off', 'high'], modelSource: { kind: 'native' } },
    { id: selectedModel, label: 'Supplemental', imageInput: true, efforts: ['low'], modelSource: source }
  ])]
  const selectedModelTwo = codexModelKey('title-small-2', source)
  agents[0].models.push({ id: selectedModelTwo, label: 'Supplemental 2', imageInput: true, efforts: ['low'], modelSource: source })

  const acceptedSession = session('accepted', '临时标题', { taskState: { phase: 'active', version: 11, updatedAt: 1, awaitingAcceptance: false } })
  const sessions = new Map([[acceptedSession.id, acceptedSession]])
  const settings: { value: TaskTitleGenerationConfig | undefined } = {
    value: { enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }
  }
  const store = new TaskMetadataStore(join(root, 'service'), testWriteFile)
  store.initialize(acceptedSession, false)
  const clock = new FakeClock()
  const inFlight = deferred<string>()
  const calls: Array<{ agentId: string; model: string | undefined; effort: string | undefined; prompt: string }> = []
  const generationBindings: Array<{ contextId?: string; taskId?: string }> = []
  const service = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async (resolvedAgent, config, prompt, _signal, _images, contextId, _options, taskId) => {
      generationBindings.push({ contextId, taskId })
      calls.push({ agentId: resolvedAgent.id, model: config.model, effort: config.effort, prompt })
      return inFlight.promise
    }
  }, { debounceMs: 800, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })

  service.responded(acceptedSession.id, '主 AI 回复', 'unaccepted')
  clock.tick(5_000)
  assert.equal(calls.length, 0, 'a connection-only start must not schedule generation')

  service.accepted(acceptedSession.id, '修复重启后历史消息里图片不显示的问题', { inputId: 'input-1' })
  service.responded(acceptedSession.id, '主 AI 确认：重启后历史消息中的图片预览缺失。', 'input-1')
  await store.flush()
  clock.tick(400)
  service.responded(acceptedSession.id, '首段持续输出：重启后历史消息中的图片预览缺失。', 'input-1')
  await store.flush()
  clock.tick(399)
  await Promise.resolve()
  assert.equal(calls.length, 0, 'debounce keeps the first accepted input lightweight')
  clock.tick(1)
  await Promise.resolve()
  await store.flush()
  assert.deepEqual(calls, [{
    agentId: 'codex',
    model: selectedModel,
    effort: 'low',
    prompt: calls[0]!.prompt
  }])
  assert.match(calls[0]!.prompt, /修复重启后历史消息里图片不显示的问题/)
  assert.equal(JSON.parse(calls[0]!.prompt.split('\n').at(-1)!).assistantResponse, '首段持续输出：重启后历史消息中的图片预览缺失。')
  service.responded(acceptedSession.id, '后续主 Agent 输出不能取消已经开始的标题调用。', 'input-1')
  await settle(store)
  assert.equal(calls.length, 1, 'streaming updates do not extend the first output window or restart an active title call')
  assert.equal(acceptedSession.taskState?.version, 11)
  inFlight.resolve('{"title":"修复任务历史图片漏显","description":"任务描述夹具","needsClarification":false}')
  await settle(store)
  assert.equal(store.current(acceptedSession).source, 'generated')
  assert.equal(store.current(acceptedSession).title, '修复任务历史图片漏显')
  assert.equal(acceptedSession.taskState?.version, 11, 'title metadata never mutates task lifecycle state')
  const readyVersion = store.current(acceptedSession).version
  service.accepted(acceptedSession.id, '继续执行时补充任务范围', { inputId: 'input-2' })
  service.responded(acceptedSession.id, '主 AI 回复', 'input-2')
  await store.flush()
  clock.tick(800)
  await settle(store)
  assert.equal(calls.length, 2, 'a new accepted turn updates the generated title and description once')
  assert.ok(generationBindings.every(binding => binding.taskId === acceptedSession.id && binding.contextId === acceptedSession.taskMetadata?.conversationId), 'every title call carries both the original task and its stable generation context')
  assert.ok(store.current(acceptedSession).version > readyVersion)
  assert.match(calls[1].prompt, /继续执行时补充任务范围/)
  assert.match(calls[1].prompt, /修复重启后历史消息里图片不显示的问题/)
  assert.equal(store.current(acceptedSession).source, 'generated')
  assert.equal(store.current(acceptedSession).generationState, 'ready')
  assert.equal(store.current(acceptedSession).title, '修复任务历史图片漏显')

  const compressedTask = session('compressed-task')
  sessions.set(compressedTask.id, compressedTask)
  store.initialize(compressedTask, false)
  await store.contexts.update(compressedTask.id, context => {
    context.turns = Array.from({ length: 4 }, (_, index) => ({ inputId: 'old-' + index, input: '历史任务内容'.repeat(1300) }))
  })
  const compressedBindings: Array<{ contextId?: string; taskId?: string; summary?: boolean }> = []
  const compressedService = new TaskTitleService(store, {
    validateDescription: async () => {}, session: id => sessions.get(id), agents: () => agents, config: () => settings.value,
    now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    generate: async (_agent, _config, _prompt, _signal, _images, contextId, options, taskId) => {
      compressedBindings.push({ contextId, taskId, summary: options?.summary })
      return options?.summary ? '{"summary":"历史摘要"}' : '{"title":"压缩后生成","description":"任务描述夹具","needsClarification":false}'
    }
  }, { debounceMs: 10 })
  compressedService.accepted(compressedTask.id, '新输入', { inputId: 'new-input' })
  compressedService.responded(compressedTask.id, '新回复', 'new-input')
  await store.flush(); clock.tick(10)
  await settleUntil(store, () => store.current(compressedTask).generationState === 'ready')
  assert.ok(compressedBindings.some(binding => binding.summary))
  assert.ok(compressedBindings.every(binding => binding.taskId === compressedTask.id), 'context compression also records against the original task')
  assert.equal(compressedBindings.at(-1)?.contextId, compressedTask.taskMetadata?.conversationId)
  await compressedService.close()

  const imageOnly = session('image-only', '临时图片任务')
  sessions.set(imageOnly.id, imageOnly)
  store.initialize(imageOnly, false)
  const imagePrompts: string[] = []
  const imageRequests: any[] = []
  const selected = agents[0].models.find(model => model.id === selectedModel)!
  selected.imageInput = true
  const imageTitles = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: id => sessions.get(id), agents: () => agents, config: () => settings.value,
    now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    generate: async (_agent, _config, prompt, _signal, images) => {
      imagePrompts.push(prompt)
      imageRequests.push(images)
      return '{"title":"排查任务页交付材料来源","description":"任务描述夹具","needsClarification":false}'
    }
  }, { debounceMs: 10 })
  const image = { kind: 'image' as const, path: '/fixture/screenshot.png', name: 'screenshot.png', mime: 'image/png' }
  imageTitles.accepted(imageOnly.id, '', { inputId: 'image-input', attachments: ['screenshot.png'], images: [image] })
  await settle(store); clock.tick(100); await settle(store)
  assert.equal(imagePrompts.length, 0, 'image input alone still waits for main AI response')
  imageTitles.responded(imageOnly.id, '其他输入的分析', 'wrong-input')
  await settle(store); clock.tick(100); await settle(store)
  assert.equal(imagePrompts.length, 0, 'a mismatched response cannot supply image context')
  imageTitles.responded(imageOnly.id, '截图中任务页的交付与验证材料由 task_delivery 写入。API_KEY=sk-abcdefghijklmnopqrstuvwxyz', 'image-input')
  await settle(store); clock.tick(10)
  await settleUntil(store, () => store.current(imageOnly).generationState === 'ready')
  const imagePayload = JSON.parse(imagePrompts[0].split('\n').at(-1)!)
  assert.equal(imagePayload.primaryIntent, '')
  assert.match(imagePayload.assistantResponse, /task_delivery/)
  assert.doesNotMatch(imagePrompts[0], /sk-abcdefghijklmnopqrstuvwxyz/)
  assert.deepEqual(imagePayload.attachmentHints, ['screenshot.png'])
  assert.deepEqual(imageRequests[0], [image], 'vision-capable selected title model receives user images')
  assert.doesNotMatch(imagePrompts[0], /\/fixture\/screenshot.png/, 'image paths never enter the text prompt')
  assert.equal(store.current(imageOnly).title, '排查任务页交付材料来源', 'pure image tasks can name from the main AI analysis')
  assert.equal(imageOnly.taskMetadata?.seed, undefined, 'AI output stays out of the renderer session projection')
  const longInput = session('long-input')
  selected.imageInput = false
  assert.equal(resolveTaskTitleConfig(settings.value, agents).enabled, false, 'text-only models cannot carry the auxiliary generator')
  selected.imageInput = true
  sessions.set(longInput.id, longInput)
  store.initialize(longInput, false)
  const longIntent = '截图背景 '.repeat(1800) + '真正目标：排查 task_delivery 交付材料的来源。'
  imageTitles.accepted(longInput.id, longIntent, { inputId: 'long-original', images: [image] })
  imageTitles.accepted(longInput.id, longIntent, { inputId: 'long-input', images: [image] })
  imageTitles.responded(longInput.id, '主 AI 已分析截图中的交付材料来源。', 'long-input')
  await settle(store); clock.tick(10)
  await settleUntil(store, () => store.current(longInput).generationState === 'ready')
  assert.equal(store.current(longInput).clarificationCount, 0, 'adding AI output to a long user input cannot consume a user clarification')
  assert.deepEqual(imageRequests[1], [image], 'long-input generation still forwards the selected vision model images')
  selected.imageInput = true
  await imageTitles.close()

  const clarifyingSession = session('clarify', '帮我处理一下')
  sessions.set(clarifyingSession.id, clarifyingSession)
  store.initialize(clarifyingSession, false)
  const clarificationResults = [
    deferred<string>(),
    deferred<string>()
  ]
  let clarificationCall = 0
  const clarificationService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => clarificationResults[clarificationCall++]!.promise
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  clarificationService.accepted(clarifyingSession.id, '帮我处理一下', { inputId: 'clarify-1' })
  clarificationService.responded(clarifyingSession.id, '请补充要处理的具体对象。', 'clarify-1')
  await store.flush()
  clock.tick(10)
  await Promise.resolve()
  await store.flush()
  clarificationResults[0]!.resolve('{"title":null,"description":null,"needsClarification":true}')
  await settle(store)
  assert.equal(store.current(clarifyingSession).generationState, 'needs-context')
  clarificationService.accepted(clarifyingSession.id, '修复工作流里评论未读没有清空。' + '用户补充背景。'.repeat(400) + '仅处理评论未读。', { inputId: 'clarify-2' })
  await settle(store)
  clock.tick(100)
  await settle(store)
  assert.equal(clarificationCall, 1, 'a new accepted input must wait for its own main AI response')
  clarificationService.responded(clarifyingSession.id, '主 AI 已理解补充的任务对象。', 'clarify-2')
  await store.flush()
  clock.tick(10)
  await Promise.resolve()
  await store.flush()
  clarificationResults[1]!.resolve('{"title":"修复评论未读未清空","description":"任务描述夹具","needsClarification":false}')
  await settle(store)
  assert.equal(store.current(clarifyingSession).title, '修复评论未读未清空')

  const manualSession = session('manual', '临时标题', { taskState: { phase: 'active', version: 23, updatedAt: 1, awaitingAcceptance: false } })
  sessions.set(manualSession.id, manualSession)
  store.initialize(manualSession, false)
  const late = deferred<string>()
  const manualService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => late.promise
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  manualService.accepted(manualSession.id, '修复任务标题竞争', { inputId: 'manual-1' })
  manualService.responded(manualSession.id, '主 AI 回复', 'manual-1')
  await store.flush()
  clock.tick(10)
  await Promise.resolve()
  await store.flush()
  await manualService.rename(manualSession.id, manualSession.title)
  late.resolve('{"title":"迟到结果","description":"任务描述夹具","needsClarification":false}')
  await settle(store)
  assert.equal(store.current(manualSession).source, 'manual')
  assert.equal(store.current(manualSession).title, '临时标题')
  assert.equal(manualSession.taskState?.version, 23)

  const renamePendingSession = session('rename-pending', '原始标题')
  sessions.set(renamePendingSession.id, renamePendingSession)
  const delayedRunningWrite = deferred<void>()
  let delayedWriteCount = 0
  const delayedStore = new TaskMetadataStore(join(root, 'rename-pending'), async (file, data) => {
    delayedWriteCount += 1
    if (delayedWriteCount === 1) await delayedRunningWrite.promise
    await atomicWriteFile(file, data)
  })
  delayedStore.initialize(renamePendingSession, false)
  const renamePendingCalls: string[] = []
  const renamePendingService = new TaskTitleService(delayedStore, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => {
      renamePendingCalls.push('late')
      return '{"title":"迟到标题","description":"任务描述夹具","needsClarification":false}'
    }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  renamePendingService.accepted(renamePendingSession.id, '运行态写盘还没完成时手动标题也必须胜出', { inputId: 'rename-pending-1' })
  renamePendingService.responded(renamePendingSession.id, '主 AI 回复', 'rename-pending-1')
  for (let attempt = 0; attempt < 200 && delayedWriteCount !== 1; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(delayedWriteCount, 1, 'seed persistence should be pending before manual rename')
  const renamePendingPromise = renamePendingService.rename(renamePendingSession.id, '人工锁定标题')
  delayedRunningWrite.resolve()
  await renamePendingPromise
  await settleUntil(delayedStore, () => delayedStore.current(renamePendingSession).source === 'manual')
  assert.equal(delayedStore.current(renamePendingSession).title, '人工锁定标题')
  assert.equal(renamePendingSession.taskMetadata?.title, '人工锁定标题')

  const retrySession = session('retry', '网络抖动')
  sessions.set(retrySession.id, retrySession)
  store.initialize(retrySession, false)
  const retryAttempts: string[] = []
  const retryService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => {
      retryAttempts.push('attempt')
      if (retryAttempts.length === 1) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
      return '{"title":"恢复网络后生成标题","description":"任务描述夹具","needsClarification":false}'
    }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  retryService.accepted(retrySession.id, '网络抖动时也要能补一次标题', { inputId: 'retry-1' })
  retryService.responded(retrySession.id, '主 AI 回复', 'retry-1')
  await settle(store)
  clock.tick(10)
  await settleUntil(store, () => retryAttempts.length === 1 && store.current(retrySession).generationState === 'deferred')
  retryService.responded(retrySession.id, '窗口结束后的流式输出不能重置退避重试。', 'retry-1')
  await settle(store)
  assert.equal(store.current(retrySession).seed?.assistantResponse, '主 AI 回复', 'first-output snapshot stays frozen while retrying')
  assert.equal(retryAttempts.length, 1)
  clock.tick(29_999)
  assert.equal(retryAttempts.length, 1)
  clock.tick(1)
  await settleUntil(store, () => retryAttempts.length === 2)
  assert.equal(retryAttempts.length, 2, 'transient failure retries exactly once after backoff')
  await settleUntil(store, () => store.current(retrySession).title === '恢复网络后生成标题')
  assert.equal(store.current(retrySession).title, '恢复网络后生成标题')

  const recoverReady = session('recover-ready', '已完成')
  const recoverRunning = session('recover-running', '运行中')
  const recoverExhausted = session('recover-exhausted', '已耗尽')
  const recoverArchived = session('recover-archived', '已归档', { archived: true })
  const recoverPending = session('recover-pending', '仅等待')
  const recoverDeferred = session('recover-deferred', '配置缺失')
  const recoverWithoutResponse = session('recover-without-response', '旧版未完成标题')
  for (const candidate of [recoverReady, recoverRunning, recoverExhausted, recoverArchived, recoverPending, recoverDeferred, recoverWithoutResponse]) {
    sessions.set(candidate.id, candidate)
    store.initialize(candidate, false)
  }
  await store.update(recoverReady, metadata => {
    metadata.seed = { primaryIntent: '已经完成的标题不恢复' }
    metadata.title = '已经生成标题'
    metadata.source = 'generated'
    metadata.generationState = 'ready'
    metadata.attempts = 1
  })
  await store.update(recoverRunning, metadata => {
    metadata.seed = { primaryIntent: '重启后恢复运行中的标题请求', assistantResponse: '主 AI 回复已保存' }
    metadata.contextGeneration = 1
    metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
    metadata.source = 'fallback'
    metadata.generationState = 'running'
    metadata.generationId = 'interrupted'
    metadata.attempts = 0
  })
  await store.update(recoverExhausted, metadata => {
    metadata.seed = { primaryIntent: '已经耗尽的运行请求不能无限恢复', assistantResponse: '主 AI 回复已保存' }
    metadata.contextGeneration = 1
    metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
    metadata.source = 'fallback'
    metadata.generationState = 'running'
    metadata.generationId = 'interrupted-exhausted'
    metadata.attempts = 2
  })
  await store.update(recoverArchived, metadata => {
    metadata.seed = { primaryIntent: '归档任务不恢复' }
    metadata.contextGeneration = 1
    metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
    metadata.source = 'fallback'
    metadata.generationState = 'running'
    metadata.generationId = 'archived-running'
    metadata.attempts = 0
  })
  await store.update(recoverPending, metadata => {
    metadata.seed = { primaryIntent: 'pending 没有证明已经真实启动' }
    metadata.contextGeneration = 1
    metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
    metadata.source = 'fallback'
    metadata.generationState = 'pending'
    metadata.attempts = 0
  })
  await store.update(recoverDeferred, metadata => {
    metadata.seed = { primaryIntent: '配置缺失的 deferred 等待配置恢复', assistantResponse: '主 AI 回复已保存' }
    metadata.contextGeneration = 1
    metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
    metadata.source = 'fallback'
    metadata.generationState = 'deferred'
    metadata.attempts = 0
    metadata.nextEligibleAt = clock.now - 1
  })
  await store.update(recoverWithoutResponse, metadata => {
    metadata.seed = { primaryIntent: '这个是怎么来的？' }
    metadata.generationState = 'deferred'
  })
  await store.flush()
  let recoverCalls = 0
  settings.value = { enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }
  const recoverService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async (_agent, _config, prompt) => {
      recoverCalls += 1
      return '{"title":"恢复后的标题","description":"任务描述夹具","needsClarification":false}'
    }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  settings.value = { enabled: true }
  await recoverService.recover([recoverReady, recoverRunning, recoverExhausted, recoverArchived, recoverPending, recoverDeferred, recoverWithoutResponse])
  assert.equal(recoverCalls, 0, 'missing title config must not generate during recovery')
  assert.equal(store.current(recoverReady).title, '已经生成标题')
  assert.equal(store.current(recoverReady).generationState, 'ready')
  assert.equal(store.current(recoverPending).generationState, 'pending')
  assert.equal(store.current(recoverArchived).generationState, 'running')
  assert.equal(store.current(recoverRunning).generationState, 'deferred')
  assert.equal(store.current(recoverRunning).attempts, 1, 'interrupted running recovery counts the uncertain prior call')
  assert.ok((store.current(recoverRunning).nextEligibleAt || 0) >= clock.now + 30_000)
  assert.equal(store.current(recoverExhausted).generationState, 'failed')
  assert.equal(store.current(recoverExhausted).lastErrorCode, 'attempts-exhausted')
  settings.value = { enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }
  recoverService.configurationChanged()
  await settleUntil(store, () => store.current(recoverDeferred).title === '恢复后的标题')
  assert.equal(recoverCalls, 1, 'missing-config deferred recovery waits for config, then resumes')
  clock.tick(29_999)
  await settle(store)
  assert.equal(recoverCalls, 1, 'interrupted running recovery waits the persisted retry backoff')
  assert.equal(store.current(recoverRunning).title, undefined)
  clock.tick(1)
  await settleUntil(store, () => store.current(recoverRunning).title === '恢复后的标题')
  assert.equal(recoverCalls, 2)
  assert.equal(store.current(recoverRunning).title, '恢复后的标题')
  assert.equal(store.current(recoverWithoutResponse).title, undefined, 'legacy records without AI response cannot generate text-only titles on recovery')
  const restartedAgain = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => { recoverCalls += 1; return '{"title":"不应重复恢复","description":"任务描述夹具","needsClarification":false}' }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  await restartedAgain.recover([recoverReady, recoverRunning, recoverExhausted, recoverArchived, recoverPending, recoverDeferred])
  clock.tick(60_000)
  await settle(store)
  assert.equal(recoverCalls, 2, 'repeated restart does not revive ready/failed/pending/archived tasks')
  await restartedAgain.close()
  await recoverService.close()

  const unconfigured = session('unconfigured', '未配置标题')
  sessions.set(unconfigured.id, unconfigured)
  store.initialize(unconfigured, false)
  const unconfiguredCalls: string[] = []
  settings.value = { enabled: true }
  const unconfiguredService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => { unconfiguredCalls.push('unexpected'); return '{"title":"bad","description":"任务描述夹具","needsClarification":false}' }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  unconfiguredService.accepted(unconfigured.id, '先在未配置状态运行', { inputId: 'u1' })
  unconfiguredService.responded(unconfigured.id, '主 AI 回复', 'u1')
  await settleUntil(store, () => store.current(unconfigured).generationState === 'deferred')
  assert.equal(unconfiguredCalls.length, 0)
  settings.value = { enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }
  unconfiguredService.configurationChanged()
  clock.tick(10)
  await settleUntil(store, () => unconfiguredCalls.length === 1)
  assert.equal(unconfiguredCalls.length, 1, 'configurationChanged recovers an earlier unconfigured task')

  const seedFailureSession = session('seed-failure', '写盘失败')
  const brokenStore = new TaskMetadataStore(join(root, 'seed-failure'), async () => { throw new Error('disk full') })
  brokenStore.initialize(seedFailureSession, false)
  const brokenSessions = new Map([[seedFailureSession.id, seedFailureSession]])
  let brokenCalls = 0
  const brokenService = new TaskTitleService(brokenStore, {
    validateDescription: async () => {},
    session: (id) => brokenSessions.get(id),
    agents: () => agents,
    config: () => ({ enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => { brokenCalls += 1; return '{"title":"bad","description":"任务描述夹具","needsClarification":false}' }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  brokenService.accepted(seedFailureSession.id, '这次不能因为 seed 写盘失败继续生成', { inputId: 'broken-1' })
  brokenService.responded(seedFailureSession.id, '主 AI 回复', 'broken-1')
  clock.tick(10)
  await settleUntil(brokenStore, () => brokenCalls === 0)
  assert.equal(brokenCalls, 0, 'seed write failure blocks generation entirely')

  const ignoredAbortSession = session('ignored-abort', '旧配置')
  sessions.set(ignoredAbortSession.id, ignoredAbortSession)
  store.initialize(ignoredAbortSession, false)
  const ignoredAbortResults = [deferred<string>(), deferred<string>()]
  const ignoredAbortCalls: Array<string | undefined> = []
  let ignoredAbortIndex = 0
  settings.value = { enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }
  const ignoredAbortService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async (_agent, config) => {
      ignoredAbortCalls.push(config.model)
      return ignoredAbortResults[ignoredAbortIndex++]!.promise
    }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  ignoredAbortService.accepted(ignoredAbortSession.id, '切换标题模型后旧结果不能落盘', { inputId: 'ignored-1' })
  ignoredAbortService.responded(ignoredAbortSession.id, '主 AI 回复', 'ignored-1')
  clock.tick(10)
  await settleUntil(store, () => ignoredAbortCalls.length === 1)
  settings.value = { enabled: true, agentId: 'codex', model: selectedModelTwo, modelSource: source }
  ignoredAbortService.configurationChanged()
  clock.tick(10)
  await settleUntil(store, () => ignoredAbortCalls.length === 2)
  ignoredAbortResults[0]!.resolve('{"title":"旧配置结果","description":"任务描述夹具","needsClarification":false}')
  await settle(store)
  assert.equal(store.current(ignoredAbortSession).title, undefined, 'ignored abort result must not commit after configuration change')
  ignoredAbortResults[1]!.resolve('{"title":"新配置结果","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => store.current(ignoredAbortSession).title === '新配置结果')
  assert.equal(store.current(ignoredAbortSession).title, '新配置结果')

  const limitedFirst = session('limited-first', '一')
  const limitedSecond = session('limited-second', '二')
  const limitedThird = session('limited-third', '三')
  sessions.set(limitedFirst.id, limitedFirst)
  sessions.set(limitedSecond.id, limitedSecond)
  sessions.set(limitedThird.id, limitedThird)
  store.initialize(limitedFirst, false)
  store.initialize(limitedSecond, false)
  store.initialize(limitedThird, false)
  const overflow = [deferred<string>(), deferred<string>(), deferred<string>()]
  let overflowIndex = 0
  const overflowCalls: string[] = []
  const overflowService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => ({ enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async (_agent, _config, prompt) => {
      overflowCalls.push(prompt)
      return overflow[overflowIndex++]!.promise
    }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 1 })
  for (const [id, text] of [[limitedFirst.id, '第一个'], [limitedSecond.id, '第二个'], [limitedThird.id, '第三个']] as const) {
    overflowService.accepted(id, text, { inputId: id })
    overflowService.responded(id, '主 AI 回复', id)
    await store.flush()
  }
  clock.tick(10)
  await settle(store)
  assert.equal(store.current(limitedThird).generationState, 'deferred', 'queue overflow preserves a deferred task instead of dropping it')
  overflow[0]!.resolve('{"title":"第一","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => overflowCalls.length === 2)
  overflow[1]!.resolve('{"title":"第二","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => overflowCalls.length === 3)
  overflow[2]!.resolve('{"title":"第三","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => store.current(limitedThird).title === '第三')
  assert.equal(store.current(limitedThird).title, '第三')

  for (const lateCompletion of ['invalid', 'rejected'] as const) {
    const candidate = session(`superseded-timeout-${lateCompletion}`)
    sessions.set(candidate.id, candidate)
    store.initialize(candidate, false)
    const pending = [deferred<string>(), deferred<string>()]
    const signals: AbortSignal[] = []
    let count = 0
    const titleService = new TaskTitleService(store, {
      validateDescription: async () => {},
      session: id => sessions.get(id), agents: () => agents,
      config: () => ({ enabled: true, agentId: 'codex', model: selectedModel, modelSource: source }),
      now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      generate: async (_agent, _config, _prompt, signal) => { signals.push(signal); return pending[count++]!.promise }
    }, { debounceMs: 10, timeoutMs: 100, retryBackoffMs: 30_000 })
    try {
      titleService.accepted(candidate.id, '修复图片漏显', { inputId: 'first' }); titleService.responded(candidate.id, '主 AI 回复', 'first')
      clock.tick(10)
      await settleUntil(store, () => count === 1)
      titleService.accepted(candidate.id, '只处理历史页', { inputId: 'latest' }); titleService.responded(candidate.id, '主 AI 最新回复', 'latest')
      await settle(store)
      assert.equal(signals[0].aborted, true)
      clock.tick(100)
      if (lateCompletion === 'invalid') pending[0].resolve('invalid old output after cancelled timeout')
      else pending[0].reject(Object.assign(new Error('late rejection'), { code: 'ECONNRESET' }))
      await settleUntil(store, () => count === 2)
      assert.equal(store.current(candidate).attempts, 1, 'cancelled old timeout cannot consume the latest context retry budget')
      assert.equal(store.current(candidate).nextEligibleAt, undefined)
      pending[1].resolve('{"title":"修复历史图片漏显","description":"任务描述夹具","needsClarification":false}')
      await settleUntil(store, () => store.current(candidate).title === '修复历史图片漏显')
      clock.tick(30_000)
      await settle(store)
      assert.equal(count, 2, 'superseded error must not leave a stale retry request')
    } finally {
      const close = titleService.close()
      for (const result of pending) result.resolve('{"title":"清理夹具","description":"任务描述夹具","needsClarification":false}')
      await close
    }
  }

  const blocked = session('blocked', '保持原标题', { readOnly: true })
  sessions.set(blocked.id, blocked)
  store.initialize(blocked, false)
  const team = session('team', '团队任务', { teamBinding: { teamProjectId: 'p', memberId: 'm' } })
  sessions.set(team.id, team)
  store.initialize(team, false)
  const assistant = session('assistant', '个人助手任务', { config: { agentId: 'codex', workdir: '/repo', assistantSnapshot: {} as any } })
  sessions.set(assistant.id, assistant)
  store.initialize(assistant, false)
  const init = session('init', '初始化任务', { config: { agentId: 'codex', workdir: '/repo', initializationTargetAgentId: 'claude' } })
  sessions.set(init.id, init)
  store.initialize(init, false)
  const blockedCalls: string[] = []
  const blockedService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => { blockedCalls.push('x'); return '{"title":"unexpected","description":"任务描述夹具","needsClarification":false}' }
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  for (const candidate of [blocked, team, assistant, init]) {
    blockedService.accepted(candidate.id, '不该进入自动命名', { inputId: candidate.id })
    blockedService.responded(candidate.id, '主 AI 回复', candidate.id)
  }
  await store.flush()
  clock.tick(100)
  await Promise.resolve()
  assert.equal(blockedCalls.length, 0)

  const first = session('q1', '标题一')
  const second = session('q2', '标题二')
  sessions.set(first.id, first)
  sessions.set(second.id, second)
  store.initialize(first, false)
  store.initialize(second, false)
  const q1 = deferred<string>()
  const q2 = deferred<string>()
  let queueIndex = 0
  const queuedService = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: (id) => sessions.get(id),
    agents: () => agents,
    config: () => settings.value,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: () => {},
    generate: async () => (queueIndex++ === 0 ? q1.promise : q2.promise)
  }, { debounceMs: 10, timeoutMs: 20_000, retryBackoffMs: 30_000, maxAttempts: 2, concurrency: 1, maxQueue: 128 })
  queuedService.accepted(first.id, '先生成第一个', { inputId: 'q1' })
  queuedService.responded(first.id, '主 AI 回复', 'q1')
  await store.flush()
  queuedService.accepted(second.id, '再生成第二个', { inputId: 'q2' })
  queuedService.responded(second.id, '主 AI 回复', 'q2')
  await store.flush()
  clock.tick(10)
  await Promise.resolve()
  await store.flush()
  assert.equal(queueIndex, 1, 'global concurrency keeps the second task queued')
  q1.resolve('{"title":"第一个标题","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => queueIndex === 2)
  assert.equal(queueIndex, 2, 'queued second task starts after the first generation settles')
  q2.resolve('{"title":"第二个标题","description":"任务描述夹具","needsClarification":false}')
  await settleUntil(store, () => store.current(second).title === '第二个标题')
  assert.equal(store.current(second).title, '第二个标题')

  assert.throws(() => parseTaskTitleResult('{"title":"bad","description":"任务描述夹具","needsClarification":false,"extra":1}'), /未知字段/)
  assert.throws(() => parseTaskTitleResult('{"title":"","description":"任务描述夹具","needsClarification":false}'), /标题/)
  assert.throws(() => parseTaskTitleResult('{"title":"bad","description":null,"needsClarification":true}'), /补充上下文/)
  assert.throws(() => parseTaskTitleResult('{"title":"line1\\nline2","description":"任务描述夹具","needsClarification":false}'), /换行/)
  assert.throws(() => parseTaskTitleResult('{"title":"Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz","description":"任务描述夹具","needsClarification":false}'), /凭据/)
  assert.throws(() => parseTaskTitleResult('{"title":"password=super-secret-value","description":"任务描述夹具","needsClarification":false}'), /凭据/)
  assert.equal(parseTaskTitleResult('{"title":null,"description":null,"needsClarification":true}').title, null)
  const tailIntent = `开头背景 `.repeat(700) + '真正需求在最后：修复评论未读没有清空'
  const bounded = sanitizeTaskTitleSeed({
    primaryIntent: tailIntent,
    assistantResponse: '主 AI 开头：已识别图片中的任务对象。' + '分析背景'.repeat(1800) + '最终结论：交付材料由 task_delivery 工具写入。',
    clarifications: ['补充范围'.repeat(200), '第二条补充'.repeat(200)],
    attachmentHints: Array.from({ length: 20 }, (_, index) => `attachment-${index}-` + 'x'.repeat(500))
  })
  assert.match(bounded.primaryIntent, /真正需求在最后：修复评论未读没有清空/)
  assert.match(bounded.assistantResponse!, /^主 AI 开头/)
  assert.match(bounded.assistantResponse!, /最终结论：交付材料由 task_delivery 工具写入。$/)
  const boundedBytes = new TextEncoder().encode(JSON.stringify(bounded)).length
  assert.ok(boundedBytes <= 8 * 1024, 'all seed material stays within 8KiB together')
  const escapedResponse = sanitizeTaskTitleSeed({ primaryIntent: '任务', assistantResponse: '\u0000'.repeat(10_000) })
  assert.ok(Buffer.byteLength(JSON.stringify(escapedResponse)) <= 8 * 1024, 'JSON-escaped AI output also stays within the shared byte budget')
  const redacted = sanitizeTaskTitleSeed({
    primaryIntent: '排查 API_KEY=sk-abcdefghijklmnopqrstuvwxyz 和 Authorization: Bearer sk-zyxwvutsrqponmlkjihgfedcba 泄漏',
    assistantResponse: '主 AI 分析 password="private-output" 和 API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
    clarifications: ['password="hunter2"', '保留 API Key 登录文案和工单 TICKET-sk-123'],
    attachmentHints: ['header Authorization: Bearer abcdefghijklmnop']
  })
  const redactedJson = JSON.stringify(redacted)
  assert.match(redacted.primaryIntent, /\[REDACTED\]/)
  assert.match(redactedJson, /\[REDACTED\]/)
  assert.doesNotMatch(redactedJson, /sk-[A-Za-z0-9_-]{10,}/)
  assert.doesNotMatch(redactedJson, /Authorization:\s*Bearer\s+[^\s",]+/)
  assert.doesNotMatch(redactedJson, /password="?hunter2"?/)
  assert.doesNotMatch(redactedJson, /private-output/)
  assert.match(redactedJson, /API Key 登录/)
  assert.match(redactedJson, /TICKET-sk-123/)
  const longPrompt = buildTaskTitlePrompt({
    primaryIntent: 'Investigate missing image previews after restart',
    clarifications: ['Use the current workspace browser implementation'],
    attachmentHints: ['screenshot.png', 'design.fig']
  })
  assert.match(longPrompt, /title and concise description of the ENTIRE task/)
  assert.doesNotMatch(longPrompt, /你负责为 UniAgent 任务生成一个中文短标题/)
  JSON.parse(longPrompt.split('\n').at(-1)!)
  const redactedPrompt = buildTaskTitlePrompt({
    primaryIntent: 'Reset password=secret123 and API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
    attachmentHints: ['Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz']
  })
  assert.match(redactedPrompt, /\[REDACTED\]/)
  assert.doesNotMatch(redactedPrompt, /secret123/)
  assert.doesNotMatch(redactedPrompt, /Authorization:\s*Bearer\s+[^\s",]+/)

  settings.value = { enabled: true, agentId: 'codex', model: 'missing-model' }
  const resolved = resolveTaskTitleConfig(settings.value, agents)
  assert.equal(resolved.enabled, false)
  assert.match(resolved.reason, /模型/)
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'codex', model: 'title-native' }, agents).config?.effort, 'off')
  assert.equal(taskTitleUnsupported({ ...agent([{ id: 'x', label: 'x', efforts: [] }]), adapter: 'traex' }), undefined)
  assert.match(taskTitleUnsupported({ ...agent([{ id: 'x', label: 'x', efforts: [] }]), adapter: 'generic', capabilities: { ...agents[0].capabilities, startupSystemPrompt: false } }), /不支持系统提示词/)
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'codex', model: 'title-native', effort: 'high' }, agents).config?.effort, 'high')
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'codex', model: 'title-native', effort: 'low' }, agents).enabled, false, 'a removed explicit effort must not become the default')
  const kimi = { ...agent([{ id: 'native', label: 'Native', imageInput: true, efforts: [], thinkingOptions: ['balanced', 'fast'], defaultThinking: 'balanced' }]), id: 'kimi', name: 'Kimi Code', adapter: 'kimi' }
  assert.equal(taskTitleUnsupported(kimi), undefined, 'installed and authenticated Kimi remains selectable despite subscription rejection')
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'kimi', model: 'native', kimiThinking: 'fast' }, [kimi]).config?.kimiThinking, 'fast')
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'kimi', model: 'native' }, [kimi]).config?.kimiThinking, 'balanced')
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'kimi', model: 'native', effort: 'low' }, [kimi]).enabled, false)
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: 'kimi', model: 'native', kimiThinking: 'removed' }, [kimi]).enabled, false)
  assert.match(taskTitleUnsupported({ ...agents[0], lifecycle: { availability: 'needs-auth', auth: 'required', health: 'unknown', updateStatus: 'idle', checkedAt: 1 } as any }), /登录/)
  assert.match(taskTitleUnsupported({ ...agents[0], lifecycle: { availability: 'detecting', auth: 'unknown', health: 'unknown', updateStatus: 'idle', checkedAt: 1 } as any }), /不可用/)
  assert.match(taskTitleUnsupported({ ...agents[0], lifecycle: { availability: 'updating', auth: 'unknown', health: 'unknown', updateStatus: 'checking', checkedAt: 1 } as any }), /不可用/)
  assert.notEqual(taskTitleContextVersion({ primaryIntent: 'a' }, 1), taskTitleContextVersion({ primaryIntent: 'a' }, 2))

  settings.value = undefined
  await renamePendingService.close()
  manualService.configurationChanged()
  await manualService.close()
  await queuedService.close()
  await blockedService.close()
  await retryService.close()
  await clarificationService.close()
  await service.close()
} finally {
  await cleanup(root)
}

console.log('task-title-service: ok')
