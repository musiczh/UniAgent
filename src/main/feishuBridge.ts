import { buildDecisionAnswer } from '../shared/approvalDecision'
import { INTERNAL_DISTRIBUTION } from '../shared/distribution'
export { buildDecisionAnswer } from '../shared/approvalDecision'
import { parseAssistantCommand } from '../shared/assistant'
import { resolveAgentModel, resolveAgentPermission, resolveModelEffort } from '../shared/agentChoices'
import { powerMonitor, systemPreferences } from 'electron'
import { WSClient, EventDispatcher, Client, defaultHttpInstance, normalizeCardAction } from '@larksuiteoapi/node-sdk'
import { constants, readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, realpath, rm, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Orchestrator } from './orchestrator'
import { teamInteractionForUser, teamQuestionParams } from '../shared/teamQuestions'
import type { TeamService, TeamInitialTurn } from './teamService'
import type { TeamCreateProjectInput, TeamDefinition, TeamProject, TeamInteraction } from '../shared/teamTypes'
import type { Requirement } from '../shared/requirementTypes'
import type { FeishuThreadStore } from './feishuThreadStore'
import { appendFeishuContext, splitFeishuContext } from '../shared/feishuContext'
import { stripAssistantContext } from './assistant/context'
import { asInteractionRequest, planFeedbackInAnswer } from '../shared/interactionRequests'
import { agentForSession, isToolSession } from '../shared/types'
import { isSessionBusy } from '../shared/sessionStatus'
import { feishuModelCard, feishuModelPatch, feishuModelSummary, modelDepth, selectFeishuModel, type FeishuModelSelection } from './feishuModelCard'
import {
  normalizeQuestions,
  encodeAnswer,
  validateQuestionAnswer,
  questionAnswerValues,
  questionAnswerKind,
  isMcpToolApproval,
  mcpToolApprovalDetail,
  mcpToolApprovalScopes,
  OTHER_VALUE,
  type NormalizedField
} from '../shared/questions.ts'
import type {
  AgentDef,
  Attachment,
  FeishuGroupChat,
  FeishuNotificationBinding,
  FeishuNotificationTarget,
  FeishuSettings,
  FeishuStatus,
  FeishuThreadLink,
  PermissionModeId,
  Project,
  ReasoningEffort,
  Session,
  SessionConfig,
  UAEvent,
  UAEState
} from '../shared/types.ts'

/** Expected user/input failures returned to the caller without creating runtime diagnostics. */
export class FeishuSendValidationError extends Error {
  override name = 'FeishuSendValidationError'
}

/**
 * 需求4（飞书 Bot 远程驱动）— the main-process bridge that lets a user keep
 * driving UniAgent sessions from Feishu while away from the Mac.
 *
 * Responsibilities (see docs/feishu-bot-remote-drive-proposal.md §4/5):
 *  - Own a single `WSClient` long-connection (inbound) + `Client` (outbound).
 *  - Gate pushes behind a lock-screen / idle门禁 (powerMonitor) so the user is
 *    only notified while away from the keyboard.
 *  - Subscribe to orchestrator `event`s and push each session's terminal
 *    results / approvals into the session's bound Feishu 话题(thread).
 *  - Route inbound: card button → `respondToRequest`; thread text reply →
 *    answer a pending question or directly send/steer; unknown p2p message →
 *    `createSession` with the configured defaults.
 *
 * The card callback must ACK within 3s, so it returns a toast synchronously and
 * drives the orchestrator + patches the card asynchronously.
 */

/** What the bridge needs from the rest of main, injected so it stays testable. */
export interface FeishuBridgeDeps {
  orchestrator: Orchestrator
  teams?: TeamService
  threadStore: FeishuThreadStore
  /** Live agent list (for private-chat session defaults). */
  getAgents: () => AgentDef[]
  /** Current persisted Feishu config, or undefined when not configured. */
  getSettings: () => FeishuSettings | undefined
  saveNotificationTarget?: (target: FeishuNotificationTarget | undefined) => void
  getAgentPref?: (agentId: string) => import('../shared/types').AgentPref | undefined
  getProjects?: () => Project[]
  getRequirements?: () => Requirement[]
  resolveProjectConfig?: (config: SessionConfig) => SessionConfig
  createTeamProject?: (input: TeamCreateProjectInput, beforeStart: (project: TeamProject) => void, initialTurn?: TeamInitialTurn) => Promise<TeamProject>
  /** Push a status delta to the renderer (settings badge). */
  onStatus: (status: FeishuStatus) => void
  onError?: (message: string, context?: Record<string, unknown>) => void
  onLog?: (sessionId: string | undefined, kind: string, data: Record<string, unknown>) => void
  /** 需求4(同步) — surface a Feishu-created session in the app sidebar live (index.ts
   *  wires this to `mainWindow.send(IPC.sessionCreated, …)`, same push the handoff
   *  path uses). Without it a session started from Feishu只 appears after a manual
   *  refresh — its 话题 ↔ session binding wasn't visible in the app. */
  onSessionCreated?: (session: Session) => void
  onSessionUpdated?: (session: Session) => void
  assistantCommand?: (sessionId: string, command: 'new' | 'clear', requestId: string) => Promise<Session>
  acceptsSession?: (session: Session) => boolean
  createAssistantSession?: (text: string, attachments: Attachment[], bind: (session: Session) => void, assertCurrent: () => void) => Promise<Session>
}

/** In-memory record of a thread's currently-awaited question/elicitation. */
interface PendingAnswerable {
  sessionId: string
  requestId: string
  kind: string
  method: string
  /** codex question id (params.questions[0].id) — used to shape a text reply. */
  qid?: string
  /** MCP elicitation first property key — used to shape a text reply. */
  prop?: string
  /** Normalized fields — lets a card submit encode ALL questions' answers. */
  fields?: NormalizedField[]
}

interface RequestCardState {
  sessionId: string
  requestSeq: number
  messageId?: string
  kind: string
  v2: boolean
  source?: 'feishu'
  submitting?: boolean
  settled?: boolean
  resolved?: object
}

/** 需求 — the user's config choices carried by the new-topic card. */
interface TopicSelection {
  projectId: string
  requirementId?: string
  executor: 'agent' | 'team'
  agentId: string
  teamId?: string
  model?: string
  effort?: ReasoningEffort
}

/** 需求 — a new-topic message awaiting its config card 开始 press. */
interface TopicOffer {
  text: string
  imageKeys: string[]
  chatId: string
  userMessageId: string
  sel: TopicSelection
  cardMessageId?: string
  threadId?: string
}

interface ModelCardState {
  id: string
  link: FeishuThreadLink
  selection: FeishuModelSelection
  messageId?: string
  submitting?: boolean
  resolved?: object
}

interface ProgressCardState {
  teamRunId?: number
  teamWaiting?: boolean
  lastTurnEvent?: UAEvent
  sessionId: string
  turnId?: string
  previous?: ProgressCardState
  cardId?: string
  messageId?: string
  replyUuid: string
  sequence: number
  startedAt: number
  status: 'running' | 'waiting'
  /** Ordered `payload.id → accumulated snapshot` for every reasoning/agent_message
   *  段: same-id events grow one segment in place, different ids append after it, so
   *  the card keeps EVERY output段 in order instead of overwriting the previous one. */
  segments: Map<string, string>
  answer?: string
  interruptRequested?: boolean
  flushing?: boolean
  operation?: string
  requestStartedAt?: number
  lastEventAt: number
  lastEventType: UAEvent['type']
  lastEventSeq: number
  lastSuccessAt?: number
  lastHealthAt?: number
  final?: { event: UAEvent; success: boolean; result: string; endedAt: number; link?: FeishuThreadLink; sending?: boolean; sent?: boolean; replySkipped?: boolean; retryAt?: number; failureCount?: number }
  cardFinished?: boolean
  streamingClosed?: boolean
  failureCount?: number
  disabled?: boolean
  retryAt?: number
  timer?: ReturnType<typeof setInterval>
}

const CARD_MSG_TYPE = 'interactive'
/** Running card refreshes on a steady 1s cadence so the elapsed time ticks even
 *  while the Agent is silent (e.g. a long tool call with no reasoning output). */
const PROGRESS_TICK_MS = 1000
const PROGRESS_RETRY_BASE_MS = 5000
const PROGRESS_RETRY_MAX_MS = 60_000
const PROGRESS_MAX_FAILURES = 10
const FEISHU_REQUEST_TIMEOUT_MS = 15_000
const TITLE_RETRY_MS = 60_000
const PROGRESS_HEALTH_MS = 30_000
const INVALID_CARD_IMAGE_KEY_CODE = 200570
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.heic', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])
const IMAGE_LIMIT = 10 * 1024 * 1024
const FILE_LIMIT = 30 * 1024 * 1024
const FEISHU_IMAGE_TYPES: Record<string, { extension: string; mime: string }> = {
  'image/bmp': { extension: '.bmp', mime: 'image/bmp' },
  'image/gif': { extension: '.gif', mime: 'image/gif' },
  'image/heic': { extension: '.heic', mime: 'image/heic' },
  'image/jpeg': { extension: '.jpg', mime: 'image/jpeg' },
  'image/png': { extension: '.png', mime: 'image/png' },
  'image/tiff': { extension: '.tiff', mime: 'image/tiff' },
  'image/webp': { extension: '.webp', mime: 'image/webp' }
}
/** Emoji we add to an inbound message while its turn runs, removed when done. */
const ACK_EMOJI = 'OnIt'

export async function fetchFeishuBotName(appId: string, appSecret: string, signal?: AbortSignal): Promise<string> {
  configureFeishuHttp()
  try {
    const result = await new Client({ appId, appSecret,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} }
    }).request<{ code?: number; bot?: { app_name?: string } }>({
      url: '/open-apis/bot/v3/info', method: 'GET', timeout: 15000, signal
    })
    const name = result.bot?.app_name?.trim()
    if (result.code !== 0 || !name) throw new Error('invalid_bot_info')
    return name
  } catch {
    throw new Error('无法获取机器人信息，请检查 App ID、App Secret 和网络后重试')
  }
}

export class FeishuBridge {
  private readonly deps: FeishuBridgeDeps
  private readonly startedAt = Date.now()
  private ws: WSClient | null = null
  private client: Client | null = null
  private botName: string | undefined
  private connected = false
  private screenLocked = false
  private screenSleeping = false
  private screenSleepSubscription: number | undefined
  private screenWakeSubscription: number | undefined
  private phase: FeishuStatus['phase'] = 'idle'
  private lastMessage: string | undefined
  /** Serialize per-session pushes so two events never race the首推建话题. */
  private pushChains = new Map<string, Promise<void>>()
  private deliveredReplySeqs = new Map<string, number>()

  isTurnReplyDelivered(sessionId: string, seq: number): boolean {
    return (this.deliveredReplySeqs.get(sessionId) ?? -1) >= seq
  }
  /** sessionId/requestId → each independently answerable question. */
  private pending = new Map<string, PendingAnswerable>()
  private teamPushRevisions = new Map<string, string>()
  private teamPushPending = new Map<string, symbol>()
  private teamCards = new Map<string, { revision: number; messageId?: string; source?: 'feishu'; submitting?: boolean }>()
  private teamMaterialMessages = new Set<string>()
  /** sessionId/requestId → each approval awaiting a button decision. Lets the
   *  resolved card echo WHAT was approved (which files / command), mirroring the
   *  question card that replays the answered questions after submit. */
  private pendingApprovals = new Map<string, { sessionId: string; requestId: string; kind: string; method: string; params: any; options?: unknown }>()
  private requestCards = new Map<string, RequestCardState>()
  private requestEvents = new Map<string, UAEvent>()
  /** sessionId → the inbound message we reacted to (removed when the turn ends). */
  private ack = new Map<string, { messageId: string; reactionId?: string }>()
  /** message_ids WE sent (root/replies) — inbound echoes of these are dropped so
   *  the bot never treats its own message as user input (self-reply death loop). */
  private sentMessageIds = new Set<string>()
  /** Concurrent Feishu redeliveries share the same acceptance result. */
  private processingInbound = new Map<string, Promise<void>>()
  /** Business accepted but the completed-id write failed; retry only that write. */
  private acceptedInbound = new Set<string>()
  /** Explicit business failures may retry in-process even while disk says pending. */
  private retryableInbound = new Set<string>()
  private progressCards = new Map<string, ProgressCardState>()
  private finishingCards = new Set<ProgressCardState>()
  private clientAppId: string | undefined
  private clientAppSecret: string | undefined
  private connectionGeneration = 0
  private threadFlights = new Map<string, Promise<FeishuThreadLink | undefined>>()
  /** Serialize explicit restarts and configuration changes. */
  private connectionTail: Promise<void> = Promise.resolve()
  /** Resident assistant fallback; task notifications use their explicitly saved destination. */
  private defaultChatId: string | undefined
  private notificationBinding: FeishuNotificationBinding | undefined
  private lockHandler = (): void => { this.screenLocked = true }
  private unlockHandler = (): void => { this.screenLocked = false }

  constructor(deps: FeishuBridgeDeps) {
    this.deps = deps
    try {
      powerMonitor.on('lock-screen', this.lockHandler)
      powerMonitor.on('unlock-screen', this.unlockHandler)
    } catch { /* powerMonitor may be unavailable in headless test hosts */ }
    try {
      this.screenSleepSubscription = systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceScreensDidSleepNotification',
        () => { this.screenSleeping = true }
      )
      this.screenWakeSubscription = systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceScreensDidWakeNotification',
        () => { this.screenSleeping = false }
      )
    } catch { /* Workspace notifications are macOS-only. */ }
  }

  getStatus(): FeishuStatus {
    const settings = this.deps.getSettings()
    return {
      enabled: !!settings?.enabled,
      connected: this.connected,
      phase: this.phase,
      appId: settings?.appId || undefined,
      botName: this.botName || settings?.botName,
      notificationTarget: settings?.notifyChatId ? {
        kind: settings.notifyChatType || 'group', chatId: settings.notifyChatId, name: settings.notifyChatName
      } : undefined,
      notificationBinding: this.notificationBinding ? { ...this.notificationBinding } : undefined,
      message: this.lastMessage
    }
  }

  private emitStatus(): void {
    this.deps.onStatus(this.getStatus())
  }

  beginNotificationBinding(input: FeishuNotificationBinding): FeishuStatus {
    if (!this.connected || !this.deps.getSettings()?.enabled) throw new Error('飞书 Bot 未连接')
    if (!this.deps.saveNotificationTarget || this.deps.createAssistantSession) throw new Error('该机器人不支持任务通知绑定')
    if (!input || !['private', 'group'].includes(input.kind) ||
      input.chatId !== undefined && (typeof input.chatId !== 'string' || !input.chatId.trim() || input.chatId.length > 200) ||
      input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200)) throw new Error('请选择有效的通知绑定方式')
    if (input.kind === 'group' && input.chatId) {
      this.persistNotificationTarget({ kind: 'group', chatId: input.chatId, name: input.name })
      this.notificationBinding = undefined
    } else {
      this.notificationBinding = { kind: input.kind }
    }
    this.emitStatus()
    return this.getStatus()
  }

  cancelNotificationBinding(): FeishuStatus {
    this.notificationBinding = undefined
    this.emitStatus()
    return this.getStatus()
  }

  unbindNotificationTarget(): FeishuStatus {
    if (!this.deps.saveNotificationTarget) throw new Error('该机器人不支持任务通知绑定')
    this.deps.saveNotificationTarget(undefined)
    if (this.deps.getSettings()?.notifyChatId) throw new Error('解绑未能保存，请重试')
    return this.cancelNotificationBinding()
  }

  private isNotificationBindingMessage(data: any): boolean {
    const binding = this.notificationBinding
    const message = data?.message
    if (binding?.kind !== 'private' || !this.connected || data?.sender?.sender_type !== 'user' ||
      message?.message_type !== 'text' || !message.chat_id ||
      !stripMentions(extractMessageContent(message.content, message.message_type).text)) return false
    return message.chat_type === 'p2p'
  }

  private persistNotificationTarget(target: FeishuNotificationTarget): void {
    this.deps.saveNotificationTarget!(target)
    const saved = this.deps.getSettings()
    if (!saved || saved.notifyChatId !== target.chatId || saved.notifyChatType !== target.kind) throw new Error('绑定未能保存，请重试')
  }

  private completeNotificationBinding(data: any): boolean {
    if (!this.isNotificationBindingMessage(data)) return false
    const binding = this.notificationBinding!
    const target = { kind: binding.kind, chatId: data.message.chat_id, name: binding.name }
    try {
      this.persistNotificationTarget(target)
      this.notificationBinding = undefined
    } catch {
      this.notificationBinding = { ...binding, error: '绑定未完成，请重新发送消息重试' }
    }
    this.emitStatus()
    return true
  }

  /** Set the wizard/connection phase and notify the renderer. */
  setPhase(phase: FeishuStatus['phase'], message?: string): void {
    this.phase = phase
    this.lastMessage = message
    this.emitStatus()
  }

  /**
   * Reuse the current connection (including its pending handshake/reconnect)
   * when Agent discovery or notification settings refresh. Only credential
   * changes, terminal failures and explicit recovery replace the clients.
   */
  async start(options: { force?: boolean } = {}): Promise<void> {
    const operation = this.connectionTail.then(() => this.startNow(options.force))
    this.connectionTail = operation.catch(() => {})
    return operation
  }

  private async startNow(force = false): Promise<void> {
    const settings = this.deps.getSettings()
    if (!force && settings?.enabled && this.ws && this.client && this.phase !== 'failed' &&
      settings.appId === this.clientAppId && settings.appSecret === this.clientAppSecret) return
    const preserveProgress = !!settings?.enabled && !!settings.appId && settings.appId === this.clientAppId
    await this.stopNow(preserveProgress)
    if (!settings?.enabled || !settings.appId || !settings.appSecret) {
      this.setPhase('idle')
      return
    }
    try {
      configureFeishuHttp()
      this.clientAppId = settings.appId
      this.clientAppSecret = settings.appSecret
      this.client = new Client({ appId: settings.appId, appSecret: settings.appSecret })
      this.botName = settings.botName
      if (!this.botName) {
        const client = this.client
        void fetchFeishuBotName(settings.appId, settings.appSecret).then(name => {
          if (this.client !== client) return
          this.botName = name
          this.emitStatus()
        }).catch(() => {})
      }
      this.log(undefined, 'connection_start', { preserved: preserveProgress, cards: this.allProgressCards().length })
      const generation = this.connectionGeneration
      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          if (generation !== this.connectionGeneration) return
          if (!data?.message || data?.sender?.sender_type === 'app') return
          const id: string = data?.message?.message_id || data?.event_id || data?.uuid || ''
          if (id && this.sentMessageIds.has(id)) return
          if (!id) return this.onInboundMessage(data)
          const createdAt = Number(data.message.create_time)
          const createdAtMs = createdAt < 1e12 ? createdAt * 1000 : createdAt
          // Do not resurrect old commands after an update/restart. Keep one minute
          // for clock skew and messages sent while this process is still starting.
          if (Number.isFinite(createdAtMs) && createdAtMs > 0 && createdAtMs < this.startedAt - 60_000) {
            this.deps.threadStore.rememberInbound(id)
            return
          }
          if (this.acceptedInbound.has(id)) {
            this.deps.threadStore.rememberInbound(id)
            this.acceptedInbound.delete(id)
            return
          }
          const active = this.processingInbound.get(id)
          if (active) return active
          const retrying = this.retryableInbound.has(id)
          if (!retrying && this.deps.threadStore.hasHandledInbound(id)) return
          const isNewPrivateMessage = data.message.chat_type === 'p2p' &&
            !data.message.thread_id && !data.message.parent_id && !data.message.root_id
          if (isNewPrivateMessage && !this.isNotificationBindingMessage(data) && !this.deps.getAgents().some((agent) =>
            agent.lifecycle?.availability === 'available'
          )) throw new Error('没有可接收飞书消息的 Agent')
          if (!this.deps.threadStore.hasPendingInbound(id)) this.deps.threadStore.reserveInbound(id)
          const operation = this.onInboundMessage(data).then(() => {
            this.acceptedInbound.add(id)
            this.deps.threadStore.rememberInbound(id)
            this.acceptedInbound.delete(id)
            this.retryableInbound.delete(id)
          }).catch((error) => {
            if (!this.acceptedInbound.has(id)) {
              this.retryableInbound.add(id)
              try { this.deps.threadStore.forgetInbound(id) } catch { /* pending remains retryable */ }
            }
            console.error('[feishu] inbound message failed:', safeErr(error))
            this.deps.onError?.(safeErr(error))
            throw error
          })
          this.processingInbound.set(id, operation)
          try { await operation } finally {
            if (this.processingInbound.get(id) === operation) this.processingInbound.delete(id)
          }
        },
        // The WS transport dispatches card callbacks through the same handler
        // map (lib/index.js) with key 'card.action.trigger'. Its return value
        // becomes the base64 response payload → toast/card update.
        'card.action.trigger': async (raw: unknown) => {
          if (generation !== this.connectionGeneration) return
          try { return await this.onCardAction(raw) } catch { return undefined }
        }
      } as Record<string, (arg: any) => unknown>)
      const ws = new WSClient({
        appId: settings.appId,
        appSecret: settings.appSecret,
        handshakeTimeoutMs: FEISHU_REQUEST_TIMEOUT_MS,
        onReady: () => { if (this.ws === ws) this.connectionReady('connection_ready') },
        onError: (err) => {
          if (this.ws !== ws) return
          this.connected = false
          this.log(undefined, 'connection_failed', this.logErrorDetails(err))
          this.setPhase('failed', safeErr(err))
        },
        onReconnecting: () => {
          if (this.ws !== ws) return
          this.connected = false
          this.setPhase('installing', '正在重新连接…')
          this.log(undefined, 'connection_reconnecting', { cards: this.allProgressCards().length })
        },
        onReconnected: () => { if (this.ws === ws) this.connectionReady('connection_reconnected') }
      })
      this.ws = ws
      this.setPhase('installing', '正在建立长连接…')
      // The SDK starts its reconnect loop here; onReady signals the actual handshake.
      await ws.start({ eventDispatcher: dispatcher })
    } catch (err) {
      const ws = this.ws
      this.connected = false
      this.ws = null
      this.client = null
      try { ws?.close({ force: true }) } catch { /* already closed */ }
      this.log(undefined, 'connection_start_failed', this.logErrorDetails(err))
      this.setPhase('failed', safeErr(err))
    }
  }

  /** Close the long connection (best effort) and reset live state. */
  async stop(): Promise<void> {
    const operation = this.connectionTail.then(() => this.stopNow())
    this.connectionTail = operation.catch(() => {})
    return operation
  }

  private async stopNow(preserveProgress = false): Promise<void> {
    this.connectionGeneration++
    this.modelCards.clear()
    this.log(undefined, 'connection_stop', { preserved: preserveProgress, cards: this.allProgressCards().length })
    const ws = this.ws
    this.ws = null
    this.client = null
    this.clientAppSecret = undefined
    this.connected = false
    this.botName = undefined
    if (!preserveProgress) {
      this.clientAppId = undefined
      this.notificationBinding = undefined
      this.defaultChatId = undefined
      this.sessionChat.clear()
      this.pushChains.clear()
      this.threadFlights.clear()
      this.pending.clear()
      this.pendingApprovals.clear()
      this.requestCards.clear()
      this.requestEvents.clear()
      this.teamPushRevisions.clear()
      this.teamPushPending.clear()
      this.teamCards.clear()
      this.teamMaterialMessages.clear()
      this.ack.clear()
      for (const state of this.allProgressCards()) {
        if (state.timer) clearInterval(state.timer)
        this.logProgress(state, 'progress_discarded', { reason: 'bridge_stopped_or_bot_changed' })
      }
      this.progressCards.clear()
      this.finishingCards.clear()
      this.sentMessageIds.clear()
    }
    if (ws) {
      try { ws.close({ force: true }) } catch { /* already closed */ }
    }
    if (this.phase === 'connected') this.setPhase('idle')
  }

  private connectionReady(kind: string): void {
    this.connected = true
    this.setPhase('connected', '已连接')
    this.log(undefined, kind, { cards: this.allProgressCards().length })
    for (const progress of this.allProgressCards()) {
      this.logProgress(progress, 'progress_resumed')
      this.scheduleProgressFlush(progress)
      this.queueProgressFlush(progress)
    }
    for (const [key, card] of this.requestCards) {
      if (card.resolved) this.enqueuePush(card.sessionId, () => this.patchRequestCard(key, card))
    }
    for (const [key, event] of this.requestEvents) {
      if (event.state === 'pending' && !event.payload.interactionExpired && !this.requestCards.has(key) && this.shouldPushFor(event.sessionId) && (!this.deps.orchestrator.getSessionById(event.sessionId)?.teamBinding || event.payload.method === 'local/plan' || event.payload.channel === 'side')) this.enqueuePush(event.sessionId, () => this.pushEvent(event))
    }
    this.handleTeamChanged()
    void this.syncThreadTitles()
  }

  private async syncThreadTitles(): Promise<void> {
    const client = this.client
    for (const link of this.deps.threadStore.all()) {
      if (this.client !== client) return
      const session = this.deps.orchestrator.getSessionById(link.sessionId)
      if (session) this.handleSessionUpdated(session)
      await this.pushChains.get(link.sessionId)
    }
  }

  private allProgressCards(): ProgressCardState[] {
    return [...this.progressCards.values(), ...this.finishingCards]
  }

  private ownsProgress(progress: ProgressCardState): boolean {
    return this.progressCards.get(progress.sessionId) === progress || this.finishingCards.has(progress)
  }

  /** Detach powerMonitor listeners; call on app teardown. */
  dispose(): void {
    try {
      powerMonitor.off('lock-screen', this.lockHandler)
      powerMonitor.off('unlock-screen', this.unlockHandler)
    } catch { /* noop */ }
    try {
      if (this.screenSleepSubscription !== undefined) {
        systemPreferences.unsubscribeWorkspaceNotification(this.screenSleepSubscription)
      }
      if (this.screenWakeSubscription !== undefined) {
        systemPreferences.unsubscribeWorkspaceNotification(this.screenWakeSubscription)
      }
    } catch { /* noop */ }
    void this.stop()
  }

  /** §5.1 门禁 — push while locked, display-asleep, or past an enabled idle
   *  threshold (or always when the user turned the gate off). */
  private shouldPush(): boolean {
    const settings = this.deps.getSettings()
    if (!settings) return false
    if (!settings.notifyOnlyWhenLocked) return true
    if (this.screenLocked || this.screenSleeping) return true
    const n = Number.isFinite(settings.idleThresholdSec) ? settings.idleThresholdSec : 300
    try {
      if (powerMonitor.getSystemIdleState(1) === 'locked') return true
      if (n > 0 && powerMonitor.getSystemIdleTime() >= n) return true
    } catch { /* unsupported host → fall through to not-push */ }
    return false
  }

  /** Title metadata updates are independent of the notification/lock-screen gate. */
  handleSessionUpdated(session: Session): void {
    if (!this.deps.getSettings()?.enabled || !this.client) return
    const link = this.deps.threadStore.bySession(session.id)
    if (!link && !this.threadFlights.has(session.id)) return
    if (link?.replyInThread === false || this.deps.createAssistantSession && link?.replyInThread !== true) return
    if (link?.rootAppId !== undefined && link.rootAppId !== this.clientAppId) return
    if (link?.rootTitleSyncBlocked || (link?.rootTitleRetryAt || 0) > Date.now()) return
    this.enqueuePush(session.id, async () => {
      try { await this.syncThreadTitle(session.id) } catch (error) {
        this.reportError('feishu_title_sync_failed', '同步飞书话题标题', error, { sessionId: session.id })
      }
    })
  }

  private async syncThreadTitle(sessionId: string): Promise<void> {
    const client = this.client
    const appId = this.clientAppId
    if (!client || !appId || !this.deps.getSettings()?.enabled) return
    await this.threadFlights.get(sessionId)
    if (this.client !== client) return
    let link = this.deps.threadStore.bySession(sessionId)
    if (!link || link.rootTitleSyncBlocked || (link.rootTitleRetryAt || 0) > Date.now()) return
    if (link.replyInThread === false || this.deps.createAssistantSession && link.replyInThread !== true) return
    const rootMessageId = link.rootMessageId
    try {
      // Driver changes whenever a user switches between App and Feishu; it does
      // not identify who authored the root. Inspect legacy links once instead.
      if (link.rootAppId === undefined) {
        const result = await withFeishuDeadline('read_thread_title', () => client.im.v1.message.get({
          path: { message_id: rootMessageId }
        }))
        if (result.code) throw new FeishuBusinessError(result.code, result.msg)
        if (this.client !== client || this.deps.threadStore.bySession(sessionId)?.rootMessageId !== rootMessageId) return
        const message = result.data?.items?.find((item) => item.message_id === rootMessageId)
        if (!message || message.deleted) return
        const text = message.msg_type === 'text' ? JSON.parse(message.body?.content || '{}').text : undefined
        const rootAppId = message.sender?.sender_type === 'app' && message.sender.id_type === 'app_id' &&
          typeof text === 'string' && text.startsWith('🧵 ') ? message.sender.id : null
        link = this.deps.threadStore.patch(sessionId, {
          rootAppId, rootTitle: rootAppId ? text.slice('🧵 '.length) : undefined
        })!
      }
      if (link.rootAppId !== appId) return
      const session = this.deps.orchestrator.getSessionById(sessionId)
      if (!session) return
      const title = this.threadTitle(session)
      if (link.rootTitle === title) return
      const result = await withFeishuDeadline('update_thread_title', () => client.im.v1.message.update({
        data: { msg_type: 'text', content: JSON.stringify({ text: `🧵 ${title}` }) },
        path: { message_id: rootMessageId }
      }))
      if (result.code) throw new FeishuBusinessError(result.code, result.msg)
      if (this.client === client && this.deps.threadStore.bySession(sessionId)?.rootMessageId === rootMessageId) {
        this.deps.threadStore.patch(sessionId, { rootTitle: title, rootTitleRetryAt: undefined })
      }
    } catch (error) {
      if (this.client === client && this.deps.threadStore.bySession(sessionId)?.rootMessageId === rootMessageId) {
        const code = feishuErrorDetails(error).feishuCode
        const blocked = code === 230072 || code === 230075
        // ponytail: retry on the next update/reconnect; add a timer if idle titles must self-heal.
        this.deps.threadStore.patch(sessionId, {
          rootTitleSyncBlocked: blocked || undefined,
          rootTitleRetryAt: blocked ? undefined : Date.now() + TITLE_RETRY_MS
        })
      }
      throw error
    }
  }

  /** Fan-in from index.ts's `orchestrator.on('event')`. */
  handleSideEvent(event: UAEvent): void {
    const request = asInteractionRequest(event)
    if (request.type !== 'approval_request') return
    this.handleEvent({ ...request, payload: { ...request.payload, requestId: 'side:' + request.payload.requestId, channel: 'side' } })
  }

  /** Resident private conversations, derived from the same links used inbound. */
  getAssistantPrivateSessions(): FeishuThreadLink[] {
    const settings = this.deps.getSettings()
    if (!this.deps.createAssistantSession || !settings?.enabled || !settings.appId) return []
    const chats = new Map<string, FeishuThreadLink>()
    for (const link of this.deps.threadStore.all().reverse()) {
      if (chats.has(link.chatId) || !link.rootMessageId || link.replyInThread === true || link.botAppId !== settings.appId) continue
      const session = this.deps.orchestrator.getSessionById(link.sessionId)
      if (!session?.config.assistantSnapshot || this.deps.acceptsSession && !this.deps.acceptsSession(session)) continue
      chats.set(link.chatId, link)
    }
    return [...chats.values()]
  }

  async executeAssistantCommandFromApp(sessionId: string, command: 'new' | 'clear', requestId: string): Promise<Session> {
    const execute = this.deps.assistantCommand
    if (!execute) throw new Error('个人助手会话命令不可用')
    const run = async (): Promise<Session> => {
      const next = await execute(sessionId, command, requestId)
      this.rebindAssistantSession(sessionId, next, { command, requestId })
      return next
    }
    const link = this.deps.threadStore.bySession(sessionId)
    return link && link.botAppId === this.deps.getSettings()?.appId ? this.enqueueAssistantChat(link.chatId, run) : run()
  }

  /** Both App and Feishu commands move the existing conversation, never create a notification-only binding. */
  rebindAssistantSession(previousId: string, next: Session, appCommand?: { command: 'new' | 'clear'; requestId: string }): FeishuThreadLink | undefined {
    const link = this.deps.threadStore.bySession(previousId)
    if (!link || !next.config.assistantSnapshot) return undefined
    if (this.deps.createAssistantSession && (link.botAppId !== this.deps.getSettings()?.appId || link.replyInThread !== true && !this.getAssistantPrivateSessions().some(item => item.sessionId === previousId))) return undefined
    this.deps.threadStore.remove(previousId)
    const moved = this.deps.threadStore.upsert({ ...link, ...(this.deps.createAssistantSession && link.replyInThread !== true ? { replyInThread: false, threadId: undefined } : {}), sessionId: next.id, lastPushedSeq: 0, pendingRequestId: undefined })
    const previousPush = this.pushChains.get(previousId)
    if (previousPush) this.pushChains.set(next.id, previousPush)
    if (appCommand && moved.replyInThread === false) {
      const client = this.client
      const generation = this.connectionGeneration
      const uuid = createHash('sha256').update(`${previousId}/command/${appCommand.requestId}`).digest('hex').slice(0, 32)
      this.enqueuePush(next.id, async () => {
        if (!client || this.client !== client || generation !== this.connectionGeneration) throw new Error('飞书 Bot 已停止或切换')
        await this.replyMessage(moved, 'text', { text: `来自 UniAgent：/${appCommand.command}\n${appCommand.command === 'clear' ? '已清空当前对话，长期记忆已保留。' : '已开启新对话。'}` }, uuid, client)
      })
    }
    return moved
  }

  private mirroredAppInputs = new Set<string>()
  private mirrorAssistantInput(event: UAEvent): void {
    if (!['user_message', 'goal_message'].includes(event.type) || event.payload.source !== 'app' ||
      event.payload.hidden || event.payload.zcodeProjection || event.payload.subagentId || event.payload.channel === 'side' || event.payload.asyncQuestion) return
    const link = this.getAssistantPrivateSessions().find(item => item.sessionId === event.sessionId)
    if (!link) return
    const key = `${event.sessionId}/input/${event.payload.zcodeQueueItemId || event.payload.assistantMessageId || event.payload.id || event.seq}`
    if (this.mirroredAppInputs.has(key)) return
    const raw = event.payload.displayText ?? event.payload.text
    const stripped = stripAssistantContext(typeof raw === 'string' ? raw : '')
    const text = splitFeishuContext(stripped)?.text ?? stripped
    const attachments = Array.isArray(event.payload.attachments) ? structuredClone(event.payload.attachments) as Attachment[] : []
    if (!text.trim() && !attachments.length) return
    const client = this.client
    const generation = this.connectionGeneration
    const target = { ...link, replyInThread: false }
    const assertCurrent = (): void => {
      if (!client || this.client !== client || generation !== this.connectionGeneration) throw new Error('飞书 Bot 已停止或切换')
    }
    const uuid = (part: string): string => createHash('sha256').update(`${key}/${part}`).digest('hex').slice(0, 32)
    this.mirroredAppInputs.add(key)
    if (this.mirroredAppInputs.size > 500) this.mirroredAppInputs.delete(this.mirroredAppInputs.values().next().value!)
    this.enqueuePush(event.sessionId, async () => {
      try {
        assertCurrent()
        // Plain text preserves what the user typed; injected context never crosses the bridge.
        const characters = [...text]
        for (let offset = 0; offset < characters.length; offset += 3000) {
          await this.replyMessage(target, 'text', { text: `${offset === 0 ? '来自 UniAgent 的输入：\n\n' : ''}${characters.slice(offset, offset + 3000).join('')}` }, uuid(`text/${offset}`), client)
        }
        for (let index = 0; index < attachments.length; index++) {
          assertCurrent()
          const attachment = attachments[index]
          const handle = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW)
          let buffer: Buffer
          try {
            const info = await handle.stat()
            if (!info.isFile() || info.size === 0 || info.size > (attachment.kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT)) throw new Error(`附件无法同步或超过飞书大小限制：${attachment.name}`)
            buffer = await handle.readFile()
            if (buffer.length !== info.size) throw new Error(`附件在同步前发生变化：${attachment.name}`)
          } finally { await handle.close() }
          await this.uploadAttachment(target, attachment.name, buffer, attachment.kind === 'image', client!, assertCurrent, uuid(`attachment/${index}`))
        }
      } catch (error) {
        this.mirroredAppInputs.delete(key)
        throw error
      }
    })
  }

  handleEvent(ev: UAEvent): void {
    const owner = this.deps.orchestrator.getSessionById(ev.sessionId)
    if (owner && this.deps.acceptsSession && !this.deps.acceptsSession(owner)) return
    ev = asInteractionRequest(ev)
    if (ev.type === 'approval_request') this.requestEvents.set(`${ev.sessionId}/${ev.payload.requestId}`, ev)
    if (ev.payload.channel !== 'side' && ev.payload.method !== 'local/plan' && this.deps.orchestrator.getSessionById(ev.sessionId)?.teamBinding && this.deps.teams) {
      const { leader } = this.deps.teams.binding(ev.sessionId)
      if (!leader || ev.type === 'approval_request') { this.handleTeamChanged(); return }
    }
    if ((ev.type === 'user_message' || ev.type === 'goal_message') &&
      !(ev.payload.source === 'mcp' && this.deps.orchestrator.getSessionById(ev.sessionId)?.teamBinding)) {
      this.deps.threadStore.patch(ev.sessionId, {
        driver: ev.payload.source === 'feishu' ? 'feishu' : 'app',
        lastPushedSeq: 0
      })
    }
    if (!this.deps.getSettings()?.enabled) return
    this.mirrorAssistantInput(ev)
    const { type, state } = ev
    if (type === 'system_notice' && ev.payload.kind === 'assistant_management_result') {
      if (this.shouldPushFor(ev.sessionId)) this.enqueuePush(ev.sessionId, () => this.pushEvent(ev))
      return
    }
    // Updating an existing card must bypass the idle/lock-screen notification gate.
    // The retained success event includes the answer; the adapter's earlier raw
    // success does not, and must not consume the card before its summary is ready.
    if (type === 'approval_request' && (state === 'cancelled' || state === 'failed' ||
      (state === 'success' && ev.payload.submittedAnswer !== undefined))) {
      const card = this.requestCards.get(`${ev.sessionId}/${ev.payload.requestId}`)
      if (card) card.settled = true
      this.clearPendingRequest(ev.sessionId, ev.payload.requestId)
      const progress = ev.payload.channel === 'side' ? undefined : this.progressCards.get(ev.sessionId)
      if (progress && ![...this.requestEvents.values()].some(request => request.sessionId === ev.sessionId && request.payload.channel !== 'side' && request.state === 'pending' && request.payload.delivery !== 'async' && request.payload.method !== 'local/plan')) {
        progress.status = 'running'; progress.segments.delete('__wait__')
      }
      this.enqueuePush(ev.sessionId, () => this.resolveRequestCard(ev))
      return
    }
    const current = this.progressCards.get(ev.sessionId)
    if (current) {
      current.lastEventAt = Date.now()
      current.lastEventType = ev.type
      current.lastEventSeq = ev.seq
    }
    const continued = type === 'user_message' && ev.payload.source === 'feishu' && ev.payload.appendedToTurn === true && !ev.payload.asyncQuestion &&
      !!current && !current.final && !current.interruptRequested
    if (continued && current) {
      current.final = {
        event: { ...ev, type: 'turn_completed', state: 'cancelled' }, success: false,
        result: '收到新消息，本张卡片已结束；后续进度请看下面的新卡片。', endedAt: Date.now(), replySkipped: true
      }
      this.progressCards.delete(ev.sessionId)
      this.finishingCards.add(current)
      this.logProgress(current, 'progress_superseded', { eventSeq: ev.seq })
      this.scheduleProgressFlush(current)
      this.queueProgressFlush(current)
    }
    if (type === 'turn_completed') {
      // Turn ended: always clear the "received" reaction (regardless of门禁 —
      // it just signals "done"), then push the final reply (gated). Pushing on
      // turn_completed rather than on `agent_message state:'success'` covers
      // EVERY adapter — some runners emit their final message with no
      // `state:'success'`, so the old gate silently dropped their replies.
      this.enqueuePush(ev.sessionId, () => this.clearAck(ev.sessionId))
      const progress = this.progressCards.get(ev.sessionId)
      const team = this.deps.orchestrator.getSessionById(ev.sessionId)?.teamBinding && this.deps.teams ? this.deps.teams.binding(ev.sessionId).p : undefined
      if (progress && team && state === 'success' && ['running', 'waiting_members', 'waiting_user'].includes(team.status) &&
        (team.assignments.some(a => a.runId === team.runId && (!a.endedAt || a.status === 'succeeded' && !a.review)) || team.interactions.some(i => i.runId === team.runId && i.state === 'pending') || team.inbox.some(i => i.runId === team.runId && i.state === 'pending'))) {
        progress.teamWaiting = true; progress.lastTurnEvent = ev; progress.teamRunId = team.runId; progress.status = 'waiting'
        progress.segments.set('__team__', 'Leader 本轮处理完成，等待团队交付或用户答复。')
        this.scheduleProgressFlush(progress); this.queueProgressFlush(progress)
        return
      }
      if (progress) {
        const success = state === 'success'
        const latestAnswer = this.deps.orchestrator.latestAgentMessageText(ev.sessionId).trim()
        const lastSegment = [...progress.segments.values()].at(-1) || ''
        const result = success
          ? latestAnswer || progress.answer || lastSegment || '任务已完成。'
          : lastSegment || progress.answer || latestAnswer || '任务未完成。'
        progress.final = { event: ev, success, result, endedAt: Date.now(), link: this.deps.threadStore.bySession(ev.sessionId) }
        this.progressCards.delete(ev.sessionId)
        this.finishingCards.add(progress)
        this.logProgress(progress, 'progress_turn_completed', { success, eventSeq: ev.seq })
        this.scheduleProgressFlush(progress)
        this.queueProgressFlush(progress)
      } else if (this.client && state === 'success' && this.shouldPushFor(ev.sessionId)) {
        this.enqueuePush(ev.sessionId, () => this.pushFinalReply(ev))
      }
      return
    }
    // Keep collecting an existing card's output even while WS is reconnecting or
    // the lock-screen gate changes. HTTP card updates do not depend on the WS.
    if (!current && !this.shouldPushFor(ev.sessionId)) return
    if (type === 'turn_started' || continued) {
      if (!this.progressCards.has(ev.sessionId)) {
        this.progressCards.set(ev.sessionId, {
          sessionId: ev.sessionId, replyUuid: randomUUID(),
          ...(continued ? { turnId: current?.turnId, previous: current } : {}),
          sequence: 0, startedAt: Date.now(), lastEventAt: Date.now(), status: 'running',
          lastEventType: ev.type, lastEventSeq: ev.seq,
          segments: new Map([['__start__', continued ? '已收到补充要求，正在继续处理。' : 'Agent 已开始处理任务。']])
        })
      }
      const progress = this.progressCards.get(ev.sessionId)!
      if (progress.teamWaiting) { progress.teamWaiting = false; progress.status = 'running'; progress.segments.delete('__team__') }
      if (typeof ev.payload?.turnId === 'string') progress.turnId = ev.payload.turnId
      this.logProgress(progress, continued ? 'progress_input_continued' : 'progress_turn_started', { eventSeq: ev.seq })
      this.scheduleProgressFlush(progress)
      this.queueProgressFlush(progress)
      return
    }
    if (type === 'reasoning' || type === 'agent_message' || type === 'error') {
      this.updateProgressCard(ev)
      return
    }
    // Approvals/questions must reach Feishu mid-turn so the user can answer.
    if (type === 'approval_request' && state === 'pending') {
      const progress = ev.payload.channel === 'side' ? undefined : this.progressCards.get(ev.sessionId)
      if (progress && ev.payload.delivery !== 'async' && ev.payload.method !== 'local/plan') {
        progress.status = 'waiting'
        progress.segments.set('__wait__', 'Agent 正在等待你的确认。')
        this.scheduleProgressFlush(progress)
      }
      this.enqueuePush(ev.sessionId, () => this.pushEvent(ev, progress))
    }
  }

  /**
   * Per-session push gate. A session the user is driving FROM Feishu must always
   * get its reply back — otherwise a plain chat while at the keyboard silently
   * drops every answer (the reported "发一条没回复"). Only in-app sessions honor
   * the lock-screen/idle门禁 so you aren't pinged while sitting at the Mac.
   */
  /** Team notifications share the Leader topic; each native request retains its own identity. */
  handleTeamChanged(): void {
    if (!this.client || !this.deps.teams) return
    for (const p of this.deps.teams.catalog().projects) {
      const sid = p.memberSessions[p.team.leaderMemberId]
      if (!sid || !this.deps.orchestrator.getSessionById(sid)) continue
      const progress = this.progressCards.get(sid)
      if (progress?.teamWaiting && progress.teamRunId === p.runId) {
        if (['completed', 'failed', 'interrupted'].includes(p.status) && progress.lastTurnEvent) {
          progress.final = { event: { ...progress.lastTurnEvent, state: p.status === 'completed' ? 'success' : p.status === 'interrupted' ? 'cancelled' : 'failed' }, success: p.status === 'completed', result: p.error || progress.answer || this.deps.orchestrator.latestAgentMessageText(sid), endedAt: Date.now(), link: this.deps.threadStore.bySession(sid) }
          this.progressCards.delete(sid); this.finishingCards.add(progress)
        } else {
          progress.segments.set('__team__', `团队进展：${p.assignments.filter(a => a.runId === p.runId && a.status === 'succeeded').length} 项已交付 · ${p.interactions.some(i => i.state === 'pending' && teamInteractionForUser(i, p.team.leaderMemberId)) ? '等待你的答复' : '等待 Leader 继续处理'}`)
        }
        this.scheduleProgressFlush(progress); this.queueProgressFlush(progress)
      }
      if (p.archivedAt || this.teamPushPending.has(p.id)) continue
      const updateOnly = !this.shouldPushFor(sid)
      if (updateOnly && !p.interactions.some(i => this.teamCards.has(i.id) && this.teamCards.get(i.id)!.revision !== i.revision)) continue
      const signature = JSON.stringify([updateOnly, p.runId, p.status, p.phase, p.summary, p.error, p.activeMs, p.finalResult?.summary, p.assignments.map(a => [a.id, a.title, a.status, a.activeMs]), p.interactions.filter(i => !updateOnly || this.teamCards.has(i.id)).map(i => [i.id, i.revision, i.state])])
      if (signature === this.teamPushRevisions.get(p.id)) continue
      const token = Symbol(p.id)
      const generation = this.connectionGeneration
      this.teamPushPending.set(p.id, token)
      this.enqueuePush(sid, async () => {
        try {
          if (!await this.pushTeamProject(p, updateOnly)) return
          this.teamPushRevisions.set(p.id, signature)
          setImmediate(() => this.handleTeamChanged())
        }
        finally {
          if (this.teamPushPending.get(p.id) === token) {
            this.teamPushPending.delete(p.id)
            if (this.connectionGeneration !== generation) setImmediate(() => this.handleTeamChanged())
          }
        }
      })
    }
  }

  private async pushTeamProject(p: TeamProject, updateOnly = false): Promise<boolean> {
    const leader = this.deps.orchestrator.getSessionById(p.memberSessions[p.team.leaderMemberId])
    const client = this.client
    const generation = this.connectionGeneration
    if (!leader || !client) return false
    const link = updateOnly ? this.deps.threadStore.bySession(leader.id) : await this.ensureThread(leader)
    if (this.client !== client || this.connectionGeneration !== generation) return false
    if (!link) throw new Error('team_notification_thread_unavailable')
    let synced = true
    for (const i of p.interactions.filter(i => teamInteractionForUser(i, p.team.leaderMemberId))) {
      const old = this.teamCards.get(i.id)
      if (old?.revision === i.revision || (!old && (updateOnly || i.state !== 'pending'))) continue
      const role = p.team.members.find(m => m.id === i.memberId)?.role.name || 'Leader'
      let card: object
      if (i.state !== 'pending') {
        let detail = role
        if (i.state === 'answered' && i.kind === 'native_question') {
          const { kind, method, params, submittedAnswer } = i.event!.payload
          const answerKind = questionAnswerKind(kind, method)
          detail = questionAnswerDetail(normalizeQuestions(answerKind, params), i.answer ?? submittedAnswer, answerKind)
        } else if (i.state === 'answered' && i.kind === 'leader_question') {
          const fields = normalizeQuestions('question', teamQuestionParams(i))
          detail = questionAnswerDetail(fields, i.answer ?? { answers: Object.fromEntries((i.questions || []).map(q => [q.id, { answers: q.answer ? [q.answer] : [] }])) }, 'question')
        }
        const answer = (i.answer ?? i.event?.payload.submittedAnswer) as any
        const planLabel = answer?.decision === 'approved' ? '已确认' : answer?.decision === 'rejected' ? '已反馈' : '已跳过'
        const label = i.state !== 'answered' ? '已失效' : i.event?.payload.kind === 'planMode' ? (old?.source === 'feishu' ? planLabel : '已在 UniAgent App 处理 · ' + planLabel) : i.kind === 'native_approval' ? '已处理'
          : old?.source === 'feishu' ? '已回答' : '已在 UniAgent App 回复'
        card = resolvedCard(label, detail, i.kind !== 'native_approval' || i.event?.payload.kind === 'planMode')
      } else if (i.kind === 'leader_question') {
        const fields = normalizeQuestions('question', teamQuestionParams(i))
        card = questionFormCard('question', i.id, i.sessionId, fields)
      } else if (i.kind === 'native_question') {
        const ev = i.event!
        const answerKind = questionAnswerKind(ev.payload.kind, ev.payload.method)
        const fields = normalizeQuestions(answerKind, ev.payload.params)
        card = fields.length ? questionFormCard(answerKind, i.requestId!, i.sessionId, fields, ev.payload.delivery) : noteCard(role + ' 需要补充信息', '请在 UniAgent 团队项目中回答此请求。')
      } else {
        const ev = i.event!
        card = approvalCard(ev.payload.kind, ev.payload.method, i.requestId!, i.sessionId, ev.payload.params, ev.payload.options)
      }
      let materialError = false
      try { await this.addTeamMaterials(card, p, i, link, client, generation) } catch (error) {
        if (this.client !== client || this.connectionGeneration !== generation) return false
        materialError = true; synced = false
        card = noteCard('决策材料发送失败', '完整材料尚未发送成功，请点击「重发完整材料」；发送成功后，可在本卡填写并提交回答。' + '\n\n' + safeErr(error))
        ;(card as any).elements.push({ tag: 'action', actions: [button('重发完整材料', 'primary', { sessionId: i.sessionId, requestId: i.requestId || i.id, act: 'retryTeamMaterials' })] })
        this.reportError('team_material_send_failed', '发送团队决策材料', error, { sessionId: leader.id, interactionId: i.id })
      }
      if (this.client !== client || this.connectionGeneration !== generation) return false
      // Pin the revision in every action. A stale card must never answer a newer question.
      const pin = (node: any): void => { if (!node || typeof node !== 'object') return; if (node.value?.requestId) { node.value.teamRevision = i.revision; node.value.teamInteractionId = i.id }; for (const child of Object.values(node)) if (child && typeof child === 'object') pin(child) }
      pin(card)
      let messageId = old?.messageId
      if (messageId) {
        const result = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } })
        if (result.code) throw new Error(result.msg || 'team_card_update_failed')
      } else {
        await this.replyText(link, role + (i.kind === 'native_approval' ? ' 请求授权' : ' 有一个问题'))
        const result = await client.im.v1.message.reply({ path: { message_id: link.rootMessageId }, data: { content: JSON.stringify(card), msg_type: CARD_MSG_TYPE, reply_in_thread: true, uuid: createHash('sha256').update(i.id).digest('hex').slice(0, 32) } })
        if (result.code || !result.data?.message_id) throw new Error(result.msg || 'team_card_send_failed')
        messageId = result.data.message_id; this.sentMessageIds.add(messageId)
      }
      if (this.client !== client || this.connectionGeneration !== generation) return false
      const tracked: { revision: number; messageId?: string; source?: 'feishu'; submitting?: boolean } = old || { revision: 0 }
      Object.assign(tracked, { revision: materialError ? 0 : i.revision, messageId })
      this.teamCards.set(i.id, tracked)
    }
    if (updateOnly) return true
    if (!Object.values(p.memberSessions).some(id => ['running', 'awaiting-approval', 'queued'].includes(this.deps.orchestrator.getSessionById(id)?.status || ''))) await this.clearAck(leader.id)
    return synced
  }

  private async addTeamMaterials(card: any, p: TeamProject, interaction: TeamInteraction, link: FeishuThreadLink, client: Client, generation: number): Promise<void> {
    if (!interaction.decision) return
    const descriptions: string[] = []
    for (const ref of interaction.decision.materials) {
      const artifact = this.deps.teams!.artifact(p.id, ref.artifactId)
      const label = [ref.questionId, ref.optionLabel, artifact.title].filter(Boolean).join(' · ')
      const key = `${link.rootMessageId}/${artifact.id}`
      if (!this.teamMaterialMessages.has(key)) {
        const buffer = artifact.path ? readFileSync(artifact.path) : Buffer.from(artifact.text || '')
        if (buffer.length > FILE_LIMIT || createHash('sha256').update(buffer).digest('hex') !== artifact.sha256) throw new Error('决策材料已变化或超出飞书文件大小限制，请在 App 查看')
        const isImage = !!artifact.path && IMAGE_EXTENSIONS.has(extname(artifact.path).toLowerCase()) && buffer.length <= IMAGE_LIMIT
        const uploaded = isImage
          ? await client.im.v1.image.create({ data: { image_type: 'message', image: buffer } })
          : await client.im.v1.file.create({ data: { file_type: 'stream', file_name: artifact.path ? basename(artifact.path) : artifact.title.replace(/[\/]/g, '_') + '.md', file: buffer } })
        if (this.client !== client || this.connectionGeneration !== generation) throw new Error('connection_changed')
        const mediaKey = isImage ? (uploaded as any)?.image_key : (uploaded as any)?.file_key
        if (!mediaKey) throw new Error('决策材料上传失败')
        await this.replyMessage(link, isImage ? 'image' : 'file', isImage ? { image_key: mediaKey } : { file_key: mediaKey }, createHash('sha256').update(key).digest('hex').slice(0, 32), client)
        if (this.client !== client || this.connectionGeneration !== generation) throw new Error('connection_changed')
        this.teamMaterialMessages.add(key)
      }
      descriptions.push(`• ${label}`)
    }
    const materialText = `**${interaction.decision.title}**${descriptions.length ? `\n\n固定材料已发送到本话题：\n${descriptions.join('\n')}` : ''}`
    card.body?.elements?.unshift({ tag: 'markdown', content: materialText })
  }

  private async onTeamCardAction(sessionId: string, requestId: string, value: Record<string, unknown>, raw: unknown): Promise<unknown> {
    try {
      const { p } = this.deps.teams!.binding(sessionId)
      const i = p.interactions.findLast(i => i.runId === p.runId && i.sessionId === sessionId && (i.requestId === requestId || i.id === requestId))
      if (!i || i.state !== 'pending' || value.teamInteractionId !== i.id || value.teamRevision !== i.revision || !teamInteractionForUser(i, p.team.leaderMemberId)) throw new Error('问题已更新或处理，请使用最新卡片')
      const card = this.teamCards.get(i.id)
      if (!card || card.submitting) throw new Error('回答正在提交，请稍候')
      const act = String(value.act || '')
      if (act === 'retryTeamMaterials') {
        this.teamPushRevisions.delete(p.id)
        setImmediate(() => this.handleTeamChanged())
        return { toast: { type: 'info', content: '正在重新发送完整材料，发送成功后可在此卡回答' } }
      }
      if (card.revision !== i.revision) throw new Error('请先重新发送完整材料后再回答')
      const pin = (node: any): void => { if (!node || typeof node !== 'object') return; if (node.value?.requestId) Object.assign(node.value, { teamRevision: i.revision, teamInteractionId: i.id }); for (const child of Object.values(node)) if (child && typeof child === 'object') pin(child) }
      if (act === 'revisePlan' && i.event?.payload.kind === 'planMode') {
        const preview = planConfirmationCard(sessionId, requestId, i.event.payload.method, i.event.payload.params, true)
        pin(preview)
        return { card: { type: 'raw', data: preview } }
      }
      const form = ((raw as any)?.action?.form_value || {}) as Record<string, unknown>
      let answer: unknown
      let feedback: string | undefined
      if (i.kind === 'leader_question') {
        const fields = normalizeQuestions('question', teamQuestionParams(i))
        const encoded = encodeAnswer('question', fields, collectFormValue(fields, form)) as { answers: Record<string, { answers: string[] }> }
        validateQuestionAnswer('question', fields, encoded)
        answer = i.decision ? encoded : Object.fromEntries(Object.entries(encoded.answers).map(([key, item]) => [key, item.answers.join('、')]))
      } else if (i.kind === 'native_question') {
        const answerKind = questionAnswerKind(i.event!.payload.kind, i.event!.payload.method)
        if (act === 'cancelQuestion' && (answerKind === 'elicitation' || answerKind === 'zcode')) answer = { action: 'cancel' }
        else if (act === 'submitQuestion') {
          const fields = normalizeQuestions(answerKind, i.event!.payload.params)
          answer = encodeAnswer(answerKind, fields, collectFormValue(fields, form))
          validateQuestionAnswer(answerKind, fields, answer)
        } else throw new Error('无效的答题操作')
      } else if (i.event?.payload.kind === 'planMode') {
        if (act === 'submitPlanFeedback') {
          feedback = String(form.feedback || '').trim()
          if (!feedback) throw new Error('请填写计划修改意见')
          answer = { decision: 'rejected', feedback }
        } else if (act === 'implementPlan') answer = { decision: 'approved' }
        else if (act === 'skipPlan') answer = { decision: 'cancelled' }
        else throw new Error('无效的计划操作')
      } else {
        validateApprovalAction(i.event!.payload.kind, i.event!.payload.method, i.event!.payload.params, i.event!.payload.options, value)
        answer = buildDecisionAnswer({ ...value, kind: i.event?.payload.kind, method: i.event?.payload.method })
      }
      card.submitting = true
      setImmediate(async () => {
        try {
          if (this.teamCards.get(i.id) !== card || this.deps.teams!.binding(sessionId).p.interactions.find(request => request.id === i.id)?.revision !== i.revision) throw new Error('问题已更新或处理，请使用最新卡片')
          card.source = 'feishu'
          await this.deps.teams!.respond(p.id, i.id, i.revision, answer, false, 'feishu')
          if (feedback && !planFeedbackInAnswer(i.event?.payload.method)) {
            if (i.memberId === p.team.leaderMemberId) await this.sendFeishuMessage(sessionId, feedback, [])
            else if (this.deps.orchestrator.getSessionById(sessionId)?.status === 'running') await this.deps.orchestrator.steerTeamMessage(sessionId, appendFeishuContext(feedback))
            else await this.deps.orchestrator.sendTeamMessage(sessionId, appendFeishuContext(feedback))
          }
        } catch (error) {
          card.source = undefined
          this.reportError('feishu_team_question_submit_failed', '提交专家团回答', error, { sessionId, requestId })
          const leaderId = p.memberSessions[p.team.leaderMemberId]
          const link = this.deps.threadStore.bySession(leaderId)
          if (link) this.enqueuePush(leaderId, () => this.replyText(link, '专家团回答提交失败：' + safeErr(error) + '。请使用对应卡片重试。'))
        } finally { card.submitting = false }
      })
      return { toast: { type: 'info', content: '正在向 Agent 提交，请等待确认' } }
    } catch (error) { return { toast: { type: 'error', content: error instanceof Error ? error.message : '提交失败' } } }
  }

  private shouldPushFor(sessionId: string): boolean {
    const session = this.deps.orchestrator.getSessionById(sessionId)
    if (session && this.deps.acceptsSession && !this.deps.acceptsSession(session)) return false
    if (session?.handoffId && session.submittedUserMessages?.at(-1)?.source === 'mcp') return false
    if (session?.handoffId && !session.handoffUserContinued) return false
    if (session && !this.deps.createAssistantSession && !this.deps.threadStore.bySession(sessionId) &&
      !this.pendingChatFor(sessionId) && !this.deps.getSettings()?.notifyChatId) return false
    if (this.getAssistantPrivateSessions().some(link => link.sessionId === sessionId)) return true
    if (this.deps.threadStore.bySession(sessionId)?.driver === 'feishu') return true
    return this.shouldPush()
  }

  /** Chain a push after any in-flight push for the same session. */
  private enqueuePush(sessionId: string, run: () => Promise<void>): void {
    const prev = this.pushChains.get(sessionId) || Promise.resolve()
    const queuedAt = Date.now()
    const next = prev.then(async () => {
      this.log(sessionId, 'push_started', { queuedMs: Date.now() - queuedAt })
      await run()
      this.log(sessionId, 'push_finished', { totalMs: Date.now() - queuedAt })
    }).catch((error) => {
      this.reportError('feishu_push_failed', '推送飞书消息', error, { sessionId })
    })
    this.pushChains.set(sessionId, next)
  }

  private log(sessionId: string | undefined, kind: string, data: Record<string, unknown>): void {
    try {
      this.deps.onLog?.(sessionId, `feishu_${kind}`, {
        processId: process.pid, connectionGeneration: this.connectionGeneration, connected: this.connected, ...data
      })
    } catch { /* logging must not stop delivery */ }
  }

  private logProgress(progress: ProgressCardState, kind: string, data: Record<string, unknown> = {}): void {
    this.log(progress.sessionId, kind, {
      turnId: progress.turnId, cardId: progress.cardId, messageId: progress.messageId, replyUuid: progress.replyUuid,
      sequence: progress.sequence, startedAt: progress.startedAt, lastEventAt: progress.lastEventAt,
      lastEventType: progress.lastEventType, lastEventSeq: progress.lastEventSeq,
      status: progress.status, segmentCount: progress.segments.size,
      lastSuccessAt: progress.lastSuccessAt, operation: progress.operation,
      requestStartedAt: progress.requestStartedAt, flushing: !!progress.flushing,
      finishing: !!progress.final, failureCount: progress.failureCount || 0, retryAt: progress.retryAt,
      ...data
    })
  }

  private logErrorDetails(error: unknown): Record<string, unknown> {
    const details = feishuErrorDetails(error)
    // Persist transport metadata only; SDK errors can contain payloads and credentials.
    return Object.fromEntries(['failureKind', 'errorName', 'errorCode', 'httpStatus', 'feishuCode', 'requestId', 'timeoutMs']
      .filter((key) => details[key] !== undefined).map((key) => [key, details[key]]))
  }

  private async progressRequest<T>(progress: ProgressCardState, operation: string, run: (attemptId: string) => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    const attemptId = randomUUID()
    progress.operation = operation
    progress.requestStartedAt = startedAt
    if (operation !== 'update_card') this.logProgress(progress, 'progress_request_started', { attemptId })
    try {
      const result = await withFeishuDeadline(operation, () => run(attemptId))
      const response = result as { code?: number; msg?: string; request_id?: string } | undefined
      if (response?.code && typeof response.code === 'number') {
        throw new FeishuBusinessError(response.code, response.msg, response.request_id)
      }
      if (operation === 'update_card' || operation === 'finish_card') progress.lastSuccessAt = Date.now()
      const durationMs = Date.now() - startedAt
      if (operation !== 'update_card' || durationMs >= 1000) {
        this.logProgress(progress, operation === 'update_card' ? 'progress_request_slow' : 'progress_request_succeeded', { attemptId, durationMs })
      }
      return result
    } catch (error) {
      this.logProgress(progress, 'progress_request_failed', {
        attemptId, durationMs: Date.now() - startedAt, ...this.logErrorDetails(error)
      })
      throw error
    } finally {
      progress.operation = undefined
      progress.requestStartedAt = undefined
    }
  }

  private reportError(
    code: string,
    operation: string,
    error: unknown,
    context: Record<string, unknown> = {}
  ): void {
    const details = { code, operation, ...context, ...feishuErrorDetails(error) }
    const message = `${operation}失败：${safeErr(error)}`
    console.error(`[feishu] ${code}: ${message}`, details)
    this.log(typeof context.sessionId === 'string' ? context.sessionId : undefined, code, {
      ...context, operation, ...this.logErrorDetails(error)
    })
    this.deps.onError?.(message, details)
  }

  private async startProgressCard(session: Session, progress: ProgressCardState, client: Client): Promise<void> {
    const appId = this.clientAppId
    const link = await this.progressRequest(progress, 'ensure_thread', () => this.ensureThread(session))
    if (!this.ownsProgress(progress) || this.client !== client) return
    if (!link) throw new Error('飞书话题尚未就绪')
    if (!progress.cardId) {
      const created = await this.progressRequest(progress, 'create_card', () => client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(progressCard(session, progress)) }
      }))
      if (!this.ownsProgress(progress)) return
      const cardId = created.data?.card_id
      if (!cardId) throw new Error('飞书未返回卡片实体 ID')
      progress.cardId = cardId
    }
    if (this.client !== client) return
    await this.progressRequest(progress, 'send_card', async () => {
      const messageId = await this.replyMessage(link, CARD_MSG_TYPE, { type: 'card', data: { card_id: progress.cardId } }, progress.replyUuid, client)
      // Remember a successful send even if our deadline has already elapsed or
      // the same Bot reconnected. Rebinding an accepted entity fails with 200780.
      if (!this.ownsProgress(progress) || this.clientAppId !== appId) return
      progress.messageId = messageId
      progress.lastSuccessAt = Date.now()
      this.logProgress(progress, 'progress_card_linked')
    })
  }

  private updateProgressCard(ev: UAEvent): void {
    const progress = this.progressCards.get(ev.sessionId)
    if (!progress) return
    progress.segments.delete('__start__')
    if (ev.type === 'reasoning' || ev.type === 'agent_message') {
      const text = String(ev.payload?.text || '').trim()
      if (!text) return
      // Accumulate每一段输出: same payload.id grows in place (streaming typewriter),
      // a new id appends after the prior段 so nothing is overwritten.
      const id = `${ev.type}:${String(ev.payload?.id ?? ev.seq)}`
      if (ev.type === 'agent_message') {
        progress.answer = clip(text, 6000)
        if (ev.payload.phase === 'final_answer') {
          progress.segments.delete(id)
          this.scheduleProgressFlush(progress)
          return
        }
      }
      progress.segments.set(id, clip(text, 4000))
      while (progress.segments.size > 40) progress.segments.delete(progress.segments.keys().next().value!)
    } else if (ev.type === 'error') {
      progress.segments.set(`error:${ev.seq}`, clip(String(ev.payload?.message || ev.payload?.text || '执行出现错误。'), 4000))
    }
    progress.status = 'running'
    this.scheduleProgressFlush(progress)
  }

  /** Rebuild the running card every second so elapsed time advances during silent
   *  gaps and stays in sync with the current status and accumulated 模型思考. */
  private scheduleProgressFlush(progress: ProgressCardState): void {
    if (progress.timer || progress.disabled && (!progress.final || progress.final.sent || progress.final.replySkipped)) return
    progress.timer = setInterval(() => {
      this.queueProgressFlush(progress)
    }, PROGRESS_TICK_MS)
    progress.timer.unref?.()
  }

  private queueProgressFlush(progress: ProgressCardState): void {
    if (!this.ownsProgress(progress)) return
    const now = Date.now()
    const final = progress.final
    if (final && !final.replySkipped && !final.sent && !final.sending && (final.retryAt || 0) <= now && this.client &&
      (progress.messageId || progress.failureCount || progress.disabled)) {
      void this.sendProgressFinal(progress)
    }
    if (progress.disabled || progress.cardFinished) {
      this.completeProgress(progress)
      return
    }
    if (now - (progress.lastHealthAt || 0) >= PROGRESS_HEALTH_MS) {
      progress.lastHealthAt = now
      const staleMs = now - (progress.lastSuccessAt || progress.startedAt)
      this.logProgress(progress, 'progress_health', {
        staleMs, eventAgeMs: now - progress.lastEventAt,
        waitingFor: !this.client ? 'connection' : progress.flushing ? 'request'
          : (progress.retryAt || 0) > now ? 'retry' : 'tick'
      })
    }
    if (progress.flushing || (progress.retryAt || 0) > now || !this.client) return
    // CardKit has its own per-card sequence. Keep this worker independent from
    // uploads, reactions and ordinary replies in the session's message queue.
    void this.flushProgressCard(progress)
  }

  private async flushProgressCard(progress: ProgressCardState): Promise<void> {
    const client = this.client
    if (!client || progress.flushing || !this.ownsProgress(progress)) return
    if (progress.previous && !progress.previous.messageId && !progress.previous.disabled && this.ownsProgress(progress.previous)) return
    progress.previous = undefined
    const { sessionId } = progress
    const session = this.deps.orchestrator.getSessionById(sessionId)
    if (!session) {
      this.logProgress(progress, 'progress_discarded', { reason: 'session_missing' })
      this.removeProgress(progress)
      return
    }
    progress.flushing = true
    try {
      if (!progress.messageId) await this.startProgressCard(session, progress, client)
      if (!this.ownsProgress(progress) || this.client !== client) return
      // Keep CardKit writes in this worker: callback responses cannot replace a
      // streaming card, and closing the stream must precede the button update.
      if ((progress.final || progress.interruptRequested || session.status === 'cancelling') && !progress.streamingClosed) {
        const sequence = ++progress.sequence
        await this.progressRequest(progress, 'close_stream', (uuid) => client.cardkit.v1.card.settings({
          data: {
            settings: JSON.stringify({ config: {
              streaming_mode: false,
              summary: { content: progress.final ? `${progressCardStatus(session, progress)}，可展开查看执行过程。` : '正在中断…' }
            } }),
            sequence,
            uuid
          },
          path: { card_id: progress.cardId! }
        }))
        progress.streamingClosed = true
        if (!this.ownsProgress(progress)) return
      }
      if (progress.final) {
        await this.finishProgressCard(session, progress, client)
      } else {
        const sequence = ++progress.sequence
        await this.progressRequest(progress, 'update_card', (uuid) => client.cardkit.v1.card.update({
          data: { card: { type: 'card_json', data: JSON.stringify(progressCard(session, progress)) }, sequence, uuid },
          path: { card_id: progress.cardId! }
        }))
      }
      if (!this.ownsProgress(progress)) return
      progress.lastSuccessAt = Date.now()
      if (progress.failureCount) this.logProgress(progress, 'progress_recovered')
      progress.failureCount = 0
      progress.retryAt = undefined
    } catch (error) {
      if (!this.ownsProgress(progress) || this.client !== client) return
      const failureCount = (progress.failureCount || 0) + 1
      const details = feishuErrorDetails(error)
      const permanent = [INVALID_CARD_IMAGE_KEY_CODE, 200780, 230072, 230075].includes(Number(details.feishuCode)) ||
        details.feishuCode === 230099 && /\bErrCode:\s*(?:200570|200780)\b/.test(String(details.feishuMessage))
      const retryStopped = permanent || failureCount >= PROGRESS_MAX_FAILURES
      const retryInMs = retryStopped
        ? undefined
        : Math.min(PROGRESS_RETRY_MAX_MS, PROGRESS_RETRY_BASE_MS * 2 ** Math.min(failureCount - 1, 4))
      progress.failureCount = failureCount
      progress.retryAt = retryInMs === undefined ? undefined : Date.now() + retryInMs
      this.reportError('progress_card_update_failed', '更新飞书进度卡片', error, {
        sessionId,
        cardId: progress.cardId,
        messageId: progress.messageId,
        sequence: progress.sequence,
        finishing: !!progress.final,
        failureCount,
        retryInMs,
        retryStopped
      })
      if (retryStopped) {
        progress.disabled = true
        if (progress.timer) clearInterval(progress.timer)
        progress.timer = undefined
        this.logProgress(progress, 'progress_disabled', { reason: permanent ? 'permanent_rejection' : 'retry_limit' })
        // Final replies retry independently even when CardKit stops accepting updates.
        this.scheduleProgressFlush(progress)
        this.queueProgressFlush(progress)
      }
    } finally {
      progress.flushing = false
    }
  }

  private async finishProgressCard(session: Session, progress: ProgressCardState, client: Client): Promise<void> {
    const sequence = ++progress.sequence
    await this.progressRequest(progress, 'finish_card', (uuid) => client.cardkit.v1.card.update({
      data: { card: { type: 'card_json', data: JSON.stringify(progressCard(session, progress)) }, sequence, uuid },
      path: { card_id: progress.cardId! }
    }))
    if (!this.ownsProgress(progress)) return
    progress.cardFinished = true
    this.queueProgressFlush(progress)
  }

  private async sendProgressFinal(progress: ProgressCardState): Promise<void> {
    const final = progress.final!
    const client = this.client!
    const appId = this.clientAppId
    final.sending = true
    try {
      await withFeishuDeadline('send_final_reply', async () => {
        const session = this.deps.orchestrator.getSessionById(progress.sessionId)
        if (!session) { this.removeProgress(progress); return }
        const link = final.link || await this.ensureThread(session)
        if (!this.ownsProgress(progress)) return
        if (!link) throw new Error('飞书会话尚未就绪')
        final.link = link
        await this.replyMessage(link, 'post', {
          zh_cn: { content: [[{ tag: 'md', text: final.result.trim() || (final.success ? '任务已完成。' : '任务未完成。') }]] }
        }, `${progress.replyUuid}-final`, client)
        if (!this.ownsProgress(progress) || this.clientAppId !== appId) return
        // Record late success too: a timed-out request may have reached Feishu.
        final.sent = true
        this.deliveredReplySeqs.set(progress.sessionId, Math.max(this.deliveredReplySeqs.get(progress.sessionId) ?? -1, final.event.seq))
        final.retryAt = undefined
        // A newer turn may already own the session's push watermark.
        if (!this.progressCards.has(progress.sessionId)) this.bump(progress.sessionId, final.event.seq)
        this.completeProgress(progress)
      })
    } catch (error) {
      if (!this.ownsProgress(progress) || this.client !== client) return
      final.failureCount = (final.failureCount || 0) + 1
      const retryInMs = Math.min(PROGRESS_RETRY_MAX_MS, PROGRESS_RETRY_BASE_MS * 2 ** Math.min(final.failureCount - 1, 4))
      final.retryAt = Date.now() + retryInMs
      this.reportError('feishu_final_reply_failed', '发送飞书最终回复', error, {
        sessionId: progress.sessionId, replyUuid: progress.replyUuid, failureCount: final.failureCount, retryInMs
      })
    } finally { final.sending = false }
  }

  private completeProgress(progress: ProgressCardState): void {
    const final = progress.final
    if (!final || !(final.sent || final.replySkipped) || !progress.cardFinished && !progress.disabled || !this.ownsProgress(progress)) return
    this.logProgress(progress, 'progress_finished', { endedAt: final.endedAt })
    this.removeProgress(progress)
  }

  private removeProgress(progress: ProgressCardState): void {
    if (progress.timer) clearInterval(progress.timer)
    if (this.progressCards.get(progress.sessionId) === progress) this.progressCards.delete(progress.sessionId)
    this.finishingCards.delete(progress)
  }

  private async pushEvent(ev: UAEvent, progress?: ProgressCardState): Promise<void> {
    const session = this.deps.orchestrator.getSessionById(ev.sessionId)
    if (!session) return
    const link = await this.ensureThread(session)
    if (!link) return
    // Dedupe by the水位 — never re-push an event we already delivered.
    if (ev.seq <= link.lastPushedSeq && ev.type !== 'approval_request') return

    if (ev.type === 'agent_message' || ev.type === 'system_notice' && ev.payload.kind === 'assistant_management_result') {
      const text = String(ev.payload?.text || '').trim()
      if (text) await this.replyText(link, text)
      this.bump(ev.sessionId, ev.seq)
    } else if (ev.type === 'approval_request') {
      await this.pushApproval(link, ev, progress)
    }
  }

  /** Push the session's final assistant reply when a turn completes. Reads the
   *  text from the orchestrator (not the event) so it works for EVERY adapter —
   *  some emit their final `agent_message` with no `state:'success'`. */
  private async pushFinalReply(ev: UAEvent): Promise<void> {
    const session = this.deps.orchestrator.getSessionById(ev.sessionId)
    if (!session) return
    const text = this.deps.orchestrator.latestAgentMessageText(ev.sessionId).trim()
    if (!text) return
    const link = await this.ensureThread(session)
    if (!link) return
    if (ev.seq <= link.lastPushedSeq) return
    await this.replyText(link, text)
    this.deliveredReplySeqs.set(ev.sessionId, Math.max(this.deliveredReplySeqs.get(ev.sessionId) ?? -1, ev.seq))
    this.bump(ev.sessionId, ev.seq)
  }

  /** Remove the "received" reaction once the session's turn ends. */
  private async clearAck(sessionId: string): Promise<void> {
    const rec = this.ack.get(sessionId)
    if (!rec || !this.client) return
    this.ack.delete(sessionId)
    try {
      if (rec.reactionId) {
        await this.client.im.v1.messageReaction.delete({
          path: { message_id: rec.messageId, reaction_id: rec.reactionId }
        })
      }
    } catch { /* reaction may already be gone */ }
  }

  private bump(sessionId: string, seq: number): void {
    const link = this.deps.threadStore.bySession(sessionId)
    if (link && seq > link.lastPushedSeq) this.deps.threadStore.patch(sessionId, { lastPushedSeq: seq })
  }

  /**
   * §5.3 首推建话题 — ensure the session has a bound thread. The first push
   * sends a root message (= the session title); its message_id anchors the
   * thread for every later reply_in_thread.
   */
  private ensureThread(session: Session): Promise<FeishuThreadLink | undefined> {
    const existing = this.threadFlights.get(session.id)
    if (existing) return existing
    const operation = withFeishuDeadline('create_thread', () => this.ensureThreadNow(session)).finally(() => {
      if (this.threadFlights.get(session.id) === operation) this.threadFlights.delete(session.id)
    })
    this.threadFlights.set(session.id, operation)
    return operation
  }

  private threadTitle(session: Session): string {
    if (session.teamBinding && this.deps.teams) {
      try { return this.deps.teams.binding(session.id).p.name } catch (error) {
        if (!(error instanceof Error) || error.message !== 'team_project_not_found') throw error
        // Historical sessions can outlive their team project.
      }
    }
    return session.title || '新会话'
  }

  private async ensureThreadNow(session: Session): Promise<FeishuThreadLink | undefined> {
    if (this.deps.acceptsSession && !this.deps.acceptsSession(session)) return undefined
    const existing = this.deps.threadStore.bySession(session.id)
    if (existing?.botAppId && existing.botAppId !== this.clientAppId) throw new Error('当前会话绑定的机器人已变更，请通过新机器人开启对话')
    if (existing && this.deps.createAssistantSession && existing.replyInThread === undefined) {
      return this.deps.threadStore.patch(session.id, { replyInThread: false, threadId: undefined })
    }
    if (existing) return existing
    if (this.deps.createAssistantSession && session.assistantEndReason) return undefined
    // Inbound sessions retain their own chat; App tasks use the saved notification target.
    const chatId = this.pendingChatFor(session.id) || this.fallbackChatId()
    if (!chatId || !this.client) return undefined
    const appId = this.clientAppId
    if (this.deps.createAssistantSession) {
      return this.deps.threadStore.upsert({
        sessionId: session.id, chatId, rootMessageId: '', replyInThread: false,
        rootAppId: null, botAppId: appId, lastPushedSeq: 0, driver: 'app'
      })
    }
    const title = this.threadTitle(session)
    try {
      const res = await this.client.im.v1.message.create({
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: `🧵 ${title}` }) },
        params: { receive_id_type: 'chat_id' }
      })
      const rootId = res.data?.message_id
      const threadId = res.data?.thread_id
      if (!rootId) return undefined
      if (this.clientAppId !== appId) return undefined
      this.sentMessageIds.add(rootId)
      return this.deps.threadStore.upsert({
        sessionId: session.id,
        chatId,
        rootMessageId: rootId,
        rootAppId: appId,
        botAppId: appId,
        rootTitle: title,
        threadId,
        lastPushedSeq: 0,
        driver: 'app'
      })
    } catch (error) {
      this.deps.onError?.(safeErr(error))
      return undefined
    }
  }

  /** chatId a session should thread into, learned from an inbound private msg. */
  private sessionChat = new Map<string, string>()
  private pendingChatFor(sessionId: string): string | undefined {
    return this.sessionChat.get(sessionId)
  }

  /** App tasks use the explicit destination; assistant chats keep their resident DM fallback. */
  private fallbackChatId(): string | undefined {
    if (!this.deps.createAssistantSession) return this.deps.getSettings()?.notifyChatId
    if (this.defaultChatId) return this.defaultChatId
    for (const link of this.deps.threadStore.all()) {
      if (link.chatId && link.replyInThread !== true && link.botAppId === this.clientAppId) return link.chatId
    }
    return undefined
  }

  /** Reply the agent's text into the session's thread (reply_in_thread). Sent as
   *  `post` with a single `md` run so Feishu renders Markdown — a `text` message
   *  shows `**bold**`/`## h`/lists as literal characters. */
  private async replyText(link: FeishuThreadLink, text: string): Promise<void> {
    if (!this.client) return
    try {
      await this.replyMessage(link, 'post', {
        zh_cn: { content: [[{ tag: 'md', text: clip(text) }]] }
      })
    } catch (error) {
      this.deps.onError?.(safeErr(error))
    }
  }

  private async replyMessage(link: FeishuThreadLink, msgType: string, content: object, uuid?: string, client = this.client): Promise<string> {
    if (!client) throw new Error('飞书 Bot 未连接')
    if (this.client !== client) throw new Error('飞书 Bot 已停止或切换')
    const appId = this.clientAppId
    const res = link.replyInThread === false
      ? await client.im.v1.message.create({
        data: { receive_id: link.chatId, content: JSON.stringify(content), msg_type: msgType, ...(uuid ? { uuid } : {}) },
        params: { receive_id_type: 'chat_id' }
      })
      : await client.im.v1.message.reply({
        data: { content: JSON.stringify(content), msg_type: msgType, reply_in_thread: true, ...(uuid ? { uuid } : {}) },
        path: { message_id: link.rootMessageId }
      })
    if (res.code) throw new FeishuBusinessError(res.code, res.msg)
    const mid = res.data?.message_id
    if (!mid) throw new Error('飞书未返回消息 ID')
    if (this.clientAppId !== appId) throw new Error('飞书 Bot 已停止或切换')
    this.sentMessageIds.add(mid)
    const threadId = res.data?.thread_id
    if (link.replyInThread !== false && threadId && threadId !== link.threadId && this.deps.threadStore.bySession(link.sessionId)?.rootMessageId === link.rootMessageId) {
      this.deps.threadStore.patch(link.sessionId, { threadId })
    }
    return mid
  }

  private async uploadAttachment(link: FeishuThreadLink, name: string, buffer: Buffer, image: boolean, client: Client, assertCurrent: () => void, uuid?: string): Promise<void> {
    assertCurrent()
    const uploaded = image
      ? await client.im.v1.image.create({ data: { image_type: 'message', image: buffer } })
      : await client.im.v1.file.create({ data: { file_type: 'stream', file_name: name, file: buffer } })
    const key = image ? (uploaded as any)?.image_key : (uploaded as any)?.file_key
    if (!key) throw new Error(`${image ? '图片' : '文件'}上传失败：${name}`)
    assertCurrent()
    await this.replyMessage(link, image ? 'image' : 'file', image ? { image_key: key } : { file_key: key }, uuid, client)
  }

  /** Send one optional caption and multiple files to this session's existing thread. */
  async sendToSession(sessionId: string, text: string | undefined, paths: string[], requestedAt: number): Promise<string[]> {
    const turn = this.deps.orchestrator.getFeishuSendTurn(sessionId)
    const assertCurrentTurn = (): void => {
      if (!turn || !Number.isFinite(requestedAt) || requestedAt < turn.ts || this.deps.orchestrator.getFeishuSendTurn(sessionId) !== turn) {
        throw new FeishuSendValidationError('当前消息不是飞书消息，或该飞书轮次已结束，禁止发送到飞书')
      }
    }
    assertCurrentTurn()
    const previous = this.pushChains.get(sessionId) || Promise.resolve()
    const operation = previous.then(() => this.sendToSessionNow(sessionId, text, paths, assertCurrentTurn))
    this.pushChains.set(sessionId, operation.then(() => undefined, () => undefined))
    return operation
  }

  private async sendToSessionNow(sessionId: string, text: string | undefined, paths: string[], assertCurrentTurn: () => void): Promise<string[]> {
    assertCurrentTurn()
    // HTTP uploads/replies do not depend on the inbound WebSocket handshake.
    const client = this.client
    if (!client) throw new Error('飞书 Bot 未连接')
    const assertCurrent = (): void => {
      assertCurrentTurn()
      if (this.client !== client) throw new Error('飞书 Bot 已停止或切换')
    }
    const session = this.deps.orchestrator.getSessionById(sessionId)
    if (!session) throw new Error('当前 UniAgent 会话不存在')
    const link = this.deps.threadStore.bySession(sessionId)
    if (!link) throw new Error('当前 UniAgent 会话尚未绑定飞书话题')
    if (link.botAppId && link.botAppId !== this.clientAppId) throw new Error('当前会话绑定的机器人已变更，请通过新机器人开启对话')
    const caption = text?.trim() || ''
    if (!caption && paths.length === 0) throw new FeishuSendValidationError('文案和文件不能同时为空')
    if (caption.length > 3500) throw new FeishuSendValidationError('文案不能超过 3500 个字符')
    if (paths.length > 10) throw new FeishuSendValidationError('一次最多发送 10 个文件')

    const files = [] as Array<{ handle: FileHandle; name: string; image: boolean; size: number }>
    try {
      const root = paths.length ? await realpath(session.config.workdir) : ''
      for (const input of [...new Set(paths)]) {
        if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
          throw new FeishuSendValidationError('文件路径无效')
        }
        const requested = isAbsolute(input) ? resolve(input) : resolve(root, input)
        const path = await realpath(requested).catch(() => {
          throw new FeishuSendValidationError(`文件不存在：${basename(input)}`)
        })
        const rel = relative(root, path)
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new FeishuSendValidationError(`文件不在当前工作目录内：${basename(input)}`)
        }
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile()) {
          await handle.close()
          throw new FeishuSendValidationError(`不是普通文件：${basename(input)}`)
        }
        const image = IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
        const limit = image ? IMAGE_LIMIT : FILE_LIMIT
        if (stat.size === 0) {
          await handle.close()
          throw new FeishuSendValidationError(`文件为空：${basename(input)}`)
        }
        if (stat.size > limit) {
          await handle.close()
          throw new FeishuSendValidationError(
            `${basename(input)} 超过飞书 ${image ? '图片 10 MB' : '文件 30 MB'} 限制`
          )
        }
        files.push({ handle, name: basename(path), image, size: stat.size })
      }
    } catch (error) {
      await Promise.all(files.map((file) => file.handle.close().catch(() => undefined)))
      throw error
    }

    const sent: string[] = []
    try {
      if (caption) {
        assertCurrent()
        await this.replyMessage(link, 'text', { text: caption }, undefined, client)
        sent.push('文案')
      }
      for (const file of files) {
        if (sent.length) await new Promise((resolveDelay) => setTimeout(resolveDelay, 220))
        let buffer: Buffer
        try { buffer = await file.handle.readFile() } finally { await file.handle.close() }
        if (buffer.length !== file.size) {
          throw new FeishuSendValidationError(`文件在发送前发生变化：${file.name}`)
        }
        assertCurrent()
        await this.uploadAttachment(link, file.name, buffer, file.image, client, assertCurrent)
        sent.push(file.name)
      }
      return sent
    } catch (error) {
      const suffix = sent.length ? `（已发送：${sent.join('、')}）` : ''
      if (error instanceof FeishuSendValidationError) {
        throw new FeishuSendValidationError(`${error.message}${suffix}`)
      }
      throw new Error(`${safeErr(error)}${suffix}`)
    } finally {
      await Promise.all(files.map((file) => file.handle.close().catch(() => undefined)))
    }
  }

  /** §5.3/5.4 — push an approval/question as a card into the thread. */
  private async pushApproval(link: FeishuThreadLink, ev: UAEvent, progress?: ProgressCardState): Promise<void> {
    const key = `${link.sessionId}/${ev.payload.requestId}`
    const latest = this.requestEvents.get(key) || ev
    if (latest.state !== 'pending' || latest.payload.interactionExpired || this.requestCards.has(key)) return
    const isStale = (): boolean => ev.payload.delivery !== 'async' && ev.payload.method !== 'local/plan' && !!progress && (
      !!progress.interruptRequested || !!progress.final || this.progressCards.get(link.sessionId) !== progress
    )
    if (!this.client || isStale()) return
    const { requestId, method, kind, params } = ev.payload
    const mcpTool = kind === 'mcpTool' || (kind === 'elicitation' && isMcpToolApproval(params))
    const effectiveKind = mcpTool ? 'mcpTool' : kind
    const isQuestion = effectiveKind === 'question' || effectiveKind === 'elicitation'
    let card: object
    if (isQuestion) {
      // 需求3 — build ONE interactive form card covering EVERY question (single →
      // dropdown, multi → multi-select, text → input), reusing the renderer's
      // normalizeQuestions so codex/traex/MCP all parse identically. A card submit
      // returns form_value; the text-reply path remains a fallback. Degrade to the
      // note card only when a shape yields no fields (keeps the reply round-tripping).
      const answerKind = questionAnswerKind(kind, method)
      const fields = normalizeQuestions(answerKind, params)
      card = fields.length
        ? questionFormCard(answerKind, requestId, link.sessionId, fields, ev.payload.delivery)
        : noteCard('❓ ' + kindTitle(kind), `${questionPrompt(params)}\n\n请在${link.replyInThread === false ? '聊天' : '本话题'}内直接回复你的答复。`)
      const qid = firstQuestionId(params)
      const prop = firstElicitProp(params)
      this.pending.set(key, { sessionId: link.sessionId, requestId, kind, method, qid, prop, fields })
    } else {
      card = approvalCard(effectiveKind, method, requestId, link.sessionId, params, ev.payload.options)
      // Remember what this approval is about so the resolved card can echo it
      // (which files / command) after the user presses a button — same idea as
      // the question card replaying the answered questions.
      this.pendingApprovals.set(key, { sessionId: link.sessionId, requestId, kind: effectiveKind, method, params, options: ev.payload.options })
    }
    const pin = (node: any): void => { if (!node || typeof node !== 'object') return; if (node.value?.requestId) node.value.requestSeq = ev.seq; for (const child of Object.values(node)) if (child && typeof child === 'object') pin(child) }
    pin(card)
    const tracked: RequestCardState = { sessionId: link.sessionId, requestSeq: ev.seq, kind: effectiveKind, v2: 'schema' in card }
    if (ev.payload.channel === 'side') (card as any).header.title.content = '侧边对话 · ' + (card as any).header.title.content
    this.requestCards.set(key, tracked)
    try {
      const mid = await this.replyMessage(link, CARD_MSG_TYPE, card)
      tracked.messageId = mid
      if (this.requestCards.get(key) !== tracked) return
      if (tracked.settled) return
      if (isStale()) {
        await this.resolveRequestCard({ ...ev, state: 'cancelled' })
        return
      }
      this.deps.threadStore.patch(link.sessionId, { pendingRequestId: requestId })
      this.bump(link.sessionId, ev.seq)
    } catch (error) {
      if (this.requestCards.get(key) === tracked) this.requestCards.delete(key)
      this.clearPendingRequest(link.sessionId, requestId)
      this.reportError('feishu_question_send_failed', '发送提问卡片', error, { sessionId: link.sessionId, requestId })
      throw error
    }
  }

  private clearPendingRequest(sessionId: string, requestId: string): void {
    const key = `${sessionId}/${requestId}`
    this.pending.delete(key)
    this.pendingApprovals.delete(key)
    if (this.deps.threadStore.bySession(sessionId)?.pendingRequestId === requestId) {
      this.deps.threadStore.patch(sessionId, { pendingRequestId: undefined })
    }
  }

  private async resolveRequestCard(ev: UAEvent): Promise<void> {
    const { requestId, kind, method, params, submittedAnswer: answer } = ev.payload
    // The send and resolve share pushChains, including when the App answers
    // before Feishu has returned the original card's message ID.
    this.clearPendingRequest(ev.sessionId, requestId)
    const key = `${ev.sessionId}/${requestId}`
    const card = this.requestCards.get(key)
    if (!card) return
    const isQuestion = card.kind === 'question' || card.kind === 'elicitation'
    const cancelled = ev.state !== 'success' || ['cancel', 'cancelled'].includes(answer?.action) || (isQuestion && answer?.action === 'decline') ||
      ['cancel', 'cancelled'].includes(answer?.decision) || answer?.outcome === 'cancelled' || answer?.outcome?.outcome === 'cancelled'
    const planLabel = answer?.decision === 'approved' ? '已确认' : answer?.decision === 'rejected' ? '已反馈' : '已跳过'
    const label = ev.payload.interactionExpired || ev.state === 'failed' ? '已失效' : card.kind === 'planMode' ? (card.source === 'feishu' ? planLabel : '已在 UniAgent App 处理 · ' + planLabel) : cancelled ? '已取消' : card.source === 'feishu'
      ? isQuestion ? '已回答' : '已处理'
      : isQuestion ? '已在 UniAgent App 回复' : '已在 UniAgent App 处理'
    const detail = cancelled ? undefined : isQuestion
      ? questionAnswerDetail(normalizeQuestions(questionAnswerKind(kind, method), params), answer, questionAnswerKind(kind, method))
      : card.kind === 'planMode' && answer?.feedback ? String(answer.feedback) : approvalDetailText(card.kind, params)
    card.settled = true
    card.resolved ||= resolvedCard(label, detail, card.v2)
    await this.patchRequestCard(key, card)
  }

  private async patchRequestCard(key: string, card: RequestCardState): Promise<void> {
    const client = this.client
    if (!client || !card.messageId || !card.resolved || this.requestCards.get(key) !== card) return
    // ponytail: failed patches retry on reconnect; add a timer if same-connection retries are needed.
    const result = await withFeishuDeadline('update_request_card', () => client.im.v1.message.patch({
      path: { message_id: card.messageId! }, data: { content: JSON.stringify(card.resolved) }
    }))
    if (result.code) throw new FeishuBusinessError(result.code, result.msg)
    if (this.requestCards.get(key) === card) this.requestCards.delete(key)
  }

  // ---- inbound ----

  private assistantInbound = new Map<string, Promise<void>>()
  private enqueueAssistantChat<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.assistantInbound.get(chatId) || Promise.resolve()
    const operation = previous.catch(() => {}).then(run)
    const finished = operation.then(() => {}, () => {}).finally(() => {
      if (this.assistantInbound.get(chatId) === finished) this.assistantInbound.delete(chatId)
    })
    this.assistantInbound.set(chatId, finished)
    return operation
  }

  private onInboundMessage(data: any): Promise<void> {
    if (!this.deps.createAssistantSession) return this.handleInboundMessage(data)
    const chatId = String(data?.message?.chat_id || '')
    const generation = this.connectionGeneration
    return this.enqueueAssistantChat(chatId, () => {
      if (generation !== this.connectionGeneration) throw new Error('connection_changed')
      return this.handleInboundMessage(data)
    })
  }

  private async handleInboundMessage(data: any): Promise<void> {
    const generation = this.connectionGeneration
    const message = data?.message
    const sender = data?.sender
    // Drop bot/app senders AND any echo of a message WE sent — either would make
    // the bot answer its own replies forever (self-reply death loop).
    if (!message || sender?.sender_type === 'app') return
    if (this.completeNotificationBinding(data)) return
    const inGroup = message.chat_type !== 'p2p'
    if (this.deps.createAssistantSession && inGroup && !(Array.isArray(message.mentions) && message.mentions.length > 0)) return
    const messageId: string = message.message_id
    if (messageId && this.sentMessageIds.has(messageId)) return
    const chatId: string = message.chat_id
    const threadId: string | undefined = message.thread_id
    const rootId: string | undefined = message.root_id
    const parentId: string | undefined = message.parent_id
    const content = extractMessageContent(message.content, message.message_type)
    const text = stripMentions(content.text)
    if (!text && content.imageKeys.length === 0) return
    if (chatId && (!this.deps.createAssistantSession || !inGroup)) this.defaultChatId = chatId

    // Assistant private chats always use the current session, including replies
    // to old messages after /new. Remote Bot and group chats route by topic.
    let link: FeishuThreadLink | undefined
    if (this.deps.createAssistantSession && !inGroup) {
      link = this.getAssistantPrivateSessions().find(item => item.chatId === chatId && item.botAppId === this.clientAppId)
    } else {
      if (threadId) link = this.deps.threadStore.byThread(threadId)
      if (!link && rootId) link = this.deps.threadStore.byRootMessage(rootId)
      if (!link && parentId) link = this.deps.threadStore.byRootMessage(parentId)
    }

    if (link) {
      if (this.deps.createAssistantSession && (link.chatId !== chatId || link.botAppId !== this.clientAppId)) return
      const bound = this.deps.orchestrator.getSessionById(link.sessionId)
      if (!bound) {
        // The bound session was permanently deleted — a retry can never succeed,
        // so tell the user and finish (handled, not retryable).
        await this.replyText(link, '⚠️ 该会话已被删除，无法继续对话，请发送新消息开启新会话。')
        return
      }
      if (this.deps.acceptsSession && !this.deps.acceptsSession(bound)) return
      if (this.deps.createAssistantSession && !inGroup && link.replyInThread !== false) {
        link = this.deps.threadStore.patch(bound.id, { replyInThread: false, threadId: undefined })!
      }
      if (text === '/model') {
        if (content.imageKeys.length) { await this.replyText(link, '会话命令不支持附件，请移除附件后重试'); return }
        await this.offerModelCard(bound, link)
        return
      }
      const command = bound.config.assistantSnapshot ? parseAssistantCommand(text) : undefined
      if (command && this.deps.assistantCommand) {
        if (content.imageKeys.length) { await this.replyText(link, '会话命令不支持附件，请移除附件后重试'); return }
        const next = await this.deps.assistantCommand(bound.id, command, messageId)
        link = this.rebindAssistantSession(bound.id, next) || link
        this.deps.onSessionCreated?.(next)
        await this.replyText(link, command === 'clear' ? '已清空当前对话，长期记忆已保留。' : '已开启新对话。')
        return
      }
      if (isToolSession(bound)) {
        await this.replyText(link, '这是工具创建的只读会话，请先在 UniAgent 中点击「启用会话」再继续对话。')
        return
      }
      // Continuing an archived session from Feishu restores it first (out of the
      // archive drawer) so the turn can run and the user just keeps chatting.
      if (bound.archived) {
        if (bound.teamBinding && this.deps.teams) this.deps.teams.archive(this.deps.teams.binding(bound.id).p.id, false)
        else this.deps.orchestrator.setArchived(link.sessionId, false)
      }
      this.sessionChat.set(link.sessionId, chatId)
      const attachments = await this.downloadImages(messageId, content.imageKeys)
      const candidates = [...this.pending.values()].filter(request => request.sessionId === link!.sessionId)
      const referenced = parentId ? candidates.find(request => this.requestCards.get(`${link!.sessionId}/${request.requestId}`)?.messageId === parentId) : undefined
      const pending = referenced || (candidates.length === 1 ? candidates[0] : undefined)
      if (text && (candidates.length > 1 && !referenced || pending && (pending.fields?.length || 0) > 1)) {
        await this.replyText(link, '当前有多条待答问题，请在对应提问卡片中填写并提交；也可引用某张单题卡片回复。')
        return
      }
      if (pending && text) {
        const key = `${link.sessionId}/${pending.requestId}`
        const card = this.requestCards.get(key)
        if (card?.submitting) { await this.replyText(link, '回答正在提交，请稍候。'); return }
        const answer = buildQuestionAnswer(pending, text)
        if (card) { card.source = 'feishu'; card.submitting = true }
        try {
          const result = await this.deps.orchestrator.respondToRequest(link.sessionId, pending.requestId, answer, { source: 'feishu' })
          if (!result?.handled) throw new Error('提问已处理或失效，请使用最新卡片')
          this.clearPendingRequest(link.sessionId, pending.requestId)
          if (attachments.length) await this.sendFeishuMessage(link.sessionId, '', attachments)
          void this.reactReceived(link.sessionId, messageId)
        } catch (error) {
          if (card) card.source = undefined
          await this.replyText(link, '回答提交失败：' + safeErr(error) + '。请通过对应提问卡片重试。')
        } finally { if (card) card.submitting = false }
      } else {
        await this.sendFeishuMessage(link.sessionId, text, attachments)
        void this.reactReceived(link.sessionId, messageId)
      }
      return
    }
    if (text === '/model') {
      if (inGroup && !message.mentions?.length && !rootId && !parentId && !threadId) return
      await this.replyUnboundAssistant(chatId, rootId || parentId || messageId, '当前没有绑定的对话，请先建立对话后再发送 /model。', inGroup)
      return
    }
    if (!this.deps.createAssistantSession && (rootId || parentId)) return
    if (this.deps.createAssistantSession) {
      const anchorId = inGroup ? rootId || parentId || messageId : messageId
      const command = parseAssistantCommand(text)
      if (command) {
        await this.replyUnboundAssistant(chatId, anchorId, '当前没有助手对话，请先发送消息开始对话。', inGroup)
        return
      }
      const attachments = await this.downloadImages(messageId, content.imageKeys)
      try {
        await this.deps.createAssistantSession(appendFeishuContext(text), attachments, session => {
          this.sessionChat.set(session.id, chatId)
          this.deps.threadStore.upsert({ sessionId: session.id, chatId, rootMessageId: anchorId,
            threadId: inGroup ? threadId : undefined, replyInThread: inGroup,
            rootAppId: null, botAppId: this.clientAppId, lastPushedSeq: 0, driver: 'feishu' })
          void this.reactReceived(session.id, messageId)
        }, () => { if (generation !== this.connectionGeneration) throw new Error('connection_changed') })
      } catch (error) {
        if (generation !== this.connectionGeneration) throw error
        await this.replyUnboundAssistant(chatId, anchorId, '无法开始个人助手对话：' + safeErr(error), inGroup)
      }
      return
    }

    // 需求 — a top-level message no longer spins up a session blind. Instead the
    // bot replies a config card (项目 + Agent + 模型 + 推理强度, defaults
    // pre-selected) anchored on the user's message; the session is created when
    // they press 开始. In a group we only react to an explicit @-mention (Feishu
    // only delivers @-bot群消息 by default anyway); the notify-group binding is a
    // purely outbound concern and must NOT gate which群 can start a话题.
    if (inGroup) {
      const mentioned = Array.isArray(message.mentions) && message.mentions.length > 0
      if (!mentioned) return
    }
    await this.offerTopicCard(text, content.imageKeys, chatId, messageId)
  }

  private sendFeishuMessage(sessionId: string, text: string, attachments: Attachment[]): Promise<void> {
    return this.deps.orchestrator.forceSend(sessionId, appendFeishuContext(text), attachments, undefined, { source: 'feishu' }, false)
  }
  private async replyUnboundAssistant(chatId: string, messageId: string, text: string, inGroup: boolean): Promise<void> {
    await withFeishuDeadline('reply_assistant_start', () => this.replyMessage({
      sessionId: '', chatId, rootMessageId: messageId, replyInThread: inGroup, lastPushedSeq: 0
    }, 'text', { text }))
  }

  private modelCards = new Map<string, ModelCardState>()

  private modelConfigError(session: Session): string | undefined {
    if (isToolSession(session) || session.readOnly) return '这是只读会话，请先在 UniAgent 中启用会话。'
    if (session.archived) return '该会话已归档，请先在 UniAgent 中恢复会话。'
    const leader = session.teamBinding && this.deps.teams?.binding(session.id).leader
    if ((session.teamBinding || session.config.roleSnapshot) && !leader) return '该会话的模型由角色或专家团配置管理，无法单独修改。'
    return undefined
  }

  private modelAgent(session: Session): AgentDef {
    const agent = this.deps.getAgents().find(agent => agent.id === session.config.agentId)
    if (!agent) throw new Error('当前 Agent 不可用，请先在 UniAgent 中检查配置。')
    return agentForSession(agent, session)
  }

  private async offerModelCard(session: Session, link: FeishuThreadLink): Promise<void> {
    const error = this.modelConfigError(session)
    if (error) { await this.replyText(link, error); return }
    if (this.modelCards.get(session.id)?.submitting) { await this.replyText(link, '模型配置正在保存，请稍候。'); return }
    let agent: AgentDef, selection: FeishuModelSelection
    try {
      agent = this.modelAgent(session)
      selection = selectFeishuModel(agent, session.config.model, modelDepth(session.config, agent))
    } catch (error) { await this.replyText(link, safeErr(error)); return }
    const state: ModelCardState = { id: randomUUID(), link: { ...link }, selection }
    this.modelCards.set(session.id, state)
    try {
      state.messageId = await this.replyMessage(link, CARD_MSG_TYPE, feishuModelCard(state.id, session, agent, selection))
    } catch (error) {
      if (this.modelCards.get(session.id) === state) this.modelCards.delete(session.id)
      throw error
    }
  }

  private modelCardCurrent(state: ModelCardState): boolean {
    const link = this.deps.threadStore.bySession(state.link.sessionId)
    return this.modelCards.get(state.link.sessionId) === state && !!link &&
      link.chatId === state.link.chatId && link.rootMessageId === state.link.rootMessageId &&
      link.botAppId === state.link.botAppId && link.replyInThread === state.link.replyInThread &&
      (!this.deps.createAssistantSession || link.replyInThread === true || this.getAssistantPrivateSessions().some(item => item.sessionId === link.sessionId))
  }

  private onModelCardAction(value: Record<string, unknown>, evt: any): object {
    const sessionId = String(value.sessionId || '')
    const state = this.modelCards.get(sessionId)
    const session = this.deps.orchestrator.getSessionById(sessionId)
    const fail = (content: string): object => ({ toast: { type: 'error', content } })
    if (!this.client || !this.deps.getSettings()?.enabled || !state || !session ||
      state.id !== value.modelCardId || !state.messageId || evt?.messageId !== state.messageId || evt?.chatId !== state.link.chatId ||
      !this.modelCardCurrent(state) || this.deps.acceptsSession && !this.deps.acceptsSession(session)) {
      return fail('该卡片已失效，请在当前对话重新发送 /model。')
    }
    if (state.resolved) return { toast: { type: 'info', content: '该卡片已处理' }, card: { type: 'raw', data: state.resolved } }
    if (state.submitting) return { toast: { type: 'info', content: '模型配置正在保存，请稍候。' } }
    const error = this.modelConfigError(session)
    if (error) return fail(error)
    if (value.act === 'cancelModel') {
      state.resolved = resolvedCard('已取消', '模型配置未修改。', true)
      return { card: { type: 'raw', data: state.resolved } }
    }
    try {
      const agent = this.modelAgent(session)
      const option = evt?.action?.option
      if (value.act === 'selectModel') {
        if (typeof option !== 'string' || !agent.models.some(model => model.id === option)) return fail('所选模型已不可用，请重新发送 /model。')
        state.selection = selectFeishuModel(agent, option, state.selection.depth)
        return { card: { type: 'raw', data: feishuModelCard(state.id, session, agent, state.selection) } }
      }
      if (value.act === 'selectDepth') {
        const selection = { ...state.selection, depth: typeof option === 'string' ? option : undefined }
        feishuModelPatch(agent, selection)
        state.selection = selection
        return { toast: { type: 'info', content: '已选择，点击应用后生效。' } }
      }
      if (value.act !== 'applyModel') return fail('无效的操作')
      if (isSessionBusy(session.status)) return fail('当前对话正在运行，请等待本轮结束后再应用。')
      const patch = feishuModelPatch(agent, state.selection)
      state.submitting = true
      // ACK immediately: provider model changes may outlive Feishu's 3-second callback deadline.
      void this.applyModelCard(state, agent, patch).catch(error => {
        this.reportError('feishu_model_update_failed', '更新模型卡片', error, { sessionId })
      })
      return { toast: { type: 'info', content: '正在保存模型配置…' } }
    } catch (error) { return fail(safeErr(error)) }
  }

  private async applyModelCard(state: ModelCardState, agent: AgentDef, patch: Partial<SessionConfig>): Promise<void> {
    const client = this.client!
    const sessionId = state.link.sessionId
    let savedSummary: string
    try {
      const updated = await this.deps.orchestrator.updateSessionConfig(sessionId, patch)
      if (!updated) throw new Error('会话已不存在。')
      this.deps.onSessionUpdated?.(updated)
      // The orchestrator can ignore a busy update or normalize unsupported options.
      if (updated.config.model !== state.selection.model || modelDepth(updated.config, agent) !== state.selection.depth) {
        throw new Error('所选配置未生效，请等待当前操作结束后重新发送 /model。')
      }
      savedSummary = feishuModelSummary(agent, updated.config)
      state.resolved = resolvedCard('模型配置已更新', `${savedSummary}\n\n从下一轮生效。`, true)
    } catch (error) {
      if (this.client === client && this.modelCardCurrent(state)) {
        await this.replyText(state.link, '模型配置保存失败：' + safeErr(error))
      }
      return
    } finally { state.submitting = false }
    if (this.client !== client || !this.modelCardCurrent(state)) return
    try {
      const result = await withFeishuDeadline('update_model_card', () => client.im.v1.message.patch({
        path: { message_id: state.messageId! }, data: { content: JSON.stringify(state.resolved) }
      }))
      if (result.code) throw new FeishuBusinessError(result.code, result.msg)
    } catch (error) {
      if (this.client === client && this.modelCardCurrent(state)) {
        await this.replyText(state.link, `模型配置已保存：${savedSummary}。卡片更新失败，请重新发送 /model 查看。`)
      }
      throw error
    }
  }

  /** sessionId → the topic config card currently offered for a new message. */
  private pendingTopics = new Map<string, TopicOffer>()

  /**
   * 需求 — reply a config card anchored on the user's message. The card lets the
   * user pick 项目/Agent/模型/推理强度 (defaults pre-selected) before the
   * session is created on 开始. The card reply establishes the 话题 whose root is
   * the user's own message, so later agent replies thread underneath it.
   */
  private async offerTopicCard(
    text: string,
    imageKeys: string[],
    chatId: string,
    userMessageId: string
  ): Promise<void> {
    if (!this.client) return
    const topicId = randomUUID()
    const sel = this.defaultSelection()
    const offer: TopicOffer = { text, imageKeys, chatId, userMessageId, sel }
    try {
      const res = await this.client.im.v1.message.reply({
        data: { content: JSON.stringify(this.topicCard(topicId, offer)), msg_type: CARD_MSG_TYPE, reply_in_thread: true },
        path: { message_id: userMessageId }
      })
      const cardMid = res.data?.message_id
      if (cardMid) this.sentMessageIds.add(cardMid)
      offer.cardMessageId = cardMid
      offer.threadId = res.data?.thread_id
      this.pendingTopics.set(topicId, offer)
    } catch (error) {
      this.deps.onError?.(safeErr(error))
      // Propagate so the inbound dedup layer forgets this id and a redelivery can
      // retry the offer (mirrors the thread-continuation failure contract).
      throw error
    }
  }

  /** Installed agents eligible to drive a Feishu session. */
  private installedAgents(): AgentDef[] {
    return this.deps.getAgents().filter((a) => a.lifecycle?.availability === 'available')
  }

  /** Pre-selected card values from the persisted defaults (all still editable). */
  private defaultSelection(): TopicSelection {
    const settings = this.deps.getSettings()
    const agents = this.installedAgents()
    const wantId = settings?.defaultAgentId
    const agent = (wantId && agents.find((a) => a.id === wantId || a.adapter === wantId)) || agents[0]
    const pref = agent && this.deps.getAgentPref?.(agent.id)
    const model = resolveAgentModel(agent, settings?.defaultModel, pref?.defaultModel)
    return {
      projectId: this.defaultProjectId(settings),
      executor: 'agent',
      agentId: agent?.id || '',
      model: model?.id,
      effort: agent?.capabilities.reasoningEffort ? resolveModelEffort(model, settings?.defaultEffort, pref?.defaultEffort) : undefined
    }
  }

  private defaultProjectId(settings: FeishuSettings | undefined): string {
    const all = this.projects()
    if (settings?.defaultProjectId && all.some((project) => project.id === settings.defaultProjectId)) {
      return settings.defaultProjectId
    }
    if (settings?.defaultWorkdir) {
      return this.deps.resolveProjectConfig?.({ agentId: '', workdir: settings.defaultWorkdir }).projectId || 'default'
    }
    return all.find((project) => project.isDefault)?.id || 'default'
  }

  private topicCard(topicId: string, offer: TopicOffer): object {
    const catalog = this.deps.teams?.catalog()
    if (offer.sel.executor !== 'team' && this.installedAgents().length) {
      const resolved = this.resolveSelection(offer.sel)
      offer.sel.model = resolved.model
      offer.sel.effort = resolved.effort
    }
    return topicConfigCard(
      topicId, offer.sel, this.installedAgents(), this.projects(),
      (this.deps.getRequirements?.() || []).filter((requirement) => requirement.status !== 'archived'),
      (catalog?.teams || []).filter((team) => team.status === 'active' && !catalog?.unavailableReasons?.[team.id])
    )
  }

  private projects(): Project[] {
    return this.deps.getProjects?.() || [{
      id: 'default', name: '默认项目', primaryDirectory: process.env.HOME || '.',
      additionalDirectories: [], createdAt: 0, updatedAt: 0, isDefault: true
    }]
  }

  /** Add a "received" reaction to the triggering message; cleared on turn end. */
  private async reactReceived(sessionId: string, messageId: string): Promise<void> {
    if (!this.client || !messageId) return
    this.ack.set(sessionId, { messageId })
    try {
      const r = await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: ACK_EMOJI } }
      })
      const rid = r.data?.reaction_id
      if (!rid) return
      const rec = this.ack.get(sessionId)
      if (rec && rec.messageId === messageId) {
        rec.reactionId = rid
      } else {
        // The turn already ended (a fast agent → `clearAck` ran before this
        // reaction landed, so it deleted the ack record with no reactionId and
        // the emoji lingered forever — the reported "加了 emoji 却没回复/没消失").
        // Remove the now-orphaned reaction we just created.
        try {
          await this.client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: rid } })
        } catch { /* already gone */ }
      }
    } catch { /* reactions are best-effort — the turn still runs */ }
  }

  private async onCardAction(raw: unknown): Promise<unknown> {
    const evt = normalizeCardAction(raw as any)
    const value = (evt?.action?.value || {}) as Record<string, unknown>
    if (value.modelCardId) return this.onModelCardAction(value, evt)
    // 需求 — new-topic config card: agent change re-renders the model/effort
    // options (dynamic linkage); 开始 creates the session with the chosen config.
    const topicId = String(value.topicId || '')
    if (topicId) return this.onTopicCardAction(topicId, value, evt)
    const sessionId = String(value.sessionId || '')
    if (!sessionId) return { toast: { type: 'error', content: '无效的操作' } }
    const session = this.deps.orchestrator.getSessionById(sessionId)
    if (isToolSession(session)) {
      return { toast: { type: 'error', content: '请先在 UniAgent 中启用此工具会话' } }
    }
    if (value.act === 'interruptSession') {
      const progress = this.progressCards.get(sessionId)
      const link = this.deps.threadStore.bySession(sessionId)
      if (
        !this.deps.getSettings()?.enabled || !this.client || !session || session.archived || session.readOnly ||
        !progress || progress.final || value.progressId !== progress.replyUuid ||
        !progress.messageId || evt?.messageId !== progress.messageId || !link || evt.chatId !== link.chatId
      ) return { toast: { type: 'error', content: '该运行卡片已失效，无法中断当前回合' } }
      if (progress.interruptRequested || session.status === 'cancelling') {
        return { toast: { type: 'info', content: '正在中断，请稍候…' } }
      }
      const teamWaiting = !!session.teamBinding && !!this.deps.teams && progress.teamWaiting && progress.teamRunId === this.deps.teams.binding(sessionId).p.runId
      if (!teamWaiting && !['running', 'queued', 'awaiting-approval'].includes(session.status)) {
        return { toast: { type: 'error', content: '该回合已结束，无需中断' } }
      }
      // replyUuid identifies the card's lifetime even before a provider turn ID
      // arrives. Stop locally without awaiting Feishu's network or a later turn.
      progress.interruptRequested = true
      try {
        if (session.teamBinding && this.deps.teams) this.deps.teams.stop(this.deps.teams.binding(sessionId).p.id)
        else this.deps.orchestrator.interrupt(sessionId)
      } catch (error) {
        progress.interruptRequested = false
        this.reportError('feishu_interrupt_failed', '中断会话', error, { sessionId })
        return { toast: { type: 'error', content: '中断失败，请重试或在 UniAgent 中停止' } }
      }
      this.logProgress(progress, 'progress_interrupt_requested')
      this.queueProgressFlush(progress)
      return { toast: { type: 'info', content: '已请求中断当前回合，正在停止…' } }
    }
    if (value.act === 'interruptTeam') return { toast: { type: 'error', content: '旧版专家团运行卡已失效，请使用 Leader 会话或在 App 中停止' } }
    const requestId = String(value.requestId || '')
    if (!sessionId || !requestId) return { toast: { type: 'error', content: '无效的操作' } }
    if (this.deps.teams && value.teamInteractionId && this.deps.orchestrator.getSessionById(sessionId)?.teamBinding) return this.onTeamCardAction(sessionId, requestId, value, raw)
    const key = `${sessionId}/${requestId}`
    const card = this.requestCards.get(key)
    const pending = this.pending.get(key)
    const approval = this.pendingApprovals.get(key)
    if (!card || card.settled || value.requestSeq !== card.requestSeq || (!pending && !approval)) return { toast: { type: 'info', content: '该请求已处理或失效，请勿重复提交' } }
    if (card.submitting) return { toast: { type: 'info', content: '回答正在提交，请稍候' } }
    if (session?.archived || session?.readOnly || session?.status === 'cancelling') return { toast: { type: 'error', content: '当前会话无法回答提问' } }
    const act = String(value.act || '')
    if (act === 'revisePlan' && approval?.kind === 'planMode') {
      const preview = planConfirmationCard(sessionId, requestId, approval.method, approval.params, true)
      const pin = (node: any): void => { if (!node || typeof node !== 'object') return; if (node.value?.requestId) node.value.requestSeq = card.requestSeq; for (const child of Object.values(node)) if (child && typeof child === 'object') pin(child) }
      pin(preview)
      return { card: { type: 'raw', data: preview } }
    }
    let answer: unknown
    let feedback: string | undefined
    try {
      if (pending) {
        if (act === 'cancelQuestion' && (pending.kind === 'elicitation' || pending.method === 'zcode/userInput')) answer = { action: 'cancel' }
        else if (act === 'submitQuestion') {
          const answerKind = questionAnswerKind(pending.kind, pending.method)
          answer = encodeAnswer(answerKind, pending.fields || [], collectFormValue(pending.fields || [], (raw as any)?.action?.form_value || {}))
          validateQuestionAnswer(answerKind, pending.fields || [], answer)
        } else throw new Error('无效的答题操作')
      } else if (approval?.kind === 'planMode') {
        if (act === 'submitPlanFeedback') {
          feedback = String((raw as any)?.action?.form_value?.feedback || '').trim()
          if (!feedback) throw new Error('请填写计划修改意见')
          answer = { decision: 'rejected', feedback }
        } else if (act === 'implementPlan') answer = { decision: 'approved' }
        else if (act === 'skipPlan') answer = { decision: 'cancelled' }
        else throw new Error('无效的计划操作')
      } else {
        validateApprovalAction(approval!.kind, approval!.method, approval!.params, approval!.options, value)
        answer = buildDecisionAnswer({ ...value, kind: approval!.kind, method: approval!.method })
      }
    } catch (error) { return { toast: { type: 'error', content: safeErr(error) } } }
    const answerKind = pending ? questionAnswerKind(pending.kind, pending.method) : ''
    const label = act === 'cancelQuestion' ? '已取消' : act === 'skipPlan' ? '已跳过' : act === 'implementPlan' ? '已确认' : act === 'submitPlanFeedback' ? '已反馈' : String(value.actLabel || (pending ? '已回答' : '已处理'))
    const detail = pending && act !== 'cancelQuestion'
      ? questionAnswerDetail(pending.fields || [], answer, answerKind)
      : approval ? approvalDetailText(approval.kind, approval.params) : undefined
    const locked = resolvedCard(label, detail, card.v2)
    card.submitting = true
    // Feishu requires an immediate ACK; completion is driven by provider acceptance.
    setImmediate(async () => {
      if (card.settled || this.requestCards.get(key) !== card) return
      card.source = 'feishu'
      try {
        const result = await this.deps.orchestrator.respondToRequest(sessionId, requestId, answer, { source: 'feishu' })
        if (!result?.handled) throw new Error('请求已处理或未被 Agent 接受，请使用最新卡片')
        if (feedback && !planFeedbackInAnswer(approval?.method)) {
          if (requestId.startsWith('side:')) await this.deps.orchestrator.forceSendSideMessage(sessionId, appendFeishuContext(feedback), undefined, undefined, { source: 'feishu' })
          else await this.sendFeishuMessage(sessionId, feedback, [])
        }
        this.clearPendingRequest(sessionId, requestId)
        if (!card.settled && this.requestCards.get(key) === card) {
          card.settled = true; card.resolved = locked
          this.enqueuePush(sessionId, () => this.patchRequestCard(key, card))
        }
      } catch (error) {
        card.source = undefined
        this.reportError('feishu_question_submit_failed', '提交提问回答', error, { sessionId, requestId })
        const link = this.deps.threadStore.bySession(sessionId)
        if (link) this.enqueuePush(sessionId, () => this.replyText(link, '回答提交失败：' + safeErr(error) + '。填写内容已保留，请重试；若请求已处理，请使用最新卡片。'))
      } finally { card.submitting = false }
    })
    return { toast: { type: 'info', content: '正在向 Agent 提交，请等待确认' } }
  }

  /**
   * 需求 — the new-topic config card callback. Each select is standalone, so a
   * change fires here with `action.option` = the chosen value: setProject/setModel/
   * setEffort merge that field and re-render; agentChange also swaps 模型/推理强度
   * to the new agent's options. 开始 (startTopic) creates the session with the
   * accumulated selection and anchors the 话题 on the user's original message. The
   * 3s ACK returns a toast synchronously.
   */
  private async onTopicCardAction(topicId: string, value: Record<string, unknown>, evt: any): Promise<unknown> {
    const offer = this.pendingTopics.get(topicId)
    if (!offer) return { toast: { type: 'error', content: '会话已过期，请重新发送消息' } }
    // Each select is standalone (not in a form): its change fires this callback
    // with `action.option` = the newly-picked value. Merge that single field onto
    // the running selection based on which select fired (`act`).
    const option = evt?.action?.option != null ? String(evt.action.option) : undefined
    const act = String(value.act || '')
    const agents = this.installedAgents()
    if (act === 'setProject' && option) offer.sel.projectId = option
    else if (act === 'setRequirement') offer.sel.requirementId = option && option !== '__none__' ? option : undefined
    else if (act === 'setExecutor' && (option === 'agent' || option === 'team')) {
      offer.sel.executor = option
      if (option === 'team' && !offer.sel.teamId) offer.sel.teamId = this.availableTeams()[0]?.id
    }
    else if (act === 'setTeam' && option) offer.sel.teamId = option
    else if (act === 'setModel') offer.sel.model = option || undefined
    else if (act === 'setEffort') offer.sel.effort = (option || undefined) as ReasoningEffort | undefined
    else if (act === 'agentChange') {
      // Agent changed → its models/efforts differ; reset model/effort to that
      // agent's default so the re-rendered card shows a valid combination.
      if (option) offer.sel.agentId = option
      offer.sel.model = undefined
      offer.sel.effort = undefined
    }
    const isStart = act === 'startTopic'
    if (!isStart) {
      // Only Agent/模型 change the DOWNSTREAM options (模型 follows Agent, 推理强度
      // follows 模型), so only those re-render the card. 项目/推理强度 have nothing
      // below them — just ACK, so the card doesn't flicker on every pick.
      const relinks = act === 'setExecutor' || act === 'agentChange' || act === 'setModel'
      return relinks
        ? { toast: { type: 'info', content: '已更新' }, card: { type: 'raw', data: this.topicCard(topicId, offer) } }
        : { toast: { type: 'info', content: '已更新' } }
    }
    if (offer.sel.requirementId && !this.deps.getRequirements?.().some((item) => item.id === offer.sel.requirementId && item.status !== 'archived')) {
      return { toast: { type: 'error', content: '所选需求不存在或已归档，请重新选择' } }
    }
    if (offer.sel.executor === 'team') {
      try { this.resolveTeamSelection(offer.sel) }
      catch (error) { return { toast: { type: 'error', content: safeErr(error) } } }
    }
    // 开始 — create the session with the chosen config, anchor the 话题 on the
    // user's message. Lock the card NOW via the callback response (buttons gone);
    // once the session exists, patch in the full config summary.
    this.pendingTopics.delete(topicId)
    const resolved = offer.sel.executor === 'team' ? undefined : this.resolveSelection(offer.sel)
    void (async () => {
      try {
        const attachments = await this.downloadImages(offer.userMessageId, offer.imageKeys)
        let title: string
        let leaderSessionId = ''
        if (offer.sel.executor === 'team') {
          const team = this.resolveTeamSelection(offer.sel)
          if (!this.deps.createTeamProject) throw new Error('专家团创建入口不可用')
          const project = await this.deps.createTeamProject({
            teamId: team.id, spaceId: offer.sel.projectId, requirementId: offer.sel.requirementId,
            prompt: offer.text || '[图片]', attachments
          }, (created) => {
            leaderSessionId = created.memberSessions[created.team.leaderMemberId]
            if (!leaderSessionId) throw new Error('team_leader_session_missing')
            this.sessionChat.set(leaderSessionId, offer.chatId)
            this.bindTopic(leaderSessionId, offer)
          }, { prompt: appendFeishuContext(offer.text || '[图片]'), source: 'feishu' })
          leaderSessionId = project.memberSessions[project.team.leaderMemberId]
          if (!leaderSessionId) throw new Error('team_leader_session_missing')
          title = project.name
          await this.reactReceived(leaderSessionId, offer.userMessageId)
        } else {
          const session = this.createSessionFrom(appendFeishuContext(offer.text), attachments, offer.sel)
          leaderSessionId = session.id
          title = session.title
          this.sessionChat.set(session.id, offer.chatId)
          this.bindTopic(session.id, offer)
          await this.reactReceived(session.id, offer.userMessageId)
        }
        const messageId = offer.cardMessageId || evt?.messageId
        if (this.client && messageId) {
          try {
            await this.client.im.v1.message.patch({
              data: { content: JSON.stringify(resolvedCard('已开始', this.topicSummary(offer.sel, resolved, title), true)) },
              path: { message_id: messageId }
            })
          } catch { /* cosmetic */ }
        }
      } catch (error) {
        this.deps.onError?.(safeErr(error))
      }
    })()
    return {
      toast: { type: 'info', content: '正在创建会话…' },
      card: { type: 'raw', data: resolvedCard('正在创建会话…', this.topicSummary(offer.sel, resolved), true) }
    }
  }

  /** A locked-card summary of the config the session was actually created with. */
  private topicSummary(
    sel: TopicSelection,
    resolved?: { agent: AgentDef; model?: string; effort?: ReasoningEffort },
    title?: string
  ): string {
    const project = this.projects().find((p) => p.id === sel.projectId)
    const requirement = this.deps.getRequirements?.().find((item) => item.id === sel.requirementId)
    if (sel.executor === 'team') {
      const team = this.availableTeams().find((item) => item.id === sel.teamId)
      return [
        `**已开始** · ${title || '新会话'}`,
        `• 项目：${project?.name || sel.projectId}`,
        sel.requirementId ? `• 需求：${requirement?.name || sel.requirementId}` : '• 需求：不关联需求',
        `• 执行方：专家团`,
        `• 专家团：${team?.name || sel.teamId || '未选择'}`
      ].join('\n')
    }
    const modelLabel = resolved?.agent.models.find((m) => m.id === resolved.model)?.label || resolved?.model
    return [
      `**已开始** · ${title || '新会话'}`,
      `• 项目：${project?.name || sel.projectId}`,
      sel.requirementId ? `• 需求：${requirement?.name || sel.requirementId}` : '• 需求：不关联需求',
      `• 执行方：单 Agent`,
      `• Agent：${resolved?.agent.name || sel.agentId}`,
      resolved?.model ? `• 模型：${modelLabel}` : '',
      resolved?.effort ? `• 推理强度：${EFFORT_LABEL[resolved.effort] || resolved.effort}` : ''
    ].filter(Boolean).join('\n')
  }

  private bindTopic(sessionId: string, offer: TopicOffer): void {
    this.deps.threadStore.upsert({
      sessionId, chatId: offer.chatId, rootMessageId: offer.userMessageId, rootAppId: null, botAppId: this.clientAppId,
      threadId: offer.threadId, lastPushedSeq: 0, driver: 'feishu'
    })
  }

  private availableTeams(): TeamDefinition[] {
    const catalog = this.deps.teams?.catalog()
    return (catalog?.teams || []).filter((team) => team.status === 'active' && !catalog?.unavailableReasons?.[team.id])
  }

  private resolveTeamSelection(sel: TopicSelection): TeamDefinition {
    const team = this.availableTeams().find((item) => item.id === sel.teamId)
    if (!team) throw new Error('所选专家团不可用，请重新选择')
    return team
  }

  /**
   * Resolve a topic selection to a concrete, VALID agent/model/effort/permission.
   * The card re-renders on every select change and resets model/effort when the
   * agent changes, so `sel` should already be consistent — but a stale model/effort
   * is still dropped here as a last-resort guard against a wrong agent+model combo.
   */
  private resolveSelection(sel: TopicSelection): {
    agent: AgentDef; model?: string; effort?: ReasoningEffort; permissionMode: PermissionModeId
  } {
    const settings = this.deps.getSettings()
    const agents = this.installedAgents()
    const agent = agents.find((a) => a.id === sel.agentId) || agents[0]
    if (!agent) throw new Error('没有可接收飞书消息的 Agent')
    const pref = this.deps.getAgentPref?.(agent.id)
    const configuredAgent = !settings?.defaultAgentId || settings.defaultAgentId === agent.id || settings.defaultAgentId === agent.adapter
    const permissionMode = resolveAgentPermission(agent, configuredAgent ? settings?.defaultPermissionMode : undefined) || 'read-only'
    const model = resolveAgentModel(agent, sel.model, configuredAgent ? settings?.defaultModel : undefined, pref?.defaultModel)
    const effort = agent.capabilities.reasoningEffort
      ? resolveModelEffort(model, sel.effort, configuredAgent ? settings?.defaultEffort : undefined, pref?.defaultEffort)
      : undefined
    return { agent, model: model?.id, effort, permissionMode }
  }

  /** §5.6 — create a session from an explicit selection (permission stays default). */
  private createSessionFrom(text: string, attachments: Attachment[], sel: TopicSelection): Session {
    const { agent, model, effort, permissionMode } = this.resolveSelection(sel)
    const config: SessionConfig = {
      agentId: agent.id,
      model,
      effort,
      projectId: sel.projectId,
      requirementId: sel.requirementId,
      workdir: '',
      permissionMode
    }
    const runtimeConfig = this.deps.resolveProjectConfig?.(config) || {
      ...config,
      workdir: process.env.HOME || '.'
    }
    const session = this.deps.orchestrator.createSession(runtimeConfig, text, attachments, undefined, undefined, undefined, { source: 'feishu' })
    try { this.deps.onSessionCreated?.(session) } catch { /* renderer may be down */ }
    return session
  }

  private async downloadImages(messageId: string, imageKeys: string[]): Promise<Attachment[]> {
    if (!imageKeys.length) return []
    if (!this.client || !messageId) throw new Error('无法下载飞书图片')
    const keys = [...new Set(imageKeys)]
    if (keys.length > 10) throw new Error('一条消息最多处理 10 张图片')
    const directory = join(tmpdir(), INTERNAL_DISTRIBUTION ? 'uniagent-feishu-images' : 'uniagent-public-feishu-images')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const attachments: Attachment[] = []
    try {
      for (const [index, fileKey] of keys.entries()) {
        const resource = await this.client.im.v1.messageResource.get({
          params: { type: 'image' },
          path: { message_id: messageId, file_key: fileKey }
        })
        const contentType = responseHeader(resource.headers, 'content-type')
        const contentLength = Number(responseHeader(resource.headers, 'content-length'))
        if (Number.isFinite(contentLength) && contentLength > IMAGE_LIMIT) {
          throw new Error('飞书图片超过 10 MB 限制')
        }
        const imageType = FEISHU_IMAGE_TYPES[contentType || ''] || FEISHU_IMAGE_TYPES['image/png']
        const name = `feishu-image-${index + 1}${imageType.extension}`
        const path = join(directory, `${randomUUID()}${imageType.extension}`)
        try {
          await resource.writeFile(path)
          const metadata = await stat(path)
          if (!metadata.isFile() || metadata.size === 0) throw new Error('飞书图片为空')
          if (metadata.size > IMAGE_LIMIT) throw new Error('飞书图片超过 10 MB 限制')
        } catch (error) {
          await rm(path, { force: true }).catch(() => undefined)
          throw error
        }
        attachments.push({ kind: 'image', path, name, mime: imageType.mime })
      }
      return attachments
    } catch (error) {
      await Promise.all(attachments.map(({ path }) => rm(path, { force: true }).catch(() => undefined)))
      throw error
    }
  }

  /**
   * 需求 — scan chats the bot is a member of, so settings can bind one for
   * notifications. Paginates `im.v1.chat.list`.
   */
  async scanGroups(): Promise<FeishuGroupChat[]> {
    if (!this.connected || !this.client) throw new Error('飞书 Bot 未连接')
    const groups: FeishuGroupChat[] = []
    let pageToken: string | undefined
    for (let i = 0; i < 20; i++) {
      const res = await this.client.im.v1.chat.list({
        params: { page_size: 100, page_token: pageToken, sort_type: 'ByActiveTimeDesc' }
      })
      if (res.code) throw new FeishuBusinessError(res.code, res.msg)
      // Older list responses omit chat_mode; retain unknown entries, excluding known DMs.
      for (const item of res.data?.items || []) {
        if (item.chat_id && item.chat_mode !== 'p2p') {
          groups.push({ chatId: item.chat_id, name: item.name || item.chat_id })
        }
      }
      if (!res.data?.has_more || !res.data?.page_token) break
      pageToken = res.data.page_token
    }
    return groups
  }

  /** Bind an already-created session to an inbound chat (used by index.ts when a
   *  session originates elsewhere but should thread into a known DM). */
  bindPrivateSession(sessionId: string, chatId: string): void {
    this.sessionChat.set(sessionId, chatId)
  }
}

// ---- pure helpers (mirrors renderer ApprovalCard shapes) ----

function validateApprovalAction(kind: string, method: string, params: any, options: unknown, value: Record<string, unknown>): void {
  const act = String(value.act || '')
  if (method === 'session/request_permission' || method === 'zcode/permission') {
    if (act === 'cancel' && method === 'session/request_permission') return
    if (act === 'select' && Array.isArray(options) && options.some(option => option?.optionId === value.optionId)) return
  } else if (kind === 'mcpTool') {
    if (act === 'accept' || act === 'decline' || mcpToolApprovalScopes(params).includes(act as 'session' | 'always')) return
  } else if (act === 'accept' || act === 'decline' || act === 'session' && method !== 'claude/canUseTool') return
  throw new Error('该操作不在当前请求提供的选项中')
}

/** §5.5 — a text reply → question/elicitation answer shape. */
export function buildQuestionAnswer(pending: PendingAnswerable, text: string): unknown {
  if ((pending.fields?.length || 0) > 1) throw new Error('请通过提问卡片回答全部问题')
  if (questionAnswerKind(pending.kind, pending.method) === 'zcode') {
    const field = pending.fields?.[0]
    if (!field) throw new Error('ZCode 提问内容无效')
    const selected = field.options.find(option => option.value === text || option.label === text)?.value ?? text
    return { action: 'accept', content: { answers: { [field.id]: field.type === 'multi' ? [selected] : selected } } }
  }
  if (questionAnswerKind(pending.kind, pending.method) === 'deepseek') {
    const fields = pending.fields || []
    if (fields.length > 1) throw new Error('请通过提问卡片回答全部问题')
    return { answers: [{ id: fields[0]?.id || pending.qid || 'q0', selected: [], custom: text }] }
  }
  if (pending.kind === 'elicitation') {
    const prop = pending.prop || 'value'
    return { action: 'accept', content: { [prop]: text } }
  }
  const qid = pending.qid || 'q0'
  return { answers: { [qid]: { answers: [text] } } }
}

function firstQuestionId(params: any): string | undefined {
  const qs = params?.questions || params?.inputs
  if (Array.isArray(qs) && qs.length) return qs[0].id || qs[0].questionId || 'q0'
  return 'q0'
}

function firstElicitProp(params: any): string | undefined {
  const schema = params?.requestedSchema || params?.schema
  if (schema?.properties && typeof schema.properties === 'object') {
    const keys = Object.keys(schema.properties)
    if (keys.length) return keys[0]
  }
  return undefined
}

function questionPrompt(params: any): string {
  const qs = params?.questions || params?.inputs
  if (Array.isArray(qs) && qs.length) return String(qs[0].prompt || qs[0].question || qs[0].title || '请回答')
  const schema = params?.requestedSchema || params?.schema
  if (typeof schema?.description === 'string') return schema.description
  return '请回答以下问题'
}

function kindTitle(kind: string): string {
  switch (kind) {
    case 'command': return '命令执行审批'
    case 'fileChange': return '文件修改审批'
    case 'permissions': return '权限申请'
    case 'mcpTool': return 'MCP 工具授权'
    case 'question': return 'Agent 提问'
    case 'deepseek': return 'Agent 提问'
    case 'zcode': return 'Agent 提问'
    case 'elicitation': return '信息补充请求'
    default: return '审批请求'
  }
}

/** Build the interactive approval card (buttons carry the decision context). */
function approvalCard(
  kind: string,
  method: string,
  requestId: string,
  sessionId: string,
  params: any,
  options?: unknown
): object {
  if (kind === 'planMode') return planConfirmationCard(sessionId, requestId, method, params)
  const detail = approvalDetailText(kind, params)
  const base = (act: string, actLabel: string): Record<string, unknown> =>
    ({ sessionId, requestId, method, kind, act, actLabel })
  let actions: object[]
  if (kind === 'mcpTool') {
    actions = [button('允许一次', 'primary', base('accept', '已允许一次'))]
    const scopes = mcpToolApprovalScopes(params)
    if (scopes.includes('session')) actions.push(button('本会话允许', 'default', base('session', '已允许(本会话)')))
    if (scopes.includes('always')) actions.push(button('始终允许', 'default', base('always', '已始终允许')))
    actions.push(button('拒绝', 'danger', base('decline', '已拒绝')))
  } else if ((method === 'session/request_permission' || method === 'zcode/permission') && Array.isArray(options)) {
    actions = (options as any[])
      .filter((o) => typeof o?.optionId === 'string' && o.optionId)
      .map((o) => button(o.name || o.label || o.optionId, 'primary', { ...base('select', `选择「${o.name || o.label || o.optionId}」`), optionId: o.optionId }))
    if (method === 'session/request_permission') actions.push(button('取消', 'default', base('cancel', '取消')))
  } else {
    actions = [
      button('批准', 'primary', base('accept', '已批准')),
      ...(method === 'claude/canUseTool' ? [] : [button('本会话都批准', 'default', base('session', '已批准(本会话)'))]),
      button('拒绝', 'danger', base('decline', '已拒绝'))
    ]
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '🛡️ ' + kindTitle(kind) } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: clip(detail) } },
      { tag: 'action', actions }
    ]
  }
}

function planConfirmationCard(sessionId: string, requestId: string, method: string, params: any, feedback = false): object {
  const action = (act: string): object => ({ type: 'callback', value: { sessionId, requestId, kind: 'planMode', method, act } })
  const plan = String(params?.plan || params?.text || '')
  const elements: object[] = [{ tag: 'markdown', content: '**实施此计划？**' }]
  for (let offset = 0; offset < plan.length; offset += 3500) elements.push({ tag: 'markdown', content: plan.slice(offset, offset + 3500) })
  if (feedback) elements.push({ tag: 'form', name: 'planFeedback', elements: [
    { tag: 'input', name: 'feedback', required: true, placeholder: { tag: 'plain_text', content: '告诉 Agent 应该如何调整计划…' } },
    { tag: 'button', name: 'submitPlanFeedback', type: 'primary', form_action_type: 'submit', text: { tag: 'plain_text', content: '发送反馈' }, behaviors: [action('submitPlanFeedback')] },
  ] })
  else for (const [act, label] of [['implementPlan', '是，实施此计划'], ['revisePlan', '否，反馈修改'], ['skipPlan', '跳过']]) {
    elements.push({ tag: 'button', type: act === 'implementPlan' ? 'primary' : 'default', text: { tag: 'plain_text', content: label }, behaviors: [action(act)] })
  }
  return { schema: '2.0', config: { update_multi: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '计划执行确认' } }, body: { elements } }
}

function button(text: string, type: string, value: Record<string, unknown>): object {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, value }
}

/**
 * 需求3 — an interactive form card that lets the user answer EVERY question (single
 * → dropdown, multi → multi-select, text → input) inside Feishu and submit once.
 * Uses the JSON 2.0 form container (markdown labels are legal inside it, unlike v1).
 * Component names are index-based (`f0`,`o0`…) so `collectFormValue` maps the
 * `form_value` callback straight back onto NormalizedField[]. The submit button
 * carries the routing context via a `callback` behavior (surfaced as action.value).
 */
function questionFormCard(
  kind: string,
  requestId: string,
  sessionId: string,
  fields: NormalizedField[],
  delivery?: string
): object {
  const elements: object[] = delivery === 'async' ? [{ tag: 'markdown', content: 'Agent 可继续执行，回答将发回当前会话。' }] : []
  fields.forEach((f, i) => {
    const label = [f.title ? `**${f.title}**` : '', f.prompt].filter(Boolean).join('\n')
    if (label) for (let offset = 0; offset < label.length; offset += 3500) elements.push({ tag: 'markdown', content: label.slice(offset, offset + 3500) })
    if (f.detail) {
      for (let offset = 0; offset < f.detail.length; offset += 3500) {
        elements.push({ tag: 'markdown', content: f.detail.slice(offset, offset + 3500) })
      }
    }
    if (f.type === 'text') {
      elements.push({
        tag: 'input',
        name: `f${i}`,
        required: f.required,
        placeholder: { tag: 'plain_text', content: f.secret ? '输入内容（将被隐藏）' : '输入你的回答' }
      })
      return
    }
    if (f.options.some(option => option.description)) elements.push({ tag: 'markdown', content: f.options.map(option => `**${option.label}**${option.description ? '：' + option.description : ''}`).join('\n') })
    if (f.type === 'multi' && (f.minItems !== undefined || f.maxItems !== undefined)) elements.push({ tag: 'markdown', content: `可多选${f.minItems !== undefined ? '，至少 ' + f.minItems + ' 项' : ''}${f.maxItems !== undefined ? '，最多 ' + f.maxItems + ' 项' : ''}` })
    const options = f.options.map((o) => ({
      text: { tag: 'plain_text', content: clip(o.label, 120) },
      value: o.value
    }))
    if (f.allowOther) options.push({ text: { tag: 'plain_text', content: '其他（在下方填写）' }, value: OTHER_VALUE })
    elements.push({
      tag: f.type === 'multi' ? 'multi_select_static' : 'select_static',
      name: `f${i}`,
      required: f.required,
      placeholder: { tag: 'plain_text', content: f.type === 'multi' ? '可多选' : '请选择' },
      options
    })
    if (f.allowOther) {
      elements.push({
        tag: 'input',
        name: `o${i}`,
        required: false,
        placeholder: { tag: 'plain_text', content: '“其他”的自定义回答' }
      })
    }
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '提交回答' },
    type: 'primary',
    form_action_type: 'submit',
    name: 'submitQuestion',
    behaviors: [
      { type: 'callback', value: { sessionId, requestId, kind, act: 'submitQuestion', actLabel: '已回答' } }
    ]
  })
  const body: object[] = [{ tag: 'form', name: 'qform', elements }]
  if (kind === 'elicitation' || kind === 'zcode') body.push({ tag: 'button', type: 'default', name: 'cancelQuestion', text: { tag: 'plain_text', content: '取消' }, behaviors: [{ type: 'callback', value: { sessionId, requestId, kind, act: 'cancelQuestion' } }] })
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '❓ ' + kindTitle(kind) } },
    body: { elements: body }
  }
}

const EFFORT_LABEL: Record<string, string> = {
  low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra'
}

/**
 * 需求 — the new-topic config card: pick 项目/需求/执行方 and the selected
 * Agent or 专家团 configuration before the session starts.
 * Each select is a STANDALONE interactive component (deliberately
 * NOT inside a `<form>`): a standalone `select_static` fires its `callback`
 * behavior the instant an option is picked (`action.option` = the chosen value),
 * so the handler can re-render the card with that agent's models/efforts (live
 * 联动). Components inside a `<form>` only batch-submit on the form button and do
 * NOT fire per-select on-change callbacks — which is why the earlier form-based
 * card left 模型 showing the previous agent's value. 开始 is a plain callback
 * button that starts the session from the accumulated selection.
 */
export function topicConfigCard(
  topicId: string,
  sel: TopicSelection,
  agents: AgentDef[],
  projects: Project[] | string[],
  requirements: Requirement[] = [],
  teams: TeamDefinition[] = []
): object {
  const projectOptions: Project[] = projects.map((project) => typeof project === 'string'
    ? { id: project, name: project, primaryDirectory: project, additionalDirectories: [], createdAt: 0, updatedAt: 0 }
    : project)
  const selectedProjectId = sel.projectId || (sel as TopicSelection & { workdir?: string }).workdir || projectOptions[0]?.id
  const agent = agents.find((a) => a.id === sel.agentId) || agents[0]
  const models = agent?.capabilities.modelSelect ? (agent.models || []) : []
  const model = resolveAgentModel(agent, sel.model)
  const efforts: ReasoningEffort[] = agent?.capabilities.reasoningEffort
    ? model?.efforts || []
    : []
  const opt = (v: string, label: string): object => ({ text: { tag: 'plain_text', content: clip(label, 120) }, value: v })
  const elements: object[] = []

  elements.push({ tag: 'markdown', content: '**项目**' })
  elements.push({
    tag: 'select_static', name: 'projectId', initial_option: selectedProjectId,
    placeholder: { tag: 'plain_text', content: '选择项目' },
    options: projectOptions.map((project) => opt(
      project.id,
      `${project.name} · ${project.primaryDirectory}${project.additionalDirectories.length ? ` +${project.additionalDirectories.length}` : ''}`
    )),
    behaviors: [{ type: 'callback', value: { topicId, act: 'setProject' } }]
  })

  elements.push({ tag: 'markdown', content: '**需求（可选）**' })
  elements.push({
    tag: 'select_static', name: 'requirementId', initial_option: sel.requirementId || '__none__',
    placeholder: { tag: 'plain_text', content: '不关联需求' },
    options: [opt('__none__', '不关联需求'), ...requirements.map((requirement) => opt(requirement.id, requirement.name))],
    behaviors: [{ type: 'callback', value: { topicId, act: 'setRequirement' } }]
  })

  elements.push({ tag: 'markdown', content: '**执行方**' })
  elements.push({
    tag: 'select_static', name: 'executor', initial_option: sel.executor || 'agent',
    placeholder: { tag: 'plain_text', content: '选择执行方' },
    options: [opt('agent', '单 Agent'), opt('team', '专家团')],
    behaviors: [{ type: 'callback', value: { topicId, act: 'setExecutor' } }]
  })

  if (sel.executor === 'team') {
    elements.push({ tag: 'markdown', content: '**专家团**' })
    if (teams.length) {
      elements.push({
        tag: 'select_static', name: 'teamId', initial_option: teams.some((team) => team.id === sel.teamId) ? sel.teamId : teams[0]?.id,
        placeholder: { tag: 'plain_text', content: '选择专家团' },
        options: teams.map((team) => opt(team.id, team.name)),
        behaviors: [{ type: 'callback', value: { topicId, act: 'setTeam' } }]
      })
    } else elements.push({ tag: 'markdown', content: '暂无可用专家团，请先在 UniAgent 中启用专家团。' })
  } else {
    elements.push({ tag: 'markdown', content: '**Agent**' })
    elements.push({
      tag: 'select_static', name: 'agentId', initial_option: agent?.id,
      placeholder: { tag: 'plain_text', content: '选择 Agent' },
      options: agents.map((a) => opt(a.id, a.name)),
      behaviors: [{ type: 'callback', value: { topicId, act: 'agentChange' } }]
    })

    if (models.length) {
      elements.push({ tag: 'markdown', content: '**模型**' })
      elements.push({
        tag: 'select_static', name: 'model', initial_option: model?.id,
        placeholder: { tag: 'plain_text', content: '选择模型' },
        options: models.map((m) => opt(m.id, m.label)),
        behaviors: [{ type: 'callback', value: { topicId, act: 'setModel' } }]
      })
    }

    if (efforts.length) {
      elements.push({ tag: 'markdown', content: '**推理强度**' })
      elements.push({
        tag: 'select_static', name: 'effort', initial_option: resolveModelEffort(model, sel.effort),
        placeholder: { tag: 'plain_text', content: '选择推理强度' },
        options: efforts.map((e) => opt(e, EFFORT_LABEL[e] || e)),
        behaviors: [{ type: 'callback', value: { topicId, act: 'setEffort' } }]
      })
    }
  }

  elements.push({
    tag: 'button', text: { tag: 'plain_text', content: '开始' }, type: 'primary',
    disabled: sel.executor === 'team' && !teams.length,
    behaviors: [{ type: 'callback', value: { topicId, act: 'startTopic' } }]
  })

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '🚀 新会话配置' } },
    body: { elements }
  }
}

/** Strip the `@_user_N` / `@_all` placeholders a group @-mention injects. */
export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').replace(/@_all/g, '').trim()
}

/** 需求3 — map a form_value callback (`f0`/`o0`…) back onto the collected shape
 *  encodeAnswer expects. Single select returns a string, multi returns a string[]. */
export function collectFormValue(
  fields: NormalizedField[],
  formValue: Record<string, unknown>
): Record<string, { choice: string[]; text: string; other: string }> {
  const collected: Record<string, { choice: string[]; text: string; other: string }> = {}
  fields.forEach((f, i) => {
    const raw = formValue[`f${i}`]
    const other = formValue[`o${i}`] == null ? '' : String(formValue[`o${i}`])
    if (f.type === 'text') {
      collected[f.id] = { choice: [], text: raw == null ? '' : String(raw), other: '' }
    } else if (f.type === 'multi') {
      const choice = Array.isArray(raw) ? raw.map(String) : raw == null || raw === '' ? [] : [String(raw)]
      collected[f.id] = { choice, text: '', other }
    } else {
      const choice = raw == null || raw === '' ? [] : [String(raw)]
      collected[f.id] = { choice, text: '', other }
    }
  })
  return collected
}

function questionAnswerDetail(
  fields: NormalizedField[],
  submittedAnswer: unknown,
  kind: string
): string {
  const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]~]/g, '\\$&')
  return fields.map((field, index) => {
    const question = [field.title, field.prompt].filter((text, i, all) => text && all.indexOf(text) === i).join('\n')
    const values = questionAnswerValues(kind, field, submittedAnswer)
    const answer = values.length ? field.secret ? '已隐藏' : values.join('、') : '未填写'
    return `**${index + 1}. ${escape(question)}**${field.detail ? `\n\n${field.detail}` : ''}\n${field.type === 'text' ? '回答' : '已选答案'}：${escape(answer)}`
  }).join('\n\n')
}

function noteCard(title: string, body: string): object {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: clip(body) } }]
  }
}

/** A resolved card: no buttons/selects, just a locked summary of what was chosen.
 *  Replaces the interactive card in place so it can no longer be clicked again.
 *  A JSON-2.0 interactive card (question/topic) can only be replaced by another
 *  2.0 card, so `v2` emits the 2.0 shape; the v1 approval card keeps the v1 shape. */
function resolvedCard(label: string, detail?: string, v2 = false): object {
  const content = detail || `已处理：**${label}**`
  if (v2) {
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: { template: 'grey', title: { tag: 'plain_text', content: '✅ ' + label } },
      body: { elements: [{ tag: 'markdown', content }] }
    }
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: '✅ ' + label } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }]
  }
}

function progressCardStatus(session: Session, progress: ProgressCardState): string {
  const final = progress.final
  return final
    ? final.success ? '已完成' : final.event.state === 'cancelled' ? '已中断' : '执行未完成'
    : progress.interruptRequested || session.status === 'cancelling' ? '正在中断'
      : progress.teamWaiting ? '等待团队推进' : progress.status === 'waiting' ? '等待你的确认'
        : progress.lastEventType === 'reasoning' ? '思考中' : '执行中'
}

function progressCard(session: Session, progress: ProgressCardState): object {
  const final = progress.final
  const stopping = !!progress.interruptRequested || session.status === 'cancelling'
  const status = progressCardStatus(session, progress)
  const effort = session.config.agentId === 'kimi' ? session.config.kimiThinking
    : session.config.agentId === 'zcode' ? session.config.zcodeModelSelection?.options?.reasoningLevel : session.config.effort
  const depth = effort ? effort === 'off' ? '关闭' : EFFORT_LABEL[effort] || effort : undefined
  const details = [session.config.agentId, session.config.model || session.config.zcodeModelSelection?.modelId, depth].filter(Boolean).join(' · ')
  const color = final ? final.success ? 'green' : final.event.state === 'cancelled' ? 'grey' : 'red'
    : stopping || progress.status === 'waiting' || progress.teamWaiting ? 'orange' : 'blue'
  const content = progressStreamText(progress)
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'compact',
      streaming_mode: !final && !progress.streamingClosed,
      summary: { content: final ? `${status}，可展开查看执行过程。` : `${status}…` },
      ...(!final && !progress.streamingClosed ? {
        streaming_config: {
          print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast'
        }
      } : {})
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', margin: '0px',
          columns: [
            {
              tag: 'column', width: 'auto', vertical_align: 'center', padding: '0px',
              elements: [{
                tag: 'markdown', content: `<font color='${color}'>●</font> **${status}**`
              }]
            },
            {
              tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', padding: '0px',
              elements: [{
                tag: 'div',
                text: {
                  tag: 'plain_text', text_size: 'notation', text_color: 'grey', text_align: final ? 'right' : 'left',
                  content: formatElapsed((final?.endedAt ?? Date.now()) - progress.startedAt)
                }
              }]
            },
            ...(!final ? [{
              tag: 'column', width: 'auto', vertical_align: 'center', padding: '0px',
              elements: [{
                tag: 'button', type: 'danger', size: 'tiny', margin: '0px',
                text: { tag: 'plain_text', content: stopping ? '中断中' : '中断对话' },
                disabled: stopping,
                behaviors: [{ type: 'callback', value: { act: 'interruptSession', sessionId: session.id, progressId: progress.replyUuid } }]
              }]
            }] : [])
          ]
        },
        { tag: 'div', text: { tag: 'plain_text', content: details, text_size: 'notation', text_color: 'grey' } },
        {
          tag: 'div', element_id: 'progress_preview',
          text: { tag: 'lark_md', content: final?.success ? '本轮处理已完成。' : final?.replySkipped ? final.result : content.latest, lines: 16 }
        },
        {
          tag: 'collapsible_panel', expanded: false, padding: '8px 0px 0px 0px',
          header: {
            title: { tag: 'markdown', content: `<font color='grey'>${content.count ? `思考记录 · ${content.count}条` : '执行详情'}</font>` },
            padding: '0px 0px 0px 0px',
            icon: { tag: 'standard_icon', token: 'right-small-ccm_outlined', color: 'grey', size: '14px 14px' },
            icon_position: 'left', icon_expanded_angle: 90
          },
          vertical_spacing: '8px',
          elements: [
            { tag: 'markdown', element_id: 'progress_stream', content: content.history }
          ]
        }
      ]
    }
  }
}

/** Keep the latest段 visible and the ordered history within Feishu's text limit. */
function progressStreamText(progress: ProgressCardState): { latest: string; history: string; count: number } {
  const segments = [...progress.segments]
    .filter(([id, text]) => text && !(progress.final && id.startsWith('agent_message:') && text === clip(progress.final.result.trim(), 4000)))
    .map(([, text]) => sanitizeProgressMarkdown(text))
  if (!segments.length) {
    const text = progress.final ? '本轮没有额外的过程记录。' : 'Agent 正在处理任务…'
    return { latest: text, history: text, count: 0 }
  }
  const MAX = 28000
  const kept: string[] = []
  let total = 0
  let elided = false
  for (let i = segments.length - 1; i >= 0; i--) {
    const piece = segments[i]
    if (total + piece.length > MAX && kept.length) { elided = true; break }
    kept.unshift(piece)
    total += piece.length
  }
  const body = kept.join('\n\n---\n\n')
  return { latest: segments.at(-1)!, history: elided ? `_（更早内容已省略）_\n\n${body}` : body, count: kept.length }
}

/** CardKit treats Markdown image destinations as Feishu image keys. Progress
 *  cards never upload media, so keep the image label and omit every destination
 *  instead of leaking a local path or sending an invalid image_key. */
function sanitizeProgressMarkdown(text: string): string {
  return text.replace(/!\[([^\]\r\n]*)\]\(\s*(?:<[^>\r\n]*>|[^)\r\n]*)\s*\)/g, (_image, alt: string) =>
    `🖼️ ${alt.trim() || '图片'}`)
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function approvalDetailText(kind: string, params: any): string {
  if (kind === 'planMode') return String(params?.plan || params?.text || '实施此计划？')
  if (kind === 'mcpTool') {
    const detail = mcpToolApprovalDetail(params)
    const parameters = detail.parameters.map(({ name, value }) =>
      `- **${name}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    return [
      `允许 **${detail.serverName}** 运行 **${detail.toolName}**？`,
      detail.description,
      parameters.length ? `参数：\n${parameters.join('\n')}` : ''
    ].filter(Boolean).join('\n\n')
  }
  if (kind === 'command') {
    const cmd = params?.command || params?.commandLine || (Array.isArray(params?.argv) ? params.argv.join(' ') : '')
    const cwd = params?.cwd || params?.workdir || params?.rawInput?.cwd
    const head = cmd ? '将执行命令：\n```\n' + cmd + '\n```' : '请求执行命令。'
    return cwd ? `${head}\n工作目录：\`${cwd}\`` : head
  }
  if (kind === 'fileChange') {
    const changes = params?.changes || params?.fileChanges
    const list = Array.isArray(changes)
      ? changes
      : changes && typeof changes === 'object'
        ? Object.entries<any>(changes).map(([path, c]) => ({ path, kind: c?.type || c?.kind }))
        : []
    if (list.length) {
      const lines = list.map((c: any) => {
        const path = typeof c === 'string' ? c : c?.path || ''
        const changeKind = typeof c === 'string' ? '' : c?.kind
        return `- ${changeKindLabel(changeKind)}${path}`
      })
      return `将修改 **${list.length}** 个文件：\n${lines.join('\n')}`
    }
    return '请求修改文件。'
  }
  if (kind === 'permissions') {
    return params?.reason ? String(params.reason) : '请求授予权限。'
  }
  return '需要你的确认。'
}

/** File-change kind → a short Chinese label prefix ("新增/删除/修改 ") for the card. */
function changeKindLabel(kind: unknown): string {
  const value = typeof kind === 'string' ? kind : (kind as any)?.type
  switch (String(value || '').toLowerCase()) {
    case 'add': case 'create': case 'added': return '新增 '
    case 'delete': case 'remove': case 'deleted': return '删除 '
    case 'rename': case 'move': return '重命名 '
    case 'update': case 'modify': case 'modified': case 'edit': return '修改 '
    default: return ''
  }
}

/** Extract user text from a Feishu message content JSON. */
export function extractText(content: string, messageType: string): string {
  return extractMessageContent(content, messageType).text
}

function extractMessageContent(content: string, messageType: string): { text: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content)
    if (messageType === 'text') return { text: typeof parsed?.text === 'string' ? parsed.text.trim() : '', imageKeys: [] }
    if (messageType === 'image') {
      return { text: '', imageKeys: typeof parsed?.image_key === 'string' ? [parsed.image_key] : [] }
    }
    if (messageType === 'post' && Array.isArray(parsed?.content)) {
      const parts: string[] = typeof parsed.title === 'string' && parsed.title.trim() ? [parsed.title.trim()] : []
      const imageKeys: string[] = []
      for (const line of parsed.content) {
        if (!Array.isArray(line)) continue
        const lineText: string[] = []
        for (const run of line) {
          if (typeof run?.text === 'string') lineText.push(run.text)
          if (typeof run?.image_key === 'string') imageKeys.push(run.image_key)
        }
        if (lineText.length) parts.push(lineText.join(''))
      }
      return { text: parts.join('\n').trim(), imageKeys }
    }
  } catch { /* not JSON */ }
  return { text: '', imageKeys: [] }
}

function responseHeader(headers: any, name: string): string | undefined {
  const value = typeof headers?.get === 'function'
    ? headers.get(name)
    : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : undefined
}

let feishuHttpConfigured = false

async function withFeishuDeadline<T>(operation: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${operation} timeout`), { code: 'ETIMEDOUT' })), FEISHU_REQUEST_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function configureFeishuHttp(): void {
  if (feishuHttpConfigured) return
  defaultHttpInstance.defaults.timeout = FEISHU_REQUEST_TIMEOUT_MS
  defaultHttpInstance.interceptors.response.use((response) => {
    // The SDK's earlier interceptor unwraps Axios responses to their body.
    const body = response as { code?: number; msg?: string; request_id?: string; error?: { log_id?: string } }
    if (body && typeof body === 'object' && typeof body.code === 'number' && body.code !== 0) {
      throw new FeishuBusinessError(
        body.code,
        typeof body.msg === 'string' ? body.msg : undefined,
        firstString(body.request_id, body.error?.log_id)
      )
    }
    return response
  })
  feishuHttpConfigured = true
}

class FeishuBusinessError extends Error {
  readonly code: number
  readonly feishuMessage?: string
  readonly requestId?: string

  constructor(code: number, message?: string, requestId?: string) {
    super(`飞书接口返回业务错误 ${code}${message ? `：${message}` : ''}`)
    this.name = 'FeishuBusinessError'
    this.code = code
    this.feishuMessage = message
    this.requestId = requestId
  }
}

function feishuErrorDetails(error: unknown): Record<string, unknown> {
  const candidate = error && typeof error === 'object'
    ? error as Record<string, any>
    : {}
  const response = candidate.response && typeof candidate.response === 'object'
    ? candidate.response as Record<string, any>
    : undefined
  const body = response?.data && typeof response.data === 'object'
    ? response.data as Record<string, any>
    : undefined
  const errorCode = candidate.code
  const timedOut = errorCode === 'ECONNABORTED' || errorCode === 'ETIMEDOUT' ||
    /timeout/i.test(typeof candidate.message === 'string' ? candidate.message : '')
  const feishuCode = error instanceof FeishuBusinessError
    ? error.code
    : typeof body?.code === 'number' ? body.code : undefined
  const feishuMessage = error instanceof FeishuBusinessError
    ? error.feishuMessage
    : typeof body?.msg === 'string' ? body.msg : undefined
  const requestId = firstString(
    error instanceof FeishuBusinessError ? error.requestId : undefined,
    body?.request_id,
    headerValue(response?.headers, 'x-tt-logid'),
    headerValue(response?.headers, 'x-request-id')
  )
  return compactRecord({
    failureKind: error instanceof FeishuBusinessError
      ? 'business'
      : timedOut
        ? 'timeout'
        : response
          ? 'http'
          : typeof errorCode === 'string'
            ? 'network'
            : 'application',
    timeoutMs: FEISHU_REQUEST_TIMEOUT_MS,
    errorName: typeof candidate.name === 'string' ? candidate.name : undefined,
    errorCode: typeof errorCode === 'string' || typeof errorCode === 'number' ? errorCode : undefined,
    errorStack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
    httpStatus: typeof response?.status === 'number' ? response.status : undefined,
    feishuCode,
    feishuMessage,
    requestId
  })
}

function headerValue(headers: any, name: string): string | undefined {
  const value = typeof headers?.get === 'function'
    ? headers.get(name)
    : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

/** Feishu single message text cap is generous; clip to keep cards readable. */
function clip(text: string, max = 3500): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function safeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return '连接失败'
}
