import { assistantPrompt } from './assistant/context'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { isAbsolute, join } from 'node:path'
import { cp, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { ACPConnection, ACPRemoteError, ACPTimeoutError } from './acp/acpConnection.ts'
import { ACPHistoryProjection, projectACPTool, projectGrokUsage } from './acp/acpEventProjection.ts'
import { grokNativeHandshake, grokCapabilityAvailable, projectGrokContract, grokModelContextWindows } from './grokNativeCapabilities.ts'
import { GrokNativeControls } from './grokNativeControls.ts'
import { assertGrokPromptSize, materializeGrokHistoryImages } from './grokImages.ts'
import { saveGrokChildHistory, flushGrokChildHistory } from './grokChildHistory.ts'
import { normalizeQuestions, validateGrokQuestionReply, type NormalizedField } from '../shared/questions.ts'
import { normalizeGrokSubagentNotification, mergeSubAgentSnapshot } from '../shared/subAgentLifecycle.ts'
import { buildTextPromptBlocks } from './acp/acpPromptBlocks.ts'
import { ACP_PERMISSION_MODES, KIMI_PERMISSION_MODES, MCODE_PERMISSION_MODES, acpLaunchArgs, acpOption, acpSelectValues, advertisedACPCapability, assertACPProviderConfig, mcodeSupportsExtension, projectACPContract, type ACPProvider } from './acp/acpProvider.ts'
import { MCODE_PERMISSION_VALUES, parseMCodeModelValue } from '../shared/mcode.ts'
import { mcodeContextLimit, readMCodeCatalogSync, writeMCodeContextLimit, type MCodeCatalog } from './mcodeCatalog.ts'
import { isKimiAuthorizationError, startKimiLogin, type KimiLoginState } from './kimiAuth.ts'
import { isProviderQuotaExceeded } from '../shared/providerErrors.ts'
import { nativeCredentialEnv } from './agentSetupCredentials.ts'
import { findAgentExecutable } from './agentSetupProcess.ts'
import { handoffMcpServers } from './handoff.ts'
import type { ACPInitialize, ACPJsonRpcMessage } from './acp/acpTypes.ts'
import type { GoalState, NativeGoalUpdate } from '../shared/nativeCapabilities.ts'
import type { AgentDef, Attachment, GrokNativeContract, GrokNativeCapability, UASubAgent, SessionAgentContract, SessionConfig, SessionSummary, TurnUsage, UAEvent } from '../shared/types.ts'

export { loadKimiSessionEvents } from './kimiHistory.ts'

const execFileP = promisify(execFile)
const CANCEL_TIMEOUT_MS = 8_000
/** MiniMax Code never notifies goal progress, so the goal status is polled. */
const MCODE_GOAL_POLL_MS = 4_000
const STOP_REASONS = new Set(['end_turn','max_tokens','max_turn_requests','refusal','cancelled'])
const nativeSessionOwners = new Map<string, ACPConnection>()
export const GROK_PERMISSION_MODES = ACP_PERMISSION_MODES.map(mode => mode.id === 'full-access'
  ? { ...mode, label: '自动代批', hint: 'UniAgent 自动批准 Grok 发出的 ACP 工具审批；当前 ACP 未开放原生 Auto 审查切换，原生拒绝规则与必须交互的操作仍生效。' }
  : mode)
export interface GrokACPContract extends SessionAgentContract { contextWindow?: number; collaborationModes: Array<'default' | 'plan'> }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validateACPInitialize(value: any, label: string): void {
  if (!record(value) || value.protocolVersion !== 1 || !record(value.agentCapabilities)) throw new Error(`${label} ACP 协议不兼容：需要 v1 和 agentCapabilities`)
}
function contentText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  return record(value) && value.type === 'text' && typeof value.text === 'string' ? value.text : ''
}
function cloneContract(value?: GrokACPContract): GrokACPContract | undefined { return value && structuredClone(value) }
/** Decode the catalog model id behind a MiniMax Code model selection value. */
function mcodeModelIdOf(model: string | undefined): string | undefined {
  if (!model) return undefined
  return parseMCodeModelValue(model)?.modelId
}
const unsupported = (): Error => new Error('稳定 ACP 接入未开放此功能；请使用 Agent 原生客户端。')

type GrokContextUsage = { contextTokens: number; contextWindow?: number }
const boundedTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * Grok's prompt result `_meta` carries the LAST model call (inputTokens) next to
 * the turn's cumulative `_meta.usage`. Only the former is bounded context load;
 * the cumulative total routinely exceeds the window (2.4M tokens for 256k).
 */
function promptContextUsage(meta: unknown): GrokContextUsage | undefined {
  if (!record(meta)) return undefined
  const used = boundedTokenCount(meta.inputTokens) ?? boundedTokenCount(meta.totalTokens)
  if (used === undefined) return undefined
  const window = boundedTokenCount(meta.contextWindow)
  return { contextTokens: used, ...(window ? { contextWindow: window } : {}) }
}

/** `_x.ai/session/state` replays the CLI's persisted context signals on session/load. */
function stateContextUsage(value: unknown): GrokContextUsage | undefined {
  const envelope = record(value) && record(value.result) ? value.result : value
  const signals = record(envelope) && record(envelope.signals) ? envelope.signals : undefined
  if (!signals) return undefined
  const used = boundedTokenCount(signals.contextTokensUsed)
  if (used === undefined) return undefined
  const window = boundedTokenCount(signals.contextWindowTokens)
  return { contextTokens: used, ...(window ? { contextWindow: window } : {}) }
}

function grokContextEvent(id: string, usage: GrokContextUsage, modelId: string | undefined, ts: number): UAEvent {
  return {
    sessionId: '', seq: 0, ts, type: 'system_notice',
    payload: { id, kind: 'context', usage: { contextTokens: usage.contextTokens, ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}), ...(modelId ? { modelId } : {}) } }
  }
}
type PendingRequest = { rpcId: number | string | null; connection: ACPConnection; turn: number; optionIds: Set<string>; kind: 'permission' | 'question' | 'elicitation'; fields?: NormalizedField[]; timer?: ReturnType<typeof setTimeout>; childId?: string }

/** Stable ACP for all providers; verified Grok extensions remain session-scoped. */
export class GrokACPRunner extends EventEmitter {
  private connection: ACPConnection | null = null
  private connectionEpoch = 0
  private ready?: Promise<void>
  private closing?: Promise<void>
  private nativeSessionId?: string
  private initializeResult?: ACPInitialize
  private response: Record<string, any> = {}
  private contract?: GrokACPContract
  /** MiniMax Code's own model catalog; the only source for per-model capabilities. */
  private mcodeCatalog?: MCodeCatalog
  private config: SessionConfig
  private turn = 0
  private activeTurn = 0
  private running = false
  private cancelling = false
  private disposed = false
  private includeMcp = true
  private replayingHistory = false
  private connecting = false
  private applyingConfig = false
  private openingUpdates: ACPJsonRpcMessage[] = []
  private textKind: 'agent' | 'thought' | null = null
  private text = ''
  private textId = ''
  private itemSerial = 0
  private commands: string[] = []
  private toolStateById = new Map<string, any>()
  private pending = new Map<string, PendingRequest>()
  private runtimeFingerprint?: string
  private promptTurnId?: number
  private goalWatcher?: ReturnType<typeof setInterval>
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  private authLoginUnsubscribes = new Set<() => void>()
  private readonly instanceId = randomUUID()
  private native?: GrokNativeContract
  private grokControls?: GrokNativeControls
  private goalState?: GoalState
  private goalUnknown = false
  private goalStateVerified = false
  private contextWindows: Record<string,number> = {}
  private controlExecution?: { turn: number; promise: Promise<any> }
  private controlAction = false
  private nativePromptId?: string
  private usageByPrompt = new Map<string, Partial<TurnUsage>>()
  private lastGrokContextKey?: string
  private children = new Map<string, UASubAgent>()
  private childHistory = new Map<string, ACPHistoryProjection>()
  private questionTools = new Set<string>()
  constructor(private readonly sessionId: string, private readonly seqRef: { n: number }, private readonly agent: AgentDef, config: SessionConfig, resumeSessionId?: string, private readonly extraEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = {}) {
    super(); this.config = { ...config }; this.nativeSessionId = resumeSessionId
  }
  private get provider(): ACPProvider {
    // Explicit mapping: a fallback to 'grok' would silently apply Grok's
    // launch arguments, permission semantics and auth detection to a provider
    // that behaves differently.
    const adapter = this.agent.adapter
    if (adapter === 'deepseek') return 'deepseek'
    if (adapter === 'kimi') return 'kimi'
    if (adapter === 'mcode') return 'mcode'
    return 'grok'
  }
  private get providerLabel(): string { return this.agent.name }
  private get eventPrefix(): string { return `${this.provider}-${this.instanceId}` }
  isRunning(): boolean { return this.running || !!this.controlExecution || this.goalState?.autonomous === true || this.goalUnknown }
  supportsCommand(name: string): boolean { return this.commands.includes(name.replace(/^\//,'')) }

  async startTurn(prompt: string, attachments?: Attachment[]): Promise<void> {
    if (this.disposed) return
    if (this.isRunning()) {
      // A native MiniMax Code goal owns the session until it settles; a
      // prompt sent on top of it would be rejected by the runtime anyway.
      if (this.goalWatcher) throw new Error('MiniMax Code 正在执行原生 Goal，请等待 Goal 结束或先清除 Goal')
      return
    }
    this.running = true; this.cancelling = false; this.activeTurn = ++this.turn
    const turn = this.activeTurn; this.resetText(); this.toolStateById.clear()
    try {
      await this.ensureReady()
      if (!this.ownsTurn(turn) || this.cancelling) return
      if (this.goalState?.autonomous || this.goalUnknown) throw new Error('恢复的 Grok 目标仍在活动或状态未确认，请先核对并暂停目标')
      const slash = prompt.trimStart().startsWith('/')
      if (slash && attachments?.length) throw new Error('slash 命令不能与附件同时发送')
      const effective = slash ? prompt.trimStart() : await assistantPrompt(this.sessionId, this.config, prompt, [worktreeInstructions(this.config),requirementInstructions(this.config)].filter(Boolean).join('\n\n'))
      const blocks = await buildTextPromptBlocks(effective, attachments, { provider:this.provider, imageAttachments:this.contract?.imageAttachments === true, fileAttachments:this.contract?.fileAttachments === true,env:typeof this.extraEnv === 'function' ? this.extraEnv() : this.extraEnv })
      if (this.provider === 'grok') assertGrokPromptSize(blocks,this.nativeSessionId!)
      if (!this.ownsTurn(turn) || this.cancelling || !this.connection || !this.nativeSessionId) return
      this.emitEvent({ type:'turn_started',payload:{ id:`${this.eventPrefix}-turn-${turn}`,threadId:this.nativeSessionId } })
      // Steering is only valid for a turn this process started through
      // `session/prompt`; a turn driven by the agent itself (for example a
      // native goal kickoff) is not steerable.
      this.promptTurnId = turn
      const result = await this.connection.request('session/prompt', { sessionId:this.nativeSessionId,prompt:blocks },0)
      this.promptTurnId = undefined
      if (!this.ownsTurn(turn)) return
      if (!record(result) || !STOP_REASONS.has(result.stopReason)) throw new Error('session/prompt 返回了无效 stopReason')
      if (this.native?.confirmed) {
        this.emitGrokUsage(result._meta?.promptId, result._meta?.usage)
        this.emitGrokPromptContext(result._meta)
      }
      this.finish(this.cancelling || result.stopReason === 'cancelled' ? 'cancelled' : 'success',turn)
    } catch (error: any) {
      if (!this.ownsTurn(turn)) return
      if (this.cancelling) { this.finish('cancelled',turn); return }
      const detail = error instanceof ACPRemoteError && typeof error.data === 'string' ? `${error.message}: ${error.data}` : error?.message || String(error)
      const authRequired = this.provider === 'kimi' ? isKimiAuthorizationError(detail) : /MISSING_CREDENTIAL|INVALID_CREDENTIAL|\b401\b|authentication|invalid.*api.?key/i.test(detail)
      if (this.provider === 'kimi' && isProviderQuotaExceeded(detail)) this.emitEvent({
        type: 'error', state: 'failed', payload: {
          message: 'Kimi Code 额度已耗尽，请等待重置或检查套餐后重试。', detail
        }
      })
      else if (authRequired && this.provider === 'kimi') this.emitKimiAuthError(error)
      else this.emitEvent({ type:'error',state:'failed',payload:{ message:`${this.providerLabel} ACP 运行失败：${detail}`, ...(authRequired ? { authRequired:true } : {}) } })
      this.finish('failed',turn,authRequired)
    }
  }
  interrupt(): void {
    if (!this.running && !this.controlExecution) {
      if (this.goalState?.autonomous) void this.updateGoal({action:'pause'}).catch(error => this.nativeFailure('goal',error))
      return
    }
    const turn = this.activeTurn; this.cancelling = true
    if (!this.connection || !this.nativeSessionId || this.connecting) { this.closeConnection(); this.finish('cancelled',turn); return }
    try { this.connection.notify('session/cancel',{ sessionId:this.nativeSessionId }) } catch { this.closeConnection(); this.finish('cancelled',turn); return }
    this.retirePending('cancelled')
    if (this.goalWatcher) {
      // session/cancel only aborts ACP prompt turns; autonomous Goals need
      // the runtime's own pause operation before the local turn can end.
      this.stopWatchingMCodeGoal()
      void this.mcodeGoalRequest('mcode/session/goal/patch', { status: 'paused' }).then(result => {
        if (!this.ownsTurn(turn)) return
        const goal = this.projectMCodeGoal(result?.goal)
        if (goal?.autonomous) throw new Error('MiniMax Code 未确认 Goal 已暂停')
        this.emit('goalChanged', goal)
        this.finish('cancelled', turn)
      }).catch(error => {
        if (!this.ownsTurn(turn)) return
        this.closeConnection()
        this.emitEvent({ type: 'error', state: 'failed', payload: { message: `MiniMax Code Goal 停止未确认：${String(error)}` } })
        this.finish('failed', turn)
      })
      return
    }
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = setTimeout(() => { if (this.activeTurn === turn && (this.running || this.controlExecution)) { this.goalUnknown = !!this.controlExecution; this.closeConnection(); this.finish('cancelled',turn) } },CANCEL_TIMEOUT_MS)
    this.cancelTimer.unref?.()
  }
  private closeConnection(): void {
    this.connectionEpoch++
    const connection = this.connection; this.connection = null
    if (this.native?.confirmed) {this.native.confirmed = false;this.updateContract({});this.emit('contract',cloneContract(this.contract))}
    if (connection) { this.closing = connection.closeAndWait(); void this.closing.catch(() => {}) }
  }
  dispose(): void {
    this.disposed = true
    if (this.running) this.finish('cancelled',this.activeTurn)
    this.retirePending('cancelled'); this.closeConnection()
    for (const unsubscribe of this.authLoginUnsubscribes) unsubscribe()
    this.authLoginUnsubscribes.clear()
  }
  async disposeAndWait(): Promise<void> {
    const connection = this.connection
    if (!this.running && this.nativeSessionId && advertisedACPCapability(this.initializeResult?.agentCapabilities?.sessionCapabilities?.close)) await connection?.request('session/close',{sessionId:this.nativeSessionId},2000).catch(() => {})
    this.dispose(); await this.ready?.catch(() => {}); await this.closing
    if (this.provider === 'grok') await flushGrokChildHistory()
  }
  async updateConfig(config: SessionConfig): Promise<{ config: SessionConfig; contract?: GrokACPContract }> {
    assertACPProviderConfig(this.provider,config)
    if (this.isRunning()) throw new Error('ACP 运行中不能更新配置')
    if (!this.connection && JSON.stringify(config) === JSON.stringify(this.config)) return { config:{...this.config}, contract:cloneContract(this.contract) }
    const previous = this.config, contract = cloneContract(this.contract)
    this.config = { ...config }
    try {
      if (this.provider === 'mcode') {
        // The context window lives in MiniMax Code's own configuration and a
        // running process never re-reads it, so a changed window needs a fresh
        // process; the session itself continues through session/load.
        const changed = await this.applyMCodeContextWindow(config)
        if (changed) { this.closeConnection(); await this.ensureReady(true) }
        else if (this.connection) await this.applyConfig(true)
        else await this.ensureReady(true)
      }
      else if (this.connection) await this.applyConfig(true)
      else await this.ensureReady(true)
      return { config:{...this.config},contract:cloneContract(this.contract) }
    } catch (error) {
      this.config = previous; this.contract = contract; this.closeConnection(); throw error
    }
  }

  /**
   * Persist the context window MiniMax Code should use for the selected model.
   * Returns true when the native configuration changed and the process has to
   * be replaced for the new window to take effect.
   */
  private async applyMCodeContextWindow(config: SessionConfig): Promise<boolean> {
    if (this.provider !== 'mcode') return false
    const catalog = this.mcodeCatalog
    const modelId = mcodeModelIdOf(config.model)
    const meta = modelId ? catalog?.models.get(modelId) : undefined
    if (!modelId || !meta) return false
    const target = config.maxMode ? meta.maxContextWindow : meta.defaultContextWindow
    if (!target || !meta.contextWindowOptions?.includes(target)) {
      // The selected model has no larger window: a remembered Max choice must
      // not linger on a model that cannot honour it.
      if (config.maxMode) delete this.config.maxMode
      return false
    }
    if (mcodeContextLimit(catalog, modelId) === target) return false
    await writeMCodeContextLimit(modelId, target, { catalog })
    this.mcodeCatalog = readMCodeCatalogSync()
    return true
  }
  restoreConfigAfterFailedCommit(config: SessionConfig, contract?: SessionAgentContract): void {
    if (this.running) throw new Error('无法恢复运行中的 ACP 配置')
    this.config = {...config}; this.contract = cloneContract(contract as GrokACPContract | undefined); this.closeConnection()
  }
  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> { await this.updateConfig({...this.config,collaborationMode:mode}) }
  respondResult(requestId: string, answer: any): { handled: boolean; hasPendingRequests: boolean } {
    const pending = this.pending.get(requestId)
    if (!pending || pending.connection !== this.connection || (pending.childId ? this.children.get(pending.childId)?.status !== 'running' : pending.turn !== this.activeTurn || !this.isRunning()) || this.cancelling) return {handled:false,hasPendingRequests:this.pending.size > 0}
    if (pending.kind === 'question') {
      const reply = validateGrokQuestionReply(pending.fields!, answer)
      pending.connection.respond(pending.rpcId,reply)
      clearTimeout(pending.timer); this.pending.delete(requestId)
      this.emitEvent({type:'approval_request',state:reply.outcome === 'cancelled' ? 'cancelled' : 'success',payload:{requestId,resolved:true}})
      return {handled:true,hasPendingRequests:this.pending.size > 0}
    }
    if (pending.kind === 'elicitation') {
      // Elicitation replies use a different wire shape than permission
      // requests: {action:'accept', content:{[prop]: value}}.
      const action = answer?.action === 'accept' ? 'accept' : answer?.action === 'cancel' ? 'cancel' : 'decline'
      const content = action === 'accept' && record(answer?.content) ? answer.content : null
      try { pending.connection.respond(pending.rpcId, { action, ...(content ? { content } : {}) }) } catch { return {handled:false,hasPendingRequests:true} }
      this.pending.delete(requestId)
      this.emitEvent({type:'approval_request',state:'success',payload:{requestId,resolved:true}})
      return {handled:true,hasPendingRequests:this.pending.size > 0}
    }
    const optionId = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : undefined
    const outcome = pending.optionIds.has(optionId) ? {outcome:'selected',optionId} : {outcome:'cancelled'}
    try { pending.connection.respond(pending.rpcId,{outcome}) } catch { return {handled:false,hasPendingRequests:true} }
    this.pending.delete(requestId)
    this.emitEvent({type:'approval_request',state:'success',payload:{requestId,resolved:true}})
    return {handled:true,hasPendingRequests:this.pending.size > 0}
  }
  /**
   * MiniMax Code asks for structured input (for example the Plan-mode review)
   * through `elicitation/create`. It carries a JSON schema instead of permission
   * options, so it must be surfaced as a question rather than an approval.
   */
  private handleElicitation(connection: ACPConnection, message: ACPJsonRpcMessage): void {
    const params = message.params
    const rpcId = message.id
    if (rpcId === undefined) return
    if (!this.running || this.cancelling || this.connecting || params?.sessionId !== this.nativeSessionId) {
      connection.respondError(rpcId, -32602, 'Invalid or inactive elicitation request')
      return
    }
    const schema = record(params?.requestedSchema) ? params.requestedSchema : undefined
    const properties = schema && record(schema.properties) ? schema.properties : {}
    if (!Object.keys(properties).length) {
      connection.respondError(rpcId, -32602, 'Elicitation request has no fields')
      return
    }
    const requestId = `${this.eventPrefix}_${this.activeTurn}_${++this.itemSerial}`
    this.pending.set(requestId, { rpcId, connection, turn: this.activeTurn, optionIds: new Set(), kind: 'elicitation' })
    this.emitEvent({
      type: 'approval_request',
      state: 'pending',
      payload: { id: requestId, requestId, kind: 'elicitation', method: message.method, params: { ...params, requestedSchema: schema } }
    })
  }
  getSubAgentItems(id: string, _trusted?: {nativeTaskId:string;parentNativeSessionId:string}): UAEvent[] {
    if (this.provider === 'mcode') throw unsupported()
    if (!this.children.has(id)) throw new Error('Grok 子 Agent 不属于当前会话')
    return structuredClone(this.childHistory.get(id)?.events || [])
  }
  async readNativeImage(_request: {eventSeq:number;blockIndex:number;toolResult?:boolean;childSessionId?:string}): Promise<string | null> { throw unsupported() }
  async getGoal(): Promise<GoalState | undefined> {
    if (this.provider === 'mcode') {
      await this.ensureReady()
      if (!this.mcodeGoalSupported()) throw unsupported()
      const result = await this.mcodeGoalRequest('mcode/session/goal/get', {})
      return this.projectMCodeGoal(result?.goal)
    }
    await this.ensureReady()
    if (!this.grokControls) throw unsupported()
    try {
      const goal = await this.grokControls.getGoal(); this.goalUnknown = false; this.goalStateVerified = true
      if (this.native) this.native.capabilities.goal = {status:'unknown'}
      this.updateContract({});this.emit('contract',cloneContract(this.contract));return goal
    }
    catch(error) { this.goalUnknown = !!this.goalState || !!this.controlExecution; this.nativeFailure('goal',error); throw error }
  }
  async setGoal(request: {objective:string;tokenBudget?:number;maxRounds?:number}): Promise<GoalState> {
    if (this.provider === 'mcode') {
      await this.ensureReady()
      if (!this.mcodeGoalSupported()) throw unsupported()
      const result = await this.mcodeGoalRequest('mcode/session/goal/create', {
        objective: request.objective,
        ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget })
      })
      const goal = this.projectMCodeGoal(result?.goal)
      if (!goal) throw new Error('MiniMax Code 未返回 Goal 状态')
      // `mcode/session/goal/create` starts the goal inside the runtime: the
      // session enters an active Turn without UniAgent sending a prompt. The
      // runner therefore has to own a turn of its own, otherwise the goal's
      // `session/update` stream and any permission request it raises would be
      // dropped as "not running".
      this.beginGoalTurn()
      this.watchMCodeGoal()
      this.publishMCodeGoal(goal)
      return goal
    }
    await this.ensureReady(); this.requireNative('goal')
    if (this.isRunning() || this.controlAction) throw new Error('Grok 当前仍有原生执行，请先暂停或核对状态')
    return this.controlGoal(() => this.grokControls!.setGoal(request))
  }
  async updateGoal(request: NativeGoalUpdate): Promise<GoalState | undefined> {
    if (this.provider === 'mcode') {
      await this.ensureReady()
      if (!this.mcodeGoalSupported()) throw unsupported()
      if (request.action === 'clear') {
        await this.mcodeGoalRequest('mcode/session/goal/clear', {})
        this.publishMCodeGoal(undefined)
        return undefined
      }
      if (request.action === 'edit') {
        const result = await this.mcodeGoalRequest('mcode/session/goal/patch', {
          ...(request.objective === undefined ? {} : { objective: request.objective }),
          ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget })
        })
        const goal = this.projectMCodeGoal(result?.goal)
        this.publishMCodeGoal(goal)
        return goal
      }
      if (request.action === 'pause' || request.action === 'resume' || request.action === 'complete') {
        const status = request.action === 'pause' ? 'paused' : request.action === 'resume' ? 'active' : 'complete'
        const result = await this.mcodeGoalRequest('mcode/session/goal/patch', { status })
        const goal = this.projectMCodeGoal(result?.goal)
        if (goal?.autonomous && !this.goalWatcher) {
          this.beginGoalTurn()
          this.watchMCodeGoal()
        }
        this.publishMCodeGoal(goal)
        return goal
      }
      // 'block' / 'disarm' have no MiniMax Code equivalent.
      throw unsupported()
    }
    await this.ensureReady()
    if (!this.grokControls) throw unsupported()
    if (this.controlAction) throw new Error('Grok 目标控制正在进行中')
    if (!['pause','resume','clear'].includes(request.action) || Object.keys(request).some(key => key !== 'action')) throw new Error('Grok 不支持此目标操作')
    return this.controlGoal(async () => {
      if (this.controlExecution || this.running) {
        if (request.action === 'resume') throw new Error('Grok 当前已有活动执行')
        const execution = this.controlExecution?.promise
        this.interrupt()
        if (execution) await execution.catch(() => {})
        else if (this.running) throw new Error('Grok 正在停止当前回合，请等待取消确认')
        if (this.goalUnknown || !this.connection) throw new Error('Grok 停止状态未确认，请重新核对')
        if (request.action === 'pause' && this.goalState?.status === 'paused') return this.goalState
      }
      return this.grokControls!.updateGoal(request)
    })
  }
  private async controlGoal<T>(action: () => Promise<T>): Promise<T> {
    this.controlAction = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([action(),new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new ACPTimeoutError('Grok 目标操作未确认；不会自动重发')),10_000) })])
    } catch (error) { this.goalUnknown = !!this.controlExecution || !!this.goalState; this.nativeFailure('goal',error); throw error }
    finally { clearTimeout(timer); this.controlAction = false }
  }
  async queryUsage(): Promise<TurnUsage | undefined> {
    if (this.provider === 'mcode') return undefined
    const usage = [...this.usageByPrompt.values()].at(-1)
    return usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' && typeof usage.cachedInputTokens === 'number' ? structuredClone(usage) as TurnUsage : undefined
  }
  /** MiniMax Code exposes native goals through the `mcode/session/goal/*` extension. */
  private mcodeGoalSupported(): boolean {
    return this.provider === 'mcode' && mcodeSupportsExtension(this.initializeResult, 'mcode/session/goal/get')
  }
  /**
   * Enter a runner-owned turn so the goal's runtime-driven stream is projected.
   *
   * The goal turn is not a `session/prompt` round trip: MiniMax Code runs the
   * objective on its own and (measured on 0.6.12) never emits a
   * `mcode/session/goal_update` notification. The turn therefore ends when the
   * polled goal status becomes terminal.
   */
  private beginGoalTurn(): void {
    if (this.running) return
    this.running = true
    this.cancelling = false
    this.activeTurn = ++this.turn
    this.resetText()
    this.toolStateById.clear()
    this.emitEvent({ type:'turn_started',payload:{ id:`${this.eventPrefix}-goal-turn-${this.activeTurn}`,threadId:this.nativeSessionId } })
    this.emit('goalTurn', { state: 'running', autonomous: true })
  }
  /**
   * Poll the goal status until it settles.
   *
   * Measured behaviour of `mcode 0.6.12`: the runtime never notifies the
   * client about goal progress, so polling is the only way to learn that the
   * autonomous turn finished.
   */
  private watchMCodeGoal(): void {
    this.stopWatchingMCodeGoal()
    const timer = setInterval(() => { void this.pollMCodeGoal() }, MCODE_GOAL_POLL_MS)
    timer.unref?.()
    this.goalWatcher = timer
  }
  private stopWatchingMCodeGoal(): void {
    if (this.goalWatcher) clearInterval(this.goalWatcher)
    this.goalWatcher = undefined
  }
  private async pollMCodeGoal(): Promise<void> {
    if (this.provider !== 'mcode' || !this.running || !this.nativeSessionId) return
    const connection = this.connection, turn = this.activeTurn, watcher = this.goalWatcher
    let goal: GoalState | undefined
    try {
      const result = await this.mcodeGoalRequest('mcode/session/goal/get', {})
      goal = this.projectMCodeGoal(result?.goal)
    } catch { return }
    if (connection !== this.connection || turn !== this.activeTurn || watcher !== this.goalWatcher) return
    this.publishMCodeGoal(goal)
  }
  private publishMCodeGoal(goal: GoalState | undefined): void {
    const ownsGoalTurn = !!this.goalWatcher
    this.emit('goalChanged', goal)
    if (ownsGoalTurn && !goal?.autonomous) this.finish(goal?.status === 'blocked' ? 'failed' : 'success', this.activeTurn)
  }
  private projectMCodeGoal(goal: any): GoalState | undefined {
    if (!record(goal)) return undefined
    const status = typeof goal.status === 'string' ? goal.status : 'active'
    // The runtime reports 'complete' (not 'completed') and 'failed'.
    const mapped = status === 'paused' ? 'paused'
      : status === 'complete' || status === 'completed' ? 'complete'
        : status === 'blocked' || status === 'failed' || status === 'error' ? 'blocked'
          : status === 'usage_limited' || status === 'usageLimited' ? 'usageLimited'
            : status === 'budget_limited' || status === 'budgetLimited' ? 'budgetLimited' : 'active'
    return {
      objective: typeof goal.objective === 'string' ? goal.objective : '',
      status: mapped as GoalState['status'],
      tokenBudget: typeof goal.tokenBudget === 'number' ? goal.tokenBudget : null,
      tokensUsed: Math.max(0, Number(goal.tokensUsed) || 0),
      timeUsedSeconds: Math.max(0, Number(goal.timeUsedSeconds) || 0),
      createdAt: Math.max(0, Number(goal.createdAt) || Date.now()),
      updatedAt: Math.max(0, Number(goal.updatedAt) || Date.now()),
      continuation: 'native',
      // The autonomous run is over once the goal settles; keeping this true
      // would pin the session in the "running" state forever.
      autonomous: mapped === 'active'
    }
  }
  private async mcodeGoalRequest(method: string, params: Record<string, unknown>): Promise<any> {
    const connection = this.connection
    if (!connection || !this.nativeSessionId) throw new Error('ACP 尚未连接')
    return connection.request(method, { sessionId: this.nativeSessionId, ...params })
  }
  async inventory(): Promise<unknown> { throw unsupported() }
  async pluginAction(_request: Record<string,unknown>): Promise<any> { throw unsupported() }
  async steer(prompt: string, attachments?: Attachment[]): Promise<{appendedToTurn:boolean;nativePromptId?:string} | void> {
    if (this.provider === 'mcode') {
      // The local turn state is checked first: "no turn to steer into" is a far
      // more actionable message than "this provider has no steering support".
      if (!this.running || this.cancelling || this.promptTurnId === undefined) throw new Error('当前没有可插话的 MiniMax Code 回合')
      if (!mcodeSupportsExtension(this.initializeResult, 'mcode/session/steer')) throw unsupported()
      const connection = this.connection
      if (!connection || !this.nativeSessionId) throw new Error('ACP 尚未连接')
      const blocks = await buildTextPromptBlocks(prompt, attachments, { provider: this.provider, imageAttachments: this.contract?.imageAttachments === true, fileAttachments: this.contract?.fileAttachments === true })
      const text = blocks.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text || '')).join('\n')
      if (!text) throw new Error('插话内容为空')
      const result = await connection.request('mcode/session/steer', { sessionId: this.nativeSessionId, text })
      const turnId = typeof result?.turnId === 'string' ? result.turnId : undefined
      const mode = typeof result?.mode === 'string' ? result.mode : undefined
      if (mode !== 'steered') throw new Error('MiniMax Code 未接受插话，已改由本地队列发送')
      return { appendedToTurn: true, nativePromptId: turnId }
    }
    this.requireNative('steer')
    if (!this.running || this.cancelling || !prompt.trim() || attachments?.length) throw new Error('Grok 引导仅支持活动父回合中的纯文本')
    const connection = this.connection!, turn = this.activeTurn, nativePromptId = this.nativePromptId
    try {
      const result = await connection.request('_x.ai/interject',{sessionId:this.nativeSessionId,text:prompt})
      if (result?.result?.status !== 'queued') throw new Error('Grok 未确认接收引导消息')
      if (connection !== this.connection || turn !== this.activeTurn || !this.running || this.cancelling) throw new ACPTimeoutError('Grok 引导送达未确认：原回合已结束，请核对后再重试')
      return {appendedToTurn:true,...(nativePromptId ? {nativePromptId} : {})}
    } catch (error) { this.nativeFailure('steer',error); throw error }
  }
  async cancelSubAgent(id: string): Promise<void> {
    if (this.provider === 'mcode') throw unsupported()
    this.requireNative('subagents')
    const child = this.children.get(id)
    if (!child?.nativeTaskId || child.status !== 'running') throw new Error('Grok 子 Agent 不属于当前活动会话')
    try {
      const result = await this.connection!.request('_x.ai/subagent/cancel',{subagentId:child.nativeTaskId})
      if (result?.result?.cancelled !== true) throw new Error('Grok 未确认取消子 Agent')
    } catch (error) { this.nativeFailure('subagents',error); throw error }
  }
  async probeSession(includeMcp = true): Promise<{nativeSessionId:string;contract:GrokACPContract}> {
    if (this.running) throw new Error('ACP runner 正在执行回合')
    this.includeMcp = includeMcp; await this.ensureReady()
    return {nativeSessionId:this.nativeSessionId!,contract:cloneContract(this.contract)!}
  }
  private ensureReady(strict = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('ACP runner 已关闭'))
    const env = { ...(this.provider === 'grok' ? nativeCredentialEnv('grok') : {}), ...(typeof this.extraEnv === 'function' ? this.extraEnv() : this.extraEnv) }
    const fingerprint = createHash('sha256').update(JSON.stringify(env)).digest('hex')
    if (this.connection && this.runtimeFingerprint !== fingerprint) this.closeConnection()
    if (this.connection && this.nativeSessionId && !this.connecting) return Promise.resolve()
    if (this.ready) return this.ready
    const ready = this.connect(env,fingerprint,strict,this.connectionEpoch).finally(() => { if (this.ready === ready) this.ready = undefined })
    this.ready = ready; return ready
  }
  private async connect(env: NodeJS.ProcessEnv, fingerprint: string, strict: boolean, epoch: number): Promise<void> {
    await this.closing
    assertACPProviderConfig(this.provider,this.config)
    if (this.disposed || epoch !== this.connectionEpoch) throw new Error('ACP 连接已关闭')
    // A fresh MiniMax Code process reads the context window from its own
    // configuration, so the requested window has to be persisted before the
    // process starts.
    if (this.provider === 'mcode') {
      if (!this.mcodeCatalog) this.mcodeCatalog = readMCodeCatalogSync()
      await this.applyMCodeContextWindow(this.config)
    }
    const args = acpLaunchArgs(this.provider,this.config)
    if (this.provider === 'deepseek' && env.UNIAGENT_DEEPSEEK_ACP_PATCH) args.push('--patch', env.UNIAGENT_DEEPSEEK_ACP_PATCH)
    const connection = new ACPConnection({ bin:this.agent.bin,args,cwd:this.config.workdir,env:{...process.env,...(this.provider === 'grok' ? {GROK_GOAL:process.env.GROK_GOAL || '1'} : {}),...env},providerLabel:this.providerLabel,validateInitialize:v => validateACPInitialize(v,this.providerLabel) })
    this.connection = connection; this.runtimeFingerprint = fingerprint; this.connecting = true; this.openingUpdates = []; this.commands = []; this.response = {}
    connection.on('notification',(message: ACPJsonRpcMessage) => { if (this.connection === connection) this.onNotification(message) })
    connection.on('request',(message: ACPJsonRpcMessage) => { if (this.connection === connection) this.onRequest(connection,message) })
    connection.on('protocolError',(error: Error) => { if (this.connection === connection && this.running) { this.emitEvent({type:'error',state:'failed',payload:{message:error.message}}); this.finish('failed',this.activeTurn) } })
    connection.on('close',({unexpected}: {unexpected?:boolean} = {}) => {
      if (this.connection !== connection) return
      this.connection = null
      if (this.native) { this.native.confirmed = false; this.goalUnknown = !!this.controlExecution || this.goalState?.autonomous === true; this.updateContract({}); this.emit('contract',cloneContract(this.contract)) }
      this.retirePending('failed')
      if (unexpected && this.running) { this.emitEvent({type:'error',state:'failed',payload:{message:`${this.providerLabel} ACP 进程已退出`}}); this.finish('failed',this.activeTurn) }
    })
    try {
      this.initializeResult = await connection.initialize()
      this.native = this.provider === 'grok' ? grokNativeHandshake(this.initializeResult) : undefined
      // MiniMax Code's capabilities (thinking variants, reasoning levels and
      // context windows) live in its own runtime configuration; the ACP surface
      // only exposes the currently selected model.
      if (this.provider === 'mcode') this.mcodeCatalog = readMCodeCatalogSync()
      this.goalStateVerified = false
      this.contextWindows = this.native?.confirmed ? await grokModelContextWindows(env) : {}
      if (this.native?.confirmed && Array.isArray(this.initializeResult._meta?.availableCommands)) this.commands = this.initializeResult._meta.availableCommands.map((value:any) => value?.name).filter((value:any) => typeof value === 'string')
      if (this.disposed || this.connection !== connection) throw new Error('ACP 连接已关闭')
      const caps = this.initializeResult.agentCapabilities
      const requestedId = this.nativeSessionId
      const claimSession = (id: string): void => {
        const key = JSON.stringify([this.provider,this.agent.bin,...['HOME','KIMI_CODE_HOME','GROK_HOME','DSH_HOME'].map(name => env[name] || process.env[name]),id])
        const owner = nativeSessionOwners.get(key)
        if (owner && owner !== connection) throw new Error(`${this.provider}_runtime_already_owned: 此原生会话已有活动连接`)
        nativeSessionOwners.set(key,connection)
        connection.once('close',() => { if (nativeSessionOwners.get(key) === connection) nativeSessionOwners.delete(key) })
      }
      if (requestedId) claimSession(requestedId)
      const method = !requestedId ? 'session/new' : advertisedACPCapability(caps?.sessionCapabilities?.resume) ? 'session/resume' : caps?.loadSession === true ? 'session/load' : undefined
      if (!method) throw new Error('新版 Agent 未声明会话恢复；历史已保留，请新建会话继续。')
      if (this.config.additionalDirectories?.length && !advertisedACPCapability(caps?.sessionCapabilities?.additionalDirectories)) {
        // MiniMax Code does not advertise extra directories; drop them instead
        // of failing the whole session, and tell the user what was ignored.
        if (this.provider === 'mcode') {
          this.config.additionalDirectories = undefined
          this.emitEvent({type:'system_notice',payload:{kind:'warning',text:'MiniMax Code 不支持会话级额外目录，已忽略多目录设置。'}})
        } else {
          throw new Error('当前 ACP 未声明额外目录支持；请选择单目录空间后继续。')
        }
      }
      this.replayingHistory = method === 'session/load'
      const response = await connection.request(method,{...(requestedId ? {sessionId:requestedId} : {}),cwd:this.config.workdir,mcpServers:this.includeMcp ? handoffMcpServers(this.sessionId) : [],...(this.config.additionalDirectories?.length ? {additionalDirectories:this.config.additionalDirectories} : {})})
      const returnedId = typeof response?.sessionId === 'string' ? response.sessionId : undefined
      if (!record(response) || (!requestedId && !returnedId) || (returnedId && requestedId && returnedId !== requestedId)) throw new Error('ACP 返回了无效或跨会话的 sessionId')
      if (this.disposed || this.connection !== connection) throw new Error('ACP 连接已关闭')
      this.nativeSessionId = returnedId || requestedId
      if (!requestedId) claimSession(this.nativeSessionId!)
      if (this.native?.confirmed) this.grokControls = new GrokNativeControls({request:(method,params,timeout) => method === 'session/prompt'
        ? this.runGrokControl(connection,params) : connection.request(method,params,timeout)},this.nativeSessionId!,this.config.workdir,goal => {
          if (this.connection !== connection) return
          this.goalState = goal; this.goalUnknown = false; this.emit('goalChanged',goal)
        },error => { if (this.connection === connection) { this.goalUnknown = true; this.nativeFailure('goal',error) } })
      else this.grokControls = undefined
      this.updateContract(response)
      this.replayingHistory = false; this.connecting = false
      this.applyingConfig = true
      try { for (const message of this.openingUpdates.splice(0)) this.onNotification(message) }
      finally { this.applyingConfig = false }
      await this.applyConfig(strict || !!this.config.roleSnapshot)
      if (this.grokControls) {
        await Promise.all([
          this.grokControls.getGoal(1500).then(() => { this.goalStateVerified = true; this.updateContract({}) })
            .catch(error => this.nativeFailure('goal',error)),
          this.refreshGrokContext(1500)
        ])
      }
      this.emit('nativeSession',{nativeSessionId:this.nativeSessionId})
      this.emit('contract',cloneContract(this.contract))
    } catch (error) {
      if (this.connection === connection) this.connection = null
      await connection.closeAndWait(); throw error
    } finally { this.connecting = false; this.replayingHistory = false }
  }
  private updateContract(response: any): void {
    for (const key of ['configOptions','modes']) if (Object.hasOwn(response || {},key)) this.response[key] = response[key]
    this.contract = projectACPContract(this.provider,this.initializeResult!,this.response,this.config,this.commands,this.mcodeCatalog) as GrokACPContract
    if (this.provider === 'grok') this.contract.permissionModes = GROK_PERMISSION_MODES
    if (this.native) {
      this.contract.models = this.contract.models.map(model => ({...model,...(this.contextWindows[model.id] ? {contextWindow:this.contextWindows[model.id]} : {})}))
      const goal = this.native.capabilities.goal
      if (this.native.confirmed && ['unknown','verified'].includes(goal.status)) goal.status = this.goalStateVerified && this.commands.includes('goal') ? 'verified' : 'unknown'
      this.contract = projectGrokContract(this.contract,this.native) as GrokACPContract
    }
  }
  private async applyConfig(strict: boolean): Promise<void> {
    this.applyingConfig = true
    try { await this.applyConfigOptions(strict) }
    finally { this.applyingConfig = false }
  }
  private async applyConfigOptions(strict: boolean): Promise<void> {
    const connection = this.connection
    if (!connection || !this.nativeSessionId) throw new Error('ACP 尚未连接')
    // MiniMax Code runs the permission policy inside its own process. The
    // logical mode has to be pushed down before the first prompt, otherwise the
    // agent keeps the user's global setting (commonly "full access") while
    // UniAgent shows a stricter one.
    if (this.provider === 'mcode') await this.applyMCodePermissionMode()
    for (const [key,category] of [['model','model'],[this.provider === 'kimi' ? 'kimiThinking' : 'effort','thought_level']] as const) {
      const value = this.config[key]
      if (!value) continue
      const option = acpOption(this.response,category)
      const available = acpSelectValues(option?.options).some(x => x.value === value)
      if (!available) {
        // A model that offers no reasoning level at all (MiniMax Code keeps
        // that per model) makes the stored level meaningless — dropping it is a
        // normal model switch, not an agent update worth a warning.
        const levelUnsupported = category === 'thought_level' && !option
        if (strict && !levelUnsupported) throw new Error(`当前 Agent 未声明可用的 ${key}=${value}`)
        if (!levelUnsupported) this.emitEvent({type:'system_notice',payload:{kind:'warning',text:`Agent 已更新，原 ${key}=${value} 不再可用，已采用原生当前设置。`}})
        delete this.config[key]; continue
      }
      if (option.currentValue === value) continue
      try {
        const result = await connection.request('session/set_config_option',{sessionId:this.nativeSessionId,configId:option.id,value})
        this.updateContract(result)
        if (acpOption(this.response,category)?.currentValue !== value) throw new Error(`Agent 未确认 ${key}=${value}`)
      } catch (error) {
        if (strict || !(error instanceof ACPRemoteError) || error.code !== -32601) throw error
        this.emitEvent({type:'system_notice',payload:{kind:'warning',text:`新版 Agent 暂不支持 ${key} 切换，已采用原生当前设置。`}})
        this.response.configOptions = (this.response.configOptions || []).filter((x: any) => x.id !== option.id)
        delete this.config[key]
      }
    }
    const modes = Array.isArray(this.response.modes?.availableModes) ? this.response.modes.availableModes : []
    const current = this.response.modes?.currentModeId
    const modeOption = acpOption(this.response,'mode')
    const ids = modes.length ? modes.map((x: any) => x.id) : acpSelectValues(modeOption?.options).map(x => x.value)
    const requestedPlan = this.config.collaborationMode === 'plan'
    const target = requestedPlan ? 'plan' : ['default','build','manual'].find(id => ids.includes(id))
    if (requestedPlan && !ids.includes('plan')) {
      if (strict) throw new Error('当前 Agent 未声明 Plan 模式')
      delete this.config.collaborationMode
      this.emit('collaborationModeChanged','default')
      this.emitEvent({type:'system_notice',payload:{kind:'warning',text:'新版 Agent 未声明 Plan 模式，已采用原生当前模式。'}})
    } else if (target && target !== (current || modeOption?.currentValue)) {
      try {
        if (modes.length) { await connection.request('session/set_mode',{sessionId:this.nativeSessionId,modeId:target}); this.response.modes.currentModeId = target }
        else { const result = await connection.request('session/set_config_option',{sessionId:this.nativeSessionId,configId:modeOption.id,value:target}); this.updateContract(result); if (acpOption(this.response,'mode')?.currentValue !== target) throw new Error('Agent 未确认模式切换') }
      } catch (error) {
        if (strict || !(error instanceof ACPRemoteError) || error.code !== -32601) throw error
        delete this.response.modes; this.response.configOptions = (this.response.configOptions || []).filter((x: any) => x.id !== modeOption?.id)
        delete this.config.collaborationMode
        this.emit('collaborationModeChanged','default')
        this.emitEvent({type:'system_notice',payload:{kind:'warning',text:'新版 Agent 暂不支持模式切换，已采用原生当前模式。'}})
      }
    }
    this.updateContract({})
    this.syncNativeConfig()
    this.emit('contract',cloneContract(this.contract))
  }
  /**
   * Push the logical permission mode down to the MiniMax Code runtime.
   *
   * The runtime only accepts `default` (Ask), `auto` (Auto) and
   * `bypassPermissions` (Full access); anything else is rejected with
   * -32602. The option is process scoped, and UniAgent runs one process per
   * session, so the value cannot leak between sessions.
   */
  private async applyMCodePermissionMode(): Promise<void> {
    const connection = this.connection
    if (!connection || !this.nativeSessionId) return
    const option = (Array.isArray(this.response.configOptions) ? this.response.configOptions : [])
      .find((x: any) => x?.id === 'permissionMode' && x?.type === 'select')
    if (!option) throw new Error('当前 Agent 未声明权限模式，无法确认所选权限，已停止执行。')
    const requested = this.config.permissionMode || 'ask'
    const value = MCODE_PERMISSION_VALUES[requested as keyof typeof MCODE_PERMISSION_VALUES] ?? MCODE_PERMISSION_VALUES.ask
    if (option.currentValue === value) return
    const result = await connection.request('session/set_config_option', { sessionId: this.nativeSessionId, configId: 'permissionMode', value })
    this.updateContract(result)
    const current = (Array.isArray(this.response.configOptions) ? this.response.configOptions : [])
      .find((x: any) => x?.id === 'permissionMode')?.currentValue
    if (current !== value) throw new Error(`Agent 未确认权限模式=${value}`)
  }
  private syncNativeConfig(): void {
    this.config.model = this.contract?.currentModelId
    const currentModel = this.contract?.models.find(x => x.id === this.contract?.currentModelId)
    if (this.provider === 'kimi') this.config.kimiThinking = currentModel?.defaultThinking
    else this.config.effort = currentModel?.defaultEffort
    const mode = this.response.modes?.currentModeId || acpOption(this.response,'mode')?.currentValue
    if (typeof mode === 'string') this.config.collaborationMode = mode === 'plan' ? 'plan' : 'default'
    this.emit('configChanged',{...this.config})
  }
  private requireNative(feature: GrokNativeCapability): void {
    if (this.provider !== 'grok' || !this.connection || !this.nativeSessionId || !grokCapabilityAvailable(this.native,feature)) throw unsupported()
  }
  private nativeFailure(feature: GrokNativeCapability, error: unknown): void {
    if (this.native && error instanceof ACPRemoteError && error.code === -32601) {
      this.native.capabilities[feature] = {status:'unsupported',reason:'Grok 未提供此扩展方法'}
      this.updateContract({}); this.emit('contract',cloneContract(this.contract))
    }
    this.emitEvent({type:'system_notice',payload:{kind:'warning',text:`Grok ${feature} 操作未确认：${error instanceof Error ? error.message : String(error)}`}})
    if (feature === 'goal' && this.goalUnknown) this.emit('goalTurn',{state:'error',error})
  }
  private runGrokControl(connection: ACPConnection, params: any): Promise<any> {
    if (this.running || this.controlExecution || connection !== this.connection) return Promise.reject(new Error('Grok 已有活动原生执行'))
    const turn = ++this.turn; this.activeTurn = turn; this.cancelling = false; this.nativePromptId = undefined
    this.resetText(); this.toolStateById.clear()
    let outcome: 'success' | 'failed' | 'cancelled' = 'failed'
    const promise = Promise.resolve().then(() => connection.request('session/prompt',params,0)).then(result => {
      if (this.controlExecution?.turn !== turn || this.connection !== connection) return result
      if (!STOP_REASONS.has(result?.stopReason)) throw new Error('Grok 返回无效控制命令结果')
      this.emitGrokUsage(result._meta?.promptId,result._meta?.usage)
      this.emitGrokPromptContext(result._meta)
      outcome = result.stopReason === 'cancelled' ? 'cancelled' : 'success'
      return result
    }).catch(error => { this.goalUnknown = true; throw error }).finally(() => {
      if (this.controlExecution?.turn !== turn) return
      this.controlExecution = undefined
      if (this.cancelTimer) clearTimeout(this.cancelTimer); this.cancelTimer = null
      if (this.running) this.finish(outcome,turn)
      else {
        this.retirePending(outcome === 'failed' ? 'failed' : 'cancelled'); this.cancelling = false
        this.emit('done',{nativeSessionId:this.nativeSessionId,interrupted:outcome === 'cancelled',failed:outcome === 'failed'})
      }
    })
    this.controlExecution = {turn,promise}
    this.emit('goalTurn',{state:'running',autonomous:true})
    return promise
  }
  private emitGrokUsage(promptId: unknown, raw: unknown): void {
    if (typeof promptId !== 'string' || !promptId || promptId.length > 256 || !record(raw)) return
    const usage = projectGrokUsage(raw), previous = this.usageByPrompt.get(promptId)
    if (previous && !previous.usageIsIncomplete && usage.usageIsIncomplete) return
    if (JSON.stringify(previous) === JSON.stringify(usage)) return
    this.usageByPrompt.set(promptId,usage)
    if (this.usageByPrompt.size > 512) this.usageByPrompt.delete(this.usageByPrompt.keys().next().value!)
    const id = `grok-usage-${this.nativeSessionId}-${promptId}`
    if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number' || typeof usage.cachedInputTokens !== 'number' || usage.usageIsIncomplete) {
      this.emitEvent({type:'system_notice',payload:{id,kind:'warning',text:'Grok 本次用量统计不完整，暂不计为完整消耗或费用。',nativeUsage:usage,nativePromptId:promptId}})
      return
    }
    this.emitEvent({type:'system_notice',payload:{id,kind:'usage',usage:{...usage,modelId:this.contract?.currentModelId},nativePromptId:promptId}})
  }
  private emitGrokPromptContext(meta: unknown): void {
    if (this.provider !== 'grok' || !this.native?.confirmed || this.disposed) return
    const usage = promptContextUsage(meta)
    if (!usage) return
    const modelId = record(meta) && typeof meta.modelId === 'string' && meta.modelId ? meta.modelId : undefined
    this.emitGrokContext(usage, modelId)
  }
  private emitGrokContext(usage: GrokContextUsage, modelId?: string): void {
    if (this.disposed) return
    const currentModelId = modelId || this.contract?.currentModelId
    const model = this.contract?.models.find(candidate => candidate.id === currentModelId)
    const contextWindow = usage.contextWindow ?? model?.contextWindow
    const payload = {contextTokens:usage.contextTokens,...(contextWindow ? {contextWindow} : {}),...(currentModelId ? {modelId:currentModelId} : {})}
    const key = JSON.stringify(payload)
    if (key === this.lastGrokContextKey) return
    this.lastGrokContextKey = key
    this.emitEvent({type:'system_notice',payload:{id:`${this.eventPrefix}-context-${++this.itemSerial}`,kind:'context',usage:payload}})
  }
  /**
   * Every Grok ACP session update stamps `_meta.totalTokens` with the current
   * bounded context size; it matches persisted `signals.contextTokensUsed`.
   * Emit only when it changes so streaming chunks do not flood the timeline.
   */
  private acceptGrokContextTick(meta: unknown): void {
    if (this.provider !== 'grok' || !this.native?.confirmed || this.replayingHistory || this.disposed) return
    if (!record(meta)) return
    const used = boundedTokenCount(meta.totalTokens)
    if (used === undefined) return
    const window = boundedTokenCount(meta.contextWindow)
    this.emitGrokContext({contextTokens:used, ...(window ? {contextWindow:window} : {})})
  }
  /** Read persisted context signals after resume/reconnect without slowing the turn. */
  private async refreshGrokContext(timeoutMs = 1500): Promise<void> {
    if (this.provider !== 'grok' || !this.native?.confirmed || this.disposed) return
    const connection = this.connection, sessionId = this.nativeSessionId
    if (!connection || !sessionId) return
    try {
      const value = await connection.request('_x.ai/session/state', { sessionId, cwd: this.config.workdir }, timeoutMs)
      if (this.disposed || this.connection !== connection || this.nativeSessionId !== sessionId) return
      const usage = stateContextUsage(value)
      if (usage) this.emitGrokContext(usage)
    } catch {
      // Context signals are optional; a failed state probe must not affect the turn.
    }
  }
  private onGrokNotification(message: ACPJsonRpcMessage): boolean {
    const params = message.params
    if (!record(params)) return false
    if (message.method === 'session/update' && params.sessionId !== this.nativeSessionId) {
      if (this.children.has(params.sessionId) && record(params.update)) {
        let history = this.childHistory.get(params.sessionId)
        if (!history) this.childHistory.set(params.sessionId,history = new ACPHistoryProjection('grok'))
        history.push(params.update,params._meta?.agentTimestampMs)
        const env = typeof this.extraEnv === 'function' ? this.extraEnv() : this.extraEnv
        void saveGrokChildHistory(this.nativeSessionId!,this.children.get(params.sessionId)!,history.events,env).catch(() => {})
      }
      return true
    }
    if (!['_x.ai/session_notification','_x.ai/session/update','_x.ai/session/prompt_complete'].includes(message.method || '')) return false
    const child = normalizeGrokSubagentNotification(params,Date.now()) || normalizeGrokSubagentNotification(params.update,Date.now())
    if (child) {
      if (params.sessionId !== this.nativeSessionId || child.parentThreadId !== this.nativeSessionId || !/^[\w-]{1,128}$/.test(child.agentThreadId) || !child.nativeTaskId || !/^[\w-]{1,128}$/.test(child.nativeTaskId)) return true
      const merged = mergeSubAgentSnapshot(this.children.get(child.agentThreadId),child,Date.now())
      this.children.set(child.agentThreadId,merged)
      this.emitEvent({type:'subagent',state:merged.status === 'running' ? 'running' : 'success',payload:{id:`grok-child-${child.agentThreadId}`,agents:[merged]}})
      return true
    }
    if (params.sessionId !== this.nativeSessionId) return true
    try { if (this.grokControls?.acceptNotification(message)) return true }
    catch (error) { this.goalUnknown = true; this.nativeFailure('goal',error); return true }
    const update = params.update
    if (update?.sessionUpdate === 'turn_completed') {
      this.emitGrokUsage(update.prompt_id,update.usage)
      return true
    }
    if (update?.sessionUpdate === 'image_dropped' && (this.running || this.controlExecution)) {
      const notes = Array.isArray(update.notes) ? update.notes.filter((note:any) => typeof note === 'string').slice(0,20).map((note:string) => note.slice(0,2000)).join('\n') : ''
      this.emitEvent({type:'system_notice',payload:{id:`${this.eventPrefix}-image-dropped-${this.activeTurn}`,kind:'warning',text:`本条消息存在图片未送达。${notes ? '\n'+notes : ''}`}})
    }
    return true
  }
  private onNotification(message: ACPJsonRpcMessage): void {
    if (this.provider === 'mcode' && message.method === 'mcode/session/goal_update') {
      // `mcode 0.6.12` does not send this notification, but newer builds may;
      // honouring it keeps the goal turn from relying on polling alone.
      if (message.params?.sessionId !== this.nativeSessionId) return
      const goal = this.projectMCodeGoal(message.params?.goal)
      this.publishMCodeGoal(goal)
      return
    }
    if (this.native?.confirmed && !this.connecting && this.onGrokNotification(message)) return
    if (message.method !== 'session/update' || !record(message.params?.update)) return
    if (this.connecting) {
      if (['available_commands_update','config_option_update','current_mode_update'].includes(message.params.update.sessionUpdate)) this.openingUpdates.push(message)
      return
    }
    if (message.params.sessionId !== this.nativeSessionId) return
    const update = message.params.update
    if (update.sessionUpdate === 'available_commands_update') { this.commands = Array.isArray(update.availableCommands) ? [...new Set<string>(update.availableCommands.map((x: any) => typeof x?.name === 'string' ? x.name.replace(/^\//,'') : '').filter(Boolean))] : []; this.updateContract({}); this.emit('contract',cloneContract(this.contract)); return }
    if (update.sessionUpdate === 'config_option_update') { this.updateContract({configOptions:update.configOptions}); if (!this.applyingConfig) this.syncNativeConfig(); this.emit('contract',cloneContract(this.contract)); return }
    if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') { if (this.response.modes) this.response.modes.currentModeId = update.currentModeId; this.updateContract({}); if (!this.applyingConfig) this.syncNativeConfig(); this.emit('contract',cloneContract(this.contract)); this.emit('collaborationModeChanged',update.currentModeId === 'plan' ? 'plan' : 'default'); return }
    if (this.controlExecution && !this.running && !this.cancelling && typeof message.params._meta?.promptId === 'string' &&
      ['agent_message_chunk','agent_thought_chunk','tool_call','tool_call_update'].includes(update.sessionUpdate)) {
      this.running = true; this.nativePromptId = message.params._meta.promptId
      this.emitEvent({type:'turn_started',payload:{id:`${this.eventPrefix}-turn-${this.activeTurn}`,threadId:this.nativeSessionId,nativePromptId:this.nativePromptId}})
    }
    this.acceptGrokContextTick(message.params._meta)
    if (!this.running || this.replayingHistory || this.cancelling) return
    if (typeof message.params._meta?.promptId === 'string') this.nativePromptId = message.params._meta.promptId
    if (update.sessionUpdate === 'usage_update') {
      const used = boundedTokenCount(update.used), size = boundedTokenCount(update.size)
      if (used !== undefined) this.emitGrokContext({contextTokens:used, ...(size ? {contextWindow:size} : {})})
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk') this.pushText('agent',contentText(update.content))
    else if (update.sessionUpdate === 'agent_thought_chunk') this.pushText('thought',contentText(update.content))
    else if (update.sessionUpdate === 'user_message_chunk') { this.settleText(); this.emitEvent({type:'user_message',state:'success',payload:{id:`${this.eventPrefix}-user-${++this.itemSerial}`,text:contentText(update.content)}}) }
    else if (['tool_call','tool_call_update'].includes(update.sessionUpdate)) { this.settleText(); this.pushTool(update) }
    else if (update.sessionUpdate === 'plan_update' || update.sessionUpdate === 'plan') { this.settleText(); this.emitEvent({type:'plan_update',state:'running',payload:{id:`plan-${this.eventPrefix}-${this.activeTurn}`,steps:(Array.isArray(update.entries) ? update.entries : []).map((x: any) => ({text:String(x?.content || x?.text || ''),status:['completed','in_progress'].includes(x?.status) ? x.status : 'pending'}))}}) }
    else if (update.sessionUpdate === 'plan_removed') { this.settleText(); this.emitEvent({type:'plan_update',state:'success',payload:{id:`plan-${this.eventPrefix}-${this.activeTurn}`,steps:[]}}) }
    else if (update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' && update.title) { this.emitEvent({type:'system_notice',payload:{id:`${this.eventPrefix}-title-${++this.itemSerial}`,kind:'info',text:`会话标题：${update.title}`}}) }
  }
  private onRequest(connection: ACPConnection, message: ACPJsonRpcMessage): void {
    if (message.id === undefined) return
    if (message.method === 'elicitation/create') { this.handleElicitation(connection, message); return }
    const childId = typeof message.params?.sessionId === 'string' && this.children.get(message.params.sessionId)?.status === 'running' ? message.params.sessionId : undefined
    const owned = connection === this.connection && !this.cancelling && !this.connecting && ((this.running || !!this.controlExecution) && message.params?.sessionId === this.nativeSessionId || !!childId)
    if (message.method === '_x.ai/ask_user_question' && grokCapabilityAvailable(this.native,'questions')) {
      const params = message.params, questions = params?.questions
      const valid = owned && params.mode === 'default' && typeof params.toolCallId === 'string' && params.toolCallId.length > 0 && params.toolCallId.length <= 256 && Array.isArray(questions) && questions.length > 0 && questions.length <= 20 &&
        questions.every((q:any) => record(q) && typeof q.question === 'string' && q.question.trim().length > 0 && q.question.length <= 65536 &&
          (q.multiSelect == null || typeof q.multiSelect === 'boolean') &&
          (q.options === undefined || Array.isArray(q.options) && q.options.length <= 100 && q.options.every((o:any) => record(o) && typeof o.label === 'string' && o.label.length > 0 && o.label.length <= 4096) && new Set(q.options.map((o:any) => o.label)).size === q.options.length)) &&
        new Set(questions.map((q:any) => q.question)).size === questions.length && this.pending.size < 32
      if (!valid) { connection.respond(message.id,{outcome:'cancelled'}); this.emitEvent({type:'system_notice',payload:{kind:'warning',text:'Grok 提问已取消：请求格式、模式或会话归属无法确认。'}}); return }
      const requestId = `${this.eventPrefix}_${this.activeTurn}_${++this.itemSerial}`
      const fields = normalizeQuestions('grok',params)
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (!pending || pending.connection !== this.connection) return
        try { pending.connection.respond(pending.rpcId,{outcome:'cancelled'}) } catch {}
        this.pending.delete(requestId)
        this.emitEvent({type:'approval_request',state:'cancelled',payload:{requestId,resolved:true}})
      },300_000)
      timer.unref?.()
      this.pending.set(requestId,{rpcId:message.id,connection,turn:this.activeTurn,optionIds:new Set(),kind:'question',fields,timer,childId})
      this.questionTools.add(params.toolCallId)
      this.emitEvent({type:'approval_request',state:'pending',payload:{id:requestId,requestId,kind:'question',method:message.method,params,...(childId ? {childSessionId:childId} : {})}})
      return
    }
    if (message.method !== 'session/request_permission') { connection.respondError(message.id,-32601,'Unsupported ACP client method'); return }
    const params = message.params, options = Array.isArray(params?.options) ? params.options : []
    if (!owned || !record(params.toolCall) || typeof params.toolCall.toolCallId !== 'string' || !options.length || options.some((x: any) => typeof x?.optionId !== 'string' || !x.optionId) || new Set(options.map((x: any) => x.optionId)).size !== options.length) { connection.respondError(message.id,-32602,'Invalid or inactive permission request'); return }
    if (this.config.permissionMode === 'full-access') { const allow = options.find((x: any) => x.kind === 'allow_once'); connection.respond(message.id,{outcome:allow ? {outcome:'selected',optionId:allow.optionId} : {outcome:'cancelled'}}); return }
    const requestId = `${this.eventPrefix}_${this.activeTurn}_${++this.itemSerial}`
    this.pending.set(requestId,{rpcId:message.id,connection,turn:this.activeTurn,optionIds:new Set(options.map((x: any) => x.optionId)),kind:'permission',childId})
    const tool = {...this.toolStateById.get(params.toolCall.toolCallId),...params.toolCall}
    this.emitEvent({type:'approval_request',state:'pending',payload:{id:requestId,requestId,kind:tool.kind === 'execute' ? 'command' : tool.kind === 'edit' ? 'fileChange' : 'permission',method:message.method,params:tool,options}})
  }
  private pushText(kind: 'agent' | 'thought', delta: string): void {
    if (!delta) return
    if (this.textKind !== kind) { this.settleText(); this.textKind = kind; this.textId = `${this.eventPrefix}-${kind}-${++this.itemSerial}` }
    this.text += delta; this.emitEvent({type:kind === 'agent' ? 'agent_message' : 'reasoning',state:'running',payload:{id:this.textId,text:this.text,delta}})
  }
  private pushTool(update: Record<string,any>): void {
    if (typeof update.toolCallId !== 'string') return
    const merged = {...this.toolStateById.get(update.toolCallId),...update}
    if (this.provider === 'deepseek' && merged.kind === 'other' && merged.title === 'bash') merged.kind = 'execute'
    this.toolStateById.set(update.toolCallId,merged)
    if (this.questionTools.has(update.toolCallId) && ['completed','failed'].includes(merged.status)) {
      this.questionTools.delete(update.toolCallId)
      if (merged.status === 'failed') this.emitEvent({type:'system_notice',payload:{kind:'warning',text:'Grok 提问工具未接受回复，请查看工具错误后继续。'}})
    }
    if (!merged.kind && merged.status == null && merged.content == null && merged.rawInput == null && merged.rawOutput == null) return
    const projected = projectACPTool(merged,this.provider); if (projected) this.emitEvent(projected)
  }
  private resetText(): void { this.textKind = null; this.text = ''; this.textId = '' }
  private settleText(): void { if (this.textKind && this.text) this.emitEvent({type:this.textKind === 'agent' ? 'agent_message' : 'reasoning',state:'success',payload:{id:this.textId,text:this.text}}); this.resetText() }
  private retirePending(state: 'failed' | 'cancelled'): void {
    for (const [requestId,pending] of this.pending) { clearTimeout(pending.timer); try { pending.connection.respond(pending.rpcId,pending.kind === 'question' ? {outcome:'cancelled'} : pending.kind === 'elicitation' ? {action:'cancel'} : {outcome:{outcome:'cancelled'}}) } catch {} this.emitEvent({type:'approval_request',state,payload:{requestId,resolved:true}}) }
    this.pending.clear()
  }
  private ownsTurn(turn: number): boolean { return this.running && this.activeTurn === turn }
  private finish(outcome: 'success' | 'failed' | 'cancelled',turn: number,authRequired = false): void {
    if (!this.ownsTurn(turn)) return
    this.stopWatchingMCodeGoal()
    this.promptTurnId = undefined
    if (this.cancelTimer) clearTimeout(this.cancelTimer); this.cancelTimer = null
    this.retirePending(outcome === 'success' ? 'cancelled' : outcome); this.running = false; this.cancelling = false; this.settleText()
    this.emitEvent({type:'turn_completed',state:outcome,payload:{id:`${this.eventPrefix}-turn-${turn}`}})
    this.emit('done',{nativeSessionId:this.nativeSessionId,interrupted:outcome === 'cancelled',failed:outcome === 'failed',authRequired})
  }
  private emitKimiAuthError(error: unknown): void {
    const id = `kimi-auth-${this.activeTurn}`
    const render = (state: KimiLoginState): void => this.emitEvent({
      type: 'error',
      state: 'failed',
      payload: {
        id,
        message: 'Kimi Code 登录已失效',
        authLogin: true,
        authStatus: state.status,
        ...(state.url ? { loginUrl: state.url } : {}),
        ...(state.message ? { loginError: state.message } : {}),
        detail: error instanceof Error ? error.message : String(error)
      }
    })
    let unsubscribe = (): void => {}
    const env = typeof this.extraEnv === 'function' ? this.extraEnv() : this.extraEnv
    unsubscribe = startKimiLogin(this.agent.bin, env.KIMI_CODE_HOME).subscribe((state) => {
      if (!this.disposed) render(state)
      if (state.status === 'success' || state.status === 'failed') {
        unsubscribe()
        this.authLoginUnsubscribes.delete(unsubscribe)
      }
    })
    this.authLoginUnsubscribes.add(unsubscribe)
  }

  private emitEvent(event: Omit<UAEvent,'sessionId' | 'seq' | 'ts'>): void { this.emit('event',{...event,sessionId:this.sessionId,seq:this.seqRef.n++,ts:Date.now()} satisfies UAEvent) }
}
export async function probeGrokACP(
  bin = 'grok',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ status: 'uninstalled' | 'incompatible' | 'needs-auth' | 'ready'; path?: string; version?: string; contract?: GrokACPContract; reason?: string }> {
  let path = bin
  if (!isAbsolute(bin)) {
    try {
      path = await findAgentExecutable(bin, { ...process.env, ...extraEnv }) || ''
      if (!path) return { status: 'uninstalled', reason: `${bin} 未找到` }
    } catch {
      return { status: 'incompatible', path: bin, reason: 'Grok 程序路径无法访问，请检查权限后重新检测' }
    }
  }
  let version = 'unknown'
  try {
    version = (await execFileP(path, ['--no-auto-update','--version'], { timeout: 8000, env: { ...process.env, ...extraEnv } })).stdout.trim().split('\n')[0]
  } catch {}
  const agent: AgentDef = {
    id: 'grok', name: 'Grok', bin: path, adapter: 'grok', icon: 'grok', builtin: true,
    capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: GROK_PERMISSION_MODES },
    models: []
  }
  const temporary = await mkdtemp(join(tmpdir(), 'uniagent-grok-probe-'))
  const home = join(temporary, 'grok')
  await mkdir(home, { mode: 0o700 })
  const nativeHome = extraEnv.GROK_HOME || process.env.GROK_HOME || join(extraEnv.HOME || process.env.HOME || homedir(), '.grok')
  let runner: GrokACPRunner | undefined
  try {
    for (const name of ['auth.json', 'config.toml']) {
      try { await cp(join(nativeHome, name), join(home, name)); await chmod(join(home, name), 0o600) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    runner = new GrokACPRunner('grok-probe', { n: 0 }, agent, {
      agentId: 'grok', permissionMode: 'ask', workdir: temporary
    }, undefined, { ...extraEnv, GROK_HOME: home })
    const probed = await runner.probeSession()
    return { status: 'ready', path, version, contract: probed.contract }
  } catch (error: any) {
    const needsAuth = error instanceof ACPRemoteError && /authentication required|not authenticated|invalid api key/i.test(error.remoteMessage || error.message)
    const reason = needsAuth ? 'Grok 连接需要认证，请登录或配置 API Key'
      : error instanceof ACPTimeoutError ? 'Grok 检测超时，请检查服务与网络后重试'
      : `Grok 协议或服务检测失败${error instanceof ACPRemoteError ? `（错误码 ${error.code}）` : ''}，请检查程序版本、权限与配置后重试`
    return { status: needsAuth ? 'needs-auth' : 'incompatible', path, version, reason }
  } finally {
    await runner?.disposeAndWait()
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

export async function probeKimiACP(
  bin = 'kimi',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ status: 'uninstalled' | 'incompatible' | 'needs-auth' | 'ready'; path?: string; version?: string; contract?: GrokACPContract; reason?: string }> {
  let path = bin
  if (!isAbsolute(bin)) {
    try {
      path = (await execFileP('/usr/bin/which', [bin], { timeout: 5000, env: { ...process.env, ...extraEnv } })).stdout.trim().split('\n')[0]
    } catch {
      return { status: 'uninstalled', reason: `${bin} 不在 PATH 中` }
    }
  }
  let version = 'unknown'
  try {
    version = (await execFileP(path, ['--version'], { timeout: 8000, env: { ...process.env, ...extraEnv } })).stdout.trim().split('\n')[0]
  } catch {}
  const agent: AgentDef = {
    id: 'kimi', name: 'Kimi Code', bin: path, adapter: 'kimi', icon: 'kimi', builtin: true,
    capabilities: { modelSelect: true, reasoningEffort: false, permissionModes: KIMI_PERMISSION_MODES, protocol: 'acp' },
    models: []
  }
  const runner = new GrokACPRunner(`kimi-probe-${randomUUID()}`, { n: 0 }, agent, {
    agentId: 'kimi', permissionMode: 'ask', workdir: cwd || process.cwd()
  }, undefined, extraEnv)
  let createdSessionId: string | undefined
  try {
    const probed = await runner.probeSession()
    createdSessionId = probed.nativeSessionId
    return { status: 'ready', path, version, contract: probed.contract }
  } catch (error: any) {
    const message = String(error?.message || error)
    const needsAuth = isKimiAuthorizationError(error) || (
      error instanceof ACPRemoteError && isKimiAuthorizationError(error.remoteMessage)
    )
    return { status: needsAuth ? 'needs-auth' : 'incompatible', path, version, reason: message }
  } finally {
    await runner.disposeAndWait()
    if (createdSessionId) await deleteKimiSession(createdSessionId, path, cwd, extraEnv).catch(() => undefined)
  }
}

function grokHistoryArgs(): string[] { return ['--no-auto-update', 'agent', '--no-leader', 'stdio'] }

function newGrokHistoryConnection(
  bin: string,
  cwd: string | undefined,
  extraEnv: NodeJS.ProcessEnv
): ACPConnection {
  return new ACPConnection({
    bin,
    args: grokHistoryArgs(),
    cwd,
    env: { ...process.env, ...nativeCredentialEnv('grok'), ...extraEnv },
    providerLabel: 'Grok',
    validateInitialize: (value) => validateACPInitialize(value, 'Grok')
  })
}

function newKimiHistoryConnection(
  bin: string,
  cwd: string | undefined,
  extraEnv: NodeJS.ProcessEnv
): ACPConnection {
  return new ACPConnection({
    bin,
    args: ['acp'],
    cwd,
    env: { ...process.env, ...extraEnv },
    providerLabel: 'Kimi Code',
    validateInitialize: (value) => validateACPInitialize(value, 'Kimi Code')
  })
}

function grokUpdatedAt(value: unknown): number {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

async function listAllGrokSessions(
  connection: ACPConnection,
  cwd?: string
): Promise<any[]> {
  const sessions: any[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  do {
    const result = await connection.request('session/list', {
      ...(cwd ? { cwd } : {}),
      ...(cursor ? { cursor } : {})
    })
    if (!record(result) || !Array.isArray(result.sessions)) {
      throw new Error('Grok session/list 返回了无效会话列表')
    }
    sessions.push(...result.sessions)
    const next = typeof result.nextCursor === 'string' && result.nextCursor
      ? result.nextCursor
      : undefined
    if (next && seenCursors.has(next)) throw new Error('Grok session/list 返回了重复 cursor')
    if (next) seenCursors.add(next)
    cursor = next
  } while (cursor)
  return sessions
}

/** ACP-only Grok history listing; never reads Grok's private session store. */
export async function listGrokSessions(
  bin = 'grok',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<SessionSummary[]> {
  if (cwd !== undefined && (!cwd || !isAbsolute(cwd) || cwd.includes(String.fromCharCode(0)))) {
    throw new Error('Grok session/list cwd 必须是绝对路径')
  }
  const connection = newGrokHistoryConnection(bin, cwd, extraEnv)
  try {
    const initialize = await connection.initialize()
    if (!initialize.agentCapabilities?.sessionCapabilities?.list) return []
    const rows = await listAllGrokSessions(connection, cwd)
    return rows
      .filter((row) => record(row) && typeof row.sessionId === 'string' && row.sessionId)
      .map((row) => ({
        id: row.sessionId,
        title: typeof row.title === 'string' && row.title ? row.title : '(Grok 会话)',
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        updatedAt: grokUpdatedAt(row.updatedAt),
        agentId: 'grok'
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  } finally {
    await connection.closeAndWait()
  }
}

/**
 * ACP-only MiniMax Code history listing.
 *
 * The CLI is queried through `session/list` only — UniAgent never reads the
 * MiniMax Code session store directly.
 */
export async function listMCodeSessions(
  bin = 'mcode',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<SessionSummary[]> {
  if (cwd !== undefined && (!cwd || !isAbsolute(cwd) || cwd.includes(String.fromCharCode(0)))) {
    throw new Error('MiniMax Code session/list cwd 必须是绝对路径')
  }
  const connection = new ACPConnection({
    bin,
    args: acpLaunchArgs('mcode', {} as SessionConfig),
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...extraEnv },
    providerLabel: 'mcode',
    validateInitialize: v => validateACPInitialize(v, 'mcode')
  })
  try {
    const initialize = await connection.initialize()
    if (!initialize.agentCapabilities?.sessionCapabilities?.list) return []
    const rows = await listAllGrokSessions(connection, cwd)
    return rows
      .filter((row) => record(row) && typeof row.sessionId === 'string' && row.sessionId)
      .map((row) => ({
        id: row.sessionId,
        title: typeof row.title === 'string' && row.title ? row.title : '(MiniMax Code 会话)',
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        updatedAt: grokUpdatedAt(row.updatedAt),
        agentId: 'mcode'
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  } finally {
    await connection.closeAndWait()
  }
}

export async function forkMCodeSession(id: string, bin: string, cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ nativeId: string; cwd: string; model?: string }> {
  if (!id || id.includes('\0') || !isAbsolute(cwd)) throw new Error('MiniMax Code 分叉会话或工作目录无效')
  const connection = new ACPConnection({ bin, args: acpLaunchArgs('mcode', {} as SessionConfig), cwd,
    env: { ...process.env, ...env }, providerLabel: 'MiniMax Code', validateInitialize: v => validateACPInitialize(v, 'MiniMax Code') })
  try {
    const initialize = await connection.initialize()
    if (!advertisedACPCapability(initialize.agentCapabilities?.sessionCapabilities?.fork)) throw unsupported()
    const response = await connection.request('session/fork', { sessionId: id, cwd, mcpServers: [] })
    if (typeof response?.sessionId !== 'string' || !response.sessionId || response.sessionId === id) throw new Error('MiniMax Code 未返回独立分叉会话')
    return { nativeId: response.sessionId, cwd, model: acpOption(response, 'model')?.currentValue }
  } finally { await connection.closeAndWait() }
}

/** Replay one MiniMax Code session through official ACP session/load. */
export async function loadMCodeSessionEvents(
  id: string,
  bin = 'mcode',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: SessionConfig['effort'] }> {
  return loadStableSessionEvents('mcode', id, bin, cwd, extraEnv)
}

/** ACP-only Kimi history listing. Kimi 2.0.2 does not consume list cursors. */
export async function listKimiSessions(
  bin = 'kimi',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<SessionSummary[]> {
  if (cwd !== undefined && (!cwd || !isAbsolute(cwd) || cwd.includes(String.fromCharCode(0)))) {
    throw new Error('Kimi session/list cwd 必须是绝对路径')
  }
  const connection = newKimiHistoryConnection(bin, cwd, extraEnv)
  try {
    const initialize = await connection.initialize()
    if (!initialize.agentCapabilities?.sessionCapabilities?.list) return []
    const result = await connection.request('session/list', cwd ? { cwd } : {})
    if (!record(result) || !Array.isArray(result.sessions)) throw new Error('Kimi session/list 返回了无效会话列表')
    return result.sessions
      .filter((row: any) => record(row) && typeof row.sessionId === 'string' && row.sessionId)
      .map((row: any) => ({
        id: row.sessionId,
        title: typeof row.title === 'string' && row.title ? row.title : '(Kimi 会话)',
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        updatedAt: grokUpdatedAt(row.updatedAt),
        agentId: 'kimi'
      }))
      .sort((left: SessionSummary, right: SessionSummary) => right.updatedAt - left.updatedAt)
  } finally {
    await connection.closeAndWait()
  }
}

/** Replay one Grok session through ACP session/load. */
export async function loadGrokSessionEvents(
  id: string,
  bin = 'grok',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: string; contextWindow?: number }> {
  return loadStableSessionEvents('grok',id,bin,cwd,extraEnv)
}
async function loadStableSessionEvents(provider: ACPProvider,id: string,bin: string,cwd?: string,extraEnv: NodeJS.ProcessEnv = {}): Promise<{events:UAEvent[];cwd?:string;model?:string;effort?:SessionConfig['effort']}> {
  if (!id || id.includes(String.fromCharCode(0))) throw new Error('Grok sessionId 无效')
  const connection = new ACPConnection({bin,args:acpLaunchArgs(provider,{} as SessionConfig),cwd:cwd || process.cwd(),env:{...process.env,...(provider === 'grok' ? nativeCredentialEnv('grok') : {}),...extraEnv},providerLabel:provider,validateInitialize:v => validateACPInitialize(v,provider)})
  const projection = new ACPHistoryProjection(provider)
  let loading = false
  let replayedContextTokens: number | undefined
  connection.on('notification', (message: ACPJsonRpcMessage) => {
    if (!loading || message.params?.sessionId !== id) return
    const replayTokens = boundedTokenCount(message.params._meta?.totalTokens)
    if (replayTokens !== undefined) replayedContextTokens = replayTokens
    // The Grok extension closes replayed turns only; live turns still follow session/prompt.
    const completion = provider === 'grok' && ['_x.ai/session/update','_x.ai/session_notification'].includes(message.method || '') && ['turn_completed','image_dropped'].includes(message.params.update?.sessionUpdate)
    if (message.method !== 'session/update' && !completion) return
    if (record(message.params.update)) projection.push(message.params.update, provider === 'grok' ? message.params._meta?.agentTimestampMs : undefined)
  })
  connection.on('request', (message: ACPJsonRpcMessage) => {
    if (message.id !== undefined) connection.respondError(message.id, -32601, 'History replay is read-only')
  })
  try {
    const initialize = await connection.initialize()
    if (initialize.agentCapabilities?.loadSession !== true) {
      throw new Error('Grok ACP 未声明 session/load')
    }
    const canList = advertisedACPCapability(initialize.agentCapabilities?.sessionCapabilities?.list)
    const row = canList ? (await listAllGrokSessions(connection, cwd)).find((entry) => entry?.sessionId === id) : undefined
    if (canList && !row) throw new Error(`${provider} 会话不存在：${id}`)
    const sessionCwd = cwd || row?.cwd || process.cwd()
    loading = true
    let response: any
    try {
      response = await connection.request('session/load', {
        sessionId: id,
        cwd: sessionCwd,
        mcpServers: []
      })
    } finally {
      loading = false
    }
    const modelOption = acpOption(response, 'model')
    // Grok's replayed usage footer is the turn's cumulative spend, not the
    // window occupancy. Replayed updates stamp the bounded context in `_meta`;
    // persisted signals are the fallback for versions that omit it. Both are
    // trusted only on the version whose semantics were verified.
    if (provider === 'grok' && grokNativeHandshake(initialize).confirmed) {
      let contextUsage: GrokContextUsage | undefined = replayedContextTokens === undefined ? undefined : { contextTokens: replayedContextTokens }
      if (contextUsage === undefined) {
        try {
          contextUsage = stateContextUsage(await connection.request('_x.ai/session/state', { sessionId: id, cwd: sessionCwd }, 3000))
        } catch {
          // Context signals are optional; history must still load without them.
        }
      }
      if (contextUsage) {
        const previous = projection.events.at(-1)
        const ts = typeof previous?.ts === 'number' && previous.ts > 0 ? previous.ts : Date.now()
        projection.events.push({ ...grokContextEvent(`grok-history-context-${id}`, contextUsage, modelOption?.currentValue, ts), seq: projection.events.length })
      }
    }
    if (provider === 'grok') await materializeGrokHistoryImages(projection.events,extraEnv)
    return {
      events: projection.events,
      cwd: typeof row?.cwd === 'string' ? row.cwd : cwd,
      model: modelOption?.currentValue,
      effort: acpOption(response, 'thought_level')?.currentValue
    }
  } finally {
    await connection.closeAndWait()
  }
}

/** Strict native deletion: caller removes local state only after this resolves. */
export async function deleteGrokSession(
  id: string,
  bin = 'grok',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<void> {
  if (!id || id.includes(String.fromCharCode(0))) throw new Error('Grok sessionId 无效')
  const connection = newGrokHistoryConnection(bin, cwd, extraEnv)
  try {
    const initialized = await connection.initialize()
    if (advertisedACPCapability(initialized.agentCapabilities?.sessionCapabilities?.delete)) await connection.request('session/delete', { sessionId:id })
  } finally { await connection.closeAndWait() }
}

export async function deleteKimiSession(
  id: string,
  bin = 'kimi',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<void> {
  if (!id || id.includes(String.fromCharCode(0))) throw new Error('Kimi sessionId 无效')
  const connection = newKimiHistoryConnection(bin, cwd, extraEnv)
  try {
    const initialize = await connection.initialize()
    if (!initialize.agentCapabilities?.sessionCapabilities?.delete) {
      return
    }
    await connection.request('session/delete', { sessionId: id })
  } finally {
    await connection.closeAndWait()
  }
}


/** History is available only when the official ACP server declares it. */
export async function listDeepSeekSessions(bin: string,cwd?: string,env: NodeJS.ProcessEnv = {}): Promise<SessionSummary[]> {
  const connection = new ACPConnection({bin,args:['--profile','acp'],cwd:cwd || process.cwd(),env:{...process.env,...env},providerLabel:'DeepSeek Harness',validateInitialize:v => validateACPInitialize(v,'DeepSeek Harness')})
  try {
    const initialized = await connection.initialize()
    if (!advertisedACPCapability(initialized.agentCapabilities?.sessionCapabilities?.list)) return []
    return (await listAllGrokSessions(connection,cwd)).filter(x => typeof x?.sessionId === 'string').map(x => ({id:x.sessionId,title:x.title || '(DeepSeek 会话)',cwd:x.cwd,updatedAt:grokUpdatedAt(x.updatedAt),agentId:'deepseek'}))
  } finally { await connection.closeAndWait() }
}
export async function loadDeepSeekSessionEvents(id: string,bin: string,cwd?: string,env: NodeJS.ProcessEnv = {}): Promise<{events:UAEvent[];cwd?:string;model?:string;effort?:SessionConfig['effort'];contextWindow?:number}> { return loadStableSessionEvents('deepseek',id,bin,cwd,env) }
export async function forkDeepSeekSession(_id: string,_bin: string,_cwd: string,_env: NodeJS.ProcessEnv = {},_seq?: number,_options: {model?:string;effort?:SessionConfig['effort'];mcpServers?:ReturnType<typeof handoffMcpServers>;point?:import('../shared/types.ts').HistoryForkPoint} = {}): Promise<{nativeId:string;cwd?:string;model?:string;effort?:SessionConfig['effort']}> { throw unsupported() }
export async function inspectDeepSeekInventory(_bin: string,_cwd: string,_env: NodeJS.ProcessEnv = {}): Promise<any> { throw unsupported() }
