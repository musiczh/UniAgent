import { assistantPrompt } from '../assistant/context'
import { EventEmitter } from 'node:events'
import type { HistoryForkPoint, ModelDef, Session, SessionConfig, SessionAgentContract, UAEvent } from '../../shared/types'
import { worktreeInstructions } from '../worktreeService'
import type { ZCodeAttachmentRef, ZCodeDeliveryRecord, ZCodeModelSelection } from '../../shared/zcode'
import type { ZCodeRuntime } from './runtime'
import type { ZCodeLease, ZCodeRuntimePool } from './runtimePool'
import type { ZCodeOwner } from './account'
import { isId, isInteger, isRecord, isZCodeRow, scrubZCodeDiagnostic, zcodeCommandId } from './protocol'
import type { ZCodeAssembledFrame, ZCodeCommand, ZCodeCommandAck, ZCodeRow, ZCodeSnapshot } from './protocol'
import { applyZCodeFrame, findObservedCommand, projectZCodeEvents } from './projection'
import { readZCodeModelCatalog, resolveZCodeSelection, zcodeModelKey, zcodeSessionContract, ZCODE_PERMISSION_VALUES } from './catalog'
import { ZCodeRpcError } from './connection'
import { readZCodeCapabilities } from './capabilities'
import type { GoalState, NativeCapabilitySnapshot, NativeGoalUpdate } from '../../shared/nativeCapabilities'
import { ZCodeCacheStore, sanitizeZCodeSelection, zcodePayloadHash } from './store'
import { sessionStoreWriteCommitted } from '../sessionStore'

interface RunnerOptions {
  session: Session; runtime: ZCodeRuntime; pool: ZCodeRuntimePool; clientId: string; nextSeq(): number; persist(): void
  mcpServers(): Record<string, unknown>[]; cache?: ZCodeCacheStore
}
interface Flight {
  subscriptionId: string; generation: number; epoch?: string; frames: ZCodeAssembledFrame[]; bytes: number
  resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>
}
export interface ZCodeDone { nativeSessionId?: string; commandId?: string; turnId?: string; interrupted: boolean; failed: boolean;
  delivery: 'observed' | 'not-submitted' | 'failed' | 'uncertain'; recovered?: boolean }

export class ZCodeRunner extends EventEmitter {
  private lease?: ZCodeLease
  private owner?: ZCodeOwner
  private state?: ZCodeSnapshot
  private history: ZCodeRow[] = []
  private subscriptionId?: string
  private connectionId?: string
  private flight?: Flight
  private recoveryPromise?: Promise<void>
  private ensurePromise?: Promise<SessionAgentContract>
  private selection: ZCodeModelSelection
  private models: ModelDef[]
  private displayGeneration = 0
  private disposed = false
  private disposePromise?: Promise<void>
  private active?: ZCodeDeliveryRecord
  private completedCommands = new Set<string>()
  private eventHashes = new Map<string, string>()
  private cacheTimer?: ReturnType<typeof setTimeout>
  private turnTimer?: ReturnType<typeof setTimeout>
  private usageStart?: Record<string, number>
  private stopRequested = false
  private finishingCommandId?: string
  private cacheWarning = false
  private unsubscribeListeners?: () => void
  private configTail = Promise.resolve()
  private configuring = false
  private capabilities?: NativeCapabilitySnapshot
  private goalSupported = false
  constructor(private options: RunnerOptions) { super(); this.selection = options.runtime.selection; this.models = options.runtime.models }
  get snapshot(): ZCodeSnapshot | undefined { return this.state }
  get runtime(): ZCodeRuntime { return this.options.runtime }
  get scope() { return this.session.zcodeState }
  isRunning(): boolean { return !!this.active || !!this.flight || this.state?.control.phase === 'running' }
  async refresh(): Promise<void> { await this.ensureSession(); await this.recover(); await this.reconcileDeliveries() }
  private get session(): Session { return this.options.session }
  private get topic(): string { return `conversation/${this.session.nativeSessionId}` }
  private get connection() { if (!this.lease) throw new Error('ZCode lease unavailable'); return this.lease.connection }

  ensureSession(): Promise<SessionAgentContract> {
    if (this.disposed || this.disposePromise) return Promise.reject(new Error('ZCode runner is disposed'))
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensure().catch(async error => {
        this.ensurePromise = undefined
        await this.releaseLease()
        throw error
      })
    }
    return this.ensurePromise
  }
  private async ensure(): Promise<SessionAgentContract> {
    this.selection = resolveZCodeSelection(this.session.config, this.models, this.options.runtime.selection)
    if (this.session.config.additionalDirectories?.length || this.session.config.roleSnapshot?.instructions?.trim()
      || this.session.config.roleSnapshot?.skills || this.session.config.roleSnapshot?.toolPolicy) throw new Error('当前 ZCode 接入不支持额外工作区或角色指令/工具覆盖')
    this.unsubscribeListeners?.(); this.unsubscribeListeners = undefined
    if (this.lease) { await this.lease.release(); this.lease = undefined }
    this.subscriptionId = undefined; this.state = undefined
    const lease = await this.options.pool.acquire(this.options.runtime, this.session.config.workdir, this.session.zcodeState?.workspaceKey)
    if (this.disposed) { await lease.release(); throw new Error('ZCode runner is disposed') }
    this.lease = lease
    const saved = this.session.zcodeState
    if (this.session.zcodeStateInvalid) throw new Error('ZCode 输入账本损坏，会话已保留；请检查本地存储后再恢复，禁止自动重发')
    const identity = { dataRootId: this.options.runtime.config.dataRootId, workspaceKey: lease.workspaceKey, runtimeFingerprint: this.options.runtime.fingerprint }
    if (saved && (saved.dataRootId !== identity.dataRootId || saved.workspaceKey !== identity.workspaceKey)) {
      await lease.release(); this.lease = undefined
      throw new Error('ZCode 会话数据根或工作区身份已变化，禁止向原会话发送输入')
    }
    if (!saved && this.session.nativeSessionId) { await lease.release(); this.lease = undefined; throw new Error('ZCode 原生会话缺少所有权元数据，不能安全恢复') }
    this.session.zcodeState ??= { schemaVersion: 1, ...identity, deliveries: [] }
    if (this.session.config.collaborationMode === 'plan' && !lease.independentPlanState) throw new Error('此 ZCode 运行时不支持独立 Plan 模式')
    const frame = (delivery: ZCodeAssembledFrame) => this.receive(delivery)
    const fault = (error: any) => {
      if (this.disposed) return
      if (error.fatal) { this.failActive('ZCode 引擎连接已断开，输入执行状态需对账'); this.ensurePromise = undefined }
      else if (error.topic === this.topic && error.subscriptionId === this.subscriptionId) {
        void this.recover().catch(() => this.failActive('ZCode 状态恢复失败，已暂停后续输入'))
      }
    }
    lease.connection.on('frame', frame); lease.connection.on('fault', fault)
    this.unsubscribeListeners = () => { lease.connection.off('frame', frame); lease.connection.off('fault', fault) }
    if (!this.session.nativeSessionId) await this.createSession()
    const nativeId = this.session.nativeSessionId!
    const owner = lease.owners.get(nativeId)
    if (owner && owner.uniagentSessionId !== this.session.id) throw new Error('ZCode 会话已属于另一个 UniAgent 会话')
    this.owner = { uniagentSessionId: this.session.id, nativeSessionId: nativeId, confirmed: false }
    lease.owners.set(nativeId, this.owner)
    // Pre-activate before subscribe/read can bind a cold record without MCP descriptors.
    if (saved && !owner) await lease.connection.request('session/resume', { sessionId: nativeId,
      workspace: { workspacePath: this.session.config.workdir, workspaceKey: this.session.config.workdir }, mcpServers: this.options.mcpServers() })
    await this.subscribe()
    await this.readCatalog(this.selection)
    this.capabilities = await readZCodeCapabilities(this.connection, this.session.config.workdir, nativeId, this.options.mcpServers(), lease.independentPlanState)
    this.goalSupported = false
    try {
      await this.connection.request('session/goal', { sessionId: nativeId, action: 'show' })
      this.goalSupported = true
    } catch (error) { if (!(error instanceof ZCodeRpcError && error.code === -32601)) this.capabilities.errors.push('ZCode Goal 状态暂不可读取') }
    await this.reconcileDeliveries()
    // An upgraded engine must successfully restore the same native session and reconcile receipts first.
    this.session.zcodeState.runtimeFingerprint = identity.runtimeFingerprint
    this.options.persist()
    const contract = this.contract()
    this.emit('contract', contract)
    return contract
  }
  private async createSession(): Promise<void> {
    const ledger = this.session.zcodeState!
    let ack: ZCodeCommandAck
    if (ledger.createCommandId) {
      const existing = await this.query(ledger.createCommandId, null)
      if (!existing) throw new Error('ZCode 会话创建结果未知，不能自动重复创建')
      ack = existing
    } else {
      ledger.createCommandId = zcodeCommandId()
      this.options.persist()
      ack = await this.command({ commandId: ledger.createCommandId, clientId: this.options.clientId, sessionId: null,
        type: 'createSession', issuedAt: Date.now(), payload: { workspaceId: this.session.config.workdir,
          config: { mode: this.mode(this.session.config), planEnabled: this.session.config.collaborationMode === 'plan',
            modelSelection: this.selection }, mcpServers: this.options.mcpServers() } })
    }
    if (!['accepted', 'duplicate'].includes(ack.status) || !isId(ack.result?.sessionId)) throw new Error('ZCode 未确认原生会话创建')
    this.emit('nativeSession', { nativeSessionId: ack.result.sessionId })
    this.session.nativeSessionId = ack.result.sessionId
    this.options.persist()
  }
  private mode(config: SessionConfig): 'build' | 'edit' | 'guarded' | 'yolo' {
    if (!config.permissionMode || !Object.hasOwn(ZCODE_PERMISSION_VALUES, config.permissionMode)) throw new Error('ZCode 不支持所选权限模式')
    return ZCODE_PERMISSION_VALUES[config.permissionMode as keyof typeof ZCODE_PERMISSION_VALUES]
  }
  private nativeSelection(): ZCodeModelSelection | undefined {
    const config = this.state?.config
    const selection = sanitizeZCodeSelection(config?.modelSelection) ?? sanitizeZCodeSelection({ providerId: config?.provider, modelId: config?.model })
    if (!selection) return undefined
    const level = typeof config?.thought === 'string' && config.thought ? config.thought : selection.options?.reasoningLevel
    return { providerId: selection.providerId, modelId: selection.modelId, ...(level ? { options: { reasoningLevel: level } } : {}) }
  }
  private contract(): SessionAgentContract {
    return { ...zcodeSessionContract(this.state!, this.selection, this.models), nativeGoal: this.goalSupported,
      commands: this.capabilities?.candidates.filter(candidate => candidate.kind === 'command').map(candidate => candidate.name) ?? [],
      collaborationModes: this.lease?.independentPlanState ? ['default', 'plan'] : ['default'] }
  }
  async discoverCapabilities(): Promise<NativeCapabilitySnapshot> {
    await this.ensureSession()
    this.capabilities = await readZCodeCapabilities(this.connection, this.session.config.workdir, this.session.nativeSessionId, this.options.mcpServers(), this.lease?.independentPlanState)
    this.emit('contract', this.contract())
    this.capabilities.actions.goal = this.goalSupported
    return this.capabilities
  }
  async updateGoal(update: NativeGoalUpdate): Promise<void> {
    await this.ensureSession()
    if (!this.goalSupported || update.tokenBudget !== undefined || update.maxRounds !== undefined || update.reason !== undefined
      || !['pause', 'resume', 'clear'].includes(update.action) || update.objective !== undefined) throw new Error('ZCode Goal 仅支持暂停、继续和清除；不支持精确 Token 预算或轮数限制')
    await this.connection.request('session/goal', { sessionId: this.session.nativeSessionId!, action: update.action })
    await this.recover()
  }
  async forkNative(point?: HistoryForkPoint): Promise<string> {
    await this.ensureSession()
    const rows = [...this.history, ...this.state!.rows.window]
    let target: { rowId: number; entityId: string } | undefined
    if (point) {
      try { target = JSON.parse(point.nativeId) } catch { throw new Error('ZCode 分叉位置无效') }
    }
    const row = rows.findLast(row => row.kind === 'assistantText' && row.state === 'complete' && isId(row.entityId)
      && (!target || row.rowId === target.rowId && row.entityId === target.entityId)
      && rows.some(turn => turn.kind === 'turnHeader' && turn.turnId === row.turnId && turn.state !== 'running'))
    if (!row) throw new Error('ZCode 尚无可分叉的完整回复，请先完成一轮对话')
    const ack = await this.command({ commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
      type: 'forkAssistant', payload: { target: { rowId: row.rowId, entityId: row.entityId } }, issuedAt: Date.now(),
      baseRevision: this.state!.revision, baseLogEpoch: this.state!.logEpoch })
    if (!['accepted', 'duplicate'].includes(ack.status) || !isId(ack.result?.sessionId) || ack.result.sessionId === this.session.nativeSessionId) throw new Error('ZCode 未确认独立分叉会话')
    // Cold activation rebinds MCP descriptors to the new UniAgent caller before subscribing.
    await this.connection.request('session/close', { sessionId: ack.result.sessionId })
    return ack.result.sessionId
  }
  async forkSideNative(): Promise<string> {
    await this.ensureSession()
    const ack = await this.command({ commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
      type: 'createSelectionSideSession', payload: {}, issuedAt: Date.now() })
    if (!['accepted', 'duplicate'].includes(ack.status) || !isId(ack.result?.sessionId) || ack.result.sessionId === this.session.nativeSessionId) throw new Error('ZCode 未确认独立侧边会话')
    await this.connection.request('session/close', { sessionId: ack.result.sessionId })
    return ack.result.sessionId
  }
  async closeNative(nativeSessionId: string): Promise<void> { await this.connection.request('session/close', { sessionId: nativeSessionId }) }
  private async readCatalog(expected: ZCodeModelSelection): Promise<void> {
    const catalog = await readZCodeModelCatalog(this.connection, this.session.nativeSessionId!, expected, this.models)
    if (expected.options?.reasoningLevel && catalog.selection.options?.reasoningLevel !== expected.options.reasoningLevel) throw new Error('ZCode 未确认思考深度变更')
    if (expected.options?.reasoningLevel && this.state?.config.thought && this.state.config.thought !== expected.options.reasoningLevel) throw new Error('ZCode 原生快照未确认思考深度变更')
    this.models = catalog.models; this.selection = catalog.selection
  }
  private command(envelope: ZCodeCommand): Promise<ZCodeCommandAck> {
    return this.connection.request<ZCodeCommandAck>('v4/command', envelope).then(ack => {
      if (!isRecord(ack) || ack.commandId !== envelope.commandId || !['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed'].includes(ack.status)
        || !isInteger(ack.revisionAtDecision)) throw new Error('ZCode invalid command ACK')
      if (ack.reasonCode === 'fault.command.queryUnavailable') throw new Error('ZCode command status is unavailable')
      return ack
    })
  }
  private async query(commandId: string, sessionId: string | null): Promise<ZCodeCommandAck | undefined> {
    const response = await this.connection.request<any>('v4/commands/query', { commands: [{ sessionId, commandId }] })
    const item = response?.results?.find((entry: any) => entry.key?.commandId === commandId && entry.key.sessionId === sessionId)
    if (item?.result === 'unknown') return undefined
    if (!isRecord(item?.result) || item.result.commandId !== commandId) throw new Error('ZCode command query unavailable')
    if (item.result.reasonCode === 'fault.command.queryUnavailable') throw new Error('ZCode command query unavailable')
    return item.result as ZCodeCommandAck
  }
  private async subscribe(): Promise<void> {
    if (this.subscriptionId) this.connection.forgetRoute(this.topic, this.subscriptionId)
    this.subscriptionId = undefined; this.connectionId = zcodeCommandId()
    const result = await this.connection.request<any>('v4/conversation/subscribe', { topic: this.topic, connectionId: this.connectionId,
      clientMode: 'desktop-continuous', workspace: { workspacePath: this.session.config.workdir, workspaceKey: this.session.config.workdir } })
    const ack = result?.ack
    if (!isId(ack?.subscriptionId) || !isId(ack.logEpoch) || ack.mode !== 'snapshot') throw new Error('ZCode invalid subscription ACK')
    this.subscriptionId = ack.subscriptionId
    const completed = this.beginFlight(ack.subscriptionId, ack.logEpoch)
    const pending = this.connection.drainFrames(this.topic, ack.subscriptionId)
    for (const delivery of pending) this.receive(delivery)
    await completed
  }
  private beginFlight(subscriptionId: string, epoch?: string): Promise<void> {
    if (this.flight) { clearTimeout(this.flight.timer); this.flight.reject(new Error('ZCode recovery superseded')) }
    return new Promise((resolve, reject) => {
      const flight: Flight = { subscriptionId, generation: this.lease!.generation, epoch, frames: [], bytes: 0, resolve, reject,
        timer: setTimeout(() => {
          if (this.flight !== flight) return
          this.flight = undefined; reject(new Error('ZCode recovery timed out'))
        }, 15_000) }
      this.flight = flight
    })
  }
  private receive(delivery: ZCodeAssembledFrame): void {
    if (this.disposed || delivery.frame.topic !== this.topic) return
    if (!this.subscriptionId) return // Connection buffers unbound routes until the subscribe ACK.
    if (delivery.frame.subscriptionId !== this.subscriptionId) return
    const flight = this.flight
    if (flight) {
      if (flight.generation !== this.lease?.generation || flight.subscriptionId !== this.subscriptionId) return
      if (!flight.epoch) {
        flight.bytes += Buffer.byteLength(JSON.stringify(delivery))
        if (flight.frames.length >= 32 || flight.bytes > 16 * 1024 * 1024) { flight.reject(new Error('ZCode recovery frame budget exceeded')); clearTimeout(flight.timer); this.flight = undefined }
        else flight.frames.push(delivery)
        return
      }
      if (delivery.deliveryKind === 'online') return
      const frame = delivery.frame
      const aligned = frame.payload.kind === 'deltas' && frame.fromSeq === frame.toSeq && frame.toSeq === this.state?.seq && this.state?.logEpoch === flight.epoch
      const result = applyZCodeFrame(this.state, delivery)
      if (frame.payload.kind === 'snapshot' && frame.payload.snapshot.logEpoch !== flight.epoch) return
      if (!aligned && result.kind !== 'applied') return
      if (result.kind === 'applied') this.apply(result.state, true)
      clearTimeout(flight.timer); this.flight = undefined
      if (this.owner && this.lease?.owners.get(this.session.nativeSessionId!) === this.owner) this.owner.confirmed = true
      else { flight.reject(new Error('ZCode session owner changed')); return }
      flight.resolve()
      this.observeActive()
      return
    }
    if (delivery.frame.payload.kind === 'snapshot' && this.state && delivery.frame.payload.snapshot.logEpoch !== this.state.logEpoch) {
      void this.recover().catch(() => this.failActive('ZCode 会话代次变化，状态恢复失败'))
      return
    }
    const result = applyZCodeFrame(this.state, delivery)
    if (result.kind === 'resync') { void this.recover().catch(() => this.failActive('ZCode 状态不一致，已暂停输入')); return }
    if (result.kind === 'applied') { this.apply(result.state, result.reset); this.observeActive() }
  }
  private apply(state: ZCodeSnapshot, reset: boolean): void {
    if (this.state && this.state.logEpoch !== state.logEpoch) { this.history = []; reset = true }
    if (reset && this.state && state.revision !== this.state.revision) this.history = []
    this.state = state
    this.emitProjection(reset)
    this.scheduleCache()
    this.emit('state', { phase: state.control.phase, pendingInteractions: state.pendingInteractions.length, canStop: state.control.canStop })
    const goal = state.goal
    const worktreePrefix = worktreeInstructions(this.session.config)
    const cumulative = state.usage?.cumulative
    const verification = goal?.verifications?.at(-1)
    const verificationFailed = ['verified', 'failed'].includes(goal?.status) && verification?.outcome === 'failed'
    const normalized: GoalState | undefined = isRecord(goal) && typeof goal.objective === 'string' && goal.objective.length > 0 ? {
      objective: worktreePrefix && goal.objective.startsWith(worktreePrefix + '\n\n') ? goal.objective.slice(worktreePrefix.length + 2) : goal.objective, status: verificationFailed ? 'blocked' : goal.status === 'verified' ? 'complete' : goal.status === 'paused' ? 'paused' : goal.status === 'failed' ? 'blocked' : 'active',
      tokenBudget: null, tokensUsed: Math.max(0, Number(cumulative?.inputTokens) || 0) + Math.max(0, Number(cumulative?.outputTokens) || 0),
      timeUsedSeconds: Math.max(0, Number(goal.timeUsedSeconds) || 0), createdAt: state.meta?.createdAt ?? 0, updatedAt: state.meta?.updatedAt ?? 0,
      continuation: 'native', autonomous: ['active', 'verifying'].includes(goal.status), nativeActivation: ['active', 'verifying'].includes(goal.status) ? 'armed' : 'disarmed',
      ...(verificationFailed ? { blockedReason: { code: 'zcode_goal_verification_failed', message: scrubZCodeDiagnostic(String(verification.reason ?? 'ZCode Goal 验证失败')) } } : {})
    } : undefined
    this.emit('goalChanged', normalized)
  }
  private emitProjection(reset: boolean): void {
    if (!this.state) return
    if (reset) { this.displayGeneration++; this.eventHashes.clear() }
    const rows = [...new Map([...this.history, ...this.state.rows.window].map(row => [row.rowId, row])).values()].sort((a, b) => a.rowId - b.rowId)
    const events = projectZCodeEvents(this.state, { sessionId: this.session.id, generation: this.displayGeneration, nextSeq: this.options.nextSeq }, rows)
      .map(event => {
        const receipt = this.session.zcodeState?.deliveries.find(record => record.commandId === event.payload.sourceCommandId)
        if (event.type !== 'user_message' || !receipt) return event
        if (receipt.submission.text.startsWith('/goal ')) return { ...event, type: 'goal_message' as const,
          payload: { ...event.payload, text: receipt.submission.text.slice(6).trim(), command: 'goal' } }
        return (this.session.config.worktree || this.session.config.workspaceNotice || this.session.config.assistantSnapshot) ? { ...event, payload: { ...event.payload, text: receipt.submission.text } } : event
      })
    if (reset) {
      for (const event of events) { const payload = { ...event.payload }; delete payload.nativeSeq
        this.eventHashes.set(`${event.type}:${event.payload.id}`, zcodePayloadHash({ type: event.type, state: event.state, payload })) }
      this.emit('eventsReset', events)
    } else for (const event of events) {
      const key = `${event.type}:${event.payload.id}`
      const payload = { ...event.payload }; delete payload.nativeSeq
      const hash = zcodePayloadHash({ type: event.type, state: event.state, payload })
      if (this.eventHashes.get(key) !== hash) { this.eventHashes.set(key, hash); this.emit('event', event) }
    }
  }
  private recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.recoverOnce().catch(async () => { await this.subscribe() }).finally(() => { this.recoveryPromise = undefined })
    return this.recoveryPromise
  }
  private async recoverOnce(): Promise<void> {
    if (!this.subscriptionId || !this.connectionId) throw new Error('ZCode subscription unavailable')
    const completed = this.beginFlight(this.subscriptionId)
    // Attach a rejection handler while waiting for the RPC ACK.
    void completed.catch(() => undefined)
    try {
      const result = await this.connection.request<any>('v4/conversation/resync', { topic: this.topic, subscriptionId: this.subscriptionId,
        connectionId: this.connectionId, base: null, forceSnapshot: true }, 15_000)
      const flight = this.flight
      if (!flight || result?.ack?.subscriptionId !== flight.subscriptionId || !isId(result.ack.logEpoch) || result.ack.mode !== 'snapshot') throw new Error('ZCode recovery ACK mismatch')
      flight.epoch = result.ack.logEpoch
      const buffered = flight.frames; flight.frames = []; flight.bytes = 0
      for (const delivery of buffered) this.receive(delivery)
      await completed
    } catch (error) {
      if (this.flight) { clearTimeout(this.flight.timer); this.flight.reject(error as Error); this.flight = undefined }
      throw error
    }
  }
  prepare(queueItemId: string, text: string, attachments: ZCodeAttachmentRef[] = []): ZCodeDeliveryRecord {
    if (this.disposed || this.disposePromise) throw new Error('ZCode 会话已关闭')
    if (!this.state || this.flight || this.active || this.configuring || this.session.zcodeState?.deliveries.some(record => record.phase === 'uncertain')) throw new Error('ZCode 尚未就绪或存在待对账输入')
    if (this.state.inputRouting?.mode !== 'startNow' || !['idle', 'draft', 'completedSuccess', 'completedInterrupted', 'error'].includes(this.state.control.phase)) throw new Error('ZCode 当前不能开始新任务')
    const actual = this.nativeSelection()
    if (actual && zcodePayloadHash(actual) !== zcodePayloadHash(this.selection)) throw new Error('ZCode 原生模型配置已变化，请重新选择模型与思考深度后再发送')
    if (!text.trim() && !attachments.length || Buffer.byteLength(text) > 512 * 1024) throw new Error('ZCode 输入为空或过大')
    if (text.startsWith('/goal ') && (!this.goalSupported || this.session.config.collaborationMode === 'plan')) throw new Error('ZCode Goal 不可用，或当前处于 Plan 模式')
    if ((text.trim() === '/compact' || text.startsWith('/goal ')) && attachments.length) throw new Error('ZCode 原生 Goal 和压缩命令不支持附件')
    const previous = this.session.zcodeState!.deliveries
    const latest = new Map(previous.map(record => [record.queueItemId, record.commandId]))
    const queued = new Set(this.session.pendingQueue?.map(item => item.id) ?? [])
    const kept = previous.filter((record, index) => index >= previous.length - 100
      || ['prepared', 'sent', 'acknowledged', 'uncertain'].includes(record.phase)
      || queued.has(record.queueItemId) && latest.get(record.queueItemId) === record.commandId)
    if (kept.length >= 1024) throw new Error('ZCode 待核对输入过多，请先处理已有队列')
    const submission = { text, modelSelection: structuredClone(this.selection), mode: this.mode(this.session.config), planEnabled: this.session.config.collaborationMode === 'plan',
      ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) }
    const record: ZCodeDeliveryRecord = { queueItemId, commandId: zcodeCommandId(), nativeSessionId: this.session.nativeSessionId,
      phase: 'prepared', issuedAt: Date.now(), payloadHash: zcodePayloadHash(submission), submission }
    this.session.zcodeState!.deliveries = [...kept, record]
    try { this.options.persist() } catch (error) {
      if (!sessionStoreWriteCommitted(error)) this.session.zcodeState!.deliveries = previous
      throw error
    }
    this.emit('delivery', record)
    return record
  }
  async submit(record: ZCodeDeliveryRecord): Promise<ZCodeCommandAck> {
    if (this.disposed || this.disposePromise || !this.state || this.flight || this.active || record.phase !== 'prepared' || record.nativeSessionId !== this.session.nativeSessionId
      || this.session.zcodeState?.deliveries.find(item => item.commandId === record.commandId) !== record || zcodePayloadHash(record.submission) !== record.payloadHash) throw new Error('ZCode 输入记录无效或状态尚未确认')
    this.active = record
    this.usageStart = { ...this.state.usage?.cumulative }
    record.phase = 'sent'
    try { this.options.persist() } catch (error) {
      if (!sessionStoreWriteCommitted(error)) record.phase = 'prepared'
      this.active = undefined
      throw error
    }
    this.session.zcodeState!.suspendedAfterStop = false
    this.emit('delivery', record)
    this.turnTimer = setTimeout(() => {
      void this.recover().then(() => { if (this.active === record) this.failActive('ZCode 长时间未确认任务状态，已暂停；请检查原生引擎') })
        .catch(() => this.failActive('ZCode 任务状态查询失败，已暂停'))
    }, 180_000)
    try {
      const compact = record.submission.text.trim() === '/compact'
      const goal = record.submission.text.startsWith('/goal ')
      const text = goal ? record.submission.text.slice(6).trim() : record.submission.text
      const effectiveText = !goal && text.trimStart().startsWith('/') ? text : await assistantPrompt(this.session.id, this.session.config, text, worktreeInstructions(this.session.config))
      if (this.disposed || this.active !== record || this.session.zcodeState?.suspendedAfterStop) throw new Error('ZCode 输入已取消')
      const ack = await this.command({ commandId: record.commandId, clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
        type: compact ? 'compact' : goal ? 'sendGoalCommand' : 'sendText', payload: compact ? {} : goal
          ? { ...structuredClone(record.submission), text: effectiveText, displayText: record.submission.text }
          : { ...structuredClone(record.submission), text: effectiveText }, issuedAt: record.issuedAt })
      record.ackStatus = ack.status
      if (['accepted', 'duplicate'].includes(ack.status)) {
        if (record.phase === 'sent') record.phase = 'acknowledged'
        this.options.persist(); this.emit('delivery', record); this.observeActive()
      } else {
        record.phase = 'failed'; this.options.persist(); this.emit('delivery', record)
        this.complete({ commandId: record.commandId, interrupted: false, failed: true, delivery: ack.status === 'failed' ? 'failed' : 'not-submitted' })
      }
      return ack
    } catch (error) { this.failActive('ZCode 输入回执未确认，已暂停自动发送'); throw error }
  }
  private observeActive(): void {
    const record = this.active
    if (!record || !this.state) return
    if (this.stopRequested && this.state.control.canStop) {
      this.stopRequested = false
      void this.interrupt().catch(() => this.failActive('ZCode 停止未确认，输入保持暂停'))
    }
    const observed = findObservedCommand(this.state, record.commandId)
    if (!observed) return
    if (this.turnTimer && !this.session.zcodeState?.suspendedAfterStop) { clearTimeout(this.turnTimer); this.turnTimer = undefined }
    if (record.phase !== 'observed') { record.phase = 'observed'; record.turnId = observed.row.turnId; this.options.persist(); this.emit('delivery', record) }
    if (observed.turn && observed.turn.state !== 'running') {
      if (observed.turn.state === 'failed') { record.phase = 'failed'; this.options.persist(); this.emit('delivery', record) }
      if (this.finishingCommandId === record.commandId) return
      this.finishingCommandId = record.commandId
      const turn = observed.turn
      void this.readFileChanges(turn).then(() => {
        if (!this.disposed && this.active === record) this.complete({ commandId: record.commandId, turnId: turn.turnId,
          interrupted: turn.state === 'completedInterrupted', failed: turn.state === 'failed', delivery: 'observed' })
      }).catch(() => this.failActive('ZCode 完成状态保存失败，已暂停后续输入'))
    }
  }
  private complete(result: Omit<ZCodeDone, 'nativeSessionId'>): void {
    if (result.commandId && this.completedCommands.has(result.commandId)) return
    if (result.commandId && result.delivery !== 'uncertain') {
      this.completedCommands.add(result.commandId)
      if (this.completedCommands.size > 128) this.completedCommands.delete(this.completedCommands.values().next().value!)
    }
    const cumulative = this.state?.usage?.cumulative
    const start = this.usageStart
    if (start && isRecord(cumulative) && result.delivery === 'observed') {
      const count = (key: string) => Math.max(0, Number(cumulative[key]) || 0)
      const delta = (key: string) => Math.max(0, count(key) - (Number(start[key]) || 0))
      this.emit('event', { sessionId: this.session.id, seq: this.options.nextSeq(), ts: Date.now(), type: 'system_notice',
        payload: { id: `zcode:usage:${result.commandId}`, kind: 'usage', turnId: result.turnId, zcodeProjection: false,
          usage: { inputTokens: delta('inputTokens'), outputTokens: delta('outputTokens'), cachedInputTokens: delta('cacheReadTokens'),
            cacheCreationInputTokens: delta('cacheWriteTokens'), modelId: this.selection.modelId,
            sessionInputTokens: count('inputTokens'), sessionOutputTokens: count('outputTokens'), sessionCachedInputTokens: count('cacheReadTokens'),
            contextTokens: this.state?.usage?.contextWindow?.usedTokens, contextWindow: this.state?.usage?.contextWindow?.maxTokens } } } as UAEvent)
    }
    this.usageStart = undefined
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = undefined; this.active = undefined; this.finishingCommandId = undefined
    this.flushCache()
    this.emit('done', { nativeSessionId: this.session.nativeSessionId, ...result })
  }
  private failActive(message: string): void {
    const active = this.active
    if (active) {
      active.phase = 'uncertain'
      try { this.options.persist(); this.emit('delivery', active) } catch { message += '；输入状态保存失败，重启后仍需核对原生会话' }
    }
    this.emit('event', { sessionId: this.session.id, seq: this.options.nextSeq(), ts: Date.now(), type: 'error', state: 'failed',
      payload: { message, zcodeProjection: false } } as UAEvent)
    if (active) this.complete({ commandId: active.commandId, interrupted: false, failed: true, delivery: 'uncertain' })
    else this.emit('state', { phase: 'error', pendingInteractions: 0, canStop: false })
  }
  private async reconcileDeliveries(): Promise<void> {
    for (const record of this.session.zcodeState!.deliveries) {
      if (!this.session.pendingQueue?.some(item => item.id === record.queueItemId)) continue
      if (this.session.zcodeState!.deliveries.filter(item => item.queueItemId === record.queueItemId).at(-1) !== record) continue
      if (record.phase === 'failed') continue
      const observed = await this.findDelivery(record).catch(() => undefined)
      if (observed) {
        record.phase = 'observed'; record.turnId = observed.row.turnId
        if (observed.turn?.state === 'failed') record.phase = 'failed'
        this.options.persist(); this.emit('delivery', record)
        if (observed.turn && observed.turn.state !== 'running') {
          this.complete({ commandId: record.commandId, turnId: observed.turn.turnId, interrupted: observed.turn.state === 'completedInterrupted',
            failed: observed.turn.state === 'failed', delivery: 'observed', recovered: true })
        } else if (!this.active) this.active = record
        continue
      }
      if (record.phase === 'prepared') continue
      try {
        const ack = await this.query(record.commandId, record.nativeSessionId ?? this.session.nativeSessionId!)
        record.ackStatus = ack?.status
        if (ack && ['failed', 'rejected', 'stale', 'noop'].includes(ack.status)) record.phase = 'failed'
        else record.phase = 'uncertain'
      } catch { record.phase = 'uncertain' }
      this.emit('delivery', record)
    }
    this.options.persist()
    if (this.session.zcodeState!.deliveries.some(record => record.phase === 'uncertain')) this.emit('state', { phase: 'error', pendingInteractions: 0, canStop: false })
  }
  private async findDelivery(record: ZCodeDeliveryRecord): Promise<ReturnType<typeof findObservedCommand>> {
    const base = this.state!
    const found = findObservedCommand(base, record.commandId)
    if (found?.turn || record.phase === 'prepared') return found
    let rows = [...base.rows.window]
    let beforeRowId = rows[0]?.rowId
    // Bounded cold reconciliation; older receipts stay uncertain rather than being replayed.
    for (let page = 0; page < 5 && beforeRowId !== undefined && base.rows.firstRowId !== null && beforeRowId > base.rows.firstRowId; page++) {
      const result = await this.connection.request<any>('v4/conversation/rowsRange', { sessionId: base.sessionId,
        clientMode: 'desktop-continuous', limit: 200, beforeRowId })
      if (this.state?.logEpoch !== base.logEpoch || this.state.revision !== base.revision || this.state.seq !== base.seq
        || result.atLogEpoch !== base.logEpoch || result.atRevision !== base.revision || result.atSeq !== base.seq
        || !Array.isArray(result.rows) || !result.rows.every(isZCodeRow)) return undefined
      const older = result.rows.filter((row: ZCodeRow) => row.rowId < beforeRowId!)
      if (!older.length) return undefined
      rows = [...older, ...rows]
      if (Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024) return undefined
      const observed = findObservedCommand({ ...base, rows: { ...base.rows, window: rows } }, record.commandId)
      if (observed?.turn) return observed
      beforeRowId = older[0].rowId
      if (!result.hasMore) break
    }
    return undefined
  }
  async interrupt(): Promise<void> {
    const active = this.active
    this.session.zcodeState!.suspendedAfterStop = true; this.options.persist()
    if (!this.state?.control.canStop) {
      this.stopRequested = !!active
      if (active && !this.turnTimer) this.turnTimer = setTimeout(() => this.failActive('ZCode 尚未提供停止目标，输入保持暂停'), 10_000)
      return
    }
    this.stopRequested = false
    const execution = this.state.control.activeWorks?.find((work: any) => isId(work.foregroundExecutionId))?.foregroundExecutionId
    const ack = await this.command({ commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!, type: 'stop',
      payload: execution ? { expectedForegroundExecutionId: execution } : {}, issuedAt: Date.now() })
    if (!['accepted', 'noop', 'duplicate'].includes(ack.status)) throw new Error('ZCode 未接受停止请求')
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => {
      void this.recover().then(() => { if (this.active === active) this.failActive('尚未确认 ZCode 已停止，后续输入保持暂停') })
        .catch(() => this.failActive('尚未确认 ZCode 已停止，后续输入保持暂停'))
    }, 10_000)
  }
  async respondResult(interactionId: string, answer: unknown): Promise<{ handled: boolean; hasPendingRequests: boolean }> {
    if (this.disposed || this.disposePromise || !this.state || this.flight || !this.connection.connected) throw new Error('ZCode 当前无法回答请求')
    const interaction = this.state.pendingInteractions.find(item => item.interactionId === interactionId)
    if (!interaction || interaction.payload?.sensitive || interaction.kind === 'workspaceHookReview') throw new Error('ZCode 请求已失效或需要原生安全渠道')
    // Recovery removes the pending interaction; keep the original card for its terminal event.
    const request = projectZCodeEvents(this.state, { sessionId: this.session.id, generation: this.displayGeneration, nextSeq: () => 0 })
      .find(event => event.type === 'approval_request' && event.payload.requestId === interactionId)
    const payload = interaction.payload
    if (!isRecord(answer)) throw new Error('ZCode 回答格式无效')
    let native: Record<string, unknown>
    if (interaction.kind === 'permission') {
      if (typeof answer.optionId !== 'string' || !payload.options?.some((option: any) => option.optionId === answer.optionId)) throw new Error('请选择 ZCode 实际提供的权限选项')
      native = { optionId: answer.optionId }
    } else {
      if (!['accept', 'decline', 'cancel'].includes(answer.action)) throw new Error('ZCode 回答动作无效')
      native = { action: answer.action }
      if (answer.action === 'accept') {
        if (!isRecord(answer.content) || !isRecord(answer.content.answers) || !Array.isArray(payload.questions)) throw new Error('ZCode 问题内容无效')
        const names = new Set<string>()
        const values: Record<string, string | string[]> = {}
        for (const question of payload.questions) {
          if (names.has(question.question)) throw new Error('ZCode 重复题目文本无法无损回答')
          names.add(question.question)
          const value = answer.content.answers[question.question]
          const chosen = Array.isArray(value) ? value : [value]
          if (!chosen.length || chosen.some(item => typeof item !== 'string' || !item.trim()) || (!question.multiSelect && chosen.length > 1)
            || (!payload.freeText && chosen.some(item => !question.options?.some((option: any) => option.value === item)))) throw new Error('请完整填写 ZCode 问题')
          values[question.question] = question.multiSelect ? chosen : chosen[0]
        }
        native.content = { answers: values }
      }
    }
    const ack = await this.command({ commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
      type: 'resolveInteraction', payload: { interactionId, answer: native }, issuedAt: Date.now() })
    if (!['accepted', 'noop', 'duplicate'].includes(ack.status)) throw new Error('ZCode 未接受回答')
    await this.recover()
    this.emit('event', { sessionId: this.session.id, seq: this.options.nextSeq(), ts: Date.now(), type: 'approval_request', state: 'success',
      payload: { ...request?.payload, id: request?.payload.id ?? `zcode:${this.state.sessionId}:${this.state.logEpoch}:interaction:${interactionId}`, requestId: interactionId,
        resolved: true, zcodeProjection: false, submittedAnswer: answer } } as UAEvent)
    return { handled: true, hasPendingRequests: this.state.pendingInteractions.length > 0 }
  }
  updateConfig(config: SessionConfig): Promise<SessionAgentContract> {
    const requested = structuredClone(config)
    const operation = this.configTail.then(async () => {
      this.configuring = true
      try { return await this.applyConfig(requested) } finally { this.configuring = false }
    })
    this.configTail = operation.then(() => undefined, () => undefined)
    return operation
  }
  async flushConfig(): Promise<void> { await this.configTail }
  private async applyConfig(config: SessionConfig): Promise<SessionAgentContract> {
    await this.ensureSession()
    if (!this.state || this.flight || this.active || this.state.control.phase === 'running' || this.state.pendingInteractions.length) throw new Error('ZCode 正在执行，配置应在下一轮应用')
    if (config.workdir !== this.session.config.workdir || config.additionalDirectories?.length || config.fastMode || config.maxMode
      || config.roleSnapshot?.instructions?.trim() || config.roleSnapshot?.skills || config.roleSnapshot?.toolPolicy) throw new Error('当前 ZCode 不支持所选工作区、角色覆盖或高级模型参数')
    if (config.collaborationMode === 'plan' && !this.lease?.independentPlanState) throw new Error('此 ZCode 运行时不支持独立 Plan 模式')
    const selection = resolveZCodeSelection(config, this.models, this.selection)
    if (zcodePayloadHash(selection) !== zcodePayloadHash(this.nativeSelection() ?? this.selection)) {
      const envelope: ZCodeCommand = { commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
        type: 'switchModelConfig', payload: { provider: selection.providerId, model: selection.modelId, thought: selection.options?.reasoningLevel ?? '' },
        issuedAt: Date.now(), baseRevision: this.state.revision, baseLogEpoch: this.state.logEpoch }
      try {
        const ack = await this.command(envelope)
        if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) throw new Error('ZCode 未接受模型变更，请刷新后重试')
      } catch (error) {
        if (error instanceof ZCodeRpcError && error.code === -32601) throw new Error('此 ZCode 运行时缺少原生模型切换接口，请使用支持 v4 模型配置的版本')
        throw error
      }
      await this.recover()
      await this.readCatalog(selection)
      this.session.config = { ...this.session.config, model: zcodeModelKey(this.selection), zcodeModelSelection: this.selection,
        effort: this.models.find(model => model.id === zcodeModelKey(this.selection))?.efforts.find(level => level === this.selection.options?.reasoningLevel) }
      this.options.persist()
      this.emit('contract', this.contract())
    }
    const mode = this.mode(config)
    if (this.state.config.mode !== mode) {
      const generation = this.lease!.generation, epoch = this.state.logEpoch, subscription = this.subscriptionId
      const envelope = { commandId: zcodeCommandId(), clientId: this.options.clientId, sessionId: this.session.nativeSessionId!,
        type: 'switchCollaborationMode', payload: { mode }, issuedAt: Date.now(), baseRevision: this.state.revision, baseLogEpoch: epoch }
      if (generation !== this.lease?.generation || epoch !== this.state.logEpoch || subscription !== this.subscriptionId) throw new Error('ZCode 配置来源已过期')
      const ack = await this.command(envelope)
      if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) { await this.recover(); throw new Error('ZCode 配置已变化，请重新应用') }
      await this.recover()
      if (this.state.config.mode !== mode) throw new Error('ZCode 未确认模式变更')
    }
    const contract = this.contract()
    if (contract.currentPermissionMode) this.session.config.permissionMode = contract.currentPermissionMode
    this.options.persist()
    return contract
  }
  async loadEarlier(beforeRowId?: number): Promise<{ hasMore: boolean }> {
    await this.ensureSession()
    const base = this.state!
    const cursor = beforeRowId ?? this.history[0]?.rowId ?? base.rows.window[0]?.rowId
    const result = await this.connection.request<any>('v4/conversation/rowsRange', { sessionId: base.sessionId, clientMode: 'desktop-continuous',
      limit: 200, ...(cursor !== undefined ? { beforeRowId: cursor } : {}) })
    if (this.state?.logEpoch !== base.logEpoch || this.state.revision !== base.revision || result.atLogEpoch !== base.logEpoch
      || result.atSeq !== base.seq || result.atRevision !== base.revision || !Array.isArray(result.rows) || !result.rows.every(isZCodeRow)) throw new Error('ZCode 历史页来源已变化，请重试')
    const history = [...new Map([...this.history, ...result.rows].map(row => [row.rowId, row])).values()].sort((a, b) => a.rowId - b.rowId)
    if (history.length > 1000 || Buffer.byteLength(JSON.stringify(history)) > 8 * 1024 * 1024) throw new Error('ZCode 历史页超过显示限制')
    this.history = history
    this.emitProjection(true); this.scheduleCache()
    return { hasMore: result.hasMore === true }
  }
  private async readFileChanges(turn: ZCodeRow): Promise<void> {
    if (!turn.entityId || !this.state || !turn.fileChanges?.files) return
    const base = this.state
    try {
      const result = await this.connection.request<any>('v4/conversation/fileChanges', { sessionId: base.sessionId, target: { rowId: turn.rowId, entityId: turn.entityId },
        baseRevision: base.revision, baseLogEpoch: base.logEpoch })
      if (this.state?.logEpoch !== base.logEpoch || this.state.revision !== base.revision || !Array.isArray(result.items)) return
      const changes = result.items.map((item: any) => ({ path: item.path, kind: 'update', additions: item.additions, deletions: item.deletions }))
      const diff = result.items.map((item: any) => `--- a/${item.path}\n+++ b/${item.path}\n${item.patches.map((hunk: any) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n')}`).join('\n')
      for (const type of ['file_change', 'diff_update'] as const) this.emit('event', { sessionId: this.session.id, seq: this.options.nextSeq(), ts: turn.endedAt ?? turn.createdAt,
        type, state: 'success', payload: { id: `zcode:${base.sessionId}:${base.logEpoch}:files:${turn.rowId}`, turnId: turn.turnId, changes, diff,
          zcodeProjection: true, projectionGeneration: this.displayGeneration, nativeLogEpoch: base.logEpoch } } as UAEvent)
    } catch { /* The native tool rows still show changes; stale summaries are discarded. */ }
  }
  private scheduleCache(): void {
    if (this.cacheTimer || !this.options.cache) return
    this.cacheTimer = setTimeout(() => { this.cacheTimer = undefined; this.flushCache() }, 250)
  }
  private flushCache(): void {
    if (!this.options.cache || !this.state || !this.lease) return
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = undefined
    const identity = { nativeSessionId: this.state.sessionId, workspaceKey: this.lease.workspaceKey,
      dataRootId: this.options.runtime.config.dataRootId, runtimeFingerprint: this.options.runtime.fingerprint }
    try {
      if (!this.state.pendingInteractions.length) this.options.cache.save(this.session.id, 'checkpoint', identity, this.state)
      this.options.cache.save(this.session.id, 'display', identity, { rows: [...this.history, ...this.state.rows.window], logEpoch: this.state.logEpoch })
    } catch {
      if (!this.cacheWarning) { this.cacheWarning = true; this.emit('event', { sessionId: this.session.id, seq: this.options.nextSeq(), ts: Date.now(), type: 'system_notice',
        payload: { text: 'ZCode 显示缓存未保存，下次将重新读取原生快照。', kind: 'warning' } } as UAEvent) }
    }
  }
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce()
    return this.disposePromise
  }
  private async disposeOnce(): Promise<void> {
    await this.ensurePromise?.catch(() => undefined)
    await this.configTail
    if (this.state?.control.canStop || this.active) {
      await this.interrupt().catch(() => undefined)
      if (this.active) await new Promise<void>(resolve => {
        const finished = () => { clearTimeout(timer); this.off('done', finished); resolve() }
        const timer = setTimeout(finished, 10_000)
        this.once('done', finished)
      })
    }
    this.disposed = true
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.flight) { clearTimeout(this.flight.timer); this.flight.reject(new Error('ZCode runner disposed')); this.flight = undefined }
    this.flushCache()
    await this.releaseLease()
  }
  private async releaseLease(): Promise<void> {
    this.unsubscribeListeners?.(); this.unsubscribeListeners = undefined
    const lease = this.lease, owner = this.owner, nativeId = this.session.nativeSessionId
    const subscriptionId = this.subscriptionId, connectionId = this.connectionId, topic = this.topic
    if (lease) {
      if (subscriptionId && connectionId && lease.connection.connected) {
        await lease.connection.request('v4/conversation/unsubscribe', { topic, subscriptionId, connectionId }, 5000).catch(() => undefined)
        lease.connection.forgetRoute(topic, subscriptionId)
      }
      if (nativeId && owner && lease.owners.get(nativeId) === owner) lease.owners.delete(nativeId)
      await lease.release()
      if (this.lease === lease) { this.lease = undefined; this.owner = undefined }
    }
  }
}
