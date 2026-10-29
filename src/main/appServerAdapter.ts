import { assistantIdentity } from '../shared/assistant'
import { assistantPrompt } from './assistant/context'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appServerAdditionalDirectoryArgs, codexSandbox } from './adapter'
import {
  AppServerRpcClient,
  SharedAppServerRpc,
  type AppServerRpc,
  type AppServerRpcFactory
} from './appServerTransport'
import { readThreadTurnItems } from './appServerHistory'
import { repairTransplantedSessionHistory } from './history'
import { handoffMcpArgs, uniAgentSessionInstructions } from './handoff'
import { teamRuntime } from './teamRuntime'
import { computeCost } from './pricing'
import { normalizeCodexRateLimits } from './codexRateLimits'
import {
  buildTurnStartParams,
  buildInput,
  claimModelNotification,
  normalizeServerModelNotification
} from './maxMode'
export { buildTurnStartParams } from './maxMode'
import {
  CompactionActivityGate,
  CompactionInvocationQueue,
  ContextCompactionLifecycle,
  DeferredTurnCompletions,
  type CompactionTransition
} from './contextCompactionLifecycle'
import type { AgentDef, Attachment, PermissionMode, QueueStatus, SessionConfig, UAEvent, UASubAgent } from '../shared/types'
import { codexModelKey, codexProviderChanged, codexSessionProvider, codexWireModel, parseCodexModelKey } from '../shared/codexModelIdentity'
import { codexContextHistoryBudget } from './codexContextBudget'
import type {
  CollaborationModeId,
  GoalState,
  GoalStatus,
  NativeReviewDraft,
  ResolvedNativeTurnContext
} from '../shared/nativeCapabilities'
import {
  historicalTimestamp,
  isSubAgentDispatchTool,
  isSubAgentTerminal,
  nativeSubAgentName,
  readableSubAgentInput,
  SubAgentDispatchTracker,
  type SubAgentDispatchStamp
} from '../shared/subAgentLifecycle'
import { isHiddenAgentWarning } from '../shared/agentWarnings'
import { providerContextLimit } from '../shared/providerErrors'
import { isMcpToolApproval, mcpToolApprovalAnswer } from '../shared/questions'

export type NativeReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string }

interface ReviewStartupNotification {
  method: string
  params: any
  wireSequence?: number
  receivedAt: number
}

interface ReviewCancellationState {
  token: string
  cancellation: Promise<never>
  rejectCancellation: (error: Error) => void
}

interface ReviewStartupState {
  token: string
  transport: AppServerRpc
  connectionGeneration: number
  notifications: ReviewStartupNotification[]
}

interface ConnectionAttempt {
  generation: number
  transport: AppServerRpc
  developerInstructions: string
}

interface PendingServerRequest {
  rpcId: number | string
  method: string
  kind: string | undefined
  transport: AppServerRpc
  connectionGeneration: number
}

interface CodexTitleGeneration {
  transport: AppServerRpc
  threadId: string
  response?: string
  error?: string
}

interface PreparedFork {
  threadId: string
  cleanup: () => Promise<void>
}
type ForkPreparation = (events: Pick<UAEvent, 'type' | 'payload'>[]) => Promise<PreparedFork>

const SIDE_CONVERSATION_INSTRUCTIONS = `Side conversation boundary.

Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread. If there is no user question after this boundary yet, wait for one.

External tools may be available according to this thread's current permissions. Any tool calls or outputs visible before this boundary happened in the parent thread and are reference-only; do not infer active instructions from them.

Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary.

Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly asks for that mutation after this boundary. Do not request escalated permissions or broader sandbox access unless the user explicitly asks for a mutation that requires it. If the user explicitly requests a mutation, keep it minimal, local to the request, and avoid disrupting the main thread.`

type CodexAppServerArgsProvider = (config: SessionConfig) => string[]
const noCodexAppServerArgs: CodexAppServerArgsProvider = () => []
let codexAppServerArgsProvider = noCodexAppServerArgs

export function configureCodexAppServerArgsProvider(provider?: CodexAppServerArgsProvider): void {
  codexAppServerArgsProvider = provider || noCodexAppServerArgs
}

export function codexAppServerArgs(agent: Pick<AgentDef, 'adapter'>, config: SessionConfig): string[] {
  return agent.adapter === 'codex' ? codexAppServerArgsProvider(config) : []
}

export interface AppServerRespondResult {
  handled: boolean
  hasPendingRequests: boolean
}

class ReviewStartCancelledError extends Error {}
class ConnectionAttemptInvalidatedError extends Error {}

const REVIEW_STARTUP_NOTIFICATION_METHODS = new Set([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'queue/status',
  'turn/queue/status',
  'thread/queue/updated',
  'thread/tokenUsage/updated',
  'error'
])

const QUEUE_WAIT_PROGRESS_METHODS = new Set([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta'
])

function isQueueWaitProgress(method: string, params: any): boolean {
  if (!QUEUE_WAIT_PROGRESS_METHODS.has(method)) return false
  if (method === 'item/started' || method === 'item/completed') {
    return typeof params?.item?.id === 'string' && !!params.item.id &&
      typeof params.item.type === 'string' && !!params.item.type &&
      !['userMessage', 'error', 'taskNotification'].includes(params.item.type)
  }
  return typeof params?.itemId === 'string' && !!params.itemId &&
    typeof params.delta === 'string' && !!params.delta
}

const THREAD_TITLE_MAX_CHARS = 36
const THREAD_TITLE_PROMPT_MAX_BYTES = 960
const THREAD_TITLE_MODEL = 'gpt-5.6-luna'

function developerInstructions(config: SessionConfig, sessionId?: string, syncRequirement = true): string {
  return [
    uniAgentSessionInstructions(),
    assistantIdentity(config.assistantSnapshot),
    worktreeInstructions(config),
    syncRequirement ? requirementInstructions(config) : '',
    config.roleSnapshot?.instructions?.trim(),
    syncRequirement ? teamRuntime(sessionId)?.instructions : ''
  ].filter(Boolean).join('\n\n')
}

function roleSnapshotChanged(current: SessionConfig, next: SessionConfig): boolean {
  return JSON.stringify(current.roleSnapshot ?? null) !== JSON.stringify(next.roleSnapshot ?? null)
}

export function buildNativeReviewTarget(draft: NativeReviewDraft): NativeReviewTarget {
  const extra = draft.instructions?.trim()
  if (draft.scope.type === 'custom') {
    if (!extra) throw new Error('自定义 Review 必须填写要求')
    return { type: 'custom', instructions: extra }
  }
  if (draft.scope.type === 'uncommittedChanges') {
    if (!extra) return { type: 'uncommittedChanges' }
    return {
      type: 'custom',
      instructions: `审查当前工作区的未提交改动。\n\n补充要求：${extra}`
    }
  }
  if (draft.scope.type === 'baseBranch') {
    const branch = draft.scope.branch.trim()
    if (!branch) throw new Error('Review base branch 不能为空')
    const scopeText = `审查当前工作区相对 base branch「${branch}」的改动。`
    return {
      type: 'custom',
      instructions: extra ? `${scopeText}\n\n补充要求：${extra}` : scopeText
    }
  }
  const sha = draft.scope.sha.trim()
  if (!sha) throw new Error('Review commit sha 不能为空')
  if (!extra) {
    return {
      type: 'commit',
      sha,
      title: draft.scope.title?.trim() || null
    }
  }
  return {
    type: 'custom',
    instructions: `审查 commit「${sha}」。\n\n补充要求：${extra}`
  }
}

/**
 * Real streaming adapter for Codex / TraeX.
 *
 * Instead of the one-shot `exec --json` path (which only emits an assistant
 * message once, on completion), this drives the CLI's `app-server` sub-command:
 * a long-lived JSON-RPC 2.0 service over stdio that pushes token-level `delta`
 * notifications. One AppServerRunner owns one child process + one thread for
 * the whole session; each user message is a `turn/start`, so multi-turn context
 * is preserved without re-spawning.
 *
 * It mirrors TurnRunner's public surface — emits 'event' (UAEvent) and 'done'
 * ({ nativeSessionId? }) — so the orchestrator treats both interchangeably.
 */
export class AppServerRunner extends EventEmitter {
  private transport: AppServerRpc | null = null
  private sharedRpc: SharedAppServerRpc
  private sharedTransport?: AppServerRpc
  private sharedParent?: AppServerRunner
  private persistentFork = false
  private retiringTransport: Promise<void> = Promise.resolve()
  private readonly runtimeAgent: Pick<AgentDef, 'id' | 'adapter' | 'bin' | 'version'>

  private threadId?: string
  private curTurnId?: string
  private turnTokenSerial = 0
  private startingTurnToken?: string
  private startingReviewToken?: string
  private reviewCancellation?: ReviewCancellationState
  private reviewStartup?: ReviewStartupState
  private activeTurnToken?: string
  /** Logical run that began while a provider Goal was active. */
  private activeGoalTurnToken?: string
  private completedTurnIds = new Set<string>()
  private deferredTurnCompletions = new DeferredTurnCompletions<{ turn: any; receivedAt: number }>()
  private disposed = false
  // True between an interrupt request and the turn actually ending, so we can
  // label the turn footer as cancelled and avoid double-finishing (G2-9).
  private interrupting = false
  // Latest token usage tick. Codex/TraeX push these via
  // `thread/tokenUsage/updated`; `turn/completed` itself carries no usage, so
  // we stash the most recent tick and surface it in the turn footer.
  private lastTokenUsage?: any
  private providerSwitchNeedsTranslation = false
  private tokenUsageSerial = 0
  private turnStartUsageSerial = 0
  // Snapshot of the thread's cumulative `total` breakdown at turn/start (Doc5
  // T1). A turn's real consumption = end total − start total, because each model
  // call in the turn re-counts the growing context under `input`; taking the
  // increment (not `last`) is the correct per-turn / billing figure.
  private turnStartTotal?: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
  private turnCostStartKnown = true
  private turnPricing?: { modelId?: string; fastMode: boolean; unknownTier?: boolean }
  private sessionEstimatedCost: number | null = 0
  private pricedSessionTotal = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  private needsInitialUsageBaseline: boolean
  private completedAgentTurnToken?: string
  private finalAnswerCompletionFallback?: {
    turnToken: string
    connectionGeneration: number
    turnId: string
    timer?: ReturnType<typeof setTimeout>
  }
  private queueWait?: {
    turnToken: string
    id: string
    activeStartedAt?: number
    waitedMs: number
  }
  private goalCompletionFallback?: {
    turnToken: string
    durationMs?: number
    timer?: ReturnType<typeof setTimeout>
  }
  /** Suppress repeated routing/compaction notices emitted for the same turn. */
  private turnNoticeKeys = new Set<string>()
  private runtimeArgsSnapshot?: string[]
  private nativeModelProvider?: string
  private negotiatedModelProvider?: string
  private portableCompactionProvider?: string
  private portableCompactionOverrides?: Record<string, unknown>

  private wireConfig(config = this.config): SessionConfig {
    return this.agent.adapter === 'codex' ? { ...config, model: codexWireModel(config) } : config
  }

  private threadModelParams(config = this.config): { model?: string; modelProvider?: string } {
    const model = this.agent.adapter === 'codex' ? codexWireModel(config) : config.model
    const source = config.modelSource ?? (config.model ? parseCodexModelKey(config.model)?.source : undefined)
    const modelProvider = this.agent.adapter === 'codex'
      ? this.portableCompactionProvider ?? codexSessionProvider(source) ?? this.nativeModelProvider
      : undefined
    return { ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}) }
  }
  /** A provider `error` notification may be followed by the same failed turn. */
  private reportedTerminalErrorTurns = new Set<string>()
  private contextOverflowRetried = false
  private contextOverflowError?: { turnId: string; error: any }
  private contextRecovery?: { cancelled: boolean }
  // ponytail: keep one sample per ignored shape per turn; batch the diagnostics
  // store if exact per-frame counts ever matter.
  private ignoredEventKeys = new Set<string>()
  // Server→client approval/question requests awaiting a user decision (Doc3).
  // The UI-facing id includes the owning connection generation because providers
  // may reuse a JSON-RPC id after reconnect. Each entry also pins the exact
  // transport that received the request, so a late UI answer can never cross
  // into a replacement process.
  private pendingRequests = new Map<string, PendingServerRequest>()

  /** Serializes (re)connection so concurrent turns don't spawn twice. */
  private readyPromise: Promise<void> | null = null
  private connectionGeneration = 0
  private connectionAttempt?: ConnectionAttempt
  private retiredTransports = new WeakSet<AppServerRpc>()
  private goalState?: GoalState
  private lastGoalWireSequence = 0
  private negotiatedModel?: string
  private lastCollaborationModeWireSequence = 0
  private shouldGenerateInitialTitle: boolean
  private initialTitleSeed?: string
  private traexTitleRequestId?: string
  private codexTitleGeneration?: CodexTitleGeneration
  private pendingImageGenerations = new Set<string>()
  private forkTranscript: Pick<UAEvent, 'type' | 'payload'>[] = []
  private forkPreparation?: ForkPreparation
  private preparedFork?: PreparedFork
  private forkBaseTranscriptLength = 0
  private preparedForkConnected = false
  private pendingThreadDeletes = new Set<Promise<void>>()
  private disposeRequested = false
  private resumeEphemeral = false
  private sideForksInFlight = 0
  private pendingSideForks = new Set<string>()
  private deferredForeignNotifications: Array<{
    method: string
    params: any
    wireSequence?: number
    receivedAt: number
  }> = []
  private activeTurnPrompt?: string
  private completedTurnSnapshotEvents: Pick<UAEvent, 'type' | 'state' | 'payload'>[] = []

  // Per-item accumulation (itemId is unique within a thread).
  private itemType = new Map<string, 'agent' | 'plan' | 'reasoning' | 'command'>()
  private textBuf = new Map<string, string>()
  private itemTurn = new Map<string, string>()
  private cmdMeta = new Map<string, { command?: string }>()
  private completedPlanItems = new Set<string>()
  private planCompletionFallback?: {
    turnToken: string
    connectionGeneration: number
    turnId?: string
    planCompleted: boolean
    timer?: ReturnType<typeof setTimeout>
  }
  // 子agent隔离 — every child thread this connection has ever multiplexed. The
  // app-server pushes child-thread notifications over the SAME stdio as the
  // parent's; we key each one by its threadId so we can (a) keep child content
  // OUT of the main timeline and (b) mark all of them completed when the parent
  // turn ends (so the roster banner stops saying 进行中).
  private childThreads = new Set<string>()
  // Latest cumulative token usage per child thread, surfaced in the sidebar
  // detail (never in the main chat). Keyed by child threadId.
  private childTokenUsage = new Map<string, any>()
  // The model a child was spawned with (from collabAgentToolCall.model), so its
  // sidebar token cost is priced correctly; falls back to the parent's model.
  private childModel = new Map<string, string>()
  // The task the parent dispatched to each child (collabAgentToolCall.prompt),
  // shown as the sidebar "输入任务" so the user sees what each child was asked.
  private childPrompt = new Map<string, string>()
  // Best-effort display name per child (from agentPath / spawn state).
  private childNameMap = new Map<string, string>()
  // A child thread can be explicitly re-dispatched after it completed. Track a
  // monotonic generation per thread so that dispatches reopen it while ordinary
  // late activity/token ticks remain unable to defeat the terminal-state lock.
  private subAgentDispatches = new SubAgentDispatchTracker()
  // First terminal observation per generation owns endedAt/status. Child
  // turn/completed and parent cleanup can both report completion; emitting only
  // the first prevents the renderer's id-based replacement from extending time.
  private terminalSubAgentGenerations = new Set<string>()
  private terminalSubAgentThreads = new Set<string>()
  private latestSubAgentInteraction = new Map<string, string>()
  private compactionLifecycle = new ContextCompactionLifecycle(() => this.threadId)
  private compactionQueue = new CompactionInvocationQueue()
  private compactionActivity = new CompactionActivityGate()
  private compactionWaiters = new Map<string, (result: CompactionTransition) => void>()
  private runningCompactions = new Map<string, { nativeId?: string; turnId?: string }>()
  private manualCompaction?: {
    id: string
    reason?: 'provider-switch'
    turnId?: string
    requesting: boolean
    requireTurnCompletion: boolean
    itemResult?: CompactionTransition
    turnCompleted: boolean
  }
  // Throttle: coalesce high-frequency deltas into ~1 UI update per frame.
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly FLUSH_MS = 50
  private static readonly PLAN_COMPLETION_FALLBACK_MS = 250
  private static readonly GOAL_COMPLETION_FALLBACK_MS = 250
  private static readonly FINAL_ANSWER_COMPLETION_FALLBACK_MS = 250

  constructor(
    private sessionId: string,
    private seqRef: { n: number },
    private agent: AgentDef,
    private config: SessionConfig,
    // 需求1 — 恢复的历史会话续跑. Seeding threadId from the session's native
    // rollout id makes the FIRST turn of a restored session take connect()'s
    // `thread/resume` branch (instead of thread/start opening a brand-new
    // thread), so the model actually carries prior context — not just the UI
    // replaying old events. Empty for freshly-created sessions (→ thread/start).
    resumeThreadId?: string,
    // 需求2（侧边对话 /side）— when set, the FIRST connect forks an EPHEMERAL
    // thread off this parent rollout (`thread/fork {ephemeral,excludeTurns}`) and
    // injects a boundary marker, instead of `thread/start`. The side runner then
    // carries the parent's context but every side turn stays off the parent
    // rollout on disk (ephemeral) and out of the main timeline (separate runner).
    private forkFromThreadId?: string,
    private transportFactory: AppServerRpcFactory = (options) => new AppServerRpcClient(options)
  ) {
    super()
    this.sharedRpc = new SharedAppServerRpc(options => this.transportFactory(options))
    this.runtimeAgent = {
      id: agent.id,
      adapter: agent.adapter,
      bin: agent.bin,
      version: agent.version
    }
    this.threadId = resumeThreadId
    this.needsInitialUsageBaseline = !!(resumeThreadId || forkFromThreadId)
    if (this.needsInitialUsageBaseline) this.sessionEstimatedCost = null
    this.shouldGenerateInitialTitle = !resumeThreadId && !forkFromThreadId
  }

  // ---- public API (parity with TurnRunner) ----

  /** Current app-server process root, used to exclude its tree from lsof ownership checks. */
  processId(): number | undefined {
    return (this.transport || this.sharedTransport)?.processId?.()
  }

  /** Reserve this process before the source runner can be closed or promoted. */
  shareConnectionWith(parent: AppServerRunner): void {
    if (this.transport || this.sharedTransport) throw new Error('app-server 已连接')
    if (!this.matchesAgentRuntime(parent.agent)) throw new Error('app_server_runtime_changed')
    if (this.codexCatalogOverride() !== parent.codexCatalogOverride()) return
    this.sharedRpc = parent.sharedRpc
    this.sharedParent = parent
    const transport = this.sharedRpc.acquire()
    this.sharedTransport = transport
    transport.once('disconnect', () => {
      if (this.sharedTransport === transport) this.sharedTransport = undefined
    })
    if (this.threadId) this.sharedTransport.claimThread?.(this.threadId)
  }

  nativeThreadId(): string | undefined {
    return this.threadId
  }

  /** Run one turn: (re)connect if needed, then turn/start and stream results. */
  async startTurn(
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    afterContextRecovery = false
  ): Promise<void> {
    this.turnNoticeKeys.clear()
    this.ignoredEventKeys.clear()
    if (this.startingTurnToken || this.curTurnId) {
      this.emit('steerFailed', { prompt, attachments, nativeContext })
      return
    }
    this.clearGoalCompletionFallback()
    this.completedAgentTurnToken = undefined
    this.clearFinalAnswerCompletionFallback()
    this.clearPlanCompletionFallback()
    this.queueWait = undefined
    this.activeGoalTurnToken = undefined
    this.activeTurnPrompt = prompt
    if (!afterContextRecovery) this.contextOverflowRetried = false
    this.contextOverflowError = undefined
    this.completedTurnSnapshotEvents = []
    const turnToken = `turn-attempt-${++this.turnTokenSerial}`
    this.startingTurnToken = turnToken
    this.emitDiagnostic('turn_starting', {
      turnToken,
      nativeSessionId: this.threadId,
      adapter: this.agent.adapter,
      collaborationMode: this.config.collaborationMode || 'default'
    })
    // Mark the turn before waiting so a concurrently-clicked /compact cannot
    // enter the uncorrelatable native-item window. A turn submitted while a
    // manual compaction is active waits for that lifecycle to finish.
    this.compactionActivity.turnStarted(turnToken)
    await this.compactionQueue.idle()
    try {
      await this.ensureReady()
      if (this.goalState?.status === 'active') this.activeGoalTurnToken = turnToken
      this.emitDiagnostic('app_server_ready', {
        turnToken,
        nativeSessionId: this.threadId,
        connectionGeneration: this.connectionGeneration
      })
    } catch (err: any) {
      this.emitEvent({
        type: 'error',
        state: 'failed',
        payload: { message: `app-server 启动失败: ${err?.message || err}` }
      })
      this.finishTurn(false, undefined, turnToken, true)
      return
    }

    try {
      if (this.agent.adapter === 'traex' && this.config.collaborationMode === 'plan') {
        this.planCompletionFallback = {
          turnToken,
          connectionGeneration: this.connectionGeneration,
          planCompleted: false
        }
      }
      // Snapshot the thread's cumulative total *before* this turn runs (Doc5 T1):
      // the last tick's `total` is where this turn starts counting from.
      this.turnStartTotal = totalBreakdown(this.lastTokenUsage)
      this.turnCostStartKnown = this.lastTokenUsage ? hasCompleteTokenBreakdown(this.lastTokenUsage) : !this.needsInitialUsageBaseline
      this.turnStartUsageSerial = this.tokenUsageSerial
      this.emitDiagnostic('turn_start_requested', {
        turnToken,
        nativeSessionId: this.threadId,
        connectionGeneration: this.connectionGeneration
      })
      const effectivePrompt = afterContextRecovery ? '' : await assistantPrompt(this.sessionId, this.config, prompt, '', false)
      if (this.startingTurnToken !== turnToken) return
      const turnConfig = this.config
      this.turnPricing = { modelId: turnConfig.model, fastMode: !!turnConfig.fastMode }
      const res = await this.rpc(
        'turn/start',
        buildTurnStartParams(this.agent, this.wireConfig(turnConfig), this.threadId, effectivePrompt, attachments, nativeContext)
      )
      const nativeTurnId = res?.turn?.id
      if (typeof nativeTurnId !== 'string' || !nativeTurnId) throw new Error('turn/start 未返回 turn id')
      if (this.startingTurnToken !== turnToken) return
      this.startingTurnToken = undefined
      this.activeTurnToken = turnToken
      // A resumed active Goal can announce its provider-owned turn while the
      // queued turn/start RPC is still resolving. Keep the newer notification
      // id when that happens; it is the valid precondition for turn/steer.
      this.curTurnId ||= nativeTurnId
      const activeTurnId = this.curTurnId
      this.emitDiagnostic('turn_start_succeeded', {
        turnToken,
        turnId: activeTurnId,
        nativeSessionId: this.threadId,
        connectionGeneration: this.connectionGeneration
      })
      this.armGoalCompletionFallback()
      this.armFinalAnswerCompletionFallback()
      this.bindPlanCompletionFallback(activeTurnId, turnToken)
      // 需求3（回退关联）— surface the native turn id as this turn's boundary the
      // moment turn/start resolves. The connect-time turn_started carries only
      // {threadId} (thread identity, persisted early for crash-safe resume);
      // THIS event adds the stable per-turn `turnId` that turn artifacts / rewind
      // key on, so the two are distinct signals rather than ambiguous duplicates.
      this.emitEvent({ type: 'turn_started', payload: { turnId: activeTurnId, threadId: this.threadId } })
      if (this.interrupting) this.interrupt()
      const earlyCompletion = this.deferredTurnCompletions.claim(activeTurnId)
      if (earlyCompletion) this.onTurnCompleted(earlyCompletion.turn, earlyCompletion.receivedAt)
      // From here, completion is delivered via the turn/completed notification.
    } catch (err: any) {
      this.emitEvent({
        type: 'error',
        state: 'failed',
        payload: { message: `turn/start 失败: ${err?.message || err}` }
      })
      this.finishTurn(false, undefined, turnToken, true)
    }
  }

  /**
   * Steer / force-send into the *running* turn (Doc4 需求2). Codex/TraeX accept
   * `turn/steer` with the id of the active turn; the new input is folded into the
   * same turn rather than queued. Best-effort: if there's no active turn id yet,
   * fall back to a fresh turn/start.
   */
  async steer(
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext
  ): Promise<void> {
    if (this.startingTurnToken) {
      this.emitEvent({
        type: 'system_notice',
        payload: { kind: 'notice', text: '当前回合正在启动，消息将排队发送。' }
      })
      this.emit('steerFailed', { prompt, attachments, nativeContext })
      return
    }
    if (!this.threadId || !this.curTurnId) {
      return this.startTurn(prompt, attachments, nativeContext)
    }
    try {
      const threadId = this.threadId, turnId = this.curTurnId
      const effectivePrompt = await assistantPrompt(this.sessionId, this.config, prompt, '', false)
      if (threadId !== this.threadId || turnId !== this.curTurnId) { this.emit('steerFailed', { prompt, attachments, nativeContext }); return }
      await this.rpc('turn/steer', { threadId, expectedTurnId: turnId, input: buildInput(effectivePrompt, attachments, nativeContext) })
    } catch (err: any) {
      this.emitEvent({
        type: 'system_notice',
        payload: { kind: 'warning', text: `插入消息失败，将排队处理: ${err?.message || err}` }
      })
      // Surface the failure to the orchestrator so it can enqueue instead.
      this.emit('steerFailed', { prompt, attachments, nativeContext })
    }
  }

  /**
   * Strict force-send for MCP/Feishu. Unlike the desktop behavior above,
   * this method may only target an already-active provider turn and never emits
   * steerFailed (whose listener intentionally enqueues a fallback message).
   */
  async steerStrict(
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    expectedTurnId?: string
  ): Promise<void> {
    if (this.startingTurnToken || !this.threadId || !this.curTurnId) {
      throw Object.assign(new Error('force_send_requires_active_turn'), { deliveryState: 'failed' })
    }
    if (expectedTurnId && this.pendingRequests.size) throw Object.assign(new Error('member_awaiting_response'), { deliveryState: 'failed' })
    if (expectedTurnId && expectedTurnId !== this.curTurnId) throw Object.assign(new Error('team_stale_turn'), { deliveryState: 'failed' })
    try {
      const threadId = this.threadId, turnId = this.curTurnId
      const effectivePrompt = await assistantPrompt(this.sessionId, this.config, prompt, '', false)
      if (threadId !== this.threadId || turnId !== this.curTurnId) throw Object.assign(new Error('force_send_requires_active_turn'), { deliveryState: 'failed' })
      await this.rpc('turn/steer', { threadId, expectedTurnId: turnId, input: buildInput(effectivePrompt, attachments, nativeContext) })
    } catch (err: any) {
      this.emitEvent({
        type: 'system_notice',
        payload: {
          kind: 'warning',
          text: `直接发送${err?.deliveryState === 'failed' ? '被拒绝' : '结果未知'}，未进入等待队列，请核对后再操作: ${err?.message || err}`
        }
      })
      throw err
    }
  }

  /**
   * Push a between-turn config change into the live thread (Doc1 需求3).
   * Model/effort/tier variants ride the next turn/start. Permission, cwd, and
   * role instructions are thread-level settings, so changing any of them retires
   * the ready transport and forces resume + Goal/Plan reconciliation before the
   * next turn can start.
   */
  updateConfig(config: SessionConfig): void {
    const runtimeArgsChanged =
      JSON.stringify(this.runtimeArgsSnapshot ?? codexAppServerArgs(this.agent, this.config)) !== JSON.stringify(codexAppServerArgs(this.agent, config))
    const threadRuntimeChanged =
      this.config.permissionMode !== config.permissionMode ||
      this.config.workdir !== config.workdir ||
      this.config.requirementId !== config.requirementId ||
      JSON.stringify(this.config.additionalDirectories || []) !== JSON.stringify(config.additionalDirectories || []) ||
      roleSnapshotChanged(this.config, config) ||
      runtimeArgsChanged
    this.config = config
    if (threadRuntimeChanged) this.invalidateReadyConnection(runtimeArgsChanged)
  }

  matchesAgentRuntime(agent: AgentDef): boolean {
    return this.runtimeAgent.id === agent.id &&
      this.runtimeAgent.adapter === agent.adapter &&
      this.runtimeAgent.bin === agent.bin &&
      this.runtimeAgent.version === agent.version
  }

  updateAgent(agent: AgentDef): void {
    if (!this.matchesAgentRuntime(agent)) throw new Error('app_server_runtime_changed')
    this.agent = agent
  }

  setInitialTitleSeed(userMessage: string): void {
    const seed = stringValue(userMessage)
    if (!seed || this.forkFromThreadId || this.initialTitleSeed) return
    this.initialTitleSeed = seed
    this.shouldGenerateInitialTitle = true
  }

  /**
   * Answer a pending server→client request (Doc3). `answer` is the already
   * shaped decision object from the renderer; we reply on the stored JSON-RPC id
   * and clear the pending entry.
   */
  respond(requestId: string, answer: any): AppServerRespondResult {
    const entry = this.pendingRequests.get(requestId)
    if (!entry) {
      return { handled: false, hasPendingRequests: this.hasPendingServerRequests() }
    }
    if (!this.isTransportOwner(entry.connectionGeneration, entry.transport)) {
      this.resolvePending(requestId)
      return { handled: false, hasPendingRequests: this.hasPendingServerRequests() }
    }
    const modeDecision = entry.method === 'mode/change/respond' ? modeChangeDecision(answer) : undefined
    if (entry.method === 'mode/change/respond' && !modeDecision) {
      return { handled: false, hasPendingRequests: this.hasPendingServerRequests() }
    }
    this.pendingRequests.delete(requestId)
    if (modeDecision) {
      const transport = entry.transport
      const connectionGeneration = entry.connectionGeneration
      const params = {
        threadId: this.threadId,
        requestId: entry.rpcId,
        decision: modeDecision
      }
      const response = transport.requestSequenced
        ? transport.requestSequenced('mode/change/respond', params)
        : transport.request('mode/change/respond', params).then((result) => ({
            result,
            sequence: this.lastCollaborationModeWireSequence + 1
          }))
      void response.then(({ sequence }) => {
        if (modeDecision === 'approved' && this.isTransportOwner(connectionGeneration, transport)) {
          this.applyCollaborationModeState('default', sequence)
        }
      }).catch((error) => {
        this.emitEvent({
          type: 'error',
          state: 'failed',
          payload: { message: `Plan 模式切换响应失败: ${extractMsg(error)}` }
        })
      })
    } else {
      entry.transport.respond(entry.rpcId, answer)
    }
    this.emitEvent({
      type: 'approval_request',
      state: 'success',
      payload: { requestId, resolved: true }
    })
    return { handled: true, hasPendingRequests: this.hasPendingServerRequests() }
  }

  hasPendingRequests(): boolean {
    return this.hasPendingServerRequests()
  }

  pendingPlanModeExitRequestId(): string | undefined {
    const transport = this.transport
    if (!transport || !this.isTransportOwner(this.connectionGeneration, transport)) return undefined
    for (const [requestId, entry] of this.pendingRequests) {
      if (
        entry.connectionGeneration === this.connectionGeneration &&
        entry.transport === transport &&
        entry.method === 'mode/change/respond'
      ) return requestId
    }
    return undefined
  }

  /**
   * Manually compress the thread's context. Emits a notice on success/failure;
   * the CLI then pushes a `thread/compacted` follow-up.
   */
  async compact(): Promise<void> {
    await this.runCompaction(false)
  }

  /** Prepare a portable summary with the destination model before committing its UI config. */
  async compactForProviderSwitch(maxContextTokens?: number, target = this.config): Promise<void> {
    const previous = this.config
    const reason = codexProviderChanged(previous, target) ? 'provider-switch' : undefined
    try {
      // Only the original provider can decode its opaque compaction summary.
      if (codexProviderChanged(previous, target) && this.providerSwitchNeedsTranslation) {
        await this.runCompaction(true, undefined, reason)
      }
      this.updateConfig(target)
      await this.runCompaction(true, maxContextTokens, reason)
    } catch (error) {
      // 仅失败时还原旧配置。成功后必须留在目标模型：随后的容量复查与
      // applyProviderConfig 会复用当前配置续跑线程，若还原成旧模型，codex 会对
      // 已记录为目标模型的 rollout 再发一条反向的 resume 模型不一致警告。
      this.updateConfig(previous)
      throw error
    }
  }

  private async runCompaction(portable: boolean, maxContextTokens?: number, reason?: 'provider-switch'): Promise<void> {
    if (this.disposed) {
      if (portable) throw new Error('app-server 已关闭')
      return
    }
    const unavailable = this.compactionActivity.manualUnavailableReason()
    if (unavailable) {
      this.emitRejectedCompaction(unavailable)
      if (portable) throw new Error(unavailable)
      return
    }
    try {
      await this.compactionQueue.run(async () => {
        const queuedUnavailable = this.compactionActivity.manualUnavailableReason()
        if (queuedUnavailable) {
          this.emitRejectedCompaction(queuedUnavailable)
          if (portable) throw new Error(queuedUnavailable)
          return
        }
        const started = this.compactionLifecycle.beginInvocation()
        let release!: (result: CompactionTransition) => void
        const terminal = new Promise<CompactionTransition>((resolve) => { release = resolve })
        const invocation = { id: started.id, reason, requesting: false, requireTurnCompletion: portable, turnCompleted: false } as NonNullable<typeof this.manualCompaction>
        this.manualCompaction = invocation
        this.compactionWaiters.set(started.id, result => {
          invocation.itemResult = result
          if (result.state === 'failed' || !invocation.requireTurnCompletion || invocation.turnCompleted) release(result)
        })
        this.emitContextCompaction(started)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await this.ensureReady()
          if (portable) {
            const result = await this.rpc('config/read', { includeLayers: false, cwd: this.config.workdir })
            this.nativeModelProvider = stringValue(result?.config?.model_provider) || 'openai'
            const provider = this.threadModelParams().modelProvider || this.nativeModelProvider
            this.portableCompactionProvider = provider
            this.portableCompactionOverrides = {}
            // Built-in OpenAI ignores overrides under its own id; an alias retains
            // its endpoint/auth and changes only the compaction capability.
            if (provider === 'openai') {
              this.portableCompactionProvider = 'uniagent-portable-openai'
              const definition = {
                name: 'OpenAI',
                ...(result?.config?.openai_base_url ? { base_url: result.config.openai_base_url } : {}),
                wire_api: 'responses', requires_openai_auth: true, supports_websockets: true,
                supports_standalone_web_search: true,
                ...(this.agent.version ? { http_headers: { version: this.agent.version } } : {}),
                env_http_headers: { 'OpenAI-Organization': 'OPENAI_ORGANIZATION', 'OpenAI-Project': 'OPENAI_PROJECT' }
              }
              for (const [key, value] of Object.entries(definition)) {
                this.portableCompactionOverrides[`model_providers.${this.portableCompactionProvider}.${key}`] = value
              }
            }
            // Cold resume applies capability overrides; a warm subscribed thread ignores them.
            this.invalidateReadyConnection()
            await this.ensureReady()
            this.assertNegotiatedModel()
          }
          const usageSerial = this.tokenUsageSerial
          if (this.contextRecovery?.cancelled) throw new Error('压缩接续已中断')
          invocation.requesting = true
          timeout = setTimeout(() => {
            const failure: CompactionTransition = { id: started.id, state: 'failed', error: '等待压缩完成超时，请稍后重试' }
            if (invocation.turnId) this.completedTurnIds.add(invocation.turnId)
            this.emitContextCompaction(this.compactionLifecycle.failInvocation(started.id, failure.error))
            this.compactionWaiters.get(started.id)?.(failure)
            this.invalidateReadyConnection()
          }, 5 * 60_000)
          const result = await this.rpc('thread/compact/start', { threadId: this.threadId })
          this.compactionLifecycle.alias(result?.item?.id || result?.itemId, started.id)
          // ThreadCompactStartResponse is empty in the v2 protocol. Native item
          // notifications are the authoritative terminal signal; waiting here
          // keeps the next invocation out of the ambiguous pre-alias window.
          const outcome = await terminal
          if (portable && outcome.state !== 'success') throw new Error(outcome.error || '上下文压缩失败')
          if (portable) {
            const contextTokens = contextTokenCount(this.lastTokenUsage)
            if (this.tokenUsageSerial <= usageSerial || contextTokens == null) {
              throw new Error('未收到压缩后的上下文用量，无法确认目标模型能接续')
            }
            if (maxContextTokens && contextTokens >= maxContextTokens) {
              throw new Error(`压缩后的上下文 ${contextTokens} tokens 仍超过目标模型限制 ${maxContextTokens} tokens`)
            }
          }
        } catch (err: any) {
          this.emitContextCompaction(this.compactionLifecycle.failInvocation(started.id, err?.message || String(err)))
          if (portable) throw err
        } finally {
          if (timeout) clearTimeout(timeout)
          this.compactionWaiters.delete(started.id)
          if (this.manualCompaction === invocation) this.manualCompaction = undefined
          if (portable) {
            this.portableCompactionProvider = undefined
            this.portableCompactionOverrides = undefined
            this.invalidateReadyConnection()
          }
        }
      })
    } catch (err) {
      // dispose() closes the queue so queued IPC calls settle without starting
      // another app-server. Other failures remain visible to the caller.
      if (portable || !this.disposed) throw err
    }
  }

  async ensureThreadReady(): Promise<string> {
    await this.ensureReady()
    if (!this.threadId) throw new Error('app-server 未返回 thread id')
    return this.threadId
  }

  async getContextTokens(target?: SessionConfig): Promise<number | undefined> {
    await this.ensureThreadReady()
    const tokens = contextTokenCount(this.lastTokenUsage)
    if (!target || !codexProviderChanged(this.config, target)) return tokens
    const result = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: false })
    const path = stringValue(result?.thread?.path)
    const budget = path ? await codexContextHistoryBudget(path) : undefined
    this.providerSwitchNeedsTranslation = budget?.opaqueCompaction ?? false
    if (budget == null || budget.opaqueCompaction) return undefined
    return Math.max(tokens ?? 0, budget.tokens)
  }

  async applyProviderConfig(config: SessionConfig, contextWindow?: number): Promise<void> {
    this.updateConfig(config)
    await this.ensureThreadReady()
    this.assertNegotiatedModel()
    if (contextWindow) this.emitLiveContext({ ...this.lastTokenUsage, modelContextWindow: contextWindow })
  }

  private assertNegotiatedModel(): void {
    const expected = this.threadModelParams()
    if ((expected.model && this.negotiatedModel !== expected.model) || this.negotiatedModelProvider !== expected.modelProvider) {
      throw new Error('Codex 未应用所选模型或来源，请等待会话空闲后重试')
    }
  }

  async setThreadTitle(title: string): Promise<void> {
    const name = stringValue(title)
    if (!name || !this.threadId) return
    await this.rpc('thread/name/set', { threadId: this.threadId, name })
  }

  async getGoal(): Promise<GoalState | undefined> {
    const threadId = await this.ensureThreadReady()
    const { result: response, sequence } = await this.rpcSequenced('thread/goal/get', { threadId })
    this.applyGoalState(response?.goal ? normalizeGoal(response.goal) : undefined, sequence)
    return this.goalState
  }

  async setGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalState> {
    const threadId = await this.ensureThreadReady()
    const { result: response, sequence } = await this.rpcSequenced('thread/goal/set', {
      threadId,
      objective: input.objective.trim(),
      status: 'active',
      ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget })
    })
    if (!response?.goal) throw new Error('thread/goal/set 未返回 Goal 状态')
    const goal = normalizeGoal(response.goal)
    this.applyGoalState(goal, sequence)
    return goal
  }

  async clearGoal(): Promise<void> {
    const threadId = await this.ensureThreadReady()
    const { sequence } = await this.rpcSequenced('thread/goal/clear', { threadId })
    this.applyGoalState(undefined, sequence)
  }

  /** TraeX can finish a Goal without emitting turn/completed; Codex cannot. */
  completeGoalTurn(durationMs?: number): void {
    if (this.agent.adapter !== 'traex') return
    const turnToken = this.activeTurnToken || this.startingTurnToken
    if (!turnToken) return
    const current = this.goalCompletionFallback
    if (current?.turnToken === turnToken) {
      current.durationMs = durationMs
      this.armGoalCompletionFallback()
      return
    }
    this.clearGoalCompletionFallback()
    this.goalCompletionFallback = { turnToken, durationMs }
    this.armGoalCompletionFallback()
  }

  /** Start a provider-native inline Review as a normal tracked turn. */
  async startReview(draft: NativeReviewDraft): Promise<void> {
    this.turnNoticeKeys.clear()
    this.ignoredEventKeys.clear()
    if (this.startingTurnToken || this.curTurnId) {
      throw new Error('当前已有 turn 正在运行')
    }
    this.clearGoalCompletionFallback()
    this.completedAgentTurnToken = undefined
    const target = buildNativeReviewTarget(draft)
    const turnToken = `turn-attempt-${++this.turnTokenSerial}`
    this.queueWait = undefined
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    const cancellationState: ReviewCancellationState = {
      token: turnToken,
      cancellation,
      rejectCancellation
    }
    this.startingTurnToken = turnToken
    this.startingReviewToken = turnToken
    this.reviewCancellation = cancellationState
    this.compactionActivity.turnStarted(turnToken)
    try {
      await this.awaitReviewStartup(turnToken, this.compactionQueue.idle())
      await this.awaitReviewStartup(turnToken, this.ensureReady())
      this.turnStartTotal = totalBreakdown(this.lastTokenUsage)
      this.turnCostStartKnown = this.lastTokenUsage ? hasCompleteTokenBreakdown(this.lastTokenUsage) : !this.needsInitialUsageBaseline
      this.turnStartUsageSerial = this.tokenUsageSerial
      // review/start has no service-tier parameter, so its actual tier is unknown.
      this.turnPricing = { modelId: this.config.model, fastMode: false, unknownTier: true }
      const reviewTransport = this.transport
      if (!reviewTransport) throw new Error('app-server 未连接')
      const reviewGeneration = this.connectionGeneration
      const startup: ReviewStartupState = {
        token: turnToken,
        transport: reviewTransport,
        connectionGeneration: reviewGeneration,
        notifications: []
      }
      this.reviewStartup = startup
      const response = await this.awaitReviewStartup(turnToken, reviewTransport.request<any>('review/start', {
        threadId: this.threadId,
        target,
        delivery: 'inline'
      }))
      const turnId = response?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        if (this.transport === reviewTransport) this.invalidateReadyConnection()
        throw new Error('review/start 未返回 turn id')
      }
      if (response?.reviewThreadId !== this.threadId) {
        if (this.transport === reviewTransport) this.invalidateReadyConnection()
        throw new Error('inline review 返回了不同 thread')
      }
      if (
        this.startingTurnToken !== turnToken ||
        this.startingReviewToken !== turnToken ||
        this.reviewCancellation !== cancellationState ||
        this.reviewStartup !== startup ||
        this.transport !== reviewTransport ||
        this.connectionGeneration !== reviewGeneration
      ) {
        throw new ReviewStartCancelledError('review/start 在完成前已中断')
      }
      const buffered = startup.notifications
      this.reviewStartup = undefined
      this.reviewCancellation = undefined
      this.startingTurnToken = undefined
      this.startingReviewToken = undefined
      this.activeTurnToken = turnToken
      this.curTurnId = turnId
      this.emitEvent({ type: 'turn_started', payload: { turnId, threadId: this.threadId } })
      for (const notification of buffered) {
        if (!this.matchesReviewNotification(notification.params, turnId)) continue
        this.onNotification(
          notification.method,
          notification.params,
          notification.wireSequence,
          notification.receivedAt
        )
      }
    } catch (err: any) {
      this.abortStartingReview(turnToken, err instanceof ReviewStartCancelledError ? 'cancelled' : this.transport ? 'failed' : 'disconnected')
      if (!(err instanceof ReviewStartCancelledError)) {
        this.emitEvent({
          type: 'error',
          state: 'failed',
          payload: { message: `review/start 失败: ${err?.message || err}` }
        })
      }
      throw err
    }
  }

  /**
   * 需求3（回退到某轮对话发起前）— open a NON-ephemeral fork of the current thread
   * whose history stops just before `targetTurnId`, returning the new native
   * thread id. Unlike the deprecated `thread/rollback`, `thread/fork` leaves the
   * original thread intact on disk (so a rewind never destroys the source
   * conversation) and only truncates the copied history.
   *
   * Contract:
   * - `ephemeral:false` — the fork is a real, resumable rollout the orchestrator
   *   can adopt as the session's new nativeSessionId once its file transaction
   *   commits. (Side conversations use ephemeral:true; this is the opposite.)
   * - Prefer `beforeTurnId` (Codex/TraeX truncate-exclusive: keep everything
   *   strictly before the target turn). If the app-server build doesn't accept
   *   that field, fall back to the documented `lastTurnId: previousTurnId`
   *   (inclusive: keep through the turn *before* the target) when the caller
   *   supplied `previousTurnId`. The fallback fires ONLY for an
   *   unsupported-field/method rejection — genuine errors (thread not found,
   *   transport) propagate so the orchestrator aborts the rewind and keeps the
   *   session on its original thread.
   * - Does NOT touch this runner's current threadId/turn state: switching the
   *   live session is the orchestrator's job, done only after the file rollback
   *   transaction succeeds (proposal §6.5). This method just produces the id.
   */
  async forkBeforeTurn(targetTurnId: string, previousTurnId?: string): Promise<string> {
    if (!targetTurnId) throw new Error('回退分叉缺少目标 turn id')
    await this.ensureReady()
    if (!this.threadId) throw new Error('回退分叉失败：当前没有原生线程')
    const base = { threadId: this.threadId, ephemeral: false, excludeTurns: true, ...this.threadModelParams() }
    let res: any
    try {
      res = await this.rpc('thread/fork', { ...base, beforeTurnId: targetTurnId })
    } catch (err: any) {
      // Only degrade to lastTurnId when the server rejected `beforeTurnId` itself
      // (older build). Any other failure is a real error and must surface.
      if (!previousTurnId || !isUnsupportedForkParam(err)) throw err
      res = await this.rpc('thread/fork', { ...base, lastTurnId: previousTurnId })
    }
    const forkedThreadId = res?.thread?.id
    if (typeof forkedThreadId !== 'string' || !forkedThreadId) {
      throw new Error('回退分叉失败：未返回 thread id')
    }
    return forkedThreadId
  }

  /**
   * Fork a side branch on the connection that already owns the live parent.
   * Native thread/fork intentionally contains completed history only, so the
   * current turn's already-visible fragments are frozen before the RPC and
   * appended as one labelled context item. In-flight tools are never included.
   */
  async forkSideSnapshot(
    events: Pick<UAEvent, 'type' | 'state' | 'payload'>[],
    priorSideEvents: Pick<UAEvent, 'type' | 'payload'>[] = [],
    sideConfig?: SessionConfig
  ): Promise<string> {
    const snapshot = liveTurnSnapshot(
      structuredClone(events),
      this.activeTurnPrompt,
      [...this.currentTurnSnapshotEvents(), ...this.completedTurnSnapshotEvents]
    )
    await this.ensureReady()
    if (this.agent.adapter === 'codex' && sideConfig?.modelSource?.kind === 'native' && !this.nativeModelProvider) {
      const result = await this.rpc('config/read', { includeLayers: false, cwd: sideConfig.workdir })
      this.nativeModelProvider = stringValue(result?.config?.model_provider) || 'openai'
    }
    if (!this.threadId) throw new Error('侧边对话分叉失败：当前没有原生线程')
    const forkParams: Record<string, unknown> = {
      threadId: this.threadId,
      ephemeral: false,
      excludeTurns: true,
      ...this.threadModelParams(sideConfig),
      developerInstructions: developerInstructions(sideConfig || this.config, undefined, false),
      ...(sideConfig ? {
        cwd: sideConfig.workdir,
        sandbox: codexSandbox(sideConfig.permissionMode!),
        approvalPolicy: this.approvalPolicyFor(sideConfig),
        approvalsReviewer: this.approvalsReviewerFor(sideConfig),
        config: this.threadConfigOverrides(this.sessionId, true, sideConfig)
      } : {})
    }
    forkParams.threadSource = 'side'
    this.sideForksInFlight += 1
    let forkedThreadId: string | undefined
    try {
      const res: any = await this.rpc('thread/fork', forkParams)
      forkedThreadId = res?.thread?.id
      if (typeof forkedThreadId !== 'string' || !forkedThreadId) {
        throw new Error('侧边对话分叉失败：未返回 thread id')
      }
      this.pendingSideForks.add(forkedThreadId)
      while (this.pendingSideForks.size > 64) {
        this.pendingSideForks.delete(this.pendingSideForks.values().next().value!)
      }
      const items = [
        messageItem('user', SIDE_CONVERSATION_INSTRUCTIONS),
        ...transcriptItems(priorSideEvents, true)
      ]
      if (snapshot) items.push(messageItem('user', snapshot))
      await this.rpc('thread/inject_items', { threadId: forkedThreadId, items })
      if (!sideConfig) await this.rpc('thread/unsubscribe', { threadId: forkedThreadId })
      return forkedThreadId
    } catch (error) {
      if (forkedThreadId) await this.rpc('thread/delete', { threadId: forkedThreadId }).catch(() => {})
      throw error
    } finally {
      this.sideForksInFlight -= 1
      if (this.sideForksInFlight === 0) this.replayDeferredForeignNotifications()
    }
  }

  /** Clone the side branch, replaying only history the provider kept memory-only. */
  async forkPersistent(events: Pick<UAEvent, 'type' | 'payload'>[], targetSessionId?: string): Promise<string> {
    if (this.startingTurnToken || this.curTurnId) throw new Error('侧边对话仍在运行，请等待结束后再转换')
    await this.ensureReady()
    const forkThreadId = this.persistentFork || this.resumeEphemeral ? this.threadId : this.forkFromThreadId
    if (!forkThreadId) throw new Error('侧边对话缺少主会话线程')
    const res: any = await this.rpc('thread/fork', {
      threadId: forkThreadId,
      ephemeral: false,
      excludeTurns: true,
      ...this.threadModelParams(),
      ...(targetSessionId && this.agent.adapter === 'codex' ? {
        threadSource: 'user',
        developerInstructions: developerInstructions(this.config, targetSessionId),
        config: this.threadConfigOverrides(targetSessionId)
      } : {})
    })
    const forkedThreadId = res?.thread?.id
    if (typeof forkedThreadId !== 'string' || !forkedThreadId) {
      throw new Error('侧边对话转换失败：未返回 thread id')
    }
    // TraeX honors ephemeral resume by keeping later turns out of the rollout,
    // so promotion must append only the transcript created after that resume.
    // Codex persists those turns in the prepared branch despite accepting the
    // same flag. Legacy runners still replay their entire visible transcript.
    const replayEvents = this.persistentFork ? [] : this.resumeEphemeral
      ? this.agent.adapter === 'traex' ? events.slice(this.forkBaseTranscriptLength) : []
      : events
    const items = transcriptItems(replayEvents)
    try {
      if (items.length) await this.rpc('thread/inject_items', { threadId: forkedThreadId, items })
      return forkedThreadId
    } catch (error) {
      await this.rpc('thread/delete', { threadId: forkedThreadId }).catch(() => {})
      throw error
    }
  }

  setForkTranscript(events: Pick<UAEvent, 'type' | 'payload'>[]): void {
    this.forkTranscript = structuredClone(events)
  }

  /** Delay first connection until the parent runner has created the side fork. */
  setForkPreparation(prepare: ForkPreparation, parent?: AppServerRunner): void {
    this.forkPreparation = prepare
    this.shouldGenerateInitialTitle = false
    if (parent) {
      this.shareConnectionWith(parent)
      this.persistentFork = true
      this.forkFromThreadId = this.threadId
      if (this.threadId) {
        const threadId = this.threadId
        this.preparedFork = { threadId, cleanup: () => this.deleteThread(threadId) }
      }
    }
  }

  deleteThread(threadId: string): Promise<void> {
    const deletion = this.deleteThreadNow(threadId)
    this.pendingThreadDeletes.add(deletion)
    void deletion.finally(() => this.pendingThreadDeletes.delete(deletion)).catch(() => {})
    return deletion
  }

  private async deleteThreadNow(threadId: string): Promise<void> {
    if (this.persistentFork) {
      const transport = this.transport || this.sharedTransport || this.sharedRpc.acquire()
      const temporary = transport !== this.transport && transport !== this.sharedTransport
      try {
        if (temporary) {
          await transport.start()
          await transport.request('initialize', {
            clientInfo: { name: 'uniagent', version: '1.0.0' },
            capabilities: { experimentalApi: true }
          })
          transport.notify('initialized', {})
        }
        await transport.request('thread/delete', { threadId })
      } finally {
        if (temporary) await transport.dispose()
      }
    } else {
      await this.ensureReady()
      await this.rpc('thread/delete', { threadId })
    }
    this.pendingSideForks.delete(threadId)
  }

  /** Delete the durable base through the parent connection that created it. */
  disposeFork(keepThread = false): void {
    if (keepThread && this.persistentFork) {
      this.preparedFork = undefined
      this.dispose()
      return
    }
    void this.releasePreparedFork().finally(() => this.dispose())
  }

  private releasePreparedFork(): Promise<void> {
    const prepared = this.preparedFork
    this.preparedFork = undefined
    this.threadId = undefined
    this.forkFromThreadId = undefined
    this.resumeEphemeral = false
    this.forkBaseTranscriptLength = 0
    this.preparedForkConnected = false
    return prepared ? prepared.cleanup().catch(() => {}) : Promise.resolve()
  }

  /** Interrupt the in-flight turn (best effort). */
  interrupt(): void {
    this.clearPlanCompletionFallback()
    if (this.contextRecovery) {
      this.contextRecovery.cancelled = true
      if (this.manualCompaction?.turnId && this.threadId) {
        void this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.manualCompaction.turnId }).catch(() => {})
        return
      }
    }
    if (this.startingReviewToken) {
      this.cancelStartingReview(new ReviewStartCancelledError('review/start 已中断'))
    } else if (this.startingTurnToken && !this.curTurnId) {
      // Let turn/start return before interrupting. Killing app-server here leaves
      // TraeX's new empty thread without a rollout, so the next turn cannot resume it.
      this.interrupting = true
    } else if (this.threadId && this.curTurnId) {
      // `turn/interrupt` is a ClientRequest (it returns a response), NOT a
      // notification — sending it fire-and-forget via notify() left codex free
      // to ignore it. Issue it as an RPC so the turn is actually aborted; codex
      // then emits `turn/completed` with status='interrupted'. If the RPC itself
      // rejects (e.g. the turn already ended), fall back to finishing locally so
      // the UI never gets stuck in a cancelling state.
      const turnId = this.curTurnId
      this.interrupting = true
      this.rpc('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {
        if (this.curTurnId === turnId) this.finishTurn(true, turnId)
      })
      // Safety net: if no turn/completed arrives shortly after the interrupt is
      // acknowledged, force the turn closed so status returns to idle.
      setTimeout(() => {
        if (this.curTurnId === turnId) this.finishTurn(true, turnId)
      }, 4000)
    } else if (this.transport && this.agent.adapter !== 'codex') {
      this.transport.interrupt()
    }
  }

  /** Tear down the child process (session archived / window closed). */
  dispose(): void {
    if (this.disposed || this.disposeRequested) return
    if (this.pendingThreadDeletes.size) {
      this.disposeRequested = true
      void Promise.allSettled([...this.pendingThreadDeletes]).finally(() => {
        this.disposeRequested = false
        this.dispose()
      })
      return
    }
    this.disposed = true
    this.releasePreparedFork()
    const disposedError = new Error('app-server 已关闭')
    if (this.startingReviewToken) {
      this.cancelStartingReview(
        new ReviewStartCancelledError('review/start 已中断：app-server 已关闭'),
        false
      )
    }
    this.compactionQueue.close(disposedError)
    this.clearFlush()
    this.clearGoalCompletionFallback()
    this.clearFinalAnswerCompletionFallback()
    this.clearPlanCompletionFallback()
    const transport = this.transport
    const retiredGeneration = this.connectionGeneration
    this.connectionGeneration += 1
    this.transport = null
    this.readyPromise = null
    this.connectionAttempt = undefined
    this.retirePendingRequests(retiredGeneration)
    // The transport rejects callbacks before terminating its child, so pending
    // compact IPC never waits for its request timeout during teardown.
    if (transport) this.retireTransport(transport)
    if (this.sharedTransport) {
      this.retireTransport(this.sharedTransport)
      this.sharedTransport = undefined
    }
    for (const stableId of [...this.compactionWaiters.keys()]) {
      this.emitContextCompaction(this.compactionLifecycle.failInvocation(stableId, disposedError.message))
      this.compactionWaiters.get(stableId)?.({ id: stableId, state: 'failed', error: disposedError.message })
    }
    for (const stableId of [...this.runningCompactions.keys()]) {
      this.emitContextCompaction(this.compactionLifecycle.failInvocation(stableId, disposedError.message))
    }
    this.compactionActivity.resetNative()
    this.runningCompactions.clear()
    this.compactionActivity.resetTurns()
    this.startingTurnToken = undefined
    this.startingReviewToken = undefined
    this.reviewCancellation = undefined
    this.reviewStartup = undefined
    this.activeTurnToken = undefined
    this.activeGoalTurnToken = undefined
    this.curTurnId = undefined
    this.reportedTerminalErrorTurns.clear()
    this.pendingImageGenerations.clear()
    this.deferredTurnCompletions.clear()
    this.sideForksInFlight = 0
    this.pendingSideForks.clear()
    this.deferredForeignNotifications = []
    this.activeTurnPrompt = undefined
    this.completedTurnSnapshotEvents = []
    this.lastCollaborationModeWireSequence = 0
  }

  // ---- connection lifecycle ----

  private sessionDeveloperInstructions(): string {
    // Side/detail branches share a session id; only the main runner owns its sync receipt.
    return developerInstructions(this.config, this.sessionId, !this.forkFromThreadId && !this.forkPreparation && !this.resumeEphemeral)
  }

  private ensureReady(): Promise<void> {
    if (this.disposed || this.disposeRequested) return Promise.reject(new Error('app-server 已关闭'))
    const args = codexAppServerArgs(this.agent, this.config)
    if (this.transport && this.runtimeArgsSnapshot && JSON.stringify(this.runtimeArgsSnapshot) !== JSON.stringify(args)) {
      this.invalidateReadyConnection(true)
    }
    if (this.transport && this.threadId && !this.readyPromise) return Promise.resolve()
    if (this.readyPromise) return this.readyPromise
    const generation = ++this.connectionGeneration
    const sessionDeveloperInstructions = this.sessionDeveloperInstructions()
    const transport = this.createTransport(generation, sessionDeveloperInstructions)
    const attempt: ConnectionAttempt = { generation, transport, developerInstructions: sessionDeveloperInstructions }
    this.connectionAttempt = attempt
    this.transport = transport
    let promise!: Promise<void>
    promise = this.connect(attempt).then(
      () => {
        this.assertConnectionAttempt(attempt)
        if (this.connectionAttempt === attempt) this.connectionAttempt = undefined
        if (this.readyPromise === promise) this.readyPromise = null
      },
      (error) => {
        if (this.connectionAttempt === attempt) this.connectionAttempt = undefined
        if (this.readyPromise === promise) this.readyPromise = null
        if (
          this.connectionGeneration === attempt.generation &&
          this.transport === attempt.transport
        ) {
          this.transport = null
        }
        this.retirePendingRequests(attempt.generation)
        this.retireTransport(attempt.transport)
        throw error
      }
    )
    this.readyPromise = promise
    return promise
  }

  /** Drop a failed ready connection without losing the thread resume identity. */
  private invalidateReadyConnection(replaceProcess = false): void {
    this.clearPlanCompletionFallback()
    const failedTransport = this.transport
    const retiredGeneration = this.connectionGeneration
    this.connectionGeneration += 1
    this.transport = null
    this.readyPromise = null
    this.connectionAttempt = undefined
    this.retirePendingRequests(retiredGeneration)
    this.negotiatedModel = undefined
    this.negotiatedModelProvider = undefined
    this.lastGoalWireSequence = 0
    this.lastCollaborationModeWireSequence = 0
    if (failedTransport) this.retireTransport(failedTransport)
    if (replaceProcess && this.agent.adapter === 'codex') {
      if (this.sharedTransport) this.retireTransport(this.sharedTransport)
      this.sharedTransport = undefined
      // Existing side threads keep their old process and model catalog.
      this.sharedRpc = new SharedAppServerRpc(options => this.transportFactory(options))
    }
  }

  private async connect(attempt: ConnectionAttempt): Promise<void> {
    if (this.disposed) throw new Error('app-server 已关闭')
    const permissionMode = this.requirePermissionMode()
    await this.retiringTransport
    if (this.threadId && !this.resumeEphemeral) {
      await repairTransplantedSessionHistory(this.agent.adapter, this.threadId)
    }
    if (this.persistentFork && this.sharedParent && !this.sharedParent.disposed) {
      await this.sharedParent.ensureReady()
    }
    this.assertConnectionAttempt(attempt)
    await attempt.transport.start()
    this.assertConnectionAttempt(attempt)
    await this.connectionRpc(attempt, 'initialize', {
      clientInfo: { name: 'uniagent', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })
    this.connectionNotify(attempt, 'initialized', {})

    if (this.agent.adapter === 'codex' && (!this.config.modelSource || this.config.modelSource.kind === 'native')) {
      const result = await this.connectionRpc<any>(attempt, 'config/read', { includeLayers: false, cwd: this.config.workdir })
      this.nativeModelProvider = stringValue(result?.config?.model_provider) || 'openai'
    }

    const sandbox = codexSandbox(permissionMode)
    const approvalPolicy = this.approvalPolicyFor()
    // Reviewer routing (Doc §4.3): on-request modes route approvals to the user
    // by default, EXCEPT approve-for-me ("帮我批准") which delegates to codex's
    // automatic review subagent (auto_review). never-ask modes need no reviewer.
    const reviewer = this.approvalsReviewerFor()
    const reviewerParam = reviewer ? { approvalsReviewer: reviewer } : {}
    const sessionDeveloperInstructions = attempt.developerInstructions
    if (!this.threadId && this.forkPreparation) {
      const prepared = await this.forkPreparation(structuredClone(this.forkTranscript))
      try {
        this.assertConnectionAttempt(attempt)
      } catch (error) {
        await prepared.cleanup().catch(() => {})
        throw error
      }
      this.preparedFork = prepared
      this.resumeEphemeral = !this.persistentFork
      this.threadId = prepared.threadId
      attempt.transport.claimThread?.(prepared.threadId)
      this.forkBaseTranscriptLength = this.forkTranscript.length
      this.preparedForkConnected = false
      // Promotion clones this durable, side-sourced base. Providers that keep
      // resumed side turns memory-only replay the post-resume transcript there.
      this.forkFromThreadId = prepared.threadId
      if (this.persistentFork) this.emit('nativeThreadReady', prepared.threadId)
    }
    const resumeThreadId = this.threadId
    if (resumeThreadId) {
      // A crash-reconnect OR the first turn of a WRITABLE session (需求1): resume
      // the same thread to keep context.
      //
      // 需求5（外部会话导入并发治理）— we no longer silently degrade a failed
      // `thread/resume` into a fresh `thread/start`. That implicit fork used to
      // fire when the rollout was locked by another writer (a TUI / another
      // UniAgent window) or had gone stale, and it split the conversation onto a
      // brand-new empty thread WITHOUT the user's knowledge — the "恢复会话失败，
      // 将以新线程继续" degradation. Read-only imported snapshots are never resumed
      // in place (the user must explicitly 原Agent分叉 / 换Agent分叉 to a fresh
      // native id first), so a resume failure here is a genuine error: surface it
      // and abort the turn instead of quietly starting a divergent thread.
      let res: any
      try {
        res = await this.connectionRpc<any>(attempt, 'thread/resume', {
          threadId: resumeThreadId,
          ...(this.resumeEphemeral ? { ephemeral: true } : {}),
          excludeTurns: true,
          cwd: this.config.workdir,
          sandbox,
          approvalPolicy,
          developerInstructions: sessionDeveloperInstructions,
          ...reviewerParam,
          ...this.threadModelParams(),
          ...(this.agent.adapter === 'codex' ? {
            config: this.threadConfigOverrides(this.sessionId, !!this.forkPreparation || this.resumeEphemeral)
          } : {})
        })
      } catch (error) {
        if (this.resumeEphemeral && !this.preparedForkConnected) {
          await this.releasePreparedFork()
        }
        throw error
      }
      if (this.resumeEphemeral && this.agent.adapter === 'traex' && this.preparedForkConnected) {
        const items = transcriptItems(this.forkTranscript.slice(this.forkBaseTranscriptLength), true)
        if (items.length) {
          await this.connectionRpc(attempt, 'thread/inject_items', { threadId: resumeThreadId, items })
        }
      }
      if (this.resumeEphemeral) this.preparedForkConnected = true
      const hasProviderTitle = this.applyProviderThreadTitle(res?.thread)
      if (!hasProviderTitle && this.initialTitleSeed) {
        this.maybeGenerateInitialTitle(this.initialTitleSeed)
      }
      this.negotiatedModel = stringValue(res?.model) || stringValue(res?.thread?.model)
      this.negotiatedModelProvider = stringValue(res?.modelProvider) || stringValue(res?.thread?.modelProvider)
      await this.refreshGoalFromProvider(resumeThreadId, attempt)
      // Collaboration mode is thread-level state and does not survive resume.
      if (this.config.collaborationMode === 'plan') {
        await this.applyCollaborationMode('plan', resumeThreadId, this.negotiatedModel, attempt)
      }
      return
    }
    {
      // 需求2（侧边对话 /side）— an ephemeral fork carries the parent's context but
      // keeps every side turn OFF the parent rollout (ephemeral) and, since this
      // runner emits on its own channel, out of the main timeline. Falls back to a
      // plain thread/start when no parent is set (shouldn't happen for a side
      // runner, but keeps the branch safe).
      if (this.forkFromThreadId) {
        const fk = await this.connectionRpc<any>(attempt, 'thread/fork', {
          threadId: this.forkFromThreadId,
          ephemeral: true,
          excludeTurns: true,
          ...this.threadModelParams(),
          developerInstructions: sessionDeveloperInstructions
        })
        const forkedThreadId = fk?.thread?.id
        if (!forkedThreadId) throw new Error('侧边对话分叉失败：未返回 thread id')
        this.threadId = forkedThreadId
        this.negotiatedModel = stringValue(fk?.thread?.model)
        await this.connectionRpc(attempt, 'thread/inject_items', {
          threadId: forkedThreadId,
          items: [messageItem('user', SIDE_CONVERSATION_INSTRUCTIONS), ...transcriptItems(this.forkTranscript)]
        })
        this.assertConnectionAttempt(attempt)
        this.emitEvent({ type: 'turn_started', payload: { threadId: forkedThreadId } })
        if (this.config.collaborationMode === 'plan') {
          await this.applyCollaborationMode('plan', forkedThreadId, this.negotiatedModel, attempt)
        }
        return
      }
      const res = await this.connectionRpc<any>(attempt, 'thread/start', {
        cwd: this.config.workdir,
        sandbox,
        approvalPolicy,
        developerInstructions: sessionDeveloperInstructions,
        ...reviewerParam,
        ...this.threadModelParams(),
        ...(this.agent.adapter === 'codex' ? { config: this.threadConfigOverrides() } : {})
      })
      const startedThreadId = res?.thread?.id
      if (!startedThreadId) throw new Error('thread/start 未返回 thread id')
      this.threadId = startedThreadId
      this.applyProviderThreadTitle(res?.thread)
      this.negotiatedModel = stringValue(res?.thread?.model)
      this.emitEvent({ type: 'turn_started', payload: { threadId: startedThreadId } })
      await this.refreshGoalFromProvider(startedThreadId, attempt)
      if (this.config.collaborationMode === 'plan') {
        await this.applyCollaborationMode('plan', startedThreadId, this.negotiatedModel, attempt)
      }
    }
  }

  private async refreshGoalFromProvider(
    threadId: string,
    attempt: ConnectionAttempt
  ): Promise<void> {
    // Side/detail branches have no provider Goal; TraeX rejects even a read.
    if (this.resumeEphemeral || this.forkFromThreadId) return
    const { result: response, sequence } = await this.connectionRpcSequenced(
      attempt,
      'thread/goal/get',
      { threadId }
    )
    this.applyGoalState(response?.goal ? normalizeGoal(response.goal) : undefined, sequence)
  }

  private applyGoalState(goal: GoalState | undefined, wireSequence: number): void {
    if (wireSequence < this.lastGoalWireSequence) return
    this.lastGoalWireSequence = wireSequence
    this.goalState = goal
    this.emit('goalChanged', goal)
  }

  private applyCollaborationModeState(
    mode: CollaborationModeId,
    wireSequence: number
  ): void {
    if (wireSequence < this.lastCollaborationModeWireSequence) return
    this.lastCollaborationModeWireSequence = wireSequence
    this.emit('collaborationModeChanged', mode)
  }

  async setCollaborationMode(mode: CollaborationModeId): Promise<void> {
    const previousConfig = this.config
    const connecting = !this.transport || !this.threadId
    if (connecting) {
      // The requested RPC is authoritative for this operation. Suppress a stale
      // persisted Plan value during connection so exiting Plan never depends on
      // the provider still advertising a Plan preset (and activation is not sent
      // twice before the caller can persist its new state).
      this.config = { ...previousConfig, collaborationMode: 'default' }
    }
    try {
      await this.ensureReady()
      if (!this.threadId) throw new Error('当前没有原生 thread')
      await this.applyCollaborationMode(mode, this.threadId, this.negotiatedModel)
      this.config = { ...previousConfig, collaborationMode: mode }
    } catch (error) {
      this.config = previousConfig
      if (connecting) this.invalidateReadyConnection()
      throw error
    }
  }

  private async applyCollaborationMode(
    mode: CollaborationModeId,
    threadId: string,
    negotiatedModel?: string,
    connectionAttempt?: ConnectionAttempt
  ): Promise<void> {
    if (this.agent.adapter !== 'codex' && this.agent.adapter !== 'traex') {
      throw new Error(`${this.agent.name} 不支持 collaboration mode`)
    }
    // null selects native mode instructions; thread instructions carry UniAgent context.
    if (mode === 'default') {
      const model = this.wireConfig().model || negotiatedModel
      if (!model) throw new Error('Default collaboration mode 缺少 model')
      const params = {
        threadId,
        collaborationMode: {
          mode: 'default',
          settings: {
            model,
            reasoning_effort: null,
            developer_instructions: null
          }
        }
      }
      const { sequence } = connectionAttempt
        ? await this.connectionRpcSequenced(connectionAttempt, 'thread/settings/update', params)
        : await this.rpcSequenced('thread/settings/update', params)
      this.lastCollaborationModeWireSequence = Math.max(
        this.lastCollaborationModeWireSequence,
        sequence
      )
      return
    }

    const response = connectionAttempt
      ? await this.connectionRpc<any>(connectionAttempt, 'collaborationMode/list', {})
      : await this.rpc('collaborationMode/list', {})
    const preset = Array.isArray(response?.data)
      ? response.data.find((item: any) => item?.mode === 'plan')
      : undefined
    if (!preset) throw new Error(`${this.agent.name} 未提供 Plan collaboration mode`)
    const model = this.config.modelSource && this.config.modelSource.kind !== 'native'
      ? this.wireConfig().model || negotiatedModel
      : stringValue(preset.model) || this.wireConfig().model || negotiatedModel
    if (!model) throw new Error('Plan collaboration mode 缺少 model')
    const settingsParams = {
      threadId,
      collaborationMode: {
        mode: 'plan',
        settings: {
          model,
          reasoning_effort: stringValue(preset.reasoning_effort) || null,
          developer_instructions: null
        }
      }
    }
    const { sequence } = connectionAttempt
      ? await this.connectionRpcSequenced(
        connectionAttempt,
        'thread/settings/update',
        settingsParams
      )
      : await this.rpcSequenced('thread/settings/update', settingsParams)
    this.lastCollaborationModeWireSequence = Math.max(
      this.lastCollaborationModeWireSequence,
      sequence
    )
  }

  /**
   * Approval policy for the negotiated thread (Doc §4.3). auto-edit / full-access
   * pre-authorize everything (never ask); every other permission mode asks
   * on-request so the UI / reviewer can decide.
   */
  private approvalPolicyFor(config = this.config): string {
    switch (config.permissionMode) {
      case 'auto-edit':
      case 'full-access':
        return 'never'
      default:
        return 'on-request'
    }
  }

  /**
   * Reviewer for on-request approvals (Doc §4.3). `approve-for-me` delegates to
   * codex's automatic review subagent; the other on-request modes route to the
   * user. never-ask modes return undefined (no reviewer needed).
   */
  private approvalsReviewerFor(config = this.config): string | undefined {
    switch (config.permissionMode) {
      case 'approve-for-me':
        return 'auto_review'
      case 'read-only':
      case 'ask':
        return 'user'
      default:
        return undefined
    }
  }

  private createTransport(generation: number, appendedPrompt: string): AppServerRpc {
    const permissionMode = this.requirePermissionMode()
    const cmd = this.agent.bin
    this.runtimeArgsSnapshot = codexAppServerArgs(this.agent, this.config)
    // The model manager reads its catalog at process startup. Keep provider,
    // model and MCP settings thread-scoped so sibling threads retain their identity.
    const args = ['app-server']
    if (this.agent.adapter === 'codex') args.push('-c', 'thread_unload_delay_secs=0')
    const catalog = this.codexCatalogOverride()
    if (catalog) args.push('-c', catalog)
    if (this.agent.adapter !== 'codex') {
      args.push(...appServerAdditionalDirectoryArgs(this.config.workdir, this.config.additionalDirectories))
    }
    if (this.agent.adapter === 'traex' && this.config.maxMode) {
      args.push('-c', 'model_backend_variant="max"')
    }
    // Doc11: inject the handoff MCP server (create_uniagent_task) via repeated
    // `-c mcp_servers.uniagent.*` TOML overrides, same as the exec path. This
    // lets a streaming turn 交接 follow-up tasks to a new session.
    // Ephemeral side/detail branches share the parent id but are desktop inputs.
    if (this.agent.adapter !== 'codex') {
      args.push(...handoffMcpArgs(
        this.agent.adapter,
        this.sessionId,
        !this.forkFromThreadId && !this.forkPreparation && !this.resumeEphemeral,
        !this.forkFromThreadId && !this.forkPreparation && !this.resumeEphemeral
      ))
    }
    // Surface the *effective* negotiated config (sandbox / approval / model /
    // effort) in the launch notice. On the streaming path these no longer live
    // in argv (they're sent as JSON-RPC params), so this is the only place the
    // UI — and the E2E tests — can see what was actually applied.
    const sandbox = codexSandbox(permissionMode)
    const approvalPolicy = this.approvalPolicyFor()
    // Show only the base subcommand in the notice — the injected handoff MCP
    // overrides are long JSON and would drown out the useful bits.
    const parts = [`启动: ${cmd} app-server`, `sandbox=${sandbox}`, `approval=${approvalPolicy}`]
    if (this.config.collaborationMode === 'plan') parts.push('mode=plan')
    if (this.config.model) parts.push(`model=${this.config.model}`)
    if (this.config.effort) parts.push(`effort=${this.config.effort}`)
    if (this.agent.adapter === 'traex') parts.push(`max=${this.config.maxMode ? 'on' : 'off'}`)
    this.emitEvent({
      type: 'system_notice',
      payload: {
        text: parts.join(' '),
        kind: 'launch',
        // 渲染层启动卡片直接消费的结构化字段；text 仍保留完整原文用于展开详情。
        label: `${this.agent.name} app-server`,
        sandbox,
        approvalPolicy,
        model: this.config.model,
        effort: this.config.effort,
        maxMode: this.agent.adapter === 'traex' ? !!this.config.maxMode : undefined,
        mode: this.config.collaborationMode === 'plan' ? 'plan' : undefined,
        appendedPrompt
      }
    })

    const options = {
      bin: cmd,
      args,
      cwd: this.config.workdir,
      env: { ...process.env },
      tokenSpeed: this.agent.adapter as 'codex' | 'traex'
    }
    const transport = this.sharedTransport || (this.agent.adapter === 'codex'
      ? this.sharedRpc.acquire(options)
      : this.transportFactory(options))
    this.sharedTransport = undefined
    this.lastGoalWireSequence = 0
    this.lastCollaborationModeWireSequence = 0
    transport.on('notification', (method: string, params: any, sequence?: number) => {
      if (!this.isTransportOwner(generation, transport)) return
      this.onNotification(method, params, sequence)
    })
    transport.on('serverRequest', (message: any) => {
      if (this.isTransportOwner(generation, transport)) {
        this.emitDiagnostic('provider_request', { generation, message })
        this.onServerRequest(message, generation, transport)
      }
    })
    transport.on('disconnect', (message?: string) => {
      this.emitDiagnostic('provider_disconnected', { generation, message })
      this.onDisconnect(generation, transport, message)
    })
    // The raw frame hook is deliberately kept at the adapter boundary so the
    // opt-in compaction diagnostics retain their current capture semantics.
    transport.on('message', (message: any) => {
      if (!this.isTransportOwner(generation, transport)) return
      if (process.env.UA_DUMP_COMPACT) dumpCompactionTraffic(message)
    })
    return transport
  }

  private isTransportOwner(generation: number, transport: AppServerRpc): boolean {
    return !this.disposed &&
      this.connectionGeneration === generation &&
      this.transport === transport
  }

  private assertConnectionAttempt(attempt: ConnectionAttempt): void {
    if (
      !this.isTransportOwner(attempt.generation, attempt.transport) ||
      this.connectionAttempt !== attempt
    ) {
      throw new ConnectionAttemptInvalidatedError('app-server 连接尝试已失效')
    }
  }

  private async connectionRpc<T>(
    attempt: ConnectionAttempt,
    method: string,
    params: any
  ): Promise<T> {
    this.assertConnectionAttempt(attempt)
    const result = await attempt.transport.request<T>(method, params)
    this.assertConnectionAttempt(attempt)
    return result
  }

  private async connectionRpcSequenced(
    attempt: ConnectionAttempt,
    method: string,
    params: any
  ): Promise<{ result: any; sequence: number }> {
    this.assertConnectionAttempt(attempt)
    const response = attempt.transport.requestSequenced
      ? await attempt.transport.requestSequenced(method, params)
      : {
          result: await attempt.transport.request(method, params),
          sequence: this.lastGoalWireSequence + 1
        }
    this.assertConnectionAttempt(attempt)
    return response
  }

  private connectionNotify(attempt: ConnectionAttempt, method: string, params: any): void {
    this.assertConnectionAttempt(attempt)
    attempt.transport.notify(method, params)
  }

  private retireTransport(transport: AppServerRpc): void {
    if (this.retiredTransports.has(transport)) return
    this.retiredTransports.add(transport)
    this.retiringTransport = transport.dispose(true).catch(() => {})
  }

  private threadConfigOverrides(sessionId = this.sessionId, side = false, config = this.config): Record<string, unknown> {
    const args = [
      ...codexAppServerArgs(this.agent, config),
      ...appServerAdditionalDirectoryArgs(config.workdir, config.additionalDirectories),
      ...handoffMcpArgs(this.agent.adapter, sessionId, !side, !side)
    ]
    const overrides = Object.fromEntries(args.filter(arg => arg !== '-c').map(arg => {
      const separator = arg.indexOf('=')
      return [arg.slice(0, separator), JSON.parse(arg.slice(separator + 1))]
    }))
    if (this.portableCompactionProvider && !side) {
      Object.assign(overrides, this.portableCompactionOverrides)
      overrides.model_provider = this.portableCompactionProvider
      overrides[`model_providers.${this.portableCompactionProvider}.capabilities.remote_compaction`] = 'unsupported'
    }
    return overrides
  }

  private codexCatalogOverride(): string | undefined {
    return codexAppServerArgs(this.agent, this.config).find(arg => arg.startsWith('model_catalog_json='))
  }

  /** Child died unexpectedly: fail any pending RPCs and end the current turn. */
  private onDisconnect(
    generation: number,
    disconnectedTransport: AppServerRpc,
    message?: string
  ): void {
    if (!this.isTransportOwner(generation, disconnectedTransport)) return
    this.connectionGeneration += 1
    this.transport = null
    this.readyPromise = null
    this.connectionAttempt = undefined
    this.retirePendingRequests(generation)
    const err = new Error(message || 'app-server 连接已断开')
    const queueTurnToken = this.activeTurnToken || this.startingTurnToken
    if (queueTurnToken) this.completeQueueWait(queueTurnToken, this.curTurnId, Date.now(), false, 'disconnected')
    // A compact RPC may already have returned while its terminal native
    // notification was still in flight. Closing the transport means that
    // notification can never arrive; fail and release every queued lifecycle.
    for (const stableId of [...this.compactionWaiters.keys()]) {
      this.emitContextCompaction(this.compactionLifecycle.failInvocation(stableId, err.message))
      this.compactionWaiters.get(stableId)?.({ id: stableId, state: 'failed', error: err.message })
    }
    if (this.manualCompaction?.turnId) this.completedTurnIds.add(this.manualCompaction.turnId)
    this.compactionActivity.resetNative()
    for (const id of [...this.runningCompactions.keys()]) {
      this.emitContextCompaction(this.compactionLifecycle.failInvocation(id, err.message))
    }
    if (message) {
      this.emitEvent({ type: 'error', state: 'failed', payload: { message } })
    }
    if (this.curTurnId) this.finishTurn(false, this.curTurnId, undefined, true)
    else if (this.startingReviewToken) {
      this.reviewCancellation?.rejectCancellation(err)
    }
    else if (this.startingTurnToken) this.finishTurn(false, undefined, this.startingTurnToken, true)
  }

  // ---- JSON-RPC plumbing ----

  // Kept as a narrow raw-frame hook for the existing adapter contract tests.
  // Production frames arrive through transport's typed notification/request events.
  private onMessage(msg: any): void {
    // 需求2(发现步骤) — env-gated raw capture of compaction-adjacent traffic so we
    // can confirm, on the packaged app, which field carries the post-compaction
    // token figure. Off unless UA_DUMP_COMPACT is set; never affects production.
    if (process.env.UA_DUMP_COMPACT) dumpCompactionTraffic(msg)
    if (msg.method) {
      if (msg.id !== undefined) {
        const transport = this.transport
        if (transport && this.isTransportOwner(this.connectionGeneration, transport)) {
          this.onServerRequest(msg, this.connectionGeneration, transport)
        } else {
          // Retained only for the narrow raw-frame contract tests. Production
          // requests enter through createTransport's generation-bound listener.
          this.onServerRequest(msg)
        }
      }
      else this.onNotification(msg.method, msg.params || {})
      return
    }
  }

  private rpc(method: string, params: any): Promise<any> {
    if (!this.transport) return Promise.reject(new Error('app-server 未连接'))
    return this.transport.request(method, params)
  }

  private rpcSequenced(
    method: string,
    params: any
  ): Promise<{ result: any; sequence: number }> {
    if (!this.transport) return Promise.reject(new Error('app-server 未连接'))
    if (this.transport.requestSequenced) return this.transport.requestSequenced(method, params)
    return this.transport.request(method, params).then((result) => ({
      result,
      sequence: this.lastGoalWireSequence + 1
    }))
  }

  private notify(method: string, params: any): void {
    this.transport?.notify(method, params)
  }

  private write(obj: any): void {
    if (obj?.method) this.transport?.notify(obj.method, obj.params)
    else if (obj?.id !== undefined) this.transport?.respond(obj.id, obj.result)
  }

  // ---- server -> client requests (approvals / questions) ----

  /**
   * A server→client request (Doc3). With approvalPolicy='never' (full-access)
   * these shouldn't arrive, so we keep the auto-decision as a defensive
   * fallback. Otherwise we register the request and surface an
   * `approval_request` UAEvent; the renderer collects the user's decision and
   * calls respond(), which replies on the stored id.
   */
  private onServerRequest(
    msg: any,
    connectionGeneration?: number,
    requestTransport?: AppServerRpc
  ): void {
    const method: string = msg.method
    const kind = approvalKind(method, msg.params)
    const hasOwner =
      connectionGeneration !== undefined &&
      requestTransport !== undefined &&
      this.isTransportOwner(connectionGeneration, requestTransport)
    if ((connectionGeneration !== undefined || requestTransport !== undefined) && !hasOwner) return
    // full-access pre-authorizes everything — answer immediately, no UI. BUT a
    // question / elicitation is a request for *information*, not a permission:
    // "跳过审批" must never silently skip it (that's the "问题被跳过了" bug), so
    // those are always surfaced interactively regardless of permission mode.
    const isElicitation = kind === 'question' || kind === 'elicitation'
    if (this.config.permissionMode === 'full-access' && !isElicitation) {
      if (hasOwner) requestTransport.respond(msg.id, this.autoDecision(method, true, kind))
      else this.write({ jsonrpc: '2.0', id: msg.id, result: this.autoDecision(method, true, kind) })
      return
    }
    const requestId = hasOwner
      ? `req_${connectionGeneration}_${String(msg.id)}`
      : `req_${String(msg.id)}`
    if (hasOwner) {
      this.pendingRequests.set(requestId, {
        rpcId: msg.id,
        method,
        kind,
        transport: requestTransport,
        connectionGeneration
      })
    }
    this.emitEvent({
      type: 'approval_request',
      state: 'pending',
      payload: {
        requestId,
        method,
        kind,
        params: msg.params || {}
      }
    })
  }

  private requirePermissionMode(): PermissionMode {
    const mode = this.config.permissionMode
    if (!mode) throw new Error(`${this.agent.name} 缺少有效权限模式`)
    if (!this.agent.capabilities.permissionModes.some((entry) => entry.id === mode)) {
      throw new Error(`${this.agent.name} 不支持权限模式：${mode}`)
    }
    return mode
  }

  /**
   * Build the immediate decision object for the full-access fast path. Uses the
   * per-method response vocabulary (accept/decline vs approved/denied vs the
   * request_user_input answers map).
   */
  private autoDecision(method: string, approve: boolean, kind?: string): any {
    if (method === 'item/tool/requestUserInput') {
      // No interactive prompt on the fast path: answer nothing.
      return { answers: {} }
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: approve ? 'approved' : 'denied' }
    }
    if (kind === 'mcpTool') return mcpToolApprovalAnswer(approve ? 'accept' : 'decline')
    // command/file/permissions approvals use accept/decline.
    return { decision: approve ? 'accept' : 'decline' }
  }

  // ---- notification -> UAEvent mapping ----

  private onNotification(
    method: string,
    p: any,
    wireSequence?: number,
    receivedAt = Date.now()
  ): void {
    if (!method.endsWith('/delta')) {
      this.emitDiagnostic('provider_notification', { method, wireSequence, receivedAt, payload: p })
    }
    // 子agent隔离 — the app-server multiplexes child-thread notifications onto the
    // SAME stdio as the parent's. Every item/delta/turn/token notification carries
    // a `threadId`; when it is NOT our parent thread it belongs to a sub-agent and
    // must stay OUT of the main chat (which shows the main agent alone). Child
    // content is surfaced only in the sidebar (its own rollout, polled from disk).
    const threadId: string | undefined = p?.threadId || p?.thread?.id
    if (threadId && this.pendingSideForks.has(threadId)) return
    if (
      threadId &&
      threadId !== this.threadId &&
      threadId !== this.codexTitleGeneration?.threadId &&
      this.sideForksInFlight > 0 &&
      !this.childThreads.has(threadId)
    ) {
      this.deferredForeignNotifications.push({ method, params: p, wireSequence, receivedAt })
      return
    }
    if (threadId && threadId === this.codexTitleGeneration?.threadId) {
      this.onCodexTitleNotification(method, p)
      return
    }
    const isChild = this.isChildThread(threadId)
    if (
      !isChild &&
      this.reviewStartup &&
      this.startingReviewToken === this.reviewStartup.token &&
      this.transport === this.reviewStartup.transport &&
      this.connectionGeneration === this.reviewStartup.connectionGeneration &&
      REVIEW_STARTUP_NOTIFICATION_METHODS.has(method)
    ) {
      this.reviewStartup.notifications.push({ method, params: p, wireSequence, receivedAt })
      return
    }
    if (!isChild && (threadId == null || threadId === this.threadId) && isQueueWaitProgress(method, p)) {
      const turnToken = this.activeTurnToken || this.startingTurnToken
      if (turnToken) this.completeQueueWait(turnToken, this.curTurnId, receivedAt, true)
    }
    switch (method) {
      case 'skills/changed':
        this.emit('skillsChanged')
        break
      case 'mcpServer/startupStatus/updated': {
        if (threadId != null && threadId !== this.threadId) break
        const name = typeof p?.name === 'string' ? p.name.trim() : ''
        const liveStatus = p?.status
        if (
          !name ||
          (liveStatus !== 'starting' && liveStatus !== 'ready' && liveStatus !== 'failed' && liveStatus !== 'cancelled')
        ) {
          this.emitIgnoredNotification(method, !name ? 'missing_server_name' : 'unknown_startup_status', p)
          break
        }
        const status = p?.failureReason === 'reauthenticationRequired'
          ? 'auth-required'
          : liveStatus
        const statusMessage = typeof p?.error === 'string' && p.error.trim()
          ? p.error.trim()
          : undefined
        this.emit('mcpStatusChanged', { name, status, statusMessage })
        break
      }
      case 'thread/goal/updated':
        if (threadId !== this.threadId) break
        this.applyGoalState(
          p?.goal ? normalizeGoal(p.goal) : undefined,
          wireSequence ?? this.lastGoalWireSequence + 1
        )
        break
      case 'thread/goal/cleared':
        if (threadId !== this.threadId) break
        this.applyGoalState(undefined, wireSequence ?? this.lastGoalWireSequence + 1)
        break
      case 'thread/settings/updated': {
        const collaborationMode = p?.threadSettings?.collaborationMode
        if (threadId !== this.threadId) break
        if (!collaborationMode) {
          this.emitIgnoredNotification(method, 'missing_collaboration_mode', p)
          break
        }
        const rawMode = collaborationMode?.mode
        if (rawMode === 'default' || rawMode === 'plan') {
          this.applyCollaborationModeState(
            rawMode,
            wireSequence ?? this.lastCollaborationModeWireSequence + 1
          )
        } else {
          this.emitEvent({
            type: 'system_notice',
            payload: {
              kind: 'warning',
              text: '收到无法安全识别的 collaboration mode 更新，已忽略。'
            }
          })
          this.emitIgnoredNotification(method, 'unknown_collaboration_mode', p)
        }
        break
      }
      case 'thread/name/updated': {
        if (threadId === this.threadId && !this.applyProviderThreadTitle({ name: p?.threadName })) {
          this.emitIgnoredNotification(method, 'missing_thread_name', p)
        }
        break
      }
      case 'thread/name/generated': {
        const title = stringValue(p?.name)
        if (
          this.agent.adapter === 'traex' &&
          threadId === this.threadId &&
          this.traexTitleRequestId !== undefined &&
          p?.turnId === this.traexTitleRequestId
        ) {
          this.traexTitleRequestId = undefined
          if (title) this.emit('sessionInfo', { title, persistProvider: true })
          else if (typeof p?.name === 'string') {
            // An empty generated name is a valid no-result response. Keep the
            // current title and allow a later user turn to try again, not a
            // recursive retry that would spend more quota on the same turn.
            this.shouldGenerateInitialTitle = true
          } else {
            this.shouldGenerateInitialTitle = true
            this.emitIgnoredNotification(method, 'missing_thread_name', p)
          }
        }
        break
      }
      case 'mode/changeRequested':
        this.onModeChangeRequested(p)
        break
      case 'mode/changeResolved':
        if (threadId !== this.threadId) break
        if (p?.requestId !== undefined) {
          this.resolvePendingByRpcId(
            this.connectionGeneration,
            p.requestId,
            'mode/change/respond',
            p?.decision === 'approved' ? 'success' : 'cancelled'
          )
        }
        if (p?.decision === 'approved' && (p?.targetMode === 'plan' || p?.targetMode === 'default')) {
          this.applyCollaborationModeState(
            p.targetMode,
            wireSequence ?? this.lastCollaborationModeWireSequence + 1
          )
        }
        break
      case 'item/started':
        if (isChild) {
          this.noteChildActivity(threadId!)
          break
        }
        // Steered input can arrive after a final_answer while the native turn continues.
        if (threadId === this.threadId && p.turnId === this.curTurnId) {
          this.completedAgentTurnToken = undefined
          this.clearFinalAnswerCompletionFallback()
        }
        this.onItemStarted(p.item, p.turnId)
        break
      case 'item/completed':
        if (isChild) {
          this.noteChildActivity(threadId!)
          break
        }
        if (threadId === this.threadId && p?.item?.type === 'userMessage') {
          this.maybeGenerateInitialTitle(this.initialTitleSeed || this.activeTurnPrompt || userMessageText(p.item))
        }
        if (this.onItemCompleted(p.item, p.turnId)) this.schedulePlanCompletionFallback(p)
        this.scheduleFinalAnswerCompletionFallback(p)
        break
      case 'item/agentMessage/delta':
        if (isChild) break
        if (this.isUsableDelta(method, p)) this.onTextDelta(p.itemId, p.delta, 'agent', p.turnId)
        break
      case 'item/plan/delta':
        if (isChild) break
        if (this.isUsableDelta(method, p)) this.onPlanDelta(p.itemId, p.delta, p.turnId)
        break
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (isChild) break
        if (this.isUsableDelta(method, p)) this.onTextDelta(p.itemId, p.delta, 'reasoning', p.turnId)
        break
      case 'item/commandExecution/outputDelta':
        if (isChild) break
        if (this.isUsableDelta(method, p)) this.onCmdDelta(p.itemId, p.delta)
        break
      case 'item/commandExecution/terminalInteraction':
        // The command card already owns command/output lifecycle. This is a
        // stdin interaction tick and may contain sensitive input, so consume it
        // without creating a duplicate card or compatibility warning.
        break
      case 'account/rateLimits/updated': {
        const snapshot = normalizeCodexRateLimits(p?.rateLimits)
        if (snapshot) this.emit('rateLimits', snapshot)
        // 全 null 是额度耗尽/第三方来源的空快照（见 rememberCodexRateLimits），
        // 属预期形态，静默消费；只有结构本身缺失才算异常。
        else if (!p?.rateLimits || typeof p.rateLimits !== 'object') {
          this.emitIgnoredNotification(method, 'missing_rate_limits', p)
        }
        break
      }
      case 'account/updated':
        // Account metadata is informational; usage updates arrive separately.
        break
      case 'turn/completed':
        if (isChild) {
          // The notification is terminal, but the turn itself may have failed or
          // been interrupted before the child produced any output.
          const status = p?.turn?.status
          const childStatus = status === 'completed' ? 'completed'
            : status === 'interrupted' || status === 'cancelled' ? 'interrupted'
              : status === 'failed' ? 'errored' : undefined
          if (childStatus) this.markChildStatus(threadId!, childStatus)
          break
        }
        if (typeof p?.turn?.id === 'string' && p.turn.id) this.onTurnCompleted(p.turn, receivedAt)
        else this.emitIgnoredNotification(method, 'missing_turn_id', p)
        break
      case 'turn/started': {
        if (isChild || (threadId != null && threadId !== this.threadId)) break
        const startedTurnId = typeof p?.turn?.id === 'string' ? p.turn.id : undefined
        if (!startedTurnId) {
          this.emitIgnoredNotification(method, 'missing_turn_id', p)
          break
        }
        const invocation = this.manualCompaction
        if (invocation?.requesting && !invocation.turnId && !this.completedTurnIds.has(startedTurnId)) {
          invocation.turnId = startedTurnId
          if (this.contextRecovery?.cancelled) this.interrupt()
        }
        this.adoptProviderTurn(startedTurnId)
        break
      }
      case 'turn/diff/updated':
        // Aggregated unified diff for the whole turn (Doc4 需求5). Feeds the
        // read-only code-review sidebar; keyed by turnId so it replaces in place.
        if (isChild) break
        this.emitEvent({
          type: 'diff_update',
          state: 'running',
          // 需求3（回退关联）— carry the stable native `turnId` alongside the
          // merge id so turn artifacts can bind this aggregated diff to the exact
          // turn (id is prefixed/formatted for merge; turnId is the raw key).
          payload: { id: `diff-${p.turnId || this.curTurnId || 't'}`, turnId: p.turnId || this.curTurnId, diff: p.diff || '' }
        })
        break
      case 'turn/plan/updated':
        // Doc4 — normalized multi-step plan for the current turn. The CLI pushes
        // the full plan snapshot each update; we归一 to plan_update and key it by
        // `plan-<turnId>` so repeated updates replace in place (like queue_status).
        if (isChild) break
        this.onPlanUpdated(p)
        break
      case 'queue/status':
      case 'turn/queue/status':
      case 'thread/queue/updated':
        // Doc1 — TraeX server-side queue progression for the current turn. The
        // CLI reports how long the request waits in the backend queue before a
        // slot frees up (queued → waiting → ready). Only traecli emits this;
        // codex/claude never do, so their turns simply skip the banner. Keyed by
        // `queue-<turnId>` so the growing state replaces in place.
        if (isChild || (threadId != null && threadId !== this.threadId)) break
        this.onQueueStatus(p, receivedAt)
        break
      case 'serverRequest/resolved':
        // The server itself resolved a pending request (e.g. auto-approval /
        // timeout). Drop it from our pending map so the UI stops waiting.
        if (p?.requestId !== undefined) this.resolvePendingByRpcId(this.connectionGeneration, p.requestId)
        else this.emitIgnoredNotification(method, 'missing_request_id', p)
        break
      case 'hook/started':
      case 'hook/completed': {
        if (isChild) break
        const run = p?.run
        if (typeof run?.id !== 'string' || !run.id) {
          this.emitIgnoredNotification(method, 'missing_run_id', p)
          break
        }
        const status = typeof run.status === 'string' ? run.status : undefined
        this.emitEvent({
          type: 'hook',
          state: method === 'hook/started' || status === 'running'
            ? 'running'
            : status === 'failed'
              ? 'failed'
              : status === 'cancelled'
                ? 'cancelled'
                : 'success',
          payload: { ...run, id: run.id, threadId, turnId: p?.turnId }
        })
        break
      }
      case 'error':
        if (isChild) {
          if (p?.willRetry !== true) this.markChildStatus(threadId!, 'errored')
          break
        }
        if (p?.willRetry === true) {
          this.emitEvent({
            type: 'system_notice',
            state: 'running',
            payload: {
              kind: 'reconnect',
              id: `reconnect-${p?.turnId || this.curTurnId || 'turn'}-${wireSequence ?? receivedAt}`,
              turnId: p?.turnId || this.curTurnId,
              text: 'Reconnect…'
            }
          })
          break
        }
        {
          const errorTurnId = typeof p?.turnId === 'string' && p.turnId
            ? p.turnId
            : this.curTurnId || this.manualCompaction?.turnId
          if (errorTurnId && this.completedTurnIds.has(errorTurnId)) break
          if (errorTurnId && this.canRecoverContextOverflow(p.error)) {
            this.contextOverflowError = { turnId: errorTurnId, error: p.error }
            break
          }
          if (errorTurnId) this.reportedTerminalErrorTurns.add(errorTurnId)
          if (errorTurnId) {
            this.failUnfinishedCompactions(errorTurnId, extractMsg(p.error))
            const invocation = this.manualCompaction
            if (invocation && invocation.turnId === errorTurnId) {
              const failure: CompactionTransition = { id: invocation.id, state: 'failed', error: extractMsg(p.error) }
              this.emitContextCompaction(this.compactionLifecycle.failInvocation(invocation.id, failure.error))
              this.compactionWaiters.get(invocation.id)?.(failure)
            }
          }
        }
        if (this.contextRecovery && this.manualCompaction) break
        this.emitEvent({
          type: 'error',
          state: 'failed',
          payload: { message: extractMsg(p.error), providerError: p.error, threadId, turnId: p?.turnId }
        })
        break
      case 'warning':
      case 'configWarning':
      case 'guardianWarning':
      case 'deprecationNotice':
        if (isChild) break
        // 修复#5 — suppress the noisy "Ignoring malformed agent role definition …"
        // config-loader chatter (pure de-dup noise, not actionable).
        if (isIgnorableWarning(p.message || p.text || extractMsg(p))) break
        this.emitEvent({
          type: 'system_notice',
          payload: { kind: 'warning', text: p.message || p.text || extractMsg(p) }
        })
        break
      case 'thread/tokenUsage/updated':
        if (isChild) {
          // A child's token usage belongs in the sidebar detail, never the main
          // chat's token card / context meter.
          this.onChildTokenUsage(threadId!, p.tokenUsage)
          break
        }
        // `turn/completed` carries no usage; these ticks are the only source.
        // Stash the latest and surface it in the turn-completed footer.
        if (!p?.tokenUsage) {
          this.emitIgnoredNotification(method, 'missing_token_usage', p)
          break
        }
        this.tokenUsageSerial += 1
        this.lastTokenUsage = p.tokenUsage
        this.armGoalCompletionFallback(true)
        // 需求(实时上下文): also push a lightweight, non-rendering `context` notice
        // each tick so the composer's context meter fills DURING the turn instead
        // of only jumping at turn/completed. Carries just the occupancy figure +
        // window; the timeline groups `kind:'context'` out (see EventStream).
        this.emitLiveContext(p.tokenUsage)
        break
      case 'uniagent/tokenSpeed':
        if (!isChild && threadId === this.threadId) {
          this.emitEvent({ type: 'system_notice', ts: p.ts,
            payload: { id: p.id, kind: 'token_speed', speed: p.speed } })
        }
        break
      case 'thread/compacted':
      case 'context/compacted':
      case 'context_compacted':
        if (isChild) break
        this.emitContextCompaction(this.compactionLifecycle.compacted(p?.itemId || p?.item?.id))
        this.emitTurnNotice('compacted', '上下文已自动压缩，后续回复将基于压缩后的上下文继续。')
        // 需求2 — auto compaction also shrinks context; if the notification (or
        // its embedded item) carries a usage snapshot, refresh the meter now
        // rather than waiting for the next token tick to self-heal.
        this.emitPostCompactionContext(compactionTokenUsage(p) || compactionTokenUsage(p?.item))
        break
      case 'model/rerouted':
      case 'model/fallback':
      case 'model/verification':
        if (isChild) break
        this.emitModelNotice(method, p)
        break
      case 'thread/started': {
        const thread = p?.thread
        const spawn = (thread?.source?.subAgent ?? thread?.source?.subagent)?.thread_spawn
        if (!threadId || threadId === this.threadId || spawn?.parent_thread_id !== this.threadId) break
        const knownChild = this.childThreads.has(threadId)
        this.childThreads.add(threadId)
        const name = nativeSubAgentName(thread)
        if (!name) break
        this.childNameMap.set(threadId, name)
        // A late metadata notification enriches existing rows without creating
        // a new dispatch or reopening a terminal child.
        if (knownChild) this.noteChildActivity(threadId)
        break
      }
      // Remaining provider lifecycle/status broadcasts are informational.
      case 'thread/closed':
      case 'thread/status/changed':
      case 'thread/inboxStatus/updated':
      case 'remoteControl/status/changed':
      case 'item/reasoning/summaryPartAdded':
        break
      // TraeX worktree 会话进入/更新广播：UniAgent 不展示 worktree 视图，
      // 仅消费，避免每次进入 worktree 都产生 ignored_provider_event 噪音。
      case 'thread/worktreeSession/entered':
      case 'thread/worktreeSession/updated':
        break
      default:
        if (!isChild) this.emitIgnoredNotification(method, 'unsupported_method', p)
        break
    }
  }

  private replayDeferredForeignNotifications(): void {
    const notifications = this.deferredForeignNotifications
    this.deferredForeignNotifications = []
    for (const notification of notifications) {
      if (this.pendingSideForks.has(notification.params?.threadId)) continue
      this.onNotification(
        notification.method,
        notification.params,
        notification.wireSequence,
        notification.receivedAt
      )
    }
  }

  private isUsableDelta(method: string, p: any): boolean {
    const reason = typeof p?.itemId !== 'string' || !p.itemId
      ? 'missing_item_id'
      : typeof p?.delta !== 'string'
        ? 'missing_delta'
        : undefined
    if (!reason) return true
    this.emitIgnoredNotification(method, reason, p)
    return false
  }

  private emitIgnoredNotification(method: string, reason: string, sample: unknown): void {
    const label = this.agent.adapter === 'traex' ? 'TraeX' : 'Codex'
    const field = 'notification:' + method + ':' + reason
    if (this.ignoredEventKeys.has(field)) return
    this.ignoredEventKeys.add(field)
    this.emitDiagnostic('ignored_provider_event', {
      agentId: this.agent.id,
      adapter: this.agent.adapter,
      method,
      reason,
      field,
      message: label + ' app-server 忽略了 notification "' + method + '"（' + reason + '）。',
      sample
    })
  }

  private onModeChangeRequested(p: any): void {
    const transport = this.transport
    const threadId = this.threadId
    const providerRequestId = stringValue(p?.requestId)
    if (!threadId || p?.threadId !== threadId || !providerRequestId || !transport) return
    this.clearPlanCompletionFallback()
    if (p?.targetMode === 'plan') {
      void transport.request('mode/change/respond', {
        threadId,
        requestId: providerRequestId,
        decision: 'approved'
      }).catch((error) => {
        this.emitEvent({
          type: 'error',
          state: 'failed',
          payload: { message: `Plan 模式切换响应失败: ${extractMsg(error)}` }
        })
      })
      return
    }
    if (p?.targetMode !== 'default') {
      this.emitIgnoredNotification('mode/changeRequested', 'unknown_target_mode', p)
      return
    }
    const requestId = `mode_${this.connectionGeneration}_${providerRequestId}`
    if (this.pendingRequests.has(requestId)) return
    this.pendingRequests.set(requestId, {
      rpcId: providerRequestId,
      method: 'mode/change/respond',
      kind: 'planMode',
      transport,
      connectionGeneration: this.connectionGeneration
    })
    this.emitEvent({
      type: 'approval_request',
      state: 'pending',
      payload: {
        requestId,
        method: 'mode/change/respond',
        kind: 'planMode',
        params: p
      }
    })
  }

  private emitIgnoredItem(item: any, phase: 'started' | 'completed', reason = 'unsupported_type'): void {
    const type = typeof item?.type === 'string' && item.type ? item.type : 'unknown'
    const label = this.agent.adapter === 'traex' ? 'TraeX' : 'Codex'
    const field = 'item:' + type + ':' + phase + (reason === 'unsupported_type' ? '' : ':' + reason)
    if (this.ignoredEventKeys.has(field)) return
    this.ignoredEventKeys.add(field)
    this.emitDiagnostic('ignored_provider_event', {
      agentId: this.agent.id,
      adapter: this.agent.adapter,
      itemType: type,
      phase,
      reason,
      field,
      message: label + ' app-server 忽略了 ' + phase + ' item "' + type + '"（' + reason + '）。',
      sample: item
    })
  }

  private emitTurnNotice(key: string, text: string, kind: 'notice' | 'warning' = 'notice'): void {
    if (this.turnNoticeKeys.has(key)) return
    this.turnNoticeKeys.add(key)
    this.emitEvent({ type: 'system_notice', payload: { kind, text } })
  }

  /** Surface every server-initiated model change, once per semantic change/turn. */
  private emitModelNotice(method: string, p: any): void {
    const normalized = normalizeServerModelNotification(method, p, this.agent.models)
    if (!normalized) return
    if (!claimModelNotification(this.turnNoticeKeys, normalized.key)) return
    this.emitEvent({
      type: 'system_notice',
      payload: { kind: normalized.noticeKind, text: normalized.text }
    })
    if (normalized.correction) {
      const source = this.config.modelSource
      const correction = source && source.kind !== 'native' && normalized.correction.model
        ? { ...normalized.correction, model: codexModelKey(normalized.correction.model, source) }
        : normalized.correction
      this.emit('configCorrection', correction)
    }
  }

  /**
   * 子agent隔离 — is this notification's threadId one of the sub-agent threads we
   * are multiplexing? The parent thread (this.threadId) is never a child; an
   * undefined/absent threadId is treated as the parent (older builds omit it on
   * some notifications, and those are always the primary turn).
   */
  private isChildThread(threadId?: string): boolean {
    if (!threadId) return false
    if (threadId === this.threadId) return false
    return this.childThreads.has(threadId)
  }

  private applyProviderThreadTitle(thread: any): boolean {
    const title = stringValue(thread?.name)
    if (!title) return false
    this.shouldGenerateInitialTitle = false
    this.emit('sessionInfo', { title })
    return true
  }

  private maybeGenerateInitialTitle(userMessage: string): void {
    if (!this.shouldGenerateInitialTitle || !userMessage || !this.threadId) return
    this.shouldGenerateInitialTitle = false
    if (this.agent.adapter === 'traex') {
      const requestId = randomUUID()
      this.traexTitleRequestId = requestId
      void this.rpc('thread/name/generate', { threadId: this.threadId, requestId }).catch((error) => {
        if (this.traexTitleRequestId !== requestId) return
        this.traexTitleRequestId = undefined
        this.shouldGenerateInitialTitle = true
        this.emitDiagnostic('title_generation_failed', { stage: 'thread/name/generate', message: extractMsg(error) })
      })
    } else if (this.agent.adapter === 'codex') {
      void this.generateCodexTitle(userMessage)
    }
  }

  private async generateCodexTitle(userMessage: string): Promise<void> {
    const transport = this.transport
    if (!transport || !this.threadId) return
    const connectionGeneration = this.connectionGeneration
    let titleThreadId: string | undefined
    let stage = 'config/read'
    const request = async <T>(method: string, params: any): Promise<T> => {
      if (!this.isTransportOwner(connectionGeneration, transport)) throw new Error('app-server 已关闭')
      const result = await transport.request<T>(method, params)
      if (!this.isTransportOwner(connectionGeneration, transport)) throw new Error('app-server 已关闭')
      return result
    }
    try {
      const config = await request<any>('config/read', {
        includeLayers: false,
        cwd: this.config.workdir
      })
      const mcpServers = Object.keys(config?.config?.mcp_servers || {})
      const supplemental = this.config.modelSource?.kind !== undefined && this.config.modelSource.kind !== 'native'
      const useTitleModel = !supplemental && this.agent.models.some(({ id }) => id === THREAD_TITLE_MODEL)
      stage = 'thread/start'
      const response = await request<any>('thread/start', {
        ...this.threadModelParams(),
        model: useTitleModel ? THREAD_TITLE_MODEL : this.wireConfig().model || this.agent.defaultModel,
        cwd: this.config.workdir,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        threadSource: 'system',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: {
          // 标题线程与主线程使用同一模型/provider：共享 app-server 进程不再带
          // -c 覆盖，provider 定义（uniagent-local / uniagent-<source>）必须随
          // 每线程 config 下发，否则 thread/start 直接报 Model provider not found。
          ...this.threadConfigOverrides(this.sessionId, true),
          ...titleGenerationConfig(mcpServers)
        }
      })
      titleThreadId = stringValue(response?.thread?.id)
      if (!titleThreadId) throw new Error('thread/start 未返回 thread id')
      this.codexTitleGeneration = {
        transport,
        threadId: titleThreadId
      }
      stage = 'turn/start'
      await request<any>('turn/start', {
        threadId: titleThreadId,
        input: [{ type: 'text', text: threadTitlePrompt(userMessage), text_elements: [] }],
        outputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: THREAD_TITLE_MAX_CHARS }
          },
          required: ['title'],
          additionalProperties: false
        },
        ...(useTitleModel ? { effort: 'low' } : {})
      })
    } catch (error) {
      this.codexTitleGeneration = undefined
      this.shouldGenerateInitialTitle = true
      this.emitDiagnostic('title_generation_failed', {
        stage,
        message: extractMsg(error)
      })
      if (titleThreadId && this.isTransportOwner(connectionGeneration, transport)) {
        void transport.request('thread/unsubscribe', { threadId: titleThreadId }).catch(() => {})
      }
    }
  }

  private onCodexTitleNotification(method: string, p: any): void {
    const generation = this.codexTitleGeneration
    if (!generation) return
    if (method === 'error') {
      if (p?.willRetry !== true && p?.error) generation.error = extractMsg(p.error)
      return
    }
    if (method === 'item/completed' && p?.item?.type === 'agentMessage') {
      generation.response = typeof p.item.text === 'string' ? p.item.text : undefined
      return
    }
    if (method !== 'turn/completed') return
    this.codexTitleGeneration = undefined
    const title = p?.turn?.status === 'completed' ? parseThreadTitle(generation.response) : undefined
    if (title) {
      this.emit('sessionInfo', { title, persistProvider: true })
    } else {
      this.shouldGenerateInitialTitle = true
      this.emitDiagnostic('title_generation_failed', {
        stage: 'response',
        message: p?.turn?.status === 'completed'
          ? '标题响应格式无效'
          : p?.turn?.error ? extractMsg(p.turn.error)
            : generation.error || `标题回合未完成：${String(p?.turn?.status || 'unknown')}`
      })
    }
    void generation.transport.request('thread/unsubscribe', {
      threadId: generation.threadId
    }).catch(() => {})
  }

  /**
   * 子agent隔离 — a child produced an item; keep it 进行中 in the roster (unless a
   * terminal state was already recorded) so its live status stays fresh. The
   * child's actual output is read from its own rollout by the sidebar.
   */
  private noteChildActivity(threadId: string): void {
    const dispatch = this.subAgentDispatches.current(threadId)
    this.emitEvent({
      type: 'subagent',
      state: 'running',
      payload: {
        id: `sa-activity-${threadId}-${dispatch?.generation ?? 0}`,
        agents: [
          {
            agentThreadId: threadId,
            parentThreadId: this.threadId,
            status: 'running',
            name: this.childName(threadId),
            ...dispatch
          }
        ]
      }
    })
  }

  /** 子agent隔离 — force a child's roster status (completed / errored / …). */
  private markChildStatus(
    threadId: string,
    status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound',
    dispatchOverride?: SubAgentDispatchStamp,
    observedAt = Date.now()
  ): void {
    const dispatch = dispatchOverride ?? this.subAgentDispatches.current(threadId)
    if (!this.claimSubAgentTerminal(threadId, dispatch?.generation, status)) return
    const endedAt = status === 'running' || status === 'pendingInit' ? undefined : observedAt
    this.emitEvent({
      type: 'subagent',
      state: status === 'running' ? 'running' : 'success',
      payload: {
        // One terminal event is emitted per generation (guarded above).
        id: `sa-status-${threadId}-${dispatch?.generation ?? 0}-${status}`,
        agents: [
          {
            agentThreadId: threadId,
            parentThreadId: this.threadId,
            status,
            name: this.childName(threadId),
            endedAt,
            ...dispatch
          }
        ]
      }
    })
  }

  private claimSubAgentTerminal(
    threadId: string,
    generation: number | undefined,
    status: UASubAgent['status']
  ): boolean {
    if (!isSubAgentTerminal(status)) return true
    const key = `${threadId}\u0000${generation ?? 0}`
    if (this.terminalSubAgentGenerations.has(key)) return false
    this.terminalSubAgentGenerations.add(key)
    this.terminalSubAgentThreads.add(threadId)
    return true
  }

  /**
   * 子agent隔离 — normalize a child's cumulative token usage and push it into the
   * roster (sidebar detail only). Priced with the child's own spawn model, else
   * the session model.
   */
  private onChildTokenUsage(threadId: string, tokenUsage: any): void {
    if (!tokenUsage) return
    this.childTokenUsage.set(threadId, tokenUsage)
    const total = totalBreakdown(tokenUsage) || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    const modelId = this.childModel.get(threadId) || this.config.model
    const cost = computeCost(total, modelId)
    const dispatch = this.subAgentDispatches.current(threadId)
    this.emitEvent({
      type: 'subagent',
      state: 'running',
      payload: {
        id: `sa-tokens-${threadId}-${dispatch?.generation ?? 0}`,
        agents: [
          {
            agentThreadId: threadId,
            parentThreadId: this.threadId,
            status: 'running',
            name: this.childName(threadId),
            ...dispatch,
            tokens: {
              inputTokens: total.inputTokens,
              outputTokens: total.outputTokens,
              totalTokens: total.inputTokens + total.outputTokens,
              cost
            }
          }
        ]
      }
    })
  }

  /** 子agent隔离 — best-effort display name for a child (cached from spawn). */
  private childName(threadId: string): string | undefined {
    return this.childNameMap.get(threadId)
  }

  private onItemStarted(item: any, turnId?: string): void {
    if (!item?.id) {
      this.emitIgnoredItem(item, 'started', 'missing_item_id')
      return
    }
    if (turnId || this.curTurnId) this.itemTurn.set(item.id, turnId || this.curTurnId!)
    switch (item.type) {
      case 'agentMessage':
        this.itemType.set(item.id, 'agent')
        this.textBuf.set(item.id, item.text || '')
        this.emitEvent({
          type: 'agent_message',
          state: 'running',
          payload: {
            id: item.id,
            text: item.text || '',
            ...(item.phase ? { phase: item.phase } : {}),
            ...(item.delivery ? { delivery: item.delivery } : {}),
            ...(Array.isArray(item.questions) ? { questions: item.questions } : {}),
            ...(this.itemTurn.get(item.id) ? { turnId: this.itemTurn.get(item.id) } : {})
          }
        })
        break
      case 'plan':
        this.onPlanStarted(item)
        break
      case 'reasoning':
        this.itemType.set(item.id, 'reasoning')
        this.textBuf.set(item.id, reasoningText(item))
        this.emitEvent({
          type: 'reasoning',
          state: 'running',
          payload: { id: item.id, text: this.textBuf.get(item.id) || '' }
        })
        break
      case 'commandExecution':
        this.itemType.set(item.id, 'command')
        this.cmdMeta.set(item.id, { command: item.command })
        this.textBuf.set(item.id, item.aggregatedOutput || '')
        this.emitEvent({
          type: 'command_exec',
          state: 'running',
          payload: { id: item.id, command: item.command, output: item.aggregatedOutput || '' }
        })
        break
      case 'mcpToolCall':
        this.emitEvent({
          type: 'tool_call',
          state: 'running',
          payload: nativeMcpToolPayload(item)
        })
        break
      case 'webSearch':
      case 'imageView':
      case 'sleep':
        this.emitEvent({
          type: 'tool_call',
          state: 'running',
          payload: nativeBuiltinToolPayload(item)
        })
        break
      case 'imageGeneration':
        this.pendingImageGenerations.add(item.id)
        this.emitEvent({
          type: 'tool_call',
          state: 'running',
          payload: imageGenerationPayload(item)
        })
        break
      case 'contextCompaction': {
        if (turnId && this.completedTurnIds.has(turnId)) break
        const transition = this.compactionLifecycle.started(item.id)
        this.emitContextCompaction(transition)
        if (transition) {
          this.compactionActivity.nativeStarted(item.id)
          this.runningCompactions.set(transition.id, { nativeId: item.id, turnId })
          if (this.manualCompaction?.id === transition.id && turnId) this.manualCompaction.turnId = turnId
        }
        break
      }
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        // Doc5 — sub-agent collaboration items. Emit a snapshot immediately so
        // the inline card appears the moment a spawn/send/wait starts.
        this.onSubAgentItem(item, 'started')
        break
      case 'taskNotification':
        this.onTaskNotification(item, 'started', turnId)
        break
      case 'userMessage':
      case 'fileChange':
      case 'dynamicToolCall':
      case 'error':
        break
      default:
        this.emitIgnoredItem(item, 'started')
        break
    }
  }

  private onItemCompleted(item: any, turnId?: string): boolean {
    if (!item) {
      this.emitIgnoredItem(item, 'completed', 'missing_item')
      return false
    }
    if (!item.id) {
      this.emitIgnoredItem(item, 'completed', 'missing_item_id')
      return false
    }
    const snapshotTurnId = turnId || this.itemTurn.get(item.id)
    if (this.curTurnId && snapshotTurnId === this.curTurnId) this.captureCompletedSnapshotItem(item)
    if (turnId || this.curTurnId) this.itemTurn.set(item.id, turnId || this.curTurnId!)
    // Flush any buffered delta for this item before finalizing.
    this.dirty.delete(item.id)
    switch (item.type) {
      case 'agentMessage':
        this.emitEvent({
          type: 'agent_message',
          state: 'success',
          payload: {
            id: item.id,
            text: item.text || this.textBuf.get(item.id) || '',
            ...(this.itemTurn.get(item.id) ? { turnId: this.itemTurn.get(item.id) } : {}),
            ...(item.phase ? { phase: item.phase } : {}),
            ...(item.delivery ? { delivery: item.delivery } : {}),
            ...(Array.isArray(item.questions) ? { questions: item.questions } : {})
          }
        })
        if (item.delivery !== 'async') {
          this.completedAgentTurnToken = this.activeTurnToken || this.startingTurnToken
          this.armGoalCompletionFallback()
        }
        break
      case 'plan': {
        if (!item.id || this.completedPlanItems.has(item.id)) return false
        this.completedPlanItems.add(item.id)
        this.itemType.set(item.id, 'plan')
        const text = typeof item.text === 'string' ? item.text : this.textBuf.get(item.id) || ''
        this.textBuf.set(item.id, text)
        this.emitEvent({
          type: 'agent_message',
          state: 'success',
          payload: {
            id: item.id,
            text,
            kind: 'plan',
            ...(this.itemTurn.get(item.id) ? { turnId: this.itemTurn.get(item.id) } : {})
          }
        })
        return !!text.trim()
      }
      case 'reasoning':
        this.emitEvent({
          type: 'reasoning',
          state: 'success',
          payload: { id: item.id, text: reasoningText(item) || this.textBuf.get(item.id) || '' }
        })
        break
      case 'commandExecution':
        this.emitEvent({
          type: 'command_exec',
          state: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'success',
          payload: {
            id: item.id,
            command: item.command || this.cmdMeta.get(item.id)?.command,
            output: item.aggregatedOutput || this.textBuf.get(item.id) || '',
            exitCode: item.exitCode ?? null,
            durationMs: item.durationMs ?? null
          }
        })
        break
      case 'contextCompaction': {
        if (turnId && this.completedTurnIds.has(turnId)) break
        const failed = item.status === 'failed'
        this.emitContextCompaction(this.compactionLifecycle.completedItem(item.id, failed, item.error?.message))
        this.compactionActivity.nativeFinished(item.id)
        // 需求2 — a successful compaction shrank the context. If the completion
        // item carries a fresh usage snapshot, refresh the occupancy meter now
        // (idle manual /compact produces no later tick to self-heal from).
        if (!failed) this.emitPostCompactionContext(compactionTokenUsage(item))
        break
      }
      case 'fileChange':
        this.emitEvent({
          type: 'file_change',
          state: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'success',
          // 需求3（回退关联）— stamp the file change with the active native turn id
          // so per-turn artifacts can attribute it to the exact turn that made it.
          payload: { id: item.id, turnId: this.curTurnId, changes: (item.changes || []).map(normalizeChange) }
        })
        break
      case 'mcpToolCall':
        this.emitEvent({
          type: 'tool_call',
          state: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'failed' : 'success',
          payload: nativeMcpToolPayload(item)
        })
        break
      case 'dynamicToolCall':
        this.emitEvent({
          type: 'tool_call',
          state: item.status === 'failed' ? 'failed' : 'success',
          payload: { id: item.id, name: item.tool || item.name, input: item.arguments, raw: item }
        })
        break
      case 'webSearch':
      case 'imageView':
      case 'sleep':
        this.emitEvent({
          type: 'tool_call',
          state: 'success',
          payload: nativeBuiltinToolPayload(item)
        })
        break
      case 'imageGeneration':
        this.pendingImageGenerations.delete(item.id)
        this.emitEvent({
          type: 'tool_call',
          state: imageGenerationState(item.status),
          payload: imageGenerationPayload(item)
        })
        break
      case 'error':
        this.emitEvent({
          type: 'system_notice',
          payload: { id: item.id, kind: 'warning', text: item.message }
        })
        break
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        this.onSubAgentItem(item, 'completed')
        break
      case 'taskNotification':
        this.onTaskNotification(item, 'completed', turnId)
        break
      case 'userMessage':
        break
      default:
        this.emitIgnoredItem(item, 'completed')
        break
    }
    return false
  }

  private captureCompletedSnapshotItem(item: any): void {
    const status = String(item?.status ?? '').toLowerCase().replace(/[_-]/g, '')
    if (status === 'inprogress' || status === 'running' || status === 'pending') return
    let event: Pick<UAEvent, 'type' | 'state' | 'payload'> | undefined
    switch (item?.type) {
      case 'commandExecution':
        event = {
          type: 'command_exec',
          state: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'success',
          payload: {
            id: item.id,
            command: item.command || this.cmdMeta.get(item.id)?.command,
            output: item.aggregatedOutput || this.textBuf.get(item.id) || '',
            exitCode: item.exitCode ?? null
          }
        }
        break
      case 'mcpToolCall':
        event = {
          type: 'tool_call',
          state: item.status === 'failed' ? 'failed' : 'success',
          payload: nativeMcpToolPayload(item)
        }
        break
      case 'dynamicToolCall':
        event = {
          type: 'tool_call',
          state: item.status === 'failed' ? 'failed' : 'success',
          payload: {
            id: item.id,
            name: item.tool || item.name,
            input: item.arguments,
            result: item.result ?? null,
            error: item.error ?? null
          }
        }
        break
      case 'webSearch':
      case 'imageView':
      case 'sleep':
        event = { type: 'tool_call', state: 'success', payload: nativeBuiltinToolPayload(item) }
        break
      case 'imageGeneration': {
        const state = imageGenerationState(item.status)
        if (state === 'running') return
        event = { type: 'tool_call', state, payload: imageGenerationPayload(item) }
        break
      }
      case 'fileChange':
        event = {
          type: 'file_change',
          state: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'success',
          payload: { id: item.id, changes: (item.changes || []).map(normalizeChange) }
        }
        break
    }
    if (event) this.completedTurnSnapshotEvents.push(structuredClone(event))
  }

  private currentTurnSnapshotEvents(): Pick<UAEvent, 'type' | 'state' | 'payload'>[] {
    if (!this.activeTurnPrompt || !this.curTurnId) return []
    return [...this.itemType].flatMap<Pick<UAEvent, 'type' | 'state' | 'payload'>>(([id, type]) => {
      if (this.itemTurn.get(id) !== this.curTurnId) return []
      const text = this.textBuf.get(id) || ''
      if (!text) return []
      if (type === 'agent' || type === 'plan') {
        return [{ type: 'agent_message' as const, state: 'running' as const, payload: { id, text } }]
      }
      if (type === 'reasoning') {
        return [{ type: 'reasoning' as const, state: 'running' as const, payload: { id, text } }]
      }
      return []
    })
  }

  private onPlanStarted(item: any): void {
    if (!item?.id || this.completedPlanItems.has(item.id)) return
    if (this.itemType.has(item.id)) return
    const text = typeof item.text === 'string' ? item.text : ''
    this.itemType.set(item.id, 'plan')
    this.textBuf.set(item.id, text)
    this.emitEvent({
      type: 'agent_message',
      state: 'running',
      payload: {
        id: item.id,
        text,
        kind: 'plan',
        ...(this.itemTurn.get(item.id) ? { turnId: this.itemTurn.get(item.id) } : {})
      }
    })
  }

  private onPlanDelta(itemId: string, delta: string, turnId?: string): void {
    if (!itemId || !delta || this.completedPlanItems.has(itemId)) return
    if (!this.itemType.has(itemId)) this.itemType.set(itemId, 'plan')
    if (turnId || this.curTurnId) this.itemTurn.set(itemId, turnId || this.curTurnId!)
    this.textBuf.set(itemId, (this.textBuf.get(itemId) || '') + delta)
    this.markDirty(itemId)
  }

  private onTextDelta(itemId: string, delta: string, kind: 'agent' | 'reasoning', turnId?: string): void {
    if (!itemId || !delta) return
    if (!this.itemType.has(itemId)) this.itemType.set(itemId, kind)
    if (turnId || this.curTurnId) this.itemTurn.set(itemId, turnId || this.curTurnId!)
    this.textBuf.set(itemId, (this.textBuf.get(itemId) || '') + delta)
    this.markDirty(itemId)
  }

  private emitContextCompaction(transition: CompactionTransition | null): void {
    if (!transition) return
    this.emitEvent({
      type: 'context_compaction',
      state: transition.state,
      payload: { id: transition.id, error: transition.error,
        ...(this.manualCompaction?.id === transition.id && this.manualCompaction.reason ? { reason: this.manualCompaction.reason } : {}) }
    })
    if (transition.state === 'running') {
      if (!this.runningCompactions.has(transition.id)) this.runningCompactions.set(transition.id, {})
    } else {
      const active = this.runningCompactions.get(transition.id)
      if (active?.nativeId) this.compactionActivity.nativeFinished(active.nativeId)
      this.runningCompactions.delete(transition.id)
      this.compactionWaiters.get(transition.id)?.(transition)
    }
  }

  /**
   * 需求2(主动压缩更新) — a compaction that SUCCEEDS shrinks the context, but the
   * occupancy bar's only sources (`emitLiveContext` per token tick, and the
   * turn-completed footer) don't refresh until the *next* turn produces a tick.
   * For an idle manual `/compact` no such tick ever comes, so the meter stays
   * stuck at the pre-compaction figure. When the compaction completion carries a
   * usage snapshot, adopt it as the new cumulative baseline (so the next turn's
   * 本轮 consumption isn't inflated by the drop) and push one `context` notice so
   * the meter falls immediately. If the tick path fires later it self-heals too;
   * we never fabricate — without a real figure we emit nothing (see caller).
   */
  private emitPostCompactionContext(tokenUsage: any): void {
    if (!tokenUsage) return
    // The tick handler stashes lastTokenUsage before emitting; mirror that so
    // turn/start's baseline snapshot reflects the post-compaction total.
    this.lastTokenUsage = tokenUsage
    this.emitLiveContext(tokenUsage)
  }

  private emitRejectedCompaction(error: string): void {
    const started = this.compactionLifecycle.beginInvocation()
    this.emitContextCompaction(started)
    this.emitContextCompaction(this.compactionLifecycle.failInvocation(started.id, error))
  }

  private onCmdDelta(itemId: string, delta: string): void {
    if (!itemId || !delta) return
    this.itemType.set(itemId, 'command')
    this.textBuf.set(itemId, (this.textBuf.get(itemId) || '') + delta)
    this.markDirty(itemId)
  }

  private onTurnCompleted(turn: any, receivedAt = Date.now()): void {
    const completedTurnId = typeof turn?.id === 'string' ? turn.id : undefined
    const invocation = this.manualCompaction
    if (completedTurnId && invocation && invocation.turnId === completedTurnId) {
      invocation.turnCompleted = true
      this.completedTurnIds.add(completedTurnId)
      if (turn.status !== 'completed' || !invocation.itemResult) {
        this.emitContextCompaction(this.compactionLifecycle.failInvocation(invocation.id,
          turn.error ? extractMsg(turn.error) : turn.status === 'completed' ? '压缩回合结束，但未收到压缩成功结果' : '压缩回合失败或已中断'))
        // An item success followed by a failed turn is not a successful switch.
        if (invocation.itemResult?.state === 'success') {
          this.compactionWaiters.get(invocation.id)?.({ id: invocation.id, state: 'failed', error: '压缩回合失败或已中断' })
        }
      } else {
        this.compactionWaiters.get(invocation.id)?.(invocation.itemResult)
      }
    }
    if (completedTurnId) this.failUnfinishedCompactions(completedTurnId, turn.error ? extractMsg(turn.error) : '回合已结束，压缩未完成')
    // Local interrupt fallback may have already completed this native turn and
    // allowed a later one to start. Never let the stale notification clear the
    // later turn's token/state. A missing id is invalid for v2 completion.
    if (!completedTurnId) return
    if (!this.curTurnId) {
      if (this.startingTurnToken) this.deferredTurnCompletions.defer(completedTurnId, { turn, receivedAt })
      return
    }
    if (completedTurnId !== this.curTurnId) return
    const failed = turn?.status === 'failed'
    const overflow = this.contextOverflowError && this.contextOverflowError.turnId === completedTurnId ? this.contextOverflowError.error : turn?.error
    if (failed && this.canRecoverContextOverflow(overflow)) {
      this.contextOverflowRetried = true
      this.finishTurn(false, completedTurnId, undefined, false, true)
      void this.recoverContextOverflow(completedTurnId)
      return
    }
    const errorAlreadyReported = this.reportedTerminalErrorTurns.has(completedTurnId)
    if (failed && !errorAlreadyReported) {
      this.emitEvent({
        type: 'error',
        state: 'failed',
        payload: { message: turn.error ? extractMsg(turn.error) : '原生 turn 执行失败' }
      })
    }
    // An interrupted turn (user pressed 中止, G2-9) is a normal, expected end —
    // surface a notice rather than an error so the timeline reads cleanly.
    const interrupted = turn?.status === 'interrupted' || this.interrupting
    if (this.activeTurnToken) {
      this.completeQueueWait(this.activeTurnToken, completedTurnId, receivedAt,
        turn?.status === 'completed' && !interrupted, interrupted ? 'cancelled' : failed ? 'failed' : 'unknown')
    }
    // An active provider Goal may advance through multiple native turns while
    // UniAgent intentionally keeps one logical run open. Preserve that run so a
    // following turn/started can become the steer target; failures and explicit
    // interrupts are still terminal.
    if (
      !!this.activeGoalTurnToken &&
      this.activeGoalTurnToken === (this.activeTurnToken || this.startingTurnToken) &&
      this.agent.adapter === 'traex' &&
      this.goalState?.status === 'active' &&
      turn?.status === 'completed' &&
      !interrupted
    ) {
      this.clearFinalAnswerCompletionFallback(this.activeGoalTurnToken)
      this.completedTurnIds.add(completedTurnId)
      return
    }
    if (interrupted) {
      this.emitEvent({
        type: 'system_notice',
        payload: { kind: 'interrupted', text: '本轮已中断。' }
      })
    }
    if (this.pendingImageGenerations.size > 0) {
      void this.reconcilePendingImageGenerations(completedTurnId)
    }
    this.emitTurnUsage(turn?.durationMs)
    this.finishTurn(interrupted, completedTurnId, undefined, failed)
  }

  private canRecoverContextOverflow(error: any): boolean {
    const source = this.config.modelSource ?? (this.config.model ? parseCodexModelKey(this.config.model)?.source : undefined)
    return this.agent.adapter === 'codex' && source?.kind === 'third-party' &&
      !!(this.activeTurnToken || this.startingTurnToken) && !this.contextOverflowRetried &&
      !this.manualCompaction && !this.interrupting &&
      (error?.codexErrorInfo === 'contextWindowExceeded' || !!providerContextLimit(extractMsg(error)))
  }

  private async recoverContextOverflow(turnId: string): Promise<void> {
    const recovery = { cancelled: false }
    this.contextRecovery = recovery
    this.emitEvent({ type: 'system_notice', payload: { kind: 'notice', text: '目标模型的实际请求超过上下文上限，正在压缩后自动接续。' } })
    try {
      await this.runCompaction(true)
      if (this.disposed) return
      if (recovery.cancelled) throw new Error('压缩接续已中断')
      // The failed native turn already persisted the user's text and attachments.
      await this.startTurn('', undefined, undefined, true)
    } catch (error: any) {
      if (this.disposed) return
      if (!recovery.cancelled) this.emitEvent({ type: 'error', state: 'failed', payload: { message: `上下文压缩后接续失败：${error?.message || error}` } })
      this.emitEvent({ type: 'turn_completed', state: recovery.cancelled ? 'cancelled' : 'failed', payload: { turnId } })
      this.emit('done', { nativeSessionId: this.threadId, interrupted: recovery.cancelled, ...(!recovery.cancelled ? { failed: true } : {}) })
    } finally {
      if (this.contextRecovery === recovery) this.contextRecovery = undefined
    }
  }

  private adoptProviderTurn(turnId: string): void {
    const turnToken = this.activeTurnToken || this.startingTurnToken
    if (!turnToken || this.completedTurnIds.has(turnId) || this.curTurnId === turnId) return
    this.curTurnId = turnId
    this.completedAgentTurnToken = undefined
    this.clearFinalAnswerCompletionFallback(turnToken)
    this.bindPlanCompletionFallback(turnId, turnToken)
  }

  private async reconcilePendingImageGenerations(turnId: string): Promise<void> {
    const transport = this.transport
    const threadId = this.threadId
    if (!transport || !threadId) return
    const connectionGeneration = this.connectionGeneration
    try {
      const items = await readThreadTurnItems<any>(transport, threadId, turnId)
      if (!this.isTransportOwner(connectionGeneration, transport)) return
      for (const item of items) {
        if (item?.type !== 'imageGeneration' || !this.pendingImageGenerations.has(item.id)) continue
        this.onItemCompleted(item)
      }
      if (this.pendingImageGenerations.size > 0) {
        this.emitDiagnostic('generated_image_reconciliation_incomplete', {
          turnId,
          pendingItemIds: [...this.pendingImageGenerations]
        })
      }
    } catch (error) {
      if (!this.isTransportOwner(connectionGeneration, transport)) return
      this.emitDiagnostic('generated_image_reconciliation_failed', {
        turnId,
        message: extractMsg(error)
      })
    }
  }

  private emitTurnUsage(durationMs?: number): void {
    const codex = this.agent.adapter === 'codex'
    const pricing = this.turnPricing
    const usage = normalizeTurnUsage(this.lastTokenUsage, this.turnStartTotal, pricing?.modelId ?? this.config.model,
      { fastMode: codex && !!pricing?.fastMode, exactModel: codex })
    if (usage && codex) {
      const end = totalBreakdown(this.lastTokenUsage)
      const start = this.turnStartTotal || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
      const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const
      if (!pricing || pricing.unknownTier || !this.turnCostStartKnown ||
          this.tokenUsageSerial === this.turnStartUsageSerial || !hasCompleteTokenBreakdown(this.lastTokenUsage) ||
          !end || keys.some(key => end[key] < start[key])) usage.cost = null
      if (keys.some(key => start[key] !== this.pricedSessionTotal[key])) {
        this.sessionEstimatedCost = null
      }
      this.sessionEstimatedCost = this.sessionEstimatedCost == null || usage.cost == null
        ? null : this.sessionEstimatedCost + usage.cost
      usage.sessionCost = this.sessionEstimatedCost
      this.pricedSessionTotal = end || this.pricedSessionTotal
      this.needsInitialUsageBaseline = false
    }
    if (usage) this.emitEvent({
      type: 'system_notice',
      payload: {
        kind: 'usage',
        usage,
        durationMs
      }
    })
    // Keep `lastTokenUsage` across turns: it is the thread's *cumulative* total,
    // and the next turn snapshots it at turn/start as its baseline so that turn's
    // consumption = end − start. Clearing it here would reset every turn's
    // baseline to zero, making 本轮 always equal 会话累计 (the reported bug).
    // Only the per-turn start snapshot is cleared; it is re-taken next startTurn.
    this.turnStartTotal = undefined
    this.turnPricing = undefined
  }

  private armGoalCompletionFallback(resetTimer = false): void {
    const fallback = this.goalCompletionFallback
    if (!fallback) return
    const turnToken = this.activeTurnToken || this.startingTurnToken
    if (
      this.agent.adapter !== 'traex' ||
      fallback.turnToken !== turnToken ||
      this.completedAgentTurnToken !== turnToken ||
      this.tokenUsageSerial <= this.turnStartUsageSerial ||
      this.interrupting
    ) return
    if (resetTimer && fallback.timer) {
      clearTimeout(fallback.timer)
      fallback.timer = undefined
    }
    if (fallback.timer) return
    fallback.timer = setTimeout(() => {
      fallback.timer = undefined
      const activeToken = this.activeTurnToken || this.startingTurnToken
      if (
        this.goalCompletionFallback !== fallback ||
        fallback.turnToken !== activeToken ||
        this.completedAgentTurnToken !== activeToken ||
        this.tokenUsageSerial <= this.turnStartUsageSerial ||
        this.interrupting
      ) return
      const turnId = this.curTurnId
      this.emitTurnUsage(fallback.durationMs)
      if (turnId) this.finishTurn(false, turnId, fallback.turnToken)
      else this.finishTurn(false, undefined, fallback.turnToken)
    }, AppServerRunner.GOAL_COMPLETION_FALLBACK_MS)
  }

  private clearGoalCompletionFallback(expectedToken?: string): void {
    const fallback = this.goalCompletionFallback
    if (!fallback || (expectedToken && fallback.turnToken !== expectedToken)) return
    if (fallback.timer) clearTimeout(fallback.timer)
    this.goalCompletionFallback = undefined
  }

  private scheduleFinalAnswerCompletionFallback(p: any): void {
    if (
      this.agent.adapter !== 'traex' ||
      p?.item?.type !== 'agentMessage' ||
      p.item.phase !== 'final_answer' ||
      // TraeX async questions also use final_answer while the same turn continues.
      p.item.delivery === 'async' ||
      (typeof p?.threadId === 'string' && p.threadId !== this.threadId)
    ) return
    const turnToken = this.activeTurnToken || this.startingTurnToken
    if (!turnToken) return
    const turnId =
      (typeof p?.turnId === 'string' && p.turnId) ||
      (typeof p?.item?.turnId === 'string' && p.item.turnId) ||
      undefined
    if (!turnId || (this.curTurnId && turnId !== this.curTurnId)) return
    this.clearFinalAnswerCompletionFallback()
    this.finalAnswerCompletionFallback = {
      turnToken,
      connectionGeneration: this.connectionGeneration,
      turnId
    }
    this.emitDiagnostic('completion_fallback_armed', {
      reason: 'traex_final_answer',
      turnId,
      turnToken
    })
    this.armFinalAnswerCompletionFallback()
  }

  private armFinalAnswerCompletionFallback(): void {
    const fallback = this.finalAnswerCompletionFallback
    const activeToken = this.activeTurnToken || this.startingTurnToken
    const turnId = this.curTurnId
    if (
      !fallback ||
      fallback.timer ||
      !turnId ||
      this.agent.adapter !== 'traex' ||
      fallback.connectionGeneration !== this.connectionGeneration ||
      fallback.turnToken !== activeToken ||
      this.completedAgentTurnToken !== activeToken ||
      fallback.turnId !== turnId ||
      this.interrupting
    ) return
    fallback.timer = setTimeout(() => {
      fallback.timer = undefined
      const currentToken = this.activeTurnToken || this.startingTurnToken
      if (
        this.finalAnswerCompletionFallback !== fallback ||
        fallback.connectionGeneration !== this.connectionGeneration ||
        fallback.turnToken !== currentToken ||
        this.completedAgentTurnToken !== currentToken ||
        this.curTurnId !== turnId ||
        this.interrupting
      ) return
      this.emitDiagnostic('completion_fallback_fired', {
        reason: 'traex_final_answer',
        turnId,
        turnToken: fallback.turnToken
      })
      this.onTurnCompleted({ id: turnId, status: 'completed' })
    }, AppServerRunner.FINAL_ANSWER_COMPLETION_FALLBACK_MS)
  }

  private clearFinalAnswerCompletionFallback(expectedToken?: string): void {
    const fallback = this.finalAnswerCompletionFallback
    if (!fallback || (expectedToken && fallback.turnToken !== expectedToken)) return
    if (fallback.timer) clearTimeout(fallback.timer)
    this.finalAnswerCompletionFallback = undefined
  }

  private bindPlanCompletionFallback(turnId: string, turnToken: string): void {
    const fallback = this.planCompletionFallback
    if (!fallback || fallback.turnToken !== turnToken) return
    if (fallback.turnId && fallback.turnId !== turnId) fallback.planCompleted = false
    fallback.turnId = turnId
    this.armPlanCompletionFallback()
  }

  private schedulePlanCompletionFallback(p: any): void {
    const fallback = this.planCompletionFallback
    if (!fallback) return
    if (typeof p?.threadId === 'string' && p.threadId !== this.threadId) return
    const turnId =
      (typeof p?.turnId === 'string' && p.turnId) ||
      (typeof p?.item?.turnId === 'string' && p.item.turnId) ||
      fallback.turnId
    if (!turnId || (fallback.turnId && fallback.turnId !== turnId)) return
    fallback.turnId = turnId
    fallback.planCompleted = true
    this.armPlanCompletionFallback()
  }

  private armPlanCompletionFallback(): void {
    const fallback = this.planCompletionFallback
    if (!fallback) return
    const turnId = fallback.turnId
    if (!fallback.planCompleted || !turnId || fallback.timer || this.curTurnId !== turnId) return
    fallback.timer = setTimeout(() => {
      fallback.timer = undefined
      if (
        this.planCompletionFallback !== fallback ||
        this.agent.adapter !== 'traex' ||
        this.config.collaborationMode !== 'plan' ||
        this.connectionGeneration !== fallback.connectionGeneration ||
        this.activeTurnToken !== fallback.turnToken ||
        this.curTurnId !== turnId ||
        this.interrupting
      ) return
      this.onTurnCompleted({ id: turnId, status: 'completed' })
    }, AppServerRunner.PLAN_COMPLETION_FALLBACK_MS)
  }

  private clearPlanCompletionFallback(expectedToken?: string): void {
    const fallback = this.planCompletionFallback
    if (!fallback || (expectedToken && fallback.turnToken !== expectedToken)) return
    if (fallback.timer) clearTimeout(fallback.timer)
    this.planCompletionFallback = undefined
  }

  private awaitReviewStartup<T>(turnToken: string, operation: Promise<T>): Promise<T> {
    const cancellation = this.reviewCancellation
    if (!cancellation || cancellation.token !== turnToken) {
      return Promise.reject(new ReviewStartCancelledError('review/start 已中断'))
    }
    return Promise.race([operation, cancellation.cancellation])
  }

  private matchesReviewNotification(params: any, turnId: string): boolean {
    const notificationThreadId = typeof params?.threadId === 'string' ? params.threadId : undefined
    if (notificationThreadId && notificationThreadId !== this.threadId) return false
    const notificationTurnId = this.reviewNotificationTurnId(params)
    return !notificationTurnId || notificationTurnId === turnId
  }

  private reviewNotificationTurnId(params: any): string | undefined {
    return (
      (typeof params?.turnId === 'string' && params.turnId) ||
      (typeof params?.turn?.id === 'string' && params.turn.id) ||
      (typeof params?.item?.turnId === 'string' && params.item.turnId) ||
      undefined
    )
  }

  private cancelStartingReview(error: ReviewStartCancelledError, retireTransport = true): boolean {
    const cancellation = this.reviewCancellation
    const turnToken = this.startingReviewToken
    if (!cancellation || !turnToken || cancellation.token !== turnToken) return false
    if (this.reviewStartup?.token === turnToken) {
      this.replayAbortedReviewQueueWait(this.reviewStartup, turnToken)
      this.reviewStartup.notifications.length = 0
    }
    cancellation.rejectCancellation(error)
    this.reviewCancellation = undefined
    this.reviewStartup = undefined
    if (retireTransport && this.transport) this.invalidateReadyConnection()
    this.emitEvent({
      type: 'system_notice',
      payload: { kind: 'interrupted', text: '本轮已中断。' }
    })
    this.finishTurn(true, undefined, turnToken)
    return true
  }

  private abortStartingReview(turnToken: string, endReason: QueueStatus['endReason'] = 'unknown'): void {
    if (this.startingReviewToken !== turnToken && this.startingTurnToken !== turnToken) return
    if (this.reviewStartup?.token === turnToken) {
      this.replayAbortedReviewQueueWait(this.reviewStartup, turnToken)
    }
    this.completeQueueWait(turnToken, undefined, Date.now(), false, endReason)
    if (this.startingTurnToken === turnToken) this.startingTurnToken = undefined
    if (this.startingReviewToken === turnToken) this.startingReviewToken = undefined
    if (this.reviewCancellation?.token === turnToken) this.reviewCancellation = undefined
    if (this.reviewStartup?.token === turnToken) {
      this.reviewStartup.notifications.length = 0
      this.reviewStartup = undefined
    }
    this.turnStartTotal = undefined
    this.turnPricing = undefined
    this.queueWait = undefined
    this.deferredTurnCompletions.clear()
    this.compactionActivity.turnFinished(turnToken)
  }

  /** Preserve only unscoped queue lifecycle when review/start never returns a turn id. */
  private replayAbortedReviewQueueWait(startup: ReviewStartupState, turnToken: string): void {
    for (const notification of startup.notifications) {
      // Without the response's authoritative review turn id, an explicitly
      // scoped notification could belong to the previous settled turn.
      if (this.reviewNotificationTurnId(notification.params)) continue
      if (
        notification.method === 'queue/status' ||
        notification.method === 'turn/queue/status' ||
        notification.method === 'thread/queue/updated'
      ) {
        this.onQueueStatus(notification.params, notification.receivedAt)
      } else if (isQueueWaitProgress(notification.method, notification.params)) {
        this.completeQueueWait(turnToken, undefined, notification.receivedAt, true)
      }
    }
  }

  private finishTurn(
    interrupted = false,
    expectedTurnId?: string,
    expectedToken?: string,
    failed = false,
    recoveringContext = false
  ): void {
    if (expectedTurnId && this.curTurnId !== expectedTurnId) return
    const token = this.activeTurnToken || this.startingTurnToken
    if (!token || (expectedToken && token !== expectedToken)) return
    this.emitDiagnostic('runner_finishing', {
      token,
      expectedToken,
      expectedTurnId,
      currentTurnId: this.curTurnId,
      nativeSessionId: this.threadId,
      interrupted,
      failed
    })
    this.clearFinalAnswerCompletionFallback(token)
    this.clearPlanCompletionFallback(token)
    // 需求3（回退关联）— capture the native turn id BEFORE it is cleared below so
    // turn_completed can carry the same `turnId` the matching turn_started did.
    const completedTurnId = expectedTurnId ?? this.curTurnId
    if (completedTurnId) this.failUnfinishedCompactions(completedTurnId, interrupted ? '回合已中断' : '回合已结束，压缩未完成')
    if (completedTurnId) this.completedTurnIds.add(completedTurnId)
    // Teardown alone does not prove that compute was acquired. Explicit ready,
    // real progress, and a matched successful completion close successful waits.
    this.completeQueueWait(token, completedTurnId, Date.now(), false,
      interrupted ? 'cancelled' : failed ? 'failed' : 'unknown')
    this.flush()
    if (this.activeTurnToken === token) {
      this.activeTurnToken = undefined
      this.curTurnId = undefined
    }
    if (this.activeGoalTurnToken === token) this.activeGoalTurnToken = undefined
    if (this.startingTurnToken === token) this.startingTurnToken = undefined
    if (this.startingReviewToken === token) this.startingReviewToken = undefined
    if (this.reviewCancellation?.token === token) this.reviewCancellation = undefined
    if (this.reviewStartup?.token === token) {
      this.reviewStartup.notifications.length = 0
      this.reviewStartup = undefined
    }
    this.deferredTurnCompletions.clear()
    this.interrupting = false
    this.clearGoalCompletionFallback(token)
    if (this.completedAgentTurnToken === token) this.completedAgentTurnToken = undefined
    this.turnStartTotal = undefined
    this.turnPricing = undefined
    this.activeTurnPrompt = undefined
    this.completedTurnSnapshotEvents = []
    this.compactionActivity.turnFinished(token)
    // A completed parent turn does not establish the outcome of its children.
    // Wait for each child's own terminal notification; only an interrupted
    // parent turn is known to cancel its outstanding children.
    if (interrupted) {
      for (const threadId of this.childThreads) this.markChildStatus(threadId, 'interrupted')
    }
    if (recoveringContext) return
    this.emitEvent({
      type: 'turn_completed',
      state: failed ? 'failed' : interrupted ? 'cancelled' : 'success',
      payload: completedTurnId ? { turnId: completedTurnId } : {}
    })
    if (completedTurnId) this.reportedTerminalErrorTurns.delete(completedTurnId)
    this.queueWait = undefined
    this.emit('done', {
      nativeSessionId: this.threadId,
      interrupted,
      ...(failed ? { failed: true } : {})
    })
  }

  private failUnfinishedCompactions(turnId: string, error: string): void {
    for (const [id, active] of this.runningCompactions) {
      if (active.turnId === turnId) this.emitContextCompaction(this.compactionLifecycle.failInvocation(id, error))
    }
  }

  /**
   * 需求(实时上下文): emit a lightweight `context` notice from each tokenUsage
   * tick so the composer's context meter tracks occupancy live. Occupancy is the
   * LAST call's input (how full the window is right now — bounded), matching the
   * final turn card's `contextTokens`; the timeline never renders these (they are
   * filtered out by `kind:'context'`).
   */
  private emitLiveContext(tokenUsage: any): void {
    if (!tokenUsage) return
    const last = tokenUsage.last || {}
    const total = tokenUsage.total || {}
    // Occupancy is normally the LAST call's input (how full the window is now).
    // 需求2 — after a compaction the app-server emits a synthetic tick whose
    // `last.inputTokens` is 0 while `last.totalTokens` carries the NEW (compacted)
    // context size — no real model call happened, so only totalTokens is
    // meaningful. Prefer a positive input figure; otherwise fall back to the
    // positive totalTokens so the meter drops to the post-compaction size instead
    // of reading a misleading 0 (which the renderer would ignore, leaving the bar
    // stuck at the pre-compaction value).
    const posInput =
      (last.inputTokens != null && last.inputTokens > 0 ? last.inputTokens : undefined) ??
      (last.input_tokens != null && last.input_tokens > 0 ? last.input_tokens : undefined)
    const posTotal =
      last.totalTokens != null && last.totalTokens > 0 ? last.totalTokens : undefined
    const contextTokens =
      posInput ??
      posTotal ??
      contextTokenCount(tokenUsage) ??
      last.inputTokens ??
      last.input_tokens ??
      total.inputTokens ??
      total.input_tokens
    if (contextTokens == null) return
    this.emitEvent({
      type: 'system_notice',
      payload: {
        kind: 'context',
        usage: {
          contextTokens,
          contextWindow: tokenUsage.modelContextWindow ?? undefined
        }
      }
    })
  }

  /**
   * Doc1 — normalize a TraeX `queue/status` notification into a `queue_status`
   * UAEvent. The CLI's field names vary across builds, so we accept a few
   * spellings for state/position/message and default the state to 'queued'.
   * `ready` (or an empty/finished state) clears the banner via state:'success'.
   */
  private onQueueStatus(p: any, receivedAt = Date.now()): void {
    if (!p) return
    const turnToken = this.activeTurnToken || this.startingTurnToken
    const notificationTurnId = typeof p.turnId === 'string' ? p.turnId : undefined
    if (
      notificationTurnId &&
      this.activeGoalTurnToken === turnToken &&
      this.agent.adapter === 'traex' &&
      this.goalState?.status === 'active'
    ) this.adoptProviderTurn(notificationTurnId)
    if (
      !turnToken ||
      (notificationTurnId && this.completedTurnIds.has(notificationTurnId)) ||
      (this.curTurnId && notificationTurnId && notificationTurnId !== this.curTurnId)
    ) return
    const rawState = String(p.state ?? p.status ?? p.phase ?? 'queued').toLowerCase()
    const state: 'queued' | 'waiting' | 'ready' =
      rawState === 'ready' || rawState === 'running' || rawState === 'started'
        ? 'ready'
        : rawState === 'waiting'
          ? 'waiting'
          : 'queued'
    const pos = p.position ?? p.queuePosition ?? p.queue_position ?? p.index
    let wait = this.queueWait
    if (wait && wait.turnToken !== turnToken) {
      this.queueWait = undefined
      wait = undefined
    }
    if (turnToken && state !== 'ready') {
      if (!wait) {
        wait = {
          turnToken,
          id: `queue-${turnToken}-${randomUUID()}`,
          activeStartedAt: receivedAt,
          waitedMs: 0
        }
        this.queueWait = wait
      } else if (wait.activeStartedAt === undefined) {
        wait.activeStartedAt = receivedAt
      }
    } else if (turnToken && state === 'ready' && wait?.activeStartedAt !== undefined) {
      wait.waitedMs += Math.max(0, receivedAt - wait.activeStartedAt)
      wait.activeStartedAt = undefined
    }
    const status: QueueStatus = {
      state,
      threadId: this.threadId,
      turnId: this.curTurnId,
      position: typeof pos === 'number' ? pos : null,
      message: typeof p.message === 'string' ? p.message : p.hint || null,
      ...(wait?.activeStartedAt === undefined ? {} : { startedAt: wait.activeStartedAt }),
      ...(wait ? { waitedMs: wait.waitedMs } : {}),
      ...(state === 'ready' ? { acquired: true } : {})
    }
    this.emitEvent({
      type: 'queue_status',
      ts: receivedAt,
      state: state === 'ready' ? 'success' : 'running',
      payload: { id: wait?.id || `queue-${this.curTurnId || this.threadId || 't'}`, queue: status }
    })
  }

  private completeQueueWait(
    turnToken: string,
    turnId?: string,
    completedAt = Date.now(),
    acquired = false,
    endReason: QueueStatus['endReason'] = 'unknown'
  ): void {
    const wait = this.queueWait
    if (!wait || wait.turnToken !== turnToken || wait.activeStartedAt === undefined) return
    wait.waitedMs += Math.max(0, completedAt - wait.activeStartedAt)
    wait.activeStartedAt = undefined
    const status: QueueStatus = {
      state: 'ready',
      threadId: this.threadId,
      turnId,
      position: null,
      message: null,
      waitedMs: wait.waitedMs,
      acquired,
      ...(acquired ? {} : { endReason })
    }
    this.emitEvent({
      type: 'queue_status',
      ts: completedAt,
      state: 'success',
      payload: { id: wait.id, queue: status }
    })
  }

  /** Forget a pending server request (resolved by the server or answered). */
  private resolvePending(requestId: string): void {
    if (this.pendingRequests.delete(requestId)) {
      this.emitEvent({
        type: 'approval_request',
        state: 'cancelled',
        payload: { requestId, resolved: true }
      })
    }
  }

  /** Resolve the current generation's provider id without touching a reused id. */
  private resolvePendingByRpcId(
    connectionGeneration: number,
    rpcId: number | string,
    method?: string,
    state: 'success' | 'cancelled' = 'cancelled'
  ): void {
    for (const [requestId, entry] of this.pendingRequests) {
      if (
        entry.connectionGeneration === connectionGeneration &&
        String(entry.rpcId) === String(rpcId) &&
        (!method || entry.method === method)
      ) {
        if (state === 'success') {
          this.pendingRequests.delete(requestId)
          this.emitEvent({
            type: 'approval_request',
            state,
            payload: { requestId, resolved: true }
          })
        } else {
          this.resolvePending(requestId)
        }
        return
      }
    }
  }

  /** Close every outstanding request owned by one retired connection exactly once. */
  private retirePendingRequests(connectionGeneration: number): void {
    for (const [requestId, entry] of [...this.pendingRequests]) {
      if (entry.connectionGeneration === connectionGeneration) this.resolvePending(requestId)
    }
  }

  private hasPendingServerRequests(): boolean {
    const transport = this.transport
    if (!transport || !this.isTransportOwner(this.connectionGeneration, transport)) return false
    for (const entry of this.pendingRequests.values()) {
      if (
        entry.connectionGeneration === this.connectionGeneration &&
        entry.transport === transport
      ) return true
    }
    return false
  }

  /**
   * Doc4 — normalize a `turn/plan/updated` notification into a `plan_update`
   * UAEvent. The CLI pushes the full plan array each update; we map its steps to
   * the归一 {text,status} shape and key the event by `plan-<turnId>` so repeated
   * updates replace in place. Status is already pending/in_progress/completed.
   */
  private onPlanUpdated(p: any): void {
    const raw: any[] = p?.plan ?? p?.steps ?? []
    const steps = (Array.isArray(raw) ? raw : []).map((s: any) => ({
      text: typeof s === 'string' ? s : s?.step ?? s?.text ?? s?.content ?? '',
      status: normalizePlanStatus(s?.status)
    }))
    if (!steps.some(({ text }) => String(text).trim())) {
      this.emitIgnoredNotification('turn/plan/updated', 'missing_plan_steps', p)
      return
    }
    this.emitEvent({
      type: 'plan_update',
      state: 'running',
      payload: {
        id: `plan-${this.curTurnId || this.threadId || 't'}`,
        steps,
        explanation: typeof p?.explanation === 'string' ? p.explanation : undefined
      }
    })
  }

  /**
   * Doc5 — normalize a `collabAgentToolCall` / `subAgentActivity` ThreadItem into a
   * `subagent` UAEvent. A collabAgentToolCall carries `agentsStates` (a map of
   * child threadId → {status,message}); we emit one snapshot per child so the
   * orchestrator can upsert its session.subagents by agentThreadId. A
   * subAgentActivity is a single child's lifecycle tick.
   */
  private onSubAgentItem(item: any, phase: 'started' | 'completed'): void {
    if (!item) return
    const agents: any[] = []
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates || {}
      const receivers: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      const ids = new Set<string>([...Object.keys(states), ...receivers])
      if (!ids.size && item.tool !== 'wait') {
        this.emitIgnoredItem(item, phase, 'missing_subagent_state')
        return
      }
      // The dispatched task + spawn model belong to the receiving child(ren).
      const prompt = readableSubAgentInput(item.prompt)
      const model = typeof item.model === 'string' && item.model.trim() ? item.model : undefined
      const dispatchRecipients = new Set(receivers.length ? receivers : Object.keys(states))
      const observedAt = Date.now()
      for (const threadId of ids) {
        const st = states[threadId] || {}
        const receiver = Array.isArray(item.receiverAgents)
          ? item.receiverAgents.find((agent: any) => agent?.threadId === threadId)
          : undefined
        const name = nativeSubAgentName(receiver) || this.childName(threadId) || nativeSubAgentName(st)
        const activeDispatch = this.subAgentDispatches.current(threadId)
        const dispatchTool = isSubAgentDispatchTool(item.tool) && typeof item.id === 'string'
        const knownDispatch = dispatchTool
          ? this.subAgentDispatches.forDispatch(threadId, item.id)
          : undefined
        const appendIsTerminal = item.tool === 'sendInput' &&
          isSubAgentTerminal(normalizeCollabStatus(st.status))
        const startsDispatch = dispatchTool && !knownDispatch && dispatchRecipients.has(threadId) &&
          (item.tool !== 'sendInput' || !activeDispatch || (phase === 'started' &&
            (this.terminalSubAgentThreads.has(threadId) || appendIsTerminal)))
        const dispatchesThread = dispatchRecipients.has(threadId) && (!!knownDispatch || startsDispatch)
        const previousDispatch = startsDispatch ? activeDispatch : undefined
        // 子agent隔离 — register the child so its stream notifications are kept out
        // of the main chat, and cache its dispatch task / model / name for the
        // sidebar. A running sendInput is only an appended question; it retains
        // the active generation's initial prompt/model.
        this.childThreads.add(threadId)
        const dispatch = knownDispatch || (startsDispatch
          ? this.subAgentDispatches.activate(threadId, item.id, observedAt)
          : activeDispatch)
        // A delayed started/completed snapshot for dispatch A may arrive after B
        // is active. Validate the stamp before touching generation-owned caches.
        const currentDispatch = !dispatchesThread || this.subAgentDispatches.isCurrent(threadId, dispatch)
        if (dispatchesThread && !currentDispatch) continue
        const startsNewGeneration = startsDispatch &&
          !!dispatch && dispatch !== previousDispatch
        if (startsNewGeneration && previousDispatch) {
          this.markChildStatus(threadId, 'completed', previousDispatch, observedAt)
        }
        if (startsNewGeneration) {
          this.terminalSubAgentThreads.delete(threadId)
          this.latestSubAgentInteraction.delete(threadId)
        }
        const appendedInput = item.tool === 'sendInput' && !dispatchesThread && typeof item.id === 'string'
        if (appendedInput && phase === 'started') this.latestSubAgentInteraction.set(threadId, item.id)
        if (name) this.childNameMap.set(threadId, name)
        if (startsNewGeneration) {
          if (model) this.childModel.set(threadId, model)
          if (prompt) this.childPrompt.set(threadId, prompt)
          else this.childPrompt.delete(threadId)
        }
        const status = dispatchesThread && phase === 'started'
          ? 'running'
          : normalizeCollabStatus(st.status)
        if (
          isSubAgentTerminal(status) &&
          this.latestSubAgentInteraction.has(threadId) &&
          this.latestSubAgentInteraction.get(threadId) !== item.id
        ) continue
        if (!this.claimSubAgentTerminal(threadId, dispatch?.generation, status)) continue
        agents.push({
          agentThreadId: threadId,
          parentThreadId: item.senderThreadId || this.threadId,
          status,
          tool: item.tool,
          message: typeof st.message === 'string' ? st.message : undefined,
          name,
          prompt: this.childPrompt.get(threadId) || (dispatchesThread ? prompt : undefined),
          ...(isSubAgentTerminal(status) ? { endedAt: observedAt } : {}),
          ...dispatch
        })
      }
    } else {
      // subAgentActivity: a single child's lifecycle event.
      const threadId = item.agentThreadId || item.id
      const name = this.childName(threadId) || nativeSubAgentName(item)
      this.childThreads.add(threadId)
      if (name) this.childNameMap.set(threadId, name)
      const activityId = typeof item.id === 'string' ? item.id : undefined
      const observedAt = historicalTimestamp(
        item.occurredAt ?? item.occurred_at_ms ?? item.timestamp
      ) ?? Date.now()
      const dispatch = activityId
        ? this.subAgentDispatches.observeActivity(threadId, activityId, observedAt)
        : this.subAgentDispatches.current(threadId)
      if (activityId && !dispatch && this.subAgentDispatches.current(threadId)) return
      if (activityId && dispatch && !this.subAgentDispatches.isCurrent(threadId, dispatch)) return
      const status = normalizeCollabStatus(item.kind)
      if (!this.claimSubAgentTerminal(threadId, dispatch?.generation, status)) return
      agents.push({
        agentThreadId: threadId,
        parentThreadId: this.threadId,
        status,
        tool: item.kind,
        name,
        prompt: this.childPrompt.get(threadId),
        ...(isSubAgentTerminal(status) ? { endedAt: observedAt } : {}),
        ...dispatch
      })
    }
    // Valid recipients can all be filtered as stale or already terminal.
    if (!agents.length) return
    this.emitEvent({
      type: 'subagent',
      state: 'running',
      // Keep the explicit dispatch start separate from its completion snapshot.
      // The renderer needs both records to show a new 开始工作 phase even when
      // a very fast child is already terminal by item/completed.
      payload: {
        id: isSubAgentDispatchTool(item.tool) ? `${item.id}:${phase}` : item.id,
        agents
      }
    })
  }

  private onTaskNotification(
    item: any,
    phase: 'started' | 'completed',
    turnId?: string
  ): void {
    const parsed = parseTaskNotification(item, phase)
    if (!parsed) {
      this.emitIgnoredItem(item, phase, 'malformed_task_notification')
      return
    }
    this.emitEvent({
      type: 'background_task',
      state: parsed.state,
      payload: { id: item.id, ...(turnId ? { turnId } : {}), ...parsed.payload }
    })
  }

  /**
   * Doc5 — fetch a sub-agent thread's items for the detail panel (lazy-loaded).
   * Wraps `thread/items/list`; returns [] on any failure so the panel degrades.
   */
  async listThreadItems(threadId: string, limit = 100): Promise<any[]> {
    try {
      await this.ensureReady()
      const res = await this.rpc('thread/items/list', { threadId, limit, sortDirection: 'asc' })
      return res?.items ?? res?.data ?? []
    } catch {
      return []
    }
  }

  // ---- delta throttling ----

  private markDirty(itemId: string): void {
    this.dirty.add(itemId)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), AppServerRunner.FLUSH_MS)
    }
  }

  private flush(): void {
    this.clearFlush()
    for (const itemId of this.dirty) {
      const type = this.itemType.get(itemId)
      const text = this.textBuf.get(itemId) || ''
      if (type === 'agent' || type === 'plan') {
        this.emitEvent({
          type: 'agent_message',
          state: 'running',
          payload: {
            id: itemId,
            text,
            ...(this.itemTurn.get(itemId) ? { turnId: this.itemTurn.get(itemId) } : {}),
            ...(type === 'plan' ? { kind: 'plan' } : {})
          }
        })
      } else if (type === 'reasoning') {
        this.emitEvent({ type: 'reasoning', state: 'running', payload: { id: itemId, text } })
      } else if (type === 'command') {
        this.emitEvent({
          type: 'command_exec',
          state: 'running',
          payload: { id: itemId, command: this.cmdMeta.get(itemId)?.command, output: text }
        })
      }
    }
    this.dirty.clear()
  }

  private clearFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private emitEvent(e: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'> & { ts?: number }): void {
    const ev: UAEvent = {
      sessionId: this.sessionId,
      seq: this.seqRef.n++,
      ts: Date.now(),
      ...e
    }
    this.emit('event', ev)
  }

  private emitDiagnostic(kind: string, data: unknown): void {
    this.emit('diagnostic', { kind, data })
  }
}

function nativeMcpToolPayload(item: any): Record<string, unknown> {
  return {
    id: item.id,
    provider: 'mcp',
    server: item.server,
    name: item.tool,
    input: item.arguments,
    result: item.result ?? null,
    error: item.error ?? null,
    durationMs: item.durationMs ?? null
  }
}

function parseTaskNotification(
  item: any,
  phase: 'started' | 'completed'
): { state: UAEvent['state']; payload: Record<string, string> } | null {
  const text = Array.isArray(item?.content)
    ? item.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n')
    : ''
  const value = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
    return match?.[1]?.trim() || undefined
  }
  const taskId = value('task-id')
  const status = value('status')
  if (!taskId || !status) return null
  const state: UAEvent['state'] = /fail|error/i.test(status)
    ? 'failed'
    : /cancel|interrupt/i.test(status)
      ? 'cancelled'
      : /complete|success/i.test(status)
        ? 'success'
        : phase === 'started'
          ? 'running'
          : 'success'
  return {
    state,
    payload: {
      taskId,
      status,
      ...(value('summary') ? { summary: value('summary')! } : {}),
      ...(value('output-file') ? { outputFile: value('output-file')! } : {})
    }
  }
}

function nativeBuiltinToolPayload(item: any): Record<string, unknown> {
  if (item.type === 'webSearch') {
    return {
      id: item.id,
      name: 'web_search',
      input: {
        query: item.query,
        ...(item.action != null ? { action: item.action } : {})
      },
      ...(item.results != null ? { result: item.results } : {})
    }
  }
  if (item.type === 'imageView') {
    return { id: item.id, name: 'view_image', input: { path: item.path } }
  }
  return { id: item.id, name: 'sleep', input: { durationMs: item.durationMs } }
}

function imageGenerationPayload(item: any): Record<string, unknown> {
  const status = typeof item?.status === 'string' ? item.status : 'in_progress'
  const state = imageGenerationState(status)
  return {
    id: item.id,
    name: 'image_generation',
    ...(typeof item.revisedPrompt === 'string' && item.revisedPrompt.trim()
      ? { input: item.revisedPrompt.trim() }
      : {}),
    ...(state === 'running'
      ? {}
      : {
          result: {
            status,
            ...(typeof item.savedPath === 'string' && item.savedPath
              ? { savedPath: item.savedPath }
              : {}),
            ...(typeof item.transparentBackground === 'boolean'
              ? { transparentBackground: item.transparentBackground }
              : {}),
            ...(item.failure != null ? { failure: item.failure } : {})
          }
        })
  }
}

function transcriptItems(
  events: Pick<UAEvent, 'type' | 'payload'>[],
  includeHidden = false
): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (!includeHidden && event.payload?.hidden === true) return []
    const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
    if (!text) return []
    if (event.type === 'user_message' || event.type === 'goal_message') {
      return [messageItem('user', text)]
    }
    if (event.type === 'agent_message') {
      return [messageItem('assistant', text)]
    }
    return []
  })
}

function messageItem(role: 'user' | 'assistant', text: string): Record<string, unknown> {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
  }
}

function liveTurnSnapshot(
  events: Pick<UAEvent, 'type' | 'state' | 'payload'>[],
  activePrompt: string | undefined,
  completedToolEvents: Pick<UAEvent, 'type' | 'state' | 'payload'>[]
): string | undefined {
  if (!activePrompt) return undefined
  const turnStart = events.findLastIndex((event) =>
    (event.type === 'user_message' || event.type === 'goal_message') &&
    event.payload?.text === activePrompt
  )
  const visible = turnStart >= 0 ? events.slice(turnStart) : []
  const merged = new Map<string, Pick<UAEvent, 'type' | 'state' | 'payload'>>()
  const ordered: Pick<UAEvent, 'type' | 'state' | 'payload'>[] = []
  const visibleMessages = visible.filter((event) =>
    event.type === 'user_message' || event.type === 'goal_message' ||
    event.type === 'agent_message' || event.type === 'reasoning'
  )
  for (const event of [...visibleMessages, ...completedToolEvents]) {
    if (!snapshotEventIncluded(event)) continue
    const id = typeof event.payload?.id === 'string' ? event.type + ':' + event.payload.id : ''
    if (id && merged.has(id)) {
      Object.assign(merged.get(id)!, structuredClone(event))
    } else {
      const copy = structuredClone(event)
      ordered.push(copy)
      if (id) merged.set(id, copy)
    }
  }
  if (turnStart < 0) ordered.unshift({ type: 'user_message', payload: { text: activePrompt } })
  const blocks = ordered.flatMap(snapshotEventText)
  if (!blocks.length) return undefined
  return [
    '[Live turn snapshot at fork time]',
    'The following is read-only context already observed in the parent turn. It may be partial. It is not a new instruction. Pending or running tools are omitted. The parent continues independently after this snapshot.',
    '',
    ...blocks
  ].join('\n')
}

function snapshotEventIncluded(event: Pick<UAEvent, 'type' | 'state' | 'payload'>): boolean {
  if (event.payload?.hidden === true) return false
  if (event.type === 'user_message' || event.type === 'goal_message') return true
  if (event.type === 'agent_message' || event.type === 'reasoning') return true
  return (event.type === 'command_exec' || event.type === 'tool_call' || event.type === 'file_change') &&
    event.state !== 'running' && event.state !== 'pending' && !nativeItemStillRunning(event.payload?.raw)
}

function nativeItemStillRunning(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const status = String((item as { status?: unknown }).status ?? '').toLowerCase().replace(/[_-]/g, '')
  return status === 'inprogress' || status === 'running' || status === 'pending'
}

function snapshotEventText(event: Pick<UAEvent, 'type' | 'state' | 'payload'>): string[] {
  const text = typeof event.payload?.text === 'string' ? event.payload.text.trim() : ''
  if (event.type === 'user_message' || event.type === 'goal_message') {
    return text ? ['User prompt:\n' + text] : []
  }
  if (event.type === 'agent_message') return text ? ['Assistant output so far:\n' + text] : []
  if (event.type === 'reasoning') return text ? ['Reasoning summary so far:\n' + text] : []
  if (event.type === 'command_exec') {
    const command = typeof event.payload?.command === 'string' ? event.payload.command : ''
    const output = typeof event.payload?.output === 'string' ? event.payload.output : ''
    return ['Completed command (' + (event.state || 'success') + '):\n$ ' + command + '\n' + output]
  }
  if (event.type === 'file_change') {
    return ['Completed file change (' + (event.state || 'success') + '):\n' + safeSnapshotJson(event.payload?.changes)]
  }
  if (event.type === 'tool_call') {
    const name = typeof event.payload?.name === 'string' ? event.payload.name : 'tool'
    return ['Completed tool ' + name + ' (' + (event.state || 'success') + '):\n' + safeSnapshotJson({
      input: event.payload?.input,
      result: event.payload?.result,
      error: event.payload?.error
    })]
  }
  return []
}

function safeSnapshotJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function imageGenerationState(status: unknown): UAEvent['state'] {
  const normalized = String(status ?? '').toLowerCase().replace(/[_-]/g, '')
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'declined') {
    return 'cancelled'
  }
  if (normalized === 'inprogress' || normalized === 'running' || normalized === 'pending') {
    return 'running'
  }
  return 'success'
}

const GOAL_STATUSES = new Set<GoalStatus>([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
])

export function normalizeGoal(raw: any): GoalState {
  const rawStatus = typeof raw?.status === 'string' ? raw.status : 'active'
  const status = GOAL_STATUSES.has(rawStatus as GoalStatus)
    ? rawStatus as GoalStatus
    : 'active'
  return {
    objective: String(raw?.objective || ''),
    status,
    tokenBudget: typeof raw?.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget)
      ? raw.tokenBudget
      : null,
    tokensUsed: finiteGoalNumber(raw?.tokensUsed),
    timeUsedSeconds: finiteGoalNumber(raw?.timeUsedSeconds),
    createdAt: finiteGoalNumber(raw?.createdAt),
    updatedAt: finiteGoalNumber(raw?.updatedAt)
  }
}

function finiteGoalNumber(value: unknown): number {
  const normalized = Number(value || 0)
  return Number.isFinite(normalized) ? normalized : 0
}

/** Build a human-readable reasoning text from an item's summary + content arrays. */
function reasoningText(item: any): string {
  const parts: string[] = []
  const collect = (arr: any[]): void => {
    for (const e of arr || []) {
      if (typeof e === 'string') parts.push(e)
      else if (e?.text) parts.push(e.text)
    }
  }
  collect(item?.summary)
  collect(item?.content)
  return parts.join('\n\n')
}

/** Classify a server→client request method into a UI approval kind (Doc3). */
function approvalKind(method: string, params?: any): string {
  switch (method) {
    case 'item/tool/requestUserInput':
      return 'question'
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return 'command'
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return 'fileChange'
    case 'item/permissions/requestApproval':
      return 'permissions'
    case 'mcpServer/elicitation/request':
      return isMcpToolApproval(params) ? 'mcpTool' : 'elicitation'
    default:
      return 'approval'
  }
}

function modeChangeDecision(answer: any): 'approved' | 'rejected' | 'cancelled' | undefined {
  switch (answer?.decision) {
    case 'approved':
    case 'accept':
    case 'acceptForSession':
    case 'approved_for_session':
      return 'approved'
    case 'rejected':
    case 'decline':
    case 'denied':
      return 'rejected'
    case 'cancelled':
    case 'cancel':
      return 'cancelled'
    default:
      return undefined
  }
}

/** Normalize an app-server file change into the {kind, path} shape the UI renders. */
function normalizeChange(c: any): { kind: string; path: string; diff?: string; movePath?: string } {
  const kind = typeof c?.kind === 'string' ? c.kind : c?.kind?.type || 'update'
  return { kind, path: c?.path, diff: c?.diff,
    ...(c?.kind?.move_path ? { movePath: c.kind.move_path } : {}) }
}

/** Best-effort human message out of an error object/string. */
function extractMsg(err: any): string {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  const raw = err.message || err.error?.message || err.reason || err.summary
  if (raw) return raw
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * 需求3（回退分叉）— did the app-server reject `thread/fork` because it doesn't
 * understand the `beforeTurnId` parameter (older build)? Only then may
 * forkBeforeTurn retry with the documented `lastTurnId`. Genuine failures
 * (thread not found, transport, permission) must NOT be swallowed, so we match
 * conservatively on the unsupported-field / unknown-param / invalid-method
 * error shapes rather than any error.
 */
function isUnsupportedForkParam(err: any): boolean {
  const msg = extractMsg(err).toLowerCase()
  if (!msg) return false
  return (
    (msg.includes('beforeturnid') &&
      (msg.includes('unknown') || msg.includes('unexpected') || msg.includes('unrecognized') ||
        msg.includes('invalid') || msg.includes('not supported') || msg.includes('unsupported'))) ||
    msg.includes('unknown field') ||
    msg.includes('unexpected field') ||
    msg.includes('unknown parameter') ||
    msg.includes('unsupported parameter') ||
    msg.includes('method not found') ||
    msg.includes('-32601') ||
    msg.includes('-32602')
  )
}

/**
 * 修复#5 — the "Ignoring malformed agent role definition: duplicate agent role
 * name …" chatter is pure config-loader de-dup noise. The user asked to never see
 * it, so drop any warning matching that shape before it reaches the timeline.
 */
function isIgnorableWarning(text?: unknown): boolean {
  if (typeof text !== 'string') return false
  return isHiddenAgentWarning(text) ||
    /Ignoring malformed agent role definition|duplicate agent role name/i.test(text)
}

/**
 * Extract the cumulative `total` breakdown from a tokenUsage tick, as a flat
 * {inputTokens, outputTokens, cachedInputTokens}. Used to snapshot turn-start.
 */
function totalBreakdown(
  u: any
): { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined {
  const t = u?.total
  if (!t) return undefined
  return {
    inputTokens: t.inputTokens ?? t.input_tokens ?? 0,
    outputTokens: t.outputTokens ?? t.output_tokens ?? 0,
    cachedInputTokens: t.cachedInputTokens ?? t.cached_input_tokens ?? 0
  }
}

function hasCompleteTokenBreakdown(u: any): boolean {
  const t = u?.total
  const values = [t?.inputTokens ?? t?.input_tokens, t?.outputTokens ?? t?.output_tokens,
    t?.cachedInputTokens ?? t?.cached_input_tokens]
  return values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) && values[2] <= values[0]
}

/** The last call's input and reply occupy the next context; cumulative billing does not. */
function contextTokenCount(usage: any): number | undefined {
  const last = usage?.last
  const tokens = last?.totalTokens ?? last?.total_tokens ?? last?.inputTokens ?? last?.input_tokens
  if (tokens === 0 && Number.isFinite(usage?.modelContextWindow) && usage.modelContextWindow > 0 && usage?.total?.totalTokens === usage.modelContextWindow &&
      usage.total.inputTokens === 0 && usage.total.outputTokens === 0) return usage.modelContextWindow
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
}

/**
 * Normalize Codex/TraeX `thread/tokenUsage/updated` into a per-turn TurnUsage
 * (Doc5 T1). The turn's real consumption is the *increment* of the thread's
 * cumulative `total` (end − start) — each model call in the turn re-counts the
 * growing context under `input`, so the delta of `total` is the correct billing
 * figure, NOT the last single call (`last`). The context-occupancy bar instead
 * uses `last.inputTokens` (how full the window is right now — bounded).
 */
function normalizeTurnUsage(
  u: any,
  start:
    | { inputTokens: number; outputTokens: number; cachedInputTokens: number }
    | undefined,
  modelId?: string,
  pricingOptions?: { fastMode?: boolean; exactModel?: boolean }
): any {
  if (!u) return undefined
  const end = totalBreakdown(u) || {
    inputTokens: u.last?.inputTokens ?? 0,
    outputTokens: u.last?.outputTokens ?? 0,
    cachedInputTokens: u.last?.cachedInputTokens ?? 0
  }
  const s = start || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  // Delta of cumulative total = this turn. Guard against a reset/regression.
  const inputTokens = Math.max(0, end.inputTokens - s.inputTokens)
  const outputTokens = Math.max(0, end.outputTokens - s.outputTokens)
  const cachedInputTokens = Math.max(0, end.cachedInputTokens - s.cachedInputTokens)
  const last = u.last || {}
  const usage: any = {
    // Canonical TurnUsage fields (Doc5 T1).
    inputTokens,
    outputTokens,
    cachedInputTokens,
    contextWindow: u.modelContextWindow ?? undefined,
    modelId,
    // Occupancy bar reads the LAST call's input (bounded), not the turn sum.
    contextTokens: last.inputTokens ?? last.input_tokens ?? end.inputTokens,
    // Whole-session cumulative totals (G2-1): the thread's running `total` at the
    // end of this turn. The per-turn card shows only this turn; expanding reveals
    // both this turn's breakdown AND these session-wide running totals.
    sessionInputTokens: end.inputTokens,
    sessionOutputTokens: end.outputTokens,
    sessionCachedInputTokens: end.cachedInputTokens,
    // Legacy snake_case mirror so any older consumer keeps working.
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cached_input_tokens: cachedInputTokens
  }
  usage.cost = computeCost({ inputTokens, outputTokens, cachedInputTokens }, modelId, undefined, pricingOptions)
  if (!pricingOptions?.exactModel) {
    usage.sessionCost = computeCost(
      {
        inputTokens: end.inputTokens,
        outputTokens: end.outputTokens,
        cachedInputTokens: end.cachedInputTokens
      },
      modelId
    )
  }
  return usage
}

/** Whether an agent should be driven through the streaming app-server path. */
export function usesAppServer(agent: AgentDef): boolean {
  return (
    (agent.adapter === 'codex' || agent.adapter === 'traex') &&
    agent.capabilities.streaming === true
  )
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function userMessageText(item: any): string {
  return (item?.content || [])
    .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry: any) => entry.text)
    .join(' ')
    .trim()
}

function threadTitlePrompt(userMessage: string): string {
  const instructions =
    `Generate a concise, single-line task title of at most ${THREAD_TITLE_MAX_CHARS} characters ` +
    `and under five words where possible. Start with an imperative verb. Capitalize only the first ` +
    `word unless the user's language, proper nouns, acronyms, or code terms require otherwise. ` +
    `Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, ` +
    `or trailing punctuation. Do not answer the request.`
  const prefix = `${instructions}\n\nUser prompt:\n`
  const remainingBytes = Math.max(0, THREAD_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix))
  return prefix + truncateUtf8(userMessage.trim(), remainingBytes)
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  for (const char of value) {
    if (Buffer.byteLength(result + char) > maxBytes) break
    result += char
  }
  return result
}

function parseThreadTitle(response: unknown): string | undefined {
  if (typeof response !== 'string' || !response.trimStart().startsWith('{')) return undefined
  try {
    const title = JSON.parse(response).title
    if (typeof title !== 'string') return undefined
    const normalized = title
      .trim()
      .replace(/^[\"'`“”‘’]+|[\"'`“”‘’]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[.?!]+$/g, '')
      .trim()
    return normalized ? [...normalized].slice(0, THREAD_TITLE_MAX_CHARS).join('') : undefined
  } catch {
    return undefined
  }
}

export function titleGenerationConfig(mcpServers: string[]): Record<string, unknown> {
  return {
    'features.apps': false,
    'features.code_mode': false,
    'features.code_mode_only': false,
    'features.current_time_reminder': false,
    'features.deferred_executor': false,
    'features.enable_fanout': false,
    'features.goals': false,
    'features.hooks': false,
    'features.image_generation': false,
    'features.memories': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.plugins': false,
    'features.request_permissions_tool': false,
    'features.shell_snapshot': false,
    'features.shell_tool': false,
    'features.standalone_web_search': false,
    'features.tool_suggest': false,
    'features.unified_exec': false,
    'features.view_image': false,
    'orchestrator.skills.enabled': false,
    'skills.include_instructions': false,
    // 交接 MCP 由 threadConfigOverrides 按线程注入，config/read 看不到，需显式关闭；
    // 标题线程不需要它，也避免 config.toml 里用户同名服务器被意外启用。
    'mcp_servers.uniagent.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
    web_search: 'disabled',
    ...Object.fromEntries(mcpServers.map((name) => [`mcp_servers.${name}.enabled`, false]))
  }
}

/**
 * Doc4 — normalize a plan step status across the CLI's spellings into the归一
 * pending | in_progress | completed. Unknown → pending.
 */
function normalizePlanStatus(s: any): 'pending' | 'in_progress' | 'completed' {
  const v = String(s ?? '').toLowerCase()
  if (v === 'completed' || v === 'complete' || v === 'done') return 'completed'
  if (v === 'in_progress' || v === 'inprogress' || v === 'active' || v === 'running') return 'in_progress'
  return 'pending'
}

/**
 * 需求2 — extract a post-compaction usage snapshot from a compaction completion
 * (native `contextCompaction` item) or a `thread/compacted` notification, and
 * normalize it into the `{last,total,modelContextWindow}` shape that
 * `emitLiveContext` reads. Compaction completions don't have a fixed field name
 * across builds, so we probe the likely carriers (`tokenUsage`, `usage`,
 * `info`, `tokenCount`). Returns undefined when no real figure is present — the
 * caller then emits nothing rather than fabricate an occupancy drop.
 */
function compactionTokenUsage(src: any): any | undefined {
  if (!src || typeof src !== 'object') return undefined
  const u = src.tokenUsage || src.usage || src.info || src.tokenCount || src.token_count
  if (!u || typeof u !== 'object') return undefined
  // Already in the tick shape (has last/total).
  if (u.last || u.total) return u
  // token_count-style info: { total_token_usage, last_token_usage, ... }.
  const last = u.last_token_usage || u.lastTokenUsage
  const total = u.total_token_usage || u.totalTokenUsage
  if (last || total) {
    return {
      last,
      total,
      modelContextWindow:
        u.model_context_window ?? u.modelContextWindow ?? src.modelContextWindow ?? undefined
    }
  }
  // A flat breakdown ({inputTokens,...}) — treat it as both last and total.
  if (u.inputTokens != null || u.input_tokens != null) {
    return { last: u, total: u, modelContextWindow: src.modelContextWindow ?? undefined }
  }
  return undefined
}

/**
 * 需求2(发现步骤) — dump every compaction-adjacent JSON-RPC frame (item
 * lifecycle, token ticks, compacted notifications) to a file so we can confirm,
 * on the packaged app, which field carries the post-compaction token figure.
 * Gated behind UA_DUMP_COMPACT; never runs in normal operation.
 */
function dumpCompactionTraffic(msg: any): void {
  try {
    const method: string = msg?.method || ''
    const itemType = msg?.params?.item?.type
    const relevant =
      method === 'thread/tokenUsage/updated' ||
      method === 'thread/compacted' ||
      method === 'context/compacted' ||
      method === 'context_compacted' ||
      (itemType === 'contextCompaction' &&
        (method === 'item/started' || method === 'item/completed'))
    if (!relevant) return
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(os.tmpdir(), 'ua-compact-dump.jsonl')
    appendFileSync(file, JSON.stringify({ ts: Date.now(), method, params: msg?.params }) + '\n')
  } catch {
    /* diagnostics only */
  }
}

/**
 * Doc5 — normalize a CollabAgentStatus across spellings. The app-server enum is
 * pendingInit | running | interrupted | completed | errored | shutdown | notFound.
 */
function normalizeCollabStatus(
  s: any
): 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound' {
  const v = String(s ?? '').toLowerCase()
  if (v.includes('complete')) return 'completed'
  if (v.includes('error')) return 'errored'
  if (v.includes('interrupt')) return 'interrupted'
  if (v.includes('shutdown')) return 'shutdown'
  if (v.includes('notfound') || v === 'not_found') return 'notFound'
  if (v.includes('pending') || v.includes('init')) return 'pendingInit'
  return 'running'
}

// Re-export for callers that only need the permission mapping helper here.
export type { PermissionMode }
