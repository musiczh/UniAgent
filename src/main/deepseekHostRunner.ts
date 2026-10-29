import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { AgentDef, Attachment, SessionAgentContract, SessionConfig, TurnUsage, UAEvent } from '../shared/types.ts'
import type { GoalState, NativeGoalUpdate } from '../shared/nativeCapabilities.ts'
import { assistantPrompt } from './assistant/context'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'
import { DeepSeekHostEvents, type DeepSeekRemoteRequest } from './deepseekHostEvents.ts'
import { assertDeepSeekHostConfig, deepseekHostContract, deepseekHostPermissionModes, DEEPSEEK_HOST_PERMISSION_VALUES } from './deepseekHostContract.ts'
import { projectDeepSeekNativeEvent, type DeepSeekProjectionContext } from './deepseekEventProjection.ts'
import { projectDeepSeekSessionUsage } from './deepseekGoalProjection.ts'
import { bindDeepSeekHostContext } from './deepseekHostContext.ts'

type Event = Pick<UAEvent, 'type' | 'state' | 'payload'>
const unsupported = (): Error => new Error('当前 DeepSeek Host 尚未接通此能力，不能执行此操作。')
const owners = new WeakMap<DeepSeekHostClient, Map<string, DeepSeekHostRunner>>()

/** Owned Host execution. Prompt acceptance and native turn completion are separate. */
export class DeepSeekHostRunner extends EventEmitter {
  private client?: DeepSeekHostClient
  private hub?: DeepSeekHostEvents
  private detach?: () => void
  private controller?: AbortController
  private ready?: Promise<void>
  private initializing?: AbortController
  private disposed = false
  private running = false
  private cancelling = false
  private submitted = false
  private broken = false
  private failedClient?: DeepSeekHostClient
  private nativeSessionId?: string
  private adopted: boolean
  private contract?: SessionAgentContract
  private config: SessionConfig
  private cursor = -1
  private context: DeepSeekProjectionContext = {}
  private pending = new Map<string, DeepSeekRemoteRequest>()
  private finishTurn?: () => void
  private cancelTimer?: ReturnType<typeof setTimeout>
  private segments = new Map<string, { type: 'agent_message' | 'reasoning'; text: string }>()
  private attempt?: { id: string; turn: number; step: number; next: number }
  private usage?: TurnUsage

  constructor(private readonly sessionId: string, private readonly seqRef: { n: number }, _agent: AgentDef,
    config: SessionConfig, resumeSessionId?: string, _extraEnv?: unknown,
    private readonly acquireClient: () => Promise<DeepSeekHostClient> = async () => (await import('./deepseekService.ts')).getDeepSeekHost()) {
    super(); this.config = { ...config }; this.nativeSessionId = resumeSessionId; this.adopted = !!resumeSessionId
  }
  isRunning(): boolean { return this.running }
  supportsCommand(name: string): boolean { return this.contract?.commands.includes(name.replace(/^\//, '')) === true }
  private event(event: Event): void {
    if (!this.disposed) this.emit('event', { ...event, sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now() })
  }
  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new DeepSeekHostError('runner-closed'))
    if (this.ready) return this.ready
    const controller = new AbortController()
    this.initializing = controller
    const signal = controller.signal
    const timer = setTimeout(() => controller.abort(new DeepSeekHostError('initialization-timeout')), 30_000)
    let rejectAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason)
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const connecting = (async () => {
      const client = await this.acquireClient()
      signal.throwIfAborted()
      if (client === this.failedClient) throw new DeepSeekHostError('connection-lost-reopen-session')
      if (this.client !== client) { this.disconnect(); this.broken = false }
      if (this.broken) throw new DeepSeekHostError('connection-lost-reopen-session')
      if (!this.client) await this.connect(client, signal)
    })()
    const ready = Promise.race([connecting, aborted]).catch(error => {
      this.disconnect()
      throw signal.aborted ? signal.reason : error
    }).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', rejectAbort)
      if (this.initializing === controller) this.initializing = undefined
      if (this.ready === ready) this.ready = undefined
    })
    this.ready = ready; return ready
  }
  private async connect(client: DeepSeekHostClient, initializing: AbortSignal): Promise<void> {
    assertDeepSeekHostConfig(this.config)
    if (this.disposed) throw new DeepSeekHostError('runner-closed')
    const owned = owners.get(client) || new Map<string, DeepSeekHostRunner>()
    owners.set(client, owned)
    const id = this.nativeSessionId || `session-${randomUUID()}`
    if (owned.has(id) && owned.get(id) !== this) throw new DeepSeekHostError('session/writer-held')
    if (this.adopted) {
      const inventory = await client.call<any>('session/list', { _request: {} }, initializing)
      initializing.throwIfAborted()
      const current = inventory.items?.find((row: any) => row.sessionId === id)
      if (!current) throw new DeepSeekHostError('session/not-found')
      if (current.running) throw new DeepSeekHostError('session/agent-busy')
    }
    if (owned.has(id) && owned.get(id) !== this) throw new DeepSeekHostError('session/writer-held')
    owned.set(id, this); this.client = client; this.nativeSessionId = id
    // 0.2.1 only reuses a stored Session through create while it is still blank;
    // a Session that already started a turn would be replaced by a minted one.
    // Resumed and forked Sessions therefore attach without create: the first
    // agent-scoped route (selectModel/commands) resumes the stored identity.
    if (!this.adopted) {
      const created = await client.call<any>('session/create', { request: { sessionId: id, cwd: this.config.workdir } }, initializing)
      initializing.throwIfAborted()
      if (created?.sessionId !== id) throw new DeepSeekHostError('invalid-session-identity')
    }
    this.adopted = true
    await bindDeepSeekHostContext(client, id, this.sessionId, this.config.workdir, initializing)
    initializing.throwIfAborted()
    this.hub = DeepSeekHostEvents.for(client)
    this.detach = await this.hub.attach(id, { request: request => this.request(request), cancel: id => this.resolve(id, 'cancelled'), failed: error => this.connectionFailed(error) }, initializing)
    initializing.throwIfAborted()
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, initializing])
    const stream = client.stream<any>('session/follow', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 1, assistantStream: true } }, signal)
    const baseline = await stream.next()
    initializing.throwIfAborted()
    if (baseline.value?.type !== 'snapshot' || !Number.isSafeInteger(baseline.value.cursor)) throw new DeepSeekHostError('invalid-session-snapshot')
    this.cursor = baseline.value.cursor
    this.usage = projectDeepSeekSessionUsage(baseline.value.projections?.values?.tokenUsage)
    if (this.disposed) { await stream.return(undefined); throw new DeepSeekHostError('runner-closed') }
    this.emit('nativeSession', { nativeSessionId: id })
    void (async () => {
      try {
        for await (const frame of stream) {
          if (frame.type === 'event') this.onNative(frame.event)
          else if (frame.type === 'assistant-stream') this.onStream(frame.frame)
        }
        if (!this.disposed) throw new DeepSeekHostError('session-stream-ended')
      } catch (error) { if (!this.disposed && !signal.aborted) this.connectionFailed(error) }
    })()
    const [catalog, commands, permissions] = await Promise.all([
      client.call('session/modelCatalog', {}, initializing), client.call<any[]>('commands/list', { agentId: id }, initializing), client.call('permissionPresets/catalog', {}, initializing)
    ])
    initializing.throwIfAborted()
    this.contract = deepseekHostContract(catalog, this.config, permissions, commands.map(command => command.name).filter(name => name !== 'uniagent-bind-context'))
    await this.applyConfig(this.config, initializing)
    initializing.throwIfAborted()
    this.emit('contract', structuredClone(this.contract))
  }
  private connectionFailed(error: unknown): void {
    if (this.broken || this.disposed) return
    this.broken = true
    this.failedClient = this.client
    if (!this.running) return // A settings update may replace an idle owned Host.
    this.event({ type: 'error', state: 'failed', payload: { message: 'DeepSeek Host 连接已断开，执行结果待确认。请重新打开会话核对历史；不会自动重发消息。', code: error instanceof DeepSeekHostError ? error.code : 'connection-lost' } })
    for (const id of this.pending.keys()) this.resolve(id, 'cancelled')
    this.finish('failed')
  }
  private async command(line: string, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    const result = await this.client!.call<any>('commands/execute', { agentId: this.nativeSessionId, line, submittedAttachments: [] }, signal)
    signal?.throwIfAborted()
    if (!result || result.result?.kind !== 'success') throw new DeepSeekHostError('command-rejected')
    return result.result
  }
  private async applyConfig(config: SessionConfig, signal?: AbortSignal): Promise<void> {
    assertDeepSeekHostConfig(config)
    signal?.throwIfAborted()
    const permissionModes = deepseekHostPermissionModes(await this.client!.call('permissionPresets/catalog', {}, signal))
    signal?.throwIfAborted()
    const permissionMode = config.permissionMode || 'ask'
    if (!permissionModes.some(mode => mode.id === permissionMode)) throw new Error('当前 DeepSeek Host 未提供所选权限模式')
    if (config.collaborationMode === 'plan' && !this.supportsCommand('plan')) throw new Error('当前 DeepSeek Host 未提供 Plan 模式')
    const modelId = config.model || this.contract?.currentModelId
    if (modelId) {
      let route: unknown
      try { route = JSON.parse(modelId) } catch { throw new DeepSeekHostError('invalid-model-selection') }
      if (!Array.isArray(route) || route.length !== 2 || route.some(part => typeof part !== 'string' || !part)) throw new DeepSeekHostError('invalid-model-selection')
      const selected = await this.client!.call<any>('session/selectModel', { request: { sessionId: this.nativeSessionId, provider: route[0], model: route[1], ...(config.effort ? { reasoningEffort: config.effort } : {}) } }, signal)
      signal?.throwIfAborted()
      if (!selected?.selected) throw new DeepSeekHostError('invalid-model-selection')
      this.config = { ...config, model: JSON.stringify([selected.selected.provider, selected.selected.model]), effort: selected.selected.reasoningEffort }
    }
    const nativePermission = DEEPSEEK_HOST_PERMISSION_VALUES[permissionMode as keyof typeof DEEPSEEK_HOST_PERMISSION_VALUES]
    await this.command(`/permission ${nativePermission}`, signal)
    const follow = this.client!.stream<any>('session/follow', { request: { address: { kind: 'session', sessionId: this.nativeSessionId }, maxMessages: 1 } }, AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]))
    try {
      const snapshot = await follow.next()
      signal?.throwIfAborted()
      if (snapshot.value?.type !== 'snapshot' || snapshot.value.projections?.values?.permissions?.currentValue !== nativePermission) throw new DeepSeekHostError('permission-not-applied')
    } finally { await follow.return(undefined) }
    if (this.supportsCommand('plan')) await this.command(config.collaborationMode === 'plan' ? '/plan' : '/plan off', signal)
    signal?.throwIfAborted()
    this.config = { ...config, model: this.config.model, effort: this.config.effort }
    this.contract = { ...this.contract!, currentModelId: this.config.model, permissionModes, currentPermissionMode: permissionMode }
  }
  async updateConfig(config: SessionConfig): Promise<{ config: SessionConfig; contract?: SessionAgentContract }> {
    if (this.running) throw new DeepSeekHostError('runner-busy')
    assertDeepSeekHostConfig(config)
    const previous = this.config
    try {
      await this.ensureReady()
      if (JSON.stringify(config) !== JSON.stringify(this.config)) await this.applyConfig(config)
      return { config: { ...this.config }, contract: this.contract && structuredClone(this.contract) }
    } catch (error) { this.config = previous; this.disconnect(); throw error }
  }
  restoreConfigAfterFailedCommit(config: SessionConfig, contract?: SessionAgentContract): void {
    if (this.running) throw new DeepSeekHostError('runner-busy')
    this.config = { ...config }; this.contract = contract && structuredClone(contract); this.disconnect()
  }
  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> { await this.updateConfig({ ...this.config, collaborationMode: mode }) }
  private async content(prompt: string, attachments?: Attachment[]): Promise<any[]> {
    const result: any[] = prompt ? [{ type: 'text', text: prompt }] : []
    for (const attachment of attachments || []) {
      const file = await open(attachment.path, 'r')
      try {
        const metadata = await file.stat()
        if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error('DeepSeek 附件须为不超过 8 MB 的普通文件')
        const data = (await file.readFile()).toString('base64')
        if (attachment.kind === 'image') {
          const mediaType = attachment.mime || 'image/png'
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new Error('DeepSeek 不支持此图片格式')
          result.push({ type: 'image', mediaType, data, name: attachment.name })
        } else {
          const upload = await this.client!.call<any>('fileUploads/upload', { agentId: this.nativeSessionId, request: { data, name: attachment.name } })
          if (typeof upload?.receiptId !== 'string') throw new DeepSeekHostError('invalid-upload-receipt')
          result.push({ type: 'file', receiptId: upload.receiptId })
        }
      } finally { await file.close() }
    }
    return result
  }
  async startTurn(prompt: string, attachments?: Attachment[]): Promise<void> {
    if (this.disposed || this.running) throw new DeepSeekHostError('runner-busy')
    this.running = true; this.cancelling = false; this.submitted = false; this.segments.clear()
    const done = new Promise<void>(resolve => { this.finishTurn = resolve })
    try {
      await this.ensureReady()
      if (this.cancelling) { this.finish('cancelled'); return }
      if (prompt.trimStart().startsWith('/')) {
        if (attachments?.length) throw new Error('slash 命令不能与附件同时发送')
        const result = await this.command(prompt.trimStart())
        if (result.text) this.event({ type: 'system_notice', payload: { message: result.text } })
        this.finish('success'); return
      }
      const effective = await assistantPrompt(this.sessionId, this.config, prompt, [worktreeInstructions(this.config), requirementInstructions(this.config)].filter(Boolean).join('\n\n'))
      const content = await this.content(effective, attachments)
      if (this.cancelling) { this.finish('cancelled'); return }
      this.submitted = true
      const accepted = await this.client!.call<any>('session/prompt', { request: { sessionId: this.nativeSessionId, requestId: randomUUID(), mode: 'queue', content } })
      if (accepted?.accepted !== true) throw new DeepSeekHostError('invalid-prompt-acknowledgement')
      await done
    } catch (error) {
      if (this.cancelling || this.disposed) { this.finish('cancelled'); return }
      if (error instanceof DeepSeekHostError && ['transport-failed', 'closed', 'invalid-response'].includes(error.code)) {
        this.connectionFailed(error)
        return
      }
      const authRequired = error instanceof DeepSeekHostError && /credentials|authentication/.test(error.code)
      this.event({ type: 'error', state: 'failed', payload: { message: error instanceof Error ? error.message : 'DeepSeek Host 请求失败', ...(authRequired ? { authRequired: true } : {}) } })
      this.finish(this.cancelling ? 'cancelled' : 'failed', authRequired)
    }
  }
  private onNative(event: any): void {
    if (!Number.isSafeInteger(event?.seq) || event.seq <= this.cursor) return
    this.cursor = event.seq
    const projected = projectDeepSeekNativeEvent(event, this.context)
    for (const value of projected) {
      if (value.type === 'user_message') continue // UniAgent's outbox owns these rows.
      if (['agent_message', 'reasoning'].includes(value.type) && Number.isSafeInteger(event.data?.step)) {
        const index = Number(value.payload.id.split('-').at(-1))
        value.payload.id = this.segmentId(event.data.turn, event.data.step, index)
        this.segments.delete(value.payload.id)
      }
      if (value.payload.kind === 'usage') this.usage = value.payload.usage
      this.event(value)
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      const authRequired = reason?.error?.code === 'AUTH' || reason?.error?.status === 401
        || /CREDENTIAL|AUTHENTICATION|AUTHORIZATION/.test(reason?.error?.code || '')
      if (reason?.kind === 'error' || reason?.kind === 'blocked') this.event({ type: 'error', state: 'failed', payload: {
        message: authRequired ? 'DeepSeek 登录或 API Key 已失效，请在设置中重新登录或配置。' : `DeepSeek 原生任务未完成（${reason.kind}）`,
        ...(authRequired ? { authRequired: true } : {})
      } })
      this.finish(['aborted', 'interrupted'].includes(reason?.kind) ? 'cancelled'
        : ['completed', 'max-tokens'].includes(reason?.kind) ? 'success' : 'failed', authRequired)
    }
    if (event.type === 'plan/mode' && typeof event.data?.active === 'boolean') {
      this.config.collaborationMode = event.data.active ? 'plan' : 'default'
      this.emit('collaborationModeChanged', this.config.collaborationMode)
    }
  }
  private segmentId(turn: number, step: number, index: number): string { return `deepseek-${this.nativeSessionId}-${turn}-${step}-${index}` }
  private onStream(frame: any): void {
    if (frame.type === 'start') {
      this.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step, next: 0 }
      this.segments.clear()
      return
    }
    const attempt = this.attempt
    if (!attempt || attempt.id !== frame.attemptId || frame.type !== 'chunk' || frame.index < attempt.next) return
    attempt.next = frame.index + 1
    const chunk = frame.chunk
    if (!['text-delta', 'reasoning-delta'].includes(chunk?.type) || typeof chunk.text !== 'string') return
    const id = this.segmentId(attempt.turn, attempt.step, chunk.index)
    const value = this.segments.get(id) || { type: chunk.type === 'text-delta' ? 'agent_message' : 'reasoning', text: '' }
    value.text += chunk.text; this.segments.set(id, value)
    this.event({ type: value.type, state: 'running', payload: { id, text: value.text } })
  }
  private request(request: DeepSeekRemoteRequest): boolean {
    if (!['approval/request', 'user-questions/request'].includes(request.event) || this.disposed) return false
    const id = request.eventId
    this.pending.set(id, request)
    const question = request.event === 'user-questions/request'
    this.event({ type: 'approval_request', state: 'pending', payload: { id, requestId: id,
      kind: question ? 'question' : 'permission', method: question ? '_uniagent/ask_user_question' : 'session/request_permission',
      params: question ? { questions: request.request.questions?.map((row: any) => ({ ...row, allowOther: true })) }
        : { toolCallId: request.request.callId, title: request.request.toolName, reason: request.request.reason },
      ...(question ? {} : { options: [{ optionId: 'allow_once', kind: 'allow_once', name: '允许一次' }, { optionId: 'reject_once', kind: 'reject_once', name: '拒绝' }] })
    } })
    return true
  }
  async respondResult(id: string, answer: any): Promise<{ handled: boolean; hasPendingRequests: boolean }> {
    const request = this.pending.get(id)
    if (!request || !this.hub) return { handled: false, hasPendingRequests: this.pending.size > 0 }
    let value: any
    if (request.event === 'approval/request') {
      const option = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : undefined
      value = option === 'allow_once' ? 'allowed-once' : option === 'reject_once' ? 'rejected' : 'cancelled'
    } else {
      const questions = request.request.questions || []
      const answers = answer?.answers
      if (!Array.isArray(answers) || answers.length !== questions.length || new Set(answers.map(row => row?.id)).size !== questions.length) return { handled: false, hasPendingRequests: true }
      for (const row of answers) {
        const question = questions.find((q: any) => q.id === row?.id)
        if (!question || !Array.isArray(row.selected) || new Set(row.selected).size !== row.selected.length || row.selected.some((label: any) => !question.options?.some((option: any) => option.label === label))
          || (!question.multiSelect && row.selected.length > 1) || (row.custom !== undefined && typeof row.custom !== 'string')) return { handled: false, hasPendingRequests: true }
      }
      value = { answers }
    }
    const handled = await this.hub.answer(id, value)
    if (handled) this.resolve(id, 'success')
    return { handled, hasPendingRequests: this.pending.size > 0 }
  }
  private resolve(id: string, state: 'success' | 'cancelled'): void {
    if (this.pending.delete(id)) this.event({ type: 'approval_request', state, payload: { requestId: id, resolved: true } })
  }
  interrupt(): void {
    this.initializing?.abort(new DeepSeekHostError('initialization-cancelled'))
    if (!this.running || this.cancelling) return
    this.cancelling = true
    if (!this.submitted) return
    void this.client?.call('session/cancel', { request: { sessionId: this.nativeSessionId } }).catch(error => this.connectionFailed(error))
    this.cancelTimer = setTimeout(() => this.connectionFailed(new DeepSeekHostError('cancel-unconfirmed')), 10_000)
    this.cancelTimer.unref()
  }
  private finish(state: 'success' | 'failed' | 'cancelled', authRequired = false): void {
    if (!this.running) return
    clearTimeout(this.cancelTimer); this.cancelTimer = undefined
    this.running = false; this.submitted = false
    for (const [id, segment] of this.segments) this.event({ type: segment.type, state, payload: { id, text: segment.text } })
    this.segments.clear()
    for (const id of this.pending.keys()) this.resolve(id, 'cancelled')
    this.finishTurn?.(); this.finishTurn = undefined
    this.emit('done', { nativeSessionId: this.nativeSessionId, failed: state === 'failed', interrupted: state === 'cancelled', authRequired })
  }
  async steer(prompt: string, attachments?: Attachment[]): Promise<{ appendedToTurn: boolean; nativePromptId: string }> {
    if (!this.running || !this.submitted || this.cancelling || this.broken) throw new DeepSeekHostError('cannot-steer')
    const content = await this.content(prompt, attachments), requestId = randomUUID()
    try {
      const result = await this.client!.call<any>('session/prompt', { request: { sessionId: this.nativeSessionId, requestId, mode: 'steer', content } })
      if (result?.accepted !== true) throw new DeepSeekHostError('invalid-prompt-acknowledgement')
    } catch (error) {
      if (error instanceof DeepSeekHostError && ['transport-failed', 'closed', 'invalid-response'].includes(error.code)) this.connectionFailed(error)
      throw error
    }
    return { appendedToTurn: true, nativePromptId: requestId }
  }
  private disconnect(): void {
    this.controller?.abort(); this.controller = undefined
    this.detach?.(); this.detach = undefined
    if (this.client && this.nativeSessionId && owners.get(this.client)?.get(this.nativeSessionId) === this) owners.get(this.client)!.delete(this.nativeSessionId)
    this.client = undefined; this.hub = undefined
  }
  dispose(): void { this.interrupt(); this.finish('cancelled'); this.disposed = true; this.disconnect() }
  async disposeAndWait(): Promise<void> { this.dispose(); await this.ready?.catch(() => {}) }
  async probeSession(_includeMcp = true): Promise<{ nativeSessionId: string; contract: SessionAgentContract }> {
    await this.ensureReady(); return { nativeSessionId: this.nativeSessionId!, contract: structuredClone(this.contract!) }
  }
  async queryUsage(): Promise<TurnUsage | undefined> { return this.usage }
  async getGoal(): Promise<GoalState | undefined> { throw unsupported() }
  async setGoal(_request: { objective: string; tokenBudget?: number; maxRounds?: number }): Promise<GoalState> { throw unsupported() }
  async updateGoal(_request: NativeGoalUpdate): Promise<GoalState | undefined> { throw unsupported() }
  async getSubAgentItems(_id: string, _trusted?: { nativeTaskId: string; parentNativeSessionId: string }): Promise<UAEvent[]> { throw unsupported() }
  async readNativeImage(request: { eventSeq: number; blockIndex: number; toolResult?: boolean; childSessionId?: string }): Promise<string | null> {
    if (request.childSessionId) throw unsupported()
    if (!Number.isSafeInteger(request.eventSeq) || request.eventSeq < 0 || !Number.isSafeInteger(request.blockIndex) || request.blockIndex < 0) throw new DeepSeekHostError('invalid-image-reference')
    await this.ensureReady()
    const page = await this.client!.call<any>('session/page', { request: { address: { kind: 'session', sessionId: this.nativeSessionId }, throughSeq: request.eventSeq, beforeSeq: request.eventSeq + 1, maxMessages: 1 } })
    const event = page.records?.find((row: any) => row.type === 'event' && row.event.seq === request.eventSeq)?.event
    if (event?.type !== (request.toolResult ? 'tool/result' : 'assistant/message')) return null
    const block = event.data?.message?.content?.[request.blockIndex]
    if (block?.type !== 'image' || typeof block.attachment?.attachmentId !== 'string') return null
    const image = await this.client!.call<any>('session/attachment', { request: { sessionId: this.nativeSessionId, attachmentId: block.attachment.attachmentId } })
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image?.attachment?.mediaType) || typeof image.data !== 'string') return null
    return `data:${image.attachment.mediaType};base64,${image.data}`
  }
  async cancelSubAgent(_id: string): Promise<void> { throw unsupported() }
  async inventory(): Promise<unknown> { throw unsupported() }
  async pluginAction(_request: Record<string, unknown>): Promise<any> { throw unsupported() }
}
