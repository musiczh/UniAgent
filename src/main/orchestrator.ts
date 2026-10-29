import { appendWeixinContext, splitWeixinContext } from '../shared/weixin'
import { stripAssistantContext } from './assistant/context'
import { cancelRequirementPreparation, forgetRequirementContext, hasRequirementContext, prepareRequirementTurn } from './requirementRuntime'
import { resolveModelEffort, withAgentDefaults } from '../shared/agentChoices'
import { MANAGE_CONFIRMATION_PREFIX } from '../shared/uniagentManage'
import { EventEmitter } from 'node:events'
import { ZCodeRunner, type ZCodeDone } from './zcode/runner'
import { ZCodeRuntimePool } from './zcode/runtimePool'
import type { ZCodeConnection } from './zcode/connection'
import { detectZCodeRuntime, loadZCodeRuntimeConfig } from './zcode/runtime'
import { ZCodeCacheStore } from './zcode/store'
import { zcodeAttachmentRefs } from './zcode/attachments'
import { readZCodeCapabilities, zcodeContextPrompt } from './zcode/capabilities'
import { ZCodeSideRunner } from './zcode/sideRunner'
import type { ZCodeEventCursor, ZCodeEventsSnapshot } from '../shared/zcode'
import { TEAM_EXECUTION, teamRuntime } from './teamRuntime'
import type { TeamInteraction } from '../shared/teamTypes'
import { teamQuestionParams, teamRequestId } from '../shared/teamQuestions'
import { isSessionBusy } from '../shared/sessionStatus'
import { codexProviderChanged, parseCodexModelKey } from '../shared/codexModelIdentity'
import { resumeModelMismatch } from '../shared/agentWarnings'
import { nanoid } from 'nanoid'
import { isAbsolute, join } from 'node:path'
import { TurnRunner } from './adapter'
import { NativeCapabilityService } from './nativeCapabilityService'
import { claudeContextOccupancy } from '../shared/claudeNativeReports'
import { BetaSideRunner } from './betaSideRunner.ts'
import { ClaudeSdkSideRunner } from './claudeSdkSideRunner'
import { claudeSdkSessionOperation, claudeReviewPrompt, claudeGoal, claudeTurnPrompt } from './claudeSdk'
import { ACPTimeoutError } from './acp/acpConnection.ts'
import {
  AppServerRunner,
  usesAppServer,
  type AppServerRespondResult
} from './appServerAdapter'
import {
  ACPRunner,
  assertACPProviderConfig as assertStableACPProviderConfig,
  deleteGrokSession,
  loadGrokSessionEvents,
  loadMCodeSessionEvents,
  forkMCodeSession,
  loadKimiSessionEvents
} from './acp/acpRunner'
import { acpProviderFor, isACPAdapter } from './acp/acpAdapters.ts'
import type { ACPProvider } from './acp/acpProvider.ts'
import { mcodeSessionRuntimeEnv } from './mcodeService.ts'
import { deleteKimiWebSession as deleteKimiSession, forkKimiWebSession, loadKimiSubAgentEvents } from './kimiHistory.ts'
import { SessionStore, sessionStoreWriteCommitted } from './sessionStore'
import { SessionLogStore } from './sessionLogStore'
import { hydrateSubmittedUserMessages, submittedTextHash } from './submittedUserMessages.ts'
import { appendEventSnapshot, withCompactionTiming } from '../shared/eventSnapshots'
import { QueueWaitHistoryStore } from './queueWaitHistory'
import { diagnostics } from './diagnostics'
import { loadSessionEvents, exportNativeSession, forkSameSession, listAgentHistory } from './history'
import { forkHistoryAt, loadClaudeForkHistory } from './historyFork'
import { inspectNativeSessionOccupancy } from './nativeSessionOccupancy'
import { reviewGetFilePair } from './reviewFiles'
import { getGitChangeSet } from './gitChangeSet'
import { assertWorktreeAvailable, assertWorktreeNotRemoving } from './worktreeService'
import { TurnArtifactStore } from './turnArtifacts'
import { resolveUserDataHome } from './userData.ts'
import { deepseekSessionRuntimeEnv } from './deepseekService.ts'
import { kimiSessionRuntimeEnv } from './kimiRoleConfig.ts'
import { forkBetaSession, retainGrokFork, recoverGrokForks, deleteOwnedGrokFork } from './betaSessionFork.ts'
import { unconfirmGrokContract } from './grokNativeCapabilities.ts'
import { prepareGrokAttachments, collectGrokImages } from './grokImages.ts'
import { readGrokChildHistory } from './grokChildHistory.ts'
import { handoffMcpServers, handoffTaskStore } from './handoff.ts'
import { isHandoffEndEvent } from '../shared/handoffEvents.ts'
import { DeepSeekEventStore } from './deepseekEventStore.ts'
import { DeepSeekHostRunner } from './deepseekHostRunner.ts'
import { assertDeepSeekHostConfig } from './deepseekHostContract.ts'
import { loadDeepSeekHostHistory, loadDeepSeekHostImage, forkDeepSeekHostSession } from './deepseekHostHistory.ts'
import { loadDeepSeekSessionEvents, forkDeepSeekSession } from './grokACPRunner.ts'
import { KimiWebRunner } from './kimiWebRunner.ts'

import { assertKimiWebConfig } from './kimiRoleConfig.ts'

function assertACPProviderConfig(provider: ACPProvider, config: SessionConfig): void {
  if (provider === 'kimi') assertKimiWebConfig(config)
  else if (provider === 'deepseek') assertDeepSeekHostConfig(config)
  else assertStableACPProviderConfig(provider, config)
}
import { deepseekRuntimeEnv } from './deepseekService.ts'
import { isMaterialContextWindowMismatch, normalizeTraexMax } from './maxMode'
import { appendFeishuContext, splitFeishuContext } from '../shared/feishuContext'
import { isMcpToolApproval, normalizeQuestions, questionAnswerKind, questionAnswerValues, validateQuestionAnswer } from '../shared/questions'
import { ASYNC_QUESTION_PREFIX, LOCAL_PLAN_PREFIX, latestLocalPlanRequest, withPlanText, withInteractionState, asyncQuestionReply, interactionRequestKey, isAsyncQuestion, isSkippedQuestionAnswer, redactInteractionAnswer, asInteractionRequest } from '../shared/interactionRequests'
import type {
  AgentDef,
  Attachment,
  BubbleComment,
  HistoryForkPoint,
  CodexModelSourceRef,
  CodexRateLimits,
  DurableQueueItem,
  QueueItem,
  QueueStatus,
  QueueWaitQualityQuery,
  QueueWaitQualityReport,
  ReviewChangeSet,
  ReviewFilePair,
  ReviewFilePairReq,
  ReviewScope,
  RewindPreview,
  RewindResult,
  Session,
  SessionAgentContract,
  SessionConfig,
  SessionImportMode,
  NativeSessionOccupancy,
  NativeSessionRefreshResult,
  SessionRuntimeState,
  SideChatState,
  SideChatStatus,
  SessionStatus,
  SubmittedUserMessage,
  TurnArtifactSummary,
  UASubAgent,
  UAEvent
} from '../shared/types'
import type {
  ComposerCommand,
  GoalState,
  McpStartupStatus,
  NativeThreadAction,
  NativeGoalUpdate,
  NativeCapabilitySnapshot,
  ResolvedNativeTurnContext
} from '../shared/nativeCapabilities'
import {
  agentForSession,
  agentSupportsAttachments,
  assertAgentSupportsSteer,
  deriveSessionTitle,
  isCrossForkSourceAgent,
  isCrossForkTargetAgent,
  isToolSession,
  sessionDedupKey
} from '../shared/types'
import { mergeSubAgentSnapshot } from '../shared/subAgentLifecycle'
import {
  buildDetailExplanationPrompt,
  parseDetailExplanationResponse,
  type DetailExplanationContext,
} from '../shared/detailQuickChat'

type TurnInputSnapshot = {
  attachments?: Attachment[]
  nativeContext?: ResolvedNativeTurnContext
}

type SideRunner = AppServerRunner | BetaSideRunner | ZCodeSideRunner | ClaudeSdkSideRunner

// 选中即评论 — display-only decorations that ride with a user turn: `comments`
// are the quote+comment cards rendered under the sent bubble, `displayText` is
// the instruction shown as the bubble's main text (the wire prompt embeds the
// quotes). Both are persisted so the bubble survives an App restart.
type TurnBubble = {
  comments?: BubbleComment[]
  displayText?: string
  /** Main-process-only source; renderer bubble input never accepts this field. */
  source?: 'feishu' | 'weixin' | 'app' | 'mcp'
  /** An answer continues the current task instead of starting a new progress card. */
  asyncQuestion?: boolean
}

function bubblePayload(bubble?: TurnBubble): Record<string, unknown> {
  if (!bubble) return {}
  return {
    ...(bubble.comments?.length ? { comments: structuredClone(bubble.comments) } : {}),
    ...(bubble.displayText ? { displayText: bubble.displayText } : {}),
    ...(bubble.source ? { source: bubble.source } : {}),
    ...(bubble.asyncQuestion ? { asyncQuestion: true } : {})
  }
}

// A queued item carries its own bubble decorations; forward them onto the user
// event recorded when the item is finally delivered/steered.
function queueItemBubblePayload(item: QueueItem): Record<string, unknown> {
  return bubblePayload({ comments: item.comments, displayText: item.displayText, source: item.source })
}

const MAX_SUBMITTED_USER_MESSAGES = 200
// Attachments are a per-agent capability (AgentDef.capabilities.attachments);
// every turn that carries one for an agent without that capability is rejected
// at the orchestrator boundary with this message.
const ATTACHMENT_UNSUPPORTED_MESSAGE =
  '当前 Agent 暂不支持附件，请移除附件或切换其他 Agent 后发送。'
function snapshotTurnInput(
  attachments?: Attachment[],
  nativeContext?: ResolvedNativeTurnContext
): TurnInputSnapshot {
  return structuredClone({
    ...(attachments === undefined ? {} : { attachments }),
    ...(nativeContext === undefined ? {} : { nativeContext })
  })
}

export function buildDurableQueueItem(
  prompt: string,
  attachments?: Attachment[],
  nativeContext?: ResolvedNativeTurnContext,
  acceptedAt = Date.now(),
  bubble?: TurnBubble
): DurableQueueItem {
  const input = snapshotTurnInput(attachments, nativeContext)
  return {
    id: 'q_' + nanoid(6),
    prompt,
    ...input,
    ...bubblePayload(bubble),
    acceptedAt,
    state: 'pending',
    attempts: 0
  }
}

type PreparedAgentRun = {
  requirementPrepared?: boolean
  /** Immutable, fully-validated execution commit created before public fan-out. */
  agent: AgentDef
  config: SessionConfig
  route: 'protocol' | 'app-server' | 'one-shot' | 'zcode'
  input: TurnInputSnapshot
  streamer?: AppServerRunner
  announceStreamer?: boolean
}

/**
 * Orchestrates all sessions: creation, message dispatch (with a FIFO queue and
 * force/steer), event fan-out, interruption, a centralized status machine
 * (Doc4 需求6), between-turn config updates (Doc1 需求3), server→client
 * responses (Doc3), history import (Doc2), and persistence.
 *
 * Two execution paths:
 *  - Streaming (codex/traex with app-server): one long-lived AppServerRunner per
 *    session, reused across turns so context is preserved and output streams
 *    token-by-token.
 *  - One-shot (claude, or non-Plan codex/traex fallback): a fresh TurnRunner per turn.
 */
export class Orchestrator extends EventEmitter {
  private readonly deepseekEvents: DeepSeekEventStore
  private sessions = new Map<string, Session>()
  private channelSendTurns = new Map<string, { ts: number; source: 'feishu' | 'weixin' }>()
  /** Live human input channel for a Leader; never restored from session history. */
  private feishuTeamInputs = new Set<string>()
  private events = new Map<string, UAEvent[]>()
  private answeringAsyncQuestions = new Set<string>()
  private managementConfirmations = new Map<string, { sessionId: string; answer: (choice?: string) => Promise<void> }>()
  private seqRefs = new Map<string, { n: number }>()
  /** Process-local event coordinate; survives renderer reload, never SessionStore/restart. */
  private backendConfigCorrectionSeqs = new Map<string, number>()
  private runners = new Map<string, TurnRunner>()
  private claudeSdkRunners = new Map<string, TurnRunner>()
  private streamers = new Map<string, AppServerRunner>()
  private occupancyLogSignatures = new Map<string, string>()
  // 需求2（侧边对话 /side）— a SECOND logical AppServerRunner per session that
  // forks a durable Codex thread on the main runner's app-server connection. Its events are cached and
  // pushed on a SEPARATE 'sideEvent' channel (never into `this.events`), so the
  // side conversation stays entirely out of the main timeline and never persists
  // to the parent rollout on disk.
  private sideStreamers = new Map<string, SideRunner>()
  private sideEvents = new Map<string, UAEvent[]>()
  private sideSeqRefs = new Map<string, { n: number }>()
  private sideStatus = new Map<string, SideChatStatus>()
  private sideConfigs = new Map<string, SessionConfig>()
  private sideNativeSessionIds = new Map<string, string>()
  private sideQueues = new Map<string, QueueItem[]>()
  private sidePromotions = new Set<string>()
  // 选中即评论 / 详情 — a THIRD, independent ephemeral fork per session that powers
  // the floating「详情」popover explaining a text selection. Structurally identical
  // to the side channel above but on its OWN maps + 'detailEvent'/'detailStatus'
  // channels, so 详情 and 侧边对话 can coexist without clobbering each other. Like
  // side chat it never touches `this.events` nor persists to the parent rollout.
  private detailStreamers = new Map<string, AppServerRunner | ClaudeSdkSideRunner>()
  private detailEvents = new Map<string, UAEvent[]>()
  private detailSeqRefs = new Map<string, { n: number }>()
  private detailStatus = new Map<string, 'idle' | 'running'>()
  private detailExplanationState = new Map<string, { itemId?: string }>()
  private protocolRunners = new Map<string, ACPRunner | KimiWebRunner | DeepSeekHostRunner >()
  private zcodeRunners = new Map<string, ZCodeRunner>()
  private zcodePool = new ZCodeRuntimePool()
  private zcodeStarts = new Map<string, symbol>()
  private zcodeRunnerLoads = new Map<string, Promise<ZCodeRunner>>()
  private zcodeDisposals = new Map<string, Promise<void>>()
  private zcodeSideDisposals = new Map<string, Promise<void>>()
  private zcodeDisplayGenerations = new Map<string, number>()
  private completedSubAgentItems = new Map<string, Map<string, UAEvent[]>>()
  /** Coalesces Kimi cold child reads while a running detail panel polls. */
  private kimiSubAgentReads = new Map<string, { at: number; status?: UASubAgent['status']; events: UAEvent[] }>()
  // Configuration is a wire-level transaction for Grok. This queue begins at
  // the orchestrator boundary so rapid partial patches are composed from the
  // latest committed config and a subsequent prompt cannot overtake them.
  private protocolConfigTails = new Map<string, Promise<void>>()
  private deepseekConfigTransactions = new Set<string>()
  // Codex 跨来源模型切换的进度卡片状态。切换期间（以及切换后到下一个 turn_started
  // 之前）codex 对 rollout 发出的 resume 模型不一致警告是流程内部产物，折叠进卡片
  // 的 hints，不再作为散落的会话提示重复展示；条目在下一次 turn_started 时清除。
  private modelSwitches = new Map<string, {
    state: 'running' | 'success' | 'failed'
    payload: Record<string, any>
  }>()
  // A message may be logically running while its Grok prompt is still gated
  // behind an accepted config transaction. Track that gap so Stop can cancel
  // the deferred start and settle locally even though the runner has no turn yet.
  private protocolPendingStarts = new Map<string, symbol>()
  // A FIFO item is removed from its visible queue one tick before dispatch so
  // the prior turn can settle. Keep an explicit token for that gap: Stop must be
  // able to invalidate the deferred dispatch before it reaches the runner.
  private deferredDispatches = new Map<string, symbol>()
  // Per-session FIFO queue of pending messages (Doc4 需求2).
  private queues = new Map<string, DurableQueueItem[]>()
  private activeQueueItems = new Map<string, string>()
  // 需求（队列二次编辑）— while the renderer is rewriting a queued item, that item
  // (and everything behind it) must not be dispatched. The lock is keyed by
  // session; dispatch is head-only FIFO, so freezing the session pauses the whole
  // queue until the edit is saved or cancelled.
  private editingQueueItems = new Map<string, string>()
  private sideEditingItems = new Map<string, string>()
  private historyLoads = new Map<string, { owner: Session; promise: Promise<void> }>()
  private sendTails = new Map<string, Promise<void>>()
  // Accepted sends may still be waiting on history hydration while the session
  // looks idle. Rewind must treat that gap as active work.
  private pendingSends = new Map<string, number>()
  private recoveryStartTokens = new Map<string, symbol>()
  private teamStopVersions = new Map<string, number>()
  private teamQuestions = new Map<string, { interaction: TeamInteraction; resumeStatus: SessionStatus }>()
  // Import is an optimistic read. These explicit generations make both sides
  // of that read durable in memory: activity covers every mutation of a local
  // Session, while identity ownership covers who owns an agent/native-id pair.
  // Owner generations are separate because normal event/status activity must
  // not look like an owner replacement. Entries are intentionally retained
  // after deletion so ABA transitions cannot look unchanged.
  private sessionActivityGenerations = new Map<string, number>()
  private sessionOwnerGenerations = new Map<string, number>()
  private nativeIdentityOwnershipGenerations = new Map<string, number>()
  // Main-streamer ownership needs its own retained epoch. Object identity alone
  // cannot detect remove/dispose -> reinstall of the same runner reference.
  private mainStreamerOwnerGenerations = new Map<string, number>()
  // Runner object identity is the generation token for delayed callbacks. A
  // disposed/deleted runner can still flush process events; callbacks must only
  // mutate state while that exact runner remains the session's live owner.
  private store: SessionStore
  private worktreeTransitions = new Set<string>()
  private sessionLogs: SessionLogStore
  private queueWaitHistory: QueueWaitHistoryStore
  // 需求3（会话节点回退）— per-turn file artifacts (before/after snapshots) so a
  // later rewind can reverse a turn's file changes without `git reset`. Keyed by
  // native turn id; finalized when the turn completes.
  private artifacts: TurnArtifactStore
  // Live capture state per session: the running turn's native id, the latest
  // aggregated unified diff (from `diff_update`) or per-file edits, seq window, and start
  // time — folded into `artifacts.finalize` on turn completion.
  private turnCapture = new Map<
    string,
    { nativeTurnId: string; nativeThreadId: string; startSeq: number; startedAt: number; latestDiff?: string; fileChanges: UAEvent[] }
  >()
  private artifactFinalizations = new Set<Promise<void>>()
  // A rewind is a multi-step mutation (fork → file transaction → session swap).
  // Guard against a second rewind or a concurrent turn dispatch mid-transaction.
  private rewinding = new Set<string>()
  private nativeActionReservations = new Set<string>()

  constructor(
    private getAgent: (id: string) => AgentDef | undefined,
    store?: SessionStore,
    artifactsRoot?: string,
    sessionLogsRoot?: string,
    private readonly resolveProjectConfig?: (config: SessionConfig, validateDirectories?: boolean) => SessionConfig,
    private readonly assertAgentReady?: (agentId: string) => void,
    private readonly getAgentPref?: (agentId: string) => import('../shared/types').AgentPref | undefined
  ) {
    super()
    this.store = store || new SessionStore()
    const storeDirectory = typeof (this.store as SessionStore).directory === 'function'
      ? this.store.directory()
      : undefined
    this.deepseekEvents = new DeepSeekEventStore(join(storeDirectory || resolveUserDataHome(), 'deepseek', 'events'), (sessionId, error) => {
      diagnostics.record({ category:'app_runtime', level:'error', source:'deepseek', agentId:'deepseek', sessionId,
        code:'conversation_persistence_failed', message:'DeepSeek 会话记录保存或读取失败，当前对话可继续，重启后的记录可能不完整。', sample:error })
    })
    this.sessionLogs = new SessionLogStore(
      sessionLogsRoot || (storeDirectory ? join(storeDirectory, 'session-logs') : undefined),
      { background: true }
    )
    this.queueWaitHistory = new QueueWaitHistoryStore(
      storeDirectory ? join(storeDirectory, 'queue-wait-history.json') : undefined
    )
    this.artifacts = new TurnArtifactStore(
      artifactsRoot || join(resolveUserDataHome(), 'turn-artifacts'),
      { loadTurnChanges: async (sessionId, turnId) => {
        const session = this.sessions.get(sessionId)
        if (!session?.nativeSessionId) return null
        const nativeThreadId = session.nativeSessionId
        const events = await this.getEvents(sessionId)
        if (this.sessions.get(sessionId) !== session || session.nativeSessionId !== nativeThreadId) return null
        let currentTurnId: string | undefined
        const turnEvents = events.filter((event) => {
          if (event.type === 'turn_started') currentTurnId = event.payload?.turnId
          const belongs = (event.payload?.turnId ?? currentTurnId) === turnId
          if (event.type === 'turn_completed') currentTurnId = undefined
          return belongs && (event.type === 'file_change' || event.type === 'turn_started' || event.type === 'turn_completed')
        })
        return { nativeThreadId, workdir: session.config.workdir, events: turnEvents }
      } }
    )
  }

  private sessionActivityGeneration(sessionId: string): number {
    return this.sessionActivityGenerations.get(sessionId) || 0
  }

  private bumpSessionActivity(sessionId: string): void {
    this.sessionActivityGenerations.set(sessionId, this.sessionActivityGeneration(sessionId) + 1)
  }

  private sessionOwnerGeneration(sessionId: string): number {
    return this.sessionOwnerGenerations.get(sessionId) || 0
  }

  private bumpSessionOwner(sessionId: string): void {
    this.sessionOwnerGenerations.set(sessionId, this.sessionOwnerGeneration(sessionId) + 1)
  }

  private mainStreamerOwnerGeneration(sessionId: string): number {
    return this.mainStreamerOwnerGenerations.get(sessionId) || 0
  }

  private bumpMainStreamerOwner(sessionId: string): void {
    this.mainStreamerOwnerGenerations.set(
      sessionId,
      this.mainStreamerOwnerGeneration(sessionId) + 1
    )
  }

  private installMainStreamerOwner(sessionId: string, streamer: AppServerRunner): void {
    this.streamers.set(sessionId, streamer)
    this.bumpMainStreamerOwner(sessionId)
  }

  private removeMainStreamerOwner(sessionId: string): AppServerRunner | undefined {
    const streamer = this.streamers.get(sessionId)
    if (!streamer) return undefined
    this.queueWaitHistory.abandonSession(sessionId)
    this.streamers.delete(sessionId)
    this.bumpMainStreamerOwner(sessionId)
    return streamer
  }

  getQueueWaitQuality(query: QueueWaitQualityQuery = {}): QueueWaitQualityReport {
    return this.queueWaitHistory.quality.report(query)
  }

  private nativeIdentityKey(agentId: string, nativeId: string): string {
    return JSON.stringify([agentId, nativeId])
  }

  private nativeIdentityOwnershipGeneration(agentId: string, nativeId: string): number {
    return this.nativeIdentityOwnershipGenerations.get(this.nativeIdentityKey(agentId, nativeId)) || 0
  }

  private bumpNativeIdentityOwnership(agentId: string, nativeId: string): void {
    const key = this.nativeIdentityKey(agentId, nativeId)
    this.nativeIdentityOwnershipGenerations.set(
      key,
      (this.nativeIdentityOwnershipGenerations.get(key) || 0) + 1
    )
  }

  private installSessionOwner(session: Session): void {
    const previous = this.sessions.get(session.id)
    if (previous !== session) {
      this.channelSendTurns.delete(session.id)
      this.feishuTeamInputs.delete(session.id)
    }
    this.sessions.set(session.id, session)
    this.logSession(session.id, 'session_owner_installed', {
      agentId: session.config.agentId,
      nativeSessionId: session.nativeSessionId,
      status: session.status,
      replacedOwner: !!previous && previous !== session
    })
    this.bumpSessionOwner(session.id)
    this.bumpSessionActivity(session.id)
    if (previous === session) return
    const changedIdentities = new Set<string>()
    if (previous?.nativeSessionId) {
      changedIdentities.add(this.nativeIdentityKey(previous.config.agentId, previous.nativeSessionId))
    }
    if (session.nativeSessionId) {
      changedIdentities.add(this.nativeIdentityKey(session.config.agentId, session.nativeSessionId))
    }
    for (const key of changedIdentities) {
      this.nativeIdentityOwnershipGenerations.set(
        key,
        (this.nativeIdentityOwnershipGenerations.get(key) || 0) + 1
      )
    }
  }

  private removeSessionOwner(sessionId: string): Session | undefined {
    this.cancelManagementConfirmations(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    this.sessions.delete(sessionId)
    this.zcodeDisplayGenerations.delete(sessionId)
    this.channelSendTurns.delete(sessionId)
    this.feishuTeamInputs.delete(sessionId)
    this.occupancyLogSignatures.delete(sessionId)
    this.bumpSessionOwner(sessionId)
    this.bumpSessionActivity(sessionId)
    if (session.nativeSessionId) {
      this.bumpNativeIdentityOwnership(session.config.agentId, session.nativeSessionId)
    }
    return session
  }

  private replaceSessionConfig(session: Session, config: SessionConfig): void {
    const previousAgentId = session.config.agentId
    session.config = config
    this.bumpSessionActivity(session.id)
    if (session.nativeSessionId && previousAgentId !== config.agentId) {
      this.bumpNativeIdentityOwnership(previousAgentId, session.nativeSessionId)
      this.bumpNativeIdentityOwnership(config.agentId, session.nativeSessionId)
    }
  }

  /** Load persisted sessions at startup (Doc2 需求3.1). */
  async loadPersisted(): Promise<void> {
    for (const s of this.store.load()) {
      this.installSessionOwner(s)
      if (!this.events.has(s.id)) this.events.set(s.id, [])
      if (!this.seqRefs.has(s.id)) this.seqRefs.set(s.id, { n: 0 })
      if (s.config.agentId === 'deepseek') {
        try {
          const events = await this.deepseekEvents.load(s.id)
          this.events.set(s.id, s.archived ? [] : events)
          this.seqRefs.set(s.id, { n: events.reduce((next, event) => Math.max(next, event.seq + 1), 0) })
        } catch (error) {
          this.logSession(s.id, 'history_restore_failed', { message: String(error) })
        }
      }
      const queue = (s.pendingQueue || []).map((item) => ({ ...item, state: 'pending' as const }))
      s.pendingQueue = queue
      this.queues.set(s.id, queue)
      this.logSession(s.id, 'session_loaded', {
        agentId: s.config.agentId,
        nativeSessionId: s.nativeSessionId,
        status: s.status,
        queuedItems: queue.length
      })
    }
    for (const side of this.store.loadSideChats?.() || []) {
      if (!this.sessions.has(side.sessionId)) continue
      this.sideEvents.set(side.sessionId, side.events)
      this.sideSeqRefs.set(side.sessionId, {
        n: side.events.reduce((next, event) => Math.max(next, event.seq + 1), 0)
      })
      this.sideConfigs.set(side.sessionId, side.config)
      this.sideQueues.set(side.sessionId, side.queue || [])
      if (side.nativeSessionId) this.sideNativeSessionIds.set(side.sessionId, side.nativeSessionId)
    }
    this.emit('assistantSessionsLoaded')
  }

  /**
   * One-time compatibility rewrite for sessions created while Codex／TraeX
   * exposed Plan as a permission. This runs only after agent discovery, because
   * custom agent ids must be classified by their resolved adapter rather than by
   * a hard-coded builtin id. All changed rows are persisted in one write.
   */
  migrateLegacyPlanSessions(): boolean {
    let changed = false
    const migratedSessions: Session[] = []
    for (const session of this.sessions.values()) {
      const agent = this.getAgent(session.config.agentId)
      if (!agent || (agent.adapter !== 'codex' && agent.adapter !== 'traex')) continue
      const readOnly = agent.capabilities.permissionModes.find((mode) => mode.id === 'read-only')
      if (!readOnly) continue
      let sessionChanged = false

      if (session.config.permissionMode === 'plan') {
        session.config = {
          ...session.config,
          permissionMode: 'read-only',
          collaborationMode: 'plan'
        }
        changed = true
        sessionChanged = true
      }

      const contract = session.agentContract
      if (contract) {
        const migratedModes = contract.permissionModes.map((mode) =>
          mode.id === 'plan' ? { ...readOnly } : { ...mode }
        )
        const permissionModes = migratedModes.filter((mode, index) =>
          migratedModes.findIndex((candidate) => candidate.id === mode.id) === index
        )
        const currentPermissionMode = contract.currentPermissionMode === 'plan'
          ? permissionModes.some((mode) => mode.id === 'read-only') ? 'read-only' : undefined
          : contract.currentPermissionMode
        if (
          permissionModes.some((mode, index) => mode.id !== contract.permissionModes[index]?.id) ||
          permissionModes.length !== contract.permissionModes.length ||
          currentPermissionMode !== contract.currentPermissionMode
        ) {
          const { currentPermissionMode: _legacyCurrentPermissionMode, ...contractWithoutCurrentMode } = contract
          session.agentContract = {
            ...contractWithoutCurrentMode,
            permissionModes,
            ...(currentPermissionMode === undefined ? {} : { currentPermissionMode })
          }
          changed = true
          sessionChanged = true
        }
      }
      if (sessionChanged) migratedSessions.push(session)
    }
    if (changed) {
      this.persist()
      for (const session of migratedSessions) {
        this.emit('sessionUpdated', { session, hasLiveStreamer: false })
      }
    }
    return changed
  }

  /**
   * Detach personal-assistant sessions whose agent cannot inject a startup system
   * prompt: the snapshot gate (inScope / Feishu residency / commands / identity
   * injection) all reads config.assistantSnapshot, so dropping it turns them back
   * into regular sessions while history stripping stays unconditional.
   */
  detachUnsupportedAssistantSessions(): Session[] {
    const detached: Session[] = []
    for (const session of this.sessions.values()) {
      if (!session.config.assistantSnapshot || session.teamBinding || session.handoffId) continue
      if (this.getAgent(session.config.agentId)?.capabilities.startupSystemPrompt) continue
      const { assistantSnapshot: _assistantSnapshot, ...config } = session.config
      session.config = config
      detached.push(session)
    }
    if (detached.length) {
      this.persist()
      for (const session of detached) {
        this.emit('sessionUpdated', { session, hasLiveStreamer: false })
      }
    }
    return detached
  }

  /** Reconcile persisted selections after the live Agent catalog is available. */
  async recoverGrokForks(): Promise<void> {
    const grok = this.getAgent('grok')
    if (grok?.capabilities.sessionFork !== true) return
    const references = new Set([...this.sessions.values()].map(session => session.nativeSessionId).filter((id): id is string => !!id))
    for (const id of this.sideNativeSessionIds.values()) references.add(id)
    const report = await recoverGrokForks(grok.bin,references)
    if (report.failed) this.emit('nativeCleanupWarning',{agentId:'grok',message:`${report.failed} 个 Grok 临时分叉清理未确认，已保留归属记录。`})
  }

  reconcileAgentConfigs(): boolean {
    let sessionsChanged = false
    for (const session of this.sessions.values()) {
      const agent = this.getAgent(session.config.agentId)
      const liveGrok = agent?.adapter === 'grok' && this.protocolRunners.has(session.id) && session.agentContract?.grokNative?.confirmed === true
      const liveMCode = agent?.adapter === 'mcode' && this.protocolRunners.has(session.id)
      const liveClaude = agent?.adapter === 'claude' && this.claudeSdkRunners.get(session.id)?.hasClaudeSdkConnection()
      
      if (agent?.adapter === 'grok' && session.agentContract?.grokNative) {
        if (!liveGrok) {
          const next = unconfirmGrokContract(session.agentContract)
          if (JSON.stringify(next) !== JSON.stringify(session.agentContract)) { session.agentContract = next; sessionsChanged = true; this.emitAgentUpdate(session) }
        }
      } else if (agent?.adapter === 'mcode' && !liveMCode && session.agentContract) {
        const next = { ...session.agentContract, ...agent.capabilities, models: agent.models, currentModelId: session.config.model }
        if (JSON.stringify(next) !== JSON.stringify(session.agentContract)) { session.agentContract = next; sessionsChanged = true; this.emitAgentUpdate(session) }
      } else if (agent && agent.capabilities.protocol !== 'web' && ['grok', 'deepseek'].includes(agent.adapter) && session.agentContract) {
        const old = session.agentContract
        const next = { ...old, permissionModes:agent.capabilities.permissionModes.map(mode => ({...mode})), sessionList:agent.capabilities.sessionList === true, sessionLoad:agent.capabilities.sessionLoad === true, sessionResume:agent.capabilities.sessionResume === true, collaborationModes:agent.capabilities.collaborationModes || ['default'], imageAttachments:agent.capabilities.imageAttachments === true, fileAttachments:agent.capabilities.fileAttachments === true, additionalDirectoriesNew:agent.capabilities.additionalDirectoriesNew === true, additionalDirectoriesResume:agent.capabilities.additionalDirectoriesResume === true, steer:false, sessionFork:false, sessionForkAtTurn:false, crossAgentFork:false, sideChat:false, structuredSubagents:false, nativeGoal:false, nativeReview:false, capabilityInventory:false, structuredUsage:false, formElicitation:false, freeTextElicitation:false }
        if (JSON.stringify(next) !== JSON.stringify(old)) { session.agentContract = next; sessionsChanged = true; this.emitAgentUpdate(session) }
      }
      if (agent && session.agentContract && ['kimi', 'claude', 'zcode', 'deepseek', 'grok'].includes(agent.adapter) &&
          !this.protocolRunners.has(session.id) && !this.runners.has(session.id) && !this.zcodeRunners.has(session.id) &&
          JSON.stringify(session.agentContract.permissionModes) !== JSON.stringify(agent.capabilities.permissionModes)) {
        session.agentContract = { ...session.agentContract, permissionModes: agent.capabilities.permissionModes.map(mode => ({ ...mode })) }
        sessionsChanged = true
        this.emitAgentUpdate(session)
      }
      if (agent && !liveGrok && !liveMCode && !liveClaude && ['claude', 'kimi', 'grok', 'deepseek', 'mcode'].includes(agent.adapter) && session.goal?.autonomous) {
        session.goal = { ...session.goal, autonomous:false, nativeActivation:'disarmed', ...(agent.adapter === 'claude' && session.goal.status === 'active' ? { status: 'paused' as const } : {}) }
        sessionsChanged = true
      }
      const config = this.normalizeAgentConfig(session.config, session.forkedFrom?.mode === 'cross').config
      if (config === session.config) continue
      this.replaceSessionConfig(session, config)
      sessionsChanged = true
      this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
    }
    let sideChatsChanged = false
    for (const [sessionId, current] of this.sideConfigs) {
      const config = this.normalizeAgentConfig(current).config
      if (config === current) continue
      this.sideConfigs.set(sessionId, config)
      this.sideStreamers.get(sessionId)?.updateConfig(config)
      sideChatsChanged = true
      this.emitSideState(sessionId)
    }
    if (sessionsChanged) this.persist()
    if (sideChatsChanged) this.persistSideChats()
    return sessionsChanged || sideChatsChanged
  }

  private persist(): void {
    this.store.save([...this.sessions.values()])
  }

  private persistOrThrow(): void {
    this.store.saveOrThrow([...this.sessions.values()])
  }

  private persistSideChats(): void {
    this.store.saveSideChats?.([...this.sideConfigs].map(([sessionId, config]) => ({
      sessionId,
      config,
      events: this.sideEvents.get(sessionId) || [],
      nativeSessionId: this.sideNativeSessionIds.get(sessionId),
      queue: this.sideQueues.get(sessionId) || []
    })))
  }

  listSessions(): Session[] {
    // Doc5 T3: collapse duplicates by session identity (agentId+nativeSessionId)
    // before returning, keeping the most-recently-updated of any dupes. Cleans
    // historical duplicates already sitting in the persisted store.
    const byKey = new Map<string, Session>()
    for (const s of this.sessions.values()) {
      const key = dedupKey(s)
      const prev = byKey.get(key)
      if (!prev || updatedAtOf(s) >= updatedAtOf(prev)) byKey.set(key, s)
    }
    return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  managedSessions(): Session[] { return [...this.sessions.values()] }
  loadedSessionEvents(sessionId: string, limit = 200): readonly UAEvent[] { return (this.events.get(sessionId) || []).slice(-Math.min(500, Math.max(1, limit))) }
  pendingSessionRequests(sessionId: string): readonly UAEvent[] {
    const requests = new Map<string, UAEvent>()
    for (const event of this.events.get(sessionId) || []) {
      if (event.type !== 'approval_request' && !isAsyncQuestion(event)) continue
      const request = asInteractionRequest(event)
      if (typeof request.payload.requestId === 'string') requests.set(request.payload.requestId,request)
    }
    return [...requests.values()].filter(event => event.state === 'pending' && event.payload.submittedAnswer === undefined && !event.payload.interactionExpired)
  }

  requestManagementConfirmation(sessionId: string, operationId: string, summary: string, answer: (approved: boolean) => Promise<void>): void {
    this.requestManagementChoice(sessionId, operationId, summary, ['取消', '确认执行'], choice => answer(choice === '确认执行'))
  }

  requestManagementChoice(sessionId: string, operationId: string, summary: string, options: string[], answer: (choice?: string) => Promise<void>): void {
    const session = this.sessions.get(sessionId)
    if (!session?.config.assistantSnapshot || session.archived || session.readOnly || session.teamBinding || session.handoffId) throw new Error('assistant_session_required')
    const requestId = MANAGE_CONFIRMATION_PREFIX + operationId
    if (this.managementConfirmations.has(requestId)) throw new Error('management_confirmation_exists')
    this.managementConfirmations.set(requestId, { sessionId, answer })
    this.record(sessionId, { type: 'approval_request', state: 'pending', payload: {
      requestId, kind: 'question', method: 'local/assistantManage', delivery: 'async', params: { questions: [{
        id: 'confirm', header: 'UniAgent', question: summary,
        allowOther: false, options: options.map(label => ({ label }))
      }] }
    } })
  }

  dismissManagementConfirmation(sessionId: string, operationId: string): void {
    const id = MANAGE_CONFIRMATION_PREFIX + operationId
    if (this.managementConfirmations.get(id)?.sessionId !== sessionId) return
    this.managementConfirmations.delete(id)
    const request = this.events.get(sessionId)?.findLast(event => event.type === 'approval_request' && event.payload.requestId === id)
    if (request) {
      request.state = 'cancelled'; request.payload.interactionExpired = true
      this.logEvent(request); this.emit('event', request)
    }
  }

  cancelManagementConfirmations(sessionId: string): void {
    for (const [id, pending] of this.managementConfirmations) if (pending.sessionId === sessionId) {
      this.managementConfirmations.delete(id)
      const request = this.events.get(sessionId)?.findLast(event => event.type === 'approval_request' && event.payload.requestId === id)
      if (request) {
        request.state = 'cancelled'; request.payload.interactionExpired = true
        this.logEvent(request); this.emit('event', request)
      }
      void pending.answer(undefined).catch(() => {})
    }
  }

  hasActiveAgentSessions(agentId?: string): boolean {
    return [...this.sessions.values()].some((session) => {
      if (agentId && session.config.agentId !== agentId) return false
      return this.isBusy(session.status) || (!!session.worktreeTask && !session.worktreeTaskError) ||
        this.teamDeliveryBlocked(session.id) || !!this.protocolPendingStarts.get(session.id) ||
        !!this.deferredDispatches.get(session.id) ||
        this.getSideStatus(session.id) !== 'idle' || !!this.sideQueues.get(session.id)?.length ||
        this.getDetailStatus(session.id) !== 'idle'
    })
  }

  hasActiveSessionWork(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && (this.isBusy(session.status) || !!this.getQueue(sessionId).length ||
      (!!session.worktreeTask && !session.worktreeTaskError) || this.teamDeliveryBlocked(sessionId) ||
      !!this.protocolPendingStarts.get(sessionId) || !!this.deferredDispatches.get(sessionId) ||
      this.pendingSends.has(sessionId) || this.recoveryStartTokens.has(sessionId) ||
      this.nativeActionReservations.has(sessionId) || this.assistantCommandSessions.has(sessionId) ||
      this.getSideStatus(sessionId) !== 'idle' || !!this.sideQueues.get(sessionId)?.length || this.getDetailStatus(sessionId) !== 'idle')
  }

  restartWorkRevision(sessionId: string): string {
    const input = (events?: readonly UAEvent[]) => {
      const event = events?.findLast(ev => ev.type === 'user_message' || ev.type === 'goal_message' || ev.type === 'turn_started')
      return event ? [event.seq, event.ts] : null
    }
    // Streaming output changes the history generation, but is still the same
    // approved work. Only accepted inputs, new turns and pending work matter.
    return JSON.stringify([input(this.events.get(sessionId)), input(this.sideEvents.get(sessionId)), input(this.detailEvents.get(sessionId)),
      this.getQueue(sessionId).map(item => item.id), this.sideQueues.get(sessionId)?.map(item => item.id) || [],
      this.pendingSends.get(sessionId) || 0, this.nativeActionReservations.has(sessionId),
      this.protocolPendingStarts.has(sessionId), this.getDetailStatus(sessionId)])
  }

  /** 需求5 — the single session object (no dedup collapse) by its UniAgent id. */
  getSessionById(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * 需求5 — the accumulated text of the most recent `agent_message` in a
   * session's in-memory event buffer (the final reply once a turn ends). Empty
   * string when the session has produced no assistant text yet.
   */
  latestAgentMessageText(sessionId: string, afterSeq = -1): string {
    const events = this.events.get(sessionId)
    if (!events) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.seq > afterSeq && ev.type === 'agent_message' && !isAsyncQuestion(ev) && typeof ev.payload?.text === 'string' && ev.payload.text.trim()) {
        return ev.payload.text
      }
    }
    return ''
  }

  latestUserMessageText(sessionId: string, beforeSeq: number): string {
    const input = this.events.get(sessionId)?.findLast(ev =>
      ev.seq < beforeSeq && (ev.type === 'user_message' || ev.type === 'goal_message') &&
      !(ev.payload.source === 'mcp' && this.sessions.get(sessionId)?.teamBinding))
    return String(input?.payload.displayText || input?.payload.text || (input?.payload.attachments?.length ? '[图片]' : ''))
  }

  currentTurnAgentMessageText(sessionId: string, completedSeq: number): string {
    const events = this.events.get(sessionId) || []
    const previousEnd = events.findLast(ev => ev.type === 'turn_completed' && ev.seq < completedSeq)?.seq ?? -1
    const input = events.find(ev => ev.seq > previousEnd && ev.seq < completedSeq && (ev.type === 'user_message' || ev.type === 'goal_message'))
    return input ? this.latestAgentMessageText(sessionId, input.seq) : ''
  }

  private assertAgentCanRun(agentId: string): void {
    this.assertAgentReady?.(agentId)
    const agent = this.getAgent(agentId)
    if (
      !agent ||
      agent.installed === false ||
      agent.incompatible ||
      (agent.lifecycle && agent.lifecycle.availability !== 'available')
    ) throw new Error('agent_not_available')
  }

  async getEvents(sessionId: string): Promise<UAEvent[]> {
    const existing = this.events.get(sessionId)
    if (existing && existing.length > 0 && this.sessions.get(sessionId)?.config.agentId !== 'zcode') return existing
    // 需求1 (重启后历史任务内容为空): a session restored from the persisted store
    // starts with an empty in-memory event buffer — we never persist the event
    // history, only metadata. Re-hydrate it lazily from the agent's own native
    // rollout on disk (created + imported alike carry a nativeSessionId once a
    // turn has run), so opening a restored task replays its conversation instead
    // of showing a blank chat area.
    const session = this.sessions.get(sessionId)
    const restoredQuestion = this.teamQuestions.has(sessionId) && !this.streamers.has(sessionId) && !this.runners.has(sessionId)
    if (session?.config.agentId === 'zcode' && session.nativeSessionId) {
      if (this.zcodeRunners.get(sessionId)?.isRunning() && existing?.length) return existing
      const runner = await this.ensureZCodeRunner(session)
      await runner.refresh()
      await runner.loadEarlier().catch(() => undefined)
      const events = this.events.get(sessionId) || []
      const ends = await handoffTaskStore.loadCallerEvents(sessionId, events)
      if (ends.length && this.events.get(sessionId) === events) {
        const ref = this.seqRefs.get(sessionId) || { n: 0 }
        this.publishZCodeSnapshot(sessionId, [...events, ...ends].sort((a, b) => a.ts - b.ts)
          .map(event => ({ ...event, seq: ref.n++ })))
        this.seqRefs.set(sessionId, ref)
      }
      return this.events.get(sessionId) || []
    }
    if (session?.config.agentId === 'deepseek') {
      let load = this.historyLoads.get(sessionId)
      if (!load || load.owner !== session) {
        const target = existing || []
        const promise = this.deepseekEvents.load(sessionId).then(restored => {
          if (this.sessions.get(sessionId) !== session || this.events.get(sessionId) !== target || target.length) return
          this.events.set(sessionId, restored)
          const ref = this.seqRefs.get(sessionId)
          if (ref) ref.n = restored.reduce((next, event) => Math.max(next, event.seq + 1), ref.n)
        })
        load = { owner: session, promise }
        this.historyLoads.set(sessionId, load)
      }
      try { await load.promise } finally { if (this.historyLoads.get(sessionId) === load) this.historyLoads.delete(sessionId) }
      return this.events.get(sessionId) || []
    }
    if (!session || (!session.nativeSessionId && !session.pendingClaudeFork) || this.isBusy(session.status) && !restoredQuestion) return existing || []
    let load = this.historyLoads.get(sessionId)
    if (!load || load.owner !== session) {
      const owner = session
      const nativeSessionId = session.nativeSessionId
      const target = existing || []
      const ref = this.seqRefs.get(sessionId) || { n: 0 }
      const startingLength = target.length
      const promise = (async (): Promise<void> => {
        try {
          await this.sessionLogs.flush()
          const checkpoints = this.sessionLogs.loadReplayCheckpoints(sessionId)
          const agent = this.getAgent(owner.config.agentId)
          const { events } =
            owner.pendingClaudeFork
              ? await loadClaudeForkHistory(owner.pendingClaudeFork)
              :  agent?.adapter === 'kimi'
                ? await loadKimiSessionEvents(nativeSessionId!, agent.bin, owner.config.workdir, kimiSessionRuntimeEnv(owner.id, owner.config))
                : agent?.adapter === 'grok'
                ? await loadGrokSessionEvents(nativeSessionId!, agent.bin, owner.config.workdir)
                : agent?.adapter === 'mcode'
                ? await loadMCodeSessionEvents(nativeSessionId!, agent.bin, owner.config.workdir, mcodeSessionRuntimeEnv())
                : await loadSessionEvents(owner.config.agentId, nativeSessionId!)
          const handoffEnds = await handoffTaskStore.loadCallerEvents(sessionId, events)
          if (
            this.sessions.get(sessionId) !== owner ||
            owner.nativeSessionId !== nativeSessionId ||
            this.events.get(sessionId) !== target ||
            target.length !== startingLength ||
            this.runners.has(sessionId) ||
            this.streamers.has(sessionId) ||
            this.protocolRunners.has(sessionId)
          ) return
          const restored = hydrateSubmittedUserMessages(events, owner.submittedUserMessages)
          this.restoreInteractionCheckpoints(sessionId, owner.config.agentId, restored, checkpoints)
          for (const end of handoffEnds) {
            const insertion = restored.findIndex(event => event.ts > end.ts)
            restored.splice(insertion < 0 ? restored.length : insertion, 0, end)
          }
          for (const event of restored) {
            target.push({ ...event, sessionId, seq: ref.n++, ...(['user_message','goal_message'].includes(event.type) ? { payload: { ...event.payload, text: stripAssistantContext(String(event.payload.text || '')) } } : {}) })
          }
          this.restoreReplyCheckpoints(sessionId, target)
          this.seqRefs.set(sessionId, ref)
          this.bumpSessionActivity(sessionId)
        } catch {
          /* rollout unreadable / removed — retain the stable empty buffer */
        }
      })()
      load = { owner, promise }
      this.historyLoads.set(sessionId, load)
      void promise.finally(() => {
        if (this.historyLoads.get(sessionId)?.promise === promise) this.historyLoads.delete(sessionId)
      })
    }
    await load.promise
    const restoredSession = this.sessions.get(sessionId)
    if (restoredSession) this.ensureLocalPlanRequest(restoredSession)
    return this.events.get(sessionId) || []
  }

  private restoreInteractionCheckpoints(
    sessionId: string, agentId: string, restored: UAEvent[],
    checkpoints = this.sessionLogs.loadReplayCheckpoints(sessionId)
  ): void {
    const localKeys = new Set(checkpoints.map(interactionRequestKey))
    const inherited = restored.filter(event => isAsyncQuestion(event) &&
      Array.isArray(event.payload.inheritedFromNativeSessionIds) && !localKeys.has(interactionRequestKey(event)))
    const sources = new Map<string, UAEvent[]>()
    for (const question of inherited) {
      for (const nativeId of question.payload.inheritedFromNativeSessionIds) {
        const source = this.findByIdentity(agentId, nativeId)
        if (!source || source.id === sessionId) continue
        let sourceCheckpoints = sources.get(source.id)
        if (!sourceCheckpoints) {
          sourceCheckpoints = this.sessionLogs.loadReplayCheckpoints(source.id)
          sources.set(source.id, sourceCheckpoints)
        }
        const saved = sourceCheckpoints.find(event => interactionRequestKey(event) === interactionRequestKey(question))
        if (!saved) continue
        const resolved = withInteractionState(question, [saved])
        if (resolved.payload.submittedAnswer === undefined && !resolved.payload.interactionExpired) break
        // Native forks preserve question items, but local answers are not in the rollout.
        // Copy their state once so the new session no longer depends on its source.
        const checkpoint = { ...resolved, sessionId }
        checkpoints.push(checkpoint)
        this.logEvent(checkpoint)
        break
      }
    }
    for (const saved of checkpoints) {
      if (saved.type === 'system_notice' && saved.payload.kind === 'nika_auto') continue
      if (saved.type === 'approval_request' && !saved.payload.kind) continue
      const key = interactionRequestKey(saved)
      const index = restored.findIndex(event => interactionRequestKey(event) === key)
      const checkpoint = {
        ...saved,
        ...(index < 0 ? {} : { ts: restored[index].ts }),
        payload: {
          ...(index < 0 ? {} : restored[index].payload), ...saved.payload,
          ...(saved.type === 'approval_request' && saved.state === 'pending' &&
            saved.payload.submittedAnswer === undefined && !saved.payload.teamQuestion && saved.payload.method !== 'local/plan' ? { interactionExpired: true } : {}),
        },
      }
      if (index >= 0) restored[index] = checkpoint
      else {
        const insertion = restored.findIndex(event => event.ts > saved.ts)
        restored.splice(insertion < 0 ? restored.length : insertion, 0, checkpoint)
      }
    }
  }

  private restoreReplyCheckpoints(sessionId: string, events: UAEvent[]): void {
    const checkpoints = this.sessionLogs.loadInterruptedReplies(sessionId)
    for (const checkpoint of checkpoints) {
      const id = checkpoint.payload?.id
      const text = typeof checkpoint.payload?.text === 'string' ? checkpoint.payload.text : ''
      const turnId = checkpoint.payload?.turnId
      if (!turnId) continue
      const turnStartIndex = events.findIndex((event) =>
        event.type === 'turn_started' && event.payload?.turnId === turnId
      )
      if (turnStartIndex < 0) continue
      const turnEndIndex = events.findIndex((event, index) =>
        index > turnStartIndex && event.type === 'turn_completed' && event.payload?.turnId === turnId
      )
      const turnLimit = turnEndIndex < 0 ? events.length : turnEndIndex + 1
      const sameTurnReply = (event: UAEvent, index: number): boolean =>
        index >= turnStartIndex && index < turnLimit && event.type === 'agent_message'
      let matchingIndex = events.findIndex((event, index) =>
        sameTurnReply(event, index) && !!id && event.payload?.id === id
      )
      if (matchingIndex < 0) matchingIndex = events.findIndex((event, index) => {
        if (!sameTurnReply(event, index)) return false
        const historyText = typeof event.payload?.text === 'string' ? event.payload.text : ''
        return !!text && !!historyText &&
          (historyText.startsWith(text) || text.startsWith(historyText))
      })
      if (matchingIndex >= 0) {
        const historyText = typeof events[matchingIndex].payload?.text === 'string'
          ? events[matchingIndex].payload.text
          : ''
        if (text.length > historyText.length) {
          events[matchingIndex] = {
            ...events[matchingIndex],
            state: 'cancelled',
            payload: { ...events[matchingIndex].payload, ...checkpoint.payload, text }
          }
        }
        continue
      }
      const insertionIndex = turnId
        ? events.findIndex((event) =>
            event.type === 'turn_completed' && event.payload?.turnId === turnId
          )
        : -1
      events.splice(insertionIndex < 0 ? events.length : insertionIndex, 0, {
        ...checkpoint,
        sessionId,
        state: 'cancelled'
      })
    }
    events.forEach((event, seq) => { event.seq = seq })
    const ref = this.seqRefs.get(sessionId) || { n: 0 }
    ref.n = events.length
    this.seqRefs.set(sessionId, ref)
  }

  async getSessionRuntimeState(sessionId: string, includeEvents = true): Promise<SessionRuntimeState> {
    let events = includeEvents ? await this.getEvents(sessionId) : []
    const zcodeEvents = this.zcodeEventCursor(sessionId, events)
    if (zcodeEvents) events = structuredClone(events)
    const nativeSessionOccupancy = await this.inspectSessionOccupancy(sessionId)
    return this.runtimeState(sessionId, events, nativeSessionOccupancy, zcodeEvents)
  }

  private runtimeState(
    sessionId: string,
    events: UAEvent[],
    nativeSessionOccupancy: NativeSessionOccupancy = {
      state: 'unsupported',
      checkedAt: Date.now()
    },
    zcodeEvents = this.zcodeEventCursor(sessionId, events)
  ): SessionRuntimeState {
    const backendConfigCorrectionSeq = this.backendConfigCorrectionSeqs.get(sessionId)
    const goal = this.sessions.get(sessionId)?.goal
    return {
      events,
      ...(zcodeEvents ? { zcodeEvents } : {}),
      // Manual context compaction is an app-server capability. A live ACP
      // transport must not make the renderer offer the app-server command;
      // Grok exposes /compact through its session-scoped command palette.
      hasLiveStreamer: this.streamers.has(sessionId),
      nativeSessionOccupancy,
      ...(backendConfigCorrectionSeq !== undefined ? { backendConfigCorrectionSeq } : {}),
      ...(goal === undefined ? {} : { goal })
    }
  }

  private inspectSessionOccupancy(sessionId: string, trigger = 'runtime'): Promise<NativeSessionOccupancy> {
    const session = this.sessions.get(sessionId)
    const nativeSessionId = session?.nativeSessionId
    return inspectNativeSessionOccupancy(
      session?.config.agentId || '',
      nativeSessionId,
      [this.streamers.get(sessionId)?.processId()],
      (sample) => {
        if (!session || this.sessions.get(sessionId) !== session) return
        // Polls repeat every 5 s; retain changes in the evidence, not timestamps.
        const signature = JSON.stringify([
          session.config.agentId, nativeSessionId, sample.file, sample.state, sample.reason,
          sample.ignoredProcessRoots, sample.writablePids, sample.parents, sample.error, sample.stderr
        ])
        if (this.occupancyLogSignatures.get(sessionId) === signature) return
        this.occupancyLogSignatures.set(sessionId, signature)
        this.logSession(sessionId, 'native_session_occupancy', {
          ...sample,
          trigger,
          agentId: session?.config.agentId,
          nativeSessionId,
          appPid: process.pid,
          sessionStatus: session?.status,
          currentRunnerPid: this.streamers.get(sessionId)?.processId(),
          sideRunnerPid: this.sideStreamers.get(sessionId)?.processId(),
          detailRunnerPid: this.detailStreamers.get(sessionId)?.processId()
        })
      }
    )
  }

  private async assertSessionNotExternallyOccupied(session: Session): Promise<void> {
    const occupancy = await this.inspectSessionOccupancy(session.id, 'before_mutation')
    if (occupancy.state === 'occupied') {
      this.logSession(session.id, 'native_session_mutation_blocked', occupancy)
      throw new Error('当前 Session 正在被其他 Agent 使用')
    }
  }

  getQueue(sessionId: string): QueueItem[] {
    return structuredClone(this.queues.get(sessionId) || [])
  }

  listQueues(): Record<string, QueueItem[]> {
    return Object.fromEntries(
      [...this.queues].map(([sessionId]) => [sessionId, this.getQueue(sessionId)])
    )
  }

  /**
   * Resume crash-recovered outbox heads whose agents are ready. Omitting the
   * filter preserves the original all-agents startup behavior.
   */
  resumePendingQueues(
    readyAgents?: ReadonlySet<string> | ((agentId: string) => boolean)
  ): void {
    const agentIsReady =
      typeof readyAgents === 'function'
        ? readyAgents
        : readyAgents
          ? (agentId: string): boolean => readyAgents.has(agentId)
          : (): boolean => true
    for (const session of this.sessions.values()) {
      if (this.canResumePendingQueue(session, agentIsReady)) {
        // Recovered queue replay is itself a send. Reuse the same history
        // barrier as a live send so native transcript events are installed
        // before the recovered user message changes the empty event buffer.
        // resumePendingQueue installs sendTails synchronously before returning,
        // so a later startup phase or live send cannot overtake this replay.
        void this.resumePendingQueue(session, agentIsReady)
      }
    }
  }

  private canResumePendingQueue(
    session: Session,
    agentIsReady: (agentId: string) => boolean
  ): boolean {
    const agent = this.getAgent(session.config.agentId)
    const needsNativeResume = !!agent && (usesAppServer(agent) || agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web' || agent.adapter === 'zcode')
    const hasTrustedNativeResume = !!session.nativeSessionId
    return (
      this.sessions.get(session.id) === session &&
      !session.archived &&
      !session.teamBinding &&
      !session.readOnly &&
      (!agent || !planCollaborationTransportError(agent, session.config)) &&
      (!needsNativeResume || hasTrustedNativeResume) &&
      agentIsReady(session.config.agentId) &&
      (this.queues.get(session.id)?.length ?? 0) > 0 &&
      !((agent?.adapter === 'kimi' || agent?.adapter === 'deepseek' || agent?.adapter === 'zcode') && this.queues.get(session.id)?.some(item => item.state !== 'pending' || item.deliveryUncertain)) &&
      !this.rewinding.has(session.id) &&
      !this.isBusy(session.status)
    )
  }

  private resumePendingQueue(
    session: Session,
    agentIsReady: (agentId: string) => boolean
  ): Promise<void> {
    const sessionId = session.id
    const previous = this.sendTails.get(sessionId) || Promise.resolve()
    const operation = previous.then(async () => {
      if (!this.canResumePendingQueue(session, agentIsReady)) return
      this.bumpSessionActivity(sessionId)
      const token = Symbol(sessionId)
      this.recoveryStartTokens.set(sessionId, token)
      await this.getEvents(sessionId)
      if (this.recoveryStartTokens.get(sessionId) !== token) return
      this.recoveryStartTokens.delete(sessionId)
      // History hydration and prior send tails are asynchronous. Re-evaluate
      // every dispatch prerequisite against current state: a later startup
      // phase may revoke agent readiness, while archive/delete/read-only/queue
      // actions may invalidate the recovered owner during the barrier.
      if (!this.canResumePendingQueue(session, agentIsReady)) return
      this.dispatchPendingQueue(session)
    })
    this.sendTails.set(
      sessionId,
      operation.then(
        () => undefined,
        () => undefined
      )
    )
    return operation
  }

  createTeamSessions(entries: Array<{ id?: string; config: SessionConfig; title: string; binding: NonNullable<Session['teamBinding']> }>): Session[] {
    const created: Session[] = []
    try {
      for (const entry of entries) {
        const { session } = this.createSessionRecord(entry.config, entry.title, undefined, entry.binding, entry.id)
        created.push(session)
      }
      this.persistOrThrow()
      return created
    } catch (error) {
      for (const session of created) this.discardUnstartedSession(session)
      throw error
    }
  }

  private isTeamMember(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.teamBinding && !teamRuntime(sessionId)?.leader
  }

  /** Team result delivery never overtakes a user queue, edit, native action or send. */
  teamDeliveryBlocked(sessionId: string): boolean {
    return this.teamQuestions.has(sessionId) || !!this.queues.get(sessionId)?.length || this.editingQueueItems.has(sessionId) ||
      this.activeQueueItems.has(sessionId) || this.nativeActionReservations.has(sessionId) ||
      this.rewinding.has(sessionId) || !!this.pendingSends.get(sessionId)
  }

  syncTeamQuestions(sessionId: string, interactions: TeamInteraction[], active: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session?.teamBinding) return
    const previous = this.teamQuestions.get(sessionId)
    const question = active ? interactions.find(interaction => interaction.state === 'pending') : undefined
    if (question) this.teamQuestions.set(sessionId, { interaction: structuredClone(question), resumeStatus: previous?.resumeStatus ?? session.status })
    else this.teamQuestions.delete(sessionId)
    if (previous && previous.interaction.id !== question?.id) {
      const settled = interactions.find(interaction => interaction.id === previous.interaction.id)
      this.recordTeamQuestion(sessionId, settled && settled.state !== 'pending' ? settled : { ...previous.interaction, state: 'expired' }, teamRequestId(previous.interaction))
    }
    if (question && (question.id !== previous?.interaction.id || question.revision !== previous.interaction.revision)) {
      this.setStatus(session, 'awaiting-approval')
      this.persist()
      this.recordTeamQuestion(sessionId, question)
    } else if (previous && !question && session.status === 'awaiting-approval' &&
      !this.streamers.get(sessionId)?.hasPendingRequests() && !this.runners.get(sessionId)?.hasPendingRequests()) {
      this.setStatus(session, previous.resumeStatus)
      if (interactions.find(interaction => interaction.id === previous.interaction.id)?.state === 'answered' &&
        ['idle', 'completed', 'queued'].includes(previous.resumeStatus) && this.queues.get(sessionId)?.length &&
        !this.activeQueueItems.has(sessionId) && !this.editingQueueItems.has(sessionId) && !session.archived && !session.readOnly) {
        const dispatchToken = Symbol(sessionId)
        this.deferredDispatches.set(sessionId, dispatchToken)
        this.setStatus(session, 'queued')
        setImmediate(() => {
          if (this.sessions.get(sessionId) === session) this.dispatchPendingQueue(session, dispatchToken)
        })
      }
    }
  }

  private recordTeamQuestion(sessionId: string, interaction: TeamInteraction, requestId = teamRequestId(interaction)): void {
    const events = this.events.get(sessionId)
    const index = events?.findLastIndex(event => event.type === 'approval_request' && event.payload.teamInteractionId === interaction.id) ?? -1
    const original = index >= 0 ? events![index] : undefined
    const state = interaction.state === 'pending' ? 'pending' : interaction.state === 'answered' ? 'success' : 'cancelled'
    const payload = {
      id: `team-question:${interaction.id}`, requestId: original?.payload.requestId || requestId,
      kind: 'question', method: 'team/askUser', params: teamQuestionParams(interaction), delivery: 'blocking',
      teamQuestion: true, teamInteractionId: interaction.id, teamRevision: interaction.revision, submittedAnswer: interaction.answer
    }
    if (!original) {
      if (!events?.length && this.sessions.get(sessionId)?.nativeSessionId && !this.streamers.has(sessionId) && !this.runners.has(sessionId)) {
        this.logEvent({ sessionId, seq: 0, ts: interaction.createdAt, type: 'approval_request', state, payload })
      } else this.record(sessionId, { type: 'approval_request', state, payload })
      return
    }
    const event: UAEvent = { ...original, state, payload }
    events![index] = event
    this.logEvent(event)
    this.bumpSessionActivity(sessionId)
    this.emit('event', event)
  }

  async sendTeamMessage(sessionId: string, prompt: string, attachments?: Attachment[], displayText?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.teamBinding) throw new Error('not_team_session')
    const agent = this.getAgent(session.config.agentId)
    if (attachments?.length && (!agent || !agentSupportsAttachments(agent))) throw new Error('team_attachments_unsupported')
    const input = teamRuntime(sessionId)?.leader && this.feishuTeamInputs.has(sessionId) ? appendFeishuContext(prompt) : prompt
    await this.sendMessage(sessionId, input, attachments, undefined, false, { source: 'mcp', displayText }, false, TEAM_EXECUTION)
  }

  async steerTeamMessage(sessionId: string, prompt: string, attachments?: Attachment[], target?: { expectedTurnId: string; messageId: string; assignmentId: string; attempt: number }): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.teamBinding || session.status !== 'running') throw Object.assign(new Error('team_turn_not_running'), { deliveryState: 'failed' })
    const agent = this.getAgent(session.config.agentId)
    try {
      assertAgentSupportsSteer(agent ? agentForSession(agent, session) : undefined)
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryState: 'failed' })
    }
    const claudeRunner = this.runners.get(sessionId)
    const streamer = this.streamers.get(sessionId)
    const protocol = this.protocolRunners.get(sessionId)
    if (!streamer && !claudeRunner && !protocol) throw Object.assign(new Error('team_direct_message_unsupported'), { deliveryState: 'failed' })
    if (claudeRunner) await claudeRunner.steer(prompt, attachments)
    else if (protocol) await protocol.steer(prompt, attachments)
    else await streamer!.steerStrict(prompt, attachments, undefined, target?.expectedTurnId)
    this.record(sessionId, { type: 'system_notice', payload: { kind: 'team_event', text: prompt, source: 'team_event', ...(attachments?.length ? { attachments } : {}), ...(target ? { teamCommunicationId: target.messageId, assignmentId: target.assignmentId, attempt: target.attempt } : {}) } })
  }

  createSession(
    config: SessionConfig,
    prompt: string,
    attachments?: Attachment[],
    meta?: { handoffId?: string; handoffWaiting?: boolean },
    nativeContext?: ResolvedNativeTurnContext,
    command?: ComposerCommand,
    bubble?: TurnBubble,
    reservedSessionId?: string
  ): Session {
    const acceptedInput = snapshotTurnInput(attachments, nativeContext)
    this.assertAgentCanRun(config.agentId)
    const agent = this.getAgent(config.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${config.agentId}`)
    if (attachments?.length && !agentSupportsAttachments(agent)) {
      throw new Error(ATTACHMENT_UNSUPPORTED_MESSAGE)
    }
    const reserved = reservedSessionId ? this.sessions.get(reservedSessionId) : undefined
    if (reservedSessionId && (!reserved?.config.worktree || reserved.status !== 'draft')) throw new Error('工作树创建草稿不可用')
    const { session, maxDisabled } = reserved ? { session: reserved, maxDisabled: false } : this.createSessionRecord(config, prompt, meta)
    let preparedRun: PreparedAgentRun | undefined
    let roleSessionCommitted = !!session.config.worktree
    try {
      preparedRun = this.prepareUserMessageRun(session, prompt, acceptedInput)
      if (session.config.roleSnapshot || session.config.assistantSnapshot) {
        try {
          this.persistOrThrow()
          roleSessionCommitted = true
        } catch (error) {
          if (!sessionStoreWriteCommitted(error)) throw error
          roleSessionCommitted = true
        }
      }
      this.recordUserMessageAndRun(
        session, prompt, preparedRun, command,
        bubble ?? (meta?.handoffId ? { source: 'mcp' } : undefined)
      )
      if (maxDisabled) {
        this.record(session.id, {
          type: 'system_notice',
          payload: { kind: 'warning', text: `所选模型 ${config.model || ''} 不支持 TraeX Max，已自动关闭 Max 模式。` }
        })
      }
      this.persist()
      return session
    } catch (error) {
      if (roleSessionCommitted) {
        if (preparedRun && session.status === 'draft') this.discardPreparedRun(session, preparedRun)
      } else {
        this.discardUnstartedSession(session)
      }
      throw error
    }
  }

  reserveWorktreeSession(config: SessionConfig, title: string, task?: Session['worktreeTask']): Session {
    if (config.worktree?.state !== 'creating') throw new Error('无效的工作树创建草稿')
    const { session } = this.createSessionRecord(config, title)
    session.worktreeTask = task && structuredClone(task)
    session.updatedAt = Math.max(Date.now(), (session.updatedAt || session.createdAt) + 1)
    this.persistOrThrow()
    this.emit('sessionUpdated', { session, hasLiveStreamer: false })
    return session
  }

  updateWorktreeTask(sessionId: string, task?: Session['worktreeTask'], error?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    session.worktreeTask = task && structuredClone(task)
    session.worktreeTaskError = error
    session.updatedAt = Math.max(Date.now(), (session.updatedAt || session.createdAt) + 1)
    this.persistOrThrow()
    this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(sessionId) })
  }

  worktreeSessionBusy(session: Session): boolean {
    const id = session.id
    return this.isBusy(session.status) || !!session.worktreeTask || this.teamDeliveryBlocked(id) ||
      (!!this.sideStatus.get(id) && this.sideStatus.get(id) !== 'idle') || !!this.sideQueues.get(id)?.length || this.detailStatus.get(id) === 'running' ||
      this.protocolPendingStarts.has(id) || this.deferredDispatches.has(id)
  }

  async assertWorktreeSessionsIdle(sessions: Session[]): Promise<void> {
    for (const session of sessions) {
      if (this.worktreeSessionBusy(session)) throw new Error('工作树仍有运行或待执行任务，请先结束任务')
      await this.assertSessionNotExternallyOccupied(session)
      if (this.worktreeSessionBusy(session)) throw new Error('工作树仍有运行或待执行任务，请先结束任务')
    }
  }

  async returnWorktreeSessions(sessions: Session[], resolve: (session: Session) => SessionConfig, notice: string, remove: () => Promise<void>): Promise<void> {
    const replacements = sessions.map(session => ({ session, config: { ...resolve(session), workspaceNotice: notice },
      previousConfig: session.config, previousSide: this.sideConfigs.get(session.id), updatedAt: session.updatedAt }))
    for (const { session } of replacements) this.worktreeTransitions.add(session.id)
    try {
      for (const { session, config, previousSide } of replacements) {
        this.disposeSession(session.id, true)
        this.replaceSessionConfig(session, config)
        if (previousSide) this.sideConfigs.set(session.id, { ...previousSide, worktree: undefined, workspaceNotice: notice, projectId: config.projectId, workdir: config.workdir, additionalDirectories: config.additionalDirectories })
        session.updatedAt = Date.now()
      }
      // Persist the replacement cwd before removing its old directory.
      this.persistOrThrow()
      this.persistSideChats()
      await Promise.all(replacements.flatMap(({ session }) => [this.zcodeDisposals.get(session.id), this.zcodeSideDisposals.get(session.id)]))
      await remove()
    } catch (error) {
      for (const { session, previousConfig, previousSide, updatedAt } of replacements) {
        this.replaceSessionConfig(session, previousConfig)
        if (previousSide) this.sideConfigs.set(session.id, previousSide)
        session.updatedAt = updatedAt
      }
      this.persistOrThrow()
      this.persistSideChats()
      throw error
    } finally {
      for (const { session } of replacements) {
        this.worktreeTransitions.delete(session.id)
        this.emit('sessionUpdated', { session, hasLiveStreamer: false })
      }
    }
  }

  readonly assistantCommandSessions = new Set<string>()

  lockAssistantCommand(sessionId: string): void {
    if (this.assistantCommandSessions.has(sessionId) || this.pendingSends.has(sessionId) || this.rewinding.has(sessionId) || this.nativeActionReservations.has(sessionId)) throw new Error('assistant_session_busy')
    this.assistantCommandSessions.add(sessionId)
  }

  appendSystemNotice(sessionId: string, text: string, kind: 'warning' | 'notice' | 'assistant_management_result' | 'app_restart' = 'warning'): void {
    if (this.sessions.has(sessionId)) this.record(sessionId, { type: 'system_notice', payload: { kind, text } })
  }

  createAssistantDraft(config: SessionConfig, previousSessionId?: string, command: 'new' | 'clear' = 'new'): Session {
    const previous = previousSessionId ? this.sessions.get(previousSessionId) : undefined
    if (previousSessionId && (!previous || isSessionBusy(previous.status))) throw new Error('assistant_session_busy')
    if (!config.assistantSnapshot) throw new Error('assistant_session_required')
    const { session } = this.createSessionRecord(config, '新会话')
    if (!previous) {
      try { this.persistOrThrow() } catch (error) { if (!sessionStoreWriteCommitted(error)) this.discardUnstartedSession(session); throw error }
      this.emit('sessionUpdated', { session, hasLiveStreamer: false })
      return session
    }
    const archived = previous.archived, reason = previous.assistantEndReason
    session.previousSessionId = previousSessionId
    previous.assistantEndReason = command
    if (command === 'clear') previous.archived = true
    try { this.persistOrThrow() } catch (error) {
      if (!sessionStoreWriteCommitted(error)) { previous.archived = archived; previous.assistantEndReason = reason; this.discardUnstartedSession(session); throw error }
    }
    this.cancelManagementConfirmations(previous.id)
    this.emit('sessionUpdated', { session: previous, hasLiveStreamer: false })
    this.emit('sessionUpdated', { session, hasLiveStreamer: false })
    return session
  }

  updateWorktreeCreation(sessionId: string, worktree: NonNullable<SessionConfig['worktree']>, config?: SessionConfig): void {
    const session = this.sessions.get(sessionId)
    if (!session || !['draft', 'idle'].includes(session.status) || session.nativeSessionId || session.config.worktree?.id !== worktree.id) throw new Error('工作树创建草稿已变化')
    if (config && (config.agentId !== session.config.agentId || config.projectId !== session.config.projectId)) throw new Error('工作树创建配置不一致')
    this.replaceSessionConfig(session, { ...(config || session.config), worktree: { ...worktree }, workdir: worktree.workdir })
    session.updatedAt = Math.max(Date.now(), (session.updatedAt || session.createdAt) + 1)
    this.persistOrThrow()
    this.emit('sessionUpdated', { session, hasLiveStreamer: false })
  }

  private createSessionRecord(
    config: SessionConfig,
    title: string,
    meta?: { handoffId?: string; handoffWaiting?: boolean },
    teamBinding?: Session['teamBinding'],
    assignedId?: string
  ): { session: Session; maxDisabled: boolean } {
    const projectConfig = this.resolveProjectConfig ? this.resolveProjectConfig(config, true) : config
    this.assertAgentCanRun(projectConfig.agentId)
    const agent = this.getAgent(projectConfig.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${config.agentId}`)
    requirePlanCollaborationTransport(agent, projectConfig)
    const permissionMode = resolveCreatePermissionMode(agent, projectConfig.permissionMode)
    let normalizedConfig: SessionConfig = {
      ...projectConfig,
      ...(permissionMode ? { permissionMode } : {})
    }
    if (!permissionMode) delete normalizedConfig.permissionMode
    const normalized = this.normalizeAgentConfig(normalizedConfig)
    normalizedConfig = normalized.config
    { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, normalizedConfig) }
    const id = assignedId || 's_' + nanoid(10)
    if (this.sessions.has(id)) throw new Error('session_id_conflict')
    const session: Session = {
      id,
      // 需求3: strip skill/MCP mention markup so the title reflects the actual
      // first line, not the "@capcode …" wire prefix.
      title: deriveSessionTitle(title) || '新会话',
      config: normalizedConfig,
      status: 'draft',
      createdAt: Date.now(),
      origin: 'created',
      ...(teamBinding ? { teamBinding: { ...teamBinding }, titleLocked: true } : {}),
      // 需求5 — carry handoff lineage so the終態 result回传 + 等待中 UI can find it.
      ...(meta?.handoffId ? { handoffId: meta.handoffId } : {}),
      ...(meta?.handoffWaiting ? { handoffWaiting: true } : {})
    }
    this.installSessionOwner(session)
    this.events.set(id, [])
    this.seqRefs.set(id, { n: 0 })
    this.queues.set(id, [])
    this.logSession(id, 'session_created', {
      agentId: normalizedConfig.agentId,
      adapter: agent.adapter,
      projectId: normalizedConfig.projectId,
      workdir: normalizedConfig.workdir,
      status: session.status
    })
    if (!normalizedConfig.roleSnapshot && !normalizedConfig.assistantSnapshot) this.persist()
    this.emit('sessionCreated', session)
    return { session, maxDisabled: normalized.disabled }
  }

  /**
   * Enqueue or dispatch a message. In MVP this rejected while running; now the
   * message is appended to the FIFO queue and drained when the turn ends.
   */
  async sendMessage(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    activatePlan = false,
    bubble?: TurnBubble,
    queueIfBusy = true,
    teamExecution?: symbol
  ): Promise<void> {
    if (this.isTeamMember(sessionId) && teamExecution !== TEAM_EXECUTION) throw new Error('team_session_requires_project_route')
    if (this.teamQuestions.has(sessionId)) throw new Error('team_awaiting_user_answer')
    if (this.assistantCommandSessions.has(sessionId)) throw new Error('assistant_session_busy')
    const teamStopVersion = this.teamStopVersions.get(sessionId) || 0
    if (bubble?.source !== 'mcp') this.assertUserSessionEnabled(sessionId)
    const acceptedInput = snapshotTurnInput(attachments, nativeContext)
    if (activatePlan) {
      await this.sendMessageWithPlan(sessionId, prompt, acceptedInput, bubble)
      return
    }
    if (this.nativeActionReservations.has(sessionId)) throw new Error('native_action_in_progress')
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (this.resolveProjectConfig) {
      this.replaceSessionConfig(session, this.resolveProjectConfig(session.config, true))
    }
    if (this.rewinding.has(sessionId)) throw new Error('rewind_in_progress')
    this.assertAgentCanRun(session.config.agentId)
    const agent = this.getAgent(session.config.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${session.config.agentId}`)
    { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, session.config) }
    requirePlanCollaborationTransport(agent, session.config)
    if (attachments?.length && !agentSupportsAttachments(agent)) {
      this.record(sessionId, {
        type: 'system_notice',
        payload: { kind: 'warning', text: ATTACHMENT_UNSUPPORTED_MESSAGE }
      })
      return
    }
    // 需求5 — a read-only imported snapshot must never be resumed in place; the
    // renderer replaces the composer with a 分叉 bar, but guard here too so an
    // errant send can't `thread/resume` the original rollout another writer owns.
    if (session.readOnly) {
      this.record(sessionId, {
        type: 'system_notice',
        payload: {
          kind: 'warning',
          text: '这是只读的导入快照，请先选择「原 Agent 分叉」「原生 Agent 直接导入」或「换 Agent 分叉」再继续对话。'
        }
      })
      return
    }
    if (agent.adapter === 'claude' &&
        (prompt.trim() === '/context' || prompt.trim() === '/usage') && !attachments?.length && !nativeContext && !activatePlan) {
      await this.queryClaudeReport(session, prompt.trim() as '/context' | '/usage')
      return
    }
    if (agent.adapter === 'grok' && acceptedInput.attachments?.some(item => item.kind === 'image')) {
      acceptedInput.attachments = await prepareGrokAttachments(acceptedInput.attachments)
      if (this.sessions.get(sessionId) !== session || this.rewinding.has(sessionId) || session.readOnly || this.nativeActionReservations.has(sessionId)) throw new Error('图片准备期间会话已变化，请重试')
    }
    if (teamExecution !== TEAM_EXECUTION) teamRuntime(sessionId)?.beforeUserTurn?.()
    if (this.isBusy(session.status)) {
      if (!queueIfBusy) throw new Error(`session_not_idle: ${session.status}`)
      this.enqueueDuringTurn(
        session,
        prompt,
        acceptedInput.attachments,
        acceptedInput.nativeContext,
        bubble
      )
      return
    }

    // Accepting a send is activity immediately, before its history/config
    // barriers yield. A concurrently finishing import must not refresh beneath
    // an accepted turn merely because no event/status mutation has landed yet.
    this.bumpSessionActivity(sessionId)
    this.pendingSends.set(sessionId, (this.pendingSends.get(sessionId) || 0) + 1)
    const previous = this.sendTails.get(sessionId) || Promise.resolve()
    const operation = previous.then(async () => {
      const owner = this.sessions.get(sessionId)
      if (!owner) return
      if (owner.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      const token = Symbol(sessionId)
      this.recoveryStartTokens.set(sessionId, token)
      // A restored transcript must finish and close its session/load connection
      // before a live runner may resume the same native session identity.
      await this.getEvents(sessionId)
      if (
        this.recoveryStartTokens.get(sessionId) !== token ||
        this.sessions.get(sessionId) !== owner ||
        this.rewinding.has(sessionId)
      ) return
      this.recoveryStartTokens.delete(sessionId)
      if (this.nativeActionReservations.has(sessionId)) {
        throw new Error('native_action_in_progress')
      }
      if (owner.readOnly) {
        this.record(sessionId, {
          type: 'system_notice',
          payload: {
            kind: 'warning',
            text: '这是只读的导入快照，请先选择「原 Agent 分叉」「原生 Agent 直接导入」或「换 Agent 分叉」再继续对话。'
          }
        })
        return
      }
      if (this.isBusy(owner.status)) {
        if (!queueIfBusy) throw new Error(`session_not_idle: ${owner.status}`)
        this.enqueueDuringTurn(
          owner,
          prompt,
          acceptedInput.attachments,
          acceptedInput.nativeContext,
          bubble
        )
        return
      }
      await this.assertSessionNotExternallyOccupied(owner)
      if (this.sessions.get(sessionId) !== owner || this.isBusy(owner.status)) return
      if (owner.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      const preparedRun = this.prepareUserMessageRun(owner, prompt, acceptedInput)
      this.recordUserMessageAndRun(owner, prompt, preparedRun, undefined, bubble)
    })
    const tracked = operation.finally(() => {
      const remaining = (this.pendingSends.get(sessionId) || 1) - 1
      if (remaining > 0) this.pendingSends.set(sessionId, remaining)
      else this.pendingSends.delete(sessionId)
    })
    this.sendTails.set(
      sessionId,
      tracked.then(
        () => undefined,
        () => undefined
      )
    )
    await tracked
  }

  /** Reassign every session that references a deleted project and persist once. */
  reassignProject(projectId: string, replacement: SessionConfig): number {
    let changed = 0
    const updated: Session[] = []
    for (const session of this.sessions.values()) {
      if (session.teamBinding || session.config.worktree || session.config.projectId !== projectId) continue
      this.replaceSessionConfig(session, {
        ...session.config,
        projectId: replacement.projectId,
        workdir: replacement.workdir,
        additionalDirectories: [...(replacement.additionalDirectories || [])]
      })
      updated.push(session)
      changed += 1
    }
    if (changed) {
      this.persist()
      for (const session of updated) {
        this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
      }
    }
    return changed
  }

  private async queryClaudeReport(session: Session, command: '/context' | '/usage'): Promise<void> {
    if (session.config.modelSource?.kind === 'third-party' || (session.config.model && parseCodexModelKey(session.config.model))) {
      throw new Error('第三方模型的上下文上限与账单请以厂商为准；会话 Token 用量可在用量卡片查看')
    }
    if (this.rewinding.has(session.id) || this.pendingSends.has(session.id)) throw new Error('session_transition_in_progress')
    if (session.pendingClaudeFork) throw new Error('请先完成原生分叉，再查询该分支的用量')
    const agent = this.getAgent(session.config.agentId)
    if (!agent || agent.adapter !== 'claude') throw new Error('Claude 原生报告需要 Claude 会话')
    const nativeId = session.nativeSessionId
    const live = this.claudeSdkRunners.get(session.id)
    const runner = this.runners.get(session.id) || (live?.hasClaudeSdkConnection() ? live : undefined)
    if (this.isBusy(session.status) && !runner) throw new Error('Claude 当前控制通道尚未就绪')
    this.nativeActionReservations.add(session.id)
    try {
      const report = runner
        ? command === '/context' ? await runner.getClaudeContextUsage() : await runner.getClaudeUsage()
        : await new NativeCapabilityService().queryClaudeUsage(agent, session.config.workdir, nativeId)
          .then((value) => command === '/context' ? value.contextUsage : value.usageReport)
      if (this.sessions.get(session.id) !== session || (nativeId && session.nativeSessionId !== nativeId)) return
      await this.getEvents(session.id)
      if (this.sessions.get(session.id) !== session) return
      const kind = command === '/context' ? 'context_usage' : 'usage_report'
      this.record(session.id, { type: 'system_notice', payload: {
        kind, ...(kind === 'context_usage' ? { contextUsage: report } : { usageReport: report })
      } })
      if (kind === 'context_usage') {
        const occupancy = claudeContextOccupancy(report)
        if (occupancy) this.record(session.id, { type: 'system_notice', payload: { kind: 'context', usage: occupancy } })
      }
    } finally {
      this.nativeActionReservations.delete(session.id)
    }
  }

  private async sendMessageWithPlan(
    sessionId: string,
    prompt: string,
    acceptedInput: TurnInputSnapshot,
    bubble?: TurnBubble
  ): Promise<void> {
    const teamStopVersion = this.teamStopVersions.get(sessionId) || 0
    const session = this.sessions.get(sessionId)
    const agent = session ? this.getAgent(session.config.agentId) : undefined
    if (agent?.adapter === 'grok' || agent?.adapter === 'kimi' || agent?.adapter === 'zcode') {
      await this.setCollaborationMode(sessionId, 'plan')
      if (session?.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      await this.sendMessage(
        sessionId,
        prompt,
        acceptedInput.attachments,
        acceptedInput.nativeContext,
        false,
        bubble
      )
      return
    }
    await this.withNativeActionReservation(sessionId, async (owner) => {
      if (this.resolveProjectConfig) {
        this.replaceSessionConfig(owner, this.resolveProjectConfig(owner.config, true))
      }
      this.assertAgentCanRun(owner.config.agentId)
      const agent = this.getAgent(owner.config.agentId)
      if (!agent) throw new Error(`未找到 Agent: ${owner.config.agentId}`)
      if (acceptedInput.attachments?.length && !agentSupportsAttachments(agent)) {
        throw new Error(ATTACHMENT_UNSUPPORTED_MESSAGE)
      }
      this.bumpSessionActivity(sessionId)
      const token = Symbol(sessionId)
      this.recoveryStartTokens.set(sessionId, token)
      try {
        await this.getEvents(sessionId)
        if (
          this.recoveryStartTokens.get(sessionId) !== token ||
          this.sessions.get(sessionId) !== owner ||
          this.rewinding.has(sessionId)
        ) return
      } finally {
        if (this.recoveryStartTokens.get(sessionId) === token) {
          this.recoveryStartTokens.delete(sessionId)
        }
      }
      if (!this.isReady(owner.status) || (this.queues.get(sessionId)?.length ?? 0) > 0) {
        throw new Error('Plan 命令只能在空闲且无排队消息的会话中使用')
      }
      if (owner.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      teamRuntime(sessionId)?.beforeUserTurn?.()
      const runner = this.ensureStreamerForNativeAction(owner)
      await runner.setCollaborationMode('plan')
      if (owner.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      owner.config = { ...owner.config, collaborationMode: 'plan' }
      owner.updatedAt = Date.now()
      runner.updateConfig(owner.config)
      this.persist()
      this.emit('sessionUpdated', { session: owner, hasLiveStreamer: true })
      const preparedRun = this.prepareUserMessageRun(owner, prompt, acceptedInput)
      this.recordUserMessageAndRun(owner, prompt, preparedRun, 'plan', bubble)
    })
  }

  /** Force-send: steer into the running turn; callers may disable all queue fallbacks. */
  async forceSend(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    bubble?: TurnBubble,
    queueIfBusy = true
  ): Promise<void> {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    if (this.teamQuestions.has(sessionId)) throw new Error('team_awaiting_user_answer')
    if (this.assistantCommandSessions.has(sessionId)) throw new Error('assistant_session_busy')
    if (bubble?.source !== 'mcp') this.assertUserSessionEnabled(sessionId)
    const acceptedInput = snapshotTurnInput(attachments, nativeContext)
    if (this.nativeActionReservations.has(sessionId)) throw new Error('native_action_in_progress')
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (this.isBusy(session.status)) {
      const agent = this.getAgent(session.config.agentId)
      assertAgentSupportsSteer(agent ? agentForSession(agent, session) : undefined)
    }
    if (this.rewinding.has(sessionId)) {
      if (!queueIfBusy) throw new Error('rewind_in_progress')
      return
    }
    if (!queueIfBusy && session.status === 'cancelling') throw new Error(`session_not_idle: ${session.status}`)
    teamRuntime(sessionId)?.beforeUserTurn?.()
    const claudeRunner = this.runners.get(sessionId)
    if (claudeRunner && this.isBusy(session.status)) {
      await claudeRunner.steer(prompt, acceptedInput.attachments)
      this.record(sessionId, { type: 'user_message', payload: { text: prompt, ...acceptedInput, ...bubblePayload(bubble), appendedToTurn: true } })
      return
    }
    const protocol = this.protocolRunners.get(sessionId)
    if (protocol && this.isBusy(session.status)) {
      const receipt = await protocol.steer(prompt, acceptedInput.attachments)
      this.record(sessionId, { type: 'user_message', payload: { text: prompt, ...acceptedInput, ...bubblePayload(bubble),
        appendedToTurn: receipt?.appendedToTurn ?? true, ...(receipt?.nativePromptId ? { nativePromptId: receipt.nativePromptId } : {}) } })
      return
    }
    const streamer = this.streamers.get(sessionId)
    if (streamer && this.isBusy(session.status)) {
      const preparedRun = this.prepareUserMessageRun(session, prompt, acceptedInput)
      const auditInput = snapshotTurnInput(
        preparedRun.input.attachments,
        preparedRun.input.nativeContext
      )
      if (!queueIfBusy) {
        await (preparedRun.streamer || streamer).steerStrict(prompt, preparedRun.input.attachments, preparedRun.input.nativeContext)
      }
      this.record(sessionId, { type: 'user_message', payload: { text: prompt, ...auditInput, ...bubblePayload(bubble), appendedToTurn: true } })
      if (!queueIfBusy) return
      await (preparedRun.streamer || streamer).steer(
        prompt,
        preparedRun.input.attachments,
        preparedRun.input.nativeContext
      )
      return
    }
    // Idle sessions start normally; busy sessions respect the caller's queue policy.
    await this.sendMessage(
      sessionId,
      prompt,
      acceptedInput.attachments,
      acceptedInput.nativeContext,
      false,
      bubble,
      queueIfBusy
    )
  }

  /**
   * MCP-only strict force-send. It succeeds only after the active provider turn
   * acknowledges turn/steer, and it never falls back to sendMessage/the queue.
   */
  async forceSendStrict(sessionId: string, prompt: string): Promise<void> {
    if (this.sessions.get(sessionId)?.teamBinding) throw new Error('team_session_requires_project_route')
    if (this.nativeActionReservations.has(sessionId)) throw new Error('native_action_in_progress')
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('force_send_session_not_found')
    const agent = this.getAgent(session.config.agentId)
    assertAgentSupportsSteer(agent ? agentForSession(agent, session) : undefined)
    if (this.rewinding.has(sessionId)) throw new Error('rewind_in_progress')
    if (session.status !== 'running') throw new Error(`force_send_requires_running_task: ${session.status}`)
    const claudeRunner = this.runners.get(sessionId)
    if (claudeRunner) {
      await claudeRunner.steer(prompt)
      this.record(sessionId, { type: 'user_message', payload: { text: prompt, source: 'mcp', appendedToTurn: true } })
      return
    }
    const streamer = this.streamers.get(sessionId)
    if (!streamer) throw new Error('force_send_provider_does_not_support_steer')
    await streamer.steerStrict(prompt)
    this.record(sessionId, { type: 'user_message', payload: { text: prompt, source: 'mcp', appendedToTurn: true } })
  }

  /** Remove a queued item by id (Doc4 需求2 — 可删除). */
  dequeue(sessionId: string, itemId: string): void {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const q = this.queues.get(sessionId)
    if (!q) return
    const idx = q.findIndex((i) => i.id === itemId)
    if (idx < 0) return
    const item = q[idx]
    // Only untouched outbox entries are user-editable. State and ownership are
    // intentionally checked independently so a future state regression cannot
    // delete an item whose provider delivery is already in flight.
    if (item.state !== 'pending' || this.activeQueueItems.get(sessionId) === item.id) return
    const next = q.filter((entry) => entry.id !== itemId)
    const session = this.sessions.get(sessionId)
    if (!session) return
    const wasEditing = this.editingQueueItems.get(sessionId) === itemId
    this.commitQueue(session, next)
    this.emitQueue(sessionId)
    if (wasEditing) this.setQueueEditing(sessionId, null)
    if (next.length === 0 && session.status === 'queued') {
      this.setStatus(session, 'running')
    }
  }

  /**
   * 需求（队列二次编辑）— replace a still-pending queued item's prompt/attachments
   * in place. The renderer pulls the item into the composer, lets the user re-edit
   * it (text + images), then saves it back. We update atomically so a crash can
   * only ever leave the original or the edited item, never a lost/duplicated one.
   */
  editQueueItem(
    sessionId: string,
    itemId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    bubble?: TurnBubble
  ): void {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const q = this.queues.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!q || !session) return
    const item = q.find((entry) => entry.id === itemId)
    // Only untouched outbox entries are editable — a dispatching/steering entry
    // already has a delivery owner and must never be mutated underneath it.
    if (!item || item.state !== 'pending' || this.activeQueueItems.get(sessionId) === itemId) return
    const zcodeReceipt = session.zcodeState?.deliveries.filter(record => record.queueItemId === itemId).at(-1)
    if (session.config.agentId === 'zcode' && zcodeReceipt && zcodeReceipt.phase !== 'failed') {
      throw new Error('该 ZCode 输入已冻结，请先核对原生会话，不能通过编辑自动重发')
    }
    if (item.source === 'feishu') prompt = splitFeishuContext(prompt)?.text ?? prompt
    if (item.source === 'weixin') prompt = splitWeixinContext(prompt)?.text ?? prompt
    const input = snapshotTurnInput(attachments, nativeContext)
    const next = q.map((entry) =>
      entry.id === itemId
        ? {
            ...entry,
            prompt,
            deliveryUncertain: undefined,
            source: 'app' as const,
            attachments: input.attachments,
            nativeContext: input.nativeContext,
            ...bubblePayload(bubble),
            // Editing drops any stale bubble decorations the new payload omits.
            ...(bubble?.comments?.length ? {} : { comments: undefined }),
            ...(bubble?.displayText ? {} : { displayText: undefined })
          }
        : entry
    )
    const priorRetryRequested = zcodeReceipt?.retryRequested
    if (session.config.agentId === 'zcode' && zcodeReceipt?.phase === 'failed') zcodeReceipt.retryRequested = true
    try { this.commitQueue(session, next) } catch (error) {
      if (zcodeReceipt && !sessionStoreWriteCommitted(error)) zcodeReceipt.retryRequested = priorRetryRequested
      throw error
    }
    this.emitQueue(sessionId)
  }

  /**
   * 需求（队列二次编辑）— freeze/unfreeze the whole FIFO queue while the renderer
   * rewrites one of its still-pending items. Dispatch is head-only, so holding the
   * session lock keeps the edited item AND everything behind it from being sent
   * until the edit is saved or cancelled. Passing `null` releases the lock and
   * resumes the queue when no live turn already owns it.
   */
  setQueueEditing(sessionId: string, itemId: string | null): void {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (itemId) {
      const queue = this.queues.get(sessionId) || []
      // Only lock on an item that is still an editable outbox entry; ignore a
      // stale id whose turn already began dispatching.
      if (!queue.some((entry) => entry.id === itemId && entry.state === 'pending')) return
      this.editingQueueItems.set(sessionId, itemId)
      // Invalidate any between-turn drain already scheduled so it can't fire mid-edit.
      const pausedBetweenTurns = this.deferredDispatches.delete(sessionId)
      // The queue is just pending messages. Freezing dispatch means nothing is
      // (or is about to be) running, so a session merely waiting to auto-drain
      // ('queued', which drives the sidebar spinner) must rest at idle/completed
      // for the duration of the edit. A truly live turn keeps its own status.
      if (session.status === 'queued' && pausedBetweenTurns) {
        const restStatus = session.goal?.status === 'complete' && this.currentTurnIsGoal(session)
          ? 'completed'
          : 'idle'
        this.setStatus(session, restStatus)
        this.emitQueue(sessionId)
      }
      return
    }
    if (!this.editingQueueItems.delete(sessionId)) return
    if (session.config.agentId === 'zcode' && session.zcodeState) session.zcodeState.suspendedAfterStop = false
    // Editing finished: resume the frozen queue only if no live turn owns it now.
    if (
      this.activeQueueItems.has(sessionId) ||
      session.status === 'running' ||
      session.status === 'queued' ||
      session.status === 'awaiting-approval' ||
      session.status === 'cancelling' ||
      session.archived ||
      session.readOnly ||
      (this.queues.get(sessionId)?.length ?? 0) === 0
    ) return
    this.setStatus(session, 'queued')
    const dispatchToken = Symbol(sessionId)
    this.deferredDispatches.set(sessionId, dispatchToken)
    this.emitQueue(sessionId)
    setImmediate(() => {
      if (this.deferredDispatches.get(sessionId) !== dispatchToken) return
      if (!this.sessions.has(sessionId)) return
      this.dispatchPendingQueue(session, dispatchToken)
    })
  }
  promoteQueueItem(sessionId: string, itemId: string): void {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    if (this.teamQuestions.has(sessionId)) throw new Error('team_awaiting_user_answer')
    const q = this.queues.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!q || !session) return
    const idx = q.findIndex((i) => i.id === itemId)
    if (idx < 0) return
    const item = q[idx]
    const deliveryInput = snapshotTurnInput(item.attachments, item.nativeContext)
    // A dispatching/steering entry already has a delivery owner. Never create
    // a second provider request for it, even if a stale renderer still offers
    // the action or a future bug accidentally restores its pending state.
    if (item.state !== 'pending' || this.activeQueueItems.get(sessionId) === item.id) return
    const protocol = this.protocolRunners.get(sessionId)
    if (protocol && this.isBusy(session.status)) {
      const agent = this.getAgent(session.config.agentId)
      if (!agent || agentForSession(agent, session).capabilities.steer !== true || deliveryInput.nativeContext || item.deliveryUncertain) return
      this.commitQueue(session, q.map(entry => entry.id === item.id
        ? { ...entry, state: 'steering' as const, attempts: entry.attempts + 1 } : entry))
      this.emitQueue(sessionId)
      let acknowledged = false
      void protocol.steer(item.prompt, deliveryInput.attachments).then(receipt => {
        if (this.sessions.get(sessionId) !== session || this.protocolRunners.get(sessionId) !== protocol) return
        acknowledged = true
        this.record(sessionId, { type: 'user_message', payload: { text: item.prompt, ...deliveryInput, ...queueItemBubblePayload(item),
          appendedToTurn: receipt?.appendedToTurn ?? true, ...(receipt?.nativePromptId ? { nativePromptId: receipt.nativePromptId } : {}) } })
        this.removeDeliveredQueueItem(session, item.id)
        if (receipt?.appendedToTurn !== false && !protocol.isRunning() && this.isReady(session.status) && !this.activeQueueItems.has(sessionId)) this.afterTurn(session)
      }).catch((error: unknown) => {
        if (this.sessions.get(sessionId) !== session || this.protocolRunners.get(sessionId) !== protocol) return
        const uncertain = acknowledged || error instanceof ACPTimeoutError || /ACP.*(?:协议|关闭|退出|超时)|connection.*(?:closed|timeout)|kimi_web_(?:connection|request_aborted)/i.test(String(error))
        this.commitQueue(session, (this.queues.get(sessionId) || []).map(entry => entry.id === item.id
          ? { ...entry, state: 'pending', ...(uncertain ? { deliveryUncertain: true } : {}) } : entry))
        this.emitQueue(sessionId)
        this.record(sessionId, { type: 'system_notice', payload: { kind: 'warning', text: uncertain
          ? '引导消息的送达状态未确认，已保留队列；请核对原生回复后再重试。'
          : `引导消息未获 Agent 接收，已保留队列：${String(error)}` } })
      })
      return
    }
    const streamer = this.streamers.get(sessionId) || this.runners.get(sessionId)
    if (!streamer || !this.isBusy(session.status)) return // no live turn to steer
    const steering = q.map((entry) =>
      entry.id === item.id ? { ...entry, state: 'steering' as const, attempts: entry.attempts + 1 } : entry
    )
    this.commitQueue(session, steering)
    this.emitQueue(sessionId)
    const auditInput = snapshotTurnInput(
      deliveryInput.attachments,
      deliveryInput.nativeContext
    )
    this.record(sessionId, { type: 'user_message', payload: { text: item.prompt, ...auditInput, ...queueItemBubblePayload(item), appendedToTurn: true } })
    void streamer.steer(
      item.prompt,
      deliveryInput.attachments,
      deliveryInput.nativeContext
    ).then(() => {
      // turn/steer success is an authoritative delivery acknowledgement.
      try {
        this.removeDeliveredQueueItem(session, item.id)
      } catch (error: any) {
        this.restoreQueueItemsToPending(
          session,
          (entry) => entry.id === item.id,
          `Steer 已到达 provider，但队列确认失败，已恢复为可重试：${error?.message || String(error)}`
        )
      }
    }).catch((error: any) => {
      this.restoreQueueItemsToPending(
        session,
        (entry) => entry.id === item.id,
        `插话未获 Agent 确认，已恢复为可重试：${error?.message || String(error)}`
      )
    })
    if (this.getQueue(sessionId).length === 0 && session.status === 'queued') this.setStatus(session, 'running')
  }

  interrupt(sessionId: string, seen = new Set<string>()): void {
    const cancelledRequirementStart = cancelRequirementPreparation(sessionId)
    this.cancelManagementConfirmations(sessionId)
    if (this.sessions.get(sessionId)?.teamBinding) this.teamStopVersions.set(sessionId, (this.teamStopVersions.get(sessionId) || 0) + 1)
    if (seen.has(sessionId)) return
    seen.add(sessionId)
    this.channelSendTurns.delete(sessionId)
    this.feishuTeamInputs.delete(sessionId)
    const session = this.sessions.get(sessionId)
    const awaitedSessionId = session?.waitingForHandoff?.awaitedSessionId
    if (awaitedSessionId) this.interrupt(awaitedSessionId, seen)
    if (session) this.bumpSessionActivity(sessionId)
    const cancelledDeferredDispatch = this.deferredDispatches.delete(sessionId)
    // A hard stop clears the queue below, so any in-progress edit lock is moot.
    this.editingQueueItems.delete(sessionId)
    const cancelledGrokStart = this.protocolPendingStarts.delete(sessionId)
    const cancelledZCodeStart = this.zcodeStarts.delete(sessionId)
    const cancelledRecoveryStart = this.recoveryStartTokens.delete(sessionId)
    if (session && this.isBusy(session.status)) this.setStatus(session, 'cancelling')
    if (session?.config.agentId === 'zcode') {
      if (session.zcodeState) session.zcodeState.suspendedAfterStop = true
      const runner = this.zcodeRunners.get(sessionId)
      const running = !!runner?.snapshot?.control.canStop
      const inFlight = session.zcodeState?.deliveries.some(record => (this.queues.get(sessionId) || []).some(item => item.id === record.queueItemId)
        && ['sent', 'acknowledged', 'observed'].includes(record.phase))
      this.commitQueue(session, (this.queues.get(sessionId) || []).map(item => {
        const receipt = session.zcodeState?.deliveries.filter(record => record.queueItemId === item.id).at(-1)
        const sent = receipt && ['sent', 'acknowledged', 'uncertain', 'observed'].includes(receipt.phase)
        return running && this.activeQueueItems.get(sessionId) === item.id ? item : { ...item, state: 'pending', deliveryUncertain: sent || undefined }
      }))
      if (!running && !inFlight) { this.activeQueueItems.delete(sessionId); this.setStatus(session, 'idle') }
      this.emitQueue(sessionId)
      void runner?.interrupt().catch(error => {
        if (this.sessions.get(sessionId) !== session) return
        this.record(sessionId, { type: 'error', state: 'failed', payload: { message: error instanceof Error ? error.message : 'ZCode 停止未确认' } })
        this.setStatus(session, 'error')
      })
      return
    }
    this.streamers.get(sessionId)?.interrupt()
    this.protocolRunners.get(sessionId)?.interrupt()
    this.runners.get(sessionId)?.interrupt()
    // A user-initiated stop is a hard stop: once the provider has seen the
    // interrupt, also drop anything still queued so the next turn doesn't
    // auto-fire the moment the current one aborts (G2-9).
    const q = this.queues.get(sessionId)
    let clearedCommitted = false
    if (q && q.length) {
      try {
        if (session) {
          this.commitQueue(session, [])
          clearedCommitted = true
        }
      } catch (error: any) {
        if (session && this.events.has(sessionId)) {
          if (sessionStoreWriteCommitted(error)) {
            clearedCommitted = true
            this.record(sessionId, {
              type: 'system_notice',
              payload: {
                kind: 'warning',
                text: `停止后清空队列失败，已停止当前回合：${error?.message || String(error)}`
              }
            })
          } else {
            this.restoreQueueItemsToPending(
              session,
              () => true,
              `停止已发送到 provider，但清空队列未提交；已恢复为可重试：${error?.message || String(error)}`,
              { releaseActiveItemId: this.activeQueueItems.get(sessionId), statusAfter: 'error' }
            )
          }
        }
      } finally {
        if (clearedCommitted && this.activeQueueItems.get(sessionId) !== undefined) {
          this.activeQueueItems.delete(sessionId)
        }
        if (clearedCommitted) this.emitQueue(sessionId)
      }
    }
    // afterTurn() has already observed the prior runner's terminal event, so no
    // further `done` callback exists to leave `cancelling`. Settle the hard stop
    // locally after invalidating the scheduled FIFO callback.
    if (
      session &&
      (cancelledRequirementStart || cancelledDeferredDispatch || cancelledGrokStart || cancelledRecoveryStart || cancelledZCodeStart && !this.zcodeRunners.get(sessionId)?.isRunning()) &&
      session.status === 'cancelling'
    ) {
      this.setStatus(session, 'idle')
    }
  }

  /** Claude model/effort selections apply to the next turn; other edits require idle. */
  async updateSessionConfig(
    sessionId: string,
    patch: Partial<SessionConfig>
  ): Promise<Session | undefined> {
    if (this.isTeamMember(sessionId)) throw new Error('team_session_config_locked')
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (['assistantSnapshot','useAssistant'].some(key => Object.prototype.hasOwnProperty.call(patch, key))) throw new Error('助手身份在会话创建后不能修改')
    if (['worktree', 'workspaceSelection'].some(key => Object.prototype.hasOwnProperty.call(patch, key)) ||
        (session.config.worktree && ['projectId', 'workdir'].some(key => Object.prototype.hasOwnProperty.call(patch, key)))) {
      throw new Error('已有会话的工作树绑定不能更改')
    }
    if (this.nativeActionReservations.has(sessionId)) throw new Error('原生操作正在进行中，请稍后再更改配置')
    const nextClaudeModel = session.config.agentId === 'claude' && Object.keys(patch).every(key => ['model', 'modelSource', 'effort'].includes(key))
    if (this.isBusy(session.status) && !nextClaudeModel) return session
    if (session.teamBinding && teamRuntime(sessionId)?.leader && ['agentId', 'projectId', 'workdir', 'additionalDirectories', 'roleSnapshot', 'requirementId', 'requirementDir', 'requirementDocPath'].some(key => Object.prototype.hasOwnProperty.call(patch, key))) throw new Error('team_session_scope_locked')
    if (session.config.roleSnapshot && !teamRuntime(sessionId)?.leader) {
      const locked = ['agentId', 'model', 'modelSource', 'effort', 'kimiThinking', 'zcodeModelSelection', 'permissionMode', 'projectId', 'workdir', 'additionalDirectories', 'roleSnapshot', 'requirementId', 'requirementDir', 'requirementDocPath', 'requirementName'] as const
      if (locked.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
        throw new Error('role_session_config_locked')
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'collaborationMode')) {
      throw new Error('collaboration mode 必须通过 setCollaborationMode 更新')
    }
    const requested = { ...session.config, ...patch }
    if (requested.agentId !== session.config.agentId) throw new Error('不能更改已有会话的 Agent')
    if (session.config.agentId === 'zcode') {
      if (requested.workdir !== session.config.workdir || JSON.stringify(requested.additionalDirectories) !== JSON.stringify(session.config.additionalDirectories)) throw new Error('ZCode 已有会话不能更改工作区')
      const operation = (this.protocolConfigTails.get(sessionId) || Promise.resolve()).then(async () => {
        if (this.sessions.get(sessionId) !== session) return undefined
        const target = { ...session.config, ...patch }
        const runner = await this.ensureZCodeRunner(session)
        const contract = await runner.updateConfig(target)
        if (this.sessions.get(sessionId) !== session) return undefined
        const model = contract.models.find(model => model.id === contract.currentModelId)
        session.config = { ...target, model: contract.currentModelId, zcodeModelSelection: model?.zcodeSelection,
          effort: model?.efforts.find(level => level === model.zcodeSelection?.options?.reasoningLevel) }
        session.agentContract = contract
        this.persistOrThrow(); this.emitAgentUpdate(session)
        return session
      })
      this.protocolConfigTails.set(sessionId, operation.then(() => undefined, () => undefined))
      return operation
    }
    if (patch.model !== undefined && patch.model !== session.config.model && !Object.prototype.hasOwnProperty.call(patch, 'modelSource')) {
      delete requested.modelSource
    }
    if (requested.agentId !== session.config.agentId) throw new Error('不能更改已有会话的 Agent')
    const agent = this.getAgent(requested.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${requested.agentId}`)
    // Reserve the activity generation before a Grok wire transaction can
    // yield, so an older import cannot dispose the runner underneath it.
    this.bumpSessionActivity(sessionId)
    if (!isACPAdapter(agent.adapter) && agent.adapter !== 'nika') {
      const target = requested
      target.permissionMode = resolveCreatePermissionMode(agent, target.permissionMode)
      const normalized = this.normalizeAgentConfig(target)
      if (agent.adapter === 'codex') {
        const source = normalized.config.modelSource ?? (normalized.config.model ? parseCodexModelKey(normalized.config.model)?.source : undefined)
        if (codexProviderChanged(session.config, normalized.config) ||
            (source && source.kind !== 'native' && session.config.model !== normalized.config.model)) {
          return this.switchCodexProvider(session, normalized.config)
        }
      }
      this.replaceSessionConfig(session, normalized.config)
      if (normalized.disabled) {
        this.record(sessionId, {
          type: 'system_notice',
          payload: {
            kind: 'warning',
            text: `所选模型 ${session.config.model || ''} 不支持 TraeX Max，已自动关闭 Max 模式。`
          }
        })
      }
      // Preserve the existing synchronous commit semantics for legacy runners.
      this.streamers.get(sessionId)?.updateConfig(session.config)
      this.persist()
      return session
    }

    const configTails = this.protocolConfigTails
    const prior = configTails.get(sessionId) || Promise.resolve()
    const operation = prior.then(async () => {
      const current = this.sessions.get(sessionId)
      if (!current) return undefined
      const target = { ...current.config, ...patch }
      const advertisedModes = agent.capabilities.permissionModes
      if (
        patch.permissionMode !== undefined &&
        !advertisedModes.some((mode) => mode.id === patch.permissionMode)
      ) {
        throw new Error(`${agent.name} 不支持权限模式：${patch.permissionMode}`)
      }
      if (
        target.permissionMode &&
        !advertisedModes.some((mode) => mode.id === target.permissionMode)
      ) {
        throw new Error('稳定 ACP 无法保证原有权限限制；请重新选择权限后继续。')
      }
      const runner = this.protocolRunners.get(sessionId)
      { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, target) }
      
      const previousConfig = { ...current.config }
      const previousContract = current.agentContract ? copySessionContract(current.agentContract) : undefined
      let replaced = false
      this.deepseekConfigTransactions.add(sessionId)
      try {
        const applied = runner ? await runner.updateConfig(target) : undefined
        // The session could have been deleted while the native RPC was pending.
        if (this.sessions.get(sessionId) !== current) return undefined
        this.replaceSessionConfig(current, applied?.config || target)
        if (applied?.contract) {
          current.agentContract = copySessionContract(applied.contract)
          this.bumpSessionActivity(current.id)
        }
        replaced = true
        if (agent.adapter === 'deepseek') this.persistOrThrow()
        else this.persist()
        if (current.agentContract) this.emitAgentUpdate(current)
        return current
      } catch (error: any) {
        const committed = agent.adapter === 'deepseek' && replaced && sessionStoreWriteCommitted(error)
        if (!committed && this.sessions.get(sessionId) === current) {
          this.replaceSessionConfig(current, previousConfig)
          current.agentContract = previousContract
          if (replaced) runner?.restoreConfigAfterFailedCommit(previousConfig, previousContract)
        }
        if (this.sessions.get(sessionId) === current && this.events.has(sessionId)) {
          this.record(sessionId, {
            type: 'system_notice',
            payload: {
              kind: 'warning',
              text: committed
                ? `${agent.name} 配置已写入，但持久化确认失败；重启后请核对配置：${error?.message || String(error)}`
                : `${agent.name} 配置更新失败，已保留原配置：${error?.message || String(error)}`
            }
          })
        }
        if (current.agentContract) this.emitAgentUpdate(current)
        throw error
      } finally {
        this.deepseekConfigTransactions.delete(sessionId)
      }
    })
    configTails.set(
      sessionId,
      operation.then(
        () => undefined,
        () => undefined
      )
    )
    return operation
  }

  private beginModelSwitch(session: Session, previous: SessionConfig, target: SessionConfig): void {
    const agent = this.getAgent(target.agentId)
    const label = (config: SessionConfig): string =>
      (config.model && agent?.models.find(item => item.id === config.model)?.label) ||
      (config.model ? parseCodexModelKey(config.model)?.model ?? config.model : '') || '默认模型'
    const source = (config: SessionConfig): CodexModelSourceRef =>
      config.modelSource ?? (config.model ? parseCodexModelKey(config.model)?.source : undefined) ?? { kind: 'native' }
    const entry = {
      state: 'running' as const,
      payload: {
        id: `mswitch-${nanoid(8)}`,
        fromModel: previous.model, fromLabel: label(previous), fromSource: source(previous),
        toModel: target.model, toLabel: label(target), toSource: source(target),
        step: 'prepare', compacted: false, hints: [] as string[],
        startedAt: Date.now()
      }
    }
    this.modelSwitches.set(session.id, entry)
    this.record(session.id, { type: 'model_switch', state: entry.state, payload: { ...entry.payload } })
  }

  private recordModelSwitch(sessionId: string, patch: Record<string, any>): void {
    const entry = this.modelSwitches.get(sessionId)
    if (!entry) return
    entry.payload = { ...entry.payload, ...patch }
    this.record(sessionId, { type: 'model_switch', state: entry.state, payload: { ...entry.payload } })
  }

  private finishModelSwitch(sessionId: string, state: 'success' | 'failed', error?: any): void {
    const entry = this.modelSwitches.get(sessionId)
    if (!entry) return
    entry.state = state
    this.recordModelSwitch(sessionId, {
      endedAt: Date.now(),
      ...(state === 'failed' ? { error: error?.message || String(error) } : {})
    })
  }

  private abandonModelSwitch(sessionId: string): void {
    this.modelSwitches.delete(sessionId)
  }

  /**
   * 模型切换窗口内 codex 的 resume 模型不一致警告是切换流程的内部产物
   * （压缩/复查/应用各自续跑线程），折叠进切换卡片；返回 true 表示事件已被
   * 卡片吞掉。下一个真实回合（turn_started）开始后出现的同类警告不再属于
   * 切换，恢复为普通会话提示。
   */
  private foldModelSwitchNotice(session: Session, ev: UAEvent): boolean {
    if (ev.type === 'turn_started') {
      this.modelSwitches.delete(session.id)
      return false
    }
    if (ev.type !== 'system_notice' || ev.payload?.kind !== 'warning' || !resumeModelMismatch(ev.payload?.text)) return false
    const entry = this.modelSwitches.get(session.id)
    if (!entry) return false
    this.recordModelSwitch(session.id, { hints: [...(entry.payload.hints || []), String(ev.payload.text)] })
    return true
  }

  private async switchCodexProvider(session: Session, requested: SessionConfig): Promise<Session | undefined> {
    const previous = session.config
    let runner: AppServerRunner | undefined
    let replaced = false
    let reserved = false
    let begun = false
    try {
      this.requireWritableIdleSession(session.id, false, true)
      this.nativeActionReservations.add(session.id)
      reserved = true
      const target = this.resolveProjectConfig?.(requested, true) || requested
      await this.assertSessionNotExternallyOccupied(session)
      if (this.sessions.get(session.id) !== session) return undefined
      this.beginModelSwitch(session, previous, target)
      begun = true
      if (session.nativeSessionId) {
        runner = this.ensureStreamerForNativeAction(session)
        const model = this.getAgent(target.agentId)?.models.find(item => item.id === target.model)
        const contextLimit = Math.floor((model?.contextWindow || 272000) * 0.95)
        const contextTokens = await runner.getContextTokens(target)
        if (this.sessions.get(session.id) !== session) { this.abandonModelSwitch(session.id); return undefined }
        if (contextTokens == null || contextTokens >= contextLimit) {
          this.recordModelSwitch(session.id, { step: 'compact' })
          await runner.compactForProviderSwitch(contextLimit, target)
          this.recordModelSwitch(session.id, { compacted: true })
          const compactedTokens = await runner.getContextTokens(target)
          if (compactedTokens == null || compactedTokens >= contextLimit) {
            throw new Error('压缩后的有效历史仍无法确认满足目标模型的上下文容量，请保留当前模型或新建会话承接任务摘要')
          }
        }
        if (this.sessions.get(session.id) !== session) { this.abandonModelSwitch(session.id); return undefined }
        this.recordModelSwitch(session.id, { step: 'apply' })
        await runner.applyProviderConfig(target, contextLimit)
        if (this.sessions.get(session.id) !== session) { this.abandonModelSwitch(session.id); return undefined }
      }
      this.replaceSessionConfig(session, target)
      replaced = true
      this.persistOrThrow()
      this.finishModelSwitch(session.id, 'success')
      this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
      return session
    } catch (error: any) {
      if (this.sessions.get(session.id) === session) {
        const committed = replaced && sessionStoreWriteCommitted(error)
        if (!committed) {
          this.replaceSessionConfig(session, previous)
          runner?.updateConfig(previous)
        }
        this.finishModelSwitch(session.id, 'failed', committed
          ? new Error(`模型配置已写入，但持久化确认失败，请核对配置：${error?.message || String(error)}`)
          : new Error(`${error?.message || String(error)}。已保留原模型和来源；请检查相关模型的容量、额度与接入配置后重试，或新建会话并带入任务摘要。`))
        this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
      } else if (begun) this.abandonModelSwitch(session.id)
      throw error
    } finally {
      if (reserved) this.nativeActionReservations.delete(session.id)
    }
  }

  /** Keep persisted/UI config within the selected model's live capabilities. */
  private normalizeAgentConfig(config: SessionConfig, crossAgentFork = false): { config: SessionConfig; disabled: boolean } {
    const agent = this.getAgent(config.agentId)
    
    const pref = this.getAgentPref?.(config.agentId)
    if (crossAgentFork && agent?.models.length && config.model &&
        (!config.modelSource || config.modelSource.kind === 'native') &&
        !agent.models.some(model => model.id === config.model)) {
      config = { ...config, model: undefined, modelSource: undefined }
    }
    config = withAgentDefaults(agent, config, pref)
    // ACP validates explicit presets against the live session. Do not silently
    // rewrite a role or clear an unsupported setting before that validation.
    if (agent && (isACPAdapter(agent.adapter) || agent.adapter === 'zcode')) return { config, disabled:false }
    const model = agent?.models.find((m) => m.id === config.model)
    let next = config
    if (config.effort && model && !model.efforts.includes(config.effort)) {
      const effort = resolveModelEffort(model, pref?.defaultEffort)
      next = { ...config, effort }
      if (!effort) delete next.effort
    }
    if (!next.maxMode) return { config: next, disabled: false }
    const normalized = normalizeTraexMax(agent?.adapter, model?.supportsMax, next.maxMode)
    return {
      config: normalized.maxMode === next.maxMode ? next : { ...next, maxMode: normalized.maxMode },
      disabled: normalized.disabled
    }
  }

  /** Respond to a server→client question / approval (Doc3). */
  respondToRequest(
    sessionId: string,
    requestId: string,
    answer: any,
    bubble?: TurnBubble
  ): AppServerRespondResult | void | Promise<AppServerRespondResult | void> {
    const result = this.respondToRequestImpl(sessionId, requestId, answer, bubble)
    if (!this.sessionLogs.backgroundWrites) return result
    return Promise.resolve(result).then(async accepted => {
      if (accepted?.handled) await this.sessionLogs.flush()
      return accepted
    })
  }

  private respondToRequestImpl(
    sessionId: string,
    requestId: string,
    answer: any,
    bubble?: TurnBubble
  ): AppServerRespondResult | void | Promise<AppServerRespondResult | void> {
    if (requestId.startsWith(MANAGE_CONFIRMATION_PREFIX)) {
      const pending = this.managementConfirmations.get(requestId)
      const request = this.events.get(sessionId)?.findLast(event => event.type === 'approval_request' && event.payload.requestId === requestId)
      if (!pending || pending.sessionId !== sessionId || !request || request.state !== 'pending') throw new Error('管理确认已处理或失效')
      const fields = normalizeQuestions('question', request.payload.params)
      if (answer?.action !== 'decline' && answer?.action !== 'cancel') validateQuestionAnswer('question', fields, answer)
      const choice = answer?.action === 'decline' || answer?.action === 'cancel' ? undefined : questionAnswerValues('question', fields[0], answer)[0]
      this.managementConfirmations.delete(requestId)
      request.state = 'success'; request.payload.submittedAnswer = answer; request.payload.source = bubble?.source || 'app'
      this.logEvent(request); this.emit('event', request)
      return pending.answer(choice).then(() => ({ handled: true, hasPendingRequests: false }))
    }
    if (requestId.startsWith('side:')) return this.respondSideRequest(sessionId, requestId.slice(5), answer, bubble)
    if (requestId.startsWith(LOCAL_PLAN_PREFIX)) return this.respondToLocalPlan(sessionId, requestId, answer, bubble)
    if (requestId.startsWith(ASYNC_QUESTION_PREFIX)) return this.respondToAsyncQuestion(sessionId, requestId, answer, bubble)
    const request = this.events.get(sessionId)?.findLast(event => event.type === 'approval_request' && event.payload.requestId === requestId)
    if (request && (request.payload.kind === 'question' || request.payload.kind === 'elicitation') && !isMcpToolApproval(request.payload.params) && !['cancel', 'decline'].includes(answer?.action)) {
      const kind = questionAnswerKind(request.payload.kind, request.payload.method)
      const fields = normalizeQuestions(kind, request.payload.params)
      if (fields.length) validateQuestionAnswer(kind, fields, answer)
    }
    const session = this.sessions.get(sessionId)
    const grok = this.protocolRunners.get(sessionId)
    const zcode = this.zcodeRunners.get(sessionId)
    if (zcode) return zcode.respondResult(requestId, answer).then(result => {
      if (this.zcodeRunners.get(sessionId) === zcode && this.sessions.get(sessionId) === session && result.handled) {
        if (request) {
          const events = this.events.get(sessionId) || []
          const index = events.findIndex(event => event.type === 'approval_request' && event.payload.requestId === requestId)
          const resolved: UAEvent = { ...request, state: 'success', payload: { ...request.payload, zcodeProjection: false, resolved: true, submittedAnswer: answer } }
          if (index >= 0) events[index] = resolved
          else events.push(resolved)
          this.logEvent(resolved); this.emit('event', resolved)
        }
        if (session && !result.hasPendingRequests && session.status === 'awaiting-approval') this.setStatus(session, 'running')
      }
      return result
    })
    const resolvedStart = this.events.get(sessionId)?.length ?? 0
    const claudeRunner = this.runners.get(sessionId)
    if (claudeRunner) {
      const planApproval = answer?.decision === 'approved' && this.events.get(sessionId)?.some((event) =>
        event.type === 'approval_request' && event.payload?.requestId === requestId &&
        event.payload?.kind === 'planMode' && event.state === 'pending'
      )
      const result = claudeRunner.respond(requestId, answer)
      if (result.handled && this.runners.get(sessionId) === claudeRunner && this.sessions.get(sessionId) === session) {
        this.retainAnsweredRequest(sessionId, requestId, answer, resolvedStart)
        if (planApproval && session) {
          session.config = { ...session.config, permissionMode: 'ask' }
          void claudeRunner.setClaudePermissionMode('default').catch(error => this.record(sessionId, { type: 'error', state: 'failed', payload: { message: String(error) } }))
          this.persist()
          this.emit('sessionUpdated', { session, hasLiveStreamer: false })
        }
        if (!result.hasPendingRequests && session?.status === 'awaiting-approval') this.setStatus(session, 'running')
      }
      return result
    }
    if (grok) {
      const accept = (result: AppServerRespondResult): AppServerRespondResult => {
        if (this.protocolRunners.get(sessionId) !== grok || this.sessions.get(sessionId) !== session) return { handled: false, hasPendingRequests: false }
        if (!result.handled) return result
        this.retainAnsweredRequest(sessionId, requestId, answer, resolvedStart)
        if (session && !result.hasPendingRequests && session.status === 'awaiting-approval') this.setStatus(session, 'running')
        return result
      }
      const result = grok.respondResult(requestId, answer)
      return result instanceof Promise ? result.then(accept) : accept(result)
    }
    const streamer = this.streamers.get(sessionId)
    if (!streamer) return { handled: false, hasPendingRequests: false }
    const sessionOwnerGeneration = this.sessionOwnerGeneration(sessionId)
    const streamerOwnerGeneration = this.mainStreamerOwnerGeneration(sessionId)
    const ownsResponse = (): boolean =>
      !!session &&
      this.sessions.get(sessionId) === session &&
      this.streamers.get(sessionId) === streamer &&
      this.sessionOwnerGeneration(sessionId) === sessionOwnerGeneration &&
      this.mainStreamerOwnerGeneration(sessionId) === streamerOwnerGeneration
    const result = streamer.respond(requestId, answer)
    if (!result.handled) return result
    // respond() emits the raw success synchronously. Validate its listeners
    // before retaining the answer, then use the same pre-respond owner epochs
    // to fence synchronous listeners of the retained merged event.
    if (!ownsResponse()) return result
    this.retainAnsweredRequest(sessionId, requestId, answer, resolvedStart)
    if (!ownsResponse()) return result
    const hasPendingRequests = streamer.hasPendingRequests()
    const currentResult = { ...result, hasPendingRequests }
    if (!hasPendingRequests && session?.status === 'awaiting-approval') {
      this.setStatus(session, 'running')
    }
    return currentResult
  }

  private async respondToAsyncQuestion(sessionId: string, requestId: string, answer: unknown, bubble?: TurnBubble): Promise<AppServerRespondResult> {
    const session = this.sessions.get(sessionId)
    if (!session || session.readOnly || session.archived || session.status === 'cancelling') throw new Error('当前会话无法回答提问')
    const key = `${sessionId}:${requestId}`
    if (this.answeringAsyncQuestions.has(key)) throw new Error('回答正在提交，请稍候')
    this.answeringAsyncQuestions.add(key)
    try {
      const events = await this.getEvents(sessionId)
      const original = events.findLast(event => isAsyncQuestion(event) && interactionRequestKey(event) === requestId)
      if (!original || original.payload.interactionExpired || original.payload.submittedAnswer !== undefined) {
        throw new Error('提问已处理或已失效')
      }
      if (!isSkippedQuestionAnswer(answer)) {
        const prompt = asyncQuestionReply(original, answer)
        // Strict steering waits for acknowledgement; idle sessions use the normal
        // durable send path. Never report a failed steer as an accepted answer.
        if (this.isTeamMember(sessionId)) {
          const input = bubble?.source === 'weixin' ? appendWeixinContext(prompt) : bubble?.source === 'feishu' ? appendFeishuContext(prompt) : prompt
          if (session.status === 'running') await this.steerTeamMessage(sessionId, input)
          else if (this.isReady(session.status)) await this.sendTeamMessage(sessionId, input)
          else throw new Error('请等待成员恢复运行或空闲后重试')
        } else await this.forceSend(sessionId, bubble?.source === 'weixin' ? appendWeixinContext(prompt) : bubble?.source === 'feishu' ? appendFeishuContext(prompt) : prompt, undefined, undefined, { ...bubble, asyncQuestion: true }, false)
      }
      if (this.sessions.get(sessionId) !== session) throw new Error('会话已切换，请检查回答状态')
      const index = events.findLastIndex(event => isAsyncQuestion(event) && interactionRequestKey(event) === requestId)
      const latest = events[index] || original
      const resolved: UAEvent = { ...latest, payload: { ...latest.payload, submittedAnswer: answer } }
      if (index >= 0) events[index] = resolved
      this.logEvent(resolved)
      this.emit('event', resolved)
      return { handled: true, hasPendingRequests: this.streamers.get(sessionId)?.hasPendingRequests() ?? false }
    } finally {
      this.answeringAsyncQuestions.delete(key)
    }
  }

  private ensureLocalPlanRequest(session: Session): void {
    if (!this.isReady(session.status) || session.readOnly || session.archived || this.isTeamMember(session.id)) return
    const events = this.events.get(session.id) || []
    const request = latestLocalPlanRequest(events)
    if (!request || request.state !== 'pending' || events.some(event => event.type === 'approval_request' && event.payload.requestId === request.payload.requestId)) return
    this.record(session.id, { type: 'approval_request', state: 'pending', payload: { ...request.payload, localPlanShared: true } })
  }

  private async respondToLocalPlan(sessionId: string, requestId: string, answer: any, bubble?: TurnBubble): Promise<AppServerRespondResult> {
    const session = this.sessions.get(sessionId)
    if (!session || session.readOnly || session.archived || !this.isReady(session.status) || this.isTeamMember(sessionId)) throw new Error('当前会话无法处理计划确认')
    const key = `${sessionId}:${requestId}`
    if (this.answeringAsyncQuestions.has(key)) throw new Error('回答正在提交，请稍候')
    this.answeringAsyncQuestions.add(key)
    try {
      const events = await this.getEvents(sessionId)
      const latest = latestLocalPlanRequest(events)
      const original = events.findLast(event => event.type === 'approval_request' && event.payload.requestId === requestId)
      if (!latest || latest.payload.requestId !== requestId || original?.payload.interactionExpired || original?.payload.submittedAnswer !== undefined) throw new Error('计划已处理或失效')
      if (!['approved', 'rejected', 'cancelled'].includes(answer?.decision)) throw new Error('无效的计划操作')
      const feedback = typeof answer.feedback === 'string' ? answer.feedback.trim() : ''
      if (answer.decision === 'rejected' && !feedback) throw new Error('请填写计划修改意见')
      if (answer.decision === 'approved') {
        const previousMode = session.config.collaborationMode || 'plan'
        await this.setCollaborationMode(sessionId, 'default')
        try { await this.sendMessage(sessionId, bubble?.source === 'weixin' ? appendWeixinContext('Implement the plan.') : bubble?.source === 'feishu' ? appendFeishuContext('Implement the plan.') : 'Implement the plan.', undefined, undefined, false, bubble, false) }
        catch (error) { await this.setCollaborationMode(sessionId, previousMode).catch(() => undefined); throw error }
      } else if (answer.decision === 'rejected') await this.sendMessage(sessionId, bubble?.source === 'weixin' ? appendWeixinContext(feedback) : bubble?.source === 'feishu' ? appendFeishuContext(feedback) : feedback, undefined, undefined, false, bubble, false)
      if (this.sessions.get(sessionId) !== session) throw new Error('会话已切换，请检查计划状态')
      const resolved: UAEvent = { ...(original || latest), state: 'success', payload: { ...(original || latest).payload, submittedAnswer: answer, interactionExpired: false, localPlanShared: true } }
      if (original) events[events.indexOf(original)] = resolved
      else events.push(resolved)
      this.logEvent(resolved); this.emit('event', resolved)
      return { handled: true, hasPendingRequests: false }
    } finally { this.answeringAsyncQuestions.delete(key) }
  }

  private expireLocalPlans(sessionId: string): void {
    const events = this.events.get(sessionId) || []
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      if (event.type !== 'approval_request' || event.payload.method !== 'local/plan' || event.state !== 'pending' || event.payload.submittedAnswer !== undefined) continue
      if (this.answeringAsyncQuestions.has(`${sessionId}:${event.payload.requestId}`)) continue
      const expired: UAEvent = { ...event, state: 'cancelled', payload: { ...event.payload, interactionExpired: true } }
      events[index] = expired; this.logEvent(expired); this.emit('event', expired)
    }
  }

  private retainAnsweredRequest(
    sessionId: string,
    requestId: string,
    answer: unknown,
    resolvedStart: number
  ): void {
    const events = this.events.get(sessionId)
    if (!events) return
    const matches = (event: UAEvent): boolean =>
      event.type === 'approval_request' && event.payload?.requestId === requestId
    const originalIndex = events.findLastIndex(
      (event, index) => index < resolvedStart && matches(event) && event.state === 'pending'
    )
    const resolvedIndex = events.findLastIndex(
      (event, index) => index >= resolvedStart && matches(event) && event.state !== 'pending'
    )
    if (originalIndex < 0 || resolvedIndex < 0) return
    const original = events[originalIndex]
    const resolved = events[resolvedIndex]
    const merged: UAEvent = {
      ...original,
      state: resolved.state,
      payload: { ...original.payload, ...resolved.payload, submittedAnswer: answer }
    }
    events.splice(resolvedIndex, 1)
    events[originalIndex] = merged
    if (this.sessions.get(sessionId)?.config.agentId === 'deepseek') this.deepseekEvents.append(sessionId, merged)
    this.logEvent(merged)
    this.emit('event', merged)
  }

  /**
   * Import a native CLI history session (Doc2 需求3.3), upserting by identity
   * (Doc5 T3). Snapshot mode stays read-only; direct mode reuses the original
   * native id as writable. Callers that need isolation use `forkSameSession`.
   */
  async importSession(
    agentId: string,
    nativeId: string,
    mode: SessionImportMode = 'snapshot',
    historyCwd?: string,
    historyTitle?: string,
    preserveExistingKind = false,
    runtimeConfig?: { ownerId: string; config: SessionConfig },
    workspaceConfig?: Pick<SessionConfig, 'projectId' | 'worktree' | 'requirementId' | 'assistantSnapshot'>
  ): Promise<Session | undefined> {
    const agent = this.getAgent(agentId)
    if (!agent) return undefined
    if (
      mode === 'direct' &&
      ((agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web')
        ? agent.capabilities.sessionLoad !== true || agent.capabilities.sessionResume !== true
        : agent.capabilities.sessionLoad === false || agent.capabilities.sessionResume === false)
    ) return undefined
    // Upsert: find an existing session with the same identity before touching
    // native history. A busy/live session must never race its active resume
    // transport with a second `session/load` on the same native id.
    const existing = this.findByIdentity(agentId, nativeId)
    if (existing?.teamBinding) throw new Error('team_session_requires_project_route')
    if (existing && this.isBusy(existing.status)) {
      // A live runner keys delayed callbacks off the exact Session object it
      // started with. Replacing that object, or even opening a parallel history
      // load against the same native session, can strand the in-flight
      // generation and its durable queue bookkeeping. While busy, fail safe by
      // returning the existing live session unchanged; idle re-import remains
      // the refresh path.
      return existing
    }
    // `status` is not a generation: a turn can start and finish while the load
    // is in flight, returning to `idle` before we inspect it. Capture explicit
    // local activity and native-identity ownership generations instead.
    const ownerActivityGeneration = existing
      ? this.sessionActivityGeneration(existing.id)
      : undefined
    const identityOwnershipGeneration = this.nativeIdentityOwnershipGeneration(agentId, nativeId)
    const loadCwd = validAbsoluteCwd(existing?.config.workdir) || validAbsoluteCwd(historyCwd)
    let loaded: Awaited<ReturnType<typeof loadSessionEvents>>
    await this.sessionLogs.flush()
    if (agent.adapter === 'deepseek') {
      loaded = agent.capabilities.protocol === 'web' ? await loadDeepSeekHostHistory(nativeId)
        : await loadDeepSeekSessionEvents(nativeId, agent.bin, loadCwd, existing ? deepseekSessionRuntimeEnv(existing.id, existing.config) : deepseekRuntimeEnv())
    }  else if (agent.adapter === 'kimi') {
      loaded = await loadKimiSessionEvents(nativeId, agent.bin, loadCwd, runtimeConfig ? kimiSessionRuntimeEnv(runtimeConfig.ownerId, runtimeConfig.config) : existing ? kimiSessionRuntimeEnv(existing.id, existing.config) : {})
    } else if (agent.adapter === 'grok') {
      loaded = await loadGrokSessionEvents(nativeId, agent.bin, loadCwd)
    } else if (agent.adapter === 'mcode') {
      loaded = await loadMCodeSessionEvents(nativeId, agent.bin, loadCwd, mcodeSessionRuntimeEnv())
    } else {
      loaded = await loadSessionEvents(agentId, nativeId)
    }
    const { cwd, model, maxMode, contextWindow } = loaded
    const events = loaded.events.map(event => ['user_message','goal_message'].includes(event.type) ? { ...event, payload: { ...event.payload, text: stripAssistantContext(String(event.payload.text || '')) } } : event)
    const current = this.findByIdentity(agentId, nativeId)
    if (
      this.nativeIdentityOwnershipGeneration(agentId, nativeId) !== identityOwnershipGeneration ||
      current !== existing ||
      (existing !== undefined &&
        (this.sessions.get(existing.id) !== existing ||
          this.sessionActivityGeneration(existing.id) !== ownerActivityGeneration))
    ) {
      // The load no longer owns the generation it observed. In particular, an
      // absent current owner means the original was deleted; never resurrect it.
      if (preserveExistingKind) throw new Error('会话状态已变化，请稍后刷新')
      return current
    }
    if (current && this.isBusy(current.status)) {
      // History import won the wire race but lost session ownership locally:
      // another turn started while `session/load` was in flight. Keep the live
      // owner unchanged and do not overwrite its state, queue, or runner.
      if (preserveExistingKind) throw new Error('当前会话正在运行，无法刷新')
      return current
    }
    if (preserveExistingKind && current) this.assertNativeSessionRefreshable(current)
    const existingStillOwned =
      existing && this.sessions.get(existing.id) === existing ? existing : undefined
    const owner = current || existingStillOwned
    const firstUser = events.find((e) => e.type === 'user_message' || e.type === 'goal_message')
    const nativeTitle = historyTitle?.trim()
    // 需求3: derive the title from the first user message with mention markup
    // stripped (was `slice(0,40)`, which captured "@capcode …" prefixes). A
    // manually-renamed session keeps its locked title; otherwise the title from
    // the native history index wins over the first-message fallback.
    const title =
      owner?.titleLocked && owner.title
        ? owner.title
        : nativeTitle || deriveSessionTitle(firstUser?.payload?.text, 40) || '(导入会话)'

    const id = owner?.id || 's_' + nanoid(10)

    let config: SessionConfig
    let maxModeDisabled = false
    if (owner) {
      config = {
        ...owner.config,
        model: owner.forkedFrom?.mode === 'cross' ? owner.config.model : model || owner.config.model,
        workdir: cwd || owner.config.workdir,
        ...((agent.adapter === 'traex' || agent.adapter === 'mcode') && maxMode !== undefined ? { maxMode } : {})
      }
      config.permissionMode = resolveCreatePermissionMode(agent, config.permissionMode)
      const normalized = this.normalizeAgentConfig(config, owner.forkedFrom?.mode === 'cross')
      config = normalized.config
      maxModeDisabled = normalized.disabled
    } else {
      const permissionMode = resolveCreatePermissionMode(agent, undefined)
      config = {
        agentId,
        model: model || agent.defaultModel,
        workdir: cwd || process.env.HOME || '.',
        ...(permissionMode ? { permissionMode } : {}),
        maxMode: (agent.adapter === 'traex' || agent.adapter === 'mcode') ? maxMode : false
      }
      const normalized = this.normalizeAgentConfig(config)
      config = normalized.config
      maxModeDisabled = normalized.disabled
    }
    if (workspaceConfig) config = { ...config, ...structuredClone(workspaceConfig) }
    if (this.resolveProjectConfig) config = this.resolveProjectConfig(config)
    const directImport = preserveExistingKind
      ? owner?.importMode === 'direct'
      : !owner?.forkedFrom && (mode === 'direct' || owner?.importMode === 'direct')
    const importedReadOnly = preserveExistingKind
      ? owner?.readOnly
      : directImport
        ? false
        : owner?.forkedFrom
          ? owner.readOnly ?? false
          : owner?.readOnly ?? true
    const nextStatus = owner?.status || 'idle'
    const nextUpdatedAt = Date.now()
    const nextEvents = hydrateSubmittedUserMessages(events, owner?.submittedUserMessages)
      .map((e) => ({ ...e, sessionId: id }))
    this.restoreInteractionCheckpoints(id, agentId, nextEvents)
    if (agent.adapter === 'deepseek') await this.deepseekEvents.replace(id, nextEvents.map((event, seq) => ({ ...event, seq })))
    if (owner) {
      // Idle refresh keeps the exact Session object identity so any cached
      // listener closures, maps, and later live runner callbacks continue to
      // target the same owner. Tear down any cached idle runner first: its
      // config/session snapshot is stale after re-import and must not be reused.
      this.disposeSession(owner.id, true)
      owner.title = title
      owner.config = config
      owner.status = nextStatus
      owner.updatedAt = nextUpdatedAt
      owner.nativeSessionId = nativeId
      if (!preserveExistingKind) {
        owner.origin = 'imported'
        owner.readOnly = importedReadOnly
        if (directImport) owner.importMode = 'direct'
        else delete owner.importMode
      }
      const ref = { n: 0 }
      const stamped = nextEvents.map((e) => ({ ...e, seq: ref.n++ }))
      appendHistoryConfigWarning(
        stamped,
        ref,
        owner.id,
        agent,
        config,
        maxModeDisabled,
        contextWindow
      )
      this.events.set(owner.id, stamped)
      this.seqRefs.set(owner.id, ref)
      this.restoreReplyCheckpoints(owner.id, stamped)
      if (owner.pendingQueue) {
        this.queues.set(owner.id, owner.pendingQueue)
      } else if (!this.queues.has(owner.id)) {
        this.queues.set(owner.id, [])
      }
      this.bumpSessionActivity(owner.id)
      this.persist()
      this.emit('sessionUpdated', { session: owner, hasLiveStreamer: false })
      return owner
    }
    const session: Session = {
      id,
      title,
      config,
      status: nextStatus,
      createdAt: Date.now(),
      updatedAt: nextUpdatedAt,
      nativeSessionId: nativeId,
      origin: 'imported',
      // Direct import deliberately reuses the original native identity. Snapshot
      // mode remains read-only until the user chooses a continuation action.
      readOnly: importedReadOnly,
      importMode: directImport ? 'direct' : undefined,
      forkedFrom: undefined,
      // Preserve manual rename / pin across re-imports (需求4).
      pinned: undefined,
      titleLocked: undefined
    }
    this.installSessionOwner(session)
    const ref = { n: 0 }
    // Re-stamp replayed events with this session id + sequential seq.
    const stamped = nextEvents.map((e) => ({ ...e, seq: ref.n++ }))
    appendHistoryConfigWarning(
      stamped,
      ref,
      id,
      agent,
      config,
      maxModeDisabled,
      contextWindow
    )
    this.events.set(id, stamped)
    this.seqRefs.set(id, ref)
    if (!this.queues.has(id)) {
      this.queues.set(id, [])
    }
    this.persist()
    return session
  }

  /** Re-read a file-backed Session without loading/resuming it or changing its kind. */
  async refreshNativeSession(sessionId: string): Promise<NativeSessionRefreshResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    if (
      !session.nativeSessionId ||
      (session.config.agentId !== 'codex' && session.config.agentId !== 'traex')
    ) throw new Error('当前会话不支持原生刷新')
    this.assertNativeSessionRefreshable(session)
    this.logSession(sessionId, 'native_session_refresh_started', {
      nativeSessionId: session.nativeSessionId,
      runnerPid: this.streamers.get(sessionId)?.processId()
    })

    const agent = this.getAgent(session.config.agentId)
    const nativeId = session.nativeSessionId
    const generation = this.sessionActivityGeneration(sessionId)
    const summary = (await listAgentHistory(session.config.agentId, agent?.bin))
      .find((entry) => entry.id === nativeId)
    if (
      this.sessions.get(sessionId) !== session ||
      session.nativeSessionId !== nativeId ||
      this.sessionActivityGeneration(sessionId) !== generation
    ) throw new Error('会话状态已变化，请稍后刷新')
    this.assertNativeSessionRefreshable(session)
    const refreshed = await this.importSession(
      session.config.agentId,
      nativeId,
      session.importMode === 'direct' ? 'direct' : 'snapshot',
      session.config.workdir,
      summary?.title || session.title,
      true
    )
    if (!refreshed) throw new Error('刷新原生会话失败')
    const runtime = await this.getSessionRuntimeState(refreshed.id)
    this.logSession(sessionId, 'native_session_refresh_finished', runtime.nativeSessionOccupancy)
    return {
      session: refreshed,
      runtime
    }
  }

  private assertNativeSessionRefreshable(session: Session): void {
    const sessionId = session.id
    if (this.isBusy(session.status)) throw new Error('当前会话正在运行，无法刷新')
    if ((this.pendingSends.get(sessionId) || 0) > 0) throw new Error('消息正在发送，无法刷新')
    if (this.nativeActionReservations.has(sessionId)) throw new Error('原生操作正在进行中，无法刷新')
    if (this.rewinding.has(sessionId)) throw new Error('回退正在进行中，无法刷新')
    const sideStatus = this.sideStatus.get(sessionId)
    if ((sideStatus && sideStatus !== 'idle') || this.detailStatus.get(sessionId) === 'running') {
      throw new Error('侧边或详情对话正在运行，无法刷新')
    }
  }

  /** Find an existing session by its (agentId, nativeSessionId) identity. */
  private findByIdentity(agentId: string, nativeId: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.config.agentId !== agentId) continue
      if (s.nativeSessionId === nativeId) return s
    }
    return undefined
  }

  /**
   * Doc2 — cross-agent resume. Transplant a native session from `sourceAgentId`
   * into `targetAgentId`'s on-disk history (history.exportNativeSession does the
   * schema translation), then import the freshly-minted native id under the
   * target agent so it opens & can be resumed there. Returns the imported
   * UniAgent session, or undefined if the transplant produced nothing.
   */
  async exportNativeSession(
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ): Promise<Session | undefined> {
    const source = this.getAgent(sourceAgentId)
    const target = this.getAgent(targetAgentId)
    const sourceAllowed = isCrossForkSourceAgent(source)
    if (!sourceAllowed || !isCrossForkTargetAgent(target)) return undefined
    const sourceConfig = this.findByIdentity(sourceAgentId, nativeId)?.config
    if (sourceConfig?.worktree) assertWorktreeAvailable(sourceConfig)
    const res = await exportNativeSession(sourceAgentId, nativeId, targetAgentId, this.getAgent, point)
    if (!res) return undefined
    // Import the transplanted native session under the target agent. The events
    // replay from the file we just wrote, so the target opens with full context.
    return this.importSession(targetAgentId, res.nativeId, 'snapshot', undefined, undefined, false, undefined,
      sourceConfig ? { projectId: sourceConfig.projectId, ...(sourceConfig.worktree ? { worktree: sourceConfig.worktree } : {}), requirementId: sourceConfig.requirementId, ...(sourceConfig.assistantSnapshot ? { assistantSnapshot: structuredClone(sourceConfig.assistantSnapshot) } : {}) } : undefined)
  }

  /**
   * 需求5（外部会话导入并发治理）— 原Agent分叉. Fork a read-only imported snapshot
   * into a NEW, independent, WRITABLE session under the SAME agent, by
   * byte-copying its native rollout to a fresh native id (history.forkSameSession
   * is lossless: reasoning/tool/world_state survive, so the branch resumes with
   * the full model context). The returned session is `readOnly:false` and carries
   * `forkedFrom` lineage, so it can be continued without ever touching the
   * original rollout the TUI/another window may still own.
   */
  async forkSameSession(
    agentId: string,
    nativeId: string,
    summaryCwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode = false
  ): Promise<Session | undefined> {
    const baseAgent = this.getAgent(agentId)
    if (!baseAgent) return undefined
    const existing = this.findByIdentity(agentId, nativeId)
    const agent = existing ? agentForSession(baseAgent, existing) : baseAgent
    if (
      ((agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web')
        ? agent.capabilities.sessionFork !== true
        : agent.capabilities.sessionFork === false)
    ) return undefined
    if (existing?.config.worktree) assertWorktreeAvailable(existing.config)
    const workspaceConfig = existing ? { projectId: existing.config.projectId, ...(existing.config.worktree ? { worktree: existing.config.worktree } : {}), requirementId: existing.config.requirementId, ...(existing.config.assistantSnapshot ? { assistantSnapshot: structuredClone(existing.config.assistantSnapshot) } : {}) } : undefined
    const existingCwd = validAbsoluteCwd(existing?.config.workdir)
    if (agent.adapter === 'zcode') {
      if (!existing?.zcodeState || compatibilityMode) throw new Error('ZCode 分叉需要本机已接入的原生会话')
      const runner = await this.ensureZCodeRunner(existing)
      const forkedNativeId = await runner.forkNative(point)
      const { session } = this.createSessionRecord(structuredClone(existing.config), existing.title)
      session.nativeSessionId = forkedNativeId
      session.zcodeState = { schemaVersion: 1, dataRootId: existing.zcodeState.dataRootId, workspaceKey: existing.zcodeState.workspaceKey,
        runtimeFingerprint: existing.zcodeState.runtimeFingerprint, deliveries: [] }
      session.forkedFrom = { agentId, nativeId, mode: 'same' }
      this.persistOrThrow()
      await this.ensureZCodeRunner(session)
      session.status = 'idle'; this.persistOrThrow()
      return session
    }
    const suppliedCwd = validAbsoluteCwd(summaryCwd)
    // Once UniAgent knows this native identity, its persisted session owns the
    // authoritative cwd. A stale/tampered history-row cwd must not redirect the
    // fork. Direct history previews (which have no local session) use the
    // validated cwd supplied by that ACP listing row.
    const workdir = existingCwd || suppliedCwd || process.env.HOME || '.'
    if (compatibilityMode) {
      const forked = await this.exportNativeSession(agentId, nativeId, agentId, point)
      if (!forked) return undefined
      forked.readOnly = false
      forked.forkedFrom = { agentId, nativeId, mode: 'compatible' }
      this.bumpSessionActivity(forked.id)
      this.persist()
      return forked
    }
    if (agent.adapter === 'deepseek') {
      const sourceConfig = existing && structuredClone(existing.config)
      if (point && agent.capabilities.protocol === 'web') throw new Error('DeepSeek 精确回合分叉尚未通过验证，请使用完整会话分叉')
      const res = agent.capabilities.protocol === 'web' ? await forkDeepSeekHostSession(nativeId)
        : await forkDeepSeekSession(nativeId, agent.bin, workdir, existing ? deepseekSessionRuntimeEnv(existing.id, sourceConfig!) : deepseekRuntimeEnv(), undefined, {
        model: sourceConfig?.model,
        effort: sourceConfig?.effort,
        mcpServers: handoffMcpServers(existing?.id),
        point
      })
      const forked = await this.importSession(agentId, res.nativeId, 'snapshot', res.cwd || workdir, undefined, false, undefined, workspaceConfig)
      if (!forked) throw new Error('DeepSeek 原生分叉已创建，但无法读取分支')
      forked.config = {
        ...forked.config,
        ...sourceConfig,
        model: res.model || sourceConfig?.model || forked.config.model,
        effort: res.effort || sourceConfig?.effort,
        workdir: res.cwd || sourceConfig?.workdir || forked.config.workdir
      }
      forked.readOnly = false
      forked.forkedFrom = { agentId, nativeId, mode: 'same' }
      this.bumpSessionActivity(forked.id)
      this.persist()
      return forked
    }
    if (agent.adapter === 'mcode') {
      if (point) throw new Error('MiniMax Code 不支持精确回合分叉，请使用完整会话分叉')
      const res = await forkMCodeSession(nativeId, agent.bin, workdir, mcodeSessionRuntimeEnv())
      const forked = await this.importSession(agentId, res.nativeId, 'snapshot', res.cwd, undefined, false, undefined, workspaceConfig)
      if (!forked) throw new Error('MiniMax Code 分叉已创建，但无法读取分支')
      forked.config = { ...forked.config, ...existing?.config, workdir: res.cwd, model: res.model || existing?.config.model || forked.config.model }
      forked.readOnly = false
      forked.forkedFrom = { agentId, nativeId, mode: 'same' }
      this.bumpSessionActivity(forked.id)
      this.persist()
      return forked
    }
    if (point) {
      const result = await forkHistoryAt(agent, nativeId, point)
      let forked: Session | undefined
      if (result.pendingClaudeFork) {
        const { session } = this.createSessionRecord({
          agentId,
          model: result.model || agent.defaultModel,
          workdir: result.cwd || workdir,
          ...workspaceConfig
        }, result.events.find((event) => event.type === 'user_message')?.payload.text || '分叉会话')
        forked = session
        forked.pendingClaudeFork = result.pendingClaudeFork
        const ref = { n: 0 }
        this.events.set(session.id, result.events.map((event) => ({ ...event, sessionId: session.id, seq: ref.n++ })))
        this.seqRefs.set(forked.id, ref)
      } else {
        forked = await this.importSession(agentId, result.nativeId!, 'snapshot', result.cwd || workdir, undefined, false, undefined, workspaceConfig)
      }
      if (!forked) throw new Error('原生分叉已创建，但无法读取分支，请刷新后重试')
      forked.status = 'idle'
      forked.origin = 'imported'
      forked.readOnly = false
      forked.forkedFrom = { agentId, nativeId, mode: 'same' }
      this.bumpSessionActivity(forked.id)
      this.persist()
      return forked
    }
    if (agent.adapter === 'kimi' || agent.adapter === 'grok') {
      const res = agent.adapter === 'kimi'
        ? await forkKimiWebSession(nativeId, agent.bin, workdir, existing ? kimiSessionRuntimeEnv(existing.id, existing.config) : {})
        : await forkBetaSession(agent.adapter, nativeId, agent.bin, workdir, {})
      const runtime = existing && agent.adapter === 'kimi' ? { ownerId: existing.id, config: existing.config } : undefined
      const forked = await (async () => {
        try {
          const imported = await this.importSession(agentId, res.nativeId, 'snapshot', res.cwd, undefined, false, runtime, workspaceConfig)
          if (!imported) throw new Error('原生分叉已创建，但无法读取分支')
          return imported
        } catch (error) {
          if (agent.adapter === 'grok' && ![...this.sessions.values()].some(session => session.nativeSessionId === res.nativeId)) {
            await deleteOwnedGrokFork(res.nativeId,agent.bin).catch(() => this.emit('nativeCleanupWarning',{agentId:'grok',message:'Grok 分叉导入失败且清理未确认，已保留归属记录。'}))
          }
          throw error
        }
      })()
      if ('dataHome' in res) forked.config.kimiDataHome = res.dataHome as string
      if (existing?.config.roleSnapshot) {
        forked.config = { ...existing.config, ...forked.config, projectId: existing.config.projectId, additionalDirectories: existing.config.additionalDirectories && [...existing.config.additionalDirectories], roleSnapshot: structuredClone(existing.config.roleSnapshot), permissionMode: existing.config.permissionMode }
        if (agent.adapter === 'kimi') forked.config.kimiRuntimeOwnerId = existing.config.kimiRuntimeOwnerId || existing.id
      }
      if (res.kimiThinking) forked.config.kimiThinking = res.kimiThinking
      forked.readOnly = false
      forked.forkedFrom = { agentId, nativeId, mode: 'same' }
      this.bumpSessionActivity(forked.id)
      this.persist()
      if (agent.adapter === 'grok') await retainGrokFork(res.nativeId,agent.bin)
      return forked
    }
    const res = await forkSameSession(agentId, nativeId)
    if (!res) return undefined
    const forked = await this.importSession(agentId, res.nativeId, 'snapshot', undefined, undefined, false, undefined, workspaceConfig)
    if (!forked) return undefined
    // Promote the fork to a writable branch and stamp its lineage.
    forked.readOnly = false
    forked.forkedFrom = { agentId, nativeId, mode: 'same' }
    this.bumpSessionActivity(forked.id)
    this.persist()
    return forked
  }

  /**
   * 需求5 — 换Agent分叉. Fork a read-only snapshot into another agent by
   * transplanting its normalized transcript into that agent's native history
   * (reuses exportNativeSession). This rebuild is potentially LOSSY (each CLI's
   * schema differs; opaque reasoning blobs can't cross), so the returned session
   * is labeled `mode:'cross'` and the UI must warn the user. Still writable +
   * carries lineage.
   */
  async forkCrossSession(
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ): Promise<Session | undefined> {
    const source = this.getAgent(sourceAgentId)
    const target = this.getAgent(targetAgentId)
    const sourceAllowed = isCrossForkSourceAgent(source)
    if (!sourceAllowed || !isCrossForkTargetAgent(target)) return undefined
    const forked = await this.exportNativeSession(sourceAgentId, nativeId, targetAgentId, point)
    if (!forked) return undefined
    forked.readOnly = false
    forked.forkedFrom = { agentId: sourceAgentId, nativeId, mode: 'cross' }
    this.bumpSessionActivity(forked.id)
    this.persist()
    return forked
  }

  /**
   * Doc10 (FR-E1) — reconstruct one file's before/after for the side-by-side
   * review panel. Resolves relative paths against the owning session's workdir so
   * the binary/oversize guards can stat the real file; the actual before/after
   * text is reconstructed from the unified-diff hunks (see reviewFiles.ts).
   */
  async reviewGetFilePair(req: ReviewFilePairReq): Promise<ReviewFilePair> {
    const session = this.sessions.get(req.sessionId)
    // 需求2/二 — a `turn` scope reads the frozen before/after snapshot from the
    // turn artifact so the review shows the COMPLETE file (no `⋯` folds) and never
    // leaks pre-existing dirty content. Falls through to the git/disk path when the
    // snapshot isn't available (older turns), which degrades to hunk context.
    if (req.scope?.kind === 'turn') {
      const art = await this.artifacts.read(req.sessionId, req.scope.turnId)
      const file = art?.files.find((f) => f.path === req.path || f.oldPath === req.path)
      if (file) {
        const base: ReviewFilePair = {
          path: file.path,
          kind: file.kind === 'rename' ? 'modify' : file.kind,
          before: '',
          after: ''
        }
        if (file.snapshotState === 'full') {
          return { ...base, before: file.before ?? '', after: file.after ?? '' }
        }
        if (file.snapshotState === 'binary') return { ...base, binary: true }
        if (file.snapshotState === 'too-large') return { ...base, tooLarge: true }
        return reviewGetFilePair({
          ...req,
          path: file.path,
          oldPath: file.oldPath,
          kind: base.kind,
          unifiedDiff: file.unifiedDiff
        })
      }
      // A historical turn snapshot must never fall through to the LIVE workspace
      // (that would show a later disk state under an old turn). Degrade only from
      // the requested turn's own diff when a full snapshot is unavailable.
      return reviewGetFilePair(req)
    }
    return reviewGetFilePair(req, session?.config.workdir)
  }

  // ── 需求3 turn-artifact capture ───────────────────────────────────────

  /**
   * Fold a streaming event into the live turn-capture record. `turn_started`
   * opens a capture keyed by the stable native turnId; prefer `diff_update`,
   * retaining `file_change` for providers that never emit an aggregate.
   */
  private captureTurnEvent(session: Session, ev: UAEvent): void {
    if (ev.type === 'turn_started') {
      const nativeTurnId = typeof ev.payload?.turnId === 'string' ? ev.payload.turnId.trim() : ''
      if (!nativeTurnId) return // connect-time turn_started carries only threadId
      const ref = this.seqRefs.get(session.id)
      this.turnCapture.set(session.id, {
        nativeTurnId,
        nativeThreadId: session.nativeSessionId || '',
        startSeq: ref ? ref.n : 0,
        startedAt: Date.now(),
        fileChanges: []
      })
    } else if (ev.type === 'diff_update') {
      const cap = this.turnCapture.get(session.id)
      if (!cap) return
      const diff = typeof ev.payload?.diff === 'string' ? ev.payload.diff : ''
      const turnId = typeof ev.payload?.turnId === 'string' ? ev.payload.turnId : ''
      if (!turnId || turnId === cap.nativeTurnId) cap.latestDiff = diff
    } else if (ev.type === 'file_change') {
      const cap = this.turnCapture.get(session.id)
      if (cap && (!ev.payload?.turnId || ev.payload.turnId === cap.nativeTurnId)) cap.fileChanges.push(ev)
    }
  }

  /**
   * A turn finished: persist its file artifact (before/after snapshots keyed by
   * native turnId) so a later rewind can reverse it. A turn with NO file changes
   * still gets a `files:[]` artifact so it remains a valid rewind node (rewinding
   * to it removes later turns without touching any file). Best-effort: a snapshot
   * failure must never disturb the completed turn.
   */
  private async finalizeTurnArtifact(session: Session): Promise<void> {
    const cap = this.turnCapture.get(session.id)
    this.turnCapture.delete(session.id)
    if (!cap) return // no turn_started captured (e.g. connect-time only)
    const nativeThreadId = cap.nativeThreadId || session.nativeSessionId || ''
    if (!nativeThreadId) return
    const ref = this.seqRefs.get(session.id)
    const startedAt = Date.now()
    this.logSession(session.id, 'artifact_finalization_started', { turnId: cap.nativeTurnId,
      fileChanges: cap.fileChanges.length, diffChars: cap.latestDiff?.length || 0 })
    const finalization = this.artifacts.finalize({
      sessionId: session.id,
      nativeThreadId,
      nativeTurnId: cap.nativeTurnId,
      startSeq: cap.startSeq,
      endSeq: ref ? ref.n : cap.startSeq,
      startedAt: cap.startedAt,
      completedAt: Date.now(),
      unifiedDiff: cap.latestDiff ?? '',
      fileChanges: cap.latestDiff === undefined ? cap.fileChanges : undefined,
      workdir: session.config.workdir
    }).then(() => {
      this.logSession(session.id, 'artifact_finalization_succeeded', { turnId: cap.nativeTurnId, durationMs: Date.now() - startedAt })
    }, () => {
      this.logSession(session.id, 'artifact_finalization_failed', { turnId: cap.nativeTurnId, durationMs: Date.now() - startedAt })
    })
    this.artifactFinalizations.add(finalization)
    try { await finalization } finally { this.artifactFinalizations.delete(finalization) }
  }

  /**
   * Doc(变更文件列表改 git-diff 驱动) — the live git change set for a session's
   * workdir (tracked changes + untracked files), so the review panel reflects the
   * IDE's Changes view instead of just what the agent touched this turn. Returns
   * `isGitRepo:false` when the workdir isn't a git repo → panel degrades.
   */
  async reviewGetChangeSet(sessionId: string, scope?: ReviewScope): Promise<ReviewChangeSet> {
    const session = this.sessions.get(sessionId)
    if (!session) return { isGitRepo: false, items: [] }
    // 需求一/二 — a `turn` scope returns ONLY that turn's frozen change set from
    // the artifact, so the review panel shows this turn's edits instead of the
    // whole working tree (pre-existing dirty files never leak in).
    if (scope?.kind === 'turn') {
      const summary = await this.artifacts.summary(sessionId, scope.turnId)
      const art = summary ? await this.artifacts.read(sessionId, scope.turnId) : null
      if (!summary) return { isGitRepo: false, items: [] }
      return {
        isGitRepo: false,
        items: summary.files.map((f) => {
          const full = art?.files.find((x) => x.path === f.path)
          return {
            path: f.path,
            ...(f.oldPath ? { oldPath: f.oldPath } : {}),
            kind: f.kind,
            tracked: true,
            added: f.added,
            removed: f.removed,
            unifiedDiff: full?.unifiedDiff ?? ''
          }
        })
      }
    }
    return getGitChangeSet(session.config.workdir, scope)
  }

  /**
   * 需求一/二/三 — the frozen per-turn artifact summary (native turnId keyed):
   * file list with add/remove counts, snapshot completeness and reversibility.
   * Drives the change card, the "完整" availability and the rewind preflight.
   */
  async getTurnArtifactSummary(
    sessionId: string,
    turnId: string
  ): Promise<TurnArtifactSummary | null> {
    return this.artifacts.summary(sessionId, turnId)
  }

  /**
   * 需求3（会话节点回退）— read-only preflight. Reports whether the session can be
   * rewound to just before `beforeTurnId` (the target turn), which turns/files
   * would be removed, and 1-based UI turn numbers for the confirm dialog. Never
   * mutates anything; the real rewind re-runs every check (proposal §6.6).
   */
  async previewSessionRewind(sessionId: string, beforeTurnId: string): Promise<RewindPreview> {
    const gate = this.rewindGate(sessionId)
    if (!gate.ok) return { allowed: false, reason: gate.reason, removeTurnIds: [], files: [] }
    const preview = await this.artifacts.previewRewind(
      sessionId, beforeTurnId, gate.session.config.workdir
    )
    const turns = await this.artifacts.list(sessionId)
    const targetIdx = turns.findIndex((t) => t.nativeTurnId === beforeTurnId)
    const ui =
      targetIdx >= 0
        ? {
            keepThroughTurn: targetIdx, // target is removed; keep the preceding turns
            removeFromTurn: targetIdx + 1,
            removeThroughTurn: turns.length
          }
        : {}
    return {
      allowed: preview.allowed,
      ...(preview.reason ? { reason: preview.reason } : {}),
      ...ui,
      removeTurnIds: preview.removeTurnIds,
      files: preview.files.map((f) => ({ path: f.path, kind: f.kind, reversible: f.reversible }))
    }
  }

  /**
   * 需求3 — execute the rewind as one orchestrated transaction (proposal §6.4/§6.5):
   *   1. re-check the gate (idle, writable, app-server, not already rewinding)
   *   2. persistent `thread/fork` BEFORE the target turn (never ephemeral)
   *   3. reverse-apply the file transaction (backup + atomic writes; rolls back on
   *      any failure so the working tree is never left partial)
   *   4. ONLY on success: switch `nativeSessionId` to the fork, reload the forked
   *      (already-truncated) native history, rebuild the live runner, persist
   *   5. return the target turn's user input as `prefillText` (never auto-sent)
   * ANY step failing leaves the Session on its original thread with files intact.
   */
  async rewindSession(sessionId: string, beforeTurnId: string): Promise<RewindResult> {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const gate = this.rewindGate(sessionId)
    if (!gate.ok) return { ok: false, error: gate.reason }
    const session = gate.session
    // Acquire synchronously with the gate: no send or second rewind can enter
    // during artifact lookup, before the first awaited operation.
    this.rewinding.add(sessionId)
    try {
      const agent = this.getAgent(session.config.agentId)
      if (!agent || (!usesAppServer(agent) && agent.adapter !== 'claude')) {
        return { ok: false, error: '当前 Agent 不支持会话回退' }
      }
      // Capture the target turn's user input + truncation point BEFORE mutation.
      const prefillText = this.targetTurnUserText(sessionId, beforeTurnId)
      // The previous turn's native id feeds the `lastTurnId` fallback for older
      // app-server builds that reject `beforeTurnId`.
      const turns = await this.artifacts.list(sessionId)
      const targetIdx = turns.findIndex((t) => t.nativeTurnId === beforeTurnId)
      if (targetIdx < 0) return { ok: false, error: '找不到目标轮的回退快照' }
      const previousTurnId = targetIdx > 0 ? turns[targetIdx - 1].nativeTurnId : undefined

      // Step 2 — persistent native fork first. A failure here means the session
      // and files are both untouched (proposal §6.7).
      let forkedThreadId: string | undefined
      const claudeTurnIds = new Map<string, string>()
      try {
        if (agent.adapter === 'claude') {
          if (!session.nativeSessionId) throw new Error('Claude 原生会话尚未就绪')
          const messages = await claudeSdkSessionOperation(agent.bin, session.config.workdir, 'history', session.nativeSessionId)
          const index = messages.findIndex((message: any) => message.uuid === beforeTurnId)
          if (index < 0) throw new Error('Claude 历史缺少目标回合，已停止回退')
          if (index > 0) {
            const fork = await claudeSdkSessionOperation(agent.bin, session.config.workdir, 'forkSession', { sessionId: session.nativeSessionId, messageId: messages[index - 1].uuid })
            if (!fork.sessionId || fork.sessionId === session.nativeSessionId) throw new Error('Claude SDK 未创建独立分支')
            forkedThreadId = fork.sessionId
            const copied = await claudeSdkSessionOperation(agent.bin, session.config.workdir, 'history', forkedThreadId)
            if (copied.length !== index) throw new Error('Claude 分叉历史长度与目标前缀不一致，已停止回退')
            for (let offset = 0; offset < index; offset++) claudeTurnIds.set(messages[offset].uuid, copied[offset].uuid)
          }
        } else {
          const streamer = this.ensureStreamerForFork(session, agent)
          forkedThreadId = await streamer.forkBeforeTurn(beforeTurnId, previousTurnId)
        }
      } catch (err: any) {
        return { ok: false, error: `原生会话分叉失败，当前会话与文件均未改变：${err?.message || err}` }
      }
      // Step 3 — file transaction. On failure the store restores every file from
      // its in-memory backup. The provider has no fork-delete API, so a failed
      // post-fork transaction can leave an unreachable native fork behind.
      const applied = await this.artifacts.applyRewind(
        sessionId, beforeTurnId, session.config.workdir
      )
      if (!applied.ok) return { ok: false, error: `${applied.error}；已创建的原生分叉可能保留` }
      // Step 4 — commit the session switch to the forked thread + reload history.
      // If this fails, undo the file transaction so the working tree and session
      // both stay on their pre-rewind state (proposal §6.5 — atomic).
      try {
        const rollbackIds = agent.adapter === 'claude' && forkedThreadId
          ? await this.artifacts.remapNativeTurns(session.id, forkedThreadId, claudeTurnIds) : undefined
        try {
          await this.commitRewind(session, forkedThreadId)
        } catch (error) { await rollbackIds?.(); throw error }
      } catch (err: any) {
        try {
          await applied.rollback()
        } catch (rollbackError: any) {
          return {
            ok: false,
            error: `回退持久化失败，且文件恢复不完整：${rollbackError?.message || rollbackError}；原错误：${err?.message || err}`
          }
        }
        return { ok: false, error: `回退持久化失败，文件与会话已恢复：${err?.message || err}` }
      }
      // Step 5 — the session/file transaction is committed. Manifest cleanup may
      // warn but must not turn that committed success into a false failure.
      let warning: string | undefined
      try { teamRuntime(sessionId)?.afterRewind?.() } catch (error) { warning = `会话已回退，但团队边界保存失败，请勿继续派单：${String(error)}` }
      try {
        await this.artifacts.trimFrom(sessionId, beforeTurnId)
      } catch (err: any) {
        warning = `回退已完成，但旧回合快照清理失败：${err?.message || err}`
      }
      const runtime = this.runtimeState(sessionId, this.events.get(sessionId) || [])
      return { ok: true, prefillText, restored: applied.restored, runtime, ...(warning ? { warning } : {}) }
    } finally {
      this.rewinding.delete(sessionId)
    }
  }

  /**
   * Shared preflight for preview + apply: the session must exist, be writable,
   * idle with no queued/pending work, use a fork-capable app-server agent, and
   * not already be mid-rewind (proposal §6.2).
   */
  private rewindGate(
    sessionId: string
  ): { ok: true; session: Session } | { ok: false; reason: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: '会话不存在' }
    if (this.nativeActionReservations.has(sessionId)) {
      return { ok: false, reason: '原生操作正在进行中' }
    }
    if (this.isTeamMember(sessionId)) return { ok: false, reason: '成员会话为只读，请通过 Leader 管理任务' }
    const teamReason = teamRuntime(sessionId)?.rewindReason?.()
    if (teamReason) return { ok: false, reason: teamReason }
    if (session.readOnly) return { ok: false, reason: '只读导入会话不支持回退' }
    if (this.rewinding.has(sessionId)) return { ok: false, reason: '回退正在进行中' }
    if ((this.pendingSends.get(sessionId) || 0) > 0) {
      return { ok: false, reason: '消息正在发送，请稍后再回退' }
    }
    if (this.isBusy(session.status) || (this.queues.get(sessionId)?.length ?? 0) > 0) {
      return { ok: false, reason: '当前仍有任务或排队消息，完成或取消后再回退' }
    }
    const agent = this.getAgent(session.config.agentId)
    if (!agent || (!usesAppServer(agent) && agent.adapter !== 'claude')) {
      return { ok: false, reason: '当前 Agent 不支持会话回退' }
    }
    return { ok: true, session }
  }

  /** The user-input text of the target turn (for prefilling the composer). */
  private targetTurnUserText(sessionId: string, turnId: string): string {
    const events = this.events.get(sessionId) || []
    const turn = events.find((e) => e.type === 'turn_started' && e.payload?.turnId === turnId)
    const boundary = turn ? turn.seq : Infinity
    let text = ''
    for (const e of events) {
      if (e.seq >= boundary) break
      if (
        (e.type === 'user_message' || e.type === 'goal_message') &&
        typeof e.payload?.text === 'string'
      ) text = e.payload.text
    }
    return text
  }

  /** Get (or build) the session's streamer so it can produce a persistent fork. */
  private ensureStreamerForFork(session: Session, agent: AgentDef): AppServerRunner {
    let streamer = this.streamers.get(session.id)
    if (!streamer) {
      const ref = this.seqRefs.get(session.id) || { n: 0 }
      this.seqRefs.set(session.id, ref)
      streamer = new AppServerRunner(session.id, ref, agent, session.config, session.nativeSessionId)
      this.bindAppServerDiagnostics(streamer, session.id)
      this.bindNativeCapabilityInvalidation(streamer, session)
      this.installMainStreamerOwner(session.id, streamer)
    }
    return streamer
  }

  /** Every reusable main runner forwards live provider skill changes once. */
  private bindNativeCapabilityInvalidation(streamer: AppServerRunner, session: Session): void {
    streamer.on('skillsChanged', () => {
      if (this.streamers.get(session.id) === streamer && this.sessions.get(session.id) === session) {
        this.emit('nativeCapabilitiesChanged', { agentId: session.config.agentId, workdir: session.config.workdir })
      }
    })
    streamer.on('mcpStatusChanged', (change: {
      name: string
      status: McpStartupStatus
      statusMessage?: string
    }) => {
      if (this.streamers.get(session.id) === streamer && this.sessions.get(session.id) === session) {
        this.emit('nativeMcpStatusChanged', {
          agentId: session.config.agentId,
          workdir: session.config.workdir,
          ...change
        })
      }
    })
  }

  /** Load the forked native history. A thin seam so tests can inject failures. */
  private loadForkedEvents(
    agentId: string,
    forkedThreadId: string
  ): ReturnType<typeof loadSessionEvents> {
    return loadSessionEvents(agentId, forkedThreadId)
  }

  /**
   * Commit a successful rewind ATOMICALLY. Every fallible step (history load,
   * persistence of the new native id) runs BEFORE any destructive in-memory swap,
   * so a failure leaves the session, its events, its seq ref and its live runner
   * exactly as they were — the old runner stays usable and the persisted store is
   * restored to the original native id (proposal §6.3/§6.5).
   *
   * Order:
   *   1. load the forked native history (throws → nothing mutated yet)
   *   2. flip session.nativeSessionId/status/updatedAt and persistOrThrow; on
   *      failure roll those fields back and best-effort re-persist the old value
   *   3. only now perform the irreversible swaps: dispose the old streamer and
   *      replace events + seq ref; the invoking renderer then pulls runtime state
   */
  private async commitRewind(session: Session, forkedThreadId: string | undefined): Promise<void> {
    const agent = this.getAgent(session.config.agentId)
    if (!agent) throw new Error('未找到 Agent')
    // (1) Fallible load — no in-memory mutation before this resolves.
    const { events } = forkedThreadId ? await this.loadForkedEvents(session.config.agentId, forkedThreadId) : { events: [] }
    const ref = { n: 0 }
    const stamped = events.map((e) => ({ ...e, sessionId: session.id, seq: ref.n++, ...(['user_message','goal_message'].includes(e.type) ? { payload: { ...e.payload, text: stripAssistantContext(String(e.payload.text || '')) } } : {}) }))

    // (2) Persist the new native identity FIRST, while the old runner/events are
    // still intact, so a persistence failure is fully recoverable.
    const prevNativeSessionId = session.nativeSessionId
    const prevStatus = session.status
    const prevUpdatedAt = session.updatedAt
    session.nativeSessionId = forkedThreadId
    session.status = 'idle'
    session.updatedAt = Date.now()
    try {
      this.persistOrThrow()
    } catch (err) {
      // rename already made the new bytes visible; keep memory aligned with disk
      // and finish the switch even though directory durability is uncertain.
      if (sessionStoreWriteCommitted(err)) {
        // continue below
      } else {
      // A not-committed atomic write left the old on-disk store intact; restore
      // memory to that same identity and keep the old runner/events untouched.
        session.nativeSessionId = prevNativeSessionId
        session.status = prevStatus
        session.updatedAt = prevUpdatedAt
        throw err
      }
    }

    // (3) Past the last fallible step — now do the irreversible swaps. Tear down
    // the streamer bound to the OLD thread so the next turn resumes the fork.
    this.disposeSession(session.id, true)
    this.events.set(session.id, stamped)
    this.emit('assistantHistoryTruncated', { sessionId: session.id, after: stamped.at(-1)?.ts || session.createdAt })
    this.seqRefs.set(session.id, ref)
    this.backendConfigCorrectionSeqs.delete(session.id)
    this.turnCapture.delete(session.id)
    this.bumpSessionActivity(session.id)
    this.logSession(session.id, 'session_rewound', {
      previousNativeSessionId: prevNativeSessionId,
      nativeSessionId: forkedThreadId,
      status: { from: prevStatus, to: 'idle' }
    })
    // Announce the settled state. The rewind IPC caller pulls the authoritative
    // runtime after this method resolves, so no second timeline push is needed.
    this.emit('statusChange', { sessionId: session.id, status: 'idle', updatedAt: session.updatedAt })
    this.emit('sessionUpdated', { session, hasLiveStreamer: false })
  }

  async runNativeAction(sessionId: string, action: NativeThreadAction): Promise<void> {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    if (this.teamQuestions.has(sessionId)) throw new Error('team_awaiting_user_answer')
    const teamStopVersion = this.teamStopVersions.get(sessionId) || 0
    const controlsNativeGoal = action.type === 'goal.update' || action.type === 'goal.clear'
    await this.withNativeActionReservation(sessionId, async (session) => {
      if (this.resolveProjectConfig) {
        this.replaceSessionConfig(session, this.resolveProjectConfig(session.config, true))
      }
      await this.getEvents(sessionId)
      if (this.sessions.get(sessionId) !== session || this.rewinding.has(sessionId)) return
      if (session.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      const baseAgent = this.getAgent(session.config.agentId)
      if (baseAgent?.adapter === 'grok' && !session.agentContract?.grokNative?.confirmed && agentForSession(baseAgent, session).capabilities.nativeGoal !== true) {
        const runner = this.ensureProtocolRunner(session, baseAgent)
        if (runner instanceof ACPRunner) await runner.probeSession()
      }
      const effectiveAgent = baseAgent ? agentForSession(baseAgent, session) : undefined
      if (action.type === 'goal.set' || action.type === 'goal.clear' || action.type === 'goal.update') {
        if (effectiveAgent?.capabilities.nativeGoal !== true && !(controlsNativeGoal && effectiveAgent?.adapter === 'grok' && session.goal)) {
          throw new Error(`unsupported_target_capability: ${effectiveAgent?.name || '目标 Agent'} does not support native goal`)
        }
      } else if (effectiveAgent?.capabilities.nativeReview !== true) {
        throw new Error(`unsupported_target_capability: ${effectiveAgent?.name || '目标 Agent'} does not support native review`)
      }
      if (action.type === 'goal.set' || action.type === 'review.start') teamRuntime(sessionId)?.beforeUserTurn?.()
      if (action.type === 'goal.set') {
        const objective = action.objective.trim()
        await this.setGoalAndRun(session, objective, action.tokenBudget, action.maxRounds)
        return
      }
      if (effectiveAgent?.adapter === 'claude' && (action.type === 'goal.clear' || action.type === 'goal.update')) {
        if (action.type === 'goal.update' && action.action === 'pause') {
          this.interrupt(session.id)
          if (session.goal) this.updateGoalState(session, { ...session.goal, status: 'paused', autonomous: false, updatedAt: Date.now() })
        } else if (action.type === 'goal.update' && ['resume', 'edit'].includes(action.action)) {
          if (!session.goal) throw new Error('Claude 当前没有可恢复的 Goal')
          await this.setGoalAndRun(session, action.objective || session.goal.objective, action.tokenBudget, action.maxRounds)
        } else if (action.type === 'goal.clear' || action.action === 'clear') {
          const runner = this.claudeSdkRunners.get(session.id)
          if (runner && this.runners.has(session.id)) {
            this.interrupt(session.id)
            await runner.stopClaudeSdk()
            await Promise.all(this.artifactFinalizations)
          }
          if (runner?.hasClaudeSdkConnection()) await runner.clearClaudeGoal()
          else { this.setStatus(session, 'running'); this.runOneShot(session, effectiveAgent, '/goal clear') }
        } else throw new Error('Claude 原生 Goal 支持暂停、恢复、编辑和清除')
        return
      }
      if (effectiveAgent?.adapter === 'claude' && action.type === 'review.start') {
        const prompt = claudeReviewPrompt(action.draft, session.config)
        this.record(session.id, { type: 'user_message', payload: { text: prompt } })
        this.setStatus(session, 'running')
        this.runOneShot(session, effectiveAgent, prompt)
        return
      }
      if (effectiveAgent?.adapter === 'zcode' && (action.type === 'goal.clear' || action.type === 'goal.update')) {
        const runner = await this.ensureZCodeRunner(session)
        await runner.updateGoal(action.type === 'goal.clear' ? { action: 'clear' } : action)
        return
      }
      if (['deepseek', 'grok', 'kimi', 'mcode'].includes(effectiveAgent?.adapter || '') && (action.type === 'goal.clear' || action.type === 'goal.update')) {
        const runner = this.ensureProtocolRunner(session, effectiveAgent!)
        const update: NativeGoalUpdate = action.type === 'goal.clear' ? { action: 'clear' } : {
          action: action.action,
          ...(action.objective === undefined ? {} : { objective: action.objective }),
          ...(action.maxRounds === undefined ? {} : { maxRounds: action.maxRounds }),
          ...(action.tokenBudget === undefined ? {} : { tokenBudget: action.tokenBudget }),
          ...(action.reason === undefined ? {} : { reason: action.reason })
        }
        if (effectiveAgent?.adapter === 'deepseek') {
          if (update.tokenBudget !== undefined) throw new Error('DeepSeek native goals do not support an exact token budget; maxRounds is a separate round limit')
        } else if (effectiveAgent?.adapter === 'mcode') {
          // MiniMax Code patches the objective and the token budget, and moves
          // the goal between active and paused. It has no round limit.
          if (update.maxRounds !== undefined) throw new Error('当前 Agent 不支持原生 Goal 轮数限制')
          if (!['pause', 'resume', 'clear', 'edit'].includes(update.action) || update.reason !== undefined) {
            throw new Error('当前 Agent 不支持此原生 Goal 状态更新，仅支持暂停、恢复、编辑或清除')
          }
        } else {
          if (update.maxRounds !== undefined) throw new Error('当前 Agent 不支持原生 Goal 轮数限制')
          if (update.tokenBudget !== undefined) throw new Error('当前 Agent 不支持修改原生 Goal Token 预算')
          if (!['pause', 'resume', 'clear'].includes(update.action) || update.objective !== undefined || update.reason !== undefined) {
            throw new Error('当前 Agent 不支持此原生 Goal 状态更新，仅支持暂停、恢复或清除')
          }
        }
        const goal = await runner.updateGoal(update)
        if (this.sessions.get(session.id) === session && this.protocolRunners.get(session.id) === runner) this.updateGoalState(session, goal)
        return
      }
      if (action.type === 'goal.update') throw new Error('当前 Agent 不支持原生 Goal 状态更新')
      const runner = this.ensureStreamerForNativeAction(session)
      if (action.type === 'goal.clear') {
        await runner.clearGoal()
        return
      }
      this.setStatus(session, 'running')
      try {
        await runner.startReview(action.draft)
      } catch (error) {
        if (this.sessions.get(session.id) === session && session.status !== 'cancelling') {
          this.setStatus(session, 'idle')
        }
        throw error
      }
    }, controlsNativeGoal)
  }

  async setCollaborationMode(
    sessionId: string,
    mode: 'default' | 'plan'
  ): Promise<void> {
    if (this.isTeamMember(sessionId)) throw new Error('team_session_config_locked')
    if (mode !== 'default' && mode !== 'plan') throw new Error('invalid_collaboration_mode')
    const claudeSession = this.sessions.get(sessionId)
    if (claudeSession?.config.agentId === 'claude') {
      const runner = this.runners.get(sessionId)
      if (claudeSession.status === 'awaiting-approval' && mode === 'default' && runner?.pendingPlanModeExitRequestId()) {
        await this.respondToRequest(sessionId, runner.pendingPlanModeExitRequestId()!, { decision: 'accept' })
      } else this.requireWritableIdleSession(sessionId)
      claudeSession.config = { ...claudeSession.config, collaborationMode: mode, permissionMode: mode === 'plan' ? 'plan' : 'ask' }
      await runner?.setClaudePermissionMode(mode === 'plan' ? 'plan' : 'default')
      this.persist()
      this.emit('sessionUpdated', { session: claudeSession, hasLiveStreamer: false })
      return
    }
    const grokSession = this.sessions.get(sessionId)
    const grokAgent = grokSession ? this.getAgent(grokSession.config.agentId) : undefined
    if (grokSession && grokAgent?.adapter === 'zcode') {
      if (!this.isReady(grokSession.status) || (this.queues.get(sessionId)?.length ?? 0) > 0) throw new Error('当前仍有任务或排队消息，请稍后操作')
      const runner = await this.ensureZCodeRunner(grokSession)
      await runner.updateConfig({ ...grokSession.config, collaborationMode: mode })
      grokSession.config.collaborationMode = mode
      if (grokSession.zcodeState) grokSession.zcodeState.pendingConfig = {
        version: (grokSession.zcodeState.pendingConfig?.version ?? 0) + 1, planEnabled: mode === 'plan'
      }
      this.persistOrThrow(); this.emitAgentUpdate(grokSession)
      return
    }
    if (grokSession && (isACPAdapter(grokAgent?.adapter))) {
      if (this.nativeActionReservations.has(sessionId)) throw new Error('native_action_in_progress')
      if (!this.isReady(grokSession.status) || (this.queues.get(sessionId)?.length ?? 0) > 0) {
        throw new Error('当前仍有任务或排队消息，请稍后再操作')
      }
      if (mode === 'plan' && !grokSession.agentContract && grokAgent.adapter === 'grok') {
        throw new Error('当前 Grok 会话尚未协商 Plan 能力')
      }
      this.nativeActionReservations.add(sessionId)
      try {
        let runner = this.protocolRunners.get(sessionId)
        if (!runner) {
          const ref = this.seqRefs.get(sessionId) || { n: 0 }
          this.seqRefs.set(sessionId, ref)
          runner = new (grokAgent.adapter === 'deepseek' && grokAgent.capabilities.protocol === 'web' ? DeepSeekHostRunner : grokAgent.adapter === 'kimi' ? KimiWebRunner : ACPRunner)(
            sessionId,
            ref,
            grokAgent,
            grokSession.config,
            grokSession.nativeSessionId,
            () => grokAgent.adapter === 'deepseek' ? deepseekSessionRuntimeEnv(sessionId, grokSession.config)
              : grokAgent.adapter === 'kimi' ? kimiSessionRuntimeEnv(sessionId, grokSession.config)
              : grokAgent.adapter === 'mcode' ? mcodeSessionRuntimeEnv()
              : {}
          )
          this.bindProtocolRunner(grokSession, runner)
          this.protocolRunners.set(sessionId, runner)
        }
        await runner.setCollaborationMode(mode)
        grokSession.config = { ...grokSession.config, collaborationMode: mode }
        grokSession.updatedAt = Date.now()
        this.bumpSessionActivity(sessionId)
        this.persist()
        this.emit('sessionUpdated', { session: grokSession, hasLiveStreamer: false })
      } finally {
        this.nativeActionReservations.delete(sessionId)
      }
      return
    }
    if (mode === 'default') {
      const session = this.sessions.get(sessionId)
      const runner = this.streamers.get(sessionId)
      const requestId = runner?.pendingPlanModeExitRequestId()
      if (
        session?.status === 'awaiting-approval' &&
        runner &&
        requestId &&
        (await this.respondToRequest(sessionId, requestId, { decision: 'cancelled' }))?.handled
      ) {
        await runner.setCollaborationMode(mode)
        session.config = { ...session.config, collaborationMode: mode }
        session.updatedAt = Date.now()
        runner.updateConfig(session.config)
        this.persist()
        this.emit('sessionUpdated', { session, hasLiveStreamer: true })
        return
      }
    }
    await this.withNativeActionReservation(sessionId, async (session) => {
      if (this.resolveProjectConfig) {
        this.replaceSessionConfig(session, this.resolveProjectConfig(session.config, true))
      }
      const runner = this.ensureStreamerForNativeAction(session)
      await runner.setCollaborationMode(mode)
      session.config = { ...session.config, collaborationMode: mode }
      session.updatedAt = Date.now()
      runner.updateConfig(session.config)
      this.persist()
      this.emit('sessionUpdated', { session, hasLiveStreamer: true })
    })
  }

  async createNativeActionSession(
    config: SessionConfig,
    action: NativeThreadAction,
    meta?: { handoffId?: string; handoffWaiting?: boolean },
    reservedSessionId?: string
  ): Promise<Session> {
    if (action.type === 'goal.clear' || action.type === 'goal.update') throw new Error('新会话只支持设置 Goal 或启动 Review')
    const agent = this.getAgent(config.agentId)
    const capability = action.type === 'goal.set' ? 'nativeGoal' : 'nativeReview'
    if (agent?.capabilities[capability] !== true) {
      throw new Error(`unsupported_target_capability: ${agent?.name || '目标 Agent'} does not support ${capability === 'nativeGoal' ? 'native goal' : 'native review'}`)
    }
    const title = action.type === 'goal.set' ? action.objective.trim() : 'Review'
    const reserved = reservedSessionId ? this.sessions.get(reservedSessionId) : undefined
    if (reservedSessionId && (!reserved?.config.worktree || reserved.status !== 'draft')) throw new Error('工作树创建草稿不可用')
    const { session } = reserved ? { session: reserved } : this.createSessionRecord(config, title, meta)
    assertWorktreeAvailable(session.config)
    const reservesNativeAction = action.type === 'review.start' || ['deepseek', 'grok', 'kimi', 'mcode'].includes(agent?.adapter || '')
    if (reservesNativeAction) this.nativeActionReservations.add(session.id)
    this.setStatus(session, 'running')
    try {
      if (action.type === 'goal.set') {
        await this.setGoalAndRun(session, title, action.tokenBudget, action.maxRounds)
      } else if (agent?.adapter === 'claude') {
        const prompt = claudeReviewPrompt(action.draft, session.config)
        this.record(session.id, { type: 'user_message', payload: { text: prompt } })
        this.runOneShot(session, agent, prompt)
      } else {
        const runner = this.ensureStreamerForNativeAction(session)
        await runner.startReview(action.draft)
      }
      return session
    } catch (error) {
      if (session.config.worktree) {
        this.setStatus(session, session.nativeSessionId ? 'error' : 'draft')
        this.persist()
      } else this.discardUnstartedSession(session)
      throw error
    } finally {
      if (reservesNativeAction) this.nativeActionReservations.delete(session.id)
    }
  }

  private requireWritableIdleSession(sessionId: string, controlsNativeGoal = false, configChange = false): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.nativeActionReservations.has(sessionId)) throw new Error('native_action_in_progress')
    if (session.archived) throw new Error('已归档会话不支持原生操作')
    if (session.readOnly) throw new Error('只读会话不支持原生操作')
    if (this.rewinding.has(sessionId)) throw new Error('回退正在进行中')
    if ((this.pendingSends.get(sessionId) || 0) > 0) {
      throw new Error('消息正在发送，请稍后再操作')
    }
    const agent = this.getAgent(session.config.agentId)
    const activeNativeGoal = controlsNativeGoal && ['claude', 'deepseek', 'grok', 'kimi', 'mcode', 'zcode'].includes(agent?.adapter || '') &&
      session.goal?.continuation === 'native' && (this.protocolRunners.has(sessionId) || this.zcodeRunners.has(sessionId) || this.runners.has(sessionId)) &&
      ['running', 'queued', 'awaiting-approval'].includes(session.status)
    const configChangeReady = configChange && (session.status === 'error' || session.status === 'draft')
    if (!activeNativeGoal && ((!this.isReady(session.status) && !configChangeReady) || (this.queues.get(sessionId)?.length ?? 0) > 0)) {
      throw new Error('当前仍有任务或排队消息，请稍后再操作')
    }
    if (!agent || (!usesAppServer(agent) && !['claude', 'deepseek', 'grok', 'kimi', 'mcode', 'zcode'].includes(agent.adapter))) throw new Error('当前 Agent 不支持原生操作')
    return session
  }

  private async withNativeActionReservation<T>(
    sessionId: string,
    action: (session: Session) => Promise<T>,
    controlsNativeGoal = false
  ): Promise<T> {
    const session = this.requireWritableIdleSession(sessionId, controlsNativeGoal)
    const teamStopVersion = this.teamStopVersions.get(sessionId) || 0
    this.nativeActionReservations.add(sessionId)
    try {
      await this.assertSessionNotExternallyOccupied(session)
      if (session.teamBinding && (this.teamStopVersions.get(sessionId) || 0) !== teamStopVersion) throw new Error('team_start_cancelled')
      return await action(session)
    } finally {
      this.nativeActionReservations.delete(sessionId)
    }
  }

  private ensureStreamerForNativeAction(session: Session): AppServerRunner {
    const agent = this.getAgent(session.config.agentId)
    if (!agent || !usesAppServer(agent)) throw new Error('当前 Agent 不支持原生操作')
    return this.ensureMainStreamer(session, agent)
  }

  /** Publish Goal intent once; native ACP Goal drivers own their prompts. */
  private async setGoalAndRun(
    session: Session,
    objective: string,
    tokenBudget?: number,
    maxRounds?: number
  ): Promise<void> {
    const claude = this.getAgent(session.config.agentId)
    if (claude?.adapter === 'claude') {
      if (session.config.permissionMode === 'plan') throw new Error('请先退出 Plan 模式再设置 Goal')
      const goal = claudeGoal(objective, tokenBudget, maxRounds)
      this.record(session.id, { type: 'goal_message', payload: { text: goal.objective, command: 'goal' } })
      this.updateGoalState(session, goal)
      this.setStatus(session, 'running')
      this.runOneShot(session, claude, `/goal ${goal.objective}`)
      return
    }
    const teamStopVersion = this.teamStopVersions.get(session.id) || 0
    const agent = this.getAgent(session.config.agentId)
    if (agent?.adapter === 'zcode') {
      if (tokenBudget !== undefined || maxRounds !== undefined) throw new Error('ZCode Goal 不支持精确 Token 预算或轮数限制')
      const runner = await this.ensureZCodeRunner(session)
      await runner.flushConfig()
      if (session.config.collaborationMode === 'plan') throw new Error('请先退出 Plan 模式再设置 Goal')
      this.commitQueue(session, [...(this.queues.get(session.id) || []), buildDurableQueueItem('/goal ' + objective)])
      if (session.zcodeState) session.zcodeState.suspendedAfterStop = false
      this.dispatchPendingQueue(session)
      return
    }
    const nativeDriver = ['deepseek', 'grok', 'kimi', 'mcode'].includes(agent?.adapter || '')
    if (agent?.adapter === 'deepseek' && tokenBudget !== undefined) throw new Error('DeepSeek native goals do not support an exact token budget; maxRounds is a separate round limit')
    if (agent?.adapter === 'kimi' && tokenBudget !== undefined) throw new Error('Kimi Code 原生 Goal 不支持 Token 预算')
    if (agent?.adapter !== 'deepseek' && maxRounds !== undefined) throw new Error('当前 Agent 不支持原生 Goal 轮数限制')
    const preparedRun = this.prepareUserMessageRun(session, objective, {})
    const runner = nativeDriver ? this.ensureProtocolRunner(session, preparedRun.agent, preparedRun.config) : preparedRun.streamer
    if (!runner) throw new Error('当前 Agent 不支持原生 Goal')
    const events = this.events.get(session.id)
    const ref = this.seqRefs.get(session.id)
    if (!events || !ref) throw new Error('会话事件流不存在')
    const event: UAEvent = {
      sessionId: session.id,
      seq: ref.n++,
      ts: Date.now(),
      type: 'goal_message',
      state: 'success',
      payload: { text: objective, command: 'goal' }
    }
    const insertionIndex = events.length
    try {
      if (nativeDriver) {
        await (this.protocolConfigTails.get(session.id) || Promise.resolve())
        await (runner as ACPRunner).updateConfig(preparedRun.config)
      }
      const goal = await runner.setGoal({ objective, ...(tokenBudget === undefined ? {} : { tokenBudget }), ...(maxRounds === undefined ? {} : { maxRounds }) })
      if (nativeDriver && this.sessions.get(session.id) === session) this.updateGoalState(session, goal)
    } catch (error) {
      if (session.status === 'draft') this.discardPreparedRun(session, preparedRun)
      throw error
    }
    if (this.sessions.get(session.id) !== session || this.events.get(session.id) !== events) return
    if (session.teamBinding && (this.teamStopVersions.get(session.id) || 0) !== teamStopVersion) { this.discardPreparedRun(session, preparedRun); throw new Error('team_start_cancelled') }
    events.splice(insertionIndex, 0, event)
    if (agent?.adapter === 'deepseek') this.deepseekEvents.append(session.id, event)
    this.logEvent(event)
    this.rememberSubmittedUserMessage(session, event)
    this.bumpSessionActivity(session.id)
    this.emit('event', event)
    if (session.teamBinding && (this.teamStopVersions.get(session.id) || 0) !== teamStopVersion) { this.discardPreparedRun(session, preparedRun); return }
    if (nativeDriver) {
      if (session.goal?.status === 'complete' && this.isReady(session.status)) this.setStatus(session, 'completed')
    } else this.run(session, objective, undefined, undefined, preparedRun)
  }

  private discardUnstartedSession(session: Session): void {
    const protocol = this.protocolRunners.get(session.id)
    protocol?.removeAllListeners(); protocol?.dispose(); this.protocolRunners.delete(session.id)
    const streamer = this.removeMainStreamerOwner(session.id)
    streamer?.removeAllListeners()
    streamer?.dispose()
    this.recoveryStartTokens.delete(session.id)
    this.historyLoads.delete(session.id)
    this.sendTails.delete(session.id)
    this.pendingSends.delete(session.id)
    this.activeQueueItems.delete(session.id)
    this.turnCapture.delete(session.id)
    this.nativeActionReservations.delete(session.id)
    this.removeSessionOwner(session.id)
    this.events.delete(session.id)
    this.queues.delete(session.id)
    this.seqRefs.delete(session.id)
    this.backendConfigCorrectionSeqs.delete(session.id)
    this.persist()
  }

  private updateGoalState(session: Session, goal: GoalState | undefined): void {
    const currentInput = this.currentTurnInput(session)
    const completedCurrentGoal =
      goal?.status === 'complete' &&
      currentInput?.type === 'goal_message' &&
      currentInput.payload?.text === goal.objective
    const wasBusy = this.isBusy(session.status)
    if (goal) session.goal = goal
    else delete session.goal
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    this.persist()
    this.emit('sessionUpdated', {
      session,
      hasLiveStreamer: this.streamers.has(session.id)
    })
    if (completedCurrentGoal && wasBusy) {
      this.streamers.get(session.id)?.completeGoalTurn(goal.timeUsedSeconds * 1000)
    }
    if (goal?.continuation === 'native' && goal.autonomous &&
      session.status !== 'awaiting-approval' && session.status !== 'cancelling' && !session.archived) {
      this.setStatus(session, 'running')
    }
  }

  /** Compress an existing live Codex / TraeX session without creating a runner. */
  async compactSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('session_not_found')
    if (this.nativeActionReservations.has(sessionId)) throw new Error('原生操作正在进行中')
    if (session.archived) throw new Error('会话已归档，无法压缩上下文')
    if (session.readOnly) throw new Error('只读会话无法压缩上下文')
    if (this.rewinding.has(sessionId)) throw new Error('回退正在进行中')
    if ((this.pendingSends.get(sessionId) || 0) > 0) throw new Error('消息正在发送，请稍后再压缩上下文')
    const agent = this.getAgent(session.config.agentId)
    const effectiveAgent = agent ? agentForSession(agent, session) : undefined
    const kimiCompact = ['kimi', 'grok', 'deepseek', 'mcode', 'zcode'].includes(effectiveAgent?.adapter || '') &&
      effectiveAgent?.capabilities.commands?.some(command => command.replace(/^\//, '') === 'compact') === true
    const claudeCompact = effectiveAgent?.adapter === 'claude' && !!session.nativeSessionId
    if (!agent || (!usesAppServer(agent) && !kimiCompact && !claudeCompact)) throw new Error('当前 Agent 不支持手动压缩上下文')
    if (this.isBusy(session.status) || (this.queues.get(sessionId)?.length ?? 0) > 0) {
      throw new Error('Agent 运行中，无法压缩上下文')
    }
    if (!this.isReady(session.status)) throw new Error('当前会话尚未空闲，无法压缩上下文')
    if (kimiCompact || claudeCompact) {
      await this.sendMessage(sessionId, '/compact')
      return
    }
    const streamer = this.streamers.get(sessionId)
    if (!streamer) throw new Error('当前会话尚未建立实时连接，请先发送一条消息')
    await streamer.compact()
  }

  /**
   * 需求2（侧边对话 /side）— has this session got a running app-server thread we can
   * fork an ephemeral side branch from? Side chat requires the parent's native
   * thread id (set once the first main turn negotiated it) AND a codex/traex agent.
   */
  canOpenSideChat(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || isToolSession(session)) return false
    const baseAgent = this.getAgent(session.config.agentId)
    const agent = baseAgent && agentForSession(baseAgent, session)
    if (!agent || !(usesAppServer(agent) || ['claude', 'kimi', 'grok', 'deepseek', 'mcode', 'zcode'].includes(agent.adapter) && agent.capabilities.sideChat === true)) return false
    return !!session.nativeSessionId
  }

  private appendEphemeralEvent(events: UAEvent[], event: UAEvent): void {
    const id = event.payload?.id
    // Match renderer compaction merging across force-send messages.
    const turnStart = events.findLastIndex(
      (item) => event.type === 'context_compaction'
        ? item.type === 'turn_completed'
        : item.type === 'user_message' || item.type === 'goal_message'
    )
    const index = id
      ? events.findLastIndex(
          (item, itemIndex) =>
            itemIndex > turnStart && item.type === event.type && item.payload?.id === id
        )
      : -1
    if (index >= 0) events[index] = withCompactionTiming(event, events[index])
    else events.push(event)
  }

  /**
   * 需求2（侧边对话 /side）— send a message into the session's ephemeral side branch,
   * lazily creating the side runner (fork off the main rollout) on the first send.
   * Side events are buffered on `sideEvents` and pushed on the 'sideEvent' channel;
   * they NEVER enter `this.events` (main timeline) or persist to the parent rollout.
   * A separate UniAgent cache restores the transcript/config across App restarts.
   */
  async sendSideMessage(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    activatePlan = false,
    bubble?: TurnBubble
  ): Promise<void> {
    if (this.sidePromotions.has(sessionId)) throw new Error('侧边对话正在转换，请稍后重试')
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const session = this.sessions.get(sessionId)
    if (!session) return
    const agent = this.getAgent(session.config.agentId)
    if (!agent || !this.canOpenSideChat(sessionId)) {
      this.recordSide(sessionId, {
        type: 'system_notice',
        payload: { kind: 'warning', text: '当前 Agent 不支持侧边对话，或主会话尚未就绪。' }
      })
      return
    }
    if (agent.adapter === 'grok' && attachments?.some(item => item.kind === 'image')) {
      attachments = await prepareGrokAttachments(attachments)
      if (this.sessions.get(sessionId) !== session || this.sidePromotions.has(sessionId)) throw new Error('图片准备期间侧边对话已变化，请重试')
    }
    if (this.sideStatus.get(sessionId) && this.sideStatus.get(sessionId) !== 'idle') {
      if (activatePlan) throw new Error('Plan 命令只能在空闲且无排队消息的侧边对话中使用')
      this.enqueueSideMessage(sessionId, prompt, attachments, nativeContext, bubble)
      return
    }
    const side = this.ensureSideStreamer(sessionId)
    if ((this.sideQueues.get(sessionId)?.length ?? 0) > 0) {
      if (activatePlan) throw new Error('Plan 命令只能在空闲且无排队消息的侧边对话中使用')
      this.enqueueSideMessage(sessionId, prompt, attachments, nativeContext, bubble)
      this.dispatchSideQueue(sessionId, side)
      return
    }
    if (activatePlan) {
      await side.setCollaborationMode('plan')
      this.sideConfigs.set(sessionId, { ...this.sideConfig(sessionId), collaborationMode: 'plan' })
      side.updateConfig(this.sideConfig(sessionId))
    }
    this.startSideTurn(sessionId, side, prompt, attachments, nativeContext, activatePlan ? 'plan' : undefined, bubble)
  }

  async forceSendSideMessage(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    bubble?: TurnBubble
  ): Promise<void> {
    if (this.sidePromotions.has(sessionId)) throw new Error('侧边对话正在转换，请稍后重试')
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const side = this.sideStreamers.get(sessionId)
    if (!side || this.sideStatus.get(sessionId) === 'idle') {
      await this.sendSideMessage(sessionId, prompt, attachments, nativeContext, false, bubble)
      return
    }
    if (side instanceof BetaSideRunner || side instanceof ZCodeSideRunner || side instanceof ClaudeSdkSideRunner) {
      if (!side.supportsSteer() || nativeContext) {
        this.enqueueSideMessage(sessionId, prompt, attachments, nativeContext, bubble)
        return
      }
      let receipt: void | { appendedToTurn: boolean; nativePromptId?: string }
      try { receipt = await side.steer(prompt, attachments, nativeContext) }
      catch (error) {
        this.enqueueSideMessage(sessionId, prompt, attachments, nativeContext, bubble, error instanceof ACPTimeoutError || /ACP.*(?:协议|关闭|退出|超时)|connection.*(?:closed|timeout)|kimi_web_(?:connection|request_aborted)/i.test(String(error)))
        return
      }
      this.recordSide(sessionId, { type: 'user_message', payload: { text: prompt, attachments, nativeContext, ...bubblePayload(bubble),
        appendedToTurn: receipt?.appendedToTurn ?? true, ...(receipt?.nativePromptId ? { nativePromptId: receipt.nativePromptId } : {}) } })
      return
    }
    this.recordSide(sessionId, {
      type: 'user_message',
      payload: { text: prompt, attachments, nativeContext, ...bubblePayload(bubble) }
    })
    await side.steer(prompt, attachments, nativeContext)
  }

  /** 需求2 — interrupt the in-flight side turn (best effort). */
  interruptSide(sessionId: string): void {
    this.sideQueues.set(sessionId, [])
    if (!this.sideStreamers.has(sessionId)) {
      this.setSideStatus(sessionId, 'idle')
      return
    }
    this.setSideStatus(sessionId, 'cancelling')
    this.sideStreamers.get(sessionId)?.interrupt()
  }

  /** 需求2 — snapshot the buffered side transcript (for renderer hydration). */
  getSideEvents(sessionId: string): UAEvent[] {
    return this.sideEvents.get(sessionId) ? [...this.sideEvents.get(sessionId)!] : []
  }

  /** 需求2 — current side-chat run status (idle when no side runner exists). */
  getSideStatus(sessionId: string): SideChatStatus {
    return this.sideStatus.get(sessionId) || 'idle'
  }

  getSideState(sessionId: string): SideChatState {
    return {
      config: structuredClone(this.sideConfig(sessionId)),
      status: this.getSideStatus(sessionId),
      queue: structuredClone(this.sideQueues.get(sessionId) || []),
      hasLiveStreamer: this.sideStreamers.has(sessionId)
    }
  }

  updateSideConfig(sessionId: string, patch: Partial<SessionConfig>): SideChatState {
    if (this.getSideStatus(sessionId) !== 'idle' || (this.sideQueues.get(sessionId)?.length ?? 0) > 0) {
      throw new Error('侧边对话仍有任务或排队消息')
    }
    const allowed = new Set(['model', 'modelSource', 'effort', 'permissionMode', 'fastMode', 'maxMode', 'kimiThinking', 'zcodeModelSelection'])
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error('invalid_side_config_patch')
    const current = this.sideConfig(sessionId)
    const agent = this.getAgent(current.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${current.agentId}`)
    const requested = { ...current, ...patch }
    if (patch.model !== undefined && patch.model !== current.model && !Object.prototype.hasOwnProperty.call(patch, 'modelSource')) {
      delete requested.modelSource
    }
    requested.permissionMode = resolveCreatePermissionMode(agent, requested.permissionMode)
    const config = this.normalizeAgentConfig(requested).config
    { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, config) }
    this.sideConfigs.set(sessionId, config)
    this.sideStreamers.get(sessionId)?.updateConfig(config)
    this.persistSideChats()
    this.emitSideState(sessionId)
    return this.getSideState(sessionId)
  }

  async setSideCollaborationMode(sessionId: string, mode: 'default' | 'plan'): Promise<SideChatState> {
    if (mode !== 'default' && mode !== 'plan') throw new Error('invalid_collaboration_mode')
    const side = this.ensureSideStreamer(sessionId)
    if (this.getSideStatus(sessionId) !== 'idle') {
      const requestId = side.pendingPlanModeExitRequestId()
      if (mode !== 'default' || !requestId) throw new Error('侧边对话运行中，无法切换模式')
      const result = await side.respond(requestId, { decision: 'cancelled' })
      if (result.handled) {
        this.setSideStatus(sessionId, (this.sideQueues.get(sessionId)?.length ?? 0) > 0 ? 'queued' : 'running')
      }
    }
    await side.setCollaborationMode(mode)
    const config = { ...this.sideConfig(sessionId), collaborationMode: mode }
    this.sideConfigs.set(sessionId, config)
    side.updateConfig(config)
    this.persistSideChats()
    this.emitSideState(sessionId)
    return this.getSideState(sessionId)
  }

  async runSideNativeAction(sessionId: string, action: NativeThreadAction): Promise<void> {
    if (action.type === 'goal.update') throw new Error('侧边对话不支持更新原生 Goal')
    if (this.getSideStatus(sessionId) !== 'idle' || (this.sideQueues.get(sessionId)?.length ?? 0) > 0) {
      throw new Error('侧边对话仍有任务或排队消息')
    }
    const side = this.ensureSideStreamer(sessionId)
    if (action.type === 'goal.clear') {
      await side.clearGoal()
      return
    }
    if (action.type === 'goal.set') {
      const objective = action.objective.trim()
      await side.setGoal({ objective, ...(action.tokenBudget === undefined ? {} : { tokenBudget: action.tokenBudget }) })
      this.startSideTurn(sessionId, side, objective, undefined, undefined, 'goal')
      return
    }
    this.setSideStatus(sessionId, 'running')
    try {
      await side.startReview(action.draft)
    } catch (error) {
      this.setSideStatus(sessionId, 'idle')
      throw error
    }
  }

  async compactSideChat(sessionId: string): Promise<void> {
    if (this.getSideStatus(sessionId) !== 'idle' || (this.sideQueues.get(sessionId)?.length ?? 0) > 0) {
      throw new Error('侧边对话运行中，无法压缩上下文')
    }
    const side = this.sideStreamers.get(sessionId)
    if (!side) throw new Error('侧边对话尚未建立实时连接，请先发送一条消息')
    if (side instanceof BetaSideRunner || side instanceof ZCodeSideRunner || side instanceof ClaudeSdkSideRunner) this.setSideStatus(sessionId, 'running')
    try { await side.compact() }
    catch (error) { this.setSideStatus(sessionId, 'idle'); throw error }
  }

  async respondSideRequest(sessionId: string, requestId: string, answer: any, bubble?: TurnBubble): Promise<AppServerRespondResult> {
    const session = this.sessions.get(sessionId)
    if (!session || session.readOnly || session.archived || this.sidePromotions.has(sessionId) || this.getSideStatus(sessionId) === 'cancelling') throw new Error('当前侧边对话无法回答提问')
    const key = `${sessionId}:side:${requestId}`
    if (this.answeringAsyncQuestions.has(key)) throw new Error('回答正在提交，请稍候')
    const side = this.sideStreamers.get(sessionId)
    const events = this.sideEvents.get(sessionId) || []
    const original = events.findLast(event => interactionRequestKey(event) === requestId)
    if (!original || original.payload.interactionExpired || original.payload.submittedAnswer !== undefined) throw new Error('提问已处理或已失效')
    this.answeringAsyncQuestions.add(key)
    try {
      const send = async (text: string): Promise<void> => {
        if (!this.canOpenSideChat(sessionId) || this.getSideStatus(sessionId) !== 'idle' || (this.sideQueues.get(sessionId)?.length ?? 0)) throw new Error('请等待侧边对话空闲后重试')
        await this.sendSideMessage(sessionId, bubble?.source === 'weixin' ? appendWeixinContext(text) : bubble?.source === 'feishu' ? appendFeishuContext(text) : text, undefined, undefined, false, bubble)
      }
      let result: AppServerRespondResult
      if (requestId.startsWith(ASYNC_QUESTION_PREFIX)) {
        if (!isSkippedQuestionAnswer(answer)) {
          const text = asyncQuestionReply(original, answer)
          const prompt = bubble?.source === 'weixin' ? appendWeixinContext(text) : bubble?.source === 'feishu' ? appendFeishuContext(text) : text
          if (this.getSideStatus(sessionId) === 'idle') await send(text)
          else {
            if (!side || this.getSideStatus(sessionId) !== 'running') throw new Error('请等待侧边对话恢复运行或空闲后重试')
            if (side instanceof BetaSideRunner || side instanceof ZCodeSideRunner || side instanceof ClaudeSdkSideRunner) {
              if (!side.supportsSteer()) throw new Error('当前 Agent 不支持运行中回答')
              await side.steer(prompt)
            } else await side.steerStrict(prompt)
            if (this.sideStreamers.get(sessionId) !== side) throw new Error('侧边对话已切换，请检查回答状态')
            this.recordSide(sessionId, { type: 'user_message', payload: { text: prompt, ...bubblePayload(bubble), appendedToTurn: true } })
          }
        }
        result = { handled: true, hasPendingRequests: isSkippedQuestionAnswer(answer) && this.getSideStatus(sessionId) === 'awaiting-approval' }
      } else if (requestId.startsWith(LOCAL_PLAN_PREFIX)) {
        const latest = latestLocalPlanRequest(events)
        if (!latest || latest.payload.requestId !== requestId || this.getSideStatus(sessionId) !== 'idle' || (this.sideQueues.get(sessionId)?.length ?? 0)) throw new Error('计划已失效或侧边对话尚未空闲')
        if (!['approved', 'rejected', 'cancelled'].includes(answer?.decision)) throw new Error('无效的计划操作')
        const feedback = typeof answer.feedback === 'string' ? answer.feedback.trim() : ''
        if (answer.decision === 'rejected' && !feedback) throw new Error('请填写计划修改意见')
        if (answer.decision === 'approved') {
          const previousMode = this.sideConfig(sessionId).collaborationMode || 'plan'
          await this.setSideCollaborationMode(sessionId, 'default')
          try { await send('Implement the plan.') }
          catch (error) { await this.setSideCollaborationMode(sessionId, previousMode).catch(() => undefined); throw error }
        } else if (answer.decision === 'rejected') await send(feedback)
        result = { handled: true, hasPendingRequests: false }
      } else {
        if (!side || original.state !== 'pending') return { handled: false, hasPendingRequests: false }
        if (['question', 'elicitation'].includes(original.payload.kind) && !isMcpToolApproval(original.payload.params) && !['cancel', 'decline'].includes(answer?.action)) {
          const kind = questionAnswerKind(original.payload.kind, original.payload.method)
          const fields = normalizeQuestions(kind, original.payload.params)
          if (fields.length) validateQuestionAnswer(kind, fields, answer)
        }
        result = await side.respond(requestId, answer)
        if (!result.handled || this.sideStreamers.get(sessionId) !== side) return { handled: false, hasPendingRequests: false }
      }
      if (this.sessions.get(sessionId) !== session || this.sideEvents.get(sessionId) !== events) throw new Error('侧边对话已切换，请检查回答状态')
      // Remove the runner's bare resolution and retain the full question and answer.
      const raw = events.findLastIndex(event => event !== original && event.type === 'approval_request' && event.payload.requestId === requestId && event.state !== 'pending')
      if (raw >= 0) events.splice(raw, 1)
      const index = events.findLastIndex(event => interactionRequestKey(event) === requestId)
      const latest = events[index] || original
      const resolved: UAEvent = { ...latest, state: 'success', payload: { ...latest.payload, submittedAnswer: answer } }
      if (index >= 0) events[index] = resolved
      this.persistSideChats(); this.logEvent(resolved, 'side'); this.emit('sideEvent', { sessionId, event: resolved })
      if (!result.hasPendingRequests && this.getSideStatus(sessionId) === 'awaiting-approval') this.setSideStatus(sessionId, (this.sideQueues.get(sessionId)?.length ?? 0) > 0 ? 'queued' : 'running')
      return result
    } finally { this.answeringAsyncQuestions.delete(key) }
  }

  private expireSideRequests(sessionId: string, plansOnly = false): void {
    const events = this.sideEvents.get(sessionId) || []
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      const requestId = interactionRequestKey(event)
      if (!requestId || event.payload.interactionExpired || event.payload.submittedAnswer !== undefined) continue
      if (plansOnly && event.payload.method !== 'local/plan') continue
      if (plansOnly && this.answeringAsyncQuestions.has(`${sessionId}:side:${requestId}`)) continue
      const expired: UAEvent = { ...event, ...(isAsyncQuestion(event) ? {} : { state: 'cancelled' as const }), payload: { ...event.payload, interactionExpired: true } }
      events[index] = expired
      this.logEvent(expired, 'side'); this.emit('sideEvent', { sessionId, event: expired })
    }
  }

  dequeueSideMessage(sessionId: string, itemId: string): void {
    const queue = this.sideQueues.get(sessionId) || []
    const wasEditing = this.sideEditingItems.get(sessionId) === itemId
    this.sideQueues.set(sessionId, queue.filter((item) => item.id !== itemId))
    if (wasEditing) this.setSideQueueEditing(sessionId, null)
    if (this.sideStatus.get(sessionId) === 'queued' && this.sideQueues.get(sessionId)!.length === 0) {
      this.sideStatus.set(sessionId, 'running')
    }
    this.emitSideState(sessionId)
    this.persistSideChats()
  }

  promoteSideMessage(sessionId: string, itemId: string): void {
    const side = this.sideStreamers.get(sessionId)
    const queue = this.sideQueues.get(sessionId) || []
    const item = queue.find((entry) => entry.id === itemId)
    if (!side || !item || this.getSideStatus(sessionId) === 'idle') return
    if (side instanceof BetaSideRunner || side instanceof ZCodeSideRunner || side instanceof ClaudeSdkSideRunner) {
      if (!side.supportsSteer() || item.nativeContext || item.state === 'steering' || item.deliveryUncertain) return
      this.sideQueues.set(sessionId, queue.map(entry => entry.id === itemId ? { ...entry, state: 'steering' as const } : entry))
      this.emitSideState(sessionId)
      this.persistSideChats()
      void side.steer(item.prompt, item.attachments, item.nativeContext).then(receipt => {
        if (this.sideStreamers.get(sessionId) !== side || !(this.sideQueues.get(sessionId) || []).some(entry => entry.id === itemId)) return
        this.sideQueues.set(sessionId, (this.sideQueues.get(sessionId) || []).filter(entry => entry.id !== itemId))
        this.recordSide(sessionId, { type:'user_message', payload:{text:item.prompt, attachments:item.attachments, nativeContext:item.nativeContext,
          appendedToTurn: receipt?.appendedToTurn ?? true, ...(receipt?.nativePromptId ? { nativePromptId: receipt.nativePromptId } : {})} })
        this.emitSideState(sessionId)
        if (this.getSideStatus(sessionId) === 'idle' && !side.isRunning() && !this.sideEditingItems.has(sessionId) && receipt?.appendedToTurn !== false) this.dispatchSideQueue(sessionId, side)
      }).catch((error) => {
        if (this.sideStreamers.get(sessionId) !== side) return
        const uncertain = error instanceof ACPTimeoutError || /ACP.*(?:协议|关闭|退出|超时)|connection.*(?:closed|timeout)|kimi_web_(?:connection|request_aborted)/i.test(String(error))
        this.sideQueues.set(sessionId, (this.sideQueues.get(sessionId) || []).map(entry => entry.id === itemId
          ? { ...entry, state: 'pending' as const, ...(uncertain ? { deliveryUncertain: true } : {}) } : entry))
        this.persistSideChats()
        this.emitSideState(sessionId)
      })
      return
    }
    this.sideQueues.set(sessionId, queue.filter((entry) => entry.id !== itemId))
    this.recordSide(sessionId, {
      type: 'user_message',
      payload: { text: item.prompt, attachments: item.attachments, nativeContext: item.nativeContext }
    })
    this.emitSideState(sessionId)
    void side.steer(item.prompt, item.attachments, item.nativeContext)
  }

  editSideMessage(
    sessionId: string,
    itemId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext
  ): void {
    const queue = this.sideQueues.get(sessionId) || []
    if (!queue.some((entry) => entry.id === itemId)) return
    this.sideQueues.set(
      sessionId,
      queue.map((entry) => (entry.id === itemId ? { ...entry, prompt, attachments, nativeContext, deliveryUncertain: undefined } : entry))
    )
    this.persistSideChats()
    this.emitSideState(sessionId)
  }

  /**
   * 需求（队列二次编辑）— freeze/unfreeze the side FIFO queue while its item is
   * rewritten. Side dispatch is also head-only, so locking the session pauses the
   * whole side queue until the edit resolves.
   */
  setSideQueueEditing(sessionId: string, itemId: string | null): void {
    if (itemId) {
      if (!(this.sideQueues.get(sessionId) || []).some((entry) => entry.id === itemId)) return
      this.sideEditingItems.set(sessionId, itemId)
      return
    }
    if (!this.sideEditingItems.delete(sessionId)) return
    const side = this.sideStreamers.get(sessionId)
    if (!side) return
    // Resume only when idle between turns and something is still queued.
    if (this.getSideStatus(sessionId) === 'idle' && (this.sideQueues.get(sessionId)?.length ?? 0) > 0) {
      this.dispatchSideQueue(sessionId, side)
    }
  }

  /** Turn a settled ephemeral side branch into a normal persisted session. */
  async promoteSideToSession(sessionId: string): Promise<Session> {
    const source = this.sessions.get(sessionId)
    const sideEvents = this.sideEvents.get(sessionId)
    if (!source || !sideEvents?.some((event) => event.type === 'user_message')) {
      throw new Error('侧边对话暂无可转换的内容')
    }
    if (this.getSideStatus(sessionId) !== 'idle') {
      throw new Error('侧边对话仍在运行，请等待结束后再转换')
    }
    if ((this.sideQueues.get(sessionId)?.length ?? 0) > 0 || this.sideEditingItems.has(sessionId)) {
      throw new Error('侧边对话仍有排队或编辑中的消息')
    }

    if (this.sidePromotions.has(sessionId)) throw new Error('侧边对话正在转换，请稍后重试')
    this.sidePromotions.add(sessionId)
    try {
      const side = this.ensureSideStreamer(sessionId)
      let events = structuredClone(sideEvents)
      const promotedId = 's_' + nanoid(10)
      const config = structuredClone(this.sideConfig(sessionId))
      this.setSideStatus(sessionId, 'running')
      let nativeSessionId: string
      try {
        nativeSessionId = await side.forkPersistent(events, promotedId)
      } catch (error) {
        if (this.sideStreamers.get(sessionId) === side) this.setSideStatus(sessionId, 'idle')
        throw error
      }
      const latestEvents = this.sideEvents.get(sessionId)
      // Native telemetry can arrive after done while the SDK creates the fork.
      const contentCount = (items: UAEvent[]) => items.filter(event => !(event.type === 'system_notice' && event.payload.kind === 'token_speed')).length
      if (
        this.sessions.get(sessionId) !== source ||
        this.sideStreamers.get(sessionId) !== side ||
        this.getSideStatus(sessionId) !== 'running' ||
        !latestEvents || contentCount(latestEvents) !== contentCount(events)
      ) {
        await side.deleteThread(nativeSessionId).catch(() => {})
        throw new Error('侧边对话内容已变更，请重试')
      }
      events = structuredClone(latestEvents)
      const firstUser = events.find((event) => event.type === 'user_message')
      let promoted: Session
      try {
        promoted = await this.persistForkSession(source, nativeSessionId, events,
          deriveSessionTitle(firstUser?.payload?.text) || `${source.title} · 侧边对话`, config, promotedId)
      } catch (error) {
        await side.deleteThread(nativeSessionId).catch(() => {})
        this.setSideStatus(sessionId, 'idle')
        throw error
      }
      const agent = this.getAgent(config.agentId)!
      if (side instanceof BetaSideRunner) await side.retainThread(nativeSessionId)
      if (agent.adapter === 'codex') this.ensureMainStreamer(promoted, agent, config, true, side as AppServerRunner)
      this.closeSideChat(sessionId)
      return promoted
    } finally {
      this.sidePromotions.delete(sessionId)
    }
  }

  private async persistForkSession(
    source: Session, nativeSessionId: string, transcript: UAEvent[], title: string,
    config: SessionConfig = source.config, id = 's_' + nanoid(10)
  ): Promise<Session> {
    const ref = { n: 0 }
    const events = transcript.map((event) => ({ ...event, sessionId: id, seq: ref.n++ }))
    const now = Date.now()
    const session: Session = {
      id,
      title,
      config: structuredClone(config),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      nativeSessionId,
      origin: 'created',
      readOnly: false
    }
    if (config.agentId === 'zcode' && source.zcodeState) session.zcodeState = { schemaVersion: 1,
      dataRootId: source.zcodeState.dataRootId, workspaceKey: source.zcodeState.workspaceKey, runtimeFingerprint: source.zcodeState.runtimeFingerprint, deliveries: [] }
    if (config.agentId === 'deepseek') await this.deepseekEvents.replace(id, events)
    this.installSessionOwner(session)
    this.events.set(id, events)
    this.seqRefs.set(id, ref)
    this.queues.set(id, [])
    try {
      this.persistOrThrow()
    } catch (error) {
      if (!sessionStoreWriteCommitted(error)) {
        this.removeSessionOwner(id)
        this.events.delete(id)
        this.seqRefs.delete(id)
        this.queues.delete(id)
        if (config.agentId === 'deepseek') await this.deepseekEvents.delete(id)
        throw error
      }
    }
    return session
  }

  /**
   * 需求2 — close & discard the session's side branch (new /side, archive, delete).
   * `keepCache` preserves both the native thread and transcript during shutdown.
   */
  closeSideChat(sessionId: string, keepCache = false): void {
    if (!keepCache) this.expireSideRequests(sessionId)
    const side = this.sideStreamers.get(sessionId)
    side?.removeAllListeners()
    if (side instanceof ZCodeSideRunner) {
      const disposal = side.disposeForkAndWait(keepCache)
      this.zcodeSideDisposals.set(sessionId, disposal)
      void disposal.finally(() => { if (this.zcodeSideDisposals.get(sessionId) === disposal) this.zcodeSideDisposals.delete(sessionId) }).catch(() => undefined)
    } else side?.disposeFork(keepCache)
    this.sideStreamers.delete(sessionId)
    this.sideStatus.delete(sessionId)
    this.sideQueues.delete(sessionId)
    this.sideEditingItems.delete(sessionId)
    if (!keepCache) {
      this.sideEvents.delete(sessionId)
      this.sideSeqRefs.delete(sessionId)
      this.sideConfigs.delete(sessionId)
      this.sideNativeSessionIds.delete(sessionId)
      this.persistSideChats()
    }
  }

  private sideConfig(sessionId: string): SessionConfig {
    const existing = this.sideConfigs.get(sessionId)
    if (existing) {
      const config = this.normalizeAgentConfig(existing).config
      if (config !== existing) this.sideConfigs.set(sessionId, config)
      return config
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('session_not_found')
    const config = structuredClone(session.config)
    const agent = this.getAgent(config.agentId)
    if (agent?.adapter === 'kimi') config.kimiRuntimeOwnerId ||= session.id
    this.sideConfigs.set(sessionId, config)
    return config
  }

  private ensureSideStreamer(sessionId: string): SideRunner {
    if (this.worktreeTransitions.has(sessionId)) throw new Error('正在切换工作目录，请稍后再操作')
    const owner = this.sessions.get(sessionId)
    if (owner) assertWorktreeNotRemoving(owner.config)
    if (owner) this.assertAgentReady?.(owner.config.agentId)
    assertWorktreeAvailable(this.sideConfig(sessionId))
    const existing = this.sideStreamers.get(sessionId)
    if (existing) return existing
    const session = this.sessions.get(sessionId)
    if (!session?.nativeSessionId) throw new Error('侧边对话需要主会话已就绪')
    const agent = this.getAgent(session.config.agentId)
    if (!agent || !this.canOpenSideChat(sessionId)) throw new Error('当前 Agent 不支持侧边对话')
    if (!this.sideSeqRefs.has(sessionId)) this.sideSeqRefs.set(sessionId, { n: 0 })
    if (!this.sideEvents.has(sessionId)) this.sideEvents.set(sessionId, [])
    if (!this.sideQueues.has(sessionId)) this.sideQueues.set(sessionId, [])
    if (agent.adapter === 'claude') {
      const side = new ClaudeSdkSideRunner(sessionId, this.sideSeqRefs.get(sessionId)!, agent, this.sideConfig(sessionId), session.nativeSessionId, this.sideNativeSessionIds.get(sessionId))
      this.bindSideStreamer(sessionId, side); this.sideStreamers.set(sessionId, side); this.emitSideState(sessionId)
      return side
    }
    if (agent.adapter === 'zcode') {
      const side = new ZCodeSideRunner(sessionId, this.sideSeqRefs.get(sessionId)!, this.sideConfig(sessionId), session.nativeSessionId,
        () => this.ensureZCodeRunner(session), this.zcodePool, this.sideNativeSessionIds.get(sessionId), this.zcodeSideDisposals.get(sessionId))
      this.bindSideStreamer(sessionId, side); this.sideStreamers.set(sessionId, side); this.emitSideState(sessionId)
      return side
    }
    if (isACPAdapter(agent.adapter)) {
      const side = new BetaSideRunner(sessionId, this.sideSeqRefs.get(sessionId)!, agent,
        this.sideConfig(sessionId), session.nativeSessionId, this.sideNativeSessionIds.get(sessionId))
      this.bindSideStreamer(sessionId, side)
      this.sideStreamers.set(sessionId, side)
      this.emitSideState(sessionId)
      return side
    }
    const side = new AppServerRunner(
      sessionId,
      this.sideSeqRefs.get(sessionId)!,
      agent,
      this.sideConfig(sessionId),
      agent.adapter === 'codex' ? this.sideNativeSessionIds.get(sessionId) : undefined
    )
    const priorSideEvents = structuredClone(this.sideEvents.get(sessionId)!)
    side.setForkTranscript(priorSideEvents)
    const parent = this.streamers.get(sessionId) || this.ensureMainStreamer(session, agent)
    side.setForkPreparation(async (events) => {
      const shared = agent.adapter === 'codex'
      const threadId = await parent.forkSideSnapshot(this.events.get(sessionId) || [], events, shared ? this.sideConfig(sessionId) : undefined)
      return { threadId, cleanup: () => shared ? side.deleteThread(threadId) : parent.deleteThread(threadId) }
    }, agent.adapter === 'codex' ? parent : undefined)
    this.bindSideStreamer(sessionId, side)
    this.sideStreamers.set(sessionId, side)
    this.emitSideState(sessionId)
    return side
  }

  private bindSideStreamer(sessionId: string, side: SideRunner): void {
    if (side instanceof AppServerRunner) this.bindAppServerDiagnostics(side, sessionId, 'side')
    side.on('nativeThreadReady', (threadId: string) => {
      if (this.sideStreamers.get(sessionId) !== side) return
      this.sideNativeSessionIds.set(sessionId, threadId)
      this.persistSideChats()
    })
    side.on('event', (event: UAEvent) => {
      if (this.sideStreamers.get(sessionId) !== side) return
      const events = this.sideEvents.get(sessionId)
      event = withInteractionState(event, events || [])
      if (events) {
        const existing = side instanceof ZCodeSideRunner && event.payload.id ? events.findIndex(item => item.type === event.type &&
          (item.payload.id === event.payload.id || item.payload.nativeSessionId === event.payload.nativeSessionId &&
            (typeof event.payload.entityId === 'string' && item.payload.entityId === event.payload.entityId
              || event.payload.kind === 'context' && item.payload.kind === 'context'))) : -1
        if (existing >= 0) { event = { ...event, seq: events[existing].seq, ts: events[existing].ts }; events[existing] = event }
        else this.appendEphemeralEvent(events, event)
      }
      this.logEvent(event, 'side')
      this.emit('sideEvent', { sessionId, event })
      if (event.type === 'approval_request' && event.state === 'pending') {
        this.setSideStatus(sessionId, 'awaiting-approval')
      }
    })
    side.on('done', (result?: { failed?: boolean }) => {
      if (this.sideStreamers.get(sessionId) !== side) return
      if (!(side instanceof ClaudeSdkSideRunner)) side.setForkTranscript(this.sideEvents.get(sessionId) || [])
      this.persistSideChats()
      if (side instanceof ZCodeSideRunner && result?.failed) { this.setSideStatus(sessionId, 'idle'); return }
      this.logSession(sessionId, 'runner_done', { runner: side instanceof BetaSideRunner ? 'acp' : 'app-server', channel: 'side' })
      // 需求（队列二次编辑）— the frozen side queue is just pending messages;
      // with dispatch held nothing runs, so rest at idle (spinner off). The
      // frozen items stay queued and setSideQueueEditing(null) resumes them.
      if (this.sideEditingItems.has(sessionId)) {
        this.setSideStatus(sessionId, 'idle')
        return
      }
      this.dispatchSideQueue(sessionId, side)
    })
    side.on('steerFailed', ({ prompt, attachments, nativeContext }: QueueItem) => {
      if (this.sideStreamers.get(sessionId) === side) {
        this.enqueueSideMessage(sessionId, prompt, attachments, nativeContext)
      }
    })
    side.on('collaborationModeChanged', (mode: 'default' | 'plan') => {
      if (this.sideStreamers.get(sessionId) !== side) return
      this.sideConfigs.set(sessionId, { ...this.sideConfig(sessionId), collaborationMode: mode })
      if (side instanceof AppServerRunner) side.updateConfig(this.sideConfig(sessionId))
      this.persistSideChats()
      this.emitSideState(sessionId)
    })
    side.on('configCorrection', (correction: Pick<SessionConfig, 'model' | 'maxMode'>) => {
      if (this.sideStreamers.get(sessionId) !== side) return
      const config = this.normalizeAgentConfig({ ...this.sideConfig(sessionId), ...correction }).config
      this.sideConfigs.set(sessionId, config)
      if (side instanceof AppServerRunner) side.updateConfig(config)
      this.persistSideChats()
      this.emitSideState(sessionId)
    })
    side.on('skillsChanged', () => {
      if (this.sideStreamers.get(sessionId) !== side) return
      const config = this.sideConfig(sessionId)
      this.emit('nativeCapabilitiesChanged', { agentId: config.agentId, workdir: config.workdir })
    })
    side.on('mcpStatusChanged', (change: { name: string; status: McpStartupStatus; statusMessage?: string }) => {
      if (this.sideStreamers.get(sessionId) !== side) return
      const config = this.sideConfig(sessionId)
      this.emit('nativeMcpStatusChanged', { agentId: config.agentId, workdir: config.workdir, ...change })
    })
  }

  private startSideTurn(
    sessionId: string,
    side: SideRunner,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    command?: ComposerCommand,
    bubble?: TurnBubble
  ): void {
    this.setSideStatus(sessionId, 'running')
    this.recordSide(sessionId, {
      type: command === 'goal' ? 'goal_message' : 'user_message',
      payload: { text: prompt, attachments, nativeContext, ...(command ? { command } : {}), ...bubblePayload(bubble) }
    })
    void side.startTurn(prompt, attachments, nativeContext)
  }

  private enqueueSideMessage(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    bubble?: TurnBubble,
    deliveryUncertain = false
  ): void {
    const queue = this.sideQueues.get(sessionId) || []
    this.sideQueues.set(sessionId, [...queue, {
      id: 'side-q_' + nanoid(6), prompt, attachments, nativeContext,
      ...(deliveryUncertain ? { deliveryUncertain: true } : {}),
      ...(bubble?.comments?.length ? { comments: bubble.comments } : {}),
      ...(bubble?.displayText ? { displayText: bubble.displayText } : {})
    }])
    this.setSideStatus(sessionId, 'queued')
  }

  private dispatchSideQueue(sessionId: string, side: SideRunner): void {
    const queue = this.sideQueues.get(sessionId) || []
    const [head, ...rest] = queue
    if (head?.deliveryUncertain || head?.state === 'steering' || head?.state === 'dispatching') { this.setSideStatus(sessionId, 'idle'); return }
    this.sideQueues.set(sessionId, rest)
    this.persistSideChats()
    if (!head) {
      this.setSideStatus(sessionId, 'idle')
      return
    }
    this.startSideTurn(sessionId, side, head.prompt, head.attachments, head.nativeContext, undefined, {
      comments: head.comments,
      displayText: head.displayText
    })
  }

  private setSideStatus(sessionId: string, status: SideChatStatus): void {
    this.sideStatus.set(sessionId, status)
    if (status === 'idle') {
      const events = this.sideEvents.get(sessionId) || []
      const request = latestLocalPlanRequest(events)
      if (request?.state === 'pending' && !events.some(event => event.type === 'approval_request' && event.payload.requestId === request.payload.requestId)) this.recordSide(sessionId, { type: 'approval_request', state: 'pending', payload: { ...request.payload, localPlanShared: true } })
    }
    this.persistSideChats()
    this.emit('sideStatus', { sessionId, status })
    this.emitSideState(sessionId)
  }

  private emitSideState(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.emit('sideState', { sessionId, state: this.getSideState(sessionId) })
  }

  /** 需求2 — append to the side transcript buffer + push on the side channel. */
  private recordSide(sessionId: string, partial: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>): void {
    if (partial.type === 'user_message' || partial.type === 'goal_message') this.expireSideRequests(sessionId, true)
    if (!this.sideSeqRefs.has(sessionId)) this.sideSeqRefs.set(sessionId, { n: 0 })
    if (!this.sideEvents.has(sessionId)) this.sideEvents.set(sessionId, [])
    const ref = this.sideSeqRefs.get(sessionId)!
    const ev: UAEvent = { sessionId, seq: ref.n++, ts: Date.now(), ...partial }
    this.appendEphemeralEvent(this.sideEvents.get(sessionId)!, ev)
    this.persistSideChats()
    this.logEvent(ev, 'side')
    this.emit('sideEvent', { sessionId, event: ev })
  }

  /**
   * 选中即评论 / 详情 — send a message into the session's ephemeral DETAIL branch,
   * lazily forking a runner off the main rollout on the first send. Mirrors
   * `sendSideMessage` but on the independent detail maps + 'detailEvent' channel,
   * so the 详情 popover and the 侧边对话 drawer never share a runner. Detail events
   * NEVER enter `this.events` and never persist to the parent rollout.
   */
  async explainDetailSelection(sessionId: string, context: DetailExplanationContext): Promise<void> {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const session = this.sessions.get(sessionId)
    if (!session) return
    const agent = this.getAgent(session.config.agentId)
    if (!agent || (!usesAppServer(agent) && agent.adapter !== 'claude') || !session.nativeSessionId) {
      this.recordDetail(sessionId, {
        type: 'system_notice',
        payload: { kind: 'warning', text: '详情解释需要 Codex / TraeX 且主会话已就绪。' }
      })
      return
    }
    // One selection owns one fresh ephemeral branch. This also closes the race
    // between replacing an open popover and starting its new explanation.
    this.closeDetail(sessionId)
    const detail = this.ensureDetailStreamer(sessionId, session, agent)
    this.detailExplanationState.set(sessionId, {})
    const prompt = buildDetailExplanationPrompt(context)
    this.recordDetail(sessionId, {
      type: 'user_message',
      payload: { text: prompt, hidden: true, displayText: `解释：${context.selectedText.trim()}` },
    })
    this.detailStatus.set(sessionId, 'running')
    this.emit('detailStatus', { sessionId, status: 'running' })
    void detail.startTurn(prompt)
  }

  async sendDetailMessage(sessionId: string, prompt: string, attachments?: Attachment[]): Promise<void> {
    if (this.isTeamMember(sessionId)) throw new Error('team_member_read_only')
    const session = this.sessions.get(sessionId)
    if (!session) return
    const agent = this.getAgent(session.config.agentId)
    if (!agent || (!usesAppServer(agent) && agent.adapter !== 'claude') || !session.nativeSessionId) {
      this.recordDetail(sessionId, {
        type: 'system_notice',
        payload: { kind: 'warning', text: '详情解释需要 Codex / TraeX 且主会话已就绪。' }
      })
      return
    }
    const detail = this.ensureDetailStreamer(sessionId, session, agent)
    this.recordDetail(sessionId, { type: 'user_message', payload: { text: prompt } })
    this.detailStatus.set(sessionId, 'running')
    this.emit('detailStatus', { sessionId, status: 'running' })
    void detail.startTurn(prompt, attachments)
  }

  private ensureDetailStreamer(sessionId: string, session: Session, agent: AgentDef): AppServerRunner | ClaudeSdkSideRunner {
    let detail = this.detailStreamers.get(sessionId)
    if (!detail) {
      if (!this.detailSeqRefs.has(sessionId)) this.detailSeqRefs.set(sessionId, { n: 0 })
      if (!this.detailEvents.has(sessionId)) this.detailEvents.set(sessionId, [])
      const ref = this.detailSeqRefs.get(sessionId)!
      // Fork off the main rollout: resumeThreadId undefined, forkFromThreadId set.
      detail = agent.adapter === 'claude'
        ? new ClaudeSdkSideRunner(sessionId, ref, agent, session.config, session.nativeSessionId!)
        : new AppServerRunner(sessionId, ref, agent, session.config)
      if (detail instanceof AppServerRunner) {
      detail.setForkTranscript(this.detailEvents.get(sessionId) || [])
      const parent = this.streamers.get(sessionId) || this.ensureMainStreamer(session, agent)
      detail.setForkPreparation(async (events) => {
        const shared = agent.adapter === 'codex'
        const threadId = await parent.forkSideSnapshot(this.events.get(sessionId) || [], events, shared ? session.config : undefined)
        return { threadId, cleanup: () => shared ? detail!.deleteThread(threadId) : parent.deleteThread(threadId) }
      }, agent.adapter === 'codex' ? parent : undefined)
      this.bindAppServerDiagnostics(detail, sessionId, 'detail')
      }
      detail.on('event', (ev: UAEvent) => {
        if (this.detailStreamers.get(sessionId) !== detail) return
        const visibleEvent = this.normalizeDetailExplanationEvent(sessionId, ev)
        if (!visibleEvent) return
        const events = this.detailEvents.get(sessionId)
        if (events) this.appendEphemeralEvent(events, visibleEvent)
        this.logEvent(visibleEvent, 'detail')
        this.emit('detailEvent', { sessionId, event: visibleEvent })
      })
      detail.on('done', () => {
        if (this.detailStreamers.get(sessionId) !== detail) return
        if (detail instanceof AppServerRunner) detail.setForkTranscript(this.detailEvents.get(sessionId) || [])
        this.detailExplanationState.delete(sessionId)
        this.logSession(sessionId, 'runner_done', { runner: 'app-server', channel: 'detail' })
        this.detailStatus.set(sessionId, 'idle')
        this.emit('detailStatus', { sessionId, status: 'idle' })
      })
      detail.on('steerFailed', ({ prompt: p, attachments: at }: QueueItem) => {
        void detail!.startTurn(p, at)
      })
      this.detailStreamers.set(sessionId, detail)
    }
    return detail
  }

  private normalizeDetailExplanationEvent(sessionId: string, event: UAEvent): UAEvent | null {
    const state = this.detailExplanationState.get(sessionId)
    if (!state || event.type !== 'agent_message') return event
    const itemId = typeof event.payload?.id === 'string' ? event.payload.id : ''
    if (!state.itemId) state.itemId = itemId
    if (itemId !== state.itemId) return event

    const parsed = parseDetailExplanationResponse(
      typeof event.payload?.text === 'string' ? event.payload.text : '',
      event.state !== 'running',
    )
    if (parsed.waitingForTitle || (!parsed.text && event.state === 'running')) return null
    return {
      ...event,
      payload: {
        ...event.payload,
        text: parsed.text,
        ...(parsed.title ? { detailTitle: parsed.title } : {}),
      },
    }
  }

  /** 详情 — interrupt the in-flight detail turn (best effort). */
  interruptDetail(sessionId: string): void {
    this.detailStreamers.get(sessionId)?.interrupt()
  }

  /** 详情 — snapshot the buffered detail transcript (for renderer hydration). */
  getDetailEvents(sessionId: string): UAEvent[] {
    return this.detailEvents.get(sessionId) ? [...this.detailEvents.get(sessionId)!] : []
  }

  /** 详情 — current detail-branch run status (idle when no runner exists). */
  getDetailStatus(sessionId: string): 'idle' | 'running' {
    return this.detailStatus.get(sessionId) || 'idle'
  }

  /** Save the explanation directly, keeping any existing side chat intact. */
  async promoteDetailToSession(sessionId: string): Promise<Session> {
    const source = this.sessions.get(sessionId)
    const detail = this.detailStreamers.get(sessionId)
    const detailEvents = this.detailEvents.get(sessionId)
    if (!source || !detail || !detailEvents?.some((event) => event.type === 'user_message')) {
      throw new Error('解释暂无可保存的内容')
    }
    if (this.getDetailStatus(sessionId) !== 'idle') {
      throw new Error('解释仍在运行，请等待结束后再添加')
    }
    const events = structuredClone(detailEvents).map((event) =>
      event.type === 'user_message' && event.payload.hidden === true
        ? { ...event, payload: { ...event.payload, hidden: false, text: event.payload.displayText || '解释所选内容' } }
        : event
    )
    const title = events.findLast((event) => event.type === 'agent_message' && event.payload.detailTitle)?.payload.detailTitle
    const firstUser = events.find((event) => event.type === 'user_message')
    const promotedId = 's_' + nanoid(10)
    const nativeSessionId = await detail.forkPersistent(events, promotedId)
    // Main-window navigation and a new selection can replace this branch while forking.
    if (this.sessions.get(sessionId) !== source || this.detailStreamers.get(sessionId) !== detail ||
        this.getDetailStatus(sessionId) !== 'idle' || detailEvents.length !== events.length) {
      throw new Error('解释内容已变更，请重试')
    }
    const session = await this.persistForkSession(source, nativeSessionId, events,
      deriveSessionTitle(typeof title === 'string' ? title : firstUser?.payload.text) || `${source.title} · 解释`, source.config, promotedId)
    const agent = this.getAgent(session.config.agentId)!
    if (agent.adapter === 'codex') this.ensureMainStreamer(session, agent, session.config, true, detail as AppServerRunner)
    this.closeDetail(sessionId)
    return session
  }

  /** 详情 — discard the session's detail branch (popover closed / discarded). */
  closeDetail(sessionId: string): void {
    const detail = this.detailStreamers.get(sessionId)
    detail?.removeAllListeners()
    detail?.disposeFork()
    this.detailStreamers.delete(sessionId)
    this.detailEvents.delete(sessionId)
    this.detailSeqRefs.delete(sessionId)
    this.detailStatus.delete(sessionId)
    this.detailExplanationState.delete(sessionId)
  }

  /**
   * 详情 →「保留为侧边对话」— promote the ephemeral detail branch into the session's
   * side channel so it survives in the 侧边对话 drawer. Any pre-existing side branch
   * is torn down first; the detail runner is re-bound to the side listeners and its
   * buffered transcript is carried over, then the detail maps are cleared.
   */
  promoteDetailToSide(sessionId: string): boolean {
    const detail = this.detailStreamers.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!detail || !session) return false
    // Discard any existing side branch, then adopt the detail runner as the side one.
    this.closeSideChat(sessionId)
    detail.removeAllListeners()
    const config = structuredClone(session.config)
    detail.updateConfig(config)
    this.sideConfigs.set(sessionId, config)
    const nativeSessionId = detail.nativeThreadId()
    if (nativeSessionId && ['codex', 'claude'].includes(this.getAgent(config.agentId)?.adapter || '')) this.sideNativeSessionIds.set(sessionId, nativeSessionId)
    this.sideQueues.set(sessionId, [])
    this.sideEvents.set(sessionId, this.detailEvents.get(sessionId) || [])
    this.sideSeqRefs.set(sessionId, this.detailSeqRefs.get(sessionId) || { n: 0 })
    this.sideStatus.set(sessionId, this.detailStatus.get(sessionId) || 'idle')
    this.sideStreamers.set(sessionId, detail)
    this.bindSideStreamer(sessionId, detail)
    // Clear detail maps WITHOUT disposing — the runner now lives on the side channel.
    this.detailStreamers.delete(sessionId)
    this.detailEvents.delete(sessionId)
    this.detailSeqRefs.delete(sessionId)
    this.detailStatus.delete(sessionId)
    this.detailExplanationState.delete(sessionId)
    this.persistSideChats()
    this.emit('sideStatus', { sessionId, status: this.getSideStatus(sessionId) })
    this.emitSideState(sessionId)
    return true
  }

  /** 详情 — append to the detail transcript buffer + push on the detail channel. */
  private recordDetail(sessionId: string, partial: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>): void {
    if (!this.detailSeqRefs.has(sessionId)) this.detailSeqRefs.set(sessionId, { n: 0 })
    if (!this.detailEvents.has(sessionId)) this.detailEvents.set(sessionId, [])
    const ref = this.detailSeqRefs.get(sessionId)!
    const ev: UAEvent = { sessionId, seq: ref.n++, ts: Date.now(), ...partial }
    this.appendEphemeralEvent(this.detailEvents.get(sessionId)!, ev)
    this.logEvent(ev, 'detail')
    this.emit('detailEvent', { sessionId, event: ev })
  }

  /**
   * 需求2 — fetch a sub-agent's output for the detail panel. Codex/Claude
   * children write their OWN native rollout whose filename id == agentThreadId,
   * so we read it directly via loadSessionEvents (the same path the main
   * transcript uses). Grok/Kimi children have no Codex rollout: Grok reads its
   * owned connection/cache, Kimi reads the native child transcript (live runner
   * first, read-only service for finished/restored sessions). This replaces the
   * old `thread/items/list` RPC, which codex 0.148.0 rejects (-32601 "not
   * supported yet") — that made the panel always empty ("正在思考…").
   * Works for live, finished, AND restored sessions; returns [] when the child
   * has not produced any native output yet (still initializing).
   */
  async getSubAgentItems(sessionId: string, agentThreadId: string): Promise<UAEvent[]> {
    const session = this.sessions.get(sessionId)
    const agentId = session?.config.agentId ?? 'codex'
    const agent = this.getAgent(agentId)
    const adapter = agent?.adapter
    
    if (adapter === 'grok') {
      const child = session?.subagents?.find(child => child.agentThreadId === agentThreadId && child.parentThreadId === session.nativeSessionId)
      if (!child || !session?.nativeSessionId) return []
      try {
        const live = await this.protocolRunners.get(sessionId)?.getSubAgentItems(agentThreadId)
        if (live?.length) return live
      } catch { /* A restored parent has not observed this child on its new connection. */ }
      return readGrokChildHistory(session.nativeSessionId,child)
    }
    if (adapter === 'kimi') {
      if (!session?.nativeSessionId) return []
      // A child owned by another parent must never be readable through this
      // session; entries without a parent provenance are left to native checks.
      const child = session.subagents?.find(candidate => candidate.agentThreadId === agentThreadId)
      if (child?.parentThreadId && child.parentThreadId !== session.nativeSessionId && child.parentThreadId !== session.id) return []
      const trusted = child?.nativeTaskId
        ? { nativeTaskId: child.nativeTaskId, parentNativeSessionId: session.nativeSessionId }
        : undefined
      const live = this.protocolRunners.get(sessionId)
      if (live) {
        try {
          const events = await live.getSubAgentItems(agentThreadId, trusted)
          // A live runner is authoritative while the child has not written any
          // transcript frame yet; do not spin up a second reader for that case.
          if (events?.length) return events
          return []
        } catch { /* The live connection may have ended before the child finished. */ }
      }
      // Finished/restored children still have a native transcript; read it with
      // the read-only service instead of leaving the detail page permanently empty.
      // A running child without a live runner is often a stale roster entry, so
      // coalesce polls instead of spawning a reader on every detail refresh.
      const cacheKey = `${sessionId}\0${session.nativeSessionId}\0${agentThreadId}`
      const cacheable = child?.status === 'running' || child?.status === 'pendingInit'
      const cached = cacheable ? this.kimiSubAgentReads.get(cacheKey) : undefined
      if (cached && cached.status === child?.status && Date.now() - cached.at < 30_000) return cached.events
      try {
        const events = (await loadKimiSubAgentEvents(session.nativeSessionId, agentThreadId, agent?.bin || 'kimi',
          session.config.workdir, kimiSessionRuntimeEnv(sessionId, session.config), trusted))
          .map(event => ({ ...event, sessionId }))
        if (cacheable) this.kimiSubAgentReads.set(cacheKey, { at: Date.now(), status: child?.status, events })
        else this.kimiSubAgentReads.delete(cacheKey)
        return events
      } catch { return [] }
    }
    if (adapter === 'deepseek') return []
    if (adapter === 'mcode') return []
    if (adapter === 'claude') {
      const cached = this.runners.get(sessionId)?.getSubAgentItems(agentThreadId) || this.completedSubAgentItems.get(sessionId)?.get(agentThreadId)
      if (cached?.length) return structuredClone(cached)
    }
    try {
      const { events } = await loadSessionEvents(agentId, agentThreadId)
      return events
    } catch {
      return []
    }
  }

  /** Cancel only a live native child owned by an ordinary user session. */
  async cancelSubAgent(sessionId: string, agentThreadId: string): Promise<void> {
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 &&
      id.length <= 500 && id === id.trim() && !/[\u0000-\u001f\u007f]/.test(id)
    if (!validId(sessionId) || !validId(agentThreadId)) throw new Error('子智能体取消请求无效')
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    this.assertUserSessionEnabled(sessionId)
    if (session.teamBinding) throw new Error('team_session_requires_project_route')
    if (session.readOnly) throw new Error('只读会话不能取消子智能体')
    if (session.archived) throw new Error('归档会话不能取消子智能体')
    const adapter = this.getAgent(session.config.agentId)?.adapter
    if (adapter !== 'grok' && adapter !== 'deepseek' && adapter !== 'kimi') throw new Error('当前 Agent 不支持取消子智能体')
    const children = session.subagents?.filter(child => child.agentThreadId === agentThreadId) || []
    const child = children[0]
    if (children.length !== 1 || child.parentThreadId && child.parentThreadId !== session.nativeSessionId && child.parentThreadId !== session.id) {
      throw new Error('子智能体不属于当前会话')
    }
    if (child.status !== 'running' || !['running', 'awaiting-approval'].includes(session.status)) throw new Error('子智能体或所属会话未在运行')
    const runner = this.protocolRunners.get(sessionId)
    if (!runner) throw new Error('子智能体所属会话未连接')
    await runner.cancelSubAgent(agentThreadId)
  }

  /**
   * Doc5 — upsert a session's sub-agent snapshot from a `subagent` event's
   * per-child agent list, keyed by agentThreadId. Preserves the first-seen
   * `startedAt` so the detail timer keeps counting.
   */
  private upsertSubAgents(session: Session, agents: UASubAgent[]): void {
    if (!agents?.length) return
    const list = session.subagents ? [...session.subagents] : []
    const byId = new Map(list.map((a) => [a.agentThreadId, a]))
    for (const incoming of agents) {
      if (!incoming.agentThreadId) continue
      const prev = byId.get(incoming.agentThreadId)
      const merged = mergeSubAgentSnapshot(prev, incoming, Date.now())
      byId.set(incoming.agentThreadId, merged)
    }
    session.subagents = [...byId.values()]
    this.bumpSessionActivity(session.id)
  }

  /**
   * A turn just reported the thread's native session id (Doc5 T3, step 2). Stamp
   * it on the live session; if some OTHER (older, e.g. imported) record already
   * carries the same (agentId, nativeId) identity, absorb it — drop the stale
   * duplicate so the same conversation never shows up twice in the sidebar.
   */
  private assignNativeSessionId(session: Session, nativeId: string): void {
    if (this.sessions.get(session.id) !== session) return
    const previousNativeId = session.nativeSessionId
    const prior = this.findByIdentity(session.config.agentId, nativeId)
    session.nativeSessionId = nativeId
    if (previousNativeId !== nativeId) {
      this.logSession(session.id, 'native_session_assigned', {
        previousNativeSessionId: previousNativeId,
        nativeSessionId: nativeId
      })
    }
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    if (previousNativeId && previousNativeId !== nativeId) {
      this.bumpNativeIdentityOwnership(session.config.agentId, previousNativeId)
    }
    if (previousNativeId !== nativeId) {
      this.bumpNativeIdentityOwnership(session.config.agentId, nativeId)
    }
    if (prior && prior.id !== session.id) {
      // Keep the live session; discard the older duplicate and its state.
      this.disposeSession(prior.id)
      this.removeSessionOwner(prior.id)
      this.events.delete(prior.id)
      this.queues.delete(prior.id)
      this.seqRefs.delete(prior.id)
      this.backendConfigCorrectionSeqs.delete(prior.id)
    }
    this.persist()
  }

  /** Release a session's long-lived streaming process (archive / close). */
  disposeSession(sessionId: string, keepSideCache = false): void {
    cancelRequirementPreparation(sessionId)
    this.channelSendTurns.delete(sessionId)
    this.feishuTeamInputs.delete(sessionId)
    if (this.sessions.has(sessionId)) this.bumpSessionActivity(sessionId)
    this.deferredDispatches.delete(sessionId)
    this.protocolPendingStarts.delete(sessionId)
    this.zcodeStarts.delete(sessionId)
    this.zcodeRunnerLoads.delete(sessionId)
    this.protocolConfigTails.delete(sessionId)
    this.modelSwitches.delete(sessionId)
    for (const key of this.kimiSubAgentReads.keys()) {
      if (key.startsWith(sessionId + '\0')) this.kimiSubAgentReads.delete(key)
    }
    if (!keepSideCache) {
      const events = this.events.get(sessionId) || []
      for (let index = 0; index < events.length; index++) {
        const event = events[index]
        if (!isAsyncQuestion(event) || event.payload.interactionExpired || event.payload.submittedAnswer !== undefined) continue
        const expired = { ...event, payload: { ...event.payload, interactionExpired: true } }
        events[index] = expired; this.logEvent(expired); this.emit('event', expired)
      }
      this.expireLocalPlans(sessionId)
    }
    if (this.sessions.get(sessionId)?.config.agentId === 'deepseek') {
      const requests = new Map<string, UAEvent>()
      for (const event of this.events.get(sessionId) || []) {
        if (event.type === 'approval_request' && event.payload.requestId) requests.set(event.payload.requestId, event)
      }
      for (const event of requests.values()) {
        if (event.state === 'pending') this.record(sessionId, { type:'approval_request', state:'cancelled',
          payload:{ ...event.payload, resolved:true, interactionExpired:true } })
      }
    }
    // 需求2 — tear down any ephemeral side branch alongside the main streamer.
    this.closeSideChat(sessionId, keepSideCache)
    // 选中即评论 / 详情 — tear down the ephemeral detail branch too.
    this.closeDetail(sessionId)
    const streamer = this.removeMainStreamerOwner(sessionId)
    streamer?.removeAllListeners()
    streamer?.dispose()
    const runner = this.runners.get(sessionId)
    runner?.removeAllListeners()
    runner?.interrupt()
    this.runners.delete(sessionId)
    const claude = this.claudeSdkRunners.get(sessionId)
    this.claudeSdkRunners.delete(sessionId)
    claude?.removeAllListeners()
    void claude?.disposeClaudeSdk()
    const grok = this.protocolRunners.get(sessionId)
    grok?.removeAllListeners()
    grok?.dispose()
    this.protocolRunners.delete(sessionId)
    const zcode = this.zcodeRunners.get(sessionId)
    this.zcodeRunners.delete(sessionId)
    zcode?.removeAllListeners()
    if (zcode) {
      const disposal = zcode.dispose().catch(() => undefined)
      this.zcodeDisposals.set(sessionId, disposal)
      void disposal.finally(() => { if (this.zcodeDisposals.get(sessionId) === disposal) this.zcodeDisposals.delete(sessionId) })
    }
    const session = this.sessions.get(sessionId)
    if (session) this.emit('sessionUpdated', { session, hasLiveStreamer: false })
  }

  /** Tear down every process, including any session hidden by list de-dup. */
  disposeAll(): void {
    for (const { sessionId } of [...this.managementConfirmations.values()]) this.cancelManagementConfirmations(sessionId)
    this.persistSideChats()
    const ids = new Set([
      ...this.streamers.keys(),
      ...this.sideStreamers.keys(),
      ...this.detailStreamers.keys(),
      ...this.runners.keys(),
      ...this.protocolRunners.keys(),
      ...this.zcodeRunners.keys(),
      ...this.zcodeRunnerLoads.keys()
    ])
    for (const id of ids) this.disposeSession(id, true)
  }
  async closeZCodeRuntime(): Promise<void> {
    this.zcodeStarts.clear()
    const loads = [...this.zcodeRunnerLoads.values()]
    this.zcodeRunnerLoads.clear()
    await Promise.allSettled(loads)
    await Promise.allSettled(this.zcodeDisposals.values())
    await Promise.allSettled(this.zcodeSideDisposals.values())
    await Promise.allSettled([...this.zcodeRunners.values()].map(runner => runner.dispose()))
    this.zcodeRunners.clear()
    await this.zcodePool.close()
  }
  async resetZCodeRuntime(): Promise<void> {
    if (this.zcodePool.hasActiveLeases || this.zcodeRunnerLoads.size || this.zcodeDisposals.size) throw new Error('ZCode 有活动会话，请先关闭相关会话')
    await this.zcodePool.close(); this.zcodePool = new ZCodeRuntimePool()
  }
  async prepareZCodeRuntimeUpdate(): Promise<void> {
    if (this.hasActiveAgentSessions('zcode') || this.zcodeStarts.size || this.zcodeRunnerLoads.size) throw new Error('agent_has_active_session')
    for (const [sessionId, side] of this.sideStreamers) {
      if (side instanceof ZCodeSideRunner) this.closeSideChat(sessionId, true)
    }
    for (const runner of this.zcodeRunners.values()) runner.removeAllListeners()
    try { await this.closeZCodeRuntime() } finally { this.zcodePool = new ZCodeRuntimePool() }
  }
  async loadZCodeEarlier(sessionId: string, beforeRowId?: number): Promise<{ hasMore: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session || session.config.agentId !== 'zcode') throw new Error('需要 ZCode 会话')
    const runner = await this.ensureZCodeRunner(session)
    return runner.loadEarlier(beforeRowId)
  }
  async discoverZCodeCapabilities(workdir: string, sessionId?: string): Promise<NativeCapabilitySnapshot> {
    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (!session || session.config.agentId !== 'zcode' || session.config.workdir !== workdir) throw new Error('invalid_native_capability_session')
      return (await this.ensureZCodeRunner(session)).discoverCapabilities()
    }
    return this.withZCodeToolConnection(workdir, (connection, independentPlanState) => readZCodeCapabilities(connection, workdir, undefined, undefined, independentPlanState))
  }

  async listZCodeToolPlugins(workdir: string): Promise<unknown> {
    return this.withZCodeToolConnection(workdir, connection => connection.request('plugins/list', {
      workspace: { workspacePath: workdir, workspaceKey: workdir }, configScope: 'user'
    }))
  }

  async uninstallZCodeToolPlugin(workdir: string, pluginId: string): Promise<void> {
    await this.withZCodeToolConnection(workdir, connection => connection.request('plugins/uninstall', {
      workspace: { workspacePath: workdir, workspaceKey: workdir }, pluginId, removeCache: false
    }))
  }

  private async withZCodeToolConnection<T>(workdir: string, read: (connection: ZCodeConnection, independentPlanState: boolean) => Promise<T>): Promise<T> {
    const config = await loadZCodeRuntimeConfig()
    if (!config) throw new Error('ZCode 运行时尚未配置')
    const lease = await this.zcodePool.acquire(await detectZCodeRuntime(config), workdir)
    try { return await read(lease.connection, lease.independentPlanState) }
    finally { await lease.release() }
  }

  assertUserSessionEnabled(sessionId: string): void {
    if (this.worktreeTransitions.has(sessionId)) throw new Error('正在切换工作目录，请稍后再操作')
    const session = this.sessions.get(sessionId)
    if (session) assertWorktreeNotRemoving(session.config)
    if (isToolSession(this.sessions.get(sessionId))) {
      throw new Error('这是工具创建的只读会话，请先在 UniAgent 中启用会话。')
    }
  }

  enableToolSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    if (!isToolSession(session)) return session
    const previous = {
      handoffUserContinued: session.handoffUserContinued,
      archived: session.archived,
      updatedAt: session.updatedAt
    }
    session.handoffUserContinued = true
    session.archived = false
    session.updatedAt = Date.now()
    try {
      this.persistOrThrow()
    } catch (error) {
      if (!sessionStoreWriteCommitted(error)) Object.assign(session, previous)
      else this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
      throw error
    }
    this.bumpSessionActivity(session.id)
    this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
    return session
  }

  /** Archive or restore a session, preserving its metadata and native rollout. */
  setArchived(sessionId: string, archived: boolean, teamExecution?: symbol): Session | undefined {
    if (this.sessions.get(sessionId)?.teamBinding && teamExecution !== TEAM_EXECUTION) throw new Error('archive_team_project_instead')
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (archived) {
      this.cancelManagementConfirmations(sessionId)
      const wasBusy = this.isBusy(session.status)
      if (wasBusy) this.interrupt(sessionId)
      this.disposeSession(sessionId)
      // dispose removes runner listeners, so no asynchronous completion can
      // settle a just-archived turn. Persist an explicit terminal state now.
      if (wasBusy) this.setStatus(session, 'cancelled')
    }
    session.archived = archived
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    this.persist()
    if (archived) this.emit('sessionArchived', sessionId)
    if (archived && session.config.agentId === 'deepseek') {
      const events = this.events.get(sessionId)
      const generation = this.sessionActivityGeneration(sessionId)
      void this.deepseekEvents.flush().then(() => {
        if (this.sessions.get(sessionId) === session && session.archived &&
          this.sessionActivityGeneration(sessionId) === generation && this.events.get(sessionId) === events) {
          this.events.set(sessionId, [])
        }
      }).catch(error => this.logSession(sessionId, 'history_cache_release_failed', { message: String(error) }))
    }
    return session
  }

  /**
   * Permanently delete a session (G2-4). Drops all in-memory state and its
   * persisted metadata. The agent's own native rollout on disk is left intact
   * (we never created it) — this only removes UniAgent's record of the session.
   */
  deleteSession(sessionId: string): Promise<void> {
    if (this.sessions.get(sessionId)?.teamBinding) throw new Error('team_session_cannot_delete')
    const session = this.sessions.get(sessionId)
    const agent = session ? this.getAgent(session.config.agentId) : undefined
    if (session?.nativeSessionId && (agent?.adapter === 'grok' || agent?.adapter === 'kimi')) {
      return this.deleteProtocolSessionNativeFirst(session, agent)
    }
    return this.deleteLocalSession(sessionId)
  }

  deleteTeamSessions(teamProjectId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.teamBinding?.teamProjectId === teamProjectId) void this.deleteLocalSession(session.id).catch(error => this.logSession(session.id, 'history_delete_failed', { message: String(error) }))
    }
  }

  private async deleteProtocolSessionNativeFirst(session: Session, agent: AgentDef): Promise<void> {
    const nativeSessionId = session.nativeSessionId
    if (!nativeSessionId) return
    if (agent.adapter === 'kimi') {
      await deleteKimiSession(nativeSessionId, agent.bin, session.config.workdir, kimiSessionRuntimeEnv(session.id, session.config))
    } else {
      await deleteGrokSession(nativeSessionId, agent.bin, session.config.workdir)
    }
    if (this.sessions.get(session.id) !== session || session.nativeSessionId !== nativeSessionId) {
      throw new Error(`${agent.name} 会话在删除期间发生变化，已保留本地记录`)
    }
    await this.deleteLocalSession(session.id)
  }

  private deleteLocalSession(sessionId: string): Promise<void> {
    this.disposeSession(sessionId)
    const deletion = this.sessions.get(sessionId)?.config.agentId === 'deepseek' ? this.deepseekEvents.delete(sessionId) : Promise.resolve()
    this.recoveryStartTokens.delete(sessionId)
    this.historyLoads.delete(sessionId)
    this.sendTails.delete(sessionId)
    this.activeQueueItems.delete(sessionId)
    this.editingQueueItems.delete(sessionId)
    this.removeSessionOwner(sessionId)
    this.events.delete(sessionId)
    this.completedSubAgentItems.delete(sessionId)
    this.queues.delete(sessionId)
    this.seqRefs.delete(sessionId)
    this.backendConfigCorrectionSeqs.delete(sessionId)
    this.persist()
    this.emit('sessionDeleted', sessionId)
    const references = new Set<string>()
    const include = (attachments?: Attachment[]): void => {
      for (const attachment of attachments || []) if (attachment.kind === 'image') references.add(attachment.path)
    }
    for (const session of this.sessions.values()) for (const message of session.submittedUserMessages || []) include(message.attachments)
    for (const buffers of [this.events,this.sideEvents]) for (const events of buffers.values()) for (const event of events) include(event.payload?.attachments)
    for (const queues of [this.queues,this.sideQueues]) for (const queue of queues.values()) for (const item of queue) include(item.attachments)
    void collectGrokImages(references).catch(() => {})
    return deletion
  }

  /**
   * 需求4: manually rename a session. Sets `titleLocked` so the imported /
   * replayed first-message heuristic can no longer overwrite the user's title.
   */
  renameSession(sessionId: string, title: string): Session | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    const trimmed = title.trim()
    if (!trimmed) return session
    session.title = trimmed.slice(0, 80)
    session.titleLocked = true
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    this.persist()
    this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
    return session
  }

  /** 需求4: pin / unpin a session (pinned rows float to the top of the list). */
  setPinned(sessionId: string, pinned: boolean): Session | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    session.pinned = pinned
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    this.persist()
    return session
  }

  // ---- status machine ----

  private isBusy(status: SessionStatus): boolean {
    return isSessionBusy(status)
  }

  private isReady(status: SessionStatus): boolean {
    return status === 'idle' || status === 'completed'
  }

  private currentTurnInput(session: Session): UAEvent | undefined {
    const events = this.events.get(session.id) || []
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].type === 'goal_message' || events[index].type === 'user_message') {
        return events[index]
      }
    }
    return undefined
  }

  private currentTurnIsGoal(session: Session): boolean {
    return this.currentTurnInput(session)?.type === 'goal_message'
  }

  private setStatus(session: Session, status: SessionStatus): void {
    const question = this.teamQuestions.get(session.id)
    if (question && ['running', 'queued', 'idle', 'completed'].includes(status)) {
      question.resumeStatus = status
      status = 'awaiting-approval'
    }
    const previous = session.status
    session.status = status
    if (!this.isBusy(status) || status === 'cancelling') this.channelSendTurns.delete(session.id)
    if (status === 'error' || status === 'cancelled' || status === 'cancelling') this.feishuTeamInputs.delete(session.id)
    session.updatedAt = Date.now()
    this.bumpSessionActivity(session.id)
    if (previous !== status) {
      this.logSession(session.id, 'status_changed', { from: previous, to: status })
    }
    this.emit('statusChange', { sessionId: session.id, status, updatedAt: session.updatedAt })
    // Persist terminal-ish transitions so the sidebar reflects them on restart.
    if (status === 'idle' || status === 'completed' || status === 'error' || status === 'cancelled') this.persist()
    if (this.isReady(status)) this.ensureLocalPlanRequest(session)
  }

  private emitQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId) || []
    this.logSession(sessionId, 'queue_changed', {
      length: queue.length,
      items: queue.map((item) => ({ id: item.id, state: item.state, attempts: item.attempts }))
    })
    this.emit('queueChange', {
      sessionId,
      queue: structuredClone(queue)
    })
  }

  private commitQueueForRecovery(
    session: Session,
    next: DurableQueueItem[]
  ): {
    durabilityUncertain: boolean
    forcedMemory: boolean
    detail?: string
  } {
    try {
      this.commitQueue(session, next)
      return { durabilityUncertain: false, forcedMemory: false }
    } catch (error: any) {
      if (sessionStoreWriteCommitted(error)) {
        return {
          durabilityUncertain: true,
          forcedMemory: false,
          detail: error?.message || String(error)
        }
      }
      // Recovery must leave the queue user-actionable even if the retry-state
      // persist itself fails before rename. Restart will still replay any old
      // in-flight rows as pending via SessionStore recovery.
      this.queues.set(session.id, next)
      session.pendingQueue = next
      this.bumpSessionActivity(session.id)
      return {
        durabilityUncertain: false,
        forcedMemory: true,
        detail: error?.message || String(error)
      }
    }
  }

  private restoreQueueItemsToPending(
    session: Session,
    predicate: (item: DurableQueueItem) => boolean,
    baseMessage: string,
    options: {
      releaseActiveItemId?: string
      statusAfter?: SessionStatus
    } = {}
  ): void {
    const current = this.queues.get(session.id) || []
    if (!current.some(predicate)) {
      if (
        options.releaseActiveItemId &&
        this.activeQueueItems.get(session.id) === options.releaseActiveItemId
      ) {
        this.activeQueueItems.delete(session.id)
      }
      if (options.statusAfter) this.setStatus(session, options.statusAfter)
      return
    }
    const next = current.map((item) =>
      predicate(item) && item.state !== 'pending'
        ? { ...item, state: 'pending' as const }
        : item
    )
    const recovery = this.commitQueueForRecovery(session, next)
    if (
      options.releaseActiveItemId &&
      this.activeQueueItems.get(session.id) === options.releaseActiveItemId
    ) {
      this.activeQueueItems.delete(session.id)
    }
    this.emitQueue(session.id)
    let text = baseMessage
    if (recovery.forcedMemory) {
      text += ` 队列恢复持久化失败，当前以内存中的可重试状态保留；重启后可能按旧磁盘状态重放：${recovery.detail}`
    } else if (recovery.durabilityUncertain) {
      text += ` 队列恢复已提交，但目录持久化未确认；如进程立刻崩溃，重启后可能重试：${recovery.detail}`
    }
    this.record(session.id, {
      type: 'system_notice',
      payload: { kind: 'warning', text }
    })
    if (options.statusAfter) this.setStatus(session, options.statusAfter)
  }

  private commitQueue(session: Session, next: DurableQueueItem[]): void {
    const previousQueue = this.queues.get(session.id) || []
    const previousPersisted = session.pendingQueue
    this.queues.set(session.id, next)
    session.pendingQueue = next
    this.bumpSessionActivity(session.id)
    try {
      this.persistOrThrow()
    } catch (error) {
      // A post-rename directory-fsync failure means the new bytes are already
      // visible. Rolling memory back here would split the live state from disk
      // and could cause a later save to resurrect/lose queue items. Keep the
      // committed state, while propagating the durability-uncertain error.
      if (!sessionStoreWriteCommitted(error)) {
        this.queues.set(session.id, previousQueue)
        session.pendingQueue = previousPersisted
        this.bumpSessionActivity(session.id)
      }
      throw error
    }
  }

  private removeDeliveredQueueItem(session: Session, itemId: string): void {
    const queue = this.queues.get(session.id) || []
    if (!queue.some((item) => item.id === itemId)) return
    let durabilityUncertain = false
    try {
      this.commitQueue(
        session,
        queue.filter((item) => item.id !== itemId)
      )
    } catch (error) {
      if (!sessionStoreWriteCommitted(error)) throw error
      durabilityUncertain = true
    } finally {
      if (this.activeQueueItems.get(session.id) === itemId) {
        this.activeQueueItems.delete(session.id)
      }
    }
    this.emitQueue(session.id)
    if (durabilityUncertain) {
      this.record(session.id, {
        type: 'system_notice',
        payload: {
          kind: 'warning',
          text: '消息发送完成且队列已删除，但目录持久化未确认；如进程立刻崩溃，重启后可能重试。'
        }
      })
    }
  }

  private enqueueDuringTurn(
    session: Session,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    bubble?: TurnBubble
  ): void {
    // Attachments are safe to persist now: clipboard images are written under
    // userData (not OS tmp), and picked files reference stable on-disk paths, so
    // a queued image survives an App restart alongside the durable FIFO entry.
    const q = this.queues.get(session.id) || []
    const item = buildDurableQueueItem(prompt, attachments, nativeContext, undefined, bubble)
    const previousStatus = session.status
    const previousHandoffUserContinued = session.handoffUserContinued
    if (session.handoffId && bubble?.source !== 'mcp') session.handoffUserContinued = true
    session.status = 'queued'
    this.bumpSessionActivity(session.id)
    try {
      this.commitQueue(session, [...q, item])
    } catch (error) {
      if (!sessionStoreWriteCommitted(error)) {
        session.status = previousStatus
        session.handoffUserContinued = previousHandoffUserContinued
        this.bumpSessionActivity(session.id)
      }
      throw error
    }
    this.logSession(session.id, 'status_changed', { from: previousStatus, to: 'queued' })
    this.emit('statusChange', { sessionId: session.id, status: 'queued' })
    this.emitQueue(session.id)
    this.record(session.id, {
      type: 'system_notice',
      payload: { text: `已排队（第 ${this.getQueue(session.id).length} 条），本轮结束后自动发送。`, kind: 'queue' }
    })
  }

  private dispatchPendingQueue(session: Session, scheduledToken?: symbol): void {
    const dispatchToken = scheduledToken || Symbol(session.id)
    if (scheduledToken && this.deferredDispatches.get(session.id) !== scheduledToken) return
    if (
      this.activeQueueItems.has(session.id) ||
      this.editingQueueItems.has(session.id) ||
      this.teamQuestions.has(session.id) ||
      session.archived ||
      session.readOnly || this.assistantCommandSessions.has(session.id)
    ) {
      if (this.deferredDispatches.get(session.id) === dispatchToken) {
        this.deferredDispatches.delete(session.id)
      }
      return
    }
    const agent = this.getAgent(session.config.agentId)
    if (agent && planCollaborationTransportError(agent, session.config)) return
    const queue = this.queues.get(session.id) || []
    const head = queue[0]
    const failedZCodeReceipt = session.zcodeState?.deliveries.filter(record => record.queueItemId === head?.id).at(-1)
    if (session.config.agentId === 'zcode' && failedZCodeReceipt?.phase === 'failed' && !failedZCodeReceipt.retryRequested) {
      this.deferredDispatches.delete(session.id); this.setStatus(session, 'error'); return
    }
    if (session.config.agentId === 'zcode' && session.zcodeState?.suspendedAfterStop) { this.deferredDispatches.delete(session.id); this.setStatus(session, 'idle'); return }
    if (head?.deliveryUncertain) { this.deferredDispatches.delete(session.id); this.setStatus(session, 'error'); return }
    if (!head) {
      this.deferredDispatches.delete(session.id)
      this.setStatus(session, 'idle')
      return
    }
    // Own the scheduled head before the internal precommit hook can synchronously
    // Stop, dequeue, or append. The hook may replace the queue, so no queue
    // snapshot captured above may be committed after it returns.
    this.deferredDispatches.set(session.id, dispatchToken)
    const acceptedInput = snapshotTurnInput(head.attachments, head.nativeContext)
    let preparedRun: PreparedAgentRun
    try {
      if (this.isTeamMember(session.id)) throw new Error('team_member_read_only')
      teamRuntime(session.id)?.beforeUserTurn?.()
      preparedRun = this.prepareUserMessageRun(session, head.prompt, acceptedInput)
    } catch (error: any) {
      const currentQueue = this.queues.get(session.id) || []
      const stillOwnsPendingHead =
        this.deferredDispatches.get(session.id) === dispatchToken &&
        this.sessions.get(session.id) === session &&
        currentQueue[0]?.id === head.id &&
        currentQueue[0]?.state === 'pending'
      if (!stillOwnsPendingHead) {
        if (this.deferredDispatches.get(session.id) === dispatchToken) {
          this.deferredDispatches.delete(session.id)
        }
        return
      }
      this.deferredDispatches.delete(session.id)
      if (session.config.collaborationMode === 'plan') return
      const failed = currentQueue.map((item, index) =>
        index === 0 && item.id === head.id
          ? { ...item, attempts: item.attempts + 1 }
          : item
      )
      this.commitQueue(session, failed)
      this.emitQueue(session.id)
      this.record(session.id, {
        type: 'system_notice',
        payload: {
          kind: 'warning',
          text: `队列消息启动失败，已恢复为可重试状态：${error?.message || String(error)}`
        }
      })
      this.setStatus(session, 'error')
      return
    }
    const currentQueue = this.queues.get(session.id) || []
    const stillOwnsPendingHead =
      this.deferredDispatches.get(session.id) === dispatchToken &&
      this.sessions.get(session.id) === session &&
      currentQueue[0]?.id === head.id &&
      currentQueue[0]?.state === 'pending'
    if (!stillOwnsPendingHead) {
      if (this.deferredDispatches.get(session.id) === dispatchToken) {
        this.deferredDispatches.delete(session.id)
      }
      this.discardPreparedRun(session, preparedRun)
      return
    }
    const dispatching = currentQueue.map((item, index) =>
      index === 0 && item.id === head.id
        ? { ...item, state: 'dispatching' as const, attempts: item.attempts + 1 }
        : item
    )
    let durabilityUncertain = false
    try {
      this.commitQueue(session, dispatching)
    } catch (error: any) {
      if (sessionStoreWriteCommitted(error)) {
        durabilityUncertain = true
      } else {
        if (this.deferredDispatches.get(session.id) === dispatchToken) {
          this.deferredDispatches.delete(session.id)
        }
        this.discardPreparedRun(session, preparedRun)
        this.record(session.id, {
          type: 'system_notice',
          payload: {
            kind: 'warning',
            text: `队列持久化失败，消息仍保留待重试：${error?.message || String(error)}`
          }
        })
        this.setStatus(session, 'error')
        return
      }
    }
    // Reuse the deferred token through the synchronous queueChange boundary.
    // A Stop handler may clear it (and the durable queue) before we record or
    // dispatch the accepted prompt.
    this.activeQueueItems.set(session.id, head.id)
    this.emitQueue(session.id)
    if (durabilityUncertain) {
      this.record(session.id, {
        type: 'system_notice',
        payload: {
          kind: 'warning',
          text: '队列已提交为发送中，但目录持久化未确认；本进程继续发送，如随后崩溃则重启后可能重试。'
        }
      })
    }
    // queueChange listeners can synchronously issue Stop.  Do not let a head
    // that was cancelled in this pre-run gap leak into the transcript or reach
    // the provider after its durable outbox entry was cleared.
    const stillOwnsDispatch = (): boolean => {
      const currentHead = this.queues.get(session.id)?.[0]
      return this.deferredDispatches.get(session.id) === dispatchToken &&
        this.sessions.get(session.id) === session &&
        session.status !== 'cancelling' &&
        currentHead?.id === head.id &&
        currentHead.state === 'dispatching' &&
        this.activeQueueItems.get(session.id) === head.id
    }
    if (!stillOwnsDispatch()) {
      if (
        this.deferredDispatches.get(session.id) === dispatchToken &&
        this.activeQueueItems.get(session.id) === head.id
      ) {
        this.activeQueueItems.delete(session.id)
      }
      if (this.deferredDispatches.get(session.id) === dispatchToken) {
        this.deferredDispatches.delete(session.id)
      }
      this.discardPreparedRun(session, preparedRun)
      return
    }
    const auditInput = snapshotTurnInput(
      preparedRun.input.attachments,
      preparedRun.input.nativeContext
    )
    this.record(session.id, {
      type: session.config.agentId === 'zcode' && head.prompt.startsWith('/goal ') ? 'goal_message' : 'user_message',
      payload: { text: session.config.agentId === 'zcode' && head.prompt.startsWith('/goal ') ? head.prompt.slice(6).trim() : head.prompt,
        ...(session.config.agentId === 'zcode' && head.prompt.startsWith('/goal ') ? { command: 'goal' } : {}),
        ...auditInput, ...queueItemBubblePayload(head), ...(session.config.agentId === 'zcode' ? { zcodeQueueItemId: head.id } : {}) }
    })
    // The public user event can synchronously issue Stop. Keep the dispatch token
    // until after fan-out so status/runner ownership cannot be resurrected.
    if (!stillOwnsDispatch()) {
      this.discardPreparedRun(session, preparedRun)
      return
    }
    this.deferredDispatches.delete(session.id)
    if (this.run(
      session,
      head.prompt,
      preparedRun.input.attachments,
      preparedRun.input.nativeContext,
      preparedRun
    )) return
    this.restoreQueueItemsToPending(
      session,
      (item) => item.id === head.id,
      '队列消息启动失败，已恢复为可重试状态。',
      { releaseActiveItemId: head.id, statusAfter: 'error' }
    )
  }

  async recordHandoffEnd(event: UAEvent): Promise<void> {
    if (!isHandoffEndEvent(event) || !this.sessions.has(event.sessionId)) return
    const events = await this.getEvents(event.sessionId)
    const prior = events.find(item => isHandoffEndEvent(item) && item.payload.taskId === event.payload.taskId)
    if (prior) this.emit('event', prior)
    else this.record(event.sessionId, { type: event.type, state: event.state, payload: event.payload }, event.ts)
  }

  private record(sessionId: string, partial: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>, ts = Date.now()): void {
    const ref = this.seqRefs.get(sessionId)
    const events = this.events.get(sessionId)
    if (!ref || !events || !this.sessions.has(sessionId)) return
    const ev: UAEvent = { sessionId, seq: ref.n++, ts, ...partial }
    if (ev.type === 'turn_completed') this.channelSendTurns.delete(sessionId)
    if (ev.type === 'user_message' || ev.type === 'goal_message') {
      if (this.sessions.get(sessionId)?.config.assistantSnapshot) ev.payload.assistantMessageId ||= nanoid(20)
      this.expireLocalPlans(sessionId)
      const source = ev.payload.source === 'feishu' || ev.payload.source === 'weixin' || ev.payload.source === 'mcp' ? ev.payload.source : 'app'
      ev.payload = { ...ev.payload, source }
      const leader = !!this.sessions.get(sessionId)?.teamBinding && teamRuntime(sessionId)?.leader === true
      if (source === 'weixin' || source === 'feishu' || source === 'mcp' && leader && this.feishuTeamInputs.has(sessionId)) {
        this.channelSendTurns.set(sessionId, { ts: ev.ts, source: source === 'weixin' ? 'weixin' : 'feishu' })
        if (source === 'feishu' && leader) this.feishuTeamInputs.add(sessionId)
      } else {
        this.channelSendTurns.delete(sessionId)
        this.feishuTeamInputs.delete(sessionId)
      }
    }
    events.push(ev)
    if (this.sessions.get(sessionId)?.config.agentId === 'deepseek') this.deepseekEvents.append(sessionId, ev)
    this.logEvent(ev)
    if (ev.type === 'user_message' || ev.type === 'goal_message') {
      this.rememberSubmittedUserMessage(this.sessions.get(sessionId)!, ev)
    }
    this.bumpSessionActivity(sessionId)
    this.emit('event', ev)
  }

  reportRequirementSyncError(sessionId: string, text: string): void {
    this.record(sessionId, { type: 'system_notice', payload: { kind: 'warning', text } })
  }

  /** Only a live message submitted by the bridge grants permission, never restored text. */
  getFeishuSendTurn(sessionId: string): { ts: number } | undefined {
    const session = this.sessions.get(sessionId)
    if (!session || session.archived || session.readOnly || !this.isBusy(session.status) || session.status === 'cancelling') return undefined
    const turn = this.channelSendTurns.get(sessionId)
    return turn?.source === 'feishu' ? turn : undefined
  }

  getWeixinSendTurn(sessionId: string): { ts: number } | undefined {
    const session = this.sessions.get(sessionId)
    if (!session || session.archived || session.readOnly || !this.isBusy(session.status) || session.status === 'cancelling') return undefined
    const turn = this.channelSendTurns.get(sessionId)
    return turn?.source === 'weixin' ? turn : undefined
  }

  clearFeishuTeamInput(sessionId: string): void {
    this.feishuTeamInputs.delete(sessionId)
  }

  logSession(sessionId: string, kind: string, data: unknown): void {
    this.sessionLogs.append(sessionId, kind, data)
  }

  async flushSessionLogs(): Promise<void> { await Promise.all([this.sessionLogs.flush(), this.deepseekEvents.flush()]) }
  async closeSessionLogs(): Promise<void> {
    await Promise.all(this.artifactFinalizations)
    await Promise.all([this.sessionLogs.close(), this.deepseekEvents.close()])
  }

  performanceStats(): Record<string, number> {
    return { sessions: this.sessions.size, streamers: this.streamers.size,
      sideStreamers: this.sideStreamers.size, runners: this.runners.size,
      protocolRunners: this.protocolRunners.size, zcodeRunners: this.zcodeRunners.size,
      bufferedEvents: [...this.events.values()].reduce((total, events) => total + events.length, 0),
      ...this.deepseekEvents.stats() }
  }

  private logEvent(event: UAEvent, channel: 'main' | 'side' | 'detail' = 'main'): void {
    if (channel === 'main' && (event.type === 'context_compaction' || event.type === 'error')) forgetRequirementContext(event.sessionId)
    const turnId = event.type === 'agent_message'
      ? event.payload?.turnId || this.turnCapture.get(event.sessionId)?.nativeTurnId
      : undefined
    const payload: Record<string, any> = { ...event.payload, ...(turnId ? { turnId } : {}) }
    if (event.state === 'running' && event.type !== 'agent_message') {
      for (const key of ['text', 'output', 'diff', 'delta']) {
        const value = payload[key]
        if (typeof value !== 'string') continue
        payload[`${key}Bytes`] = Buffer.byteLength(value)
        delete payload[key]
      }
    }
    this.logSession(event.sessionId, 'ua_event', {
      channel,
      event: redactInteractionAnswer({ ...event, payload })
    })
  }

  private bindAppServerDiagnostics(
    streamer: AppServerRunner,
    sessionId: string,
    channel: 'main' | 'side' | 'detail' = 'main'
  ): void {
    streamer.on('rateLimits', (snapshot: CodexRateLimits) => {
      this.emit('codexRateLimits', snapshot)
    })
    streamer.on('diagnostic', ({ kind, data }: { kind: string; data: unknown }) => {
      this.logSession(sessionId, kind, { channel, data })
      if (kind === 'title_generation_failed') {
        const issue = data && typeof data === 'object' ? data as Record<string, unknown> : {}
        const stage = typeof issue.stage === 'string' && issue.stage.trim()
          ? issue.stage.trim()
          : 'unknown'
        const detail = typeof issue.message === 'string' && issue.message.trim()
          ? issue.message.trim()
          : '未返回错误信息'
        const agentId = this.sessions.get(sessionId)?.config.agentId || 'app'
        diagnostics.record({
          category: 'app_runtime',
          level: 'error',
          source: `${agentId}-app-server${channel === 'main' ? '' : `-${channel}`}`,
          agentId,
          sessionId,
          code: kind,
          field: stage,
          message: `自动生成会话标题失败，已保留当前标题：${detail}`,
          sample: issue
        })
        return
      }
      if (kind !== 'ignored_provider_event' || !data || typeof data !== 'object') return
      const issue = data as Record<string, unknown>
      if (
        typeof issue.agentId !== 'string' ||
        typeof issue.adapter !== 'string' ||
        typeof issue.field !== 'string' ||
        typeof issue.message !== 'string'
      ) return
      diagnostics.record({
        category: 'app_runtime',
        level: 'warn',
        source: issue.adapter + '-app-server' + (channel === 'side' ? '-side' : ''),
        agentId: issue.agentId,
        sessionId,
        code: 'ignored_provider_event',
        field: issue.field,
        message: issue.message,
        sample: issue.sample
      })
    })
  }

  private disposeMainStreamer(sessionId: string): void {
    const streamer = this.removeMainStreamerOwner(sessionId)
    if (!streamer) return
    streamer.removeAllListeners()
    streamer.dispose()
  }

  private discardPreparedRun(session: Session, preparedRun: PreparedAgentRun): void {
    if (
      preparedRun.announceStreamer &&
      preparedRun.streamer &&
      this.streamers.get(session.id) === preparedRun.streamer
    ) {
      this.disposeMainStreamer(session.id)
    }
  }

  private prepareCurrentAgentRun(
    session: Session,
    acceptedInput: TurnInputSnapshot
  ): PreparedAgentRun {
    const input = snapshotTurnInput(
      acceptedInput.attachments,
      acceptedInput.nativeContext
    )
    let currentAgent: AgentDef
    try {
      currentAgent = this.requireCurrentAgentRun(session, input.attachments)
    } catch (error) {
      this.disposeMainStreamer(session.id)
      throw error
    }
    const agent = structuredClone(currentAgent)
    const normalized = this.normalizeAgentConfig(session.config, session.forkedFrom?.mode === 'cross').config
    if (normalized !== session.config) {
      this.replaceSessionConfig(session, normalized)
      this.persist()
      this.emit('sessionUpdated', { session, hasLiveStreamer: this.streamers.has(session.id) })
    }
    const config = structuredClone(session.config)
    const route = agentRunRoute(agent)
    if (route === 'zcode' && (config.fastMode || config.maxMode)) throw new Error('ZCode 当前接入不支持 Fast 或 Max 参数')
    if (route !== 'app-server') return { agent, config, route, input }
    const previous = this.streamers.get(session.id)
    const streamer = this.ensureMainStreamer(session, agent, config, false)
    return {
      agent,
      config,
      route,
      input,
      streamer,
      announceStreamer: previous !== streamer
    }
  }

  private prepareUserMessageRun(
    session: Session,
    prompt: string,
    acceptedInput: TurnInputSnapshot
  ): PreparedAgentRun {
    if (this.assistantCommandSessions.has(session.id)) throw new Error('assistant_session_busy')
    // Internal lifecycle hook only. Main never bridges it to renderer/Feishu.
    // Tests use it to model synchronous discovery/config changes immediately
    // before the atomic execution commit is created.
    const hookInput = snapshotTurnInput(
      acceptedInput.attachments,
      acceptedInput.nativeContext
    )
    this.emit('beforeUserMessageCommit', {
      sessionId: session.id,
      prompt,
      ...hookInput
    })
    return this.prepareCurrentAgentRun(session, acceptedInput)
  }

  private requireCurrentAgentRun(
    session: Session,
    attachments?: readonly Attachment[]
  ): AgentDef {
    if (this.sessions.get(session.id) !== session) throw new Error('会话不存在')
    if (this.worktreeTransitions.has(session.id)) throw new Error('正在切换工作目录，请稍后再操作')
    assertWorktreeNotRemoving(session.config)
    assertWorktreeAvailable(session.config)
    const agent = this.getAgent(session.config.agentId)
    if (
      !agent ||
      agent.id !== session.config.agentId ||
      !agent.bin.trim() ||
      agent.installed === false ||
      agent.incompatible ||
      (agent.lifecycle && agent.lifecycle.availability !== 'available')
    ) throw new Error('agent_not_available')
    if (session.pendingClaudeFork && agent.adapter !== 'claude') {
      throw new Error('此分支需要使用 Claude Code 完成首次续写')
    }
    { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, session.config) }
    requireAdvertisedPermissionMode(agent, session.config.permissionMode)
    const attachmentError = validateAttachmentsForAgent(agent, session, attachments)
    if (attachmentError) throw new Error(attachmentError)
    requirePlanCollaborationTransport(agent, session.config)
    return agent
  }

  private recordUserMessageAndRun(
    session: Session,
    prompt: string,
    preparedRun: PreparedAgentRun,
    command?: ComposerCommand,
    bubble?: TurnBubble
  ): boolean {
    if (preparedRun.route === 'zcode') {
      const item = buildDurableQueueItem(prompt, preparedRun.input.attachments, preparedRun.input.nativeContext, undefined, bubble)
      if (session.zcodeState) session.zcodeState.suspendedAfterStop = false
      this.commitQueue(session, [...(this.queues.get(session.id) || []), item])
      this.emitQueue(session.id)
      this.dispatchPendingQueue(session)
      return true
    }
    const teamStopVersion = this.teamStopVersions.get(session.id) || 0
    const auditInput = snapshotTurnInput(
      preparedRun.input.attachments,
      preparedRun.input.nativeContext
    )
    this.record(session.id, {
      type: 'user_message',
      payload: {
        text: prompt,
        ...auditInput,
        ...(command === undefined ? {} : { command }),
        ...bubblePayload(bubble)
      }
    })
    if (session.teamBinding && (this.teamStopVersions.get(session.id) || 0) !== teamStopVersion) { this.discardPreparedRun(session, preparedRun); return false }
    return this.run(
      session,
      prompt,
      preparedRun.input.attachments,
      preparedRun.input.nativeContext,
      preparedRun
    )
  }

  private rememberSubmittedUserMessage(session: Session, event: UAEvent): void {
    if (session.worktreeTask) {
      session.worktreeTask = undefined
      session.worktreeTaskError = undefined
    }
    const events = this.events.get(session.id) || []
    let userOrdinal = -1
    for (const candidate of events) {
      if (candidate.type === 'user_message' || candidate.type === 'goal_message') userOrdinal++
      if (candidate === event) break
    }
    if (userOrdinal < 0) return
    // Remember whether a human has ever continued this MCP-created session for
    // legacy records; the current message source still decides each turn's push.
    if (session.handoffId && event.payload.source !== 'mcp' && (userOrdinal > 0 || session.submittedUserMessages?.length)) {
      session.handoffUserContinued = true
    }
    const attachments = Array.isArray(event.payload?.attachments)
      ? structuredClone(event.payload.attachments as Attachment[])
      : undefined
    const nativeContext = event.payload?.nativeContext
      ? structuredClone(event.payload.nativeContext as ResolvedNativeTurnContext)
      : undefined
    const command = event.payload?.command === 'plan' || event.payload?.command === 'goal'
      ? event.payload.command as ComposerCommand
      : event.type === 'goal_message'
        ? 'goal'
        : undefined
    const comments = Array.isArray(event.payload?.comments) && event.payload.comments.length
      ? structuredClone(event.payload.comments as BubbleComment[])
      : undefined
    const displayText = typeof event.payload?.displayText === 'string' && event.payload.displayText
      ? event.payload.displayText
      : undefined
    const submitted: SubmittedUserMessage = {
      ...(session.config.assistantSnapshot ? { assistantText: String(event.payload.text || '').slice(0,65536), assistantMessageId: event.payload.assistantMessageId } : {}),
      type: event.type as SubmittedUserMessage['type'],
      ...(event.payload.appendedToTurn === true ? { appendedToTurn: true } : {}),
      source: event.payload.source === 'feishu' || event.payload.source === 'weixin' || event.payload.source === 'mcp' ? event.payload.source : 'app',
      userOrdinal,
      textHash: submittedTextHash(event.payload?.text),
      acceptedAt: event.ts,
      ...(command === undefined ? {} : { command }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(nativeContext === undefined ? {} : { nativeContext }),
      ...(comments === undefined ? {} : { comments }),
      ...(displayText === undefined ? {} : { displayText })
    }
    session.submittedUserMessages = [
      ...(session.submittedUserMessages || []).filter((item) => item.userOrdinal !== userOrdinal),
      submitted
    ].slice(-MAX_SUBMITTED_USER_MESSAGES)
    this.persist()
  }

  private run(
    session: Session,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    preparedRun?: PreparedAgentRun
  ): boolean {
    const input = preparedRun?.input || snapshotTurnInput(attachments, nativeContext)
    const agent = preparedRun?.agent || this.getAgent(session.config.agentId)
    if (!agent) {
      this.record(session.id, {
        type: 'error',
        state: 'failed',
        payload: { message: `未找到 Agent: ${session.config.agentId}` }
      })
      this.setStatus(session, 'error')
      return false
    }
    if (!preparedRun) {
      if (planCollaborationTransportError(agent, session.config)) return false
      if (agent.installed === false || (agent.lifecycle && agent.lifecycle.availability !== 'available')) {
        this.record(session.id, {
          type: 'error',
          state: 'failed',
          payload: { message: agent.lifecycle?.availability === 'needs-auth' ? `${agent.name} 尚未登录` : `${agent.name} 当前不可用，请先在设置中完成检测` }
        })
        this.setStatus(session, 'error')
        return false
      }
      try {
        { const provider = acpProviderFor(agent.adapter); if (provider) assertACPProviderConfig(provider, session.config) }
        requireAdvertisedPermissionMode(agent, session.config.permissionMode)
      } catch (error: any) {
        this.record(session.id, {
          type: 'error',
          state: 'failed',
          payload: { message: error?.message || String(error) }
        })
        this.setStatus(session, 'error')
        return false
      }
      const attachmentError = validateAttachmentsForAgent(agent, session, input.attachments)
      if (attachmentError) {
        this.record(session.id, {
          type: 'system_notice',
          payload: { kind: 'warning', text: attachmentError }
        })
        this.setStatus(session, 'idle')
        return false
      }
    }

    if (hasRequirementContext(session.config) && !preparedRun?.requirementPrepared) {
      const prepared = preparedRun || this.prepareCurrentAgentRun(session, input)
      const preparation = prepareRequirementTurn(session, prompt)
      void preparation.ready.then(text => {
        if (!preparation.current() || this.sessions.get(session.id) !== session) return
        this.run(session, text, input.attachments, input.nativeContext, { ...prepared, requirementPrepared: true })
        preparation.complete()
      }).catch(error => {
        if (!preparation.current() || this.sessions.get(session.id) !== session) return
        preparation.complete()
        forgetRequirementContext(session.id)
        this.discardPreparedRun(session, prepared)
        this.record(session.id, { type: 'error', state: 'failed', payload: { message: '需求上下文读取失败，本轮未启动：' + String(error) } })
        const activeId = this.activeQueueItems.get(session.id)
        if (activeId) this.restoreQueueItemsToPending(session, item => item.id === activeId, '需求上下文读取失败，消息已恢复为可重试状态。', { releaseActiveItemId: activeId, statusAfter: 'error' })
        else this.setStatus(session, 'error')
      })
      this.setStatus(session, 'running')
      return true
    }

    const queuedBehindActive =
      this.activeQueueItems.has(session.id) && (this.queues.get(session.id)?.length ?? 0) > 1
    this.setStatus(session, queuedBehindActive ? 'queued' : 'running')

    const route = preparedRun?.route || agentRunRoute(agent)
    if (route === 'zcode') {
      this.runZCode(session, prompt, input.attachments, input.nativeContext)
    } else if (route === 'protocol') {
      this.runProtocol(session, agent, prompt, input.attachments, preparedRun?.config, input.nativeContext)
    } else if (route === 'app-server') {
      this.runStreaming(
        session,
        agent,
        prompt,
        input.attachments,
        input.nativeContext,
        preparedRun
      )
    } else {
      this.runOneShot(session, agent, agent.adapter === 'claude' ? claudeTurnPrompt(prompt, input.nativeContext) : prompt, input.attachments, preparedRun?.config)
    }
    return true
  }

  /** After a turn finishes: drain the next queued message, else go idle. */
  private afterTurn(session: Session, interrupted = false): void {
    this.emit('assistantTurnEnded', { sessionId: session.id, interrupted: interrupted || session.status === 'error' })
    this.channelSendTurns.delete(session.id)
    // A hard interrupt (G2-9) settles to a clean terminal state and does NOT
    // auto-drain the queue — the queue was already cleared on interrupt, and the
    // user explicitly stopped, so we must not immediately kick another turn.
    if (interrupted) {
      this.activeQueueItems.delete(session.id)
      if ((this.queues.get(session.id)?.length ?? 0) === 0) {
        this.setStatus(session, 'idle')
        return
      }
      if (session.status === 'error') return
      this.setStatus(session, 'queued')
      const dispatchToken = Symbol(session.id)
      this.deferredDispatches.set(session.id, dispatchToken)
      this.emitQueue(session.id)
      setImmediate(() => {
        if (this.deferredDispatches.get(session.id) !== dispatchToken) return
        if (!this.sessions.has(session.id)) return
        this.dispatchPendingQueue(session, dispatchToken)
      })
      return
    }
    const activeItemId = this.activeQueueItems.get(session.id)
    if (activeItemId) {
      try {
        this.removeDeliveredQueueItem(session, activeItemId)
      } catch (error: any) {
        // The provider finished but durable acknowledgement failed before the
        // removal became visible. Retain the outbox item visibly; restart will
        // replay it (at-least-once).
        this.record(session.id, {
          type: 'system_notice',
          payload: {
            kind: 'warning',
            text: `消息发送完成但持久化确认失败，重启后可能重试：${error?.message || String(error)}`
          }
        })
        this.setStatus(session, 'error')
        return
      }
    }
    if ((this.queues.get(session.id)?.length ?? 0) > 0) {
      if (this.protocolRunners.has(session.id) && this.queues.get(session.id)?.[0].state === 'steering') {
        // The native turn ended before its steer receipt; the receipt owns the next dispatch.
        this.setStatus(session, 'idle')
        this.emitQueue(session.id)
        return
      }
      // 需求（队列二次编辑）— the queue is just pending messages waiting to be
      // sent; a turn that finishes while the user is still rewriting a queued
      // item leaves NOTHING executing, so the session must rest at its natural
      // terminal status (idle/completed) rather than the busy 'queued' state
      // that drives the sidebar spinner + 「正在思考」line. The frozen queue stays
      // durably pending and setQueueEditing(null) resumes it once editing ends.
      if (this.editingQueueItems.has(session.id)) {
        const frozenStatus = session.goal?.status === 'complete' && this.currentTurnIsGoal(session)
          ? 'completed'
          : 'idle'
        if (session.status !== frozenStatus) this.setStatus(session, frozenStatus)
        this.emitQueue(session.id)
        return
      }
      const dispatchToken = Symbol(session.id)
      this.deferredDispatches.set(session.id, dispatchToken)
      // Publish the between-turn boundary while the durable head is still
      // pending.  A synchronous Stop from the renderer can then invalidate the
      // token and durably clear the outbox before the next tick marks the head
      // dispatching.  Keeping the item in the outbox until a terminal result is
      // what gives restart recovery its at-least-once guarantee.
      this.emitQueue(session.id)
      setImmediate(() => {
        if (this.deferredDispatches.get(session.id) !== dispatchToken) return
        if (!this.sessions.has(session.id) || session.status === 'cancelling') return
        this.dispatchPendingQueue(session, dispatchToken)
      })
    } else {
      const status = session.goal?.status === 'complete' && this.currentTurnIsGoal(session)
        ? 'completed'
        : 'idle'
      if (session.status !== status) this.setStatus(session, status)
    }
  }

  /** Streaming path: reuse (or create) the session's AppServerRunner. */
  private runStreaming(
    session: Session,
    agent: AgentDef,
    prompt: string,
    attachments?: Attachment[],
    nativeContext?: ResolvedNativeTurnContext,
    preparedRun?: PreparedAgentRun
  ): void {
    const input = preparedRun?.input || snapshotTurnInput(attachments, nativeContext)
    const streamer = preparedRun?.streamer || this.ensureMainStreamer(session, agent)
    if (preparedRun) {
      streamer.updateAgent(preparedRun.agent)
      streamer.updateConfig(preparedRun.config)
      if (preparedRun.announceStreamer) {
        this.emit('sessionUpdated', { session, hasLiveStreamer: true })
      }
    }
    void streamer.startTurn(prompt, input.attachments, input.nativeContext)
  }

  private ensureMainStreamer(
    session: Session,
    agent: AgentDef,
    config: SessionConfig = session.config,
    announce = true,
    sharedWith?: AppServerRunner
  ): AppServerRunner {
    if (this.worktreeTransitions.has(session.id)) throw new Error('正在切换工作目录，请稍后再操作')
    assertWorktreeNotRemoving(config)
    const existing = this.streamers.get(session.id)
    if (existing?.matchesAgentRuntime(agent)) {
      existing.updateAgent(agent)
      existing.updateConfig(config)
      if (!session.titleLocked) {
        const firstUser = this.events.get(session.id)?.find((event) =>
          event.type === 'user_message' || event.type === 'goal_message'
        )
        existing.setInitialTitleSeed(firstUser?.payload?.text || '')
      }
      return existing
    }
    if (existing) this.disposeMainStreamer(session.id)
    const ref = this.seqRefs.get(session.id) || { n: 0 }
    this.seqRefs.set(session.id, ref)
    const streamer = new AppServerRunner(
      session.id,
      ref,
      agent,
      config,
      session.nativeSessionId
    )
    if (sharedWith) streamer.shareConnectionWith(sharedWith)
    if (!session.titleLocked) {
      const firstUser = this.events.get(session.id)?.find((event) =>
        event.type === 'user_message' || event.type === 'goal_message'
      )
      streamer.setInitialTitleSeed(firstUser?.payload?.text || '')
    }
    this.bindAppServerDiagnostics(streamer, session.id)
    this.installMainStreamerOwner(session.id, streamer)
    const onEvent = (ev: UAEvent): void => {
      if (this.streamers.get(session.id) !== streamer || this.sessions.get(session.id) !== session) {
        return
      }
      if (this.foldModelSwitchNotice(session, ev)) return
      ev = withInteractionState(ev, this.events.get(session.id) || [])
      const nativeSessionId =
        ev.type === 'turn_started' && typeof ev.payload?.threadId === 'string'
          ? ev.payload.threadId.trim()
          : ''
      if (nativeSessionId && nativeSessionId !== session.nativeSessionId) {
        // thread/start returns the durable resume identity before the turn ends.
        // Persist it now so a crash with queued work resumes this thread.
        this.assignNativeSessionId(session, nativeSessionId)
      }
      if (ev.type === 'queue_status') {
        const queue = ev.payload?.queue as QueueStatus | undefined
        const model = session.config.model || agent.defaultModel
        if (queue && model) {
          const estimate = this.queueWaitHistory.observe(
            `${session.id}:${String(ev.payload?.id || queue.turnId || ev.seq)}`,
            model,
            queue,
            ev.ts
          )
          if (estimate) Object.assign(queue, estimate)
        }
      }
      // 需求3 — capture per-turn file artifacts. `turn_started` carries the stable
      // native turnId; `diff_update` carries the growing aggregated diff; the
      // `done` handler finalizes a snapshot keyed by that turnId.
      this.captureTurnEvent(session, ev)
      if (ev.type === 'turn_completed') this.channelSendTurns.delete(session.id)
      const buffer = this.events.get(session.id)
      if (buffer) appendEventSnapshot(buffer, ev)
      this.logEvent(ev)
      this.bumpSessionActivity(session.id)
      this.emit('event', ev)
      // A pending server→client request flips us into awaiting-approval.
      if (ev.type === 'approval_request' && ev.state === 'pending') {
        this.setStatus(session, 'awaiting-approval')
      }
      // Doc5 — merge a sub-agent snapshot into the session so the panel + sidebar
      // reflect live child-agent state; persisted so it survives a reload.
      if (ev.type === 'subagent' && Array.isArray(ev.payload?.agents)) {
        this.upsertSubAgents(session, ev.payload.agents as UASubAgent[])
        this.persist()
      }
    }
    streamer.on('event', onEvent)
    this.bindNativeCapabilityInvalidation(streamer, session)
    streamer.on('goalChanged', (goal: GoalState | undefined) => {
      if (this.streamers.get(session.id) === streamer && this.sessions.get(session.id) === session) {
        this.updateGoalState(session, goal)
      }
    })
    streamer.on('collaborationModeChanged', (mode: 'default' | 'plan') => {
      if (
        this.streamers.get(session.id) !== streamer ||
        this.sessions.get(session.id) !== session ||
        session.config.collaborationMode === mode
      ) return
      session.config = { ...session.config, collaborationMode: mode }
      session.updatedAt = Date.now()
      streamer.updateConfig(session.config)
      this.persist()
      this.emit('sessionUpdated', { session, hasLiveStreamer: true })
    })
    streamer.on('sessionInfo', ({ title, persistProvider }: { title?: string; persistProvider?: boolean }) => {
      if (
        this.streamers.get(session.id) !== streamer ||
        this.sessions.get(session.id) !== session ||
        session.titleLocked ||
        !title
      ) return
      session.titleLocked = true
      if (title === session.title) {
        this.persist()
        if (persistProvider) void streamer.setThreadTitle(title).catch(() => {})
        return
      }
      session.title = title
      session.updatedAt = Date.now()
      this.bumpSessionActivity(session.id)
      this.persist()
      this.emit('sessionUpdated', { session, hasLiveStreamer: true })
      if (persistProvider) void streamer.setThreadTitle(title).catch(() => {})
    })
    streamer.on('configCorrection', (correction: Pick<SessionConfig, 'model' | 'maxMode'>) => {
      const next = { ...session.config, ...correction }
      const normalized = this.normalizeAgentConfig(next)
      if (
        normalized.config.model === session.config.model &&
        normalized.config.effort === session.config.effort &&
        normalized.config.maxMode === session.config.maxMode
      ) return
      session.config = normalized.config
      session.updatedAt = Date.now()
      // The warning event is emitted immediately before configCorrection. Its
      // seq is an explicit renderer watermark: usage at/before it belongs to
      // the pre-correction backend config and must no longer override the UI.
      const backendConfigCorrectionSeq = this.seqRefs.get(session.id)!.n - 1
      this.backendConfigCorrectionSeqs.set(session.id, backendConfigCorrectionSeq)
      streamer.updateConfig(session.config)
      this.persist()
      this.emit('sessionUpdated', { session, backendConfigCorrectionSeq })
    })
    streamer.on(
      'done',
      async ({ nativeSessionId, interrupted, failed }: { nativeSessionId?: string; interrupted?: boolean; failed?: boolean }) => {
        if (this.streamers.get(session.id) !== streamer || this.sessions.get(session.id) !== session) {
          return
        }
        if (nativeSessionId && nativeSessionId !== session.nativeSessionId) {
          this.assignNativeSessionId(session, nativeSessionId)
        }
        this.logSession(session.id, 'runner_done', {
          runner: 'app-server',
          nativeSessionId,
          interrupted: !!interrupted,
          failed: !!failed
        })
        const completedInput = this.currentTurnInput(session)
        const failedActiveItemId = failed ? this.activeQueueItems.get(session.id) : undefined
        const capture = this.turnCapture.get(session.id)
        // 需求3 — snapshot this turn's files BEFORE draining the queue. afterTurn
        // schedules the next turn (setImmediate), which can start writing files;
        // awaiting finalize here ensures the disk read captures THIS turn's after
        // state, not a later turn's, avoiding a snapshot race.
        const finalization = this.finalizeTurnArtifact(session)
        // Empty artifacts contain metadata only; their writes must not hold the
        // completed turn busy. File snapshots still precede the next dispatch.
        if (capture?.latestDiff || capture?.fileChanges.length) await finalization
        else void finalization
        if (this.streamers.get(session.id) !== streamer || this.sessions.get(session.id) !== session) {
          return
        }
        // Goal completion is published before artifact finalization so the whole
        // Session can leave its busy state immediately. If the user starts a new
        // turn while that best-effort finalization is pending, the old callback
        // must not overwrite the new turn's running state.
        if (failedActiveItemId && this.activeQueueItems.get(session.id) === failedActiveItemId) {
          this.restoreQueueItemsToPending(
            session,
            (item) => item.id === failedActiveItemId,
            'Provider 启动或执行失败，消息已恢复为可重试状态。',
            { releaseActiveItemId: failedActiveItemId }
          )
        }
        if (this.currentTurnInput(session) !== completedInput) return
        if (failed) {
          this.setStatus(session, 'error')
          return
        }
        this.afterTurn(session, interrupted)
      }
    )
    // A failed steer (no active turn to fold into) falls back to the queue.
    streamer.on('steerFailed', ({ prompt: p, attachments: at, nativeContext: context }: QueueItem) => {
      if (this.streamers.get(session.id) !== streamer || this.sessions.get(session.id) !== session) {
        return
      }
      const q = this.queues.get(session.id) || []
      const steering = q.find((item) => item.state === 'steering' && item.prompt === p)
      const item = buildDurableQueueItem(p, at, context, undefined, { source: steering?.source })
      if (this.currentTurnInput(session)?.payload.text === p) this.channelSendTurns.delete(session.id)
      this.commitQueue(session, [...q, item])
      this.emitQueue(session.id)
    })
    if (announce) this.emit('sessionUpdated', { session, hasLiveStreamer: true })
    return streamer
  }

  /** Read one recorded native image for the transcript. A live turn reuses its
   * protocol runner; a restored session reads through the shared, writer-free
   * Host connection so previewing never creates or resumes a session.
   * Child-session images stay unsupported until sub-agent transcripts land. */
  async readNativeImage(sessionId: string, selector: { eventSeq:number; blockIndex:number; toolResult?:boolean; childSessionId?:string }): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session?.nativeSessionId || this.rewinding.has(sessionId) || selector.childSessionId) return null
    const live = this.protocolRunners.get(sessionId)
    if (live) {
      // Kimi/Grok runners reject the selector; that is a miss, not a broken turn.
      try { return await live.readNativeImage(selector) } catch { return null }
    }
    if (this.getAgent(session.config.agentId)?.adapter !== 'deepseek') return null
    try { return await loadDeepSeekHostImage(session.nativeSessionId, selector) } catch { return null }
  }

  private ensureZCodeRunner(session: Session): Promise<ZCodeRunner> {
    if (this.worktreeTransitions.has(session.id)) return Promise.reject(new Error('正在切换工作目录，请稍后再操作'))
    assertWorktreeNotRemoving(session.config)
    const loading = this.zcodeRunnerLoads.get(session.id)
    if (loading) return loading
    const existing = this.zcodeRunners.get(session.id)
    if (existing) return existing.ensureSession().then(() => existing)
    const pool = this.zcodePool
    const operation: Promise<ZCodeRunner> = Promise.resolve(this.zcodeDisposals.get(session.id)).then(async () => {
      const config = await loadZCodeRuntimeConfig()
      if (!config) throw new Error('ZCode 运行时尚未配置')
      const runtime = await detectZCodeRuntime(config)
      if (this.sessions.get(session.id) !== session || pool !== this.zcodePool || this.zcodeRunnerLoads.get(session.id) !== operation) throw new Error('ZCode 会话已关闭')
      const ref = this.seqRefs.get(session.id) || { n: 0 }
      this.seqRefs.set(session.id, ref)
      const runner = new ZCodeRunner({ session, runtime, pool, clientId: `uniagent:${session.id}`, nextSeq: () => ref.n++,
        persist: () => { if (this.sessions.get(session.id) !== session) throw new Error('ZCode 会话已关闭'); this.persistOrThrow() },
        mcpServers: () => handoffMcpServers(session.id).map(server => ({ ...server, isolation: 'session', protocolVersion: 'legacy' })),
        cache: new ZCodeCacheStore(join(resolveUserDataHome(), 'zcode', 'cache')) })
      this.zcodeRunners.set(session.id, runner)
      this.bindZCodeRunner(session, runner)
      try {
        await runner.ensureSession()
        if (this.zcodeRunners.get(session.id) !== runner || this.zcodeRunnerLoads.get(session.id) !== operation) throw new Error('ZCode 会话已关闭')
        return runner
      } catch (error) {
        if (this.zcodeRunners.get(session.id) === runner) this.zcodeRunners.delete(session.id)
        runner.removeAllListeners(); await runner.dispose(); throw error
      }
    })
    this.zcodeRunnerLoads.set(session.id, operation)
    void operation.finally(() => { if (this.zcodeRunnerLoads.get(session.id) === operation) this.zcodeRunnerLoads.delete(session.id) }).catch(() => undefined)
    return operation
  }

  private zcodeEventCursor(sessionId: string, events: UAEvent[]): ZCodeEventCursor | undefined {
    if (this.sessions.get(sessionId)?.config.agentId !== 'zcode') return undefined
    return { generation: this.zcodeDisplayGenerations.get(sessionId) ?? 0,
      upToEventSeq: events.reduce((highest, event) => Math.max(highest, event.seq), (this.seqRefs.get(sessionId)?.n ?? 0) - 1) }
  }
  private publishZCodeSnapshot(sessionId: string, events: UAEvent[]): void {
    const generation = (this.zcodeDisplayGenerations.get(sessionId) ?? 0) + 1
    this.zcodeDisplayGenerations.set(sessionId, generation)
    const stamped = events.map(event => event.payload.zcodeProjection ? {
      ...event, payload: { ...event.payload, projectionGeneration: generation }
    } : event)
    this.events.set(sessionId, stamped)
    const snapshot: ZCodeEventsSnapshot = { sessionId, ...this.zcodeEventCursor(sessionId, stamped)!, events: structuredClone(stamped) }
    this.emit('eventsReset', snapshot)
  }
  private bindZCodeRunner(session: Session, runner: ZCodeRunner): void {
    const owns = () => this.sessions.get(session.id) === session && this.zcodeRunners.get(session.id) === runner
    const decorate = (event: UAEvent): UAEvent => {
      if (event.type !== 'user_message') return event
      const receipt = session.zcodeState?.deliveries.find(item => item.commandId === event.payload.sourceCommandId)
      const audit = receipt && this.events.get(session.id)?.find(item => ['user_message', 'goal_message'].includes(item.type) && item.payload.zcodeQueueItemId === receipt.queueItemId)
      return audit ? { ...event, payload: { ...audit.payload, ...event.payload } } : event
    }
    runner.on('eventsReset', (snapshot: UAEvent[]) => {
      if (!owns()) return
      const native = snapshot.map(decorate)
      const ids = new Set(native.filter(event => ['user_message', 'goal_message'].includes(event.type)).map(event => event.payload.zcodeQueueItemId).filter(Boolean))
      const local = (this.events.get(session.id) || []).filter(event => !event.payload.zcodeProjection && !ids.has(event.payload.zcodeQueueItemId))
      const events = [...local, ...native].sort((a, b) => a.ts - b.ts || a.seq - b.seq)
      this.publishZCodeSnapshot(session.id, events)
    })
    runner.on('event', (incoming: UAEvent) => {
      if (!owns()) return
      let event = decorate(incoming)
      if (event.payload.zcodeProjection) event = { ...event, payload: { ...event.payload,
        projectionGeneration: this.zcodeDisplayGenerations.get(session.id) ?? 0 } }
      const events = this.events.get(session.id) || []
      const index = events.findIndex(item => item.type === event.type && (event.payload.id && item.payload.id === event.payload.id
        || event.type === 'user_message' && event.payload.zcodeQueueItemId && item.payload.zcodeQueueItemId === event.payload.zcodeQueueItemId))
      if (index >= 0) events[index] = event
      else events.push(event)
      this.events.set(session.id, events)
      this.captureTurnEvent(session, event); this.logEvent(event); this.bumpSessionActivity(session.id)
      if (event.type === 'turn_completed') this.channelSendTurns.delete(session.id)
      if (index >= 0 && (event.type === 'user_message' || event.type === 'turn_completed')) this.publishZCodeSnapshot(session.id, events)
      else this.emit('event', event)
    })
    runner.on('nativeSession', ({ nativeSessionId }: { nativeSessionId: string }) => { if (owns()) this.assignNativeSessionId(session, nativeSessionId) })
    runner.on('goalChanged', (goal: GoalState | undefined) => {
      if (owns() && JSON.stringify(session.goal) !== JSON.stringify(goal)) this.updateGoalState(session, goal)
      if (owns() && !runner.isRunning() && !this.activeQueueItems.has(session.id) && !this.queues.get(session.id)?.length && session.status !== 'cancelling') {
        this.setStatus(session, runner.snapshot?.control.phase === 'error' ? 'error' : goal?.status === 'complete' ? 'completed' : 'idle')
      }
    })
    runner.on('contract', (contract: SessionAgentContract) => {
      if (!owns()) return
      session.agentContract = contract
      session.config.model = contract.currentModelId
      const model = contract.models.find(model => model.id === contract.currentModelId)
      session.config.zcodeModelSelection = model?.zcodeSelection
      session.config.effort = model?.efforts.find(level => level === model.zcodeSelection?.options?.reasoningLevel)
      if (contract.currentPermissionMode) session.config.permissionMode = contract.currentPermissionMode
      this.persistOrThrow(); this.emitAgentUpdate(session)
    })
    runner.on('state', (state: { phase: string; pendingInteractions: number }) => {
      if (!owns() || session.status === 'cancelling') return
      if (state.pendingInteractions) this.setStatus(session, 'awaiting-approval')
      else if (state.phase === 'running') this.setStatus(session, 'running')
      else if (state.phase === 'error') this.setStatus(session, 'error')
      else if (runner.isRunning() && this.activeQueueItems.has(session.id)) this.setStatus(session, 'running')
      const zcodeState = session.zcodeState
      if (zcodeState?.pendingConfig && zcodeState.pendingConfig.planEnabled === runner.snapshot?.config.planEnabled) {
        delete zcodeState.pendingConfig; this.persistOrThrow()
      }
    })
    runner.on('delivery', (record: import('../shared/zcode').ZCodeDeliveryRecord) => {
      if (!owns()) return
      const next = (this.queues.get(session.id) || []).map(item => item.id !== record.queueItemId ? item : {
        ...item, state: ['uncertain', 'failed'].includes(record.phase) ? 'pending' as const : 'dispatching' as const,
        deliveryUncertain: record.phase === 'uncertain' || undefined })
      this.commitQueue(session, next)
      if (record.phase === 'observed') this.activeQueueItems.set(session.id, record.queueItemId)
      this.emitQueue(session.id)
    })
    runner.on('done', (result: ZCodeDone) => {
      void (async () => {
        if (!owns()) return
        const receipt = session.zcodeState?.deliveries.find(item => item.commandId === result.commandId)
        const itemId = receipt?.queueItemId
        if (result.delivery === 'uncertain' || result.delivery === 'not-submitted' || result.failed) {
          if (itemId) this.commitQueue(session, (this.queues.get(session.id) || []).map(item => item.id === itemId ? {
            ...item, state: 'pending', deliveryUncertain: result.delivery === 'uncertain' || undefined } : item))
          this.activeQueueItems.delete(session.id); this.emitQueue(session.id); this.setStatus(session, 'error')
          return
        }
        if (!result.recovered) await this.finalizeTurnArtifact(session)
        if (!owns()) return
        if (itemId) this.removeDeliveredQueueItem(session, itemId)
        if (result.interrupted || session.zcodeState?.suspendedAfterStop || result.recovered) {
          this.activeQueueItems.delete(session.id)
          this.setStatus(session, 'idle'); this.emitQueue(session.id)
        } else if (session.goal?.continuation === 'native' && session.goal.autonomous) {
          this.activeQueueItems.delete(session.id); this.setStatus(session, 'running')
        } else this.afterTurn(session)
        if (session.zcodeState) {
          const queueIds = new Set((this.queues.get(session.id) || []).map(item => item.id))
          session.zcodeState.deliveries = session.zcodeState.deliveries.filter((item, index, all) => queueIds.has(item.queueItemId) || index >= all.length - 100)
          this.persistOrThrow()
        }
      })().catch(error => { if (owns()) { this.setStatus(session, 'error'); this.logSession(session.id, 'zcode_queue_reconciliation_failed', { message: String(error) }) } })
    })
  }

  private runZCode(session: Session, prompt: string, attachments?: Attachment[], nativeContext?: ResolvedNativeTurnContext): void {
    const token = Symbol(session.id)
    this.zcodeStarts.set(session.id, token)
    const itemId = this.activeQueueItems.get(session.id)
    const ownsStart = () => this.sessions.get(session.id) === session && this.zcodeStarts.get(session.id) === token
      && this.activeQueueItems.get(session.id) === itemId && this.queues.get(session.id)?.some(item => item.id === itemId)
    void (async () => {
      if (!itemId) throw new Error('ZCode 输入缺少持久化队列记录')
      const runner = await this.ensureZCodeRunner(session)
      await this.protocolConfigTails.get(session.id)
      await runner.flushConfig()
      if (!ownsStart()) return
      const records = session.zcodeState!.deliveries.filter(item => item.queueItemId === itemId)
      const prior = records.at(-1)
      if (prior?.phase === 'failed' && !prior.retryRequested) throw new Error('ZCode 上次输入已失败，请重新保存该队列条目以重试，或删除条目后继续')
      if (prior && !['prepared', 'failed'].includes(prior.phase)) throw new Error('ZCode 输入状态仍需对账，已暂停重发')
      const text = nativeContext ? zcodeContextPrompt(prompt, nativeContext, await runner.discoverCapabilities()) : prompt
      const record = prior?.phase === 'prepared' ? prior : runner.prepare(itemId, text,
        await zcodeAttachmentRefs(attachments, session.agentContract?.imageAttachments))
      if (record.submission.text !== text) throw new Error('ZCode 输入已经冻结，请恢复原始内容或删除未发送条目')
      if (!ownsStart()) return
      this.zcodeStarts.delete(session.id)
      await runner.submit(record)
    })().catch(error => {
      if (this.sessions.get(session.id) !== session) return
      if (itemId && !this.queues.get(session.id)?.some(item => item.id === itemId)) return
      if (this.zcodeStarts.get(session.id) === token) this.zcodeStarts.delete(session.id)
      const receipt = session.zcodeState?.deliveries.filter(item => item.queueItemId === itemId).at(-1)
      const uncertain = receipt && ['sent', 'acknowledged', 'uncertain', 'observed'].includes(receipt.phase)
      if (itemId) this.commitQueue(session, (this.queues.get(session.id) || []).map(item => item.id === itemId ? {
        ...item, state: 'pending', deliveryUncertain: uncertain || undefined } : item))
      this.activeQueueItems.delete(session.id); this.emitQueue(session.id)
      this.record(session.id, { type: 'error', state: 'failed', payload: { message: error instanceof Error ? error.message : 'ZCode 启动失败' } })
      this.setStatus(session, 'error')
    }).catch(error => {
      if (this.sessions.get(session.id) === session) { this.activeQueueItems.delete(session.id); this.setStatus(session, 'error') }
      this.logSession(session.id, 'zcode_start_recovery_failed', { message: String(error) })
    })
  }

  /** Protocol runners expose the same orchestration events across native transports. */
  private ensureProtocolRunner(session: Session, agent: AgentDef, config = session.config): ACPRunner | KimiWebRunner | DeepSeekHostRunner  {
    let runner = this.protocolRunners.get(session.id)
    if (!runner) {
      const ref = this.seqRefs.get(session.id) || { n: 0 }
      this.seqRefs.set(session.id, ref)
      runner =  new (agent.adapter === 'deepseek' && agent.capabilities.protocol === 'web' ? DeepSeekHostRunner : agent.adapter === 'kimi' ? KimiWebRunner : ACPRunner)(session.id, ref, agent, config, session.nativeSessionId, () => agent.adapter === 'deepseek' ? deepseekSessionRuntimeEnv(session.id, session.config) : agent.adapter === 'kimi' ? kimiSessionRuntimeEnv(session.id, session.config) : agent.adapter === 'mcode' ? mcodeSessionRuntimeEnv() : {})
      this.protocolRunners.set(session.id, runner)
      this.bindProtocolRunner(session, runner)
    }
    return runner
  }

  private runProtocol(
    session: Session,
    agent: AgentDef,
    prompt: string,
    attachments?: Attachment[],
    config: SessionConfig = session.config,
    nativeContext?: ResolvedNativeTurnContext
  ): void {
    const runner = this.ensureProtocolRunner(session, agent, config)
    const configBarrier = this.protocolConfigTails.get(session.id) || Promise.resolve()
    const startToken = Symbol(session.id)
    this.protocolPendingStarts.set(session.id, startToken)
    let started = false
    void configBarrier.then(async () => {
      if (this.protocolPendingStarts.get(session.id) !== startToken) return
      // MiniMax Code runs the permission policy inside its own process, so the
      // selected mode has to be pushed down before every turn — otherwise a
      // mid-session change would never reach the agent.
      if (session.config.requirementId || agent.adapter === 'kimi' || agent.adapter === 'deepseek' || agent.adapter === 'mcode' || agent.adapter === 'nika') await runner!.updateConfig(config)
      if (this.protocolPendingStarts.get(session.id) !== startToken) return
      this.protocolPendingStarts.delete(session.id)
      if (this.sessions.get(session.id) !== session || session.status === 'cancelling') return
      started = true
      await runner!.startTurn(prompt, attachments)
    }).catch(error => {
      if (this.sessions.get(session.id) !== session) return
      if (!started && this.protocolPendingStarts.get(session.id) !== startToken) return
      this.protocolPendingStarts.delete(session.id)
      this.record(session.id, { type: 'error', state: 'failed', payload: { message: String(error) } })
      this.setStatus(session, 'error')
    })
  }

  private bindProtocolRunner(session: Session, runner: ACPRunner | KimiWebRunner | DeepSeekHostRunner ): void {
    const ownsRunner = (): boolean =>
      this.protocolRunners.get(session.id) === runner && this.sessions.get(session.id) === session
    runner.on('configChanged', (config: SessionConfig) => {
      if (!ownsRunner() || this.deepseekConfigTransactions.has(session.id)) return
      session.config = { ...session.config, model:config.model, effort:config.effort, kimiThinking:config.kimiThinking, collaborationMode:config.collaborationMode }
      this.persist(); this.emitAgentUpdate(session)
    })
    runner.on('goalChanged', (goal: GoalState | undefined) => {
      if (ownsRunner()) this.updateGoalState(session, goal)
    })
    runner.on('goalTurn', (turn: { state: string; autonomous?: boolean; error?: unknown }) => {
      if (!ownsRunner()) return
      if (turn.state === 'running' && session.status !== 'awaiting-approval' && session.status !== 'cancelling') {
        this.setStatus(session, 'running')
      } else if (turn.state === 'error') {
        this.setStatus(session, 'error')
      }
    })
    runner.on('event', (ev: UAEvent) => {
      if (!ownsRunner()) return
      if (ev.type === 'turn_completed') this.channelSendTurns.delete(session.id)
      const events = this.events.get(session.id)
      if (events) appendEventSnapshot(events, ev)
      if (session.config.agentId === 'deepseek') this.deepseekEvents.append(session.id, ev)
      this.logEvent(ev)
      this.bumpSessionActivity(session.id)
      this.emit('event', ev)
      if (ev.type === 'approval_request' && ev.state === 'pending') {
        this.setStatus(session, 'awaiting-approval')
      }
      if (ev.type === 'subagent' && Array.isArray(ev.payload?.agents)) {
        this.upsertSubAgents(session, ev.payload.agents as UASubAgent[])
        this.persist()
      }
    })
    runner.on('nativeSession', ({ nativeSessionId, kimiDataHome, nikaBinding }: { nativeSessionId: string; kimiDataHome?: string; nikaBinding?: SessionConfig['nikaBinding'] }) => {
      if (ownsRunner() && nikaBinding) session.config.nikaBinding = nikaBinding
      if (ownsRunner() && kimiDataHome) session.config.kimiDataHome = kimiDataHome
      if (ownsRunner() && nativeSessionId !== session.nativeSessionId) {
        this.assignNativeSessionId(session, nativeSessionId)
      }
    })
    runner.on('contract', (contract: SessionAgentContract) => {
      if (!ownsRunner()) return
      if (this.deepseekConfigTransactions.has(session.id)) return
      session.agentContract = copySessionContract(contract)
      session.config.model = contract.currentModelId
      if (contract.currentPermissionMode) {
        session.config.permissionMode = contract.currentPermissionMode
      } else {
        delete session.config.permissionMode
      }
      this.bumpSessionActivity(session.id)
      this.persist()
      this.emitAgentUpdate(session)
      this.emit('nativeCapabilitiesChanged', {
        agentId: session.config.agentId,
        workdir: session.config.workdir,
        sessionId: session.id
      })
    })
    runner.on('collaborationModeChanged', (mode: 'default' | 'plan') => {
      if (!ownsRunner() || session.config.collaborationMode === mode) return
      session.config = { ...session.config, collaborationMode: mode }
      session.updatedAt = Date.now()
      this.bumpSessionActivity(session.id)
      this.persist()
      this.emit('sessionUpdated', { session, hasLiveStreamer: false })
    })
    runner.on(
      'done',
      ({
        nativeSessionId,
        interrupted,
        failed,
        authRequired
      }: { nativeSessionId?: string; interrupted?: boolean; failed?: boolean; authRequired?: boolean }) => {
        if (!ownsRunner()) return
        if (nativeSessionId && nativeSessionId !== session.nativeSessionId) {
          this.assignNativeSessionId(session, nativeSessionId)
        }
        this.logSession(session.id, 'runner_done', {
          runner: session.config.agentId,
          nativeSessionId,
          interrupted: !!interrupted,
          failed: !!failed,
          authRequired: !!authRequired
        })
        if ((session.agentContract?.nativeGoal ?? this.getAgent(session.config.agentId)?.capabilities.nativeGoal) === true && session.goal?.continuation === 'native' && !failed && !interrupted) {
          if (session.goal.autonomous) {
            const activeId = this.activeQueueItems.get(session.id)
            if (activeId) {
              try { this.removeDeliveredQueueItem(session, activeId); this.emitQueue(session.id) }
              catch (error) {
                this.record(session.id, { type: 'system_notice', payload: { kind: 'warning',
                  text: `消息发送完成但持久化确认失败：${String(error)}` } })
                this.setStatus(session, 'error')
                return
              }
            }
            if (session.status !== 'awaiting-approval' && session.status !== 'cancelling') this.setStatus(session, 'running')
            return
          }
          if (session.status === 'error') return
        }
        if (failed && ['kimi','grok','deepseek','mcode','nika'].includes(session.config.agentId)) {
          const activeId = this.activeQueueItems.get(session.id)
          if (activeId) {
            try {
              if (authRequired) this.removeDeliveredQueueItem(session, activeId)
              else this.commitQueue(session, (this.queues.get(session.id) || []).map(item => item.id === activeId ? { ...item, state: 'pending', deliveryUncertain: true } : item))
              this.activeQueueItems.delete(session.id); this.emitQueue(session.id)
            } catch { /* Retain dispatching state: restart will not replay it. */ }
          }
        }
        if (failed && (['kimi','grok','deepseek','mcode','nika'].includes(session.config.agentId) || (this.queues.get(session.id)?.length ?? 0) === 0)) {
          this.setStatus(session, 'error')
        } else {
          this.afterTurn(session, interrupted)
        }
      }
    )
  }

  private emitAgentUpdate(session: Session): void {
    if (!session.agentContract) return
    this.emit('agentUpdate', {
      sessionId: session.id,
      agentId: session.config.agentId,
      config: { ...session.config },
      contract: session.agentContract
    })
  }

  /** Claude reuses its SDK owner; fallback adapters create one runner per turn. */
  private runOneShot(
    session: Session,
    agent: AgentDef,
    prompt: string,
    attachments?: Attachment[],
    config: SessionConfig = session.config
  ): void {
    const existing = agent.adapter === 'claude' ? this.claudeSdkRunners.get(session.id) : undefined
    if (existing) {
      this.runners.set(session.id, existing)
      existing.configureClaudeGoal(session.goal)
      existing.start(agent, config, prompt, session.nativeSessionId, attachments, session.pendingClaudeFork)
      return
    }
    const ref = this.seqRefs.get(session.id)!
    const runner = new TurnRunner(session.id, ref)
    this.runners.set(session.id, runner)
    if (agent.adapter === 'claude') this.claudeSdkRunners.set(session.id, runner)
    if (agent.adapter === 'claude') runner.configureClaudeGoal(session.goal)
    runner.on('goalChanged', (goal: GoalState | undefined) => {
      if (this.claudeSdkRunners.get(session.id) === runner && this.sessions.get(session.id) === session) this.updateGoalState(session, goal)
    })

    runner.on('event', (ev: UAEvent) => {
      if ((this.runners.get(session.id) !== runner && this.claudeSdkRunners.get(session.id) !== runner) || this.sessions.get(session.id) !== session) return
      ev = withPlanText(ev, this.events.get(session.id) || [])
      this.captureTurnEvent(session, ev)
      if (ev.type === 'turn_completed') this.channelSendTurns.delete(session.id)
      if (session.pendingClaudeFork && ev.type === 'turn_started' && ev.payload.sessionId) {
        delete session.pendingClaudeFork
        this.assignNativeSessionId(session, ev.payload.sessionId)
      }
      const buffer = this.events.get(session.id)
      if (buffer) appendEventSnapshot(buffer, ev)
      this.logEvent(ev)
      this.bumpSessionActivity(session.id)
      this.emit('event', ev)
      if (ev.type === 'approval_request' && ev.state === 'pending') this.setStatus(session, 'awaiting-approval')
      if (ev.type === 'subagent' && Array.isArray(ev.payload?.agents)) {
        this.upsertSubAgents(session, ev.payload.agents)
        this.persist()
      }
    })
    runner.on('rateLimits', (snapshot: CodexRateLimits) => {
      this.emit('claudeRateLimits', snapshot)
    })
    runner.on('done', async ({ nativeSessionId, interrupted, failed }: { nativeSessionId?: string; interrupted?: boolean; failed?: boolean }) => {
      if (this.runners.get(session.id) !== runner || this.sessions.get(session.id) !== session) return
      if (nativeSessionId && nativeSessionId !== session.nativeSessionId) {
        this.assignNativeSessionId(session, nativeSessionId)
      }
      await this.finalizeTurnArtifact(session)
      if (this.runners.get(session.id) !== runner || this.sessions.get(session.id) !== session) return
      this.logSession(session.id, 'runner_done', { runner: 'one-shot', nativeSessionId, interrupted: !!interrupted, failed: !!failed })
      const details = this.completedSubAgentItems.get(session.id) || new Map<string, UAEvent[]>()
      for (const child of session.subagents || []) {
        const items = runner.getSubAgentItems(child.agentThreadId)
        if (items.length) details.set(child.agentThreadId, items)
      }
      this.completedSubAgentItems.set(session.id, details)
      this.runners.delete(session.id)
      if (failed) {
        const activeId = this.activeQueueItems.get(session.id)
        if (activeId) {
          this.restoreQueueItemsToPending(
            session,
            (item) => item.id === activeId,
            'Claude 启动或执行失败，消息已恢复为可重试状态。',
            { releaseActiveItemId: activeId }
          )
        }
        this.setStatus(session, 'error')
        return
      }
      this.afterTurn(session, interrupted)
    })

    runner.start(agent, config, prompt, session.nativeSessionId, attachments, session.pendingClaudeFork)
  }
}

/**
 * Session identity key for de-dup (Doc5 T3). A session is uniquely identified by
 * its (agentId, nativeSessionId) once the native id is known; before that the
 * local id stands in, so drafts never collide and fold into their identity the
 * moment a nativeSessionId lands.
 */
export function dedupKey(s: Session): string {
  return sessionDedupKey(s)
}

function resolveCreatePermissionMode(
  agent: AgentDef,
  requested: SessionConfig['permissionMode']
): SessionConfig['permissionMode'] {
  const modes = agent.capabilities.permissionModes
  if (modes.length === 0) throw new Error(`${agent.name} 未声明可用权限模式`)
  if (!requested) return modes[0].id
  if (!modes.some((mode) => mode.id === requested)) {
    throw new Error(`${agent.name} 不支持权限模式：${requested}`)
  }
  return requested
}

function requireAdvertisedPermissionMode(
  agent: AgentDef,
  requested: SessionConfig['permissionMode']
): NonNullable<SessionConfig['permissionMode']> {
  if (!requested) throw new Error(`${agent.name} 缺少有效权限模式`)
  if (!agent.capabilities.permissionModes.some((mode) => mode.id === requested)) {
    throw new Error(`${agent.name} 不支持权限模式：${requested}`)
  }
  return requested
}

function planCollaborationTransportError(
  agent: AgentDef,
  config: SessionConfig
): string | undefined {
  if (config.collaborationMode !== 'plan') return undefined
  if (agent.adapter === 'claude') return undefined
  if (isACPAdapter(agent.adapter) || agent.adapter === 'zcode') return undefined
  if (agent.adapter !== 'codex' && agent.adapter !== 'traex') {
    return 'plan_collaboration_requires_app_server'
  }
  if (!usesAppServer(agent)) return 'plan_collaboration_requires_app_server'
  return undefined
}

function agentRunRoute(agent: AgentDef): 'protocol' | 'app-server' | 'one-shot' | 'zcode' {
  if (agent.adapter === 'zcode') return 'zcode'
  if (agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web') return 'protocol'
  return usesAppServer(agent) ? 'app-server' : 'one-shot'
}

function requirePlanCollaborationTransport(agent: AgentDef, config: SessionConfig): void {
  const error = planCollaborationTransportError(agent, config)
  if (error) throw new Error(error)
}

function validateAttachmentsForAgent(
  agent: AgentDef,
  session: Session,
  attachments?: readonly Attachment[]
): string | undefined {
  if (!attachments?.length) return undefined
  if (!agentSupportsAttachments(agent)) return ATTACHMENT_UNSUPPORTED_MESSAGE
  // A fresh ACP session has not negotiated prompt capabilities yet, so the
  // runner remains the authority for its first turn. Once a session contract
  // exists, reject each unsupported kind at the orchestrator boundary as well
  // (including restored sessions) instead of treating attachment support as a
  // single coarse boolean.
  if ((!isACPAdapter(agent.adapter)) || !session.agentContract) return undefined
  if (attachments.some((attachment) => attachment.kind === 'image') &&
      session.agentContract.imageAttachments !== true) {
    return `当前 ${agent.name} 未声明图片输入能力`
  }
  if (attachments.some((attachment) => attachment.kind === 'file') &&
      session.agentContract.fileAttachments !== true) {
    return `当前 ${agent.name} 不支持文件附件`
  }
  return undefined
}

function updatedAtOf(s: Session): number {
  return s.updatedAt ?? s.createdAt
}

function appendHistoryConfigWarning(
  events: UAEvent[],
  ref: { n: number },
  sessionId: string,
  agent: AgentDef,
  config: SessionConfig,
  maxModeDisabled: boolean,
  contextWindow?: number
): void {
  const selectedModel = agent.models.find((model) => model.id === config.model)
  const expectedWindow = config.maxMode
    ? selectedModel?.maxContextWindow
    : selectedModel?.contextWindow
  if (!maxModeDisabled && !isMaterialContextWindowMismatch(contextWindow, expectedWindow)) return
  events.push({
    sessionId,
    seq: ref.n++,
    ts: Date.now(),
    type: 'system_notice',
    payload: {
      kind: 'warning',
      text: maxModeDisabled
        ? `历史记录请求 Max，但模型 ${config.model || ''} 当前不支持，已恢复为标准模式。`
        : `历史上下文窗口为 ${contextWindow}，当前模型配置窗口为 ${expectedWindow}；请确认模型或 Max 模式是否已变化。`
    }
  })
}

function validAbsoluteCwd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && !trimmed.includes(String.fromCharCode(0)) && isAbsolute(trimmed)
    ? trimmed
    : undefined
}

function copySessionContract(contract: SessionAgentContract): SessionAgentContract {
  return {
    ...(contract.grokNative ? { grokNative: structuredClone(contract.grokNative) } : {}),
    models: contract.models.map((model) => ({ ...model, efforts: [...model.efforts] })),
    currentModelId: contract.currentModelId,
    permissionModes: contract.permissionModes.map((mode) => ({ ...mode })),
    currentPermissionMode: contract.currentPermissionMode,
    imageAttachments: contract.imageAttachments === true,
    fileAttachments: contract.fileAttachments === true,
    sessionList: contract.sessionList === true,
    sessionLoad: contract.sessionLoad === true,
    sessionResume: contract.sessionResume === true,
    steer: contract.steer === true,
    followup: contract.followup === true,
    sessionFork: contract.sessionFork === true,
    sessionForkAtTurn: contract.sessionForkAtTurn === true,
    crossAgentFork: contract.crossAgentFork === true,
    sideChat: contract.sideChat === true,
    structuredSubagents: contract.structuredSubagents === true,
    formElicitation: contract.formElicitation === true,
    freeTextElicitation: contract.freeTextElicitation === true,
    nativeGoal: contract.nativeGoal === true,
    nativeReview: contract.nativeReview === true,
    structuredUsage: contract.structuredUsage === true,
    capabilityInventory: contract.capabilityInventory === true,
    additionalDirectoriesNew: contract.additionalDirectoriesNew === true,
    additionalDirectoriesResume: contract.additionalDirectoriesResume === true,
    commands: [...contract.commands],
    collaborationModes: [...(contract.collaborationModes || [])]
  }
}
