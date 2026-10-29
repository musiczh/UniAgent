import { TeamSessionContext, TeamDecisionMaterials, TeamArtifacts } from './TeamSessionExtras'
import { teamDeliveryContent } from '../teamDelivery'
import { teamWaitingAssignments } from '../teamTimeline'
import { TeamAssignmentDisplayContext, teamAssignmentCardForText } from './TeamAssignmentCard'
import { TeamEventCard } from './TeamEventCard'
import { parseTeamEventPrompt } from '@shared/teamEventPrompt'
import { coalesceUsageSnapshots, withCompactionTiming } from '@shared/eventSnapshots'
import { isTaskTurnInput, tokenSpeedForTurn } from '@shared/tokenSpeed'
import { createContext, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './interactionRequests.css'
import type { ReactNode, RefObject } from 'react'
import type { TeamAssignment, TeamProject } from '@shared/teamTypes'
import { ASYNC_QUESTION_PREFIX, asInteractionRequest, asyncQuestionReply, interactionRequestKey, isPendingInteraction, isSkippedQuestionAnswer, localPlanRequest, planFeedbackInAnswer, withPlanText } from '@shared/interactionRequests'
import type { HistoryForkPoint } from '@shared/types'
import type { Attachment, PlanStep, QueueStatus, ResolvedNativeTurnContext, TurnArtifactSummary, UASubAgent, UAEvent } from '@shared/types'
import { isSessionBusy, sessionActivityStatus, type SessionActivityStatus } from '@shared/sessionStatus'
import { handoffResultText, handoffTaskAction, handoffTaskIdFromResult, isHandoffEndEvent } from '@shared/handoffEvents'
import { Markdown } from './Markdown'
import { formatClaudeNativeReport } from '@shared/claudeNativeReports'
import { HtmlPreviewSessionContext } from './HtmlPreview'
import { ImageLightbox } from './ImageLightbox'
import { ViewImageThumbnail } from './ViewImageThumbnail'
import { NativeImageThumbnail } from './NativeImageThumbnail'
import { adoptToolResultImages, nativeImageName, nativeImageSelectors, viewImagePath } from '@shared/viewImage'
import { formatMessageFullTime, formatMessageTime } from './ImmersiveReader'
import { captureSelection, type Annotation, type CapturedSelection } from '../textAnnotations'
import { Chevron, UiIcon } from './Icons'
import { ModelSwitchCard } from './ModelSwitchCard'
import { SentCapabilityChips } from './SkillChips'
import { cacheAttachmentPreview, getCachedAttachmentPreview } from '../hooks'
import { fileDiffsFromSummary, parseUnifiedDiff, totalStat, type FileDiff } from './diffModel'
import { SubAgentIcon } from './SubAgentIcon'
import {
  isSubAgentGenerationAdvance,
  isSubAgentTerminal,
  mergeSubAgentSnapshot,
  subAgentDisplayName,
  subAgentTaskSummary,
} from '@shared/subAgentLifecycle'
import { isVisibleDetailEvent } from '@shared/detailQuickChat'
import { isConversationHint, isHiddenAgentWarning } from '@shared/agentWarnings'
import { providerContextLimit } from '@shared/providerErrors'
import { splitFeishuContext } from '@shared/feishuContext'
import { splitWeixinContext } from '@shared/weixin'
import {
  reconcileChainOpenState,
  toggleChainOpen,
  type ChainOpenState,
} from '../chainOpenController'
// 需求3 — question parsing/encoding is shared with the Feishu bridge (main process),
// so it lives in a pure module. Re-exported below to keep existing importers stable.
import {
  normalizeQuestions,
  questionAnswerValues,
  questionAnswerKind,
  validateQuestionAnswer,
  encodeAnswer,
  isMcpToolApproval,
  mcpToolApprovalAnswer,
  mcpToolApprovalDetail,
  mcpToolApprovalScopes,
  OTHER_VALUE,
  type NormalizedField,
} from '@shared/questions'
export { normalizeQuestions, encodeAnswer } from '@shared/questions'
export type { NormalizedField } from '@shared/questions'

const RequestPresentationContext = createContext<{
  docked: boolean
  locateSeq: number | null
  select: (event: UAEvent) => void
  asyncReplies: Map<number, UAEvent>
  onOpenFile?: (path: string, line?: number) => void
}>({ docked: false, locateSeq: null, select: () => {}, asyncReplies: new Map() })


// 选中即评论 — actions a text selection inside an agent reply can trigger. The
// MAIN chat provides these; the side-chat drawer and 详情 popover render the same
// <EventStream> WITHOUT them, so selection annotation is main-chat only.
export interface SelectionActions {
  onSideComment?: (selection: import('@shared/comments').CommentSelection) => void
  /** all annotations for the active session, so replies can re-highlight ranges */
  annotations: Annotation[]
  /** 评论 — persist an annotation; it is pinned to the composer's 待评论托盘 */
  onComment: (a: { seq: number; start: number; end: number; quote: string; comment: string }) => void
  /** 编辑评论 — locate its persistent highlight and reopen the comment box. */
  editRequest?: { annotation: Annotation; nonce: number }
  onEditComment: (id: string) => void
  onUpdateComment: (id: string, comment: string) => void
  onRemoveComment: (id: string) => void
  onEditRequestHandled: (nonce: number) => void
  /** 详情 — open the floating fork popover explaining this selection */
  onDetail?: (a: { seq: number; start: number; end: number; quote: string; selectedMessageText: string }) => void
  /** 侧边聊天 — pin this selection to the side drawer's 待评论托盘 and open it */
  onSide?: (a: { seq: number; start: number; end: number; quote: string }) => void
}

interface HistoryForkActions {
  agentName: string
  points: HistoryForkPoint[]
  busy: boolean
  onFork: (point: HistoryForkPoint) => void
}

const HistoryForkContext = createContext<HistoryForkActions | undefined>(undefined)
const ImmersiveReaderContext = createContext<((event: UAEvent) => void) | undefined>(undefined)

function MessageActions({
  event,
  kind,
  text,
  onRewind,
  suffix,
  readable = false,
  hooks,
}: {
  event: UAEvent
  kind: 'agent' | 'user'
  text?: string
  onRewind?: () => void
  suffix?: JSX.Element
  readable?: boolean
  hooks?: UAEvent[]
}): JSX.Element {
  const historyFork = useContext(HistoryForkContext)
  const onOpenReader = useContext(ImmersiveReaderContext)
  const [copied, setCopied] = useState(false)
  const [hooksOpen, setHooksOpen] = useState(false)
  const hooksId = useId()
  const copiedTimer = useRef<number | null>(null)
  const forkPoint = kind === 'agent'
    ? historyFork?.points.find((point) => point.eventSeq === event.seq)
    : undefined

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Leave the copy affordance unchanged so a permission failure is retryable.
    }
  }

  return (
    <>
      <div className={`message-actions ${kind}${hooksOpen && hooks?.length ? ' hooks-open' : ''}`} role="group" aria-label="消息操作">
        {text !== undefined && <button
          className={`message-action copy${copied ? ' copied' : ''}`}
          title={copied ? '已复制' : '复制消息'}
          aria-label={copied ? '已复制' : '复制消息'}
          onClick={() => void copy()}
        >
          <UiIcon name={copied ? 'check' : 'copy'} size={15} />
        </button>}
        {kind === 'agent' && readable && onOpenReader && (
          <button className="message-action" title="沉浸阅读" aria-label="沉浸阅读" onClick={() => onOpenReader(event)}>
            <UiIcon name="book-open" size={16} />
          </button>
        )}
        {kind === 'agent' && historyFork && forkPoint && (
          <button
            className="message-action"
            disabled={historyFork.busy}
            title={forkPoint.kind === 'after-turn'
              ? '从本轮结束分叉新会话'
              : '从此回复分叉新会话'}
            aria-label="从此位置分叉新会话"
            onClick={() => historyFork.onFork(forkPoint)}
          >
            <UiIcon name="fork" size={15} />
          </button>
        )}
        {kind === 'user' && onRewind && (
          <button
            className="message-action"
            title="回退到本轮对话发起前"
            aria-label="回退到本轮对话发起前"
            onClick={onRewind}
          >
            <UiIcon name="rewind" size={15} />
          </button>
        )}
        {!!hooks?.length && (
          <button
            className="message-action"
            title={`${hooksOpen ? '收起' : '查看'}本轮 Hook（${hooks.length} 个）`}
            aria-label={`查看本轮 Hook（${hooks.length} 个）`}
            aria-expanded={hooksOpen}
            aria-controls={hooksId}
            onClick={() => setHooksOpen(!hooksOpen)}
          >
            <UiIcon name="zap" size={15} />
          </button>
        )}
        <time
          className="message-time"
          dateTime={Number.isFinite(event.ts) && event.ts > 0 ? new Date(event.ts).toISOString() : undefined}
          title={formatMessageFullTime(event.ts)}
        >
          {formatMessageTime(event.ts)}
        </time>
        {suffix}
      </div>
      {hooksOpen && !!hooks?.length && <TurnHooks id={hooksId} events={hooks} />}
    </>
  )
}

// Provided by EventStream so nested ReplyBlocks can re-highlight their own
// annotation ranges without prop-threading through every caller. Deletion lives
// in the composer's 待评论托盘 now, so the context only carries the highlight map.
const AnnotationContext = createContext<{
  annotationsBySeq: Map<number, Annotation[]>
  onEditAnnotation?: (id: string) => void
}>({ annotationsBySeq: new Map() })

/**
 * 子 Agent v3 — a sub-agent lifecycle transition rendered as ONE inline row in
 * the main stream (复刻 codex). Each row is a phase change for one (or several
 * same-instant) child agents; "spawn" reads "开始工作" WITHOUT a spinner.
 */
// A parent sendInput/interacted event is rendered as one standalone 追加提问 row;
// it does not advance or interrupt the child's lifecycle generation.
type SubPhase = 'spawn' | 'append' | 'done' | 'interrupted' | 'error'
type SubLineAgent = { threadId: string; name?: string; prompt?: string; dispatchId?: string }

/** Fix#4 — set on the CALLER session while its turn blocks (wait=true) on an
 * outbound handoff; also used by the inline 交接任务 row to resolve a jump target. */
type WaitingForHandoff = {
  handoffId: string
  awaitedSessionId: string
  agentId: string
  agentName: string
  label: string
}

export interface HandoffSessionTarget {
  sessionId: string
  roleName?: string
  agentName?: string
}

const HandoffSessionTargetsContext = createContext<Record<string, HandoffSessionTarget>>({})
const HandoffTaskEndsContext = createContext<Record<string, UAEvent>>({})

type HandoffMilestone = 'start' | 'delivered' | 'force-delivered' | 'terminal'

type Segment =
  | { kind: 'chain'; id: string; events: UAEvent[] }
  | { kind: 'reply'; id: string; event: UAEvent }
  | { kind: 'user_append'; id: string; event: UAEvent }
  | { kind: 'image'; id: string; event: UAEvent }
  /** 提问 / 审批卡片 — 独立于链路的顶层分段（见 groupTurns）。 */
  | { kind: 'approval'; id: string; event: UAEvent }
  /** Non-interactive notices keep their first-seen position in the process. */
  | { kind: 'hint' | 'notice' | 'runtime'; id: string; event: UAEvent }
  /** Codex 跨来源模型切换的进度卡片，按 payload.id 原地合并。 */
  | { kind: 'model_switch'; id: string; event: UAEvent }
  | { kind: 'queue_wait'; id: string; event: UAEvent; view: QueueView }
  /** A confirmed task/message milestone. MCP acceptance and polling stay folded. */
  | { kind: 'handoff'; id: string; event: UAEvent; milestone: HandoffMilestone; taskId: string }
  /** A member delivery in the continuous team process. */
  | { kind: 'team_delivery'; id: string; event: UAEvent; assignmentId: string; attempt: number; summary: string; deliveryKind: string }
  | { kind: 'team_wait' | 'team_dispatch'; id: string; event: UAEvent }
  | { kind: 'team_event'; id: string; event: UAEvent }
  | {
      kind: 'subagent'
      id: string
      phase: SubPhase
      agents: SubLineAgent[]
      ts: number
    }

type Turn = {
  id: string
  user: UAEvent | null
  events: UAEvent[]
  segments: Segment[]
  footers: UAEvent[]
  hints: UAEvent[]
  /** Doc4 — the latest plan snapshot for this turn (plan_update), if any. */
  plan: UAEvent | null
  /** Native Plan-mode Markdown body, emitted as a tagged agent_message. */
  planMessage: UAEvent | null
  /** TraeX waits on this protocol request before it can leave Plan mode. */
  planModeRequest: UAEvent | null
  done: boolean
  startTs: number
  endTs: number
  /** 需求一 — the provider's native turn id (turn_started/turn_completed payload),
   * when the runner reports it. Enables opening review scoped to just this turn. */
  nativeTurnId?: string
  /** The first native turn stays attached to the original bubble for rewind. */
  rewindTurnId?: string
  /** 需求一 — this turn's aggregated unified diff (latest diff_update), kept so the
   * turn can render a change card + open a turn-scoped review. Empty = no changes. */
  diff?: string
  queueView: QueueView | null
  /** One entry per native queue wait id; later wake-ups in the same visual turn keep their own node. */
  queueViews: QueueWaitView[]
  /** Event boundary captured at the first real completion notification. */
  completionSeq: number | null
  /** First provider-marked final answer; later replies are supplements. */
  finalReplySeq: number | null
}

type SubmittedApproval = {
  answer: unknown
  payload: Record<string, any>
}

export function toolCallTitle(payload: { provider?: string; server?: string; name?: string }): string {
  if (payload.provider === 'mcp') {
    return `MCP · ${payload.server || '?'} · ${payload.name || '?'}`
  }
  return `工具调用: ${payload.name || '?'}`
}

export function toolCallDetail(
  payload: { input?: unknown; result?: unknown; error?: unknown; raw?: unknown },
  state?: UAEvent['state']
): unknown {
  if (state !== 'running') {
    if (payload.error != null) return payload.error
    if (payload.result != null) return payload.result
  }
  return payload.input ?? payload.raw
}

function isGeneratedImageEvent(event: UAEvent): boolean {
  return event.type === 'tool_call' && event.payload?.name === 'image_generation'
}

/** A request id may be reused; seq identifies this concrete timeline event. */
export function approvalEventIdentity(event: UAEvent): string {
  return `${event.sessionId}:${event.seq}`
}

export function mergeOptimisticApprovalAnswers(
  events: UAEvent[],
  submitted: Record<string, SubmittedApproval>,
): UAEvent[] {
  return events.map((event) => {
    if (event.type !== 'approval_request') return event
    const saved = submitted[approvalEventIdentity(event)]
    if (!saved) return event
    return {
      ...event,
      state: event.state === 'pending' && event.payload.submittedAnswer === undefined ? 'success' : event.state,
      payload: {
        ...saved.payload,
        ...event.payload,
        submittedAnswer:
          event.payload.submittedAnswer === undefined
            ? saved.answer
            : event.payload.submittedAnswer,
      },
    }
  })
}

/**
 * 修复#5 — the "Ignoring malformed agent role definition: duplicate agent role
 * name …" notice is pure config-loader de-dup noise; drop it from the timeline
 * even if a restored rollout still carries the old system_notice.
 */
function isIgnorableNotice(text?: unknown): boolean {
  if (typeof text !== 'string') return false
  return isHiddenAgentWarning(text) || /Ignoring malformed agent role definition|duplicate agent role name/i.test(
    text,
  )
}

/** Map a sub-agent's terminal status to its inline phase. */
function subTerminalPhase(status: string): SubPhase {
  if (status === 'interrupted') return 'interrupted'
  if (status === 'errored') return 'error'
  return 'done'
}

type ChainOpenController = {
  state: ChainOpenState
  toggle: (id: string) => void
}

const CHAIN_TYPES = new Set([
  'reasoning',
  'command_exec',
  'tool_call',
  'hook',
  'background_task',
  'file_change',
  'approval_request',
  'context_compaction',
  'raw_output',
])

/**
 * Group a flat ordered event list into per-turn buckets. Within a turn, chain
 * events (reasoning/commands/tools/…) and replies are kept in their real order
 * as a list of segments, so multiple replies interleave with their own chain
 * blocks (à la Codex) instead of being merged into one bucket.
 */
function groupTurns(events: UAEvent[], activeWaitingHandoffId = '', teamProject?: TeamProject, status?: string): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null
  let teamRunId: number | undefined
  // 子 Agent v3 — track each child's last-seen phase across the WHOLE session so
  // a `subagent` snapshot only emits an inline row when the child's phase truly
  // advances (spawn → done/…), never once per redundant token tick.
  const lastPhase = new Map<string, { phase: SubPhase; generation?: number }>()
  const seenSubAgentInteractions = new Set<string>()
  const subAgentState = new Map<string, UASubAgent>()
  const seenHandoffMilestones = new Set<string>()
  const handoffEndIds = new Set(events.filter(isHandoffEndEvent).map(event => event.payload.taskId))
  // 有切换卡片时，跨来源切换附带的压缩事件折叠进卡片步骤，不再单独占一行；
  // 旧格式历史（没有卡片事件）保持原有渲染。
  const hasModelSwitchCard = events.some(event => event.type === 'model_switch')

  const startCur = (ev: UAEvent): Turn => {
    teamRunId = undefined
    cur = {
      // Compaction terminal snapshots change seq; keep the expanded step mounted.
      id: (ev.type === 'context_compaction' || ev.type === 'model_switch') && ev.payload?.id
        ? `turn-${ev.type === 'model_switch' ? 'mswitch' : 'compaction'}-${turns.at(-1)?.id ?? 'initial'}:${ev.payload.id}`
        : `turn-${ev.payload?.clientTurnKey ?? ev.seq}`,
      user: null,
      events: [],
      segments: [],
      footers: [],
      hints: [],
      plan: null,
      planMessage: null,
      planModeRequest: null,
      done: false,
      startTs: ev.ts,
      endTs: ev.ts,
      queueView: null,
      queueViews: [],
      completionSeq: null,
      finalReplySeq: null,
    }
    turns.push(cur)
    return cur
  }
  const ensure = (ev: UAEvent): Turn => cur || startCur(ev)
  const pushChain = (t: Turn, ev: UAEvent): void => {
    const last = t.segments[t.segments.length - 1]
    if (last?.kind === 'team_wait' && ev.type !== 'queue_status' && isPassiveChainEvent(ev)) {
      const previous = t.segments.findLast((segment) => segment.kind === 'chain')
      if (previous?.kind === 'chain') previous.events.push(ev)
      else t.segments.splice(t.segments.length - 1, 0, {
        kind: 'chain', id: `chain-${ev.payload?.id ?? ev.seq}`, events: [ev],
      })
      return
    }
    if (last && last.kind === 'chain') last.events.push(ev)
    // Key a chain off its first event's *stable* identity (payload.id survives
    // streaming re-emits; seq does not) so the block isn't remounted per delta.
    else
      t.segments.push({
        kind: 'chain',
        id: `chain-${ev.payload?.id ?? ev.seq}`,
        events: [ev],
      })
  }
  // 子 Agent v3 — append a sub-agent phase row, merging into the previous row when
  // it is the SAME phase and lands within 1s (adjacent multi-agent spawns collapse
  // to one line, matching the mockup's "同刻合并").
  const pushSub = (
    t: Turn,
    phase: SubPhase,
    agent: SubLineAgent,
    ev: UAEvent,
  ): void => {
    const last = t.segments[t.segments.length - 1]
    if (
      last &&
      last.kind === 'subagent' &&
      last.phase === phase &&
      ev.ts - last.ts < 1000 &&
      !last.agents.some((a) => a.threadId === agent.threadId)
    ) {
      last.agents.push(agent)
      last.ts = ev.ts
      return
    }
    t.segments.push({
      kind: 'subagent',
      id: `sub-${phase}-${agent.threadId}-${ev.seq}`,
      phase,
      agents: [agent],
      ts: ev.ts,
    })
  }

  for (const ev of events) {
    if (ev.type === 'goal_message') {
      const t = startCur(ev)
      t.user = ev
      t.events.push(ev)
      continue
    }
    if (ev.type === 'user_message') {
      if (ev.payload?.appendedToTurn === true && turns.at(-1)?.done === false) {
        const t = ensure(ev)
        t.done = false
        t.completionSeq = null
        t.finalReplySeq = null
        t.plan = null
        t.planMessage = null
        t.planModeRequest = null
        t.endTs = Math.max(t.endTs, ev.ts)
        t.events.push(ev)
        t.segments.push({
          kind: 'user_append',
          id: `user-append-${ev.payload?.id ?? ev.seq}`,
          event: ev,
        })
        continue
      }
      const t = startCur(ev)
      t.user = ev
      t.events.push(ev)
      continue
    }
    if (ev.type === 'system_notice' && ev.payload?.kind === 'team_wakeup') {
      const continued = !!teamProject && !!cur && (teamRunId === undefined || teamRunId === ev.payload.teamRunId)
      const t = continued ? ensure(ev) : startCur(ev)
      teamRunId = ev.payload.teamRunId
      if (continued) { t.done = false; t.completionSeq = null; t.finalReplySeq = null }
      t.events.push(ev)
      if (ev.payload.teamEventPrompt) t.segments.push({ kind: 'team_event', id: `team-event-${ev.payload.id ?? ev.seq}`, event: ev })
      if (teamProject) continue
      for (const [index, item] of (Array.isArray(ev.payload.teamEvents) ? ev.payload.teamEvents : []).entries()) {
        if (!item?.assignmentId || !['result', 'blocked'].includes(item.kind)) continue
        t.segments.push({
          kind: 'team_delivery',
          id: `team-delivery-${item.eventId ?? `${item.assignmentId}:${item.attempt ?? index}`}`,
          event: ev,
          assignmentId: String(item.assignmentId),
          attempt: Number(item.attempt) || 1,
          summary: String(item.summary || ''),
          deliveryKind: String(item.kind),
        })
      }
      continue
    }
    if (ev.type === 'system_notice' && ['team_wait', 'team_dispatch', 'team_delivery_notice'].includes(ev.payload?.kind)) {
      const t = ensure(ev)
      teamRunId = ev.payload.teamRunId
      t.done = false; t.completionSeq = null; t.finalReplySeq = null; t.endTs = Math.max(t.endTs, ev.ts)
      t.events.push(ev)
      if (ev.payload.kind === 'team_delivery_notice') t.segments.push({ kind: 'team_delivery', id: ev.payload.id, event: ev, assignmentId: ev.payload.assignmentId, attempt: ev.payload.attempt, summary: ev.payload.summary || '', deliveryKind: 'result' })
      else t.segments.push({ kind: ev.payload.kind, id: ev.payload.id, event: ev })
      continue
    }
    // A manual compaction is started while the session is idle, so its events
    // arrive after the preceding turn's `turn_completed`.  Do not append them
    // to that completed turn: DoneTurn intentionally renders only through its
    // final reply and would otherwise hide every segment that follows it.  A
    // synthetic, user-less turn keeps the stable compaction row visible while
    // App merges running -> terminal updates by payload id.  模型切换卡片同理。
    const previousTurn = turns[turns.length - 1]
    const t =
      previousTurn?.done && (ev.type === 'context_compaction' || ev.type === 'model_switch')
        ? startCur(ev)
        : ensure(ev)
    t.events.push(ev)
    if (teamProject && ev.type === 'tool_call' && /(?:^|__)(ask_team_user|dispatch_team_task)$/.test(String(ev.payload.name || '')) && ev.state !== 'failed') continue
    t.endTs = Math.max(t.endTs, ev.ts)
    // Hook history stays on the turn, outside the live and completed work timeline.
    if (ev.type === 'hook') continue
    if (ev.type === 'turn_started') {
      // 需求一 — remember the provider's native turn id for a turn-scoped review.
      const tid = ev.payload?.turnId ?? ev.payload?.turn_id
      if (tid && !t.done) {
        t.rewindTurnId ??= String(tid)
        t.nativeTurnId = String(tid)
      }
      continue
    }
    if (ev.type === 'turn_completed') {
      if (!t.done) {
        t.done = true
        t.completionSeq = ev.seq
        const tid = ev.payload?.turnId ?? ev.payload?.turn_id
        if (tid) {
          t.rewindTurnId ??= String(tid)
          t.nativeTurnId = String(tid)
        }
      }
      continue
    }
    // Aggregated diffs feed the read-only review sidebar, not the chain — but keep
    // the latest one on the turn (需求一) so it can render a change card + open a
    // turn-scoped review without re-scanning the whole workspace.
    if (ev.type === 'diff_update') {
      if (ev.payload?.diff) t.diff = String(ev.payload.diff)
      continue
    }
    // Queue snapshots become one stable node at the id's latest occurrence (a live wait stays at the tail).
    if (ev.type === 'queue_status') {
      pushChain(t, ev)
      continue
    }
    // Doc4 — a plan snapshot updates the turn's PlanStatusBar (merged by id).
    if (ev.type === 'plan_update') {
      t.plan = ev
      continue
    }
    // 子 Agent v3 — a sub-agent snapshot becomes an inline phase row IN ORDER,
    // one per real transition (spawn/append/done/…), each clickable → detail.
    if (ev.type === 'subagent') {
      const agents = (ev.payload?.agents || []) as UASubAgent[]
      for (const a of agents) {
        if (!a.agentThreadId) continue
        const previous = subAgentState.get(a.agentThreadId)
        const merged = mergeSubAgentSnapshot(previous, a, ev.ts)
        if (merged === previous) continue
        subAgentState.set(a.agentThreadId, merged)
        const seen = lastPhase.get(a.agentThreadId)
        const newerGeneration = isSubAgentGenerationAdvance(
          !!seen,
          seen?.generation,
          merged.generation,
        )
        if (
          (a.tool === 'sendInput' || a.tool === 'interacted') &&
          !newerGeneration &&
          !isSubAgentTerminal(merged.status)
        ) {
          const interactionId = String(ev.payload?.id ?? ev.seq).replace(/:(started|completed)$/, '')
          const key = `${a.agentThreadId}\0${interactionId}`
          if (!seenSubAgentInteractions.has(key)) {
            seenSubAgentInteractions.add(key)
            pushSub(t, 'append', { threadId: a.agentThreadId, name: merged.name, prompt: merged.prompt, dispatchId: merged.dispatchId }, ev)
          }
          continue
        }
        const prevPhase = newerGeneration ? undefined : seen?.phase
        // The lifecycle itself advances only from start to a terminal state.
        // Appended questions took the standalone branch above.
        const nextPhase: SubPhase = isSubAgentTerminal(merged.status)
          ? subTerminalPhase(merged.status)
          : 'spawn'
        if (prevPhase === nextPhase) continue // no real transition → no new row
        lastPhase.set(a.agentThreadId, { phase: nextPhase, generation: merged.generation })
        pushSub(t, nextPhase, { threadId: a.agentThreadId, name: merged.name, prompt: merged.prompt, dispatchId: merged.dispatchId }, ev)
      }
      continue
    }
    if (isGeneratedImageEvent(ev)) {
      t.segments.push({
        kind: 'image',
        id: `image-${ev.payload?.id ?? ev.seq}`,
        event: ev,
      })
      continue
    }
    // Only confirmed business milestones become persistent handoff cards. Tool
    // acceptance, queue/running ticks, ordinary polls and stop requests remain
    // ordinary chain events inside「已处理」.
    if (isHandoffTaskCall(ev)) {
      const milestones = handoffMilestones(ev, activeWaitingHandoffId).filter(item =>
        item.milestone !== 'terminal' || isHandoffEndEvent(ev) || !handoffEndIds.has(item.taskId))
      if (milestones.length === 0) {
        pushChain(t, ev)
        continue
      }
      for (const milestone of milestones) {
        const identity = milestone.milestone === 'delivered' || milestone.milestone === 'force-delivered'
          ? String(ev.payload?.id ?? ev.seq)
          : milestone.taskId
        const key = `${milestone.milestone}:${identity}`
        if (seenHandoffMilestones.has(key)) continue
        seenHandoffMilestones.add(key)
        t.segments.push({
          kind: 'handoff',
          id: `handoff-${key}`,
          event: ev,
          milestone: milestone.milestone,
          taskId: milestone.taskId,
        })
      }
      continue
    }
    if (ev.type === 'agent_message') {
      if (ev.payload?.kind === 'plan') {
        t.planMessage = ev
        continue
      }
      // Key by the stable item id (falls back to seq) so streaming re-emits
      // update the same node in place instead of remounting it each delta —
      // remounting is what made the whole reply flash rather than grow.
      t.segments.push({
        kind: 'reply',
        id: `reply-${ev.payload?.id ?? ev.seq}`,
        event: ev,
      })
      if (ev.payload?.phase === 'final_answer' && t.finalReplySeq === null) {
        t.finalReplySeq = ev.seq
      }
      continue
    }
    if (ev.type === 'approval_request') {
      if (ev.payload?.kind === 'planMode') {
        t.planModeRequest = ev
      }
      // 提问 / 审批 = 「轮到用户」的时刻，用户此刻最关注的就是这张卡片。它不再进
      // 入 chain（链路运行中不自动展开，卡片会被折叠藏起来），而是独立成段、渲染
      // 在本轮最外层（链路行之后），保证默认可见、可直接作答。作答后就地变为已答
      // 紧凑态，不跳回链路内部。
      t.segments.push({
        kind: 'approval',
        id: `approval-${ev.payload?.requestId ?? ev.payload?.id ?? ev.seq}`,
        event: withPlanText(ev, t.events),
      })
      continue
    }
    // 跨来源切换附带的压缩进度折叠进模型切换卡片的步骤行，不再单独成段。
    if (ev.type === 'context_compaction' && ev.payload?.reason === 'provider-switch' && hasModelSwitchCard) continue
    if (ev.type === 'model_switch') {
      // running → success/failed 及 hints 增量快照共用 payload.id；恢复的历史里
      // 同一 id 的多条快照只保留最新一条原地更新。
      const segmentId = `mswitch-${ev.payload?.id ?? ev.seq}`
      const existing = t.segments.find((segment) => segment.kind === 'model_switch' && segment.id === segmentId)
      if (existing?.kind === 'model_switch') existing.event = ev
      else t.segments.push({ kind: 'model_switch', id: segmentId, event: ev })
      continue
    }
    if (ev.type === 'context_compaction') {
      const id = `runtime-${ev.payload?.id ?? ev.seq}`
      const existing = ev.payload?.id && t.segments.find(segment => segment.kind === 'runtime' && segment.id === id)
      if (existing?.kind === 'runtime') existing.event = withCompactionTiming(ev, existing.event)
      else t.segments.push({ kind: 'runtime', id, event: withCompactionTiming(ev) })
      continue
    }
    if (ev.type === 'error') {
      t.segments.push({ kind: 'runtime', id: `runtime-${ev.payload?.id ?? ev.seq}`, event: ev })
      continue
    }
    if (ev.type === 'raw_output') {
      t.segments.push({ kind: 'notice', id: `notice-${ev.payload?.id ?? ev.seq}`, event: ev })
      continue
    }
    if (ev.type === 'system_notice') {
      if (parseTeamEventPrompt(ev.payload?.text).kind !== 'not-event')
        t.segments.push({ kind: 'team_event', id: `team-event-${ev.payload?.id ?? ev.seq}`, event: ev })
      else if (['usage', 'usage_report', 'context_usage'].includes(ev.payload?.kind)) t.footers.push(ev)
      else if (ev.payload?.kind === 'warning' && isConversationHint(ev.payload?.text)) {
        // Providers may repeat the same guidance with different ids or no id.
        // Keep its first occurrence per turn for both live and restored events.
        if (t.hints.some((hint) => hint.payload?.text === ev.payload?.text)) continue
        t.hints.push(ev)
        t.segments.push({ kind: 'hint', id: `hint-${ev.payload?.id ?? ev.seq}`, event: ev })
      }
      // 需求(实时上下文): live token-usage ticks drive the context meter only —
      // they must never render as a card in the timeline.
      else if (
        ev.payload?.kind === 'context' || ev.payload?.kind === 'token_speed' ||
        ev.payload?.kind === 'queue' ||
        ev.payload?.kind === 'reconnect'
      ) continue
      // 修复#5 — never render the "Ignoring malformed agent role definition …"
      // config-loader chatter (belt-and-suspenders: also filtered in main, but a
      // restored rollout may still carry the old notice).
      else if (isIgnorableNotice(ev.payload?.text)) continue
      else if (ev.payload?.kind === 'launch') pushChain(t, ev)
      else t.segments.push({ kind: 'notice', id: `notice-${ev.payload?.id ?? ev.seq}`, event: ev })
      continue
    }
    // Everything else (chain types + unknown) preserves order in the chain.
    pushChain(t, ev)
  }

  const priorQueueWaitById = new Map<string, number>()
  for (const turn of turns) {
    for (const segment of turn.segments) {
      if (segment.kind !== 'subagent') continue
      segment.agents = segment.agents.map((agent) => ({
        ...agent,
        name: subAgentState.get(agent.threadId)?.name || agent.name,
        prompt: agent.prompt || (subAgentState.get(agent.threadId)?.dispatchId === agent.dispatchId
          ? subAgentState.get(agent.threadId)?.prompt : undefined),
      }))
    }
    turn.queueViews = computeQueueViews(turn.events, priorQueueWaitById)
    turn.queueView = foldQueueViews(turn.queueViews)
    rememberQueueWaitTotals(turn.events, priorQueueWaitById)
    retainCompletedQueueWait(turn)
    if (teamProject) {
      const usage = turn.footers.filter((event) => event.payload.kind === 'usage')
      const latest = usage.at(-1)
      if (latest && usage.length > 1) {
        const total = computeCumulativeUsage(usage).get(latest.seq)!
        // Internal Leader wake-ups are one user task, so show one combined usage footer.
        turn.footers = turn.footers.flatMap((event) => event.payload.kind !== 'usage' ? [event]
          : event !== latest ? [] : [{ ...latest, payload: { ...latest.payload, usage: {
            ...latest.payload.usage, inputTokens: total.input, outputTokens: total.output,
            cachedInputTokens: total.cached, cost: total.cost,
          } } }])
      }
    }
  }
  if (teamProject && status !== undefined && turns.length) turns[turns.length - 1].done = !isSessionBusy(status)
  return turns
}

/** Only the first visual user turn may rewind a shared native (folded/steered) turn. */
export function rewindableVisualTurnIndexes(
  turns: readonly { nativeTurnId?: string; rewindTurnId?: string; user: unknown }[]
): Set<number> {
  const seen = new Set<string>()
  const indexes = new Set<number>()
  turns.forEach((turn, index) => {
    const turnId = turn.rewindTurnId ?? turn.nativeTurnId
    if (turn.user && turnId && !seen.has(turnId)) {
      seen.add(turnId)
      indexes.add(index)
    }
  })
  return indexes
}

/** A shared native turn ends at its last visual turn, so its card renders there once. */
export function changeCardVisualTurnIndexes(
  turns: readonly { nativeTurnId?: string; done: boolean }[]
): Set<number> {
  const lastByNativeTurn = new Map<string, number>()
  turns.forEach((turn, index) => {
    if (turn.nativeTurnId) lastByNativeTurn.set(turn.nativeTurnId, index)
  })
  const indexes = new Set<number>()
  turns.forEach((turn, index) => {
    if (turn.done && (!turn.nativeTurnId || lastByNativeTurn.get(turn.nativeTurnId) === index)) {
      indexes.add(index)
    }
  })
  return indexes
}

/** A persisted artifact is authoritative; live/legacy turns fall back to their patch. */
export function turnChangeFiles(
  summary: TurnArtifactSummary | null | undefined,
  diff: string
): FileDiff[] {
  return summary ? fileDiffsFromSummary(summary.files) : parseUnifiedDiff(diff)
}

export function EventStream({
  events,
  status,
  sessionId,
  manageProcessedFoldScroll,
  onRespond,
  subagents,
  onOpenSubAgent,
  waitingForHandoff,
  handoffSessionTargets,
  onJumpToSession,
  scrollToBottomSignal,
  onOpenTurnReview,
  onRewindToTurn,
  onOpenFile,
  onImplementPlan,
  onRevisePlan,
  selection,
  historyFork,
  onOpenReader,
  requestDockRef,
  onRequestEarlier,
  afterConversation,
}: {
  events: UAEvent[]
  historyFork?: HistoryForkActions
  status?: string
  sessionId?: string
  manageProcessedFoldScroll?: boolean
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  subagents?: UASubAgent[]
  onOpenSubAgent?: (agentThreadId: string) => void
  waitingForHandoff?: WaitingForHandoff
  handoffSessionTargets?: Record<string, HandoffSessionTarget>
  onJumpToSession?: (sessionId: string) => void
  scrollToBottomSignal?: number
  /** 需求一 — open the review overlay scoped to one turn; `filePath` preselects a
   * file (变更卡内文件行点击). Both are optional so callers can wire incrementally. */
  onOpenTurnReview?: (arg: { turnId: string; diff: string; filePath?: string }) => void
  /** 需求三 — request rewinding the session to before this turn (user footer action). */
  onRewindToTurn?: (arg: { turnId?: string; userEventSeq: number }) => void
  onOpenFile?: (path: string, line?: number) => void
  onImplementPlan?: () => Promise<void>
  onRevisePlan?: (feedback: string) => Promise<void>
  /** 选中即评论 — enable text-selection annotation (main chat only). */
  selection?: SelectionActions
  onOpenReader?: (event: UAEvent) => void
  requestDockRef?: RefObject<HTMLDivElement>
  onRequestEarlier?: () => Promise<unknown>
  afterConversation?: ReactNode
}): JSX.Element {
  const streamRef = useRef<HTMLDivElement>(null)
  const teamContext = useContext(TeamSessionContext)
  const ignoreFoldScrollRef = useRef(false)
  const followRef = useRef(true)
  const scrollSizeRef = useRef({ height: 0, viewport: 0 })
  const earlierLoadRef = useRef<{ sessionKey?: string; height: number; top: number } | null>(null)
  function requestEarlier(): void {
    const stream = streamRef.current
    if (!onRequestEarlier || !stream || stream.scrollTop > 20 || earlierLoadRef.current) return
    followRef.current = false
    const load = { sessionKey: sessionId ?? events[0]?.sessionId, height: stream.scrollHeight, top: stream.scrollTop }
    earlierLoadRef.current = load
    void onRequestEarlier().catch(() => {}).finally(() => {
      requestAnimationFrame(() => {
        if (earlierLoadRef.current !== load) return
        earlierLoadRef.current = null
        if (streamRef.current === stream && scrollSnapshot.current?.sessionKey === load.sessionKey) {
          stream.scrollTop = load.top + Math.max(0, stream.scrollHeight - load.height)
        }
      })
    })
  }
  const scrollSnapshot = useRef<{
    sessionKey?: string
    signal?: number
  } | null>(null)
  const [submittedRequests, setSubmittedRequests] = useState<
    Record<string, SubmittedApproval>
  >({})
  const usageNormalizedEvents = useMemo(() => coalesceUsageSnapshots(events), [events])
  const renderedEvents = useMemo(
    () => adoptToolResultImages(mergeOptimisticApprovalAnswers(
      usageNormalizedEvents.filter(isVisibleDetailEvent).map(asInteractionRequest), submittedRequests)),
    [usageNormalizedEvents, submittedRequests],
  )
  const asyncReplies = useMemo(() => {
    const questions = new Map<string, UAEvent>()
    const replies = new Map<number, UAEvent>()
    for (const event of renderedEvents) {
      if (event.type === 'approval_request' && event.payload.delivery === 'async' && event.payload.submittedAnswer !== undefined) {
        try {
          questions.set(asyncQuestionReply(event, event.payload.submittedAnswer), event)
        } catch {
          // Malformed saved answers cannot identify a reply.
        }
      } else if (event.type === 'user_message' && typeof event.payload.text === 'string') {
        const text = splitWeixinContext(event.payload.text)?.text ?? splitFeishuContext(event.payload.text)?.text ?? event.payload.text
        const question = questions.get(text)
        if (question) {
          replies.set(event.seq, question)
          questions.delete(text)
        }
      }
    }
    return replies
  }, [renderedEvents])
  const teamProject = teamContext && teamContext.project.memberSessions[teamContext.project.team.leaderMemberId] === sessionId ? teamContext.project : undefined
  const turns = useMemo(
    () => groupTurns(renderedEvents, waitingForHandoff?.handoffId, teamProject, status),
    [renderedEvents, waitingForHandoff?.handoffId, teamProject, status],
  )
  const rewindableTurns = useMemo(() => rewindableVisualTurnIndexes(turns), [turns])
  const changeCardTurns = useMemo(() => changeCardVisualTurnIndexes(turns), [turns])
  const planDecisionTurnIndex = turns.length - 1
  const artifactTurnKey = JSON.stringify([...new Set(turns.filter((turn) => turn.done).map((turn) => turn.nativeTurnId).filter(Boolean))])
  const artifactTurnIds = useMemo(() => JSON.parse(artifactTurnKey) as string[], [artifactTurnKey])
  const [artifactSummaries, setArtifactSummaries] = useState<Record<string, TurnArtifactSummary | null>>({})
  const artifactCache = useRef<Record<string, TurnArtifactSummary | null>>({})
  useEffect(() => {
    artifactCache.current = {}
    setArtifactSummaries({})
  }, [sessionId])
  useEffect(() => {
    if (!sessionId || artifactTurnIds.length === 0) return
    let cancelled = false
    const missing = artifactTurnIds.filter((turnId) => !artifactCache.current[turnId])
    if (!missing.length) return
    Promise.all(missing.map(async (turnId) => [
      turnId,
      await window.uniagent.getTurnArtifactSummary(sessionId, turnId).catch(() => null)
    ] as const)).then((entries) => {
      if (!cancelled) {
        Object.assign(artifactCache.current, Object.fromEntries(entries))
        setArtifactSummaries({ ...artifactCache.current })
      }
    })
    return () => { cancelled = true }
  }, [sessionId, status, artifactTurnIds])
  const respond = async (requestId: string, answer: unknown): Promise<void> => {
    await onRespond?.(requestId, answer)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (
        interactionRequestKey(event) === requestId
      ) {
        setSubmittedRequests((current) => ({
          ...current,
          [approvalEventIdentity(event)]: { answer, payload: asInteractionRequest(event).payload },
        }))
        break
      }
    }
  }
  // Completed turns keep their existing nested call-chain disclosure state.
  // Running turns use the separate step timeline below.
  const [chainState, setChainState] = useState<ChainOpenState>(() => ({
    manualOpenIds: new Set(),
    manualClosedIds: new Set(),
  }))
  const validChainIds = useMemo(
    () =>
      new Set(
        turns.flatMap((turn) =>
          turn.segments
            .filter((segment) => segment.kind === 'chain')
            .map((segment) => segment.id),
        ),
      ),
    [turns],
  )
  useEffect(
    () =>
      setChainState({ manualOpenIds: new Set(), manualClosedIds: new Set() }),
    [sessionId],
  )
  useEffect(
    () =>
      setChainState((state) => reconcileChainOpenState(state, validChainIds)),
    [validChainIds],
  )
  const chainController = useMemo<ChainOpenController>(
    () => ({
      state: chainState,
      toggle: (chainId) =>
        setChainState((state) => toggleChainOpen(state, chainId, null)),
    }),
    [chainState],
  )

  // 需求19: while a turn is in flight, show a codex-style live status line as the
  // LAST row describing what the agent is doing right now, with a shimmer sweep.
  const busy = isSessionBusy(status)
  const waitingForMembers = status === 'waiting_members'
  const activeTurnId = busy
    ? turns.findLast((turn) => !turn.done)?.id ?? null
    : null
  const compacting = events.some(
    (event) => event.type === 'context_compaction' && event.state === 'running',
  )
  const reconnecting = useMemo(() => isReconnectActive(events), [events])
  const activity = useMemo(
    () =>
      status === 'awaiting-approval'
        ? pendingApprovalActivity(events)
        : status === 'cancelling'
          ? '正在中止…'
          : reconnecting
            ? 'Reconnect…'
            : deriveActivity(events),
    [events, reconnecting, status],
  )

  // G2-1: whole-session cumulative usage keyed by each usage event's seq. We
  // sum per-turn input/output/cached/cost across every usage footer in order,
  // so the expanded token card can show session totals up to and including that
  // turn — robust for both the streaming and one-shot paths.
  const cumulativeBySeq = useMemo(
    () => computeCumulativeUsage(usageNormalizedEvents),
    [usageNormalizedEvents],
  )

  // Active waits own the live status, so do not repeat thinking below their node.
  const latestQueueView = turns[turns.length - 1]?.queueView ?? null
  const activeQueueView = latestQueueView?.phase === 'active' ? latestQueueView : null

  const readOnlyConversation = useContext(ReadOnlyConversationContext)
  const [dockTarget, setDockTarget] = useState<HTMLDivElement | null>(null)
  const [dockContainer, setDockContainer] = useState<HTMLDivElement | null>(null)
  const [requestFullscreen, setRequestFullscreen] = useState(false)
  const [requestCollapsed, setRequestCollapsed] = useState(false)
  const requestHeightRef = useRef<number | null>(null)
  const [selectedRequest, setSelectedRequest] = useState('')
  const [locateSeq, setLocateSeq] = useState<number | null>(null)
  const [localPlanAnswers, setLocalPlanAnswers] = useState<Record<string, unknown>>({})
  const [offeredPlans, setOfferedPlans] = useState<UAEvent[]>([])
  // Passive effects run after the later composer sibling has attached its ref.
  useEffect(() => { setDockTarget(requestDockRef?.current ?? null) }, [requestDockRef, sessionId])
  useEffect(() => {
    const container = document.createElement('div')
    container.className = 'interaction-dock-host'
    setDockContainer(container)
    return () => container.remove()
  }, [])
  useEffect(() => {
    setSelectedRequest(''); setLocateSeq(null); setLocalPlanAnswers({}); setOfferedPlans([]); setSubmittedRequests({}); setRequestFullscreen(false); setRequestCollapsed(false)
  }, [sessionId])
  const docked = !!dockTarget && !readOnlyConversation && !!onRespond
  const latestTurn = turns[planDecisionTurnIndex]
  const fallbackPlanRequest = latestTurn && !latestTurn.planModeRequest && !busy &&
    latestTurn.events.findLast(event => event.type === 'turn_completed')?.state === 'success' && latestTurn.planMessage?.state === 'success' && onImplementPlan && onRevisePlan
    ? localPlanRequest(latestTurn.planMessage) : null
  const fallbackPlanKey = fallbackPlanRequest?.payload.requestId
  useEffect(() => {
    if (fallbackPlanRequest) setOfferedPlans(current => current.some(event => event.payload.requestId === fallbackPlanKey)
      ? current : [...current, fallbackPlanRequest])
  }, [fallbackPlanKey])
  const requests = renderedEvents.filter(event => event.type === 'approval_request').map(event => withPlanText(event, renderedEvents))
  const localPlans = fallbackPlanRequest && !offeredPlans.some(event => event.payload.requestId === fallbackPlanKey)
    ? [...offeredPlans, fallbackPlanRequest] : offeredPlans
  requests.push(...localPlans.filter(event => !requests.some(request => request.payload.requestId === event.payload.requestId)).map(event => event.payload.requestId === fallbackPlanKey || localPlanAnswers[event.payload.requestId] !== undefined
    ? event : { ...event, payload: { ...event.payload, interactionExpired: true } }))
  const requestWithAnswer = (event: UAEvent): UAEvent => {
    const answer = localPlanAnswers[event.payload.requestId]
    return answer === undefined ? event : { ...event, state: 'success', payload: { ...event.payload, submittedAnswer: answer } }
  }
  const pendingRequests = requests.map(requestWithAnswer).filter(isPendingInteraction)
  const hasPendingRequests = pendingRequests.length > 0
  const fullscreen = requestFullscreen && !requestCollapsed && docked && hasPendingRequests
  const activeRequest = pendingRequests.find(event => approvalEventIdentity(event) === selectedRequest) || pendingRequests[0]
  const activeQuestion = !!activeRequest && isQuestionKind(activeRequest.payload.kind, activeRequest.payload.params)
  const activeRequestKey = activeRequest ? approvalEventIdentity(activeRequest) : ''
  useEffect(() => { setSelectedRequest(activeRequestKey) }, [activeRequestKey])
  useEffect(() => {
    if (!docked || !hasPendingRequests) { setRequestFullscreen(false); setRequestCollapsed(false) }
  }, [docked, hasPendingRequests])
  useLayoutEffect(() => {
    if (!dockContainer) return
    if (!docked || !dockTarget || !hasPendingRequests) {
      dockContainer.remove()
      dockContainer.style.removeProperty('height')
      requestHeightRef.current = null
      return
    }
    const focused = document.activeElement
    // Keep the form in its conversation so expanding never remounts it.
    dockTarget.appendChild(dockContainer)
    if (focused instanceof HTMLElement && dockContainer.contains(focused)) focused.focus({ preventScroll: true })
  }, [dockContainer, dockTarget, docked, hasPendingRequests])
  const toggleRequestFullscreen = (): void => {
    const panel = dockContainer?.querySelector<HTMLElement>('.interaction-dock')
    if (panel && dockContainer) {
      requestHeightRef.current = panel.getBoundingClientRect().height
      if (!fullscreen && !dockContainer.style.height) {
        // Reserve the compact dock's space while its top edge covers the stream.
        dockContainer.style.height = `${dockContainer.getBoundingClientRect().height}px`
      }
    }
    setRequestCollapsed(false)
    setRequestFullscreen(!fullscreen)
  }
  const toggleRequestCollapsed = (): void => {
    requestHeightRef.current = null
    setRequestFullscreen(false)
    setRequestCollapsed(!requestCollapsed)
  }
  useLayoutEffect(() => {
    const panel = dockContainer?.querySelector<HTMLElement>('.interaction-dock')
    const stream = streamRef.current
    if (!panel || !stream || !dockContainer || !hasPendingRequests) return
    panel.style.removeProperty('height')
    const collapsedHeight = fullscreen ? dockContainer.getBoundingClientRect().height - 6 : panel.getBoundingClientRect().height
    const resize = (): void => {
      panel.style.height = `${Math.max(collapsedHeight,
        dockContainer.getBoundingClientRect().bottom - 2 - stream.getBoundingClientRect().top - 8)}px`
    }
    if (fullscreen) resize()
    const targetHeight = panel.getBoundingClientRect().height
    const previousHeight = requestHeightRef.current
    requestHeightRef.current = null
    let animation: Animation | undefined
    const settle = (): void => {
      panel.classList.remove('is-transitioning')
      if (!fullscreen) {
        panel.style.removeProperty('height')
        dockContainer.style.removeProperty('height')
      }
    }
    if (previousHeight !== null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      panel.classList.add('is-transitioning')
      panel.style.height = `${targetHeight}px`
      animation = panel.animate([{ height: `${previousHeight}px` }, { height: `${targetHeight}px` }],
        { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' })
      animation.onfinish = settle
    } else settle()
    const observer = fullscreen ? new ResizeObserver(resize) : undefined
    observer?.observe(stream)
    observer?.observe(dockContainer)
    return () => {
      observer?.disconnect()
      animation?.cancel()
      panel.classList.remove('is-transitioning')
    }
  }, [dockContainer, docked, fullscreen, hasPendingRequests, requestCollapsed])
  const selectRequest = (event: UAEvent): void => {
    setRequestCollapsed(false)
    setSelectedRequest(approvalEventIdentity(event))
    requestAnimationFrame(() => {
      const panel = dockContainer?.querySelector<HTMLElement>('[data-request-panel]:not([hidden])')
      const input = panel?.querySelector<HTMLElement>('textarea:not(:disabled), input:not(:disabled)')
      const target = input || panel
      target?.focus({ preventScroll: true })
    })
  }
  const locateRequest = (event: UAEvent): void => {
    followRef.current = false
    setLocateSeq(event.seq)
  }
  useEffect(() => {
    if (locateSeq === null) return
    // History disclosures animate and mount their children after opening.
    const scroll = (): void => {
      const stream = streamRef.current
      const row = stream?.querySelector<HTMLElement>(`[data-interaction-seq="${locateSeq}"]`)
      if (stream && row) stream.scrollTo({ top: stream.scrollTop + row.getBoundingClientRect().top -
        stream.getBoundingClientRect().top - 24, behavior: 'smooth' })
    }
    const frame = requestAnimationFrame(scroll)
    const settle = window.setTimeout(scroll, 350)
    const clear = window.setTimeout(() => setLocateSeq(null), 2200)
    return () => { cancelAnimationFrame(frame); clearTimeout(settle); clearTimeout(clear) }
  }, [locateSeq])
  const submitPlan = async (event: UAEvent, decision: string, feedback?: string): Promise<void> => {
    if (event.payload.method === 'local/plan' && !event.payload.localPlanShared) {
      if (decision === 'approved') await onImplementPlan?.()
      if (decision === 'rejected') await onRevisePlan?.(feedback || '')
      setLocalPlanAnswers(current => ({ ...current, [event.payload.requestId]: { decision } }))
    } else {
      const feedbackInAnswer = planFeedbackInAnswer(event.payload.method)
      await respond(event.payload.requestId, { decision, ...(feedbackInAnswer ? { feedback } : {}) })
      if (decision === 'rejected' && !feedbackInAnswer) await onRevisePlan?.(feedback || '')
    }
  }

  // Message hydration is only the first layout: artifacts, images, previews and
  // composer resizing can change its height later without changing `events`.
  useLayoutEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    const sessionKey = sessionId ?? events[0]?.sessionId
    const previous = scrollSnapshot.current
    if (!previous || previous.sessionKey !== sessionKey || previous.signal !== scrollToBottomSignal) {
      followRef.current = true
      ignoreFoldScrollRef.current = false
      earlierLoadRef.current = null
    }
    scrollSnapshot.current = { sessionKey, signal: scrollToBottomSignal }
    const syncLayout = (): void => {
      // Limit navigation to this transcript; scrollIntoView also scrolls ancestors.
      if (followRef.current) stream.scrollTop = stream.scrollHeight
      scrollSizeRef.current = { height: stream.scrollHeight, viewport: stream.clientHeight }
    }
    syncLayout()
    const observer = new ResizeObserver(syncLayout)
    observer.observe(stream)
    // ponytail: observe O(rows) to preserve flex gaps and scroll anchors; use a
    // content wrapper if registering very long transcripts becomes costly.
    for (const row of stream.children) observer.observe(row)
    return () => observer.disconnect()
  })

  const handleProcessedFoldToggle = (opening: boolean): void => {
    followRef.current = false
    if (!manageProcessedFoldScroll || !streamRef.current) return
    const stream = streamRef.current
    const sessionKey = scrollSnapshot.current?.sessionKey
    const scrollTop = stream.scrollTop
    ignoreFoldScrollRef.current = true
    requestAnimationFrame(() => {
      if (streamRef.current === stream && scrollSnapshot.current?.sessionKey === sessionKey) {
        stream.scrollTo({ top: opening ? scrollTop : 0, behavior: 'auto' })
      }
      requestAnimationFrame(() => {
        ignoreFoldScrollRef.current = false
      })
    })
  }

  // 选中即评论 — group annotations by reply seq so each ReplyBlock can re-highlight
  // its own ranges and show a「N 条注释」capsule (via AnnotationContext).
  const annotationsBySeq = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of selection?.annotations || []) {
      if (a.filePath) continue
      const list = map.get(a.seq) || []
      list.push(a)
      map.set(a.seq, list)
    }
    return map
  }, [selection?.annotations])

  // Direct targets come from Session.handoffId. Extend that base map through
  // follow-up results so every later task id in the same conversation resolves
  // back to the original session as well.
  const resolvedHandoffSessionTargets = useMemo(() => {
    const targets = { ...(handoffSessionTargets || {}) }
    for (const event of events) {
      if (!isHandoffEndEvent(event)) continue
      const p = event.payload
      if (p.targetSessionId) targets[p.taskId] = {
        ...targets[p.taskId], sessionId: p.targetSessionId,
        agentName: targets[p.taskId]?.agentName || p.agentName,
      }
    }
    for (const event of events) {
      const action = handoffTaskAction(event)
      if (action !== 'create' && action !== 'followup') continue
      const input = (event.payload.input || {}) as { taskId?: string; followupTaskId?: string; agent?: string }
      const followupTaskId = action === 'followup' ? input.taskId || input.followupTaskId : undefined
      const taskId = handoffTaskIdFromResult(event.payload.result)
      const target = followupTaskId ? targets[followupTaskId] : taskId ? targets[taskId] : undefined
      if (taskId && target) targets[taskId] = { ...target,
        agentName: target.agentName || (input.agent ? handoffAgentName(input.agent) : undefined),
      }
    }
    return targets
  }, [events, handoffSessionTargets])
  const handoffTaskEnds = useMemo(() => {
    const ends: Record<string, UAEvent> = {}
    for (const event of renderedEvents) {
      if (!isHandoffTaskCall(event)) continue
      for (const item of handoffMilestones(event)) {
        if (item.milestone === 'terminal' && (!ends[item.taskId] || isHandoffEndEvent(event))) ends[item.taskId] = event
      }
    }
    return ends
  }, [renderedEvents])

  const liveStatus = waitingForHandoff && !compacting
    ? <HandoffWaitLine info={waitingForHandoff} onJump={onJumpToSession} />
    : busy && !compacting && !waitingForMembers && activity && !activeQueueView
      ? <StatusLine text={activity} /> : null

  return (
    <HistoryForkContext.Provider value={historyFork}>
    <ImmersiveReaderContext.Provider value={onOpenReader}>
    <AnnotationContext.Provider value={{ annotationsBySeq, onEditAnnotation: selection?.onEditComment }}>
    <HandoffSessionTargetsContext.Provider value={resolvedHandoffSessionTargets}>
    <HandoffTaskEndsContext.Provider value={handoffTaskEnds}>
    <HtmlPreviewSessionContext.Provider value={sessionId}>
    <RequestPresentationContext.Provider value={{ docked: !!dockTarget, locateSeq, select: selectRequest, asyncReplies, onOpenFile }}>
    <div className="stream-area">
      {selection && (
        <SelectionLayer
          streamRef={streamRef}
          onComment={selection.onComment}
          editRequest={selection.editRequest}
          onUpdateComment={selection.onUpdateComment}
          onRemoveComment={selection.onRemoveComment}
          onEditRequestHandled={selection.onEditRequestHandled}
          onDetail={selection.onDetail}
          onSide={selection.onSide}
          onSideComment={selection.onSideComment}
        />
      )}
      <div
        ref={streamRef}
        className="event-stream"
        onWheel={(e) => {
          if (e.deltaY < 0) { followRef.current = false; requestEarlier() }
        }}
        onScroll={(e) => {
          if (ignoreFoldScrollRef.current) return
          const el = e.currentTarget
          const size = scrollSizeRef.current
          // A layout-generated scroll can arrive before ResizeObserver. It is
          // not a user leaving the bottom; keep following until layout settles.
          if (size.height !== el.scrollHeight || size.viewport !== el.clientHeight) return
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          followRef.current = atBottom
        }}
      >
        {turns.map((t, index) => (
          <TurnBlock
            key={t.id}
            turn={t}
            active={t.id === activeTurnId}
            liveStatus={index === turns.length - 1 ? liveStatus : null}
            waitingForMembers={waitingForMembers && index === turns.length - 1}
            showFooters={(!teamProject || t.done) && (!busy || index < turns.length - 1)}
            onRespond={onRespond ? respond : undefined}
            cumulativeBySeq={cumulativeBySeq}
            onOpenSubAgent={onOpenSubAgent}
            waitingForHandoff={waitingForHandoff}
            onJumpToSession={onJumpToSession}
            chainController={chainController}
            onProcessedFoldToggle={handleProcessedFoldToggle}
            onOpenTurnReview={onOpenTurnReview}
            onRewindToTurn={onRewindToTurn}
            onOpenFile={onOpenFile}
            artifactSummary={t.nativeTurnId ? artifactSummaries[t.nativeTurnId] : undefined}
            rewindable={rewindableTurns.has(index)}
            showChangeCard={changeCardTurns.has(index)}
            offerPlanDecision={
              index === planDecisionTurnIndex &&
              (t.planModeRequest?.state === 'pending' ||
                (!t.planModeRequest && !busy && t.events.findLast(event => event.type === 'turn_completed')?.state === 'success' && t.planMessage?.state === 'success')) &&
              (t.planModeRequest ? !!onRespond : !!onImplementPlan && !!onRevisePlan)
            }
            planModeRequest={t.planModeRequest}
            onImplementPlan={onImplementPlan}
            onRevisePlan={onRevisePlan}
            planRequest={requests.map(requestWithAnswer).find(event => event.payload.kind === 'planMode' &&
              (event.payload.requestId === t.planModeRequest?.payload.requestId || event.payload.method === 'local/plan' && (event.payload.planSeq ?? event.seq) === t.planMessage?.seq))}
          />
        ))}
        {waitingForMembers && turns.length === 0 && <TeamWaitingMembersStep />}
        {turns.length === 0 && liveStatus}
        {afterConversation}
        <div />
      </div>
    </div>
    {docked && dockTarget && dockContainer && hasPendingRequests && createPortal(
      <section className={`interaction-dock${activeQuestion ? ' is-question' : ''}${activeRequest?.payload.teamQuestion ? ' is-team' : ''}${fullscreen ? ' is-fullscreen' : ''}${requestCollapsed ? ' is-collapsed' : ''}`}
        role="region" aria-label="待处理提问与审批"
        onKeyDown={event => {
          if (!fullscreen || event.defaultPrevented || !event.currentTarget.contains(event.target as Node) ||
            event.currentTarget.querySelector('dialog:modal') || document.querySelector('.filebrowser-overlay')) return
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); toggleRequestFullscreen()
          }
        }}>
        <div className="interaction-dock-head">
          <UiIcon name={activeQuestion ? 'question' : 'shield'} size={15} />
          <strong>{activeRequest && interactionTitle(activeRequest)}</strong>
          <span className="approval-wait-chip">{pendingRequests.every(event => isQuestionKind(event.payload.kind, event.payload.params))
            ? `待回答${pendingRequests.length > 1 ? ` ${pendingRequests.length}` : ''}` : `待处理 ${pendingRequests.length}`}</span>
          <div className="interaction-dock-tools">
            {!fullscreen && <button type="button" className="interaction-link" onClick={() => activeRequest && locateRequest(activeRequest)}>定位到时间线</button>}
            <button type="button" className="interaction-dock-toggle interaction-fullscreen-toggle" data-request-fullscreen-toggle
              aria-expanded={fullscreen}
              aria-label={fullscreen ? '退出全屏问答' : '全屏展示问答'} title={fullscreen ? '退出全屏（Esc）' : '全屏展示问答'}
              onClick={toggleRequestFullscreen}>
              <UiIcon name={fullscreen ? 'collapse' : 'expand'} size={14} />{fullscreen ? '退出全屏' : '全屏'}
            </button>
            <button type="button" className="interaction-dock-toggle interaction-collapse-toggle" data-request-collapse-toggle
              aria-expanded={!requestCollapsed}
              aria-label={requestCollapsed ? '展开提问卡片' : '收起提问卡片'} title={requestCollapsed ? '展开提问卡片' : '收起提问卡片'}
              onClick={toggleRequestCollapsed}>
              <UiIcon name="chevron-down" size={14} />{requestCollapsed ? '展开' : '收起'}
            </button>
          </div>
        </div>
        {pendingRequests.length > 1 && <div className="interaction-tabs" role="tablist" aria-label="待处理请求" hidden={requestCollapsed}>
          {pendingRequests.map((event, index) => {
            const title = isQuestionKind(event.payload.kind, event.payload.params)
              ? normalizeQuestions(questionAnswerKind(event.payload.kind, event.payload.method), event.payload.params)[0]?.title || interactionSummary(event)
              : interactionTitle(event)
            return <button type="button" role="tab" key={approvalEventIdentity(event)} title={interactionSummary(event)}
              aria-selected={approvalEventIdentity(event) === activeRequestKey}
              onClick={() => selectRequest(event)}>{index + 1} · {title}</button>
          })}
        </div>}
        {pendingRequests.map(event => {
          const background = questionBackgroundText(renderedEvents, event)
          return <div key={approvalEventIdentity(event)} data-request-panel tabIndex={-1}
          hidden={requestCollapsed || approvalEventIdentity(event) !== activeRequestKey} className="interaction-panel">
          {background && <div className="question-context"><Markdown text={background} onOpenFile={onOpenFile} /></div>}
          {event.payload.kind === 'planMode' ? <>
            <div className="interaction-plan-content"><Markdown text={event.payload.params?.plan || 'Agent 请求结束计划模式并开始实施。'} /></div>
            <PlanDecision onImplement={() => submitPlan(event, 'approved')}
              onRevise={feedback => submitPlan(event, 'rejected', feedback)}
              onSkip={() => submitPlan(event, 'cancelled')} />
          </> : <RequestDetailCard ev={event} onRespond={respond} />}
        </div>})}
      </section>, dockContainer,
    )}
    </RequestPresentationContext.Provider>
    </HtmlPreviewSessionContext.Provider>
    </HandoffTaskEndsContext.Provider>
    </HandoffSessionTargetsContext.Provider>
    </AnnotationContext.Provider>
    </ImmersiveReaderContext.Provider>
    </HistoryForkContext.Provider>
  )
}

/**
 * 选中即评论 — the floating layer that watches for text selections INSIDE the main
 * chat's replies and shows the selection bubble (评论 / 详情 / 侧边聊天) centered
 * above the selection. 评论 morphs the bubble into an inline comment box in place.
 * Fixed-positioned at the live selection rect (rendered through a portal so it
 * escapes the scroll container's clipping); dismissed on outside-click, scroll
 * (rect goes stale), or Esc. Nothing renders unless a selection is captured.
 */
function SelectionLayer({
  streamRef,
  onComment,
  editRequest,
  onUpdateComment,
  onRemoveComment,
  onEditRequestHandled,
  onDetail,
  onSide,
  onSideComment,
}: {
  streamRef: React.RefObject<HTMLDivElement>
  onSideComment?: SelectionActions['onSideComment']
  onComment: (a: { seq: number; start: number; end: number; quote: string; comment: string }) => void
  editRequest?: { annotation: Annotation; nonce: number }
  onUpdateComment: (id: string, comment: string) => void
  onRemoveComment: (id: string) => void
  onEditRequestHandled: (nonce: number) => void
  onDetail?: (a: { seq: number; start: number; end: number; quote: string; selectedMessageText: string }) => void
  onSide?: (a: { seq: number; start: number; end: number; quote: string }) => void
}): JSX.Element | null {
  const [sel, setSel] = useState<CapturedSelection | null>(null)
  const [mode, setMode] = useState<'bubble' | 'comment'>('bubble')
  const [comment, setComment] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Capture the selection on mouseup inside the stream. A mouseup landing on our
  // own popover (the comment box) must NOT recapture or dismiss it. Defer one
  // tick so the browser has finalized the selection before we read it.
  useEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    const onMouseUp = (e: MouseEvent): void => {
      if (popRef.current?.contains(e.target as Node)) return
      window.setTimeout(() => {
        const captured = captureSelection()
        if (captured) {
          setSel(captured)
          setMode('bubble')
          setComment('')
          setEditingId(null)
        }
      }, 0)
    }
    stream.addEventListener('mouseup', onMouseUp)
    return () => stream.removeEventListener('mouseup', onMouseUp)
  }, [streamRef])

  // Dismiss on outside mousedown, on scroll (the fixed rect goes stale), or Esc.
  useEffect(() => {
    if (!sel) return
    const dismiss = (): void => setSel(null)
    const onDown = (e: MouseEvent): void => {
      if (popRef.current?.contains(e.target as Node)) return
      setSel(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSel(null)
    }
    const stream = streamRef.current
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    stream?.addEventListener('scroll', dismiss, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      stream?.removeEventListener('scroll', dismiss)
    }
  }, [sel, streamRef])

  useEffect(() => {
    if (mode === 'comment') requestAnimationFrame(() => taRef.current?.focus())
  }, [mode])

  // Editing starts from the composer tray, outside this stream. Resolve the
  // annotation by its persistent DOM id, jump first, then measure its final
  // viewport rect so the existing comment box opens at the correct position.
  useEffect(() => {
    if (!editRequest) return
    const { annotation, nonce } = editRequest
    const stream = streamRef.current
    if (!stream) {
      onEditRequestHandled(nonce)
      return
    }
    const findMarks = (): HTMLElement[] => Array.from(
      stream.querySelectorAll<HTMLElement>('mark.ua-annotation-hl')
    ).filter((mark) => mark.dataset.annoId === annotation.id)
    const marks = findMarks()
    if (!marks.length) {
      onEditRequestHandled(nonce)
      return
    }

    setSel(null)
    marks[0].scrollIntoView({ block: 'center', behavior: 'auto' })
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const positionedMarks = findMarks()
        const rects = positionedMarks.flatMap((mark) => Array.from(mark.getClientRects()))
        if (!rects.length) return
        const left = Math.min(...rects.map((rect) => rect.left))
        const top = Math.min(...rects.map((rect) => rect.top))
        const right = Math.max(...rects.map((rect) => rect.right))
        const bottom = Math.max(...rects.map((rect) => rect.bottom))
        setComment(annotation.comment)
        setEditingId(annotation.id)
        setMode('comment')
        setSel({
          seq: annotation.seq,
          start: annotation.start,
          end: annotation.end,
          quote: annotation.quote,
          selectedMessageText: '',
          rect: new DOMRect(left, top, right - left, bottom - top),
        })
        onEditRequestHandled(nonce)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [editRequest, onEditRequestHandled, streamRef])

  if (!sel) return null

  const left = sel.rect.left + sel.rect.width / 2
  const top = sel.rect.top
  const anchor = { left, top, transform: 'translate(-50%, calc(-100% - 10px))' } as const

  const clearNativeSelection = (): void => {
    window.getSelection()?.removeAllRanges()
    setSel(null)
    setEditingId(null)
  }
  const confirmComment = (): void => {
    if (editingId) {
      onUpdateComment(editingId, comment.trim())
    } else {
      onComment({
        seq: sel.seq,
        start: sel.start,
        end: sel.end,
        quote: sel.quote,
        comment: comment.trim(),
      })
    }
    clearNativeSelection()
  }
  const removeComment = (): void => {
    if (editingId) onRemoveComment(editingId)
    clearNativeSelection()
  }

  if (mode === 'comment') {
    return createPortal(
      <div
        ref={popRef}
        className="sel-cmt-pop"
        style={anchor}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sel-cmt-quote">{sel.quote}</div>
        <textarea
          ref={taRef}
          className="sel-cmt-ta"
          placeholder="添加评论…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              confirmComment()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setSel(null)
            }
          }}
          rows={3}
        />
        <div className="sel-cmt-actions">
          {editingId
            ? <button className="sel-cmt-delete" onClick={removeComment}><UiIcon name="trash" size={13} /> 删除评论</button>
            : <span className="sel-cmt-hint">⌘⏎ 发送</span>}
          <button className="sel-cmt-ghost" onClick={clearNativeSelection}>取消</button>
          <button className="sel-cmt-primary" onClick={confirmComment}>{editingId ? '保存' : '评论'}</button>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      ref={popRef}
      className="sel-pop"
      style={anchor}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="sel-btn" onClick={() => setMode('comment')}>
        <UiIcon name="message-square" size={14} /> 评论
      </button>
      {onDetail && <>
        <span className="sel-sep" />
        <button
          className="sel-btn"
          onClick={() => {
            onDetail({
              seq: sel.seq,
              start: sel.start,
              end: sel.end,
              quote: sel.quote,
              selectedMessageText: sel.selectedMessageText,
            })
            clearNativeSelection()
          }}
        >
          <UiIcon name="search" size={14} /> 解释
        </button>
      </>}
      {onSide && <>
        <span className="sel-sep" />
        <button
          className="sel-btn"
          onClick={() => {
            onSide({ seq: sel.seq, start: sel.start, end: sel.end, quote: sel.quote })
            clearNativeSelection()
          }}
        >
          <UiIcon name="fork" size={14} /> 侧边聊天
        </button>
      </>}
      {onSideComment && <><span className="sel-sep" /><button className="sel-btn" onClick={() => {
        onSideComment(sel); clearNativeSelection()
      }}><UiIcon name="message-square" size={14} /> 侧边评论</button></>}
    </div>,
    document.body,
  )
}

export function replyHasLiveCursor(
  state: UAEvent['state'],
  turnDone: boolean,
  activeTurn: boolean,
  latestReply: boolean,
): boolean {
  return state === 'running' && !turnDone && activeTurn && latestReply
}

/**
 * Standalone live status below the process timeline, aligned with its heading.
 * The shimmer sweep signals that the turn is still running.
 */
export function StatusLine({ text }: { text: string }): JSX.Element {
  return (
    <div className="status-line" aria-live="polite">
      <span className="status-line-text shimmer">{text}</span>
    </div>
  )
}

/**
 * Fix#4 — the live status line shown INSTEAD of「思考中」while this session is
 * blocked (wait=true) on an outbound create_uniagent_task handoff to another
 * agent. It names WHAT is being awaited ("等待 <agent> 的 <task>") and, when the
 * awaited session is known, is clickable to jump straight to it.
 */
function HandoffWaitLine({
  info,
  onJump,
}: {
  info: WaitingForHandoff
  onJump?: (sessionId: string) => void
}): JSX.Element {
  const clickable = !!(onJump && info.awaitedSessionId)
  return (
    <div
      className={`status-line handoff-wait-line${clickable ? ' is-clickable' : ''}`}
      aria-live="polite"
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? '点击跳转到该任务会话' : undefined}
      onClick={clickable ? () => onJump?.(info.awaitedSessionId) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onJump?.(info.awaitedSessionId)
              }
            }
          : undefined
      }
    >
      <span className="status-line-gutter" aria-hidden>
        ⏳
      </span>
      <span className="status-line-text shimmer">
        等待 {info.agentName} 的 {info.label}
      </span>
    </div>
  )
}

/** Target-agent display name from a handoff's `input.agent` id/adapter (mirrors
 * AgentIcon's key mapping). Falls back to the raw value, then a generic label. */
function handoffAgentName(agentId?: string): string {
  const v = (agentId || '').toLowerCase()
  if (v.includes('codex') || v === 'openai') return 'Codex'
  if (v.includes('trae')) return 'TraeX'
  if (v.includes('claude') || v.includes('anthropic')) return 'Claude Code'
  if (v.includes('grok')) return 'Grok'
  return agentId || '新任务'
}

const HT_ACTION_LABEL: Record<string, string> = {
  start: '派发任务',
  delivered: '追加消息',
  done: '任务结束',
  failed: '任务异常',
  interrupted: '任务中止',
  force: '强制追加',
}

/** Collapse a prompt to a single-line prefix for the meta row (CSS elides the tail).
 * Mirrors index.ts firstLine intent but keeps more context since the card ellipses. */
function inputPrefixOf(text?: string): string {
  const line = (text || '').replace(/\s+/g, ' ').trim()
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

function handoffEventMarker(result: unknown): HandoffMilestone | '' {
  const marker = handoffResultText(result).match(/\[uniagent:event=(started|delivered|force-delivered)\]/)?.[1]
  return marker === 'started' ? 'start' : marker === 'delivered' || marker === 'force-delivered' ? marker : ''
}

function handoffTerminalMarker(result: unknown): 'completed' | 'failed' | 'stopped' | '' {
  return (handoffResultText(result).match(/\[uniagent:terminal=(completed|failed|stopped)\]/)?.[1] || '') as
    'completed' | 'failed' | 'stopped' | ''
}

function stripHandoffMarkers(text: string): string {
  return text.replace(/\n*\[uniagent:(?:event|terminal|source)=[^\]]+\]/g, '').trim()
}

function parsedHandoffStatus(result: unknown): {
  taskId?: string
  status?: string
  done?: boolean
  latestReply?: string
  stoppedBy?: string
} {
  try { return JSON.parse(handoffResultText(result)) } catch { return {} }
}

/** Translate tool results into the only milestones that deserve visible cards. */
function handoffMilestones(
  ev: UAEvent,
  activeWaitingHandoffId = '',
): { milestone: HandoffMilestone; taskId: string }[] {
  const p = ev.payload || {}
  if (isHandoffEndEvent(ev)) return [{ milestone: 'terminal', taskId: p.taskId }]
  const action = handoffTaskAction(ev)
  if (action === 'create' || action === 'followup') {
    const input = (p.input || {}) as { wait?: boolean }
    const taskId = handoffTaskIdFromResult(p.result)
      || (input.wait === true && activeWaitingHandoffId ? activeWaitingHandoffId : '')
    if (!taskId) return []
    const out: { milestone: HandoffMilestone; taskId: string }[] = []
    const event = handoffEventMarker(p.result)
    if (event) out.push({ milestone: event, taskId })
    else if (
      input.wait === true &&
      taskId === activeWaitingHandoffId &&
      (ev.state === 'running' || ev.state === 'pending')
    ) {
      // The main process confirms a real target before publishing waitingForHandoff.
      out.push({ milestone: action === 'followup' ? 'delivered' : 'start', taskId })
    }
    if (handoffTerminalMarker(p.result)) out.push({ milestone: 'terminal', taskId })
    return out
  }
  if (action === 'get') {
    const parsed = parsedHandoffStatus(p.result)
    const terminal = parsed.done === true && (
      parsed.status === 'completed' || parsed.status === 'failed' || parsed.status === 'stopped'
    )
    const taskId = parsed.taskId || String(p.input?.taskId || '')
    return terminal && taskId ? [{ milestone: 'terminal', taskId }] : []
  }
  if (action === 'stop') {
    const taskId = handoffTaskIdFromResult(p.result) || String(p.input?.taskId || '')
    return handoffTerminalMarker(p.result) === 'stopped' && taskId
      ? [{ milestone: 'terminal', taskId }]
      : []
  }
  return []
}

function deriveHandoffRow(ev: UAEvent, milestone: HandoffMilestone): {
  state: 'start' | 'delivered' | 'done' | 'failed' | 'interrupted'
  agentId?: string
  agentName: string
  isFollowup: boolean
  force: boolean
  stoppedByMcp: boolean
  input: string
  reply: string
} | null {
  const p = ev.payload || {}
  if (isHandoffEndEvent(ev)) {
    const state = p.status === 'completed' ? 'done' : p.status === 'failed' ? 'failed' : 'interrupted'
    return {
      state, agentId: p.agentId, agentName: p.agentName || '任务',
      isFollowup: false, force: false, stoppedByMcp: p.stoppedBy === 'stop_uniagent_task',
      input: '', reply: p.reply || (state === 'done' ? '任务已完成，暂无文本结果。' : state === 'failed' ? '任务执行失败。' : '任务已中止。'),
    }
  }
  const action = handoffTaskAction(ev)
  if (action === 'create' || action === 'followup') {
    const input = (p.input || {}) as {
      prompt?: string; agent?: string; wait?: boolean
      role?: string; force?: boolean
    }
    const isFollowup = action === 'followup'
    const isRole = !isFollowup && !!input.role
    // Role ids are internal storage keys. The visible name is resolved from the
    // created session's immutable roleSnapshot inside HandoffTaskLine.
    const agentName = isFollowup || isRole ? '' : handoffAgentName(input.agent)
    const prefix = inputPrefixOf(input.prompt)
    const base = {
      agentId: input.agent,
      agentName,
      isFollowup,
      force: input.force === true,
      stoppedByMcp: /\[uniagent:source=stop_uniagent_task\]/.test(handoffResultText(p.result)),
      input: prefix,
    }
    if (milestone === 'start') return { state: 'start', ...base, reply: '' }
    if (milestone === 'delivered' || milestone === 'force-delivered') {
      return { state: 'delivered', ...base, force: milestone === 'force-delivered', reply: '' }
    }
    const terminal = handoffTerminalMarker(p.result)
    if (!terminal) return null
    const text = stripHandoffMarkers(handoffResultText(p.result))
    const state = terminal === 'failed' ? 'failed' : terminal === 'stopped' ? 'interrupted' : 'done'
    const reply = text.replace(/^[\s\S]*?：\n\n/, '').trim()
    return { state, ...base, reply }
  }
  if (action === 'get') {
    const parsed = parsedHandoffStatus(p.result)
    const s = parsed.status
    const state = s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s === 'stopped' ? 'interrupted' : null
    if (!state) return null
    return {
      state,
      agentName: '任务',
      isFollowup: false,
      force: false,
      stoppedByMcp: parsed.stoppedBy === 'stop_uniagent_task',
      input: '',
      reply: parsed.latestReply || '',
    }
  }
  if (action === 'stop' && handoffTerminalMarker(p.result) === 'stopped') {
    const text = stripHandoffMarkers(handoffResultText(p.result))
    return {
      state: 'interrupted',
      agentName: '任务',
      isFollowup: false,
      force: false,
      stoppedByMcp: true,
      input: '',
      reply: text.split('\n\n').slice(1).join('\n\n').trim(),
    }
  }
  return null
}

/** Persistent caller-side row for a confirmed start, delivery or terminal state. */
function HandoffTaskLine({
  ev,
  milestone,
  taskId,
  waitingForHandoff,
  onJump,
}: {
  ev: UAEvent
  milestone: HandoffMilestone
  taskId: string
  waitingForHandoff?: WaitingForHandoff
  onJump?: (sessionId: string) => void
}): JSX.Element | null {
  const targets = useContext(HandoffSessionTargetsContext)
  const ends = useContext(HandoffTaskEndsContext)
  const original = deriveHandoffRow(ev, milestone)
  if (!original) return null
  const end = ends[taskId] ? deriveHandoffRow(ends[taskId], 'terminal') : null
  const row = milestone !== 'terminal' && end ? { ...original, state: end.state } : original
  const terminal = milestone === 'terminal'
  const input = (ev.payload?.input || {}) as { taskId?: string; followupTaskId?: string }
  const waitingTaskId = waitingForHandoff?.handoffId || ''
  const target = targets[taskId] || targets[input.taskId || input.followupTaskId || '']
  const waiting = waitingTaskId === taskId ? waitingForHandoff : undefined
  const jumpTo = target?.sessionId
    || (!terminal ? waiting?.awaitedSessionId : '')
    || ''
  const clickable = !!(onJump && jumpTo)
  const pulsing = row.state === 'start'
  const agentName = target?.agentName || (row.agentId ? handoffAgentName(row.agentId) : row.agentName || waiting?.agentName)
  const displayName = target?.roleName || agentName || '任务'
  const showAgent = !!target?.roleName && !!agentName && agentName !== displayName && agentName !== '任务'
  const actionState = terminal ? row.state : row.force ? 'force'
    : row.isFollowup || milestone === 'delivered' ? 'delivered' : 'start'
  const summary = [row.stoppedByMcp && '由 MCP 中止', terminal ? row.reply : row.input].filter(Boolean).join('：')
  return (
    <div className={`process-step process-handoff${terminal ? ' process-handoff-end' : ''}${pulsing ? ' active' : ''}${row.state === 'failed' ? ' failed' : ''}`}>
      <span className="process-step-node" aria-hidden><UiIcon name="dispatch" size={13} /></span>
      <div className="process-step-content">
      <div
        className="hx"
        data-state={row.state}
        data-end={terminal || undefined}
        data-force={row.force || undefined}
        role={clickable ? 'button' : undefined}
        aria-label={clickable ? `跳转到${displayName}的任务会话` : undefined}
        tabIndex={clickable ? 0 : undefined}
        title={clickable ? '点击跳转到该任务会话' : undefined}
        onClick={clickable ? () => onJump?.(jumpTo) : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onJump?.(jumpTo)
                }
              }
            : undefined
        }
      >
        <div className="hx-head">
          <span className="hx-label">跨agent调用</span>
          <span className="hx-name" title={`${displayName}${showAgent ? `（${agentName}）` : ''}`}>
            {displayName}{showAgent && <span className="hx-agent">（{agentName}）</span>}
          </span>
          <span className="hx-action" data-state={actionState}>{HT_ACTION_LABEL[actionState]}</span>
        </div>
        {summary && <div className="hx-summary">{summary}</div>}
      </div>
      </div>
    </div>
  )
}

/** The same compute-wait node renders both active and completed phases. */
function QueueWaitStep({
  view,
}: {
  view: QueueView
}): JSX.Element {
  const [, refresh] = useState(0)
  const waiting = view.phase === 'active'
  useEffect(() => {
    if (!waiting) return
    const tick = (): void => refresh((value) => value + 1)
    const timer = setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [waiting])
  // Read the clock on every render, including snapshots arriving between ticks.
  const now = Date.now()
  const elapsed = view.waitedMs + (view.phase === 'active' ? Math.max(0, now - view.startTs) : 0)
  const estimate = view.phase !== 'active' || view.estimatedRemainingMs === undefined
    ? undefined
    : Math.max(0, view.estimatedRemainingMs - Math.max(0, now - view.estimatedAt))
  return (
    <div className={`process-step process-queue${waiting ? ' active' : ''}`} role="status">
      <span className="process-step-node" aria-hidden><span className={waiting ? 'process-step-live-dot' : 'process-step-done-dot'} /></span>
      <div className="process-step-content process-step-head">
        <span className="process-step-title">等待算力</span>
        <span className="process-step-meta">
          {view.phase === 'active' && typeof view.position === 'number' && view.position >= 0 && `第 ${view.position + 1} 位 · `}
          {waiting ? `已等待 ${fmtWait(elapsed)}` : `${fmtWait(elapsed)} · 已结束`}
          {estimate !== undefined && estimate > 0 && ` · 预计还需 ${Math.ceil(estimate / 1000)}s`}
        </span>
      </div>
    </div>
  )
}

type QueueView =
  | {
      phase: 'active'
      position?: number | null
      startTs: number
      waitedMs: number
      estimatedRemainingMs?: number
      estimatedAt: number
      turnId: string
      source: UAEvent
    }
  | { phase: 'done'; waitedMs: number; source: UAEvent }

type QueueWaitView = { id: string; view: QueueView }

type QueueSlot = {
  waitedMs: number
  startTs: number | null
  startSeq: number | null
  position?: number | null
  turnId: string
  source: UAEvent
  sawWait: boolean
  estimatedRemainingMs?: number
  estimatedAt: number
}

/**
 * Fold one visual turn's queue snapshots into one view per queue id. The adapter
 * may keep `waitedMs` across several visible turns in one Goal, so subtract the
 * last total previously seen for the same queue id. `startedAt` keeps a current
 * phase stable across mergeable queue updates. Real agent progress and the turn
 * boundary remain fallbacks for providers that omit an explicit ready event.
 *
 * Team wake-ups continue the same visual turn but open a new native turn with a
 * new queue id; each id keeps its own start/duration so the live wait stays at
 * the bottom of the timeline instead of being folded into the first wait.
 */
function computeQueueViews(
  events: UAEvent[],
  priorWaitById: ReadonlyMap<string, number> = new Map()
): QueueWaitView[] {
  const slots = new Map<string, QueueSlot>()
  for (const ev of events) {
    if (ev.type === 'queue_status') {
      const q = ev.payload?.queue as QueueStatus | undefined
      if (!q) continue
      const id = String(ev.payload?.id ?? `queue-${ev.seq}`)
      const slot = slots.get(id) ?? {
        waitedMs: 0,
        startTs: null,
        startSeq: null,
        turnId: `t-${events[0]?.seq ?? 0}`,
        source: ev,
        sawWait: false,
        estimatedAt: 0,
      }
      slot.source = ev
      if (q.turnId) slot.turnId = q.turnId
      slot.estimatedRemainingMs = undefined
      slot.estimatedAt = 0
      if (Number.isFinite(q.estimatedRemainingMs) && Number.isFinite(q.estimatedAt)) {
        slot.estimatedRemainingMs = Math.max(0, q.estimatedRemainingMs as number)
        slot.estimatedAt = q.estimatedAt as number
      }
      const rawWaitedMs = Number.isFinite(q.waitedMs) ? Math.max(0, q.waitedMs as number) : null
      const priorWaitedMs = priorWaitById.get(id) || 0
      const reportedWaitedMs = rawWaitedMs === null ? null : Math.max(0, rawWaitedMs - priorWaitedMs)
      if (q.state === 'ready') {
        if (reportedWaitedMs !== null) {
          slot.waitedMs = Math.max(slot.waitedMs, reportedWaitedMs)
          slot.sawWait = true
        } else if (slot.startTs !== null) {
          slot.waitedMs += Math.max(0, ev.ts - slot.startTs)
        }
        slot.startTs = null
        slot.startSeq = null
      } else {
        slot.sawWait = true
        if (reportedWaitedMs !== null) slot.waitedMs = Math.max(slot.waitedMs, reportedWaitedMs)
        if (slot.startTs === null) {
          slot.startTs = Number.isFinite(q.startedAt) ? q.startedAt as number : ev.ts
          slot.startSeq = ev.seq
        }
        if (typeof q.position === 'number') slot.position = q.position
      }
      slots.set(id, slot)
      continue
    }
    if (!(ev.type === 'agent_message' ||
      ev.type === 'reasoning' ||
      ev.type === 'tool_call' ||
      ev.type === 'command_exec' ||
      ev.type === 'turn_completed')) continue
    for (const slot of slots.values()) {
      if (slot.startTs === null || slot.startSeq === null || ev.seq <= slot.startSeq) continue
      slot.waitedMs += Math.max(0, ev.ts - slot.startTs)
      slot.startTs = null
      slot.startSeq = null
    }
  }
  const views: QueueWaitView[] = []
  for (const [id, slot] of slots) {
    if (!slot.sawWait) continue
    views.push({
      id,
      view: slot.startTs === null
        ? { phase: 'done', waitedMs: slot.waitedMs, source: slot.source }
        : {
            phase: 'active', position: slot.position, startTs: slot.startTs, waitedMs: slot.waitedMs,
            turnId: slot.turnId, source: slot.source,
            estimatedRemainingMs: slot.estimatedRemainingMs, estimatedAt: slot.estimatedAt,
          },
    })
  }
  return views
}

/** The turn-level view drives the live status line and the usage footer. */
function foldQueueViews(views: readonly QueueWaitView[]): QueueView | null {
  if (!views.length) return null
  const active = views.findLast(entry => entry.view.phase === 'active')
  if (active) return active.view
  const done = views
    .map(entry => entry.view)
    .filter((view): view is Extract<QueueView, { phase: 'done' }> => view.phase === 'done')
  if (!done.length) return null
  return {
    phase: 'done',
    waitedMs: done.reduce((sum, view) => sum + view.waitedMs, 0),
    source: done[done.length - 1].source,
  }
}

function rememberQueueWaitTotals(events: UAEvent[], totals: Map<string, number>): void {
  for (const ev of events) {
    if (ev.type !== 'queue_status' || !ev.payload?.id) continue
    const waitedMs = (ev.payload.queue as QueueStatus | undefined)?.waitedMs
    if (!Number.isFinite(waitedMs)) continue
    const id = String(ev.payload.id)
    totals.set(id, Math.max(totals.get(id) || 0, Math.max(0, waitedMs as number)))
  }
}

/** Keep one node per queue id, anchored at the id's latest occurrence across live snapshots and completion. */
function retainCompletedQueueWait(turn: Turn): void {
  if (!turn.queueViews.length) return
  const views = new Map(turn.queueViews.map(entry => [entry.id, entry.view]))
  const queueEventId = (event: UAEvent): string => String(event.payload?.id ?? `queue-${event.seq}`)
  // 同一 id 的快照可能被用户追加消息等边界拆开：节点锚在最后一次出现处，
  // 让活跃排队留在时间轴尾部（与「live wait follows the waiting card」一致）。
  const anchor = new Map<string, UAEvent>()
  for (const segment of turn.segments) {
    if (segment.kind !== 'chain') continue
    for (const event of segment.events) {
      if (event.type !== 'queue_status') continue
      const id = queueEventId(event)
      if (views.has(id)) anchor.set(id, event)
    }
  }
  const segments: Segment[] = []
  for (const segment of turn.segments) {
    if (segment.kind !== 'chain') {
      segments.push(segment)
      continue
    }
    let chainEvents: UAEvent[] = []
    const flush = (): void => {
      if (!chainEvents.length) return
      segments.push({
        ...segment,
        id: chainEvents[0] === segment.events[0] ? segment.id : `chain-${chainEvents[0].payload?.id ?? chainEvents[0].seq}`,
        events: chainEvents,
      })
      chainEvents = []
    }
    for (const event of segment.events) {
      if (event.type !== 'queue_status') {
        chainEvents.push(event)
      } else {
        flush()
        const id = queueEventId(event)
        const view = views.get(id)
        if (view && anchor.get(id) === event) {
          segments.push({ kind: 'queue_wait', id: `queue-${id}`, event, view })
        }
      }
    }
    flush()
  }
  turn.segments = segments
}

/** Use the same second rounding as the runtime detail. */
function fmtWait(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec} 秒`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m} 分 ${s.toString().padStart(2, '0')} 秒`
}

/**
 * 需求19: infer what the agent is doing right now from the tail of the event
 * stream, so the live status line reads like codex ("正在运行 <cmd>" / "正在思考"
 * / "正在写入文件" …). Scans backwards for the newest still-relevant signal.
 */
export function deriveActivity(events: UAEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'turn_completed') break
    // A completed assistant item is not the native Session boundary. Goal hooks
    // and other provider work can continue after text lands, so the activity
    // shimmer remains visible until the authoritative turn_completed event.
    if (ev.type === 'agent_message' && ev.state === 'success') continue
    if (ev.type === 'command_exec' && ev.state === 'running') {
      const cmd = (ev.payload.command || '').split('\n')[0].slice(0, 48)
      return cmd ? `正在运行 ${cmd}` : '正在运行命令'
    }
    if (ev.type === 'tool_call' && ev.state === 'running') {
      return ev.payload.name ? `正在调用 ${ev.payload.name}` : '正在调用工具'
    }
    if (ev.type === 'file_change' && ev.state === 'running')
      return '正在写入文件'
    if (
      ev.type === 'approval_request' &&
      ev.state !== 'success' &&
      ev.state !== 'cancelled'
    )
      return isQuestionKind(ev.payload?.kind, ev.payload?.params) ? '等待回答' : '等待授权'
    if (ev.type === 'context_compaction' && ev.state === 'running')
      return '上下文压缩中…'
    if (ev.type === 'agent_message' && ev.state === 'running')
      return '正在回复…'
    if (ev.type === 'reasoning' && ev.state === 'running') return '正在思考…'
  }
  return '正在思考…'
}

/** A mergeable provider event can move in place, so compare seq instead of array order. */
export function isReconnectActive(events: UAEvent[]): boolean {
  let lastCompletion = -1
  for (const event of events) {
    if (event.type === 'turn_completed') lastCompletion = Math.max(lastCompletion, event.seq)
  }
  let reconnectSeq = -1
  let progressSeq = -1
  for (const event of events) {
    if (event.seq <= lastCompletion) continue
    if (event.type === 'system_notice' && event.payload?.kind === 'reconnect') {
      reconnectSeq = Math.max(reconnectSeq, event.seq)
    } else {
      progressSeq = Math.max(progressSeq, event.seq)
    }
  }
  return reconnectSeq > progressSeq
}

function isQuestionKind(kind?: string, params?: any): boolean {
  return kind === 'question' || (kind === 'elicitation' && !isMcpToolApproval(params))
}

function isQuestionApproval(event: UAEvent): boolean {
  return event.type === 'approval_request' && isQuestionKind(event.payload?.kind, event.payload?.params)
}

/** Claude / Kimi / Grok 把同一次提问同时记成工具行和提问卡片。 */
function isQuestionToolCall(event: UAEvent): boolean {
  if (event.type !== 'tool_call') return false
  const name = String(event.payload?.name || event.payload?.title || '').split('__').pop() || ''
  return /^(AskUserQuestion|ask_user_question|request_user_input|requestUserInput)$/i.test(name)
}

function approvalToolCallId(event: UAEvent): string {
  const params = event.payload?.params
  const id = params?.toolCallId || params?.toolCall?.toolCallId || params?.callId
  return typeof id === 'string' ? id : ''
}

/**
 * 提问已经有卡片时，不再展示对应工具行。对不上卡片的工具调用仍保留。
 * 同一 tool id 的 running / success 更新一起隐藏。
 */
export function coveredQuestionToolSeqs(events: UAEvent[]): Set<number> {
  const approvals = events.filter(isQuestionApproval)
  const used = new Set<number>()
  const hidden = new Set<number>()
  const groups = new Map<string, UAEvent[]>()
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    const id = typeof event.payload?.id === 'string' ? event.payload.id : ''
    const linked = !!id && approvals.some(approval => approvalToolCallId(approval) === id)
    if (!isQuestionToolCall(event) && !linked) continue
    const key = id ? `id:${id}` : `seq:${event.seq}`
    const group = groups.get(key) || []
    group.push(event)
    groups.set(key, group)
  }
  const sameTool = (anchor: UAEvent, event: UAEvent): boolean =>
    event.type === 'tool_call' && !!anchor.payload?.id && event.payload?.id === anchor.payload.id
  const adjacentApproval = (anchor: UAEvent, direction: 1 | -1): UAEvent | undefined => {
    const index = events.findIndex(event => event.seq === anchor.seq)
    for (let i = index + direction; i >= 0 && i < events.length; i += direction) {
      const event = events[i]
      if (isQuestionApproval(event) && !used.has(event.seq)) return event
      if (!breaksQuestionAdjacency(event) || sameTool(anchor, event)) continue
      break
    }
    return undefined
  }
  for (const group of groups.values()) {
    const anchor = group[0]
    const id = typeof anchor.payload?.id === 'string' ? anchor.payload.id : ''
    const match = (id ? approvals.find(approval => !used.has(approval.seq) && approvalToolCallId(approval) === id) : undefined)
      || adjacentApproval(anchor, 1) || adjacentApproval(anchor, -1)
    if (!match) continue
    used.add(match.seq)
    for (const event of group) hidden.add(event.seq)
  }
  return hidden
}

/**
 * 子 Agent 卡片已经展示这次派发时，不再重复展示对应的工具行（Claude 会同时发
 * tool_call 与 subagent 事件，配对键是 tool_use_id）。对不上卡片的工具调用仍保留。
 * 同一 tool id 的 running / success 更新一起隐藏。
 */
export function coveredSubAgentToolSeqs(
  subAgents: Iterable<Pick<UASubAgent, 'dispatchId'>>,
  events: UAEvent[],
): Set<number> {
  const dispatchIds = new Set<string>()
  for (const agent of subAgents) {
    if (agent.dispatchId) dispatchIds.add(agent.dispatchId)
  }
  const hidden = new Set<number>()
  if (!dispatchIds.size) return hidden
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    const id = typeof event.payload?.id === 'string' ? event.payload.id : ''
    if (id && dispatchIds.has(id)) hidden.add(event.seq)
  }
  return hidden
}

/**
 * 提问紧挨着的上一段助手正文是问题背景。中间有命令、其它工具或另一条消息时不取。
 * 提问自己的工具行和思考不隔断这段正文。
 */
export function questionBackgroundText(events: UAEvent[], approval: UAEvent): string {
  if (!isQuestionApproval(approval)) return ''
  const index = events.findIndex(event => event.seq === approval.seq)
  if (index < 0) return ''
  const hidden = coveredQuestionToolSeqs(events)
  for (let i = index - 1; i >= 0; i--) {
    const event = events[i]
    if (hidden.has(event.seq) || !breaksQuestionAdjacency(event)) continue
    if (event.type !== 'agent_message' || event.payload?.kind === 'plan') return ''
    return String(event.payload?.text || '').trim()
  }
  return ''
}

/** 用量、回合边界和思考不构成「中间还有别的工作」。 */
function breaksQuestionAdjacency(event: UAEvent): boolean {
  if (event.type === 'reasoning' || event.type === 'turn_started' || event.type === 'turn_completed' ||
    event.type === 'diff_update' || event.type === 'plan_update' || event.type === 'queue_status' ||
    event.type === 'hook') return false
  if (event.type === 'system_notice' && ['usage', 'usage_report', 'context_usage', 'context', 'token_speed', 'queue', 'reconnect', 'launch'].includes(event.payload?.kind)) return false
  return true
}

function pendingApprovalActivity(events: UAEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'turn_completed') break
    if (
      ev.type === 'approval_request' &&
      ev.state !== 'success' &&
      ev.state !== 'cancelled'
    ) {
      return isQuestionKind(ev.payload?.kind, ev.payload?.params) ? '等待回答' : '等待授权'
    }
  }
  return '等待授权'
}

/** Session cumulative usage (G2-1). Sum per-turn usage footers in order. */
type CumUsage = {
  input: number
  output: number
  cached: number
  cost: number | null
}
function computeCumulativeUsage(events: UAEvent[]): Map<number, CumUsage> {
  const out = new Map<number, CumUsage>()
  let input = 0
  let output = 0
  let cached = 0
  let cost = 0
  let allCostsKnown = true
  for (const ev of events) {
    if (ev.type !== 'system_notice' || ev.payload?.kind !== 'usage') continue
    const u = ev.payload.usage || {}
    input += u.inputTokens ?? u.input_tokens ?? 0
    output += u.outputTokens ?? u.output_tokens ?? 0
    cached += u.cachedInputTokens ?? u.cached_input_tokens ?? 0
    const c = u.cost ?? ev.payload.cost
    if (c != null && Number.isFinite(c)) {
      cost += c
    } else allCostsKnown = false
    out.set(ev.seq, { input, output, cached, cost: allCostsKnown ? cost : null })
  }
  return out
}

function TurnBlock({
  turn,
  active,
  liveStatus,
  waitingForMembers,
  showFooters,
  onRespond,
  cumulativeBySeq,
  onOpenSubAgent,
  waitingForHandoff,
  onJumpToSession,
  chainController,
  onProcessedFoldToggle,
  onOpenTurnReview,
  onRewindToTurn,
  onOpenFile,
  artifactSummary,
  rewindable,
  showChangeCard,
  offerPlanDecision,
  planModeRequest,
  onImplementPlan,
  onRevisePlan,
  planRequest,
}: {
  turn: Turn
  active: boolean
  liveStatus?: ReactNode
  waitingForMembers: boolean
  showFooters: boolean
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  cumulativeBySeq: Map<number, CumUsage>
  onOpenSubAgent?: (agentThreadId: string) => void
  waitingForHandoff?: WaitingForHandoff
  onJumpToSession?: (sessionId: string) => void
  chainController: ChainOpenController
  onProcessedFoldToggle?: (opening: boolean) => void
  onOpenTurnReview?: (arg: { turnId: string; diff: string; filePath?: string }) => void
  onRewindToTurn?: (arg: { turnId?: string; userEventSeq: number }) => void
  onOpenFile?: (path: string, line?: number) => void
  artifactSummary?: TurnArtifactSummary | null
  rewindable: boolean
  showChangeCard: boolean
  offerPlanDecision: boolean
  planModeRequest: UAEvent | null
  onImplementPlan?: () => Promise<void>
  onRevisePlan?: (feedback: string) => Promise<void>
  planRequest?: UAEvent
}): JSX.Element {
  const requestPresentation = useContext(RequestPresentationContext)
  const timelineTurn = useMemo<Turn>(() => planRequest && !turn.planModeRequest
    ? { ...turn, segments: [...turn.segments, {
      kind: 'approval', id: `approval-${planRequest.payload.requestId}`, event: planRequest,
    }] }
    : turn, [turn, planRequest])
  const lastReplyIdx = useMemo(() => {
    let idx = -1
    turn.segments.forEach((s, i) => {
      if (s.kind !== 'reply') return
      if (turn.finalReplySeq !== null) {
        if (s.event.seq === turn.finalReplySeq) idx = i
      } else if (turn.completionSeq === null || s.event.seq < turn.completionSeq) idx = i
    })
    return idx
  }, [turn.segments, turn.completionSeq, turn.finalReplySeq])
  const latestReplySeq = turn.events.findLast((event) => event.type === 'agent_message')?.seq

  const useProcessedFold = turn.done && lastReplyIdx >= 0 && !waitingForMembers && !liveStatus
  const finalReply = useProcessedFold
    ? (turn.segments[lastReplyIdx] as Extract<Segment, { kind: 'reply' }>).event
    : null
  const hooks = useMemo(() => {
    const latest = new Map<string, UAEvent>()
    for (const event of turn.events) {
      if (event.type === 'hook') latest.set(`${event.payload.turnId ?? ''}:${event.payload.id ?? event.seq}`, event)
    }
    return [...latest.values()]
  }, [turn.events])
  const showHooks = hooks.length > 0 && showFooters && !active && !waitingForMembers && !liveStatus
  const moveFinalActions = !!finalReply && (showHooks || showFooters && turn.footers.length > 0)
  const actionEvent = finalReply ?? (showHooks
    ? turn.events.findLast(event => event.type === 'agent_message') ?? turn.events.at(-1)
    : undefined)
  const changeFiles = useMemo(
    () => turnChangeFiles(artifactSummary, turn.diff || ''),
    [artifactSummary, turn.diff]
  )

  return (
    <>
      {turn.user && (
        <UserBubble
          ev={turn.user}
          onRewind={
            onRewindToTurn && rewindable && turn.user && (turn.rewindTurnId || turn.nativeTurnId)
              ? () => onRewindToTurn({ turnId: turn.rewindTurnId || turn.nativeTurnId, userEventSeq: turn.user!.seq })
              : undefined
          }
        />
      )}
      <div className="turn-response">
        {useProcessedFold ? (
          <DoneTurn
            turn={timelineTurn}
            lastReplyIdx={lastReplyIdx}
            onRespond={onRespond}
            onOpenSubAgent={onOpenSubAgent}
            waitingForHandoff={waitingForHandoff}
            onJumpToSession={onJumpToSession}
            chainController={chainController}
            onProcessedFoldToggle={onProcessedFoldToggle}
            onOpenFile={onOpenFile}
            showFinalActions={!moveFinalActions}
          />
        ) : (
          <LiveTurn
            turn={timelineTurn}
            active={active}
            liveStatus={liveStatus}
            waitingForMembers={waitingForMembers}
            latestReplySeq={latestReplySeq}
            onRespond={onRespond}
            onOpenSubAgent={onOpenSubAgent}
            waitingForHandoff={waitingForHandoff}
            onJumpToSession={onJumpToSession}
            onOpenFile={onOpenFile}
          />
        )}
        {!requestPresentation.docked && offerPlanDecision && (planModeRequest && onRespond ? (
          <PlanDecision
            key={String(turn.planMessage?.payload?.id || turn.id)}
            onImplement={async () => { await onRespond(planModeRequest.payload.requestId, { decision: 'approved' }) }}
            onRevise={async (feedback) => {
              const feedbackInAnswer = planFeedbackInAnswer(planModeRequest.payload.method)
              await onRespond(planModeRequest.payload.requestId, { decision: 'rejected', ...(feedbackInAnswer ? { feedback } : {}) })
              if (!feedbackInAnswer) await onRevisePlan?.(feedback)
            }}
            onSkip={async () => { await onRespond(planModeRequest.payload.requestId, { decision: 'cancelled' }) }}
          />
        ) : onImplementPlan && onRevisePlan ? (
          <PlanDecision
            key={String(turn.planMessage?.payload?.id || turn.id)}
            onImplement={onImplementPlan}
            onRevise={onRevisePlan}
          />
        ) : null)}
        {showChangeCard && changeFiles.length > 0 && (
          <TurnChangeCard
            files={changeFiles}
            onOpenReview={
              onOpenTurnReview && (turn.nativeTurnId || turn.diff)
                ? (filePath) => onOpenTurnReview({ turnId: turn.nativeTurnId || turn.id, diff: turn.diff || '', filePath })
                : undefined
            }
          />
        )}
        {showFooters && turn.footers.map((ev) => (
          <EventCard
            key={eventKey(ev)}
            ev={ev}
            cumulative={cumulativeBySeq.get(ev.seq)}
            queueWaitMs={turn.queueView?.phase === 'done' ? turn.queueView.waitedMs : undefined}
            onOpenFile={onOpenFile}
          />
        ))}
        {(moveFinalActions || showHooks) && actionEvent && (
          <MessageActions
            event={actionEvent}
            kind="agent"
            text={actionEvent.type === 'agent_message' ? String(actionEvent.payload.text || '') : undefined}
            readable={actionEvent.type === 'agent_message' && actionEvent.payload.phase !== 'commentary'}
            hooks={showHooks ? hooks : undefined}
          />
        )}
      </div>
    </>
  )
}

/**
 * 需求4(反馈) — the newest plan across all turns, for the fixed PlanStatusBar
 * above the composer. Returns [] when no turn ever produced a plan (bar hidden).
 */
export function latestPlanSteps(events: UAEvent[]): PlanStep[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'plan_update') {
      return (events[i].payload?.steps || []) as PlanStep[]
    }
    // A new user message starts a new turn. Until that turn publishes its own
    // plan, do not revive the previous turn's steps just because the session is
    // running again. A trailing turn_completed intentionally does not clear the
    // last plan, so its terminal state remains inspectable between turns.
    if (events[i].type === 'user_message' || events[i].type === 'goal_message') return []
  }
  return []
}

/**
 * Doc4 — the "current task list" pill (复刻 Codex). 需求4(反馈): fixed ABOVE the
 * composer (not inline in the stream). Collapsed it shows only `第 x / n 步` (or
 * `n / n 步已完成` when done); hovering pops the full step list. `steps` empty →
 * renders nothing so the composer isn't pushed down for planless turns.
 */
function planTerminal(status?: SessionActivityStatus): boolean {
  return status !== undefined && !isSessionBusy(status)
}

/** The task-list pill + hover popover (no `.plan-bar` wrapper), shared between the
 * standalone PlanStatusBar and the combined TurnStatusBar (需求: 计时胶囊并排). */
function PlanPillGroup({
  steps,
  status,
}: {
  steps: PlanStep[]
  status?: SessionActivityStatus
}): JSX.Element {
  const n = steps.length
  const completed = steps.filter((s) => s.status === 'completed').length
  const allDone = completed === n && n > 0
  const terminal = planTerminal(status)
  const x = allDone ? n : planCurrentIndex(steps) + 1
  return (
    <div className="plan-pill-wrap">
      <div className="plan-pill">
        {allDone ? (
          <>
            <span className="plan-pill-check">✓</span>
            <span className="plan-pill-text">
              {n} / {n} 步已完成
            </span>
          </>
        ) : terminal ? (
          <>
            <span className="plan-pill-stop" aria-hidden>
              •
            </span>
            <span className="plan-pill-text">
              第 {x} / {n} 步
            </span>
          </>
        ) : (
          <>
            <span className="plan-pill-spin" aria-hidden />
            <span className="plan-pill-text">
              第 {x} / {n} 步
            </span>
          </>
        )}
      </div>
      <div className="plan-pop">
        <div className="plan-pop-title">任务列表</div>
        {steps.map((s, i) => (
          <div key={i} className={`plan-step plan-${s.status}`}>
            <span className="plan-step-ic">
              {s.status === 'completed'
                ? '✓'
                : s.status === 'in_progress'
                  ? terminal
                    ? '•'
                    : <span className="plan-pill-spin" aria-hidden />
                  : '○'}
            </span>
            <span className="plan-step-text">
              {s.status === 'in_progress' && s.activeForm
                ? s.activeForm
                : s.text}
            </span>
          </div>
        ))}
        <div className="plan-pop-foot">
          {allDone ? `${n} / ${n} 步已完成` : `第 ${x} / ${n} 步`}
        </div>
      </div>
    </div>
  )
}

export function PlanStatusBar({
  steps,
  status,
}: {
  steps: PlanStep[]
  status?: SessionActivityStatus
}): JSX.Element | null {
  if (!steps.length) return null
  const n = steps.length
  const allDone = steps.filter((s) => s.status === 'completed').length === n && n > 0
  const terminal = planTerminal(status)
  return (
    <div className={`plan-bar ${allDone ? 'is-done' : ''}${terminal ? ' is-terminal' : ''}`}>
      <PlanPillGroup steps={steps} status={status} />
    </div>
  )
}

/**
 * 计时胶囊重构 — the composer-top status row. Renders the task-list pill (when the
 * turn published a plan) plus the PERSISTENT timer capsule: it ticks the current
 * turn's elapsed time while busy and freezes at the last turn's duration once the
 * turn ends. Border color + leading glyph carry the session state (blue dot =
 * running, green ✓ = finished, red ! = error, yellow ? = awaiting approval).
 * Hovering the capsule pops the summary card above it (`summary` slot); the old
 * timing-split popover is gone.
 */
export function TurnStatusBar({
  events,
  status,
  showPlan = true,
  summary,
  summaryOpen,
  onTimerHoverChange,
}: {
  events: UAEvent[]
  status?: SessionActivityStatus
  showPlan?: boolean
  /** Summary card rendered inside the capsule's hover popover. */
  summary?: ReactNode
  summaryOpen?: boolean
  onTimerHoverChange?: (hovering: boolean) => void
}): JSX.Element | null {
  const steps = showPlan ? latestPlanSteps(events) : []
  const busy = isSessionBusy(status)
  const turnStartTs = busy ? currentTurnStartTs(events) : null
  const lastDurationMs = useMemo(
    () => (busy ? null : lastTurnDurationMs(events)),
    [busy, events],
  )
  const speed = useMemo(() => tokenSpeedForTurn(events, busy), [events, busy])
  const speedId = useId()

  // Tick once per second while the turn runs so the elapsed counter advances.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    setNowTick(Date.now())
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  if (!steps.length && turnStartTs === null && lastDurationMs === null) return null
  const allDone =
    steps.length > 0 &&
    steps.filter((s) => s.status === 'completed').length === steps.length
  const terminal = steps.length > 0 && planTerminal(status)
  const variant = busy
    ? status === 'awaiting-approval'
      ? 'waiting'
      : 'running'
    : status === 'error'
      ? 'error'
      : 'done'
  const shownMs = turnStartTs !== null ? Math.max(0, nowTick - turnStartTs) : lastDurationMs ?? 0
  return (
    <div className={`plan-bar ${allDone ? 'is-done' : ''}${terminal ? ' is-terminal' : ''}`}>
      {steps.length > 0 && <PlanPillGroup steps={steps} status={status} />}
      {(turnStartTs !== null || lastDurationMs !== null) && (
        <div
          className={`turn-timer st-${variant}`}
          onMouseEnter={(event) => { if (!(event.target as Element).closest('.turn-speed')) onTimerHoverChange?.(true) }}
          onMouseLeave={() => onTimerHoverChange?.(false)}
        >
          <span className={`turn-timer-mark${variant === 'running' ? ' is-dot' : ''}`} aria-hidden onMouseEnter={() => onTimerHoverChange?.(true)}>
            {variant === 'done' ? '✓' : variant === 'error' ? '!' : variant === 'waiting' ? '?' : ''}
          </span>
          <span className="turn-timer-text" onMouseEnter={() => onTimerHoverChange?.(true)}>{fmtDuration(shownMs)}</span>
          {speed && <span className="turn-speed" onMouseEnter={() => onTimerHoverChange?.(false)} onFocus={() => onTimerHoverChange?.(false)}>
            <button type="button" className="turn-speed-value" aria-describedby={speedId}>
              <span className="turn-speed-label">{busy ? speed.metric === 'request' ? '上次请求' : '上次' : speed.metric === 'request' ? '请求均速' : '均速'}</span>
              <span>{speed.outputTokens * 1000 / speed.durationMs < 0.1 ? '<0.1' : `≈${(speed.outputTokens * 1000 / speed.durationMs).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`}</span>
              <span className="turn-speed-unit">token/s</span>
              {speed.partial && <span className="turn-speed-label">部分</span>}
            </button>
            <span className="turn-speed-tooltip" id={speedId} role="tooltip">
              <strong>{busy ? '上次调用' : '本轮平均'}{speed.metric === 'generation' ? '生成速度' : '请求速度'}</strong>
              <span>输出 token <b>{speed.outputTokens.toLocaleString('en-US')}</b></span>
              <span>{speed.metric === 'generation' ? '生成时段' : '请求耗时'} <b>{(speed.durationMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })}s</b></span>
              {speed.model && <span>模型 <b>{speed.model}</b></span>}
              <span>数据来源 <b>{speed.source}</b></span>
              <small>{busy ? '显示最近一次有效调用。' : `按 ${speed.samples} 次有效调用加权统计。`}{speed.partial ? '部分统计：存在缺失计时、不同模型或中断样本。' : ''}不计工具执行与审批等待。{speed.metric === 'request' ? '包含首 token 等待。' : ''}≈ 为客户端观测均速，包含传输与消费开销；输出与推理 token 按 Agent 原生口径计数，不代表服务端纯解码性能。</small>
            </span>
          </span>}
          {summary && (
            <div className={`timer-summary-pop${summaryOpen ? ' open' : ''}`}>{summary}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** Team wake-ups and steering continue the same user task's timer. */
function currentTurnStartTs(events: UAEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isTaskTurnInput(events[i])) {
      return events[i].ts
    }
  }
  return null
}

/** Wall-clock duration of the last turn, matching the「已处理」fold label. */
function lastTurnDurationMs(events: UAEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isTaskTurnInput(events[i])) {
      let endTs = events[i].ts
      for (let j = i + 1; j < events.length; j++) endTs = Math.max(endTs, events[j].ts)
      return endTs - events[i].ts
    }
  }
  return null
}

/** UniAgent task tools that may carry a confirmed, renderable milestone. */
function isHandoffTaskCall(event: UAEvent): boolean {
  return isHandoffEndEvent(event) || event.type === 'tool_call' &&
    event.payload?.server === 'uniagent' &&
    handoffTaskAction(event) !== undefined
}

export function planCurrentIndex(steps: PlanStep[]): number {
  const running = steps.findLastIndex((step) => step.status === 'in_progress')
  if (running >= 0) return running
  return Math.min(steps.filter((step) => step.status === 'completed').length, steps.length - 1)
}

/**
 * Doc5 — merge a turn's sub-agent snapshot events into a by-thread map, keeping
 * the latest state per child. Sub-agent events carry `payload.agents: []`.
 */
function mergeSubAgents(events: UAEvent[], saved: UASubAgent[]): UASubAgent[] {
  const byId = new Map(saved.filter(agent => agent.agentThreadId).map(agent => [agent.agentThreadId, agent]))
  for (const ev of events) {
    const agents = (ev.payload?.agents || []) as UASubAgent[]
    for (const a of agents) {
      if (!a.agentThreadId) continue
      const prev = byId.get(a.agentThreadId)
      byId.set(a.agentThreadId, mergeSubAgentSnapshot(prev, a, ev.ts))
    }
  }
  return [...byId.values()]
}

/**
 * 需求5(反馈) — merge sub-agent state across the WHOLE session's events (all
 * turns), for the pinned banner + detail panel. Both must reflect every child
 * spawned so far, not just the current turn. Saved snapshots retain children
 * whose events are not loaded; newer events enrich and extend the same roster.
 */
export function subAgentsFromEvents(events: UAEvent[], saved: UASubAgent[] = []): UASubAgent[] {
  return mergeSubAgents(events.filter((e) => e.type === 'subagent'), saved)
}

/** One row per sub-agent phase transition; clicking opens the existing detail panel. */
const SUB_PHASE_LABEL: Record<SubPhase, string> = {
  spawn: '开始工作',
  append: '追加提问',
  done: '已完成',
  interrupted: '已中断',
  error: '出错',
}
const SUB_PHASE_CLASS: Record<SubPhase, string> = {
  spawn: 'run',
  append: 'upd',
  done: 'done',
  interrupted: 'intr',
  error: 'err',
}

function SubAgentLine({
  phase,
  agents,
  onOpen,
  sourceLabel = '子 Agent',
  statusLabel,
}: {
  sourceLabel?: string
  statusLabel?: string
  phase: SubPhase
  agents: SubLineAgent[]
  onOpen?: (agentThreadId: string) => void
}): JSX.Element {
  const primary = agents[0]
  return (
    <div className="sa-line-wrap">
      <button
        className="sa-line"
        type="button"
        onClick={() => onOpen?.(primary.threadId)}
        title={[subAgentDisplayName({ agentThreadId: primary.threadId, name: primary.name }), subAgentTaskSummary(primary.prompt)].filter(Boolean).join(' · ')}
      >
        {agents.map((a, i) => (
          <Fragment key={a.threadId}>
            {i > 0 && <span className="sep">·</span>}
            <SubAgentIcon threadId={a.threadId} size={18} />
            {i === 0 && <span className="kind">{sourceLabel}</span>}
            <span className="nm">
              {subAgentDisplayName({ agentThreadId: a.threadId, name: a.name })}
              {subAgentTaskSummary(a.prompt) && <span className="sa-task"> · {subAgentTaskSummary(a.prompt)}</span>}
            </span>
          </Fragment>
        ))}
        <span className={`st ${SUB_PHASE_CLASS[phase]}`}>
          {statusLabel || SUB_PHASE_LABEL[phase]}
        </span>
        <span className="chev"><Chevron size={12} /></span>
      </button>
    </div>
  )
}

function TeamWaitingMembersStep({ event }: { event?: UAEvent } = {}): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  const [now, setNow] = useState(() => Date.now())
  const project = context?.project
  const leaderSessionId = project?.memberSessions[project.team.leaderMemberId]
  const assignments: TeamAssignment[] = project ? event ? (event.payload.assignmentRefs || []).flatMap((ref: { assignmentId: string; attempt: number }) => {
    const a = project.assignments.find(a => a.id === ref.assignmentId)
    const attempt = a?.attempt === ref.attempt ? a : a?.history.find(h => h.attempt === ref.attempt)
    return a && attempt ? [{ ...a, ...attempt }] : []
  }) : teamWaitingAssignments(project, leaderSessionId) : []
  const visible = assignments.length > 0
  const pending = assignments.filter(a => !a.endedAt).length
  const leaderSession = context?.sessions.find(session => session.id === leaderSessionId)
  const waiting = pending > 0 && !!leaderSession && !!context &&
    sessionActivityStatus(leaderSession, project, context.sessions) === 'waiting_members'

  useEffect(() => {
    if (!visible || !waiting) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible, waiting])

  if (!visible || !context || !project) return null
  const startedAt = event?.ts ?? Math.min(...assignments.map(assignment => assignment.startedAt || assignment.createdAt))
  const statusLabel: Record<string, string> = { queued: '待执行', running: '运行中', blocked: '等待 Leader', cancelling: '停止中', succeeded: '已交付', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
  return <div className={`process-step team-waiting-members-step${waiting ? ' active' : ''}`} aria-label="等待组员交付">
    <span className={`process-step-node${waiting ? ' team-waiting-spinner' : ''}`} aria-hidden>{!waiting && <span className="process-step-done-dot" />}</span>
    <div className="process-step-content">
    <div className="team-waiting-head">
      <span className="team-waiting-copy"><strong>{pending ? '等待组员交付' : assignments.every(a => a.status === 'succeeded') ? '组员均已交付' : '组员均已返回'}</strong><small>{project.team.name} · {assignments.length - pending} / {assignments.length} {assignments.some(a => a.endedAt && a.status !== 'succeeded') ? '已返回' : '已交付'}{pending ? ` · ${pending} 位待返回` : ''}</small></span>
      {waiting && <span className="team-waiting-elapsed">已等待 {fmtDuration(Math.max(0, now - startedAt))}</span>}
    </div>
    <div className="team-waiting-list">{assignments.map(assignment => {
      const member = project.team.members.find(item => item.id === assignment.memberId)
      const memberSessionId = project.memberSessions[assignment.memberId]
      const source = project.assignments.find(item => item.id === assignment.id)!
      const summary = project.inbox.find(item => item.assignmentId === assignment.id && item.attempt === assignment.attempt && ['result', 'blocked'].includes(item.kind))?.summary
        || event?.payload.deliverySummaries?.[`${assignment.id}:${assignment.attempt}`] || event?.payload.summary || ''
      const content = teamDeliveryContent(source, assignment.attempt, summary)
      const delivered = !!assignment.endedAt || assignment.status === 'blocked'
      const artifacts = project.artifacts.filter(artifact => content.artifactRefs.includes(artifact.id))
      const hasDetails = delivered && !!(content.result || content.error || content.question || artifacts.length || content.review)
      return <div className="team-waiting-entry" key={`${assignment.id}:${assignment.attempt}`} data-assignment-id={assignment.id} data-attempt={assignment.attempt}>
        <button
          type="button"
          className="team-waiting-member"
          data-member-session-id={memberSessionId}
          aria-label={`查看${member?.role.name || '团队成员'}的详情对话：${assignment.title}`}
          disabled={!memberSessionId}
          onClick={() => memberSessionId && context.onOpenMember(memberSessionId)}
        >
          <SubAgentIcon threadId={memberSessionId || assignment.memberId} size={24} plain />
          <span className="team-waiting-member-copy"><strong>{member?.role.name || '团队成员'}</strong><span>{assignment.title}</span></span>
          <span className={`team-waiting-state ${assignment.status}`}><i />{statusLabel[assignment.status] || assignment.status}</span>
          <UiIcon name="chevron-right" size={13} />
        </button>
        {delivered && !!content.summary && <div className="team-waiting-summary">{content.summary}</div>}
        {hasDetails && <details className="team-waiting-details" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <summary><span className="team-waiting-expand"><UiIcon name="chevron-right" size={12} /><span className="team-waiting-closed">展开完整报告</span><span className="team-waiting-open">收起完整报告</span></span>{artifacts.length > 0 && <span>交付材料 · {artifacts.length} 份</span>}</summary>
          <div className="team-waiting-report">
            {content.result && <Markdown text={content.result} />}
            {content.question && <p className="team-muted">{content.question}</p>}
            {content.error && <p className="team-error">{content.error}</p>}
            <TeamArtifacts ids={content.artifactRefs} />
            {content.review && <div className="team-member-review">{content.review}</div>}
          </div>
        </details>}
      </div>
    })}</div>
    </div>
  </div>
}

function TeamDispatchStep({ event }: { event: UAEvent }): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  const a = context?.project.assignments.find(a => a.id === event.payload.assignmentId)
  if (!context || !a) return null
  const sid = context.project.memberSessions[a.memberId]
  return <div className="process-step team-dispatch-step"><span className="process-step-node team-dispatch-node" aria-hidden><svg viewBox="0 0 24 24" width="7" height="7"><path d="M3.4 20.4l17.2-7.4c.8-.35.8-1.55 0-1.9L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .72.73 1.2 1.39.91z" fill="currentColor" /></svg></span><div className="process-step-content">
    <button type="button" className="sa-line team-dispatch-line" disabled={!sid} onClick={() => context.onOpenMember(sid)}>
      <span className="team-dispatch-verb">派发任务给</span><span className="nm">{event.payload.memberName}</span><span className="team-dispatch-task">{event.payload.taskTitle || a.title}</span><span className="st done">已派发</span><Chevron size={12} />
    </button>
  </div></div>
}

/** Keep the newest non-empty reasoning visible when the current step is collapsed. */
function latestReasoning(events: UAEvent[]): UAEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'reasoning' && (ev.payload.text || '').trim()) return ev
  }
  return undefined
}

/** A current step's latest thinking, shown only when that step is collapsed. */
function LiveReasoning({
  ev,
  onOpenFile,
}: {
  ev: UAEvent
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  return (
    <div className="live-reason">
      <span className="live-reason-ic" aria-hidden>
        <UiIcon name="lightbulb" size={14} />
      </span>
      <div className="live-reason-body">
        <Markdown text={ev.payload.text || ''} onOpenFile={onOpenFile} />
        {ev.state === 'running' && <span className="stream-cursor" aria-hidden />}
      </div>
    </div>
  )
}

/** 启动通知 + 紧随其后（同一段 chain 内）的启动警告，合并为一张启动卡片。 */
type LaunchGroup = { launch: UAEvent; warnings: UAEvent[] }

type ProcessStep = {
  kind: 'step'
  id: string
  title?: UAEvent
  events: UAEvent[]
  items: Array<UAEvent | Extract<Segment, { kind: 'subagent' }> | LaunchGroup>
  teamEvents?: UAEvent[]
  startTs: number
  endTs?: number
}

type ProcessItem = Exclude<Segment, { kind: 'subagent' }> | ProcessStep
  /** 无工作内容的其它事件不单独形成步骤。 */
  | { kind: 'event'; id: string; event: UAEvent }

const PROCESS_STEP_HISTORY_LIMIT = 8

/** 同一工作步骤内最多直读的调用/思考条目数；更早的收进「更早的 N 条」折叠行。 */
const PROCESS_STEP_ENTRIES_LIMIT = 12

/** 调用、有内容思考等真实工作之外的通知类事件，不足以单独构成一个工作步骤。 */
function isPassiveChainEvent(event: UAEvent): boolean {
  // 空思考不渲染任何内容（EventCard G2-11 返回 null），不能据此包出空步骤。
  if (event.type === 'reasoning') return !(event.payload?.text || '').trim()
  return event.type === 'system_notice' || event.type === 'raw_output' || event.type === 'queue_status'
}

/** 把 launch 通知与其后连续的 warning 通知归并为一组（一张启动卡片）。 */
function groupLaunchItems(events: UAEvent[]): Array<UAEvent | LaunchGroup> {
  const grouped: Array<UAEvent | LaunchGroup> = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'system_notice' && event.payload?.kind === 'launch') {
      const warnings: UAEvent[] = []
      while (i + 1 < events.length &&
        events[i + 1].type === 'system_notice' &&
        events[i + 1].payload?.kind === 'warning') {
        warnings.push(events[++i])
      }
      grouped.push({ launch: event, warnings })
    } else {
      grouped.push(event)
    }
  }
  return grouped
}

function launchItemId(event: UAEvent): string {
  return `launch-${event.payload?.id ?? event.seq}`
}

/** Project ordered calls and sub-agent phases into steps; other interactive cards stay outside. */
function processItems(segments: Segment[], finalReplySeq: number | null): ProcessItem[] {
  const flatEvents = segments.flatMap(segment =>
    segment.kind === 'chain' ? segment.events : 'event' in segment ? [segment.event] : [])
  const hiddenQuestionTools = coveredQuestionToolSeqs(flatEvents)
  const hiddenSubAgentTools = coveredSubAgentToolSeqs(
    segments.flatMap(segment => (segment.kind === 'subagent' ? segment.agents : [])),
    flatEvents)
  const items: ProcessItem[] = []
  let current: ProcessStep | undefined
  const waitingAttempts = new Set(segments.flatMap(segment => segment.kind === 'team_wait'
    ? (segment.event.payload.assignmentRefs || []).map((ref: { assignmentId: string; attempt: number }) => `${ref.assignmentId}:${ref.attempt}`)
    : []))
  const deliverySummaries = Object.fromEntries(segments.flatMap(segment => segment.kind === 'team_delivery'
    ? [[`${segment.assignmentId}:${segment.attempt}`, segment.summary]] : []))
  // A waiting member row owns its delivery; quick tasks without a wait get the same row in-place.
  segments = segments.flatMap<Segment>(segment => {
    if (segment.kind === 'team_wait') return [{ ...segment, event: { ...segment.event, payload: { ...segment.event.payload, deliverySummaries } } }]
    if (segment.kind !== 'team_delivery') return [segment]
    const key = `${segment.assignmentId}:${segment.attempt}`
    if (waitingAttempts.has(key)) return []
    waitingAttempts.add(key)
    return [{ kind: 'team_wait', id: segment.id, event: { ...segment.event, payload: {
      ...segment.event.payload, assignmentRefs: [{ assignmentId: segment.assignmentId, attempt: segment.attempt }], summary: segment.summary,
    } } }]
  })
  segments.forEach((segment, index) => {
    if (segment.kind === 'reply') {
      const next = segments[index + 1]
      // App-server only supplies phase reliably when the item completes; keep live text in-place meanwhile.
      const streamingNarration = segment.event.state === 'running' &&
        !segment.event.payload?.phase && !!segment.event.payload?.text?.trim()
      const narration = segment.event.seq !== finalReplySeq &&
        segment.event.payload?.phase !== 'final_answer' &&
        (segment.event.payload?.phase === 'commentary' || streamingNarration || next?.kind === 'chain' || next?.kind === 'subagent')
      if (narration) {
        if (current) current.endTs = segment.event.ts
        current = {
          kind: 'step',
          id: `step-${segment.id}`,
          title: segment.event,
          events: [],
          items: [],
          startTs: segment.event.ts,
        }
        items.push(current)
        return
      }
    }
    if (segment.kind === 'chain') {
      const events = segment.events.filter(event =>
        !hiddenQuestionTools.has(event.seq) && !hiddenSubAgentTools.has(event.seq))
      if (!events.length) return
      const hasLaunch = events.some(event => event.type === 'system_notice' && event.payload?.kind === 'launch')
      // 启动信息直接进入任务开始；没有内容的思考等事件不单独形成步骤。
      if (!current && !hasLaunch && events.every(isPassiveChainEvent)) {
        for (const event of events) {
          items.push({ kind: 'event', id: `event-${event.payload?.id ?? event.seq}`, event })
        }
        return
      }
      if (!current) {
        current = {
          kind: 'step',
          id: `step-${segment.id}`,
          events: [],
          items: [],
          startTs: events[0]?.ts ?? 0,
        }
        items.push(current)
      }
      current.events.push(...events)
      current.items.push(...groupLaunchItems(events))
      return
    }
    if (segment.kind === 'subagent') {
      if (!current) {
        current = {
          kind: 'step',
          id: `step-${segment.id}`,
          events: [],
          items: [],
          startTs: segment.ts,
        }
        items.push(current)
      }
      current.items.push(segment)
      return
    }
    // 压缩属于当前工作步骤；保留 current，让后续工具调用继续追加。
    if (segment.kind === 'runtime' && segment.event.type === 'context_compaction') {
      if (!current) {
        current = { kind: 'step', id: `step-${segment.id}`, events: [], items: [], startTs: segment.event.payload.startedAt ?? segment.event.ts }
        items.push(current)
      }
      current.events.push(segment.event)
      current.items.push(segment.event)
      return
    }
    // 步骤进行中收到的「提示」（会话提示、原生上下文通知）就地并入当前步骤；
    // 若让它独立成段，会切断工作过程并凭空多出一个「执行调用」步骤。
    if (current && (segment.kind === 'hint' || segment.kind === 'notice' &&
      segment.event.type === 'system_notice' && segment.event.payload?.kind !== 'warning')) {
      current.items.push(segment.event)
      current.endTs = segment.event.ts
      return
    }
    if (current) current.endTs = segment.event.ts
    current = undefined
    items.push(segment)
  })
  const teamEvents = items.filter((item): item is Extract<Segment, { kind: 'team_event' }> => item.kind === 'team_event')
  if (teamEvents.length === 0) return items
  const taskStart = items.find((item): item is ProcessStep => item.kind === 'step' && !item.title)
  if (taskStart) taskStart.teamEvents = teamEvents.map(item => item.event)
  else items.splice(items.findIndex(item => item.kind === 'team_event'), 0, {
    kind: 'step',
    id: `step-${teamEvents[0].id}`,
    events: [],
    items: [],
    teamEvents: teamEvents.map(item => item.event),
    startTs: teamEvents[0].event.ts,
  })
  return items.filter(item => item.kind !== 'team_event')
}

type CompactCall = { kind: 'call'; id: string; events: UAEvent[] }
type StepEntry = CompactCall | { kind: 'event'; event: UAEvent } | { kind: 'subagent'; segment: Extract<Segment, { kind: 'subagent' }> } | { kind: 'launch'; id: string; event: UAEvent; warnings: UAEvent[] }

/** Auto-expand reasoning only when it is the latest visible item in the process. */
function latestProcessReasoningKey(items: ProcessItem[]): string | undefined {
  const latestItem = items.at(-1)
  if (latestItem?.kind !== 'step') return undefined
  const latest = latestItem.items.findLast((item) =>
    'kind' in item || 'launch' in item || item.type !== 'reasoning' || (item.payload.text || '').trim())
  return latest && !('kind' in latest) && !('launch' in latest) && latest.type === 'reasoning' ? eventKey(latest) : undefined
}

function callIdentity(event: UAEvent): string {
  if (event.type === 'command_exec') return 'command_exec'
  const name = String(event.payload?.name ?? '')
  return [event.type, event.payload?.provider ?? '', event.payload?.server ?? '', event.payload?.namespace ?? '', name].join('\0')
}

function stepEntries(items: ProcessStep['items']): StepEntry[] {
  const entries: StepEntry[] = []
  for (const event of items) {
    if ('kind' in event) {
      entries.push({ kind: 'subagent', segment: event })
      continue
    }
    if ('launch' in event) {
      entries.push({ kind: 'launch', id: launchItemId(event.launch), event: event.launch, warnings: event.warnings })
      continue
    }
    if (event.type === 'reasoning' && !(event.payload?.text || '').trim()) continue
    if (event.type !== 'command_exec' && event.type !== 'tool_call') {
      entries.push({ kind: 'event', event })
      continue
    }
    const last = entries[entries.length - 1]
    if (last?.kind === 'call' && callIdentity(last.events[0]) === callIdentity(event) &&
      event.payload?.id && last.events.every((item) =>
        item.payload?.id && item.payload.id !== event.payload.id)) {
      last.events.push(event)
    } else {
      entries.push({ kind: 'call', id: eventKey(event), events: [event] })
    }
  }
  return entries
}

function compactCallName(event: UAEvent): string {
  if (event.type === 'command_exec') return 'Bash'
  const name = String(event.payload?.name || '工具调用')
  const server = event.payload?.server || event.payload?.namespace
  if (event.payload?.provider === 'mcp' && server) return `${server} · ${name}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

function compactCallArgument(event: UAEvent): string {
  if (event.type === 'command_exec') return String(event.payload?.command || '')
  const input = event.payload?.input ?? event.payload?.raw?.arguments
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const keys = ['command', 'query', 'q', 'path', 'file_path', 'pattern', 'url', 'prompt']
  const selected = keys.filter((key) => input[key] !== undefined).slice(0, 2)
  if (selected.length) return selected.map((key) => `${key}: ${JSON.stringify(input[key])}`).join(' · ')
  return JSON.stringify(input) || ''
}

/** Keep collapsing content mounted just long enough for its exit transition. */
function AnimatedCollapse({
  open,
  keepMounted = false,
  className = '',
  children,
}: {
  open: boolean
  keepMounted?: boolean
  className?: string
  children: React.ReactNode
}): JSX.Element | null {
  const [mounted, setMounted] = useState(open || keepMounted)

  useEffect(() => {
    if (open || keepMounted) {
      setMounted(true)
      return
    }
    if (!mounted) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), 160)
    return () => window.clearTimeout(timer)
  }, [keepMounted, mounted, open])

  if (!mounted) return null
  return (
    <div
      className={`animated-collapse ${open ? 'is-open' : 'is-closed'}${className ? ` ${className}` : ''}`}
      data-collapse-state={open ? 'open' : 'closed'}
      aria-hidden={!open}
      ref={(element) => { if (element) element.inert = !open }}
    >
      <div className="animated-collapse-inner">{children}</div>
    </div>
  )
}

function CompactCallRow({ events }: { events: UAEvent[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const first = events[0]
  const running = events.filter((event) => event.state === 'running').length
  const failed = events.filter((event) => event.state === 'failed').length
  const cancelled = events.filter((event) => event.state === 'cancelled').length
  const parallel = events.length > 1 && running === events.length &&
    events.every((event) => !!event.payload?.id) &&
    new Set(events.map((event) => event.payload.id)).size === events.length
  const duration = events.length === 1 && Number.isFinite(first.payload?.durationMs)
    ? fmtHookDuration(Math.max(0, first.payload.durationMs))
    : ''
  const argumentsText = [...new Set(events.map(compactCallArgument).filter(Boolean))].slice(0, 3).join(' · ')
  const status = [
    running > 0 ? `${running > 1 ? running + ' ' : ''}运行中` : '',
    failed > 0 ? `${failed > 1 ? failed + ' ' : ''}失败` : '',
    cancelled > 0 ? `${cancelled > 1 ? cancelled + ' ' : ''}已取消` : '',
    running === 0 && failed === 0 && cancelled === 0 ? duration || '完成' : '',
  ].filter(Boolean).join(' · ')
  const images = events.flatMap((event) => {
    const path = viewImagePath(event)
    return path ? [{ event, path }] : []
  })
  // Images a tool returned preview inside that row instead of a standalone card.
  const nativeImages = events.flatMap((event) => nativeImageSelectors(event).map((selector, index) => ({
    event, selector, name: nativeImageName(event, selector), key: `${eventKey(event)}:${index}`,
  })))
  const hasImages = images.length > 0 || nativeImages.length > 0
  const rowContent = <>
    <UiIcon name={first.type === 'command_exec' ? 'code' : 'plug'} size={14} />
    <span className="step-call-name">{compactCallName(first)}</span>
    {hasImages && <span className="step-call-images">
      {images.map(({ event, path }) => <ViewImageThumbnail key={`${event.sessionId}:${eventKey(event)}:${path}`} event={event} path={path} />)}
      {nativeImages.map(({ event, selector, name, key }) =>
        <NativeImageThumbnail key={key} event={event} selector={selector} name={name} />)}
    </span>}
    {events.length > 1 && <span className="step-call-count">×{events.length}{parallel ? ' 并行' : ' 次'}</span>}
    <code className="step-call-arg" title={argumentsText}>{argumentsText}</code>
    <span className="step-call-status">
      {running > 0 && <span className="spin" />}{status}
    </span>
    <Chevron open={open} size={12} />
  </>
  return (
    <div className={`step-call${open ? ' open' : ''}${running ? ' running' : ''}${failed || cancelled ? ' failed' : ''}`}>
      {hasImages ? (
        <div className="step-call-row step-call-image-row">
          {rowContent}
          <button className="step-call-image-details" type="button" aria-label={`${open ? '收起' : '展开'} ${compactCallName(first)} 详情`} aria-expanded={open} title={argumentsText} onClick={() => setOpen(!open)} />
        </div>
      ) : (
        <button className="step-call-row" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{rowContent}</button>
      )}
      <AnimatedCollapse open={open} keepMounted className="step-call-disclosure">
        <div className="step-call-detail">
          {events.map((event, index) => (
            <div key={eventKey(event)}>
              {events.length > 1 && <b>调用 {index + 1}</b>}
              {event.type === 'command_exec'
                ? <><pre>{event.payload?.command || ''}</pre>{event.payload?.output && <pre>{event.payload.output}</pre>}{event.payload?.exitCode != null && <small>退出码 {event.payload.exitCode}</small>}</>
                : <pre>{JSON.stringify({ input: event.payload?.input ?? event.payload?.raw?.arguments, result: toolCallDetail(event.payload, event.state) }, null, 2)}</pre>}
              {Number.isFinite(event.payload?.durationMs) && <small>{fmtHookDuration(Math.max(0, event.payload.durationMs))}</small>}
              {(event.state === 'failed' || event.state === 'cancelled') && <small>{event.state === 'failed' ? '失败' : '已取消'}</small>}
            </div>
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

/**折叠区一行：可折叠行 + 折进该行的「提示」（参考 Hook 在步骤内收纳）。 */
type ProcessRow = { item: ProcessItem; hints: UAEvent[]; key: string }

/**折叠锚点：用户追加消息、提问/审批卡片保持可见，按位置切段。 */
function isFoldAnchor(item: ProcessItem): boolean {
  return item.kind === 'user_append' || item.kind === 'approval'
}

/**「提示」折进归属 item：紧随错误事件行的提示挂到该行下（参考 Hook 逻辑），
 * 不再独立占时间轴行；会话开头无归属的提示维持独立展示。 */
function attachOwnedHints(items: ProcessItem[]): ProcessRow[] {
  const rows: ProcessRow[] = []
  const seen = new Map<string, number>()
  for (const item of items) {
    const owner = rows.at(-1)
    if (item.kind === 'hint' && owner?.item.kind === 'runtime') {
      owner.hints.push(item.event)
      continue
    }
    //历史恢复的重复 payload.id 会让步骤 id 撞车；React key 按出现顺序消歧。
    const occurrence = (seen.get(item.id) ?? 0) + 1
    seen.set(item.id, occurrence)
    rows.push({ item, hints: [], key: occurrence > 1 ? `${item.id}~${occurrence}` : item.id })
  }
  return rows
}

type ProcessStage =
  | { kind: 'anchor'; row: ProcessRow }
  | { kind: 'folded'; id: string; rows: ProcessRow[] }
  | { kind: 'live'; id: string; folded: ProcessRow[]; visible: ProcessRow[] }

/**分阶段区域折叠：整个过程保留最近 8 条步骤；更早的步骤、上下文压缩、等待、警告等
 * 以锚点（用户追加消息、提问/审批）切段，按位置收进各段折叠行，保持原顺序。
 * 折叠成员按位置切片判定，不按步骤 id 匹配——历史恢复的重复 payload.id 会让尾部
 * 步骤误入更早区，看起来就像全程一直在压缩。 */
function partitionProcessStages(items: ProcessItem[]): ProcessStage[] {
  const stages: ProcessStage[] = []
  const rows = attachOwnedHints(items)
  const stepRows = rows.filter((row) => row.item.kind === 'step')
  const cut = stepRows.length > PROCESS_STEP_HISTORY_LIMIT
    ? rows.indexOf(stepRows[stepRows.length - PROCESS_STEP_HISTORY_LIMIT])
    : 0
  let start = 0
  const flush = (end: number): void => {
    if (start === end) return
    const run = rows.slice(start, end)
    const id = `stage-${stages.length}`
    if (end <= cut) stages.push({ kind: 'folded', id, rows: run })
    else {
      const localCut = Math.max(0, cut - start)
      stages.push({ kind: 'live', id, folded: run.slice(0, localCut), visible: run.slice(localCut) })
    }
  }
  for (const [index, row] of rows.entries()) {
    if (isFoldAnchor(row.item)) {
      flush(index)
      stages.push({ kind: 'anchor', row })
      start = index + 1
    }
  }
  flush(rows.length)
  return stages
}

function processRowTimes(row: ProcessRow): { startTs: number; endTs?: number } {
  const item = row.item
  if (item.kind === 'step') return { startTs: item.startTs, endTs: item.endTs }
  if (item.kind === 'chain') return { startTs: item.events[0]?.ts ?? 0, endTs: item.events.at(-1)?.ts }
  return { startTs: item.event.ts, endTs: item.event.ts }
}

/**分阶段折叠行：不超过 2 步直接显示，其余段内可折叠行整体收放。 */
function ProcessStageFold({ rows, renderRow }: {
  rows: ProcessRow[]
  renderRow: (row: ProcessRow) => JSX.Element | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const steps = rows.filter((row): row is ProcessRow & { item: ProcessStep } => row.item.kind === 'step')
  if ((steps.length || rows.length) <= 2) {
    return <>{rows.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}</>
  }
  const commands = steps.reduce((count, row) =>
    count + row.item.events.filter((event) => event.type === 'command_exec').length, 0)
  const tools = steps.reduce((count, row) =>
    count + row.item.events.filter((event) => event.type === 'tool_call').length, 0)
  //上下文压缩与其它行一起走折叠，meta 里保留本段的压缩次数便于回溯。
  const compactions = steps.reduce((count, row) =>
    count + row.item.events.filter(event => event.type === 'context_compaction').length, 0)
  const startTs = processRowTimes(rows[0]).startTs
  const endTs = processRowTimes(rows.at(-1) ?? rows[0]).endTs
  const duration = startTs > 0 && endTs !== undefined
    ? fmtDuration(Math.max(0, endTs - startTs))
    : ''
  const meta = [commands && `${commands} 命令`, tools && `${tools} 工具`, compactions && `${compactions} 次压缩`, duration]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <div className="steps-fold">
        <span className="steps-fold-node" aria-hidden><i /></span>
        <button className="steps-fold-row" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Chevron open={open} size={12} />
          <span>{open ? '收起' : ''}{steps.length > 0 ? `更早的 ${steps.length} 个步骤` : `更早的 ${rows.length} 条记录`}</span>
          {meta && <span className="steps-fold-meta">{meta}</span>}
        </button>
      </div>
      <AnimatedCollapse open={open} className="process-step-history-collapse">
        <div className="processed-body">
          {rows.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}
        </div>
      </AnimatedCollapse>
    </>
  )
}

function ProcessStepRow({ step, active, endTs, latestOutputKey, fallbackTitle, onOpenFile, onOpenSubAgent }: {
  step: ProcessStep
  active: boolean
  endTs?: number
  latestOutputKey?: string
  /** 无旁白标题时的兜底标题：本轮第一个步骤为「任务开始」，其余为「执行调用」。 */
  fallbackTitle?: string
  onOpenFile?: (path: string, line?: number) => void
  onOpenSubAgent?: (agentThreadId: string) => void
}): JSX.Element {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const [callsExpanded, setCallsExpanded] = useState(false)
  const hasLatestReasoning = !!latestOutputKey && step.events.some((event) => eventKey(event) === latestOutputKey)
  const open = manualOpen ?? (active || hasLatestReasoning ||
    !step.title && step.events.length > 0 && step.events.every(event => event.type === 'context_compaction'))
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNowTick(Date.now())
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const entries = stepEntries(step.items)
  // 同一步骤内调用/思考条目过多时，默认只直读最后 12 条，更早的收进折叠行。
  const hiddenCalls = callsExpanded ? 0 : Math.max(0, entries.length - PROCESS_STEP_ENTRIES_LIMIT)
  const visibleEntries = hiddenCalls > 0 ? entries.slice(hiddenCalls) : entries
  const commands = step.events.filter((event) => event.type === 'command_exec').length
  const tools = step.events.filter((event) => event.type === 'tool_call').length
  const subagents = step.items.filter((item) => 'kind' in item).length
  const duration = step.title && (active ? nowTick : endTs) !== undefined && step.startTs > 0
    ? fmtDuration(Math.max(0, (active ? nowTick : endTs!) - step.startTs)) : ''
  const latest = active && !open ? latestReasoning(step.events) : undefined
  const title = step.title?.payload?.text || fallbackTitle || '执行调用'
  return (
    <div className={`process-step${active ? ' active' : ''}${open ? ' open' : ''}`} data-step-id={step.id}>
      <span className="process-step-node" aria-hidden>{active ? <span className="process-step-live-dot" /> : <span className="process-step-done-dot" />}</span>
      <div className="process-step-content">
        <div className="process-step-head">
          {open && step.title?.payload?.text
            ? (
              // 展开后点击旁白标题同样收起；拖选文字不收起。Markdown 内的链接与
              // 文件路径点击已 stopPropagation，不会冒泡到这里。
              <div
                className="process-step-markdown"
                onClick={() => {
                  if (window.getSelection()?.isCollapsed === false) return
                  setManualOpen(false)
                }}
              >
                <Markdown text={title} onOpenFile={onOpenFile} />
              </div>
            )
            : <button className="process-step-title" type="button" aria-expanded={open} onClick={() => setManualOpen(!open)}>{title}</button>}
          <button className="process-step-meta" type="button" aria-label={open ? '收起工作步骤' : '展开工作步骤'} aria-expanded={open} onClick={() => setManualOpen(!open)}>
            {[commands && `${commands} 命令`, tools && `${tools} 工具`, subagents && `${subagents} 子 Agent`, duration].filter(Boolean).join(' · ')}
            <Chevron open={open} size={12} />
          </button>
        </div>
        <AnimatedCollapse open={open && (entries.length > 0 || !!step.teamEvents?.length)} className="process-step-disclosure">
          {step.teamEvents?.map(event => <TeamEventNotice key={eventKey(event)} ev={event} />)}
          {entries.length > 0 && <div className="process-step-calls">
            {entries.length > PROCESS_STEP_ENTRIES_LIMIT && (
              <button
                className="step-call-row step-calls-fold"
                type="button"
                aria-expanded={callsExpanded}
                onClick={() => setCallsExpanded(!callsExpanded)}
              >
                <Chevron open={callsExpanded} size={12} />
                <span>{callsExpanded ? '收起' : ''}更早的 {entries.length - PROCESS_STEP_ENTRIES_LIMIT} 条</span>
              </button>
            )}
            {visibleEntries.map((entry) => entry.kind === 'call'
              ? <CompactCallRow key={entry.id} events={entry.events} />
              : entry.kind === 'subagent'
                ? <SubAgentLine key={entry.segment.id} phase={entry.segment.phase} agents={entry.segment.agents} onOpen={onOpenSubAgent} />
                : entry.kind === 'launch'
                  ? <LaunchNotice key={entry.id} event={entry.event} warnings={entry.warnings} />
                  : <EventCard key={eventKey(entry.event)} ev={entry.event} latestOutputKey={latestOutputKey} onOpenFile={onOpenFile} />)}
          </div>}
        </AnimatedCollapse>
        {latest && <LiveReasoning ev={latest} onOpenFile={onOpenFile} />}
      </div>
    </div>
  )
}

/**
 * Process section heading. Provider notices (native context, warnings) can arrive
 * before the first work step; without this heading they read as free-floating
 * messages above the timeline. Counts are only added once real work exists.
 */
function ProcessTimelineHead({ items, fallbackWait = false }: {
  items: ProcessItem[]
  fallbackWait?: boolean
}): JSX.Element | null {
  const steps = items.filter((item): item is ProcessStep => item.kind === 'step')
  const stepCount = steps.length +
    items.filter(item => ['team_dispatch', 'team_wait'].includes(item.kind)).length +
    items.filter(item => item.kind === 'queue_wait' || item.kind === 'runtime').length +
    items.filter(item => item.kind === 'user_append').length +
    Number(fallbackWait)
  const visibleNoticeCount = items.filter(item =>
    (item.kind === 'hint' || item.kind === 'notice') && processNoticeText(item.event).trim()).length
  if (stepCount === 0 && visibleNoticeCount === 0) return null
  const callCount = steps.reduce((count, step) =>
    count + step.events.filter((event) => event.type === 'command_exec' || event.type === 'tool_call').length, 0)
  const subagentCount = steps.reduce((count, step) => count + step.items.filter((item) => 'kind' in item).length, 0)
  return (
    <div className="process-timeline-head">
      <b>工作过程</b>
      {stepCount > 0 && <> · {stepCount} 步 · {callCount} 次调用</>}
      {subagentCount > 0 && ` · ${subagentCount} 次子 Agent 状态`}
    </div>
  )
}

/** Notices have no milestone dot; the timeline continues beside their disclosure. */
function ProcessNotice({ ev, onOpenFile }: { ev: UAEvent; onOpenFile?: (path: string, line?: number) => void }): JSX.Element | null {
  const raw = ev.type === 'raw_output'
  const warning = ev.payload?.kind === 'warning'
  const label = raw ? '输出' : warning && !isConversationHint(ev.payload?.text) ? '警告' : '提示'
  const text = processNoticeText(ev)
  if (!text.trim()) return null
  return (
    <div className={`process-notice${warning ? ' warning' : ''}`}><details>
      <summary>
        <UiIcon name="alert-circle" size={13} />
        <span className="process-notice-label">{label}</span>
        <span className="process-notice-preview">{text}</span>
        <Chevron size={12} />
      </summary>
      <div className="process-notice-body">
        {raw ? <pre>{text}</pre> : <Markdown text={text} onOpenFile={onOpenFile} />}
      </div>
    </details></div>
  )
}

function processNoticeText(ev: UAEvent): string {
  return ev.payload?.kind === 'team_communication'
    ? `Leader 补充（${ev.payload.communication?.state || '已发送'}）：${ev.payload.communication?.message || ev.payload.text || ''}`
    : String(ev.payload?.text || '')
}

function ProcessRuntimeStep({ ev, hints = [], onOpenFile }: {
  ev: UAEvent
  /**「提示」折进归属事件行：紧随错误的提示在行内默认收起（参考 Hook 逻辑）。 */
  hints?: UAEvent[]
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const active = ev.state === 'running'
  const failed = ev.type === 'error' || ev.state === 'failed'
  return <div className={`process-step process-runtime${active ? ' active' : ''}${failed ? ' failed' : ''}`}>
    <span className="process-step-node" aria-hidden><span className={active ? 'process-step-live-dot' : 'process-step-done-dot'} /></span>
    <div className="process-step-content">
      <EventCard ev={ev} onOpenFile={onOpenFile} />
      {hints.map((hint) => <ProcessNotice key={eventKey(hint)} ev={hint} onOpenFile={onOpenFile} />)}
    </div>
  </div>
}

function TeamEventNotice({ ev }: { ev: UAEvent }): JSX.Element | null {
  const team = useContext(TeamSessionContext)
  const parsed = ev.payload.teamEventPrompt || parseTeamEventPrompt(ev.payload.text)
  return parsed.kind === 'not-event' ? null
    : <TeamEventCard parsed={parsed} hideDeliveries={!!team || ev.payload.kind === 'team_wakeup'} />
}

function UserAppendStep({ ev }: { ev: UAEvent }): JSX.Element {
  const presentation = useContext(RequestPresentationContext)
  const question = presentation.asyncReplies.get(ev.seq)
  const skipped = isSkippedQuestionAnswer(question?.payload.submittedAnswer)
  const questionLabel = skipped ? '跳过异步提问' : '回答异步提问'
  const fields = question ? normalizeQuestions('question', question.payload.params) : []
  const questionSummary = fields.map(field => field.prompt || field.title || field.id).join('；').replace(/\s+/g, ' ').trim()
  const attachments = (ev.payload.attachments || []) as Attachment[]
  const nativeContext = ev.payload.nativeContext as ResolvedNativeTurnContext | undefined
  const comments = (Array.isArray(ev.payload.comments) ? ev.payload.comments : []) as {
    quote: string
    comment: string
  }[]
  const messageText = comments.length && typeof ev.payload.displayText === 'string' && ev.payload.displayText
    ? ev.payload.displayText
    : ev.payload.text
  const remote = ev.payload.source !== 'app' && typeof messageText === 'string'
    ? splitWeixinContext(messageText) || splitFeishuContext(messageText)
    : undefined
  const visibleText = String(remote?.text ?? messageText ?? '')
  const copyText = [
    visibleText,
    ...comments.map((comment) => [
      comment.quote ? `> ${comment.quote}` : '',
      comment.comment,
    ].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n\n')
  const command = ev.payload.command === 'plan' ? 'plan' : undefined
  const summary = question ? questionSummary : (
    visibleText.trim() || comments.map(comment => comment.comment || comment.quote).join('；') || attachments.map(attachment => attachment.name).join('、')
  ).replace(/\s+/g, ' ').trim()
  return (
    <div className="user-append-step">
      <span className="user-append-node" aria-hidden><UiIcon name="user-circle" size={13} /></span>
      <details className={`user-append-card${question ? ' async-question-reply' : ''}`}>
        <summary className="user-append-head">
          <span className="user-append-label">{question ? questionLabel : '用户追加消息'}</span>
          <span className={question ? 'async-reply-preview' : 'user-append-preview'} title={summary}>{summary}</span>
          <MessageActions
            event={ev}
            kind="user"
            text={copyText}
            suffix={remote ? (
              <span className={'user-feishu-source' + (ev.payload.source === 'weixin' ? ' user-weixin-source' : '')} title={remote.context} aria-label={remote.context} tabIndex={0}>
                <UiIcon name={ev.payload.source === 'weixin' ? 'message-square' : 'feishu'} size={14} />
              </span>
            ) : undefined}
          />
          <Chevron size={12} />
        </summary>
        <div className="user-append-body">
          <SentCapabilityChips context={nativeContext} command={command} />
          {question ? fields.map(field => (
            <div className="async-reply-field" key={field.id}>
              <div className="async-reply-question"><span className="async-reply-question-label">问题</span><div>{field.prompt || field.title || field.id}</div></div>
              <div className="async-reply-answer"><span className="async-reply-answer-label">回答</span><div>{skipped ? '已跳过' : readonlyQuestionAnswer(field, questionAnswerValues('question', field, question.payload.submittedAnswer))}</div></div>
            </div>
          )) : <div className="user-append-text">{visibleText}</div>}
          {comments.length > 0 && (
            <div className="bubble-comments">
              {comments.map((comment, index) => (
                <div className="bubble-comment" key={index}>
                  <span className="bubble-comment-idx">{index + 1}</span>
                  <div className="bubble-comment-body">
                    <div className="bubble-comment-quote">{comment.quote}</div>
                    {comment.comment && <div className="bubble-comment-note">{comment.comment}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="bubble-attachments">
              {attachments.map((attachment, index) => attachment.kind === 'image' ? (
                <BubbleImage
                  key={`${attachment.path}-${index}`}
                  sessionId={ev.sessionId}
                  attachment={attachment}
                  optimistic={ev.payload.optimistic === true}
                  siblings={attachments}
                />
              ) : (
                <span key={`${attachment.path}-${index}`} className="bubble-attach" title={attachment.path}>
                  📎 {attachment.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

/** Still running (or finished with no reply): show segments in real order. */
function LiveTurn({
  turn,
  active,
  liveStatus,
  waitingForMembers = false,
  latestReplySeq,
  onRespond,
  onOpenSubAgent,
  waitingForHandoff,
  onJumpToSession,
  onOpenFile,
}: {
  turn: Turn
  active: boolean
  liveStatus?: ReactNode
  waitingForMembers?: boolean
  latestReplySeq?: number
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  onOpenSubAgent?: (agentThreadId: string) => void
  waitingForHandoff?: WaitingForHandoff
  onJumpToSession?: (sessionId: string) => void
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const items = processItems(turn.segments, turn.finalReplySeq)
  const steps = items.filter((item): item is ProcessStep => item.kind === 'step')
  const latestWork = items.findLast(item => !['hint', 'notice', 'event'].includes(item.kind))
  const lastStep = latestWork?.kind === 'step' ? latestWork : undefined
  const latestOutputKey = latestProcessReasoningKey(items)
  const fallbackWait = waitingForMembers && !turn.segments.some(s => s.kind === 'team_wait')
  // 本轮第一个没有模型旁白标题的步骤叫「任务开始」，其余仍是「执行调用」。
  const firstUntitledStep = steps.find((step) => !step.title)
  // 模型切换回合（无用户消息、含切换卡片）只保留切换卡片：切换附带的启动信息、
  // 压缩进度、失败异常等一切都由卡片承载（步骤行与卡片内错误框），时间轴不再
  // 渲染该回合的其它任何行。
  const switchOnly = !turn.user && items.some((item) => item.kind === 'model_switch')
  const visibleItems = switchOnly ? items.filter((item) => item.kind === 'model_switch') : items
  const renderRow = (row: ProcessRow): JSX.Element | null => {
    const seg = row.item
    if (seg.kind === 'queue_wait') return <QueueWaitStep view={seg.view} />
    if (seg.kind === 'runtime') return <ProcessRuntimeStep ev={seg.event} hints={row.hints} onOpenFile={onOpenFile} />
    if (seg.kind === 'hint' || seg.kind === 'notice') return <ProcessNotice ev={seg.event} onOpenFile={onOpenFile} />
    if (seg.kind === 'model_switch') return <ModelSwitchCard ev={seg.event} />
    if (seg.kind === 'step') return (
      <ProcessStepRow
        step={seg}
        active={active && seg === lastStep}
        endTs={seg.endTs ?? (turn.done ? turn.endTs : undefined)}
        latestOutputKey={latestOutputKey}
        fallbackTitle={seg === firstUntitledStep ? '任务开始' : undefined}
        onOpenFile={onOpenFile}
        onOpenSubAgent={onOpenSubAgent}
      />
    )
    if (seg.kind === 'event')
      return <EventCard ev={seg.event} latestOutputKey={latestOutputKey} onOpenFile={onOpenFile} />
    if (seg.kind === 'user_append') return <UserAppendStep ev={seg.event} />
    if (seg.kind === 'reply')
      return (
        <ReplyBlock
          ev={seg.event}
          streaming={replyHasLiveCursor(
            seg.event.state,
            turn.done,
            active,
            seg.event.seq === latestReplySeq,
          )}
          onOpenFile={onOpenFile}
        />
      )
    if (seg.kind === 'team_wait') return <TeamWaitingMembersStep event={seg.event} />
    if (seg.kind === 'team_dispatch') return <TeamDispatchStep event={seg.event} />
    if (seg.kind === 'image') return <GeneratedImageCard ev={seg.event} />
    // 交接任务 — persistent 开始/进行中/终态 row in the caller session.
    if (seg.kind === 'handoff')
      return (
        <HandoffTaskLine
          ev={seg.event}
          milestone={seg.milestone}
          taskId={seg.taskId}
          waitingForHandoff={waitingForHandoff}
          onJump={onJumpToSession}
        />
      )
    // 提问 / 审批卡片渲染在链路之外（顶层），默认就可见、可直接作答。
    if (seg.kind === 'approval')
      return <ApprovalCard ev={seg.event} onRespond={onRespond} />
    return null
  }
  return (
    <>
      {!switchOnly && <ProcessTimelineHead items={items} fallbackWait={fallbackWait} />}
      {partitionProcessStages(visibleItems).map((stage) =>
        stage.kind === 'anchor' ? (
          <Fragment key={stage.row.key}>{renderRow(stage.row)}</Fragment>
        ) : stage.kind === 'folded' ? (
          <ProcessStageFold key={stage.id} rows={stage.rows} renderRow={renderRow} />
        ) : (
          <Fragment key={stage.id}>
            {stage.folded.length > 0 && <ProcessStageFold rows={stage.folded} renderRow={renderRow} />}
            {stage.visible.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}
          </Fragment>
        ),
      )}
      {fallbackWait && <TeamWaitingMembersStep />}
      {liveStatus}
    </>
  )
}

/** Completed turn: fold its execution history into one "已处理" block. */
function DoneTurn({
  turn,
  lastReplyIdx,
  onRespond,
  onOpenSubAgent,
  waitingForHandoff,
  onJumpToSession,
  chainController,
  onProcessedFoldToggle,
  onOpenFile,
  showFinalActions,
}: {
  turn: Turn
  lastReplyIdx: number
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  onOpenSubAgent?: (agentThreadId: string) => void
  waitingForHandoff?: WaitingForHandoff
  onJumpToSession?: (sessionId: string) => void
  chainController: ChainOpenController
  onProcessedFoldToggle?: (opening: boolean) => void
  onOpenFile?: (path: string, line?: number) => void
  showFinalActions: boolean
}): JSX.Element {
  // Runtime events and notices keep their chronological position in the history.
  // Generated images retain their standalone preview beside the final reply.
  const processed = turn.segments.filter((segment, index) => {
    if (segment.kind === 'image') return false
    if (index < lastReplyIdx) return true
    return index > lastReplyIdx &&
      ['handoff', 'team_wait', 'team_dispatch', 'team_delivery', 'team_event', 'queue_wait', 'runtime', 'notice', 'hint', 'model_switch', 'subagent'].includes(segment.kind)
  })
  const images = turn.segments.filter((segment): segment is Extract<Segment, { kind: 'image' }> =>
    segment.kind === 'image'
  )
  const finalSeg = turn.segments[lastReplyIdx]
  const supplements = turn.segments
    .filter((segment): segment is Extract<Segment, { kind: 'reply' }> =>
      segment.kind === 'reply' && (turn.finalReplySeq !== null
        ? segment.event.seq > turn.finalReplySeq
        : turn.completionSeq !== null && segment.event.seq > turn.completionSeq))
  return (
    <>
      {processed.length > 0 && (
        <ProcessedFold
          segments={processed}
          finalReplySeq={turn.finalReplySeq}
          endTs={turn.endTs}
          durationMs={turn.endTs - turn.startTs}
          onRespond={onRespond}
          onOpenSubAgent={onOpenSubAgent}
          waitingForHandoff={waitingForHandoff}
          onJumpToSession={onJumpToSession}
          chainController={chainController}
          onToggle={onProcessedFoldToggle}
          onOpenFile={onOpenFile}
        />
      )}
      {images.map((segment) => <GeneratedImageCard key={segment.id} ev={segment.event} />)}
      {finalSeg.kind === 'reply' && <ReplyBlock ev={finalSeg.event} readable={finalSeg.event.payload.phase !== 'commentary'} onOpenFile={onOpenFile} showActions={showFinalActions} />}
      {turn.segments.slice(lastReplyIdx + 1).map(segment => segment.kind === 'approval'
        ? <ApprovalCard key={segment.id} ev={segment.event} onRespond={onRespond} />
        : null)}
      {supplements.length > 0 && (
        <details className="reply-supplements">
          <summary>
            <Chevron size={13} />
            <span>补充信息 · {supplements.length} 条</span>
          </summary>
          <div className="reply-supplements-body">
            {supplements.map((segment) => (
              <ReplyBlock key={segment.id} ev={segment.event} dim onOpenFile={onOpenFile} />
            ))}
          </div>
        </details>
      )}
    </>
  )
}

/**
 * 需求一(每轮变更摘要 + 补1 文件行可点击) — a compact card under the final reply
 * summarising the files this turn changed. Clicking「审核」opens the review scoped
 * to this turn; clicking a file row opens review AND preselects that file. Renders
 * nothing when the turn changed no files.
 */
function TurnChangeCard({
  files,
  onOpenReview,
}: {
  files: FileDiff[]
  onOpenReview?: (filePath?: string) => void
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const total = useMemo(() => totalStat(files), [files])
  if (files.length === 0) return null

  const verb = files.every((f) => f.kind === 'add')
    ? '已新增'
    : files.every((f) => f.kind === 'delete')
      ? '已删除'
      : '已编辑'
  const shown = expanded ? files : files.slice(0, 6)
  const rest = files.length - 6

  return (
    <div className="turn-change-card">
      <div className="tcc-head">
        <span className="tcc-title">
          {verb} {files.length} 个文件
        </span>
        <span className="tcc-stat">
          <span className="p">+{total.added}</span> <span className="m">−{total.removed}</span>
        </span>
        {onOpenReview && (
          <button className="tcc-review" onClick={() => onOpenReview(undefined)}>
            审核 →
          </button>
        )}
      </div>
      <div className="tcc-files">
        {shown.map((f) => {
          const badge = f.kind === 'add' ? 'A' : f.kind === 'delete' ? 'D' : f.kind === 'rename' ? 'R' : 'M'
          return (
            <div
              key={f.path}
              className="tcc-file"
              data-file={f.path}
              role={onOpenReview ? 'button' : undefined}
              onClick={onOpenReview ? () => onOpenReview(f.path) : undefined}
              title={f.path}
            >
              <span className={`tcc-badge ${f.kind === 'rename' ? 'modify' : f.kind}`}>{badge}</span>
              <span className="tcc-path">{f.path}</span>
              <span className="tcc-fstat">
                {f.added > 0 && <span className="p">+{f.added}</span>}
                {f.removed > 0 && <span className="m">−{f.removed}</span>}
              </span>
            </div>
          )
        })}
      </div>
      {rest > 0 && (
        <button
          className="tcc-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '▴ 收起' : `▾ 展开其余 ${rest} 个文件`}
        </button>
      )}
    </div>
  )
}

export function UserBubble({ ev, onRewind }: { ev: UAEvent; onRewind?: () => void }): JSX.Element {
  const teamAssignmentContext = useContext(TeamAssignmentDisplayContext)
  const attachments = (ev.payload.attachments || []) as Attachment[]
  const nativeContext = ev.payload.nativeContext as ResolvedNativeTurnContext | undefined
  // 选中即评论 — a sent turn may carry structured comment cards (引用+评论). When
  // present, the bubble's main text is the instruction (`displayText`) and the
  // cards render below it, marking this as a 带评论的消息.
  const comments = (Array.isArray(ev.payload.comments) ? ev.payload.comments : []) as {
    quote: string
    comment: string
  }[]
  const bubbleText =
    comments.length && typeof ev.payload.displayText === 'string' && ev.payload.displayText
      ? ev.payload.displayText
      : ev.payload.text
  const assignmentCard = teamAssignmentContext
    ? teamAssignmentCardForText(bubbleText, teamAssignmentContext)
    : null
  if (assignmentCard) return assignmentCard
  const remote = ev.payload.source !== 'app' && typeof bubbleText === 'string'
    ? splitWeixinContext(bubbleText) || splitFeishuContext(bubbleText)
    : undefined
  const command = ev.type === 'goal_message'
    ? 'goal'
    : ev.payload.command === 'plan'
      ? 'plan'
      : undefined
  const visibleText = String(remote?.text ?? bubbleText ?? '')
  const copyText = [
    visibleText,
    ...comments.map((comment) => [
      comment.quote ? `> ${comment.quote}` : '',
      comment.comment,
    ].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n\n')
  return (
    <div className={`card user-msg${remote ? ' has-feishu-context' : ''}`}>
      <div className="bubble">
        <SentCapabilityChips context={nativeContext} command={command} />
        <span>{remote?.text ?? bubbleText}</span>
        {comments.length > 0 && (
          <div className="bubble-comments">
            {comments.map((c, i) => (
              <div className="bubble-comment" key={i}>
                <span className="bubble-comment-idx">{i + 1}</span>
                <div className="bubble-comment-body">
                  <div className="bubble-comment-quote">{c.quote}</div>
                  {c.comment && <div className="bubble-comment-note">{c.comment}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="bubble-attachments">
            {attachments.map((a, i) => (
              a.kind === 'image' ? (
                <BubbleImage
                  key={`${a.path}-${i}`}
                  sessionId={ev.sessionId}
                  attachment={a}
                  optimistic={ev.payload.optimistic === true}
                  siblings={attachments}
                />
              ) : (
                <span key={`${a.path}-${i}`} className="bubble-attach" title={a.path}>
                  📎 {a.name}
                </span>
              )
            ))}
          </div>
        )}
      </div>
      <MessageActions
        event={ev}
        kind="user"
        text={copyText}
        onRewind={onRewind}
        suffix={remote ? (
          <span className={'user-feishu-source' + (ev.payload.source === 'weixin' ? ' user-weixin-source' : '')} title={remote.context} aria-label={remote.context} tabIndex={0}>
            <UiIcon name={ev.payload.source === 'weixin' ? 'message-square' : 'feishu'} size={14} />
          </span>
        ) : undefined}
      />
    </div>
  )
}

function BubbleImage({
  sessionId,
  attachment,
  optimistic,
  siblings
}: {
  sessionId: string
  attachment: Attachment
  optimistic: boolean
  /** 同一气泡里的全部附件：详情视图据此支持左右切换。 */
  siblings: Attachment[]
}): JSX.Element {
  const [src, setSrc] = useState<string | null | undefined>(() =>
    getCachedAttachmentPreview(attachment.path)
  )
  // `open` also pins the index the user clicked, so the detail view starts there.
  const [open, setOpen] = useState<number | null>(null)
  // 同一气泡里其它图片的预览：只有真正打开详情时才去取，避免为每张缩略图都读一次盘。
  const [sources, setSources] = useState<Record<string, string>>({})

  useEffect(() => {
    const cached = getCachedAttachmentPreview(attachment.path)
    if (cached) {
      setSrc(cached)
      return
    }
    setSrc(undefined)
    if (optimistic) return
    let active = true
    void window.uniagent.fsReadAttachmentImage(sessionId, attachment.path)
      .then((dataUrl) => {
        if (!active) return
        cacheAttachmentPreview(attachment.path, dataUrl || undefined)
        setSrc(dataUrl)
      })
      .catch(() => { if (active) setSrc(null) })
    return () => { active = false }
  }, [attachment.path, optimistic, sessionId])

  const imageAttachments = useMemo(
    () => siblings.filter((item) => item.kind === 'image'),
    [siblings]
  )
  const sourceOf = useCallback(
    (item: Attachment): string | undefined => {
      const cached = getCachedAttachmentPreview(item.path)
      return sources[item.path] ?? cached
    },
    [sources]
  )

  // The preview a bubble already shows (its own, plus anything cached) is used
  // immediately; the rest stream in and the lightbox re-renders as they land.
  useEffect(() => {
    if (open === null) return
    let active = true
    const missing = imageAttachments.filter(
      (item) => item.path !== attachment.path && !getCachedAttachmentPreview(item.path)
    )
    void Promise.all(missing.map(async (item) => {
      if (optimistic) return
      try {
        const dataUrl = await window.uniagent.fsReadAttachmentImage(sessionId, item.path)
        if (!active || !dataUrl) return
        cacheAttachmentPreview(item.path, dataUrl)
        setSources((prev) => (prev[item.path] === dataUrl ? prev : { ...prev, [item.path]: dataUrl }))
      } catch {
        // 单张读不出来时保留缩略图占位，不影响其它图片切换。
      }
    }))
    return () => { active = false }
  }, [attachment.path, imageAttachments, open, optimistic, sessionId])

  if (src) {
    const images = imageAttachments.map((item) => ({
      src: item.path === attachment.path ? src : sourceOf(item) || '',
      alt: item.name
    }))
    const openPosition = Math.max(imageAttachments.findIndex((item) => item.path === attachment.path), 0)
    return (
      <>
        <button
          type="button"
          className="bubble-image bubble-image-button"
          aria-label={`预览 ${attachment.name}`}
          title={attachment.path}
          onClick={() => setOpen(openPosition)}
        >
          <img src={src} alt="" />
        </button>
        {open !== null && (
          <ImageLightbox
            images={images}
            index={open}
            onIndexChange={setOpen}
            onClose={() => setOpen(null)}
            label={attachment.name}
          />
        )}
      </>
    )
  }
  if (src === undefined) return <span className="bubble-image bubble-image-loading" aria-label={`正在加载 ${attachment.name}`}>🖼</span>
  return <span className="bubble-attach" title={attachment.path}>🖼 {attachment.name}</span>
}

function GeneratedImageCard({ ev }: { ev: UAEvent }): JSX.Element {
  const nativeImage = ev.payload?.result?.nativeImage
  const nativeEventSeq = nativeImage?.eventSeq
  const nativeBlockIndex = nativeImage?.blockIndex
  const nativeToolResult = nativeImage?.toolResult === true
  const nativeChildSessionId = typeof nativeImage?.childSessionId === 'string' ? nativeImage.childSessionId : undefined
  const nativeSelector = Number.isSafeInteger(nativeEventSeq) && nativeEventSeq >= 0 &&
    Number.isSafeInteger(nativeBlockIndex) && nativeBlockIndex >= 0
    ? { eventSeq: nativeEventSeq, blockIndex: nativeBlockIndex, ...(nativeToolResult ? { toolResult: true } : {}),
      ...(nativeChildSessionId ? { childSessionId: nativeChildSessionId } : {}) }
    : undefined
  const savedPath = typeof ev.payload?.result?.savedPath === 'string'
    ? ev.payload.result.savedPath
    : undefined
  const cacheKey = savedPath || (nativeSelector ? `native-image:${ev.sessionId}:${nativeChildSessionId || ''}:${nativeEventSeq}:${nativeBlockIndex}:${nativeToolResult}` : undefined)
  const imageLabel = nativeSelector ? '图片' : '生成图片'
  const [src, setSrc] = useState<string | null | undefined>(() =>
    cacheKey ? getCachedAttachmentPreview(cacheKey) : undefined
  )
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!cacheKey || ev.state !== 'success') return
    const cached = getCachedAttachmentPreview(cacheKey)
    if (cached) {
      setSrc(cached)
      return
    }
    setSrc(undefined)
    let active = true
    const read = savedPath ? window.uniagent.fsReadAttachmentImage(ev.sessionId, savedPath)
      : window.uniagent.fsReadNativeImage(ev.sessionId, nativeSelector!)
    void read
      .then((dataUrl) => {
        if (!active) return
        cacheAttachmentPreview(cacheKey, dataUrl || undefined)
        setSrc(dataUrl)
      })
      .catch(() => { if (active) setSrc(null) })
    return () => { active = false }
  }, [ev.sessionId, ev.state, savedPath, cacheKey, nativeEventSeq, nativeBlockIndex, nativeToolResult, nativeChildSessionId])

  const stateLabel = ev.state === 'running'
    ? '生成中'
    : ev.state === 'success'
      ? '已完成'
      : ev.state === 'cancelled'
        ? '已取消'
        : '生成失败'
  const failure = ev.payload?.result?.failure
  const failureText = typeof failure === 'string'
    ? failure
    : typeof failure?.message === 'string'
      ? failure.message
      : undefined

  return (
    <div className={`card generated-image-card state-${ev.state}`}>
      <div className="generated-image-head">
        <UiIcon name="image" size={15} />
        <span>{imageLabel}</span>
        <span className="generated-image-separator">·</span>
        <span className="generated-image-state">{stateLabel}</span>
      </div>
      {ev.state === 'running' ? (
        <div className="generated-image-placeholder">正在生成图片…</div>
      ) : ev.state !== 'success' ? (
        <div className="generated-image-error">{failureText || stateLabel}</div>
      ) : src ? (
        <>
          <button
            type="button"
            className="generated-image-preview"
            aria-label={`查看${imageLabel}`}
            onClick={() => setOpen(true)}
          >
            <img src={src} alt={imageLabel} />
          </button>
          <span className="generated-image-hint">点击查看大图</span>
        </>
      ) : (
        <div className="generated-image-placeholder">
          {src === null || !cacheKey ? '图片暂时无法读取' : '正在加载图片…'}
        </div>
      )}
      {src && open && (
        <ImageLightbox
          images={[{ src, alt: imageLabel }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setOpen(false)}
          label={imageLabel}
        />
      )}
    </div>
  )
}

export function ReplyBlock({
  ev,
  dim,
  streaming = false,
  readable = false,
  showActions = false,
  onOpenFile,
}: {
  ev: UAEvent
  dim?: boolean
  streaming?: boolean
  readable?: boolean
  showActions?: boolean
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  // 选中即评论 — pull this reply's own annotation ranges from context (main chat
  // only; the map is empty in side / detail streams, so nothing highlights there).
  // The comment cards themselves live in the composer's 待评论托盘, not here.
  const { annotationsBySeq, onEditAnnotation } = useContext(AnnotationContext)
  const annotations = annotationsBySeq.get(ev.seq)
  return (
    <div
      className={`card agent-msg${dim ? ' dim' : ''}${streaming ? ' streaming' : ''}`}
      data-seq={ev.seq}
    >
      <Markdown text={ev.payload.text || ''} onOpenFile={onOpenFile} annotations={annotations} onEditAnnotation={onEditAnnotation} />
      {streaming && <span className="stream-cursor" aria-hidden />}
      {showActions && <MessageActions event={ev} kind="agent" text={String(ev.payload.text || '')} readable={readable} />}
    </div>
  )
}

function PlanDecision({
  onImplement,
  onRevise,
  onSkip,
}: {
  onImplement: () => Promise<void>
  onRevise: (feedback: string) => Promise<void>
  onSkip?: () => Promise<void>
}): JSX.Element | null {
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')

  if (dismissed) return null

  const submit = async (action: () => Promise<void>): Promise<void> => {
    setSubmitting(true)
    setError('')
    try {
      await action()
      setDismissed(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="plan-decision">
      <div className="plan-decision-title">实施此计划？</div>
      {feedbackOpen ? (
        <>
          <textarea
            autoFocus
            value={feedback}
            disabled={submitting}
            placeholder="告诉 Agent 应该如何调整计划…"
            onChange={(event) => setFeedback(event.target.value)}
            rows={3}
          />
          <div className="plan-decision-actions">
            <button type="button" disabled={submitting} onClick={() => setFeedbackOpen(false)}>返回</button>
            <button
              type="button"
              className="primary"
              disabled={submitting || !feedback.trim()}
              onClick={() => void submit(() => onRevise(feedback.trim()))}
            >
              发送反馈
            </button>
          </div>
        </>
      ) : (
        <div className="plan-decision-actions">
          <button
            type="button"
            className="primary"
            disabled={submitting}
            onClick={() => void submit(onImplement)}
          >
            是，实施此计划
          </button>
          <button type="button" disabled={submitting} onClick={() => setFeedbackOpen(true)}>
            否，并告诉 Agent 应该如何做得不同
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSkip ? void submit(onSkip) : setDismissed(true)}
          >
            跳过
          </button>
        </div>
      )}
      {error && <div className="plan-decision-error">{error}</div>}
    </div>
  )
}

/** The big "已处理 {duration}" collapse wrapping a completed turn's history. */
function ProcessedFold({
  segments,
  finalReplySeq,
  endTs,
  durationMs,
  onRespond,
  onOpenSubAgent,
  waitingForHandoff,
  onJumpToSession,
  chainController,
  onToggle,
  onOpenFile,
}: {
  segments: Segment[]
  finalReplySeq: number | null
  endTs: number
  durationMs: number
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  onOpenSubAgent?: (agentThreadId: string) => void
  waitingForHandoff?: WaitingForHandoff
  onJumpToSession?: (sessionId: string) => void
  chainController: ChainOpenController
  onToggle?: (opening: boolean) => void
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element | null {
  const hasError = segments.some(segment => segment.kind === 'runtime' && (segment.event.type === 'error' || segment.event.state === 'failed'))
  const [open, setOpen] = useState(hasError)
  useEffect(() => { if (hasError) setOpen(true) }, [hasError])
  const { locateSeq } = useContext(RequestPresentationContext)
  useEffect(() => {
    if (locateSeq !== null && segments.some(segment => segment.kind === 'approval' && segment.event.seq === locateSeq)) setOpen(true)
  }, [locateSeq, segments])
  const items = processItems(segments, finalReplySeq)
  if (items.length === 0) return null
  const steps = items.filter((item): item is ProcessStep => item.kind === 'step')
  const latestOutputKey = latestProcessReasoningKey(items)
  const userAppendCount = items.filter((item) => item.kind === 'user_append').length
  const firstUntitledStep = steps.find((step) => !step.title)
  const renderRow = (row: ProcessRow): JSX.Element | null => {
    const seg = row.item
    if (seg.kind === 'step') return (
      <ProcessStepRow
        step={seg}
        active={false}
        endTs={seg.endTs ?? endTs}
        latestOutputKey={latestOutputKey}
        fallbackTitle={seg === firstUntitledStep ? '任务开始' : undefined}
        onOpenFile={onOpenFile}
        onOpenSubAgent={onOpenSubAgent}
      />
    )
    if (seg.kind === 'queue_wait') return <QueueWaitStep view={seg.view} />
    if (seg.kind === 'runtime') return <ProcessRuntimeStep ev={seg.event} hints={row.hints} onOpenFile={onOpenFile} />
    if (seg.kind === 'event') return <EventCard ev={seg.event} latestOutputKey={latestOutputKey} onOpenFile={onOpenFile} />
    if (seg.kind === 'user_append') return <UserAppendStep ev={seg.event} />
    if (seg.kind === 'reply') return <ReplyBlock ev={seg.event} dim onOpenFile={onOpenFile} />
    if (seg.kind === 'image') return <GeneratedImageCard ev={seg.event} />
    if (seg.kind === 'team_wait') return <TeamWaitingMembersStep event={seg.event} />
    if (seg.kind === 'team_dispatch') return <TeamDispatchStep event={seg.event} />
    // 已完成的轮次：已答的提问 / 审批卡片留在原位置，与历史回放保持一致。
    if (seg.kind === 'approval') return <ApprovalCard ev={seg.event} onRespond={onRespond} />
    if (seg.kind === 'hint' || seg.kind === 'notice') return <ProcessNotice ev={seg.event} onOpenFile={onOpenFile} />
    if (seg.kind === 'model_switch') return <ModelSwitchCard ev={seg.event} />
    if (seg.kind === 'handoff')
      return (
        <HandoffTaskLine
          ev={seg.event}
          milestone={seg.milestone}
          taskId={seg.taskId}
          waitingForHandoff={waitingForHandoff}
          onJump={onJumpToSession}
        />
      )
    if (seg.kind === 'chain') return (
      <ChainFold
        id={seg.id}
        events={seg.events}
        open={chainController.state.manualOpenIds.has(seg.id)}
        onToggle={() => chainController.toggle(seg.id)}
        onRespond={onRespond}
        onOpenFile={onOpenFile}
      />
    )
    return null
  }
  return (
    <div className={`processed-fold ${open ? 'open' : 'closed'}`}>
      <div
        className="processed-head"
        onClick={() => {
          onToggle?.(!open)
          setOpen(!open)
        }}
      >
        <span className="processed-caret">
          <Chevron open={open} size={15} />
        </span>
        <span className="processed-label">
          已处理 {fmtDuration(durationMs)}
        </span>
        {userAppendCount > 0 && (
          <span className="processed-user-appends">
            <UiIcon name="agent" size={11} />
            含 {userAppendCount} 条用户追加消息
          </span>
        )}
      </div>
      <AnimatedCollapse open={open} className="processed-disclosure">
        <div className="processed-body">
          <ProcessTimelineHead items={items} />
          {partitionProcessStages(items).map((stage) =>
            stage.kind === 'anchor' ? (
              <Fragment key={stage.row.key}>{renderRow(stage.row)}</Fragment>
            ) : stage.kind === 'folded' ? (
              <ProcessStageFold key={stage.id} rows={stage.rows} renderRow={renderRow} />
            ) : (
              <Fragment key={stage.id}>
                {stage.folded.length > 0 && <ProcessStageFold rows={stage.folded} renderRow={renderRow} />}
                {stage.visible.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}
              </Fragment>
            ),
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

/** Foldable "call chain" container. Auto-collapses once the real reply arrives; user can re-open. */
function ChainFold({
  id,
  events,
  trackLatest,
  open,
  onToggle,
  onRespond,
  onOpenFile,
}: {
  id: string
  events: UAEvent[]
  trackLatest?: boolean
  open: boolean
  onToggle: () => void
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const summary = useMemo(() => chainSummary(events), [events])
  const entries = useMemo(() => groupChainEvents(events), [events])
  const latestEvent = trackLatest
    ? events
        .filter((event) => event.type !== 'reasoning' || (event.payload.text || '').trim())
        .reduce<UAEvent | undefined>((latest, event) =>
          !latest || event.seq > latest.seq ? event : latest, undefined)
    : undefined
  const latestEventKey = latestEvent ? eventKey(latestEvent) : undefined
  const latestCommand = events.findLast((event) =>
    event.type === 'command_exec' && event.state === 'running')

  return (
    <div
      className={`chain-fold ${open ? 'open' : 'closed'}`}
      data-chain-id={id}
    >
      <div className="chain-head" onClick={onToggle}>
        <span className="chain-caret">
          <Chevron open={open} size={14} />
        </span>
        <span className="chain-title">调用链路</span>
        <span className="chain-summary">{summary}</span>
      </div>
      <AnimatedCollapse open={open} className="chain-disclosure">
        <div className="chain-body">
          {entries.map((entry) => entry.kind === 'reasoning'
              ? <ReasoningBatch
                  key={`${entry.id}-${latestEventKey}`}
                  events={entry.events}
                  latestOutputKey={latestEventKey}
                  onOpenFile={onOpenFile}
                />
            : entry.kind === 'commands'
              ? <CommandBatch key={entry.id} events={entry.events} />
              : <EventCard
                  key={eventKey(entry.event)}
                  ev={entry.event}
                  forceOpen={entry.event === latestCommand}
                  latestOutputKey={latestEventKey}
                  onRespond={onRespond}
                  onOpenFile={onOpenFile}
                />
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

type ChainEntry =
  | { kind: 'event'; event: UAEvent }
  | { kind: 'reasoning'; id: string; events: UAEvent[] }
  | { kind: 'commands'; id: string; events: UAEvent[] }

/** Batch reasoning and completed Bash commands; keep only the currently running Bash visible. */
export function groupChainEvents(events: UAEvent[]): ChainEntry[] {
  const entries: ChainEntry[] = []
  const latestCommand = events.findLast((event) =>
    event.type === 'command_exec' && event.state === 'running')
  let commandBatch: Extract<ChainEntry, { kind: 'commands' }> | undefined
  for (const event of events) {
    if (event.type === 'hook') continue
    const last = entries[entries.length - 1]
    if (event.type === 'reasoning' && (event.payload.text || '').trim()) {
      if (last?.kind === 'reasoning') last.events.push(event)
      else entries.push({
        kind: 'reasoning',
        id: `reasoning-${event.payload?.turnId ?? 'turn'}-${event.payload?.id ?? event.seq}`,
        events: [event],
      })
      continue
    }
    if (event.type === 'command_exec' && event !== latestCommand) {
      if (commandBatch) commandBatch.events.push(event)
      else {
        commandBatch = { kind: 'commands', id: `commands-${event.payload?.turnId ?? 'turn'}-${event.payload?.id ?? event.seq}`, events: [event] }
        entries.push(commandBatch)
      }
      continue
    }
    entries.push({ kind: 'event', event })
  }
  return entries
}

function ReasoningBatch({
  events,
  latestOutputKey,
  onOpenFile,
}: {
  events: UAEvent[]
  latestOutputKey?: string
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(events.some((event) => eventKey(event) === latestOutputKey))
  if (events.length === 1) return (
    <EventCard ev={events[0]} latestOutputKey={latestOutputKey} onOpenFile={onOpenFile} />
  )
  return (
    <div className={`hook-batch command-batch reasoning-batch${open ? ' open' : ''}`}>
      <button className="hook-batch-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <UiIcon name="lightbulb" size={14} />
        <span className="hook-batch-title">思考</span>
        <span className="hook-batch-count">{events.length} 个</span>
        <span className="hook-batch-caret"><Chevron open={open} size={12} /></span>
      </button>
      <AnimatedCollapse open={open} keepMounted className="hook-batch-disclosure">
        <div className="hook-batch-body">
          {events.map((event) => (
            <EventCard
              key={eventKey(event)}
              ev={event}
              latestOutputKey={latestOutputKey}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

function CommandBatch({ events }: { events: UAEvent[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const completed = events.filter((event) => event.state === 'success').length
  const running = events.filter((event) => event.state === 'running').length
  const failed = events.filter((event) => event.state === 'failed' || event.state === 'cancelled').length

  return (
    <div className={`hook-batch command-batch${open ? ' open' : ''}`}>
      <button className="hook-batch-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cmd-icon">{'>_'}</span>
        <span className="hook-batch-title">Bash</span>
        <span className="hook-batch-count">{events.length} 个</span>
        <span className="hook-batch-summary">
          {completed > 0 && <span className="success">{completed} 已完成</span>}
          {running > 0 && <span className="running">{running} 运行中</span>}
          {failed > 0 && <span className="failed">{failed} 失败</span>}
        </span>
        <span className="hook-batch-caret"><Chevron open={open} size={12} /></span>
      </button>
      <AnimatedCollapse open={open} keepMounted className="hook-batch-disclosure">
        <div className="hook-batch-body">
          {events.map((event) => <EventCard key={eventKey(event)} ev={event} />)}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

function TurnHooks({ id, events }: { id: string; events: UAEvent[] }): JSX.Element {
  const completed = events.filter((event) => event.state === 'success').length
  const running = events.filter((event) => event.state === 'running').length
  const failed = events.filter((event) => event.state === 'failed' || event.state === 'cancelled').length
  const groups = new Map<string, UAEvent[]>()
  for (const event of events) {
    const name = event.payload?.eventName || 'Hook'
    const group = groups.get(name)
    if (group) group.push(event)
    else groups.set(name, [event])
  }
  return (
    <section id={id} className="turn-hooks" aria-label="本轮 Hook 调用">
      <div className="hook-batch-head">
        <span className="hook-batch-icon" aria-hidden><UiIcon name="zap" size={14} /></span>
        <span className="hook-batch-title">本轮 Hooks</span>
        <span className="hook-batch-count">{events.length} 个</span>
        <span className="hook-batch-summary">
          {completed > 0 && <span className="success">{completed} 已完成</span>}
          {running > 0 && <span className="running">{running} 运行中</span>}
          {failed > 0 && <span className="failed">{failed} 失败</span>}
        </span>
      </div>
      <div className="hook-batch-body">
        {[...groups].map(([name, group]) => (
          <details key={name} className="turn-hook-group" aria-label={name}>
            <summary className="hook-type-head">
              <span className="hook-row-caret"><Chevron open={false} size={12} /></span>
              <span className="hook-type-name">{name}</span>
              <span className="hook-batch-count">{group.length} 个</span>
            </summary>
            {group.map((event) => <HookRow key={`${event.payload.turnId ?? ''}:${eventKey(event)}`} event={event} />)}
          </details>
        ))}
      </div>
    </section>
  )
}

function HookRow({ event }: { event: UAEvent }): JSX.Element {
  const [open, setOpen] = useState(false)
  const entries = Array.isArray(event.payload?.entries) ? event.payload.entries : []
  const sourcePath = typeof event.payload?.sourcePath === 'string' ? event.payload.sourcePath : ''
  const sourceFile = sourcePath.split(/[\\/]/).filter(Boolean).pop() || event.payload?.source || '未知来源'
  const status = event.state === 'running' ? '运行中'
    : event.state === 'failed' ? '失败'
      : event.state === 'cancelled' ? '已取消'
        : '完成'

  return (
    <div className={`hook-row-wrap${open ? ' open' : ''} state-${event.state || 'success'}`}>
      <button className="hook-row" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="hook-state-dot" aria-hidden />
        <span className="hook-name">{event.payload?.eventName || 'Hook'}</span>
        <code className="hook-source" title={sourcePath}>{sourceFile}</code>
        <span className="hook-status">
          {status}{Number.isFinite(event.payload?.durationMs) ? ` · ${fmtHookDuration(event.payload.durationMs)}` : ''}
        </span>
        <span className="hook-row-caret"><Chevron open={open} size={12} /></span>
      </button>
      <AnimatedCollapse open={open} keepMounted className="hook-row-disclosure">
        <div className="hook-detail">
          <dl>
            <dt>来源</dt><dd><code>{sourcePath || '—'}</code></dd>
            <dt>处理器</dt><dd><code>{[event.payload?.handlerType, event.payload?.executionMode, event.payload?.scope].filter(Boolean).join(' · ') || '—'}</code></dd>
            <dt>状态信息</dt><dd>{event.payload?.statusMessage || '—'}</dd>
            <dt>运行 ID</dt><dd><code>{event.payload?.id || '—'}</code></dd>
          </dl>
          <div className="hook-output">
            <strong>Hook 输出 · {entries.length} 条</strong>
            <pre>{entries.length ? entries.map(formatHookEntry).join('\n\n') : '无输出'}</pre>
          </div>
        </div>
      </AnimatedCollapse>
    </div>
  )
}

function formatHookEntry(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return String(entry)
  const item = entry as Record<string, unknown>
  const body = typeof item.text === 'string' ? item.text : JSON.stringify(item, null, 2)
  return typeof item.kind === 'string' ? `${item.kind}  ${body}` : body
}

function fmtHookDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

/**
 * Stable per-event React key. Streaming re-emits reuse the same `payload.id`
 * but get a fresh `seq` each delta; keying off `seq` would remount the node
 * every token (making the block flash instead of grow), so prefer the id.
 */
function eventKey(ev: UAEvent): string {
  return ev.payload?.id ? `${ev.type}-${ev.payload.id}` : `${ev.type}-${ev.seq}`
}

function chainSummary(events: UAEvent[]): string {
  let queueWaitMs: number | null = null
  let think = 0
  let cmd = 0
  let tool = 0
  let task = 0
  let file = 0
  let warn = 0
  for (const ev of events) {
    if (ev.type === 'queue_status') {
      const waitedMs = (ev.payload?.queue as QueueStatus | undefined)?.waitedMs
      if (Number.isFinite(waitedMs)) queueWaitMs = Math.max(0, waitedMs as number)
    } else if (ev.type === 'reasoning') {
      // Mirror the render guard (G2-11): an empty reasoning item shows nothing,
      // so it shouldn't inflate the "思考 N" summary either.
      if ((ev.payload.text || '').trim()) think++
    } else if (ev.type === 'command_exec') cmd++
    else if (ev.type === 'tool_call') tool++
    else if (ev.type === 'background_task') task++
    else if (ev.type === 'file_change') file++
    else if (ev.type === 'error' || ev.type === 'system_notice' && !['team_event', 'token_speed'].includes(ev.payload?.kind)) warn++
  }
  const parts: string[] = []
  if (queueWaitMs !== null) parts.push(`等待算力 ${fmtWait(queueWaitMs)}`)
  if (think) parts.push(`思考 ${think}`)
  if (cmd) parts.push(`命令 ${cmd}`)
  if (tool) parts.push(`工具 ${tool}`)
  if (task) parts.push(`后台任务 ${task}`)
  if (file) parts.push(`文件 ${file}`)
  if (warn) parts.push(`提示 ${warn}`)
  return parts.length ? parts.join(' · ') : `${events.length} 步`
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

function ContextCompactionRow({ ev }: { ev: UAEvent }): JSX.Element {
  const running = ev.state === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const startedAt = ev.payload.startedAt ?? (running ? ev.ts : undefined)
  const durationMs = running && Number.isFinite(startedAt)
    ? Math.max(0, now - startedAt) : ev.payload.durationMs
  const state = running ? '压缩中…' : ev.state === 'failed' ? '失败'
    : ev.state === 'cancelled' ? '已取消' : '已完成'
  const label = running ? '上下文压缩中…' : ev.state === 'failed' ? '上下文压缩失败'
    : ev.state === 'cancelled' ? '上下文压缩已取消' : '上下文压缩完成'
  return (
    <div className={`step-call context-compaction state-${ev.state}`} data-compaction-id={ev.payload.id} role="status" aria-label={label} aria-live="polite">
      <div className="step-call-row">
        <UiIcon name="collapse" size={14} />
        <span className="step-call-name">上下文压缩</span>
        <span className="step-call-status context-compaction-status">
          {running && <span className="spin" />}{state}
          {Number.isFinite(durationMs) && durationMs >= 0 && <span className="context-compaction-duration">{fmtHookDuration(durationMs)}</span>}
        </span>
      </div>
      {ev.state === 'failed' && ev.payload.error && <div className="context-compaction-error">{String(ev.payload.error)}</div>}
    </div>
  )
}

function EventCard({
  ev,
  onRespond,
  cumulative,
  queueWaitMs,
  onOpenFile,
  forceOpen,
  latestOutputKey,
}: {
  ev: UAEvent
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  cumulative?: CumUsage
  queueWaitMs?: number
  onOpenFile?: (path: string, line?: number) => void
  forceOpen?: boolean
  latestOutputKey?: string
}): JSX.Element | null {
  const stateKey = ev.type === 'reasoning' ? latestOutputKey : undefined
  const autoOpen = ev.type === 'reasoning'
    ? !!latestOutputKey && eventKey(ev) === latestOutputKey
    : forceOpen || defaultOpen(ev)
  const [manualOpen, setManualOpen] = useState<{ key?: string; value: boolean }>()
  const open = manualOpen && manualOpen.key === stateKey ? manualOpen.value : autoOpen
  const setOpen = (value: boolean): void => setManualOpen({ key: stateKey, value })

  switch (ev.type) {
    case 'reasoning': {
      // G2-11: skip the "思考" card entirely when there is no reasoning text —
      // some turns emit an empty reasoning item, which otherwise renders as a
      // clickable-but-empty expander.
      const text = (ev.payload.text || '').trim()
      if (!text) return null
      return (
        <div className="card reasoning">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <UiIcon name="lightbulb" size={14} />
            <span className="reasoning-title">思考</span>
            <span className="reasoning-preview" title={text}>{text}</span>
            <span className="reasoning-caret"><Chevron open={open} size={12} /></span>
          </div>
          <AnimatedCollapse open={open} className="reasoning-disclosure">
            <div className="reasoning-body">
              <Markdown text={ev.payload.text || ''} onOpenFile={onOpenFile} />
            </div>
          </AnimatedCollapse>
        </div>
      )
    }

    case 'command_exec':
      return (
        <div className={`card command state-${ev.state}`}>
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="cmd-icon">{'>_'}</span>
            <code className="cmd-line">
              {ev.payload.command || '(命令输出)'}
            </code>
            <StateTag state={ev.state} />
            {ev.payload.exitCode != null && (
              <span className="exit-code">exit {ev.payload.exitCode}</span>
            )}
            <span className="command-caret"><Chevron open={open} size={12} /></span>
          </div>
          <AnimatedCollapse open={open && !!ev.payload.output} className="command-disclosure">
            <pre className="cmd-output">{ev.payload.output}</pre>
          </AnimatedCollapse>
        </div>
      )

    case 'background_task': {
      const status = ev.state === 'running' ? '运行中'
        : ev.state === 'failed' ? '失败'
          : ev.state === 'cancelled' ? '已取消'
            : '已完成'
      return (
        <div className={`hook-row-wrap background-task${open ? ' open' : ''} state-${ev.state || 'success'}`}>
          <button className="hook-row" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="hook-state-dot" aria-hidden />
            <span className="hook-name">后台任务 #{ev.payload.taskId || ev.payload.id}</span>
            <span className="hook-status">{status}</span>
            <span className="hook-row-caret"><Chevron open={open} size={12} /></span>
          </button>
          <AnimatedCollapse open={open} keepMounted className="hook-row-disclosure">
            <div className="hook-detail">
              <dl>
                <dt>摘要</dt><dd>{ev.payload.summary || '—'}</dd>
                <dt>输出</dt><dd><code>{ev.payload.outputFile || '—'}</code></dd>
              </dl>
            </div>
          </AnimatedCollapse>
        </div>
      )
    }

    case 'file_change':
      return (
        <div className={`card file-change state-${ev.state}`}>
          <div className="card-head">
            <UiIcon name="file-diff" size={14} /> 文件改动 <StateTag state={ev.state} />
          </div>
          <ul className="file-list">
            {(ev.payload.changes || []).map((c: any, i: number) => (
              <li key={i}>
                <span className={`kind kind-${c.kind}`}>
                  {kindLabel(c.kind)}
                </span>{' '}
                {c.path}
              </li>
            ))}
          </ul>
        </div>
      )

    case 'tool_call': {
      if (isGeneratedImageEvent(ev)) return <GeneratedImageCard ev={ev} />
      const imagePath = viewImagePath(ev)
      return (
        <div className={`card tool-call state-${ev.state}`}>
          <div className="card-head" onClick={() => setOpen(!open)}>
            <UiIcon name="plug" size={14} />
            <span className="tool-call-title">{toolCallTitle(ev.payload)}</span>
            {imagePath && <ViewImageThumbnail key={`${ev.sessionId}:${eventKey(ev)}:${imagePath}`} event={ev} path={imagePath} />}
            <StateTag state={ev.state} />
            <span className="tool-call-caret"><Chevron open={open} size={12} /></span>
          </div>
          <AnimatedCollapse open={open} className="tool-disclosure">
            <pre className="tool-body">
              {JSON.stringify(toolCallDetail(ev.payload, ev.state), null, 2)}
            </pre>
          </AnimatedCollapse>
        </div>
      )
    }

    case 'approval_request':
      return <ApprovalCard ev={ev} onRespond={onRespond} />

    case 'queue_status': {
      const view = computeQueueViews([ev])[0]?.view
      return view ? <QueueWaitStep view={view} /> : null
    }

    case 'context_compaction':
      return <ContextCompactionRow ev={ev} />

    case 'error': {
      const limit = providerContextLimit(ev.payload.message)
      if (limit) {
        return (
          <div className="card error">
            <div className="card-head"><UiIcon name="warn" size={13} />本次请求超过模型上下文上限</div>
            <div className="error-msg">
              {limit.tokens
                ? `${limit.model || '当前模型'} 返回 ${limit.tokens.toLocaleString('en-US')} tokens 上限。`
                : '本次请求超过当前模型的上下文容量。'}
              请换用更大上下文的模型，或新建会话并带入任务摘要。
            </div>
            <details className="context-limit-detail">
              <summary>技术详情</summary>
              <pre className="error-detail">{ev.payload.message}{ev.payload.detail ? `\n${ev.payload.detail}` : ''}</pre>
            </details>
          </div>
        )
      }
      if (ev.payload.authLogin) {
        const status = ev.payload.authStatus
        const url = typeof ev.payload.loginUrl === 'string' ? ev.payload.loginUrl : ''
        const body = status === 'success'
          ? `Kimi Code 登录已完成。${url ? `\n\n[再次打开 Kimi Code 登录网页 ↗](${url})` : ''}\n\n请重新发送这条消息。`
          : status === 'failed'
            ? `${ev.payload.loginError || 'Kimi Code 登录未完成。'}${url ? `\n\n[打开 Kimi Code 登录网页 ↗](${url})` : ''}`
            : url
              ? `登录网页已自动打开，请在浏览器完成授权。\n\n[打开 Kimi Code 登录网页 ↗](${url})\n\n完成登录后，请重新发送这条消息。`
              : '正在启动 Kimi Code 登录…'
        return (
          <>
            <div className="card error">
              <div className="card-head"><UiIcon name="warn" size={13} />Kimi Code 登录已失效</div>
              <Markdown text={body} onOpenFile={onOpenFile} />
            </div>
            {(status === 'starting' || status === 'awaiting') && (
              <div className="context-compaction state-running" role="status" aria-live="polite">
                <span className="context-compaction-icon" aria-hidden>◌</span>
                <span>{status === 'awaiting' ? '正在等待登录完成…' : '正在启动登录…'}</span>
              </div>
            )}
          </>
        )
      }
      return (
        <div className="card error">
          <div className="card-head"><UiIcon name="warn" size={13} />错误</div>
          <div className="error-msg">{ev.payload.message}</div>
          {ev.payload.detail && (
            <details className="error-details">
              <summary><Chevron size={10} />错误详情</summary>
              <pre className="error-detail">{ev.payload.detail}</pre>
            </details>
          )}
        </div>
      )
    }

    case 'system_notice':
      if (ev.payload.kind === 'token_speed') return null
      if (ev.payload.kind === 'context_usage' || ev.payload.kind === 'usage_report') {
        return <div className="card system-notice"><Markdown text={formatClaudeNativeReport(ev.payload.kind, ev.payload.contextUsage ?? ev.payload.usageReport)} onOpenFile={onOpenFile} /></div>
      }
      if (ev.payload.kind === 'usage') {
        return <UsageCard ev={ev} cumulative={cumulative} queueWaitMs={queueWaitMs} />
      }
      if (ev.payload.kind === 'launch') {
        return <LaunchNotice event={ev} />
      }
      return <ProcessNotice ev={ev} onOpenFile={onOpenFile} />

    case 'raw_output':
      return <ProcessNotice ev={ev} onOpenFile={onOpenFile} />

    default:
      return null
  }
}

/**
 * 启动信息卡片：标题行 + 关键参数 chips 直读，完整命令、追加的系统提示与
 * 按内容去重的启动警告折叠在展开区。warnings 由 processItems 归并（紧随
 * launch 的 warning 通知）。
 */
export function LaunchNotice({
  event,
  warnings = [],
}: {
  event: UAEvent
  warnings?: UAEvent[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const payload = event.payload || {}
  const label = typeof payload.label === 'string' && payload.label ? payload.label : 'Agent'
  const chips: Array<{ name?: string; value: string; primary?: boolean }> = []
  if (payload.model) chips.push({ value: String(payload.model), primary: true })
  if (payload.effort) chips.push({ name: 'effort', value: String(payload.effort) })
  if (payload.sandbox) chips.push({ name: 'sandbox', value: String(payload.sandbox) })
  if (payload.approvalPolicy) chips.push({ name: 'approval', value: String(payload.approvalPolicy) })
  if (typeof payload.maxMode === 'boolean') chips.push({ name: 'max', value: payload.maxMode ? 'on' : 'off' })
  if (payload.mode) chips.push({ name: 'mode', value: String(payload.mode) })
  const prompt = typeof payload.appendedPrompt === 'string' ? payload.appendedPrompt.trim() : ''
  const command = String(payload.text || '').replace(/^启动:\s*/, '')
  const warningCounts = new Map<string, number>()
  for (const warning of warnings) {
    const text = String(warning.payload?.text || '')
    warningCounts.set(text, (warningCounts.get(text) ?? 0) + 1)
  }
  return (
    <div className={`launch-card${open ? ' open' : ''}`}>
      <button className="launch-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <UiIcon name="zap" size={14} />
        <span className="launch-title">已启动 <span className="launch-label">{label}</span></span>
        <span className="launch-side">
          {warnings.length > 0 && (
            <span className="launch-warn"><UiIcon name="warn" size={12} />{warnings.length} 条警告</span>
          )}
          <Chevron open={open} size={12} />
        </span>
      </button>
      {chips.length > 0 && (
        <div className="launch-chips">
          {chips.map((chip) => (
            <span key={`${chip.name ?? ''}:${chip.value}`} className={`launch-chip${chip.primary ? ' primary' : ''}`}>
              {chip.name && <b>{chip.name}</b>}{chip.value}
            </span>
          ))}
        </div>
      )}
      <AnimatedCollapse open={open} keepMounted className="launch-disclosure">
        <div className="launch-body">
          <div className="launch-sec">
            <div className="launch-sec-h">完整启动命令</div>
            <pre className="launch-pre">{command}</pre>
          </div>
          {prompt && <AppendedPromptCard prompt={prompt} />}
          {warningCounts.size > 0 && (
            <div className="launch-sec">
              <div className="launch-sec-h">启动警告 · 按内容去重</div>
              {[...warningCounts.entries()].map(([text, count]) => (
                <div className="launch-warnrow" key={text}>
                  <UiIcon name="warn" size={11} />
                  <span className="launch-warntext">{text}</span>
                  {count > 1 && <span className="launch-warncnt">×{count}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

export function AppendedPromptCard({ prompt }: { prompt: string }): JSX.Element {
  return (
    <details className="launch-prompt-card">
      <summary className="launch-prompt-head">
        <UiIcon name="sparkles" size={14} />
        <span className="launch-prompt-title">本次启动追加的系统提示</span>
        <span className="launch-prompt-tokens">约 {Math.max(1, Math.ceil(new TextEncoder().encode(prompt).length / 4))} tokens</span>
        <span className="launch-prompt-caret"><Chevron size={12} /></span>
      </summary>
      <pre>{prompt}</pre>
    </details>
  )
}

function StateTag({ state }: { state?: string }): JSX.Element | null {
  if (!state) return null
  const map: Record<string, string> = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    pending: '等待',
    cancelled: '已取消',
  }
  return <span className={`state-tag st-${state}`}>{map[state] || state}</span>
}

/**
 * Per-turn token card (G2-1). The collapsed line shows ONLY this turn's input /
 * output (plus cache-hit when present). Clicking expands to a compact two-row
 * table: one row for THIS turn (本轮 = one question + one answer) and one row for
 * the whole-session cumulative totals (会话累计 = sum across every turn so far).
 * The two rows differ once a session has more than one turn.
 */
function UsageCard({
  ev,
  cumulative,
  queueWaitMs,
}: {
  ev: UAEvent
  cumulative?: CumUsage
  queueWaitMs?: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const u = ev.payload.usage || {}
  const inTok = u.inputTokens ?? u.input_tokens
  const outTok = u.outputTokens ?? u.output_tokens
  const cached = u.cachedInputTokens ?? u.cached_input_tokens
  const cost = u.cost ?? ev.payload.cost
  // Prefer the adapter's own session totals (streaming path carries them);
  // otherwise fall back to the running sum we computed across usage footers.
  const sInput = u.sessionInputTokens ?? cumulative?.input
  const sOutput = u.sessionOutputTokens ?? cumulative?.output
  const sCached = u.sessionCachedInputTokens ?? cumulative?.cached
  const sCost = u.sessionCost !== undefined ? u.sessionCost : cumulative?.cost

  return (
    <div className={`card system-notice usage ${open ? 'open' : ''}`}>
      <div className="usage-line" onClick={() => setOpen((v) => !v)}>
        <span className="usage-caret">
          <Chevron open={open} size={13} />
        </span>
        <span>
          本轮 · 输入 {fmtInt(inTok)} · 输出 {fmtInt(outTok)}
        </span>
        {cached != null && cached > 0 && (
          <span> · 命中缓存 {fmtInt(cached)}</span>
        )}
        {queueWaitMs !== undefined && queueWaitMs > 0 && (
          <span> · 等待算力 {Math.round(queueWaitMs / 1000)}s</span>
        )}
      </div>
      {open && (
        <table className="usage-table">
          <thead>
            <tr>
              <th></th>
              <th>输入</th>
              <th>输出</th>
              <th>命中缓存</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>本轮</th>
              <td>{fmtInt(inTok)}</td>
              <td>{fmtInt(outTok)}</td>
              <td>{cached != null && cached > 0 ? fmtInt(cached) : '—'}</td>
              <td>{cost != null ? fmtCost(cost) : '—'}</td>
            </tr>
            <tr>
              <th>会话累计</th>
              <td>{fmtInt(sInput)}</td>
              <td>{fmtInt(sOutput)}</td>
              <td>{sCached != null && sCached > 0 ? fmtInt(sCached) : '—'}</td>
              <td>{sCost != null ? fmtCost(sCost) : '—'}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

function defaultOpen(ev: UAEvent): boolean {
  if (ev.type === 'reasoning') return false
  if (ev.type === 'command_exec') return ev.state === 'failed'
  if (ev.type === 'background_task') return ev.state === 'failed' || ev.state === 'cancelled'
  if (ev.type === 'tool_call') return false
  return true
}

function kindLabel(k: string): string {
  return (
    {
      add: '新增',
      modify: '修改',
      delete: '删除',
      rename: '重命名',
      update: '修改',
    }[k] || k
  )
}

/** Thousands-separated integer for the usage line (Doc5 T1). */
function fmtInt(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?'
  return Math.round(n).toLocaleString('en-US')
}

/** Cost with 4 decimals; sub-0.0001 shows "<$0.0001" (Doc5 T1). */
function fmtCost(c: number): string {
  if (!Number.isFinite(c)) return ''
  if (c > 0 && c < 0.0001) return '<$0.0001'
  return '$' + c.toFixed(4)
}

/**
 * Interactive approval / question card (Doc3 需求). Renders the pending
 * server→client request according to its `kind` and collects the user's
 * decision, then calls `onRespond` with the exact decision shape the provider
 * expects. ACP permission requests echo the exact offered option id; legacy
 * app-server requests keep their accept/decline or approved/denied shapes.
 */
export const ReadOnlyConversationContext = createContext(false)

export function ApprovalCard({
  ev, onRespond, readOnly,
}: {
  ev: UAEvent
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  readOnly?: boolean
}): JSX.Element {
  const presentation = useContext(RequestPresentationContext)
  if (presentation.docked || ev.payload.kind === 'planMode' || isQuestionKind(ev.payload.kind, ev.payload.params)) return <CompactRequestCard ev={ev}
    onSelect={presentation.docked && onRespond && !readOnly ? () => presentation.select(ev) : undefined}
    highlighted={presentation.locateSeq === ev.seq} readOnly={readOnly} />
  return <div className="interaction-step" data-interaction-seq={ev.seq}>
    <span className="process-step-node interaction-node" aria-hidden><UiIcon name="shield" size={13} /></span>
    <div className="process-step-content"><RequestDetailCard ev={ev} onRespond={onRespond} readOnly={readOnly} /></div>
  </div>
}

function interactionTitle(event: UAEvent): string {
  if (event.payload.teamQuestion) return 'UniAgent 提问'
  if (event.payload.delivery === 'async') return '异步提问'
  return kindTitle(isMcpToolApproval(event.payload.params) ? 'mcpTool' : event.payload.kind)
}

function interactionSummary(event: UAEvent): string {
  const { kind, params, method } = event.payload
  if (isQuestionKind(kind, params)) {
    const field = normalizeQuestions(questionAnswerKind(kind, method), params)[0]
    return field?.prompt || field?.title || params?.message || 'Agent 需要你补充信息'
  }
  if (kind === 'mcpTool' || isMcpToolApproval(params)) {
    const detail = mcpToolApprovalDetail(params)
    return `${detail.serverName} · ${detail.toolName}`
  }
  const command = params?.command ?? params?.rawInput?.command
  if (command) return Array.isArray(command) ? command.join(' ') : String(command)
  if (kind === 'planMode') return '是否开始实施此计划？'
  const changes = params?.changes || params?.fileChanges
  if (changes) return (Array.isArray(changes) ? changes : Object.keys(changes)).map((item: any) => typeof item === 'string' ? item : item.path).join('、')
  return params?.reason || params?.title || params?.summary || params?.message || kindTitle(kind)
}

function isAnsweredQuestion(event: UAEvent): boolean {
  if (!isQuestionKind(event.payload.kind, event.payload.params) || event.payload.interactionExpired ||
    event.state === 'failed' || event.state === 'cancelled' || isCancelledApprovalAnswer(event.payload.submittedAnswer) || isSkippedQuestionAnswer(event.payload.submittedAnswer)) return false
  if (event.state === 'success') return true
  if (event.payload.submittedAnswer === undefined) return false
  const kind = questionAnswerKind(event.payload.kind, event.payload.method)
  try {
    validateQuestionAnswer(kind, normalizeQuestions(kind, event.payload.params), event.payload.submittedAnswer)
    return true
  } catch { return false }
}

function interactionOutcome(event: UAEvent): string {
  if (event.payload.interactionExpired || event.state === 'failed') return '已失效'
  if (event.state === 'cancelled' || isCancelledApprovalAnswer(event.payload.submittedAnswer)) return '已取消'
  if (isPendingInteraction(event)) return isQuestionKind(event.payload.kind, event.payload.params) ? '待回答' : '待处理'
  const answer = event.payload.submittedAnswer
  if (event.payload.kind === 'planMode') return answer?.decision === 'approved' ? '已确认' : answer?.decision === 'rejected' ? '已反馈' : '已跳过'
  if (isQuestionKind(event.payload.kind, event.payload.params)) return isSkippedQuestionAnswer(answer) ? '已跳过' : isAnsweredQuestion(event) ? '已回答' : '待回答'
  const optionId = answer?.optionId || answer?.outcome?.optionId
  const optionKind = event.payload.options?.find((option: any) => option.optionId === optionId)?.kind
  const decision = answer?.decision || answer?.action || optionKind
  if (['decline', 'denied', 'deny', 'reject_once', 'reject_always', 'rejected'].includes(decision)) return '已拒绝'
  if (['accept', 'approved', 'acceptForSession', 'approved_for_session', 'allow_once', 'allow_always', 'allowOnce', 'allowAlways'].includes(decision)) return '已允许'
  return '已处理'
}

function CompactRequestCard({ ev, onSelect, highlighted, readOnly }: { ev: UAEvent; onSelect?: () => void; highlighted: boolean; readOnly?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const pending = isPendingInteraction(ev)
  const readOnlyConversation = useContext(ReadOnlyConversationContext)
  const canAnswer = pending && !!onSelect && !readOnly && !readOnlyConversation
  const question = isQuestionKind(ev.payload.kind, ev.payload.params)
  const answered = isAnsweredQuestion(ev)
  return <div className={`interaction-step${ev.payload.teamQuestion ? ' team-question-step' : ''}${answered ? ' answered' : ''}`} data-interaction-seq={ev.seq}>
    <span className="process-step-node interaction-node" aria-hidden><UiIcon name={question ? 'question' : 'shield'} size={13} /></span>
    <div className={`interaction-timeline${pending ? ' pending' : ''}${highlighted ? ' highlighted' : ''}`}>
    <div className="interaction-compact">
      <span className="interaction-kind">{interactionTitle(ev)}</span>
      <span className="interaction-summary" title={interactionSummary(ev)}>{open && question ? '' : interactionSummary(ev)}</span>
      <span className="interaction-state">{interactionOutcome(ev)}</span>
      <button type="button" className="interaction-link" aria-expanded={canAnswer ? undefined : open}
        onClick={() => canAnswer ? onSelect?.() : setOpen(!open)}>{canAnswer ? question ? '去回答' : '去处理' : open ? '收起' : '详情'}{!canAnswer && <Chevron open={open} size={10} />}</button>
    </div>
    {open && <RequestDetailCard ev={ev} readOnly />}
    </div>
  </div>
}

function RequestDetailCard({
  ev,
  onRespond,
  readOnly,
}: {
  ev: UAEvent
  onRespond?: (requestId: string, answer: unknown) => void | Promise<void>
  readOnly?: boolean
}): JSX.Element {
  const readOnlyConversation = useContext(ReadOnlyConversationContext)
  const { onOpenFile } = useContext(RequestPresentationContext)
  const { requestId, kind, params, method, options } = ev.payload
  const resolved = ev.state === 'success' || ev.state === 'cancelled' || ev.state === 'failed' || !!ev.payload.interactionExpired || isAnsweredQuestion(ev)
  const mcpTool = kind === 'mcpTool' || (kind === 'elicitation' && isMcpToolApproval(params))
  const effectiveKind = mcpTool ? 'mcpTool' : kind
  const question = isQuestionKind(effectiveKind)
  const title = ev.payload.teamQuestion ? 'UniAgent 提问' : kindTitle(effectiveKind)
  const icon = <UiIcon name={question ? 'question' : 'shield'} size={14} />
  const submittedAnswer = ev.payload.submittedAnswer
  const cancelled = ev.state === 'cancelled' || isCancelledApprovalAnswer(submittedAnswer)
  const [done, setDone] = useState<string | null>(
    cancelled
      ? '取消'
      : submittedAnswer === undefined
      ? null
      : approvalAnswerLabel(effectiveKind, submittedAnswer),
  )
  const [answer, setAnswer] = useState<unknown>(submittedAnswer)
  const [resolvedOpen, setResolvedOpen] = useState(false)
  const [responding, setResponding] = useState(false)
  const [responseError, setResponseError] = useState('')

  useEffect(() => {
    if (cancelled) {
      setDone('取消')
      setResolvedOpen(false)
      return
    }
    if (submittedAnswer === undefined) return
    setAnswer(submittedAnswer)
    setDone(approvalAnswerLabel(effectiveKind, submittedAnswer))
  }, [cancelled, effectiveKind, submittedAnswer])

  const displayedAnswer = submittedAnswer === undefined ? answer : submittedAnswer
  const displayedDone = cancelled
    ? '取消'
    : submittedAnswer === undefined
      ? done
      : approvalAnswerLabel(effectiveKind, submittedAnswer)

  async function respond(a: unknown, label: string): Promise<void> {
    if (responding || !onRespond) return
    setResponding(true); setResponseError('')
    try { await onRespond(requestId, a); setAnswer(a); setDone(label) }
    catch (error) { setResponseError(error instanceof Error ? error.message : '提交失败，请重试') }
    finally { setResponding(false) }
  }

  const legacy =
    method === 'execCommandApproval' || method === 'applyPatchApproval'
  const acceptVal = legacy ? { decision: 'approved' } : { decision: 'accept' }
  const sessionVal = legacy
    ? { decision: 'approved_for_session' }
    : { decision: 'acceptForSession' }
  const declineVal = legacy ? { decision: 'denied' } : { decision: 'decline' }
  // Native permission ids must round-trip without broadening the offered scope.
  const isACP = method === 'session/request_permission'
  const isZCode = method === 'zcode/permission'
  const acpOptions: Array<{ optionId: string; kind?: string; name?: string; label?: string }> = isACP || isZCode
    ? (Array.isArray(options) ? options : []).filter(
        (option: any) => typeof option?.optionId === 'string' && option.optionId.length > 0
      )
    : []

  if (readOnly || readOnlyConversation) {
    const outcome = typeof displayedAnswer === 'object' && displayedAnswer ? (displayedAnswer as any).outcome : undefined
    const optionId = (displayedAnswer as any)?.optionId || outcome?.optionId
    const offered = acpOptions.find(option => option.optionId === optionId)
    const decisionText = offered?.name || offered?.label || interactionOutcome({ ...ev, payload: { ...ev.payload, submittedAnswer: displayedAnswer } })
    return <div className={'card approval readonly-approval ' + (resolved ? 'resolved' : 'pending')}>
      <div className="card-head">{icon}{title} · {ev.payload.interactionExpired ? '已失效' : question ? resolved ? cancelled ? '已取消' : isSkippedQuestionAnswer(displayedAnswer) ? '已跳过' : '已回答' : '等待处理' : decisionText}</div>
      <TeamDecisionMaterials interactionId={ev.payload.teamInteractionId} />
      {question ? <QuestionForm kind={kind} method={method} params={params} answer={displayedAnswer} onOpenFile={onOpenFile} readOnly /> : kind === 'planMode' && params?.plan ? <Markdown text={params.plan} /> : <ApprovalDetail kind={effectiveKind} params={params} />}
      {!resolved && <p className="team-muted">请返回主会话查看请求处理状态</p>}
    </div>
  }

  if (resolved || displayedDone) {
    const expandable = !cancelled && isExpandableQuestionAnswer(effectiveKind, displayedAnswer)
    return (
      <div
        className={`card approval resolved${question ? ' question-card' : ''}${resolvedOpen ? ' open' : ''}`}
      >
        <div
          className={`card-head${expandable ? ' expandable' : ''}`}
          onClick={expandable ? () => setResolvedOpen((open) => !open) : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? resolvedOpen : undefined}
          onKeyDown={
            expandable
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setResolvedOpen((open) => !open)
                  }
                }
              : undefined
          }
        >
          {icon} {title} · 已{displayedDone || '处理'}
          {expandable && <Chevron open={resolvedOpen} size={13} />}
        </div>
        <TeamDecisionMaterials interactionId={ev.payload.teamInteractionId} />
        {expandable && resolvedOpen && (
          <QuestionForm
            kind={kind}
            method={method}
            params={params}
            answer={displayedAnswer}
            onOpenFile={onOpenFile}
            readOnly
          />
        )}
      </div>
    )
  }


  return (
    <div className={`card approval pending${question ? ' question-card' : ''}`} ref={(element) => { if (element) element.inert = !onRespond }}>
      <div className="card-head">
        {icon} {title}
        {/* 卡片现在渲染在链路之外（顶层），这枚胶囊点明「此刻等你」，让焦点落到它身上。 */}
        <span className="approval-wait-chip">{question ? '待你回答' : '待你授权'}</span>
      </div>
      {ev.payload.teamSource && <p className="team-muted">来自 {ev.payload.teamSource}</p>}
      <TeamDecisionMaterials interactionId={ev.payload.teamInteractionId} />
      {responseError && <div className="team-error" role="alert">{responseError}</div>}
      {question && kind === 'elicitation' && params?.message && <div className="question-prompt"><Markdown text={params.message} onOpenFile={onOpenFile} /></div>}
      <fieldset disabled={responding || !onRespond} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {!question && <ApprovalDetail kind={effectiveKind} params={params} />}
      {question ? (
        <QuestionForm
          kind={kind}
          method={method}
          params={params}
          onOpenFile={onOpenFile}
          hint={<>
            {ev.payload.delivery === 'async' && <p className="interaction-hint">Agent 可继续执行，回答将发回当前会话。</p>}
            {ev.payload.teamQuestion && <p className="interaction-hint">Agent 正在等待你的回答。</p>}
          </>}
          onSubmit={(payload) => respond(payload, '回答')}
          onSkip={ev.payload.delivery === 'async' && requestId?.startsWith(ASYNC_QUESTION_PREFIX)
            ? () => respond({ action: 'skip' }, '跳过') : undefined}
          onCancel={
            method === '_x.ai/ask_user_question' ? () => respond({ outcome: 'cancelled' }, '取消') : kind === 'elicitation' || method === 'zcode/userInput'
              ? () => respond({ action: 'cancel' }, '取消')
              : undefined
          }
        />
      ) : mcpTool ? (
        <div className="approval-actions">
          <button
            className="appr-btn appr-accept"
            onClick={() => respond(mcpToolApprovalAnswer('accept'), '允许一次')}
          >
            允许一次
          </button>
          {mcpToolApprovalScopes(params).includes('session') && (
            <button
              className="appr-btn appr-session"
              onClick={() => respond(mcpToolApprovalAnswer('accept', 'session'), '本会话允许')}
            >
              本会话允许
            </button>
          )}
          {mcpToolApprovalScopes(params).includes('always') && (
            <button
              className="appr-btn appr-always"
              onClick={() => respond(mcpToolApprovalAnswer('accept', 'always'), '始终允许')}
            >
              始终允许
            </button>
          )}
          <button
            className="appr-btn appr-decline"
            onClick={() => respond(mcpToolApprovalAnswer('decline'), '拒绝')}
          >
            拒绝
          </button>
        </div>
      ) : isACP || isZCode ? (
        <div className="approval-actions">
          {acpOptions.map((option) => {
            const label = option.name || option.label || option.optionId
            return (
              <button
                key={option.optionId}
                className={`appr-btn ${acpOptionClass(option.kind)}`}
                onClick={() =>
                  respond(
                    isZCode ? { optionId: option.optionId } : { outcome: { outcome: 'selected', optionId: option.optionId } },
                    `选择「${label}」`
                  )
                }
              >
                {label}
              </button>
            )
          })}
          {isACP && <button
            className="appr-btn appr-cancel"
            onClick={() => respond({ outcome: { outcome: 'cancelled' } }, '取消')}
          >
            取消
          </button>}
        </div>
      ) : (
        <div className="approval-actions">
          <button
            className="appr-btn appr-accept"
            onClick={() => respond(acceptVal, '批准')}
          >
            批准
          </button>
          {method !== 'claude/canUseTool' && <button
            className="appr-btn appr-session"
            onClick={() => respond(sessionVal, '本会话批准')}
          >
            本会话都批准
          </button>}
          <button
            className="appr-btn appr-decline"
            onClick={() => respond(declineVal, '拒绝')}
          >
            拒绝
          </button>
        </div>
      )}
      </fieldset>
    </div>
  )
}

export function isCancelledApprovalAnswer(answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false
  const value = answer as any
  return (
    value.action === 'cancel' ||
    value.decision === 'cancel' ||
    value.outcome === 'cancelled' ||
    value.outcome?.outcome === 'cancelled'
  )
}

export function approvalAnswerLabel(kind: string, answer: unknown): string {
  if (isCancelledApprovalAnswer(answer)) return '取消'
  if (isQuestionKind(kind) && isSkippedQuestionAnswer(answer)) return '跳过'
  return isQuestionKind(kind) ? '回答' : '处理'
}

export function isExpandableQuestionAnswer(kind: string, answer: unknown): boolean {
  return isQuestionKind(kind) && answer !== undefined && !isCancelledApprovalAnswer(answer) && !isSkippedQuestionAnswer(answer)
}

export function readonlyQuestionAnswer(
  field: Pick<NormalizedField, 'secret'>,
  values: string[],
): string {
  if (!values.length) return '未回答'
  return field.secret ? '已填写' : values.join('、')
}

function acpOptionClass(kind?: string): string {
  if (kind === 'allow_once' || kind === 'allowOnce') return 'appr-accept'
  if (kind === 'allowAlways') return 'appr-always'
  if (kind === 'allow_always') return 'appr-session'
  if (kind === 'reject_once' || kind === 'reject_always' || kind === 'deny') return 'appr-decline'
  return 'appr-session'
}

function ApprovalDetail({ kind, params }: { kind: string; params: any }): JSX.Element {
  if (kind === 'mcpTool') {
    const detail = mcpToolApprovalDetail(params)
    return (
      <div className="approval-detail mcp-tool-detail">
        <div className="mcp-tool-question">允许 {detail.serverName} 运行 {detail.toolName}？</div>
        {detail.description && <div className="mcp-tool-description">{detail.description}</div>}
        <div className="mcp-tool-params">
          <strong>{detail.toolName}</strong>
          {detail.parameters.map((parameter, index) => (
            <div className="mcp-tool-param" key={`${parameter.name}-${index}`}>
              <span>{parameter.name}</span><code>{typeof parameter.value === 'string' ? parameter.value : JSON.stringify(parameter.value)}</code>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (kind === 'command') {
    const rawCommand = params?.command ?? params?.rawInput?.command
    const cmd = Array.isArray(rawCommand) ? rawCommand.join(' ') : rawCommand
    return (
      <div className="approval-detail">
        <div className="approval-line">请求执行命令：</div>
        <pre className="approval-cmd">{cmd || params?.title || JSON.stringify(params, null, 2)}</pre>
        {params?.cwd && <div className="approval-cwd">目录：{params.cwd}</div>}
        {params?.reason && <div className="approval-line">原因：{params.reason}</div>}
      </div>
    )
  }
  if (kind === 'fileChange') {
    const changes = params?.changes || params?.fileChanges || []
    return (
      <div className="approval-detail">
        <div className="approval-line">请求修改文件：</div>
        <ul className="file-list">
          {(Array.isArray(changes) ? changes : Object.keys(changes || {})).map(
            (c: any, i: number) => (
              <li key={i}>{typeof c === 'string' ? c : c.path}
                {typeof c?.diff === 'string' && <details><summary>查看变更</summary><pre className="approval-raw">{c.diff}</pre></details>}
              </li>
            ),
          )}
        </ul>
      </div>
    )
  }
  return <pre className="approval-raw">{JSON.stringify(params, null, 2)}</pre>
}

function kindTitle(kind?: string): string {
  return (
    {
      command: '命令执行审批',
      fileChange: '文件修改审批',
      permission: '权限审批',
      permissions: '权限升级审批',
      mcpTool: 'MCP 工具授权',
      elicitation: '信息补充请求',
      question: '智能体提问',
      approval: '审批请求',
      planMode: '计划执行确认',
    }[kind || ''] || '审批请求'
  )
}

// 需求3(问题卡片) — NormalizedField / normalizeQuestions / OTHER_VALUE / encodeAnswer
// now live in the pure shared module `@shared/questions` (imported + re-exported at
// the top of this file) so the Feishu bridge and the renderer share one contract.

/**
 * 需求3 — the unified interactive form for question / elicitation requests. Renders
 * one group per NormalizedField (radio / checkbox / text), enforces required and
 * multi-select minItems before enabling submit, and encodes the reply per source.
 */
function optionDescription(option: { description?: string }): string {
  return typeof option.description === 'string' ? option.description.trim() : ''
}

export function QuestionForm({
  kind,
  method,
  params,
  onSubmit,
  onCancel,
  onSkip,
  onOpenFile,
  hint,
  answer,
  readOnly = false,
}: {
  kind: string
  method?: string
  params: any
  onSubmit?: (payload: unknown) => void
  onCancel?: () => void
  onSkip?: () => void
  onOpenFile?: (path: string, line?: number) => void
  hint?: ReactNode
  answer?: unknown
  readOnly?: boolean
}): JSX.Element {
  const answerKind = questionAnswerKind(kind, method)
  const fields = useMemo(() => normalizeQuestions(answerKind, params), [answerKind, params])
  const formId = useId()
  const [collected, setCollected] = useState<
    Record<string, { choice: string[]; text: string; other: string }>
  >({})

  const get = (id: string) => collected[id] || { choice: [], text: '', other: '' }
  const update = (
    id: string,
    patch: Partial<{ choice: string[]; text: string; other: string }>
  ): void => setCollected((prev) => ({ ...prev, [id]: { ...get(id), ...patch } }))

  const toggleChoice = (f: NormalizedField, value: string): void => {
    const state = get(f.id)
    if (f.type === 'single') {
      update(f.id, { choice: [value] })
      return
    }
    const has = state.choice.includes(value)
    let next = has ? state.choice.filter((v) => v !== value) : [...state.choice, value]
    if (f.maxItems && next.length > f.maxItems) next = next.slice(next.length - f.maxItems)
    update(f.id, { choice: next })
  }

  const fieldSatisfied = (f: NormalizedField): boolean => {
    const state = get(f.id)
    if (f.type === 'text') return !f.required || state.text.trim().length > 0
    const chosen = state.choice
    // An "其他" choice needs its text filled in to count.
    if (params?.teamQuestion && chosen.includes(OTHER_VALUE) && (!state.other.trim() || chosen.some(value => value !== OTHER_VALUE && value === state.other))) return false
    const effectiveCount = chosen.filter(v => v !== OTHER_VALUE || state.other.trim().length > 0).length
    if (f.type === 'multi') {
      const min = f.minItems ?? (f.required ? 1 : 0)
      return effectiveCount >= min && (!params?.teamQuestion || f.maxItems === undefined || effectiveCount <= f.maxItems)
    }
    return !f.required || effectiveCount >= 1
  }

  const canSubmit = fields.length > 0 && fields.every(fieldSatisfied)
  const answerFor = (field: NormalizedField): string[] => questionAnswerValues(answerKind, field, answer)

  // 需求Fix#2 — codex-style collapsed multi-question UX: when several questions are
  // asked at once, show ONE at a time with a pager ("第 X / N 问") and prev/next
  // navigation, instead of a long stacked list. A single question renders inline.
  const paged = fields.length > 1 && !readOnly
  const [page, setPage] = useState(0)
  const clampedPage = Math.min(page, Math.max(0, fields.length - 1))
  const visibleFields = paged ? [fields[clampedPage]] : fields
  const onLastPage = clampedPage >= fields.length - 1
  const currentSatisfied = fields[clampedPage] ? fieldSatisfied(fields[clampedPage]) : true

  const renderField = (f: NormalizedField): JSX.Element => (
    <div className="question-field" key={f.id}>
      {f.title && f.title.trim() !== f.prompt.trim() && <div className="question-title">{f.title}</div>}
      {f.prompt && <div className="question-prompt">{readOnly && <span className="question-detail-label">问题</span>}<Markdown text={f.prompt} onOpenFile={onOpenFile} /></div>}
      {!readOnly && f.detail && <Markdown text={f.detail} onOpenFile={onOpenFile} />}
      {readOnly ? (
        <div className="question-readonly-row">
          <span className="question-detail-label">回答</span>
          <div className="question-readonly-answer">
            {isSkippedQuestionAnswer(answer) ? '已跳过' : readonlyQuestionAnswer(f, answerFor(f))}
          </div>
        </div>
      ) : (
        <div className="question-answer-row">
          {f.type === 'text' ? (
            <textarea
              className="approval-answer"
              placeholder={f.secret ? '输入内容（将被隐藏）…' : '输入你的回答…'}
              value={get(f.id).text}
              onChange={(e) => update(f.id, { text: e.target.value })}
              rows={2}
              // secret fields mask input via password-style rendering
              style={f.secret ? ({ WebkitTextSecurity: 'disc' } as any) : undefined}
            />
          ) : (
            <div className="question-options">
              {f.options.map((o) => {
                const state = get(f.id)
                const checked = state.choice.includes(o.value)
                return (
                  <label key={o.value} className={`question-opt ${checked ? 'checked' : ''}`}>
                    <input
                      type={f.type === 'multi' ? 'checkbox' : 'radio'}
                      name={`${formId}:${f.id}`}
                      checked={checked}
                      onChange={() => toggleChoice(f, o.value)}
                    />
                    <span className="question-opt-body">
                      <span className="question-opt-label">{o.label}</span>
                      {optionDescription(o) && <span className="question-opt-desc">{optionDescription(o)}</span>}
                    </span>
                  </label>
                )
              })}
              {f.allowOther && (
                <label
                  className={`question-opt ${get(f.id).choice.includes(OTHER_VALUE) ? 'checked' : ''}`}
                >
                  <input
                    type={f.type === 'multi' ? 'checkbox' : 'radio'}
                    name={`${formId}:${f.id}`}
                    checked={get(f.id).choice.includes(OTHER_VALUE)}
                    onChange={() => toggleChoice(f, OTHER_VALUE)}
                  />
                  <span className="question-opt-body">
                    <span className="question-opt-label">其他</span>
                    <input
                      className="question-other-input"
                      placeholder="自定义回答…"
                      value={get(f.id).other}
                      onChange={(e) => {
                        // Typing in the free-text box also selects the "其他" choice,
                        // so it works whether or not onFocus fired first (e.g. under CDP).
                        const text = e.target.value
                        const state = get(f.id)
                        if (text && !state.choice.includes(OTHER_VALUE)) {
                          const nextChoice =
                            f.type === 'single' ? [OTHER_VALUE] : [...state.choice, OTHER_VALUE]
                          update(f.id, { other: text, choice: nextChoice })
                        } else {
                          update(f.id, { other: text })
                        }
                      }}
                      onFocus={() => {
                        if (!get(f.id).choice.includes(OTHER_VALUE)) toggleChoice(f, OTHER_VALUE)
                      }}
                    />
                  </span>
                </label>
              )}
              {f.type === 'multi' && (f.minItems || f.maxItems) && (
                <div className="question-hint">
                  {f.minItems ? `至少选 ${f.minItems} 项` : ''}
                  {f.minItems && f.maxItems ? '，' : ''}
                  {f.maxItems ? `最多选 ${f.maxItems} 项` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div
      className={`question-form${paged ? ' paged' : ''}${readOnly ? ' readonly' : ''}`}
    >
      {paged && (
        <div className="question-pager">
          {/* per-question dots let you jump straight to any question, codex-style */}
          <div className="question-pager-dots">
            {fields.map((f, i) => (
              <button
                key={f.id}
                className={`qpager-dot ${i === clampedPage ? 'active' : ''} ${
                  (readOnly ? answerFor(f).length > 0 : fieldSatisfied(f))
                    ? 'answered'
                    : ''
                }`}
                onClick={() => setPage(i)}
                title={f.title || f.prompt || `第 ${i + 1} 问`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <div className="question-pager-label">
            第 {clampedPage + 1} / {fields.length} 问
          </div>
        </div>
      )}
      {visibleFields.map(renderField)}
      {!readOnly && hint}
      {!readOnly && (
        <div className="approval-actions">
          {paged && clampedPage > 0 && (
            <button
              className="appr-btn appr-cancel"
              onClick={() => setPage(clampedPage - 1)}
            >
              上一题
            </button>
          )}
          {onSkip && <button type="button" className="appr-btn appr-cancel question-skip" onClick={onSkip}>
            跳过
          </button>}
          {paged && !onLastPage ? (
            <button
              className="btn-send"
              disabled={!currentSatisfied}
              onClick={() => setPage(clampedPage + 1)}
            >
              下一题
            </button>
          ) : (
            <button
              className="btn-send"
              disabled={!canSubmit}
              onClick={() => onSubmit?.(encodeAnswer(answerKind, fields, collected))}
            >
              提交回答
            </button>
          )}
          {onCancel && (
            <button className="appr-btn appr-cancel" onClick={onCancel}>
              取消
            </button>
          )}
        </div>
      )}
    </div>
  )
}
