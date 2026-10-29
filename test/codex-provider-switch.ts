import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner, configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import type { AppServerRpc } from '../src/main/appServerTransport'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { codexModelKey, codexProviderChanged, codexSessionProvider } from '../src/shared/codexModelIdentity'
import type { AgentDef, Session, SessionConfig, UAEvent } from '../src/shared/types'

const native: SessionConfig = { agentId: 'codex', model: 'gpt-6.1-sol', modelSource: { kind: 'native' }, permissionMode: 'read-only', workdir: tmpdir() }
const kimi: SessionConfig = { ...native, model: codexModelKey('k3-256k', { kind: 'third-party', sourceId: 'kimi' }), modelSource: { kind: 'third-party', sourceId: 'kimi' } }
const deepseek: SessionConfig = { ...native, model: codexModelKey('deepseek-flash', { kind: 'third-party', sourceId: 'deepseek' }), modelSource: { kind: 'third-party', sourceId: 'deepseek' } }
const agent: AgentDef = {
  id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, icon: '', models: [
    { id: kimi.model!, label: 'k3-256k', efforts: ['high'], contextWindow: 262144 },
    { id: deepseek.model!, label: 'DeepSeek Flash', efforts: ['high'], contextWindow: 1048576 },
    { id: 'gpt-small', label: 'GPT Small', efforts: ['high'], contextWindow: 200000 },
    { id: codexModelKey('k3', kimi.modelSource!), label: 'k3', efforts: ['high'], contextWindow: 1048576 }
  ],
  capabilities: { modelSelect: true, reasoningEffort: false, streaming: true, permissionModes: [{ id: 'read-only', label: '只读', hint: '' }] }
}

assert.equal(codexProviderChanged(native, { ...native, model: 'gpt-other', modelSource: undefined }), false)
assert.equal(codexProviderChanged(native, kimi), true)
assert.equal(codexProviderChanged(kimi, { ...kimi, model: 'k3', modelSource: kimi.modelSource }), false)
assert.equal(codexProviderChanged(kimi, { ...kimi, modelSource: { kind: 'third-party', sourceId: 'deepseek' } }), true)
assert.equal(codexProviderChanged(native, { ...kimi, modelSource: undefined }), true, 'encoded selector carries provider identity')

class Transport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []
  compactStarted!: () => void
  resumeUsage?: any
  historyPath?: string
  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'config/read') return { config: { model_provider: 'openai' } } as T
    if (method === 'thread/resume') {
      if (this.resumeUsage) this.emit('notification', 'thread/tokenUsage/updated', { threadId: params.threadId, tokenUsage: this.resumeUsage })
      return { thread: { id: params.threadId }, model: params.model, modelProvider: params.modelProvider } as T
    }
    if (method === 'thread/goal/get') return { goal: null } as T
    if (method === 'turn/start') return { turn: { id: 'native-next-turn' } } as T
    if (method === 'thread/read') return { thread: { id: params.threadId, path: this.historyPath } } as T
    if (method === 'thread/compact/start') {
      this.emit('notification', 'turn/started', { threadId: params.threadId, turn: { id: 'compact-turn' } })
      this.emit('notification', 'item/started', { threadId: params.threadId, turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } })
      this.compactStarted()
    }
    return {} as T
  }
}

configureCodexAppServerArgsProvider(config => config.modelSource?.kind === 'third-party'
  ? ['-c', `model_provider=${JSON.stringify(codexSessionProvider(config.modelSource))}`] : [])
async function adapterCase(mode: 'success' | 'failed' | 'disconnect' | 'missing' | 'too-large' | 'item-then-failed', compactModel = native): Promise<void> {
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const transports: Transport[] = []
  const runner = new AppServerRunner(`switch-${mode}`, { n: 0 }, agent, native, 'existing-thread', undefined, () => {
    const transport = new Transport()
    transport.compactStarted = started
    transports.push(transport)
    return transport
  })
  const events: any[] = []
  runner.on('event', event => events.push(event))
  try {
    assert.equal(await runner.getContextTokens(), undefined, '没有最近一次用量时不能假定上下文为空')
    let settled = false
    const operation = runner.compactForProviderSwitch(200000, compactModel).finally(() => { settled = true })
    const rejection = mode === 'success' ? undefined : assert.rejects(operation)
    await startedPromise
    const wire = transports.at(-1)!
    const resume = wire.requests.find(request => request.method === 'thread/resume')!.params
    const provider = compactModel === native ? 'uniagent-portable-openai' : 'uniagent-kimi'
    assert.equal(resume.model, compactModel === native ? native.model : 'k3-256k')
    assert.equal(resume.modelProvider, provider, '切换压缩必须使用目标模型的实际上下文规则')
    if (compactModel === native) assert.equal(resume.config['model_providers.uniagent-portable-openai.requires_openai_auth'], true)
    assert.equal(resume.config[`model_providers.${provider}.capabilities.remote_compaction`], 'unsupported')
    const notify = (method: string, extra: any): void => { wire.emit('notification', method, { threadId: 'existing-thread', turnId: 'compact-turn', ...extra }) }
    if (mode === 'disconnect') {
      wire.emit('disconnect', 'connection lost')
    } else if (mode === 'failed') {
      notify('turn/completed', { turn: { id: 'compact-turn', status: 'failed', error: { message: 'usage limit' } } })
    } else if (mode === 'item-then-failed') {
      notify('item/completed', { item: { id: 'compact-item', type: 'contextCompaction' } })
      notify('turn/completed', { turn: { id: 'compact-turn', status: 'failed' } })
    } else if (mode === 'missing') {
      notify('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
    } else {
      notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 0, totalTokens: mode === 'too-large' ? 300000 : 4000 }, total: {} } })
      notify('item/completed', { item: { id: 'compact-item', type: 'contextCompaction' } })
      await Promise.resolve()
      assert.equal(settled, false, 'item success alone cannot commit a provider switch')
      notify('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
    }
    if (rejection) {
      await rejection
      if (compactModel !== native) {
        await runner.ensureThreadReady()
        const restored = transports.at(-1)!.requests.find(request => request.method === 'thread/resume')!.params
        assert.equal(restored.model, native.model, '目标模型压缩失败后恢复原模型连接')
        assert.equal(restored.modelProvider, 'openai')
      }
    } else {
      await operation
      if (compactModel !== native) {
        // 根因回归 — 压缩成功后配置必须停留在目标模型：随后的容量复查续跑若
        // 拿旧模型恢复线程，codex 会对已记录为目标模型的 rollout 再发一条
        // 反向的 resume 模型不一致警告。
        await runner.getContextTokens()
        const review = transports.at(-1)!.requests.filter(request => request.method === 'thread/resume').at(-1)!.params
        assert.equal(review.model, 'k3-256k')
        assert.equal(review.modelProvider, 'uniagent-kimi')
      }
      await runner.applyProviderConfig(kimi, 249036)
      assert.equal(transports.at(-1)!.requests.find(request => request.method === 'thread/resume')!.params.modelProvider, 'uniagent-kimi')
      const occupancy = events.filter(event => event.payload?.kind === 'context').at(-1)!.payload.usage
      assert.equal(occupancy.contextWindow, 249036, '切换完成即发布目标窗口，不能等首条消息才更新')
      assert.equal(occupancy.contextTokens, 4000, '发布压缩后的占用，而非旧累计账单')
    }
    const compactions = events.filter(event => event.type === 'context_compaction')
    assert.ok(compactions.every(event => event.payload.reason === (compactModel === native ? undefined : 'provider-switch')),
      '只有跨 provider 切换主动压缩携带输入框提示来源，正常压缩及同来源压缩不能冒用')
    assert.equal(compactions.at(-1).state, ['success', 'too-large', 'item-then-failed'].includes(mode) ? 'success' : 'failed')
    const count = compactions.length
    ;(runner as any).onNotification('item/started', { threadId: 'existing-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } })
    assert.equal(events.filter(event => event.type === 'context_compaction').length, count, 'late starts cannot revive a finished compaction')
  } finally { runner.dispose() }
}

async function contextUsageCase(): Promise<void> {
  const wire = new Transport()
  wire.resumeUsage = { last: { inputTokens: 20000, totalTokens: 30000 }, total: { totalTokens: 900000 } }
  const runner = new AppServerRunner('switch-usage', { n: 0 }, agent, native, 'existing-thread', undefined, () => wire)
  try {
    assert.equal(await runner.getContextTokens(), 30000, '恢复线程后读取最近一次用量，包含尚未计入下次输入的回复')
    const cases: Array<[any, number | undefined]> = [
      [{ last: { inputTokens: 0, totalTokens: 4000 } }, 4000],
      [{ last: { input_tokens: 20000, total_tokens: 30000 } }, 30000],
      [{ last: { inputTokens: 20000 } }, 20000],
      [{ last: { inputTokens: 0, totalTokens: 0 } }, 0],
      [{ last: { totalTokens: 0 }, total: { totalTokens: 249036, inputTokens: 0, outputTokens: 0 }, modelContextWindow: 249036 }, 249036],
      [{ total: { totalTokens: 900000 } }, undefined],
      [{ last: {} }, undefined],
      [{ last: { totalTokens: NaN } }, undefined],
      [{ last: { totalTokens: Infinity } }, undefined],
      [{ last: { totalTokens: -1 } }, undefined],
      [{ last: { totalTokens: '4000' } }, undefined]
    ]
    for (const [tokenUsage, expected] of cases) {
      wire.emit('notification', 'thread/tokenUsage/updated', { threadId: 'existing-thread', tokenUsage })
      assert.equal(await runner.getContextTokens(), expected)
    }
    assert.equal(wire.requests.filter(request => request.method === 'thread/resume').length, 1, '已连接线程无需重复恢复')
  } finally { runner.dispose() }
}

async function targetContextCase(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-target-context-'))
  const wire = new Transport()
  wire.historyPath = join(root, 'rollout.jsonl')
  wire.resumeUsage = { last: { inputTokens: 97009, totalTokens: 97616 }, total: { totalTokens: 2331752 } }
  const runner = new AppServerRunner('target-context', { n: 0 }, agent, native, 'existing-thread', undefined, () => wire)
  const line = (type: string, payload: any): string => JSON.stringify({ type, payload }) + '\n'
  const image = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(595534) }] }
  const summary = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'summary' }] }
  try {
    await writeFile(wire.historyPath, line('session_meta', { base_instructions: { text: 'system' } }) + line('response_item', image))
    const budget = (await runner.getContextTokens(kimi))!
    assert.ok(budget > 249036, '跨来源的旧用量低于目标窗口，也必须把大图等原生历史纳入切换前预算')
    assert.ok(budget < Math.floor(1048576 * 0.95), '更大的目标能容纳预算时仍可直接切换，不因包含图片就无条件压缩')
    assert.equal(await runner.getContextTokens({ ...native, model: 'gpt-small' }), 97616, '同来源沿用可比较的原生 token 用量')
    await writeFile(wire.historyPath, line('response_item', image) + line('compacted', { replacement_history: [summary] }))
    assert.equal(await runner.getContextTokens(kimi), 97616, '压缩后不再累计已被替换的旧图片历史，也不使用累计账单 2331752')
    await writeFile(wire.historyPath, line('response_item', image) + line('compacted', {}))
    assert.equal(await runner.getContextTokens(kimi), undefined, '无法重建的压缩历史不能按旧模型用量判定足够')
    await writeFile(wire.historyPath, 'broken json\n')
    assert.equal(await runner.getContextTokens(kimi), undefined, '损坏的原生历史不能误判为零上下文')
    await writeFile(wire.historyPath, line('response_item', image) + line('compacted', { replacement_history: [summary] }) + line('event_msg', { type: 'thread_rolled_back', num_turns: 1 }))
    assert.equal(await runner.getContextTokens(kimi), undefined, '跨压缩边界回退后无法重建时不能低估有效历史')
    wire.historyPath = undefined
    assert.equal(await runner.getContextTokens(kimi), undefined, '未提供原生历史时不能把旧模型用量当作目标预算')
  } finally { runner.dispose(); await rm(root, { recursive: true, force: true }) }
}

async function encryptedCompactionCase(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-encrypted-switch-'))
  const file = join(root, 'rollout.jsonl')
  const providers: string[] = []
  let sequence = 0
  class CompactTransport extends Transport {
    async request<T>(method: string, params: any): Promise<T> {
      if (method !== 'thread/compact/start') return super.request(method, params)
      providers.push(this.requests.findLast(request => request.method === 'thread/resume')!.params.modelProvider)
      const turnId = `compact-${++sequence}`
      const item = { id: `${turnId}-item`, type: 'contextCompaction' }
      this.emit('notification', 'turn/started', { threadId: params.threadId, turn: { id: turnId } })
      this.emit('notification', 'item/started', { threadId: params.threadId, turnId, item })
      await writeFile(file, JSON.stringify({ type: 'compacted', payload: { replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'portable summary' }] }
      ] } }) + '\n')
      this.emit('notification', 'thread/tokenUsage/updated', { threadId: params.threadId, tokenUsage: { last: { inputTokens: 0, totalTokens: 4000 }, total: {} } })
      this.emit('notification', 'item/completed', { threadId: params.threadId, turnId, item })
      this.emit('notification', 'turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed' } })
      return {} as T
    }
  }
  const runner = new AppServerRunner('encrypted-switch', { n: 0 }, agent, native, 'existing-thread', undefined, () => {
    const wire = new CompactTransport()
    wire.historyPath = file
    return wire
  })
  try {
    await writeFile(file, JSON.stringify({ type: 'compacted', payload: { replacement_history: [
      { type: 'compaction', encrypted_content: 'provider-bound-summary' }
    ] } }) + '\n')
    assert.equal(await runner.getContextTokens(kimi), undefined, '加密摘要不能只按字节小于窗口就交给另一个来源')
    await runner.compactForProviderSwitch(249036, kimi)
    assert.deepEqual(providers, ['uniagent-portable-openai', 'uniagent-kimi'], '先由能读取摘要的原模型转成文本，再由目标模型准备上下文')
    assert.equal(await runner.getContextTokens(kimi), 4000, '可读文本检查点替换加密摘要后可以确认目标容量')
  } finally { runner.dispose(); await rm(root, { recursive: true, force: true }) }
}

async function overflowRecoveryCase(mode: 'success' | 'exhausted' | 'other' | 'interrupted' | 'compact-failed' | 'cancel-recovery' | 'completion-only'): Promise<void> {
  let retryStarted!: () => void
  const retry = new Promise<void>(resolve => { retryStarted = resolve })
  class TurnTransport extends Transport {
    async request<T>(method: string, params: any): Promise<T> {
      if (method === 'thread/compact/start') {
        if (mode === 'compact-failed') throw new Error('compact quota exhausted')
        queueMicrotask(() => {
          const common = { threadId: 'existing-thread', turnId: 'compact-turn' }
          this.emit('notification', 'turn/started', { ...common, turn: { id: 'compact-turn' } })
          if (mode === 'cancel-recovery') runner.interrupt()
          this.emit('notification', 'item/started', { ...common, item: { id: 'compact-item', type: 'contextCompaction' } })
          this.emit('notification', 'thread/tokenUsage/updated', { ...common, tokenUsage: { last: { inputTokens: 0, totalTokens: 4000 } } })
          this.emit('notification', 'item/completed', { ...common, item: { id: 'compact-item', type: 'contextCompaction' } })
          this.emit('notification', 'turn/completed', { ...common, turn: { id: 'compact-turn', status: mode === 'cancel-recovery' ? 'interrupted' : 'completed' } })
        })
        return {} as T
      }
      if (method !== 'turn/start') return super.request(method, params)
      this.requests.push({ method, params })
      if (this.requests.filter(item => item.method === method).length === 2) retryStarted()
      return { turn: { id: `turn-${this.requests.filter(item => item.method === method).length}` } } as T
    }
  }
  const wire = new TurnTransport()
  const runner = new AppServerRunner('switch-overflow', { n: 0 }, agent, kimi, 'existing-thread', undefined, () => wire)
  const events: any[] = [], done: any[] = []
  let ended!: () => void
  const terminal = new Promise<void>(resolve => { ended = resolve })
  runner.on('event', event => events.push(event))
  runner.on('done', result => { done.push(result); ended() })
  const error = { message: mode === 'other' ? 'API key is invalid' : "Codex ran out of room in the model's context window.", codexErrorInfo: mode === 'other' ? 'other' : 'contextWindowExceeded' }
  const notify = (method: string, turnId: string, extra: any): void => { wire.emit('notification', method, { threadId: 'existing-thread', turnId, ...extra }) }
  try {
    await runner.startTurn('原始问题', [{ kind: 'image', name: 'fixture.png', path: '/fixture.png' }])
    if (mode === 'interrupted') runner.interrupt()
    if (mode !== 'completion-only') notify('error', 'turn-1', { error })
    notify('turn/completed', 'turn-1', { turn: { id: 'turn-1', status: mode === 'interrupted' ? 'interrupted' : 'failed', error } })
    const recover = ['success', 'exhausted', 'completion-only'].includes(mode)
    const settled = recover ? retry : terminal
    await Promise.race([settled, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(JSON.stringify(events))), 2000)
      settled.finally(() => clearTimeout(timer))
    })])
    await new Promise(resolve => setImmediate(resolve))
    const starts = wire.requests.filter(item => item.method === 'turn/start')
    assert.ok(starts[0].params.input.some((item: any) => item.type === 'localImage' && item.path === '/fixture.png'))
    assert.equal(starts.length, recover ? 2 : 1, '仅明确超限且未中断时自动接续一次')
    if (recover) {
      assert.deepEqual(starts[1].params.input, [], '接续原生历史中已保存的输入，不重复提交用户问题和附件')
      assert.equal(done.length, 0, '压缩接续期间不能提前结束逻辑回合或调度下一条消息')
      assert.equal(events.some(event => event.type === 'error'), false, '可恢复的首次超限显示等待提示')
      notify('error', 'turn-1', { error })
      assert.equal(events.some(event => event.type === 'error'), false, '迟到的旧错误不能破坏压缩接续')
      notify('item/started', 'turn-2', { item: { id: 'auto-compact', type: 'contextCompaction' } })
      notify('item/completed', 'turn-2', { item: { id: 'auto-compact', type: 'contextCompaction' } })
      if (mode === 'exhausted') notify('error', 'turn-2', { error })
      notify('turn/completed', 'turn-2', { turn: { id: 'turn-2', status: mode === 'exhausted' ? 'failed' : 'completed', error: mode === 'exhausted' ? error : null } })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(wire.requests.filter(item => item.method === 'turn/start').length, 2, '第二次超限不再重试')
    }
    assert.equal(done.length, 1)
    assert.ok(events.filter(event => event.type === 'context_compaction').every(event => event.payload.reason === undefined),
      '运行中超限恢复及 Codex 自发压缩都不能显示跨 provider 切换输入框提示')
    assert.equal(!!done[0].failed, ['exhausted', 'other', 'compact-failed'].includes(mode))
    if (mode === 'cancel-recovery') assert.equal(done[0].interrupted, true)
  } finally { runner.dispose() }
}

async function orchestratorCase({ fail = false, applyFails = false, previous = native, target = kimi, contextTokens, compact = true, afterCompact = 4000 }: {
  fail?: boolean; applyFails?: boolean; previous?: SessionConfig; target?: SessionConfig; contextTokens?: number; compact?: boolean; afterCompact?: number
} = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-provider-switch-'))
  const store = new SessionStore(join(root, 'sessions.json'))
  const session: Session = { id: 'session', title: 'session', config: previous, nativeSessionId: 'existing-thread', status: 'idle', createdAt: Date.now(), origin: 'created', readOnly: false }
  store.save([session])
  const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'), join(root, 'logs'))
  orchestrator.loadPersisted()
  const current = orchestrator.getSessionById('session')!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = []
  let didCompact = false
  const fake = {
    getContextTokens: async (config: SessionConfig): Promise<number | undefined> => { assert.equal(config.model, target.model); calls.push('usage'); await gate; return didCompact ? afterCompact : contextTokens },
    compactForProviderSwitch: async (limit: number, config: SessionConfig): Promise<void> => {
      assert.equal(config.model, target.model, '压缩阶段就必须选用目标模型，不能拿旧模型的压缩用量确认跨来源容量')
      assert.equal(limit, Math.floor(agent.models.find(model => model.id === target.model)!.contextWindow! * 0.95),
        '切换容量必须采用目标目录的有效窗口，不能继续使用未知模型的 272K 上限')
      calls.push('compact'); await gate; if (fail) throw new Error('quota exhausted'); didCompact = true
    },
    applyProviderConfig: async (config: SessionConfig): Promise<void> => { calls.push('apply'); assert.equal(config.model, target.model); if (applyFails) throw new Error('provider unavailable') },
    updateConfig: (): void => { calls.push('restore') }
  }
  ;(orchestrator as any).ensureStreamerForNativeAction = () => fake
  ;(orchestrator as any).assertSessionNotExternallyOccupied = async () => {}
  try {
    for (const status of ['running', 'queued', 'cancelling', 'awaiting-approval'] as const) {
      current.status = status
      await orchestrator.updateSessionConfig('session', target)
      assert.equal(current.config.model, previous.model, '运行及停止过程中不能替换当前模型')
      assert.equal(current.nativeSessionId, 'existing-thread')
      assert.equal(calls.length, 0, '忙碌时不得准备另一厂商的连接或压缩历史')
    }
    current.status = 'idle'
    const switching = orchestrator.updateSessionConfig('session', target)
    const tooLarge = compact && afterCompact >= Math.floor(agent.models.find(model => model.id === target.model)!.contextWindow! * 0.95)
    const rejected = fail || applyFails || tooLarge ? assert.rejects(switching, /quota|provider|上下文/) : undefined
    await Promise.resolve(); await Promise.resolve()
    assert.equal(current.config.model, previous.model)
    await assert.rejects(orchestrator.updateSessionConfig('session', { effort: 'high' }), /原生操作/)
    await assert.rejects(orchestrator.sendMessage('session', 'continue'), /native_action|原生操作/)
    release()
    if (rejected) await rejected
    else await switching
    assert.equal(current.config.model, fail || applyFails || tooLarge ? previous.model : target.model)
    assert.equal(current.nativeSessionId, 'existing-thread', '切换成功或失败均保留原生会话 ID')
    assert.deepEqual(calls, ['usage', ...(compact ? ['compact', ...(fail ? [] : ['usage'])] : []), ...(fail || tooLarge ? [] : ['apply']), ...(fail || applyFails || tooLarge ? ['restore'] : [])])
    const events = await orchestrator.getEvents('session')
    assert.equal(events.filter(event => event.type === 'system_notice').some(event => String(event.payload?.text || '').includes('切换')), false,
      '切换过程与结果由卡片承载，不再发纯文本提示')
    const cards = events.filter(event => event.type === 'model_switch')
    assert.ok(cards.length > 0, '切换必须留下进度卡片')
    assert.equal(new Set(cards.map(event => event.payload.id)).size, 1, '一次切换全程共用一个卡片 id')
    const card = cards.at(-1)!
    assert.equal(card.payload.fromModel, previous.model)
    assert.equal(card.payload.toModel, target.model)
    assert.ok(card.payload.fromLabel && card.payload.toLabel, '卡片携带展示用模型名')
    assert.equal(typeof card.payload.startedAt, 'number')
    if (!fail && !applyFails && !tooLarge) {
      assert.equal(card.state, 'success')
      assert.equal(card.payload.compacted, compact)
      assert.equal(card.payload.step, 'apply')
      assert.equal(typeof card.payload.endedAt, 'number')
    } else {
      assert.equal(card.state, 'failed')
      assert.ok(card.payload.error, '失败卡片必须给出原因')
    }
    assert.equal((orchestrator as any).nativeActionReservations.has('session'), false)
    assert.equal(new SessionStore(join(root, 'sessions.json')).load()[0].config.model, fail || applyFails || tooLarge ? previous.model : target.model)
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function warningFoldingCase(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-switch-fold-'))
  const store = new SessionStore(join(root, 'sessions.json'))
  const session: Session = { id: 'fold', title: 'fold', config: native, nativeSessionId: 'existing-thread', status: 'idle', createdAt: Date.now(), origin: 'created', readOnly: false }
  store.save([session])
  const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'), join(root, 'logs'))
  orchestrator.loadPersisted()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fake = {
    getContextTokens: async (): Promise<number> => { await gate; return 20000 },
    compactForProviderSwitch: async (): Promise<void> => {},
    applyProviderConfig: async (): Promise<void> => {},
    updateConfig: (): void => {}
  }
  ;(orchestrator as any).ensureStreamerForNativeAction = () => fake
  ;(orchestrator as any).assertSessionNotExternallyOccupied = async () => {}
  const warning = (recorded: string, resuming: string): UAEvent => ({
    sessionId: 'fold', seq: 0, ts: Date.now(), type: 'system_notice',
    payload: { kind: 'warning', text: `This session was recorded with model \`${recorded}\` but is resuming with \`${resuming}\`. Consider switching back to \`${recorded}\` as it may affect Codex performance.` }
  })
  const fold = (ev: UAEvent): boolean => (orchestrator as any).foldModelSwitchNotice(orchestrator.getSessionById('fold')!, ev)
  try {
    const switching = orchestrator.updateSessionConfig('fold', kimi)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(fold(warning('gpt-6.1-sol', 'k3-256k')), true, '切换期间的正向不一致警告折叠进卡片')
    assert.equal(fold(warning('k3-256k', 'gpt-6.1-sol')), true, '切换期间的反向不一致警告同样折叠')
    release()
    await switching
    const events = await orchestrator.getEvents('fold')
    assert.equal(events.filter(event => event.type === 'system_notice' && String(event.payload?.text || '').includes('resuming with')).length, 0,
      '折叠后时间线不再留下散落的原始警告')
    const card = events.filter(event => event.type === 'model_switch').at(-1)!
    assert.equal(card.state, 'success')
    assert.equal(card.payload.hints.length, 2, '原始警告收进卡片 hints')
    assert.ok(card.payload.hints.every((text: string) => text.includes('resuming with')))
    assert.equal(fold(warning('gpt-6.1-sol', 'k3-256k')), true, '回合开始前的迟到警告仍按切换产物折叠')
    assert.equal(fold({ sessionId: 'fold', seq: 0, ts: Date.now(), type: 'turn_started', payload: { threadId: 'existing-thread' } }), false)
    assert.equal(fold(warning('gpt-6.1-sol', 'k3-256k')), false, '下一个回合开始后同类警告恢复为普通提示')
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function nativeModelSwitchCase(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-native-model-switch-'))
  const store = new SessionStore(join(root, 'sessions.json'))
  const session: Session = { id: 'native-switch', title: 'hi', config: native, nativeSessionId: 'existing-thread', status: 'idle', createdAt: Date.now(), origin: 'created', readOnly: false }
  store.save([session])
  const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'), join(root, 'logs'))
  orchestrator.loadPersisted()
  const applied: SessionConfig[] = []
  ;(orchestrator as any).streamers.set(session.id, { updateConfig: (config: SessionConfig) => { applied.push(config) } })
  ;(orchestrator as any).ensureStreamerForNativeAction = () => { assert.fail('官方 provider 内部模型切换不能进入压缩准备事务') }
  ;(orchestrator as any).assertSessionNotExternallyOccupied = async () => {}
  try {
    for (const model of ['gpt-small', native.model!]) {
      await orchestrator.updateSessionConfig(session.id, { model })
      assert.equal(orchestrator.getSessionById(session.id)!.config.model, model)
      assert.equal(applied.at(-1)?.model, model)
    }
    assert.equal((await orchestrator.getEvents(session.id)).some(event => event.type === 'context_compaction' || event.type === 'model_switch'), false)
    assert.equal(new SessionStore(join(root, 'sessions.json')).load()[0].config.model, native.model)
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function nativeModelNextTurnCase(): Promise<void> {
  const wire = new Transport()
  const runner = new AppServerRunner('native-next-turn', { n: 0 }, agent, native, 'existing-thread', undefined, () => wire)
  try {
    await runner.ensureThreadReady()
    runner.updateConfig({ ...native, model: 'gpt-small' })
    await runner.startTurn('hi')
    const turn = wire.requests.find(request => request.method === 'turn/start')!.params
    assert.equal(turn.model, 'gpt-small', '直接切换后的首条自然对话使用目标模型')
    assert.equal(turn.collaborationMode, undefined, '普通对话不发送覆盖模型的模式配置')
    assert.deepEqual(turn.input, [{ type: 'text', text: 'hi', text_elements: [] }])
    assert.equal(wire.requests.filter(request => request.method === 'thread/resume').length, 1)
    assert.equal(wire.requests.some(request => request.method === 'thread/compact/start'), false)
  } finally { runner.dispose() }
}

async function providerRoundTripCase(chain: SessionConfig[]): Promise<void> {
  const transports: Transport[] = [], events: UAEvent[] = []
  let turnNumber = 0
  class RoundTripTransport extends Transport {
    async request<T>(method: string, params: any): Promise<T> {
      const result = await super.request<T>(method, params)
      return method === 'turn/start' ? { turn: { id: `roundtrip-${++turnNumber}` } } as T : result
    }
  }
  const runner = new AppServerRunner('roundtrip', { n: 0 }, agent, chain[0], 'roundtrip-thread', undefined, () => {
    const wire = new RoundTripTransport()
    transports.push(wire)
    return wire
  })
  runner.on('event', event => events.push(event))
  try {
    for (const [index, config] of chain.entries()) {
      await runner.applyProviderConfig(config)
      assert.equal(runner.nativeThreadId(), 'roundtrip-thread')
      const wire = transports.at(-1)!
      const resume = wire.requests.find(request => request.method === 'thread/resume')!.params
      const model = config === native ? native.model : config === kimi ? 'k3-256k' : 'deepseek-flash'
      assert.equal(resume.model, model)
      assert.equal(resume.modelProvider, config === native ? 'openai' : codexSessionProvider(config.modelSource!))
      const done = new Promise<any>(resolve => runner.once('done', resolve))
      await runner.startTurn(`message-${index}`)
      const start = wire.requests.find(request => request.method === 'turn/start')!.params
      assert.equal(start.model, model, '切换后新发送的消息必须使用目标模型')
      assert.deepEqual(start.input, [{ type: 'text', text: `message-${index}`, text_elements: [] }])
      const turnId = `roundtrip-${turnNumber}`
      wire.emit('notification', 'item/completed', { threadId: 'roundtrip-thread', turnId, item: { id: `reply-${index}`, type: 'agentMessage', text: `reply-${index}` } })
      wire.emit('notification', 'turn/completed', { threadId: 'roundtrip-thread', turn: { id: turnId, status: 'completed' } })
      const result = await done
      assert.equal(!!result.failed, false)
      assert.equal(!!result.interrupted, false)
      assert.ok(events.some(event => event.type === 'agent_message' && event.payload.text === `reply-${index}`), '切换后必须完成真实消息事件链，不能只验证配置值')
    }
    assert.equal(transports.length, chain.length, '每次跨来源都重新连接，切回官方时不得沿用第三方路由')
    assert.ok(transports.every(wire => !wire.requests.some(request => request.method === 'thread/start')), '往返过程中不能新建空白会话')
  } finally { runner.dispose() }
}

try {
  await providerRoundTripCase([kimi, deepseek, kimi])
  await providerRoundTripCase([native, kimi, deepseek, native])
  await nativeModelSwitchCase()
  await nativeModelNextTurnCase()
  for (const [previous, target] of [[deepseek, kimi], [kimi, deepseek]]) {
    await orchestratorCase({ previous, target, contextTokens: 20000, compact: false })
    await orchestratorCase({ previous, target, contextTokens: 20000, compact: false, applyFails: true })
    await orchestratorCase({ previous, target, fail: true })
  }
  for (const mode of ['success', 'exhausted', 'other', 'interrupted', 'compact-failed', 'cancel-recovery', 'completion-only'] as const) await overflowRecoveryCase(mode)
  await orchestratorCase({ contextTokens: 20000, compact: false })
  await targetContextCase()
  await encryptedCompactionCase()
  await contextUsageCase()
  for (const mode of ['success', 'failed', 'disconnect', 'missing', 'too-large', 'item-then-failed'] as const) await adapterCase(mode)
  await adapterCase('success', kimi)
  await adapterCase('failed', kimi)
  await orchestratorCase()
  await warningFoldingCase()
  await orchestratorCase({ fail: true })
  await orchestratorCase({ applyFails: true })
  await orchestratorCase({ applyFails: true, contextTokens: 20000, compact: false })
  await orchestratorCase({ target: { ...kimi, model: codexModelKey('k3', kimi.modelSource!) }, contextTokens: 700000, compact: false })
  await orchestratorCase({ contextTokens: 0, compact: false })
  const contextLimit = Math.floor(262144 * 0.95)
  await orchestratorCase({ contextTokens: contextLimit - 1, compact: false })
  await orchestratorCase({ contextTokens: contextLimit })
  await orchestratorCase({ contextTokens: contextLimit + 1 })
  await orchestratorCase({ contextTokens: contextLimit + 1, afterCompact: contextLimit + 1 })
  await orchestratorCase({ previous: { ...kimi, model: codexModelKey('k3', kimi.modelSource!) }, contextTokens: 700000 })
  await orchestratorCase({ previous: { ...kimi, model: codexModelKey('k3', kimi.modelSource!), modelSource: undefined }, target: { ...kimi, modelSource: undefined }, contextTokens: 700000 })
} finally { configureCodexAppServerArgsProvider() }
console.log('codex provider switch: ok')
