import { agentInitializationPrompt } from '@shared/agentInitialization'
import { APP_NAME } from '@shared/distribution'
import { pendingAgentDetection } from '@shared/agentReadiness'
export { agentInitializationPrompt } from '@shared/agentInitialization'
import { parseAssistantCommand } from '@shared/assistant'
import './components/requirements.css'
import { useRequirements } from './useRequirements'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { enterStartup, updateStartup } from './startup'
import type {
  AgentDef,
  AgentLifecycleProgress,
  Attachment,
  BubbleComment,
  HistoryForkPoint,
  NativeSessionOccupancy,
  PermissionMode,
  QueueItem,
  ReasoningEffort,
  ReviewChangeSet,
  ReviewScope,
  RewindPreview,
  Session,
  SessionConfig,
  TurnBubbleInput,
  UAEvent,
  UASubAgent
} from '@shared/types'
import type {
  CollaborationModeId,
  NativeCapabilitySnapshot,
  NativeThreadAction,
  NativeTurnSelectionRequest,
  ResolvedNativeTurnContext
} from '@shared/nativeCapabilities'
import {
  agentForSession,
  DEFAULT_ENABLED_AGENT_IDS,
  isCrossForkSourceAgent,
  isCrossForkTargetAgent,
  isToolSession,
  sessionDedupKey
} from '@shared/types'
import { NewTaskPanel } from './components/NewTaskPanel'
import { SessionConversation } from './components/SessionConversation'
import { WorktreeCreation } from './components/WorktreeCreation'
import { MemberSession } from './components/TeamWorkspace'
import { TeamSessionProvider, TeamSummary } from './components/TeamSessionExtras'
import { teamSessionEvents } from './teamTimeline'
import type { TeamCatalog, TeamCreateProjectInput } from '@shared/teamTypes'
import { teamRowSessionId, teamRowSessionIds } from '@shared/teamAttention'
import { teamSessionRows } from './teamSessions'
import { SessionList, type ReplyUnreadKind } from './components/SessionList'
import { subAgentsFromEvents, TurnStatusBar, type HandoffSessionTarget } from './components/EventStream'
import { isSessionBusy, sessionActivityStatus } from '@shared/sessionStatus'
import { interactionRequestKey, isAsyncQuestion, isPendingInteraction } from '@shared/interactionRequests'
import { Composer, type ComposerDraftSeed } from './components/Composer'
import { GoalStatusBar } from './components/GoalStatusBar'
import {
  currentSessionForkTargets,
  HistoryConfirmation,
  ResumePanel,
  type HistoryAction
} from './components/ResumePanel'
import { AutomationsPanel } from './components/AutomationsPanel'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { DEFAULT_SIDEBAR_SHORTCUTS, isSettingsPagePanel, SETTINGS_CATEGORIES, type SettingsCategory } from '@shared/settingsNavigation'
import { CapabilitySyncPanel } from './components/CapabilitySyncPanel'
import { AgentCapabilitiesPanel } from './components/AgentCapabilitiesPanel'
import type { CapabilityInventorySyncRequest } from '@shared/capabilitySync'
import { SubAgentPanel } from './components/SubAgentPanel'
import { SideChatPanel } from './components/SideChatPanel'
import { CommentPanel } from './components/CommentPanel'
import { COMMENT_ANNOTATION_PREFIX, useComments } from './comments'
import type { CommentThread } from '@shared/comments'
import { QuotaHoverButton } from './components/QuotaHoverButton'
import type { Annotation } from './textAnnotations'
import { AgentIcon } from './components/AgentIcon'
import { FolderIcon, SidebarIcon, UiIcon } from './components/Icons'
import { displayedContextWindow } from './contextWindow'
import { contextCompactionAvailability, supportsManualContextCompaction } from './contextCompaction'
import { ReviewPanel } from './components/ReviewPanel'
import { ModelPicker } from './components/ModelPicker'
import { FileBrowser } from './components/FileBrowser'
import { ImmersiveReader } from './components/ImmersiveReader'
import { TokenUsagePanel } from './components/TokenUsagePanel'
import { rollbackOptimisticSessionStatus, useNativeCapabilities, useSessionAttention } from './hooks'
import { mergeZCodeEvent, mergeZCodeSnapshot } from './zcodeEvents'
import { usageSnapshotKey, withCompactionTiming } from '@shared/eventSnapshots'
import type { ZCodeEventCursor, ZCodeEventsSnapshot } from '@shared/zcode'

const MERGEABLE_EVENT_TYPES = new Set<UAEvent['type']>([
  'command_exec',
  'file_change',
  'tool_call',
  'hook',
  'background_task',
  'agent_message',
  'reasoning',
  'diff_update',
  'context_compaction',
  'model_switch',
  'approval_request',
  'queue_status',
  'plan_update',
  'subagent'
])

function optimisticNativeContext(
  selection: NativeTurnSelectionRequest | undefined,
  snapshot: NativeCapabilitySnapshot
): ResolvedNativeTurnContext | undefined {
  if (!selection?.candidateIds.length) return undefined
  const candidatesById = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]))
  const context: ResolvedNativeTurnContext = { skills: [], mcpServers: [] }
  for (const candidateId of selection.candidateIds) {
    const candidate = candidatesById.get(candidateId)
    if (!candidate) continue
    if (candidate.kind === 'skill') {
      context.skills.push({ name: candidate.name, path: candidate.path })
    } else if (candidate.kind === 'mcp') {
      context.mcpServers.push({ name: candidate.name })
    }
  }
  return context.skills.length || context.mcpServers.length ? context : undefined
}

export function mergeSessionEvent(events: UAEvent[], event: UAEvent, inPlace = false): UAEvent[] {
  const usageKey = usageSnapshotKey(event)
  if (usageKey !== undefined) {
    const index = events.findLastIndex(item => usageSnapshotKey(item) === usageKey)
    if (index >= 0) {
      const next = inPlace ? events : [...events]
      next[index] = event
      return next
    }
  }
  if (event.type === 'user_message' || event.type === 'goal_message') {
    if (
      event.type === 'goal_message' &&
      event.payload?.optimistic === true &&
      events.some((item) =>
        item.type === 'goal_message' &&
        item.payload?.optimistic !== true &&
        item.payload?.text === event.payload?.text &&
        item.ts >= event.ts
      )
    ) return events
    const index = events.findLastIndex(
      (item) =>
        item.type === event.type &&
        item.payload?.optimistic === true &&
        item.payload?.text === event.payload?.text
    )
    if (index >= 0) {
      const next = inPlace ? events : [...events]
      const prior = next[index].payload || {}
      const clientTurnKey = prior.clientTurnKey
      // 选中即评论 — the optimistic bubble carries the comment cards + instruction
      // text; the backend user_message may not echo them, so preserve them the
      // same way clientTurnKey is preserved when swapping optimistic→real.
      const preserved = {
        ...(clientTurnKey === undefined ? {} : { clientTurnKey }),
        ...(event.payload?.comments === undefined && prior.comments !== undefined
          ? { comments: prior.comments }
          : {}),
        ...(event.payload?.displayText === undefined && prior.displayText !== undefined
          ? { displayText: prior.displayText }
          : {})
      }
      next[index] = Object.keys(preserved).length === 0
        ? event
        : { ...event, payload: { ...event.payload, ...preserved } }
      return next
    }
    if (event.type === 'goal_message') {
      const insertionIndex = events.findIndex((item) => item.seq > event.seq)
      if (insertionIndex >= 0) {
        const next = inPlace ? events : [...events]
        next.splice(insertionIndex, 0, event)
        return next
      }
    }
  }
  const key = event.payload?.id ?? event.payload?.requestId
  if (key && MERGEABLE_EVENT_TYPES.has(event.type)) {
    // In-flight items share a native turn; queue totals also retain each visual segment.
    const turnStart = events.findLastIndex(
      (item) => item.type === 'turn_completed' || event.type === 'queue_status' &&
        (item.type === 'user_message' || item.type === 'goal_message')
    )
    const index = events.findLastIndex(
      (item, itemIndex) =>
        (itemIndex > turnStart || isAsyncQuestion(event) ||
          (event.type === 'approval_request' && (item.seq === event.seq ||
            event.state !== 'pending' && item.state === 'pending'))) &&
        item.type === event.type &&
        (item.payload?.id ?? item.payload?.requestId) === key
    )
    if (index >= 0) {
      const next = inPlace ? events : [...events]
      // Keep a streamed reply at its first position when embedded task cards arrive.
      if (event.type === 'agent_message') event = { ...event, ts: Math.min(next[index].ts, event.ts) }
      if (event.type === 'approval_request') {
        next[index] = {
          ...event,
          seq: next[index].seq,
          ts: next[index].ts,
          payload: { ...next[index].payload, ...event.payload }
        }
        return next
      }
      if (event.type === 'agent_message') {
        next[index] = {
          ...event,
          ...(isAsyncQuestion(next[index]) ? { seq: next[index].seq } : {}),
          payload: { ...next[index].payload, ...event.payload },
        }
        return next
      }
      const submittedAnswer = next[index].payload?.submittedAnswer
      event = withCompactionTiming(event, next[index])
      next[index] = submittedAnswer === undefined
        ? event
        : { ...event, payload: { ...event.payload, submittedAnswer } }
      return next
    }
  }
  if (inPlace) { events.push(event); return events }
  return [...events, event]
}

export function mergeHydratedSessionEvents(snapshot: UAEvent[], live: UAEvent[]): UAEvent[] {
  const liveBySeq = new Map(live.map((event) => [event.seq, event]))
  return [...snapshot.filter((event) => !liveBySeq.has(event.seq)), ...live]
    .sort((a, b) => a.seq - b.seq)
    .reduce((events, event) => mergeSessionEvent(events, event, true), [] as UAEvent[])
}

export function unreadAfterReplyStatus(
  current: ReplyUnreadKind | undefined,
  previousStatus: string | undefined,
  status: string,
  source: ReplyUnreadKind,
  shouldMark = true,
  session?: Session
): ReplyUnreadKind | undefined {
  if (isToolSession(session)) return undefined
  if (previousStatus === status) return current
  const wasBusy = isSessionBusy(previousStatus)
  // The Dock badge also treats failures and interruptions as attention. Mark the
  // same terminal states here so every badged session has a visible unread row.
  const attention = status === 'error' ||
    wasBusy && (status === 'idle' || status === 'completed' || status === 'cancelled' || status === 'interrupted')
  return shouldMark && attention ? source : current
}

const SIDEBAR_UNREAD_KEY = 'ua.sidebarUnread'
const SIDEBAR_PENDING_KEY = 'ua.sidebarPendingInteractions'
const PENDING_STATUS_KEY = 'status:awaiting-approval'
type PendingInteractionIds = Record<string, string[]>

function loadSidebarUnread(): Partial<Record<string, ReplyUnreadKind>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SIDEBAR_UNREAD_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([id, kind]) => id && (kind === 'main' || kind === 'side')))
  } catch { return {} }
}

function loadSidebarPending(): PendingInteractionIds {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SIDEBAR_PENDING_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([id, keys]) => {
      if (!id || !Array.isArray(keys)) return []
      const valid = [...new Set(keys.filter((key): key is string => typeof key === 'string' &&
        (key === PENDING_STATUS_KEY || key.startsWith('request:') && key.length > 'request:'.length)))]
      return valid.length ? [[id, valid]] : []
    }))
  } catch { return {} }
}

function reconcileSidebarPending(
  previous: PendingInteractionIds,
  eventsBySession: Record<string, UAEvent[]>,
  hydrated: Record<string, boolean>,
  statuses: Record<string, Session['status']>
): PendingInteractionIds {
  let next = previous
  for (const [sessionId, events] of Object.entries(eventsBySession)) {
    const old = previous[sessionId] || []
    const keys = new Set(hydrated[sessionId] ? [] : old)
    for (const event of events) {
      const requestId = interactionRequestKey(event)
      if (!requestId) continue
      const key = `request:${requestId}`
      if (isPendingInteraction(event)) keys.add(key)
      else keys.delete(key)
    }
    if (hydrated[sessionId] && statuses[sessionId] === 'awaiting-approval') keys.add(PENDING_STATUS_KEY)
    const updated = [...keys]
    if (updated.length === old.length && updated.every((key, index) => key === old[index])) continue
    if (next === previous) next = { ...previous }
    if (updated.length) next[sessionId] = updated
    else delete next[sessionId]
  }
  return next
}

function saveSidebarState(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage may be unavailable */ }
}

// 选中即评论 — 待发送评论按会话缓存到 localStorage（沿用 `ua.*` 命名），切换会话 /
// 重启 App 后回填托盘与正文高亮。每个 sessionId 一个键，空数组即删除键。
const PENDING_COMMENTS_PREFIX = 'ua.pendingComments.'

function loadPendingComments(): Record<string, Annotation[]> {
  const out: Record<string, Annotation[]> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(PENDING_COMMENTS_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        out[key.slice(PENDING_COMMENTS_PREFIX.length)] = parsed as Annotation[]
      }
    }
  } catch {
    // Corrupt / unavailable storage just yields no restored drafts.
  }
  return out
}

function savePendingComments(sessionId: string, annotations: Annotation[]): void {
  const key = PENDING_COMMENTS_PREFIX + sessionId
  try {
    if (annotations.length) localStorage.setItem(key, JSON.stringify(annotations))
    else localStorage.removeItem(key)
  } catch {
    // Ignore quota / availability failures — the in-memory store still works.
  }
}

export function App(): JSX.Element {
  const comments = useComments()
  const [commentNotice, setCommentNotice] = useState('')
  const [startupVisible, setStartupVisible] = useState(true)
  const [startupReady, setStartupReady] = useState(false)
  const [startupError, setStartupError] = useState('')
  useEffect(() => {
    let cancelled = false
    void window.uniagent.startupState().then((state) => {
      if (!cancelled) { setStartupReady(state.ready); setStartupError(state.error || '') }
    }).catch(() => { if (!cancelled) setStartupError('初始化未完成，请重新启动 UniAgent。') })
    return () => { cancelled = true }
  }, [])
  const [teamCatalog, setTeamCatalog] = useState<TeamCatalog>({ teams: [], projects: [], errors: [] })
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general')
  const [settingsNavigationKey, setSettingsNavigationKey] = useState(0)
  const [sidebarShortcuts, setSidebarShortcuts] = useState<readonly SettingsCategory[]>(DEFAULT_SIDEBAR_SHORTCUTS)
  const [requirementsEnabled, setRequirementsEnabled] = useState(false)
  const settingsNavigationGuard = useRef<(() => boolean) | null>(null)
  const [settingsTeamId, setSettingsTeamId] = useState<string>()
  const [teamError, setTeamError] = useState('')
  const [teamsLoading, setTeamsLoading] = useState(true)
  const teamVersion = useRef(0)
  const refreshTeams = () => { const version = ++teamVersion.current; void window.uniagent.teamCatalog().then(c => { if (version === teamVersion.current) { setTeamCatalog(c); setTeamError('') } }).catch(e => { if (version === teamVersion.current) setTeamError(String(e)) }).finally(() => { if (version === teamVersion.current) setTeamsLoading(false) }) }
  useEffect(() => { refreshTeams(); const off = window.uniagent.onTeamChanged(refreshTeams); return () => { teamVersion.current++; off() } }, [])
  const [agents, setAgents] = useState<AgentDef[]>([])
  useEffect(() => { if (agents.length) refreshTeams() }, [agents])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsRedetecting, setAgentsRedetecting] = useState(false)
  const [enabledAgentIds, setEnabledAgentIds] = useState<string[]>(() => [...DEFAULT_ENABLED_AGENT_IDS])
  useEffect(() => window.uniagent.onUniAgentManagementChanged(resource => {
    if (!['settings','agents'].includes(resource)) return
    void window.uniagent.getAppSettings().then(settings => { setEnabledAgentIds(settings.enabledAgentIds ?? [...DEFAULT_ENABLED_AGENT_IDS]); setSidebarShortcuts(settings.sidebarShortcuts ?? DEFAULT_SIDEBAR_SHORTCUTS); setRequirementsEnabled(settings.requirementsEnabled === true) }).catch(() => {})
    if (resource === 'agents') void window.uniagent.getLifecycleSnapshot().then(setAgents).catch(() => {})
  }), [])
  const [agentChoiceSettingsLoading, setAgentChoiceSettingsLoading] = useState(true)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsLoadError, setSessionsLoadError] = useState<string | null>(null)
  const blockingError = startupError || sessionsLoadError
  const startupBlocking = !startupReady || agentsLoading || agentChoiceSettingsLoading || sessionsLoading || teamsLoading || !!blockingError
  useEffect(() => {
    if (!startupBlocking) return
    const block = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' && !(event.target instanceof Element && event.target.closest('#ua-startup-restart'))) event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', block, true)
    return () => window.removeEventListener('keydown', block, true)
  }, [startupBlocking])
  useEffect(() => {
    if (!startupVisible || !startupBlocking || blockingError) return
    updateStartup(sessionsLoading ? '正在加载会话…'
      : agentsLoading || !startupReady ? '正在初始化 Agent…' : teamsLoading ? '正在恢复团队…' : '正在加载配置…')
  }, [startupVisible, startupBlocking, blockingError, sessionsLoading, agentsLoading, teamsLoading, startupReady])
  useEffect(() => {
    if (!startupVisible) return
    if (blockingError) { updateStartup('', true); return }
    if (!startupBlocking) return enterStartup(() => setStartupVisible(false))
  }, [startupVisible, startupBlocking, blockingError])
  const [sessions, setSessions] = useState<Session[]>([])
  const [assistantPrivateSessionIds, setAssistantPrivateSessionIds] = useState<string[]>([])
  useEffect(() => {
    let mounted = true, revision = 0
    const refresh = (): void => {
      const current = ++revision
      void window.uniagent.getAssistantPrivateSessions().then(ids => {
        if (mounted && current === revision) setAssistantPrivateSessionIds(previous =>
          previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids)
      }).catch(error => console.warn('[assistant] private session bindings:', error))
    }
    const offBindings = window.uniagent.onAssistantPrivateSessionsChanged(refresh)
    const offSettings = window.uniagent.onAssistantFeishuChanged(refresh)
    refresh()
    return () => { mounted = false; offBindings(); offSettings() }
  }, [])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sessionReturnId, setSessionReturnId] = useState<string | null>(null)
  const [eventView, setEventView] = useState<{ events: Record<string, UAEvent[]>; zcodeCursors: Record<string, ZCodeEventCursor> }>({ events: {}, zcodeCursors: {} })
  const eventsBySession = eventView.events
  function setEventsBySession(update: Record<string, UAEvent[]> | ((previous: Record<string, UAEvent[]>) => Record<string, UAEvent[]>)): void {
    setEventView(previous => ({ ...previous, events: typeof update === 'function' ? update(previous.events) : update }))
  }
  const eventsBySessionRef = useRef(eventsBySession)
  const archivedEventCaches = useRef(new Set<string>())
  eventsBySessionRef.current = eventsBySession
  function applyZCodeSnapshot(snapshot: ZCodeEventsSnapshot): void {
    setEventView(prev => {
      const prior = prev.zcodeCursors[snapshot.sessionId]
      const live = prev.events[snapshot.sessionId] || []
      const events = mergeZCodeSnapshot(snapshot, live, prior)
      if (events === live) return prev
      return { events: { ...prev.events, [snapshot.sessionId]: events }, zcodeCursors: { ...prev.zcodeCursors,
        [snapshot.sessionId]: { generation: snapshot.generation, upToEventSeq: snapshot.upToEventSeq } } }
    })
  }
  const [statusBySession, setStatusBySession] = useState<Record<string, Session['status']>>({})
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueItem[]>>({})
  // Process-local event coordinates must never survive SessionStore/restart.
  const [correctionSeqBySession, setCorrectionSeqBySession] = useState<Record<string, number>>({})
  // A restored session has no live app-server runner until this process sends a
  // turn. Keep this process-local capability separate from persisted status.
  const [liveStreamerBySession, setLiveStreamerBySession] = useState<Record<string, boolean>>({})
  const [modelPreparingBySession, setModelPreparingBySession] = useState<Record<string, boolean>>({})
  const [nativeOccupancyBySession, setNativeOccupancyBySession] = useState<Record<string, NativeSessionOccupancy>>({})
  const [refreshingNativeSessionId, setRefreshingNativeSessionId] = useState<string | null>(null)
  const nativeRefreshesRef = useRef(new Set<string>())
  const syncedNativeVersionsRef = useRef<Record<string, string>>({})
  const [unreadBySession, setUnreadBySession] = useState<Partial<Record<string, ReplyUnreadKind>>>(loadSidebarUnread)
  const [savedPendingInteractions, setSavedPendingInteractions] = useState<PendingInteractionIds>(loadSidebarPending)
  const [hydratedSessions, setHydratedSessions] = useState<Record<string, boolean>>({})
  const hydratedSessionsRef = useRef(new Set<string>())
  useEffect(() => { saveSidebarState(SIDEBAR_UNREAD_KEY, unreadBySession) }, [unreadBySession])
  useEffect(() => { saveSidebarState(SIDEBAR_PENDING_KEY, savedPendingInteractions) }, [savedPendingInteractions])
  // 需求12/13: history & scheduled tasks are sidebar nav entries whose content
  // renders in the MAIN chat area (codex-style), not a floating drawer.
  // 'settings' = 设置页内展示（带分类导航）；'settings-window' = 全窗展示（左侧侧栏快捷入口打开，无分类导航）。
  const [panel, setPanel] = useState<null | 'history' | 'automations' | 'diagnostics' | 'settings' | 'settings-window' | 'capabilities' | 'capability-sync' | 'tokens'>(
    null
  )
  const [capabilitySyncRequest, setCapabilitySyncRequest] = useState<CapabilityInventorySyncRequest | null>(null)
  // Doc5 — which sub-agent's detail panel is open (child thread id), if any.
  const [openSubAgent, setOpenSubAgent] = useState<string | null>(null)
  // 修复#4 — which page the panel boots to when it opens: an inline lifecycle
  // row jumps straight to that child's 详情 (detail); the summary card's 子智能体
  // entry opens the LIST instead (browse, then pick). Only read on mount.
  const [subPanelView, setSubPanelView] = useState<'list' | 'detail'>('detail')
  // 需求2（侧边对话 /side）— whether the ephemeral side-chat drawer is open. Mutually
  // exclusive with the sub-agent drawer (both anchor to the right edge).
  const [sideChatOpen, setSideChatOpen] = useState<boolean>(false)
  // 记住每个 session 的侧边聊天开合：离开时状态被持续记录，再次进入该 session 时恢复
  // （打开过就默认保持打开，关着离开就保持关闭）。
  const sideOpenBySessionRef = useRef<Record<string, boolean>>({})
  // 计时胶囊重构 — the summary card is opened by HOVERING the persistent timer
  // capsule (popover above the capsule) and can be pinned to a right-hand dock.
  // Pinned state + dock width persist across launches; hover/dismiss are transient.
  const [summaryPinned, setSummaryPinned] = useState<boolean>(
    () => localStorage.getItem('ua.summaryPinned') === '1'
  )
  const [summaryWidth, setSummaryWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('ua.summaryWidth'))
    return Number.isFinite(saved) && saved > 0 ? Math.min(480, Math.max(300, saved)) : 300
  })
  const [summaryHover, setSummaryHover] = useState(false)
  const [summaryDismissed, setSummaryDismissed] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  // The review overlay's source: live workspace slices, a branch/commit range,
  // or the frozen artifact for one historical turn.
  const [reviewScope, setReviewScope] = useState<ReviewScope>({ kind: 'workspace' })
  const [reviewTurnDiff, setReviewTurnDiff] = useState('')
  const [reviewInitialFile, setReviewInitialFile] = useState<string | undefined>(undefined)
  const [filesOpen, setFilesOpen] = useState(false)
  const [readerEventSeq, setReaderEventSeq] = useState<number | null>(null)
  // 需求补9 — when a workspace overlay (review / file browser) is open, this flag
  // hides the left session sidebar so the overlay fills the whole window. Seeded
  // from the persisted `coverSidebar` AppSetting, but toggleable per-open via the
  // header expand/collapse button without rewriting the default.
  const [overlayCover, setOverlayCover] = useState(false)
  // 需求五 — when the user clicks a path in a reply, FileBrowser opens focused on it.
  const [fileFocus, setFileFocus] = useState<{ path: string; line?: number; root?: string } | null>(null)
  const [reviewChangeSet, setReviewChangeSet] = useState<ReviewChangeSet | null>(null)
  // 需求三（会话节点回退）— the rewind flow: preview loading → confirm → executing.
  // Kept as one discriminated state so the UI can never show confirm + loading at
  // once, and a failure simply drops back to null while leaving the timeline intact.
  const [rewind, setRewind] = useState<
    | null
    | { phase: 'preview'; sessionId: string; beforeTurnId: string; userEventSeq: number }
    | { phase: 'confirm'; sessionId: string; beforeTurnId: string; userEventSeq: number; preview: RewindPreview }
    | { phase: 'executing'; sessionId: string; beforeTurnId: string; userEventSeq: number }
    | { phase: 'error'; sessionId: string; message: string }
  >(null)
  const [rewindWarning, setRewindWarning] = useState<string | null>(null)
  // 需求三 — target turn's user text, pushed into the Composer after a successful
  // rewind (nonce forces a refill even if the text repeats). Never auto-sent.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number }>({
    text: '',
    nonce: 0
  })
  // 选中即评论 — per-session annotation store. Single source of truth for both the
  // in-body highlights (grouped by seq) AND the composer's 待评论托盘 (all of them).
  // Persisted per session in localStorage so it survives 会话切换 + App 重启.
  const [annotationsBySession, setAnnotationsBySession] = useState<Record<string, Annotation[]>>(
    () => loadPendingComments()
  )
  const [annotationEditRequest, setAnnotationEditRequest] = useState<{
    sessionId: string
    annotation: Annotation
    nonce: number
  } | null>(null)
  // 选中即评论 →「解释」— each selection owns a fresh floating explanation.
  const [detailPopover, setDetailPopover] = useState<{
    sessionId: string
    quote: string
    selectedMessageText: string
    nonce: number
  } | null>(null)
  useEffect(() => {
    if (detailPopover && detailPopover.sessionId !== activeId) {
      void window.uniagent.closeDetail(detailPopover.sessionId)
      setDetailPopover(null)
    }
  }, [activeId, detailPopover])
  const [e2eFixtures, setE2EFixtures] = useState(false)
  const [newTaskPrefill, setNewTaskPrefill] = useState<{ text: string } | null>(null)
  const [quickCreateSeed, setQuickCreateSeed] = useState<
    (Partial<Pick<SessionConfig, 'agentId' | 'projectId' | 'requirementId'>> & { teamId?: string }) | null
  >(null)
  const [newTaskKey, setNewTaskKey] = useState(0)
  const [composerDraftSeed, setComposerDraftSeed] = useState<ComposerDraftSeed | null>(null)
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0)
  const [startupProgress, setStartupProgress] = useState<AgentLifecycleProgress | null>(null)
  // Every pull of the lifecycle snapshot shares one generation. A delayed
  // core-only startup response must never overwrite a newer snapshot that
  // already contains the asynchronously merged agent rows.
  const agentSnapshotGenerationRef = useRef(0)
  // Both fork modes share loading, cancellation and commit ownership.
  const [forkBusy, setForkBusy] = useState<string | null>(null)
  const [forkError, setForkError] = useState('')
  const forkOperationRef = useRef<{ nextToken: number; activeToken: number | null }>({
    nextToken: 0, activeToken: null
  })
  const [activeHistoryForkPoints, setActiveHistoryForkPoints] = useState<HistoryForkPoint[]>([])
  const [historyForkConfirmation, setHistoryForkConfirmation] = useState<HistoryAction | null>(null)
  const [latestSessionFork, setLatestSessionFork] = useState<{ sessionId: string; action: HistoryAction } | null>(null)
  // 需求15: sidebar is resizable (drag the right edge) and collapsible.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('ua.sidebarWidth'))
    return v >= 200 && v <= 520 ? v : 260
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('ua.sidebarCollapsed') === '1'
  )
  // Kept in sync with activeId so the (once-installed) event listener can tell
  // whether an incoming turn belongs to the session the user is currently viewing.
  const activeIdRef = useRef<string | null>(null)
  // 团队成员的未读归属于侧栏的团队行（Leader session）；事件监听器只安装一次，
  // 所以通过 ref 读取最新的归属表与当前展示行。
  const teamRowIdsRef = useRef<Map<string, string>>(new Map())
  const displayedRowIdRef = useRef<string | null>(null)
  const sideStatusBySessionRef = useRef<Record<string, string>>({})
  useEffect(() => {
    activeIdRef.current = activeId
    setRewind(null)
    setReaderEventSeq(null)
    setActiveHistoryForkPoints([])
    setHistoryForkConfirmation(null)
    setLatestSessionFork(null)
  }, [activeId])
  // 记住当前 session 的侧边开合：每次 sideChatOpen 变化时写回当前 session（此时
  // activeIdRef 已同步为新值），供 handleSelect 再次进入时恢复。
  useEffect(() => {
    const id = activeIdRef.current
    if (id) sideOpenBySessionRef.current[id] = sideChatOpen
  }, [sideChatOpen])
  // Mirror `panel` into a ref so the once-installed diagnostic listener can tell
  // whether the user is currently viewing the diagnostics panel.
  const panelRef = useRef<typeof panel>(null)
  useEffect(() => {
    panelRef.current = panel
  }, [panel])
  useEffect(() => {
    const timer = setInterval(() => { void redetectAgents({ silent: true }) }, 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])
  // 异常（待登录/不健康）时快轮询：外部登录或修复完成后 UI 自动追平，全部恢复即停。
  const hasAgentAnomaly = agents.some((a) =>
    a.lifecycle?.availability === 'needs-auth' || a.lifecycle?.availability === 'unhealthy'
  )
  useEffect(() => {
    if (!hasAgentAnomaly) return
    const timer = setInterval(() => { void redetectAgents({ silent: true }) }, 30 * 1000)
    return () => clearInterval(timer)
  }, [hasAgentAnomaly])
  // Load agents + subscribe to pushes once.
  useEffect(() => {
    let cancelled = false
    const initialAgentGeneration = ++agentSnapshotGenerationRef.current
    void window.uniagent.getLifecycleSnapshot()
      .then((detected) => {
        if (!cancelled && agentSnapshotGenerationRef.current === initialAgentGeneration) {
          setAgents(detected)
        }
      })
      .catch(() => {
        if (!cancelled && agentSnapshotGenerationRef.current === initialAgentGeneration) {
          setStartupProgress({ agentId: '*', phase: 'failed', message: 'Agent 初始化失败，可在设置中重新检测' })
        }
      })
      .finally(() => {
        if (!cancelled && agentSnapshotGenerationRef.current === initialAgentGeneration) {
          setAgentsLoading(false)
        }
      })
    void window.uniagent.getAppSettings()
      .then((settings) => {
        if (!cancelled) {
          setEnabledAgentIds(settings.enabledAgentIds ?? [...DEFAULT_ENABLED_AGENT_IDS])
          setSidebarShortcuts(settings.sidebarShortcuts ?? DEFAULT_SIDEBAR_SHORTCUTS)
          setRequirementsEnabled(settings.requirementsEnabled === true)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setAgentChoiceSettingsLoading(false)
      })
    window.uniagent.listSessions()
      .then((next) => {
        if (!cancelled) {
          setSessions(next)
          setSessionsLoadError(null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionsLoadError('会话数据加载失败。为保护已保存的会话，当前不能新建任务；请重新启动 UniAgent 后再试。')
        }
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false)
      })

    let eventBatch: UAEvent[] = []
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    const flushEvents = (): void => {
      if (eventTimer) clearTimeout(eventTimer)
      eventTimer = undefined
      if (!eventBatch.length) return
      const batch = eventBatch
      eventBatch = []
      setEventView((prev) => {
        const next = { ...prev.events }
        const copied = new Set<string>()
        for (const event of batch) {
          if (archivedEventCaches.current.has(event.sessionId)) continue
          if (!copied.has(event.sessionId)) { next[event.sessionId] = [...(next[event.sessionId] || [])]; copied.add(event.sessionId) }
          next[event.sessionId] = event.payload.zcodeProjection || prev.zcodeCursors[event.sessionId]
            ? mergeZCodeEvent(next[event.sessionId], event, prev.zcodeCursors[event.sessionId])
            : mergeSessionEvent(next[event.sessionId], event, true)
        }
        return { ...prev, events: next }
      })
    }
    const offEvent = window.uniagent.onEvent((ev) => {
      if (archivedEventCaches.current.has(ev.sessionId)) return
      eventBatch.push(ev)
      if (ev.state !== 'running') flushEvents()
      else if (!eventTimer) eventTimer = setTimeout(flushEvents, 50)
    })
    const offZCodeReset = window.uniagent.onZCodeEventsReset((snapshot) => {
      flushEvents()
      applyZCodeSnapshot(snapshot)
    })
    // Main authorizes this only when Electron was launched with --ua-e2e. Page
    // content cannot enable the fixture surface itself.
    window.uniagent.e2eEnabled().then(setE2EFixtures)

    const offStatus = window.uniagent.onStatusChange(({ sessionId, status, updatedAt }) => {
      flushEvents()
      setSavedPendingInteractions((previous) => {
        const old = previous[sessionId] || []
        const keys = new Set(old)
        if (status === 'awaiting-approval') keys.add(PENDING_STATUS_KEY)
        else keys.delete(PENDING_STATUS_KEY)
        const updated = [...keys]
        if (updated.length === old.length && updated.every((key, index) => key === old[index])) return previous
        const next = { ...previous }
        if (updated.length) next[sessionId] = updated
        else delete next[sessionId]
        return next
      })
      setStatusBySession((prev) => {
        const was = prev[sessionId]
        const rowId = teamRowSessionId(teamRowIdsRef.current, sessionId)
        setUnreadBySession((unread) => {
          const next = unreadAfterReplyStatus(unread[rowId], was, status, 'main', displayedRowIdRef.current !== rowId, sessionsRef.current.find((session) => session.id === sessionId))
          return next === unread[rowId] ? unread : { ...unread, [rowId]: next }
        })
        return { ...prev, [sessionId]: status }
      })
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId
          ? { ...s, status: status as Session['status'], updatedAt: updatedAt ?? Date.now() }
          : s))
      )
    })
    const offSideStatus = window.uniagent.onSideStatus(({ sessionId, status }) => {
      const previous = sideStatusBySessionRef.current[sessionId]
      sideStatusBySessionRef.current[sessionId] = status
      const rowId = teamRowSessionId(teamRowIdsRef.current, sessionId)
      setUnreadBySession((unread) => {
        const next = unreadAfterReplyStatus(unread[rowId], previous, status, 'side', true, sessionsRef.current.find((session) => session.id === sessionId))
        return next === unread[rowId] ? unread : { ...unread, [rowId]: next }
      })
    })
    const offQueue = window.uniagent.onQueueChange(({ sessionId, queue }) => {
      setQueueBySession((prev) => ({ ...prev, [sessionId]: queue }))
    })
    // Recovery can begin before BrowserWindow (and therefore this listener)
    // exists. Pull the authoritative runtime snapshot after subscribing, then
    // keep any newer live values that arrived while the invoke was in flight.
    void window.uniagent.listQueues()
      .then((snapshot) => {
        if (!cancelled) {
          setQueueBySession((live) => mergeQueueSnapshots(snapshot, live))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStartupProgress({ agentId: '*', phase: 'failed', message: '消息队列加载失败，请重新打开 App' })
        }
      })

    const offSessionUpdated = window.uniagent.onSessionUpdated(({ session, backendConfigCorrectionSeq, hasLiveStreamer }) => {
      if (isToolSession(session) || isToolSession(sessionsRef.current.find((item) => item.id === session.id))) {
        setUnreadBySession((current) => current[session.id] ? { ...current, [session.id]: undefined } : current)
      }
      if (backendConfigCorrectionSeq !== undefined) {
        setCorrectionSeqBySession((prev) => ({ ...prev, [session.id]: backendConfigCorrectionSeq }))
      }
      if (hasLiveStreamer !== undefined) {
        setLiveStreamerBySession((prev) => ({ ...prev, [session.id]: hasLiveStreamer }))
      }
      // A terminal session snapshot also repairs a missed terminal status push.
      // Busy snapshots are not copied here: turn/status events own that lifecycle.
      if (!isSessionBusy(session.status)) {
        setStatusBySession((prev) => ({ ...prev, [session.id]: session.status }))
      }
      setSessions((prev) => prev.map((s) => (s.id === session.id ? session : s)))
    })

    // Background creations never steal focus.
    const offCreated = window.uniagent.onSessionCreated((session) => {
      const key = sessionDedupKey(session)
      setSessions((prev) => [session, ...prev.filter((s) => sessionDedupKey(s) !== key)])
      const rowId = teamRowSessionId(teamRowIdsRef.current, session.id)
      if (displayedRowIdRef.current !== rowId && !isToolSession(session)) {
        setUnreadBySession((unread) => ({ ...unread, [rowId]: 'main' }))
      }
    })
    const offLifecycle = window.uniagent.onLifecycleProgress((progress) => {
      // Per-Agent lifecycle progress (update/check) is shown inline beside that
      // Agent in Settings — never as the bottom-right toast, which is reserved
      // for app-wide startup ('*') progress.
      setStartupProgress(progress.agentId === '*' ? progress : null)
      // Refresh the snapshot on terminal phases and while an Agent is updating,
      // so its list row + detail reflect the live '更新中' status.
      if (progress.phase === 'completed' || progress.phase === 'failed' || progress.phase === 'updating' || progress.phase === 'detecting') {
        const generation = ++agentSnapshotGenerationRef.current
        void window.uniagent.getLifecycleSnapshot()
          .then((next) => {
            if (!cancelled && agentSnapshotGenerationRef.current === generation) {
              setAgents(next)
              if (next.some(agent => agent.lifecycle?.detectionStatus === 'detecting')) setAgentsRedetecting(false)
            }
          })
          .catch(() => {
            if (!cancelled && agentSnapshotGenerationRef.current === generation) {
              setStartupProgress({ agentId: '*', phase: 'failed', message: 'Agent 状态刷新失败，请重试' })
            }
          })
          .finally(() => {
            if (!cancelled && agentSnapshotGenerationRef.current === generation) setAgentsLoading(false)
          })
      }
    })
    const offAgentUpdate = window.uniagent.onAgentUpdate((update) => {
      // Associate negotiated options with their originating session. Two live
      // sessions may expose different model/mode inventories; the global
      // definition remains the conservative New Task baseline.
      setSessions((prev) =>
        prev.map((session) =>
          session.id === update.sessionId && session.config.agentId === update.agentId
            ? { ...session, config: update.config, agentContract: update.contract }
            : session
        )
      )
      // The createSession IPC reply and this push travel on separate channels.
      // Refresh from the authoritative store so an unusually fast handshake
      // cannot publish before the new session is present in local React state.
      void window.uniagent.listSessions().then((latest) => {
        if (!cancelled) setSessions(latest)
      })
    })
    const offAppNotification = window.uniagent.onAppNotificationOpenSession(handleSelect)

    return () => {
      cancelled = true
      if (eventTimer) clearTimeout(eventTimer)
      offEvent()
      offZCodeReset()
      offStatus()
      offSideStatus()
      offQueue()
      offSessionUpdated()
      offCreated()
      offLifecycle()
      offAgentUpdate()
      offAppNotification()
    }
  }, [])

  const runtimeSessions = useMemo(() => sessions.map(session => {
    const status = statusBySession[session.id]
    return status && status !== session.status ? { ...session, status } : session
  }), [sessions, statusBySession])
  const activityBySession = useMemo(() => Object.fromEntries(runtimeSessions.map(session => [
    session.id,
    sessionActivityStatus(session, teamCatalog.projects.find(p => p.id === session.teamBinding?.teamProjectId), runtimeSessions)
  ] as const)), [runtimeSessions, teamCatalog.projects])
  useEffect(() => {
    setSavedPendingInteractions(previous => reconcileSidebarPending(previous, eventsBySession, hydratedSessions, statusBySession))
  }, [eventsBySession, hydratedSessions, statusBySession])
  const pendingInteractionBySession = useMemo(() => {
    const pending = reconcileSidebarPending(savedPendingInteractions, eventsBySession, hydratedSessions, statusBySession)
    return Object.fromEntries([
      ...Object.entries(pending).map(([sessionId, keys]) => [sessionId, keys.length > 0]),
      ...Object.entries(eventsBySession).filter(([, events]) => events.some(event => isPendingInteraction(event) && !interactionRequestKey(event)))
        .map(([sessionId]) => [sessionId, true])
    ])
  }, [savedPendingInteractions, eventsBySession, hydratedSessions, statusBySession])
  const activeTeam = teamCatalog.projects.find(p => Object.values(p.memberSessions).includes(activeId || '') || activeId === 'team:' + p.id)
  const activeMember = !!activeTeam && activeId !== activeTeam.memberSessions[activeTeam.team.leaderMemberId] && activeId !== 'team:' + activeTeam.id
  const activeSession = runtimeSessions.find(s => s.id === (activeId?.startsWith('team:') ? activeTeam?.memberSessions[activeTeam.team.leaderMemberId] : activeId) && !activeMember && (!s.teamBinding || !!activeTeam)) || null
  useEffect(() => { comments?.configure(activeSession, agents) }, [activeSession, agents, comments?.configure])
  useEffect(() => window.uniagent.onDetailPromoted(result => {
    setDetailPopover(null)
    if (result.kind === 'side') { setOpenSubAgent(null); setSideChatOpen(true) }
    else if (result.session) handleSidePromoted(result.session)
  }), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const locate = (event: Event): void => {
      const thread = (event as CustomEvent<CommentThread>).detail
      if (thread.sessionId !== activeSession?.id) return
      setCommentNotice('')
      const find = (): HTMLElement | undefined => Array.from(document.querySelectorAll<HTMLElement>('[data-anno-id]'))
        .find(node => node.dataset.annoId === COMMENT_ANNOTATION_PREFIX + thread.id && node.getBoundingClientRect().width > 0)
      const existing = find()
      if (existing) { existing.scrollIntoView({ block: 'center', behavior: 'smooth' }); existing.focus(); return }
      if (thread.anchor.filePath) { setReaderEventSeq(null); handleOpenFile(thread.anchor.filePath) }
      else {
        setFilesOpen(false)
        void window.uniagent.getEvents(thread.sessionId).then(events => {
          if (!events.some(event => event.seq === thread.anchor.seq && event.type === 'agent_message')) { setCommentNotice('原回复已不存在，评论中仍保留原文引用'); return }
          setEventsBySession(previous => ({ ...previous, [thread.sessionId]: events }))
          setReaderEventSeq(thread.anchor.seq)
        }).catch(() => setCommentNotice('无法读取原回复，评论中仍保留原文引用'))
      }
      let attempts = 0
      const retry = (): void => {
        const node = find()
        if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.focus(); return }
        if (++attempts < 20) timer = setTimeout(retry, 100)
        else setCommentNotice('原文已变化或不可访问，评论中仍保留原文引用')
      }
      timer = setTimeout(retry, 100)
    }
    const edit = (event: Event): void => { if (activeSession) handleEditAnnotation(activeSession.id, (event as CustomEvent<Annotation>).detail.id) }
    window.addEventListener('ua:locate-comment', locate); window.addEventListener('ua:edit-pending-comment', edit)
    return () => { clearTimeout(timer); window.removeEventListener('ua:locate-comment', locate); window.removeEventListener('ua:edit-pending-comment', edit) }
  }, [activeSession?.id])
  // Team members share their Leader's sidebar row. Unread is stored per row so the
  // dot, the read action and the Dock badge always describe the same session.
  const teamRowIds = useMemo(() => teamRowSessionIds(teamCatalog.projects), [teamCatalog.projects])
  teamRowIdsRef.current = teamRowIds
  const displayedRowId = panel || startupVisible
    ? null
    : activeSession ? teamRowSessionId(teamRowIds, activeSession.id)
      : activeMember && activeId ? teamRowSessionId(teamRowIds, activeId)
        : null
  displayedRowIdRef.current = displayedRowId
  useSessionAttention(displayedRowId)
  useEffect(() => { if (activeId === 'team:' + activeTeam?.id) setActiveId(activeTeam!.memberSessions[activeTeam!.team.leaderMemberId]) }, [activeId, activeTeam?.id])
  const sidebarSessions = useMemo(() => [...runtimeSessions.filter(s => !s.teamBinding), ...teamSessionRows(teamCatalog.projects, runtimeSessions)], [runtimeSessions, teamCatalog.projects])
  useEffect(() => {
    if (!activeTeam || panel) return
    const ids = Object.values(activeTeam.memberSessions)
    if (ids.some(id => unreadBySession[id])) setUnreadBySession(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.includes(id))))
  }, [activeTeam?.id, panel, unreadBySession])
  async function handleCreateTeam(input: TeamCreateProjectInput): Promise<void> {
    const p = await window.uniagent.createTeamProject(input)
    setTeamCatalog(c => {
      const current = c.projects.find(project => project.id === p.id)
      return { ...c, projects: [...c.projects.filter(old => old.id !== p.id), current && current.revision > p.revision ? current : p] }
    })
    void window.uniagent.listSessions().then(next => setSessions(current => next.map(session => {
      const latest = current.find(item => item.id === session.id)
      return latest && (latest.updatedAt || 0) > (session.updatedAt || 0) ? latest : session
    }))).catch(e => setTeamError(String(e)))
    setActiveId(p.memberSessions[p.team.leaderMemberId]); setPanel(null); setNewTaskKey(k => k + 1)
  }
  const activeToolSession = isToolSession(activeSession)
  const handoffSessionTargets = useMemo(() => {
    const targets: Record<string, HandoffSessionTarget> = {}
    for (const session of sessions) {
      if (!session.handoffId) continue
      targets[session.handoffId] = {
        sessionId: session.id,
        agentName: agents.find(agent => agent.id === session.config.agentId)?.name || session.config.agentId,
        ...(session.config.roleSnapshot?.name ? { roleName: session.config.roleSnapshot.name } : {})
      }
    }
    return targets
  }, [sessions, agents])
  const activeAgentBase = agents.find((a) => a.id === activeSession?.config.agentId)
  const activeAgent = activeAgentBase
    ? agentForSession(activeAgentBase, activeSession)
    : undefined
  const latestForkSource = sessions.find((session) => session.id === latestSessionFork?.sessionId)
  const latestForkSourceBase = agents.find((agent) => agent.id === latestForkSource?.config.agentId)
  const latestForkSourceAgent = latestForkSourceBase
    ? agentForSession(latestForkSourceBase, latestForkSource)
    : undefined
  const latestForkTargets = currentSessionForkTargets(latestForkSourceAgent, agents)
  const activeEvents = activeId ? eventsBySession[activeId] || [] : []
  const activeSubAgents = useMemo(
    () => subAgentsFromEvents(activeEvents, activeSession?.subagents),
    [activeEvents, activeSession?.subagents]
  )
  const readerEvent = readerEventSeq === null
    ? undefined
    : activeEvents.find((event) => event.seq === readerEventSeq && event.type === 'agent_message')
  // While a freshly opened session's history is being hydrated from the
  // orchestrator, `eventsBySession[activeId]` is still undefined. Show a loading
  // overlay over the chat area so the user sees progress instead of a blank body.
  const sessionHydrating = !!activeId && eventsBySession[activeId] === undefined
  const activeQueue = activeId ? queueBySession[activeId] || [] : []
  const activeRuntimeStatus = activeSession?.status || 'idle'
  const activeStatus = activeSession ? activityBySession[activeSession.id] : 'idle'
  const conversationEvents = useMemo(() => {
    const events = activeTeam && activeSession ? teamSessionEvents(activeTeam, activeSession.id, activeEvents) : activeEvents
    const task = activeSession?.worktreeTask
    if (!activeSession || !task || events.some(event => event.type === 'user_message' || event.type === 'goal_message')) return events
    const prompt = task.kind === 'message' ? task.prompt : task.action.type === 'goal.set' ? task.action.objective : 'Review'
    const pending: UAEvent = { sessionId: activeSession.id, seq: -1, ts: activeSession.createdAt, type: 'user_message',
      payload: { text: prompt, ...(task.kind === 'message' && task.attachments ? { attachments: task.attachments } : {}) } }
    return [pending, ...events]
  }, [activeTeam, activeSession, activeEvents])
  const worktreeInputBlocked = !!activeSession?.config.worktree && (activeSession.config.worktree.state !== 'ready' || !!activeSession.worktreeTask && !activeSession.worktreeTaskError)
  const worktreeDraftRestored = useRef('')
  useEffect(() => {
    const task = activeSession?.worktreeTask
    if (!activeSession?.worktreeTaskError || activeSession.config.worktree?.state !== 'ready' || task?.kind !== 'message') return
    const key = `${activeSession.id}:${activeSession.worktreeTaskError}`
    if (worktreeDraftRestored.current === key) return
    worktreeDraftRestored.current = key
    setComposerDraftSeed({ sessionId: activeSession.id, agentId: activeSession.config.agentId, workdir: activeSession.config.workdir,
      text: task.prompt, command: task.activatePlan ? 'plan' : null, candidateIds: task.selection?.candidateIds || [], attachments: task.attachments || [] })
  }, [activeSession])
  useEffect(() => {
    setActiveHistoryForkPoints([])
    if (
      !activeSession?.nativeSessionId ||
      sessionHydrating ||
      isSessionBusy(activeStatus)
    ) return
    let cancelled = false
    void window.uniagent.getSessionForkPoints(activeSession.id)
      .then((points) => {
        if (!cancelled) setActiveHistoryForkPoints(points)
      })
      .catch(() => {
        if (!cancelled) setActiveHistoryForkPoints([])
      })
    return () => { cancelled = true }
  }, [
    activeSession?.id,
    activeSession?.nativeSessionId,
    activeStatus,
    sessionHydrating,
    activeEvents.length,
    activeEvents.at(-1)?.seq,
  ])

  useEffect(() => {
    if (readerEventSeq !== null && !readerEvent) setReaderEventSeq(null)
  }, [readerEvent, readerEventSeq])
  const {
    snapshot: activeNativeCapabilities,
    ready: activeNativeCapabilitiesReady
  } = useNativeCapabilities(
    worktreeInputBlocked ? undefined : activeSession?.config.agentId,
    worktreeInputBlocked ? undefined : activeSession?.config.workdir,
    activeSession?.id
  )

  // Follow the active direct import's native file as well as its ownership.
  // Unchanged files need only a stat/lsof check; changed files reuse read-only
  // refresh, with the pre-read revision retained so concurrent appends retry.
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    let checking = false
    const refreshRuntime = (): void => {
      if (checking) return
      checking = true
      void window.uniagent.getSessionRuntimeState(activeId, activeSession?.config.agentId === 'zcode').then(async (runtime) => {
        if (!cancelled) {
          if (runtime.zcodeEvents) applyZCodeSnapshot({ sessionId: activeId, events: runtime.events, ...runtime.zcodeEvents })
          setNativeOccupancyBySession((prev) => ({
            ...prev,
            [activeId]: runtime.nativeSessionOccupancy
          }))
          setLiveStreamerBySession((prev) => ({ ...prev, [activeId]: runtime.hasLiveStreamer }))
          const version = runtime.nativeSessionOccupancy.historyVersion
          if (
            activeSession?.importMode === 'direct' &&
            activeSession.config.agentId === 'codex' &&
            !isSessionBusy(activeStatus) &&
            version && syncedNativeVersionsRef.current[activeId] !== version
          ) {
            const refreshed = await refreshNativeSessionHistory(activeId)
            if (refreshed) syncedNativeVersionsRef.current[activeId] = version
          }
        }
      }).catch(() => {
        // Keep the last known state; the next focus/poll retries the read-only check.
      }).finally(() => {
        checking = false
      })
    }
    refreshRuntime()
    const timer = window.setInterval(refreshRuntime, 5_000)
    window.addEventListener('focus', refreshRuntime)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshRuntime)
    }
  }, [activeId, activeSession?.importMode, activeSession?.config.agentId, activeSession?.nativeSessionId, activeStatus])
  const activeNativeOccupancy = activeId ? nativeOccupancyBySession[activeId] : undefined
  const activeSessionExternallyOccupied = activeNativeOccupancy?.state === 'occupied'

  async function handleEnableToolSession(): Promise<void> {
    if (!activeSession || !activeToolSession) return
    const sessionId = activeSession.id
    const updated = await window.uniagent.enableToolSession(sessionId)
    setUnreadBySession((current) => ({ ...current, [teamRowSessionId(teamRowIdsRef.current, sessionId)]: undefined }))
    setSessions((current) => current.map((session) => session.id === sessionId ? updated : session))
  }

  async function handleRefreshNativeSession(): Promise<void> {
    if (!activeId || isSessionBusy(activeStatus)) return
    await refreshNativeSessionHistory(activeId)
  }

  async function refreshNativeSessionHistory(sessionId: string): Promise<boolean> {
    if (nativeRefreshesRef.current.has(sessionId)) return false
    nativeRefreshesRef.current.add(sessionId)
    const startingEvents = eventsBySessionRef.current[sessionId]
    setRefreshingNativeSessionId(sessionId)
    try {
      const { session, runtime } = await window.uniagent.refreshNativeSession(sessionId)
      // A send, live delta or competing hydration owns any newer transcript.
      // Retry on the next poll rather than overwriting it with a history snapshot.
      if (eventsBySessionRef.current[sessionId] !== startingEvents) return false
      setSessions((prev) => prev.map((item) => item.id === sessionId ? session : item))
      setEventsBySession((prev) => prev[sessionId] !== startingEvents ? prev : {
        ...prev, [sessionId]: mergeHydratedSessionEvents(runtime.events, [])
      })
      setStatusBySession((prev) => ({ ...prev, [sessionId]: session.status }))
      if (runtime.backendConfigCorrectionSeq !== undefined) {
        setCorrectionSeqBySession((prev) => ({
          ...prev,
          [sessionId]: runtime.backendConfigCorrectionSeq as number
        }))
      }
      setNativeOccupancyBySession((prev) => ({
        ...prev,
        [sessionId]: runtime.nativeSessionOccupancy
      }))
      setLiveStreamerBySession((prev) => ({
        ...prev,
        [sessionId]: runtime.hasLiveStreamer
      }))
      return true
    } catch {
      // Preserve the current transcript and occupancy state; the user can retry.
      return false
    } finally {
      nativeRefreshesRef.current.delete(sessionId)
      setRefreshingNativeSessionId((current) => current === sessionId ? null : current)
    }
  }
  const latestDiff = useMemo(() => {
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      const event = activeEvents[i]
      if (event.type === 'diff_update' && event.payload?.diff) return String(event.payload.diff)
    }
    return ''
  }, [activeEvents])
  const previousTurn = useMemo(() => {
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      const completed = activeEvents[i]
      if (completed.type !== 'turn_completed') continue
      let diff = ''
      for (let j = i - 1; j >= 0 && activeEvents[j].type !== 'turn_completed'; j--) {
        if (activeEvents[j].type === 'diff_update' && activeEvents[j].payload?.diff) {
          diff = String(activeEvents[j].payload.diff)
          break
        }
      }
      const completedId = completed.payload?.turnId ?? completed.payload?.turn_id ?? completed.payload?.id
      if (completedId != null && String(completedId).trim()) {
        return { turnId: String(completedId).trim(), diff }
      }
      // Legacy completions can omit the id. Find only the start belonging to this
      // completion; crossing another completion would select the wrong turn.
      for (let j = i - 1; j >= 0; j--) {
        const candidate = activeEvents[j]
        if (candidate.type === 'turn_completed') break
        if (candidate.type !== 'turn_started') continue
        const startedId = candidate.payload?.turnId ?? candidate.payload?.turn_id ?? candidate.payload?.id
        if (startedId != null && String(startedId).trim()) {
          return { turnId: String(startedId).trim(), diff }
        }
      }
      return undefined
    }
    return undefined
  }, [activeEvents])
  const previousTurnId = previousTurn?.turnId
  const completedTurns = useMemo(
    () => activeEvents.filter((event) => event.type === 'turn_completed').length,
    [activeEvents]
  )

  useEffect(() => {
    setReviewOpen(false)
    setReviewScope({ kind: 'workspace' })
    setReviewTurnDiff('')
    setReviewInitialFile(undefined)
    setFilesOpen(false)
    setReviewChangeSet(null)
    if (!activeId) return
    let cancelled = false
    window.uniagent.reviewGetChangeSet(activeId).then(
      (changeSet) => { if (!cancelled) setReviewChangeSet(changeSet) },
      () => { if (!cancelled) setReviewChangeSet({ isGitRepo: false, items: [] }) }
    )
    return () => { cancelled = true }
  }, [activeId, completedTurns])

  // A live metadata event is not a complete history. Hydrate once on first open,
  // merge newer events, and reconcile requests that expired on restart.
  useEffect(() => {
    if (!activeId || hydratedSessionsRef.current.has(activeId)) return
    const sessionId = activeId
    let cancelled = false
    window.uniagent.getSessionRuntimeState(sessionId).then((runtime) => {
      if (cancelled) return
      const { events: evs, backendConfigCorrectionSeq } = runtime
      if (backendConfigCorrectionSeq !== undefined) {
        setCorrectionSeqBySession((prev) => ({ ...prev, [sessionId]: backendConfigCorrectionSeq }))
      }
      setNativeOccupancyBySession((prev) => ({
        ...prev,
        [sessionId]: runtime.nativeSessionOccupancy
      }))
      setLiveStreamerBySession((prev) => ({
        ...prev,
        [sessionId]: runtime.hasLiveStreamer
      }))
      if (runtime.zcodeEvents) applyZCodeSnapshot({ sessionId, events: evs, ...runtime.zcodeEvents })
      else setEventsBySession((prev) => ({
        ...prev,
        [sessionId]: mergeHydratedSessionEvents(evs, prev[sessionId] || [])
      }))
      hydratedSessionsRef.current.add(sessionId)
      setHydratedSessions(previous => ({ ...previous, [sessionId]: true }))
    })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // Context load (Doc1 需求3): sum the latest usage snapshot for this session.
  const contextInfo = useMemo(() => computeContext(activeEvents), [activeEvents])
  const contextWindow = useMemo(() => {
    const m = activeAgent?.models.find((x) => x.id === activeSession?.config.model)
    const configured = activeSession?.config.maxMode ? m?.maxContextWindow : m?.contextWindow
    // A usage tick is authoritative only for the turn that produced it. Between
    // turns, a model/Max toggle must update the meter immediately instead of
    // being masked by the previous turn's window. During a new turn, also ignore
    // old usage until the first tick after its latest user message arrives.
    return displayedContextWindow(
      activeEvents,
      activeStatus,
      configured,
      activeId ? correctionSeqBySession[activeId] : undefined
    )
  }, [activeAgent, activeSession?.config.model, activeSession?.config.maxMode, activeEvents, activeStatus, activeId, correctionSeqBySession])
  const supportsManualCompact = supportsManualContextCompaction(activeAgent)
  const compactAvailability = contextCompactionAvailability(
    supportsManualCompact,
    activeStatus,
    activeEvents,
    !!(activeId && liveStreamerBySession[activeId]) || activeAgent?.adapter === 'kimi' ||
      (activeAgent?.adapter === 'claude' && !!activeSession?.nativeSessionId),
    !!(activeId && modelPreparingBySession[activeId])
  )
  const invalidateForkOperation = (): void => {
    forkOperationRef.current.activeToken = null
    setForkBusy(null)
    setHistoryForkConfirmation(null)
  }

  async function handleCreate(
    config: SessionConfig,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean
  ): Promise<Session> {
    invalidateForkOperation()
    return window.uniagent.createSession(config, prompt, attachments, selection, activatePlan)
  }

  async function handleCreateNativeAction(
    config: SessionConfig,
    action: NativeThreadAction
  ): Promise<Session> {
    invalidateForkOperation()
    return window.uniagent.createNativeActionSession(config, action)
  }

  function handleCommitCreatedSession(session: Session, seed: ComposerDraftSeed | null): void {
    // Fold into its identity (Doc5 T3): drop any existing row sharing the same
    // (agentId+native/lane) key.
    const key = sessionDedupKey(session)
    setSessions((prev) => {
      const current = prev.find(item => item.id === session.id)
      const latest = session.config.worktree && current && (current.updatedAt || 0) > (session.updatedAt || 0) ? current : session
      return [latest, ...prev.filter(item => sessionDedupKey(item) !== key)]
    })
    setComposerDraftSeed(seed)
    setActiveId(session.id)
    setNewTaskKey((current) => current + 1)
    setQuickCreateSeed(null)
    setNewTaskPrefill(null)
  }

  function openNewTask(seed: (Partial<Pick<SessionConfig, 'agentId' | 'projectId' | 'requirementId'>> & { teamId?: string }) | null = null): void {
    invalidateForkOperation()
    setQuickCreateSeed(seed ? { ...seed } : null)
    setComposerDraftSeed(null)
    setNewTaskPrefill(null)
    setPanel(null)
    setActiveId(null)
    setReviewOpen(false)
    setFilesOpen(false)
    setOpenSubAgent(null)
    setSideChatOpen(false)
  }

  function beginInitialization(targetAgentId: string): void {
    if (targetAgentId === 'deepseek') {
      openSettingsCategory('agent')
      return
    }
    openNewTask()
    setNewTaskPrefill({
      text: agentInitializationPrompt(
        targetAgentId,
        agents.find((agent) => agent.id === targetAgentId)?.name || targetAgentId
      )
    })
  }

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent).detail
      if (typeof id === 'string' && sessionsRef.current.some(s => s.id === id && s.config.assistantSnapshot && !s.teamBinding && !s.handoffId)) handleSelect(id)
    }
    window.addEventListener('uniagent-open-assistant-session', open)
    return () => window.removeEventListener('uniagent-open-assistant-session', open)
  }, [])

  async function handleSend(
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean,
    bubble?: TurnBubbleInput
  ): Promise<void> {
    if (!activeId) return
    const sessionId = activeId
    const assistantCommand = sessions.find(session => session.id === sessionId)?.config.assistantSnapshot ? parseAssistantCommand(prompt) : undefined
    if (assistantCommand && !bubble?.comments?.length && !bubble?.displayText) {
      if (attachments?.length) throw new Error('会话命令不支持附件，请移除附件后重试')
      const session = await window.uniagent.assistantCommand(sessionId, assistantCommand, crypto.randomUUID())
      setSessions(current => [...current.filter(item => item.id !== session.id), session].map(item => item.id === sessionId && assistantCommand === 'clear' ? { ...item, archived: true } : item))
      if (activeIdRef.current === sessionId) setActiveId(session.id)
      return
    }
    const previousStatus = statusBySession[sessionId]
    const optimisticTs = Date.now()
    const busyAtSend = isSessionBusy(activeRuntimeStatus)
    // 选中即评论 — the sent bubble shows the instruction (`displayText`) + structured
    // comment cards; carry them onto the optimistic event so the user sees them
    // immediately, and pass them to the backend so the persisted turn keeps them.
    const bubbleDecoration = bubble && (bubble.comments?.length || bubble.displayText)
      ? {
          ...(bubble.comments?.length ? { comments: bubble.comments } : {}),
          ...(bubble.displayText ? { displayText: bubble.displayText } : {})
        }
      : undefined
    const optimisticQueueItem: QueueItem | undefined = busyAtSend && activatePlan !== true
      ? {
          id: `optimistic-queue-${sessionId}-${optimisticTs}`,
          prompt,
          attachments,
          nativeContext: optimisticNativeContext(selection, activeNativeCapabilities),
          ...(bubbleDecoration || {})
        }
      : undefined
    const optimisticEvent: UAEvent | undefined = busyAtSend
      ? undefined
      : {
          sessionId,
          seq: Number.MAX_SAFE_INTEGER,
          ts: optimisticTs,
          type: 'user_message',
          state: 'success',
          payload: {
            text: prompt,
            attachments,
            optimistic: true,
            clientTurnKey: `optimistic-${sessionId}-${optimisticTs}`,
            ...(activatePlan === true ? { command: 'plan' } : {}),
            ...(bubbleDecoration || {}),
            nativeContext: optimisticNativeContext(selection, activeNativeCapabilities)
          }
        }
    if (optimisticQueueItem) {
      setQueueBySession((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] || []), optimisticQueueItem]
      }))
    }
    if (optimisticEvent) {
      setEventsBySession((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] || []), optimisticEvent]
      }))
    }
    // Show the submitted bubble before switching the conversation to running.
    // Busy sends remain queue items until the backend actually dispatches them.
    optimisticRunning(sessionId)
    if (activeIdRef.current === sessionId) setScrollToBottomSignal((value) => value + 1)
    try {
      await window.uniagent.sendMessage(sessionId, prompt, attachments, selection, activatePlan, bubble)
      // 选中即评论 — the pending comments are now on the sent turn; drop them from
      // the composer tray + localStorage so they don't ride along the next send.
      if (bubbleDecoration?.comments) clearAnnotations(sessionId)
    } catch (error) {
      if (optimisticEvent) {
        setEventsBySession((current) => ({
          ...current,
          [sessionId]: (current[sessionId] || []).filter((event) => event !== optimisticEvent)
        }))
      }
      setStatusBySession((current) =>
        rollbackOptimisticSessionStatus(current, sessionId, previousStatus)
      )
      if (optimisticQueueItem) {
        setQueueBySession((current) => ({
          ...current,
          [sessionId]: (current[sessionId] || []).filter(
            (item) => item.id !== optimisticQueueItem.id
          )
        }))
      }
      throw error
    }
  }
  async function handleForceSend(
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    bubble?: TurnBubbleInput
  ): Promise<void> {
    if (!activeId) return
    if (activeSession?.config.assistantSnapshot && parseAssistantCommand(prompt) && !bubble?.comments?.length && !bubble?.displayText) return handleSend(prompt, attachments, selection, false, bubble)
    const sessionId = activeId
    const previousStatus = statusBySession[sessionId]
    optimisticRunning(sessionId)
    if (activeIdRef.current === sessionId) setScrollToBottomSignal((value) => value + 1)
    try {
      await window.uniagent.forceSend(sessionId, prompt, attachments, selection, bubble)
      if (bubble?.comments?.length) clearAnnotations(sessionId)
    } catch (error) {
      setStatusBySession((current) =>
        rollbackOptimisticSessionStatus(current, sessionId, previousStatus)
      )
      throw error
    }
  }
  async function handleRunNativeAction(action: NativeThreadAction): Promise<void> {
    if (!activeId) return
    const sessionId = activeId
    const optimisticEvent: UAEvent | undefined = action.type === 'goal.set'
      ? {
          sessionId,
          seq: Number.MAX_SAFE_INTEGER,
          ts: Date.now(),
          type: 'goal_message',
          state: 'success',
          payload: { text: action.objective, command: 'goal', optimistic: true }
        }
      : undefined
    if (optimisticEvent) {
      setEventsBySession((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] || []), optimisticEvent]
      }))
      if (activeIdRef.current === sessionId) setScrollToBottomSignal((value) => value + 1)
    }
    try {
      await window.uniagent.runNativeAction(sessionId, action)
    } catch (error) {
      if (optimisticEvent) {
        setEventsBySession((current) => ({
          ...current,
          [sessionId]: (current[sessionId] || []).filter((event) => event !== optimisticEvent)
        }))
      }
      throw error
    }
  }
  async function handleSetCollaborationMode(mode: CollaborationModeId): Promise<void> {
    if (!activeId) return
    const sessionId = activeId
    await window.uniagent.setCollaborationMode(sessionId, mode)
  }
  async function handleImplementPlan(): Promise<void> {
    await handleSetCollaborationMode('default')
    try {
      await handleSend('Implement the plan.')
    } catch (error) {
      await handleSetCollaborationMode('plan').catch(() => undefined)
      throw error
    }
  }
  async function handleRevisePlan(feedback: string): Promise<void> {
    await handleSend(feedback)
  }
  // 需求19: optimistic "running" so feedback is immediate. Only nudges an idle
  // session — a real backend status (running/queued/…) always wins afterwards.
  function optimisticRunning(id: string): void {
    setStatusBySession((prev) => {
      const s = prev[id] ?? sessionsRef.current.find(session => session.id === id)?.status
      if (isSessionBusy(s)) {
        return prev
      }
      return { ...prev, [id]: 'running' }
    })
  }
  function handleInterrupt(): void {
    if (activeId && !activeToolSession) window.uniagent.interrupt(activeId)
  }

  async function redetectAgents(options: { silent?: boolean } = {}): Promise<void> {
    const silent = options.silent === true
    const generation = ++agentSnapshotGenerationRef.current
    setAgents(previous => previous.map(pendingAgentDetection))
    if (!silent) {
      setAgentsRedetecting(true)
      setStartupProgress(null)
    }
    try {
      const next = await window.uniagent.detectAgents()
      if (agentSnapshotGenerationRef.current === generation) {
        setAgents(next)
        if (!silent) setStartupProgress(null)
      }
    } catch {
      if (!silent && agentSnapshotGenerationRef.current === generation) {
        setStartupProgress(null)
      }
    } finally {
      if (!silent) setAgentsRedetecting(false)
    }
  }
  async function handleDequeue(itemId: string): Promise<void> {
    if (activeId) await window.uniagent.dequeue(activeId, itemId)
  }
  async function handlePromoteQueue(itemId: string): Promise<void> {
    if (!activeId) return
    const sessionId = activeId
    await window.uniagent.promoteQueueItem(sessionId, itemId)
    if (activeIdRef.current === sessionId) setScrollToBottomSignal((value) => value + 1)
  }
  async function handleEditQueueItem(
    itemId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest
  ): Promise<void> {
    if (!activeId) return
    await window.uniagent.editQueueItem(activeId, itemId, prompt, attachments, selection)
  }
  async function handleUpdateConfig(patch: Partial<SessionConfig>): Promise<void> {
    if (!activeId) return
    const sessionId = activeId
    const preparesModel = activeSession?.config.agentId === 'codex' && (patch.model !== undefined || patch.modelSource !== undefined)
    if (preparesModel) setModelPreparingBySession((prev) => ({ ...prev, [sessionId]: true }))
    try {
      const updated = await window.uniagent.updateSessionConfig(sessionId, patch)
      if (updated) {
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
        // Persist only an update the native provider actually accepted. A
        // rejection is surfaced as a transcript warning by the orchestrator.
        void window.uniagent.setPrefs(updated.config.agentId, {
          model: updated.config.model,
          effort: updated.config.effort,
          ...(updated.config.agentId === 'zcode' ? { zcodeThinking: updated.config.zcodeModelSelection?.options?.reasoningLevel } : {}),
          permissionMode: updated.config.permissionMode,
          fastMode: updated.config.fastMode,
          maxMode: updated.config.maxMode
        })
      }
    } catch {
      // Keep the controlled selectors on their prior committed props.
    } finally {
      if (preparesModel) setModelPreparingBySession((prev) => ({ ...prev, [sessionId]: false }))
    }
  }
  async function handleRespond(requestId: string, answer: unknown): Promise<void> {
    if (!activeId) throw new Error('会话已切换')
    const sessionId = activeId
    await window.uniagent.respondRequest(sessionId, requestId, answer)
    setEventsBySession((current) => {
      const events = current[sessionId]
      if (!events) return current
      const index = events.findLastIndex(
        (event) => interactionRequestKey(event) === requestId
      )
      if (index < 0) return current
      const next = [...events]
      next[index] = {
        ...next[index],
        payload: { ...next[index].payload, submittedAnswer: answer }
      }
      return { ...current, [sessionId]: next }
    })
  }
  async function handleCompactSession(): Promise<void> {
    if (!activeId) return
    try {
      await window.uniagent.compactSession(activeId)
    } catch {
      // Session status can change between eligibility calculation and the IPC.
      // ContextMeter resets its pending state in finally; provider events remain authoritative.
    }
  }
  // Doc5 — open a specific sub-agent's DETAIL panel (from an inline lifecycle row).
  function handleOpenSubAgent(agentThreadId: string): void {
    setSideChatOpen(false)
    setSubPanelView('detail')
    setOpenSubAgent(agentThreadId)
  }

  // 需求一 — open the review overlay scoped to a single turn, optionally focused on
  // one file (变更卡内文件行点击). Turn scope shows only this turn's diff, never the
  // whole workspace.
  function handleOpenTurnReview(arg: { turnId?: string; diff: string; filePath?: string }): void {
    if (!arg.turnId) return
    setFilesOpen(false)
    setReviewScope({ kind: 'turn', turnId: arg.turnId })
    setReviewTurnDiff(arg.diff)
    setReviewInitialFile(arg.filePath)
    setReviewOpen(true)
  }

  // 需求五 — open the internal file browser focused on a path the user clicked in a
  // reply (相对/绝对路径), positioning the given line when available.
  function handleOpenFile(path: string, line?: number): void {
    setReviewOpen(false)
    setFileFocus({ path, line })
    setFilesOpen(true)
  }
  function handleOpenRequirement(path: string, root: string): void {
    setReviewOpen(false)
    setFileFocus({ path, root })
    setFilesOpen(true)
  }

  function handleOpenReader(event: UAEvent): void {
    setReviewOpen(false)
    setFilesOpen(false)
    setOpenSubAgent(null)
    setSideChatOpen(false)
    setReaderEventSeq(event.seq)
  }

  // 需求三（会话节点回退）— run the preflight first (loading), then show the confirm
  // dialog. The timeline is NOT touched until the user confirms and the execute
  // step below succeeds ("先检查、再变更、后回填").
  async function handleRewindToTurn(arg: { turnId?: string; userEventSeq: number }): Promise<void> {
    if (!activeId || !arg.turnId) return
    const sessionId = activeId
    setRewind({ phase: 'preview', sessionId, beforeTurnId: arg.turnId, userEventSeq: arg.userEventSeq })
    try {
      const preview = await window.uniagent.previewSessionRewind(sessionId, arg.turnId)
      if (activeIdRef.current !== sessionId) return
      if (!preview.allowed) {
        setRewind({ phase: 'error', sessionId, message: preview.reason || '无法回退到该轮之前。' })
        return
      }
      setRewind({
        phase: 'confirm',
        sessionId,
        beforeTurnId: arg.turnId,
        userEventSeq: arg.userEventSeq,
        preview
      })
    } catch {
      if (activeIdRef.current === sessionId) {
        setRewind({ phase: 'error', sessionId, message: '回退预检失败，会话与文件均未改变。' })
      }
    }
  }

  // 需求三 — execute a confirmed rewind. On success re-hydrate the session runtime
  // (truncated history), then prefill the target turn's user text into the composer
  // WITHOUT auto-sending. On failure keep the UI exactly as it was.
  async function handleRewindConfirm(): Promise<void> {
    if (!rewind || rewind.phase !== 'confirm' || activeId !== rewind.sessionId) return
    const sessionId = rewind.sessionId
    const { beforeTurnId } = rewind
    setRewind({ phase: 'executing', sessionId, beforeTurnId, userEventSeq: rewind.userEventSeq })
    try {
      const result = await window.uniagent.rewindSession(sessionId, beforeTurnId)
      if (!result.ok) {
        if (activeIdRef.current === sessionId) {
          setRewind({ phase: 'error', sessionId, message: result.error })
        }
        return
      }
      const runtime = result.runtime
      setEventsBySession((prev) => ({
        ...prev,
        [sessionId]: mergeHydratedSessionEvents(runtime.events, [])
      }))
      if (runtime.backendConfigCorrectionSeq !== undefined) {
        setCorrectionSeqBySession((prev) => ({
          ...prev,
          [sessionId]: runtime.backendConfigCorrectionSeq as number
        }))
      }
      setLiveStreamerBySession((prev) => ({ ...prev, [sessionId]: runtime.hasLiveStreamer }))
      if (activeIdRef.current !== sessionId) return
      setReviewChangeSet(null)
      setRewind(null)
      setRewindWarning(result.warning ?? null)
      // Finally: drop the target turn's user text into the composer for tweak+resend.
      setComposerPrefill((prev) => ({ text: result.prefillText, nonce: prev.nonce + 1 }))
    } catch {
      if (activeIdRef.current === sessionId) {
        setRewind({ phase: 'error', sessionId, message: '回退执行失败，会话与文件保持原样。' })
      }
    }
  }
  // 修复#4 — open the sub-agent panel on its LIST page (from the summary card's
  // 子智能体 entry): the user browses the roster and picks, rather than being
  // dropped into the first child's detail.
  function handleOpenSubAgentList(anyThreadId: string): void {
    setSideChatOpen(false)
    setSubPanelView('list')
    setOpenSubAgent(anyThreadId)
  }

  // 选中即评论 — the three selection actions for the active session. 评论 persists
  // an annotation into the per-session store (mirrored to localStorage) which the
  // composer's 待评论托盘 renders — no textarea injection. 详情 opens the floating
  // fork popover (auto-explains). 侧边聊天 prefills + opens the drawer.
  function handleAddAnnotation(sessionId: string, a: Omit<Annotation, 'id'>): void {
    const annotation: Annotation = { id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...a }
    setAnnotationsBySession((prev) => {
      const next = [...(prev[sessionId] || []), annotation]
      savePendingComments(sessionId, next)
      return { ...prev, [sessionId]: next }
    })
  }
  function handleRemoveAnnotation(sessionId: string, id: string): void {
    setAnnotationsBySession((prev) => {
      const next = (prev[sessionId] || []).filter((x) => x.id !== id)
      savePendingComments(sessionId, next)
      return { ...prev, [sessionId]: next }
    })
  }
  function handleEditAnnotation(sessionId: string, id: string): void {
    const annotation = annotationsBySession[sessionId]?.find((item) => item.id === id)
    if (!annotation) return
    if (annotation.filePath) handleOpenFile(annotation.filePath)
    setAnnotationEditRequest((current) => ({
      sessionId,
      annotation,
      nonce: (current?.nonce ?? 0) + 1,
    }))
  }
  function handleUpdateAnnotation(sessionId: string, id: string, comment: string): void {
    setAnnotationsBySession((prev) => {
      const current = prev[sessionId] || []
      if (!current.some((item) => item.id === id)) return prev
      const next = current.map((item) => item.id === id ? { ...item, comment } : item)
      savePendingComments(sessionId, next)
      return { ...prev, [sessionId]: next }
    })
  }
  // 选中即评论 — clear all pending comments for a session after a successful send
  // (drops the in-body highlights + the localStorage draft in one shot).
  function clearAnnotations(sessionId: string): void {
    setAnnotationsBySession((prev) => {
      if (!prev[sessionId]?.length) return prev
      savePendingComments(sessionId, [])
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }
  function handleSelectionDetail(a: { quote: string; selectedMessageText: string }): void {
    if (!activeId) return
    // The main-process explain command atomically replaces any prior detail fork,
    // avoiding a close/open IPC race when the user selects a new passage quickly.
    setDetailPopover((prev) => ({
      sessionId: activeId,
      quote: a.quote,
      selectedMessageText: a.selectedMessageText,
      nonce: (prev?.nonce ?? 0) + 1,
    }))
    void window.uniagent.explainDetailSelection(activeId, { selectedText: a.quote, selectedMessageText: a.selectedMessageText,
      sourceConversationId: activeId, targetedReplyLabel: '所选文本' }).catch(error => setCommentNotice(String(error.message || error)))
  }
  function handleSelectionSide(a: { seq: number; start: number; end: number; quote: string }): void {
    // 选中即评论 →「侧边聊天」— pin the selection to the SIDE composer's 待评论托盘
    // (keyed `side:<sessionId>`, cached like the main tray) and open the drawer;
    // no textarea prefill so the side input stays at its resting height.
    if (activeId) handleAddAnnotation(`side:${activeId}`, { ...a, comment: '' })
    setOpenSubAgent(null)
    setSideChatOpen(true)
  }
  function handleSidePromoted(session: Session): void {
    const key = sessionDedupKey(session)
    setSessions((prev) => [session, ...prev.filter((item) => sessionDedupKey(item) !== key)])
    setSideChatOpen(false)
    setActiveId(session.id)
  }

  async function handleImport(
    agentId: string,
    nativeId: string,
    cwd?: string,
    historyTitle?: string
  ): Promise<void> {
    invalidateForkOperation()
    const session = await window.uniagent.importSession(
      agentId,
      nativeId,
      'direct',
      cwd,
      historyTitle
    )
    if (!session) return
    // Doc5 T3: fold into its identity — drop any local dupe that shares the same
    // (agentId+nativeSessionId) key, not just the same local id.
    const key = sessionDedupKey(session)
    setSessions((prev) => [session, ...prev.filter((s) => sessionDedupKey(s) !== key)])
    const events = await window.uniagent.getEvents(session.id)
    setEventsBySession((prev) => ({ ...prev, [session.id]: events }))
    setActiveId(session.id)
    // 需求13: importing from the inline history panel drops back to the chat.
    setPanel(null)
  }

  async function handleCrossImport(
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ): Promise<void> {
    await handleForkSession(sourceAgentId, nativeId, targetAgentId, undefined, point)
  }

  async function handleForkSame(
    agentId: string,
    nativeId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode = false
  ): Promise<void> {
    await handleForkSession(agentId, nativeId, agentId, cwd, point, compatibilityMode)
  }

  async function handleForkSession(
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode = false
  ): Promise<void> {
    const operation = forkOperationRef.current
    if (!nativeId || operation.activeToken !== null) return
    const token = ++operation.nextToken
    operation.activeToken = token
    const sourceActiveId = activeIdRef.current
    const sourcePanel = panelRef.current
    const ownsOperation = (): boolean =>
      operation.activeToken === token &&
      activeIdRef.current === sourceActiveId && panelRef.current === sourcePanel
    const targetName = agents.find((agent) => agent.id === targetAgentId)?.name || targetAgentId
    setForkError('')
    setForkBusy(targetName)
    let createdSessionId: string | null = null
    let discarded = false
    const discardCreatedFork = async (): Promise<void> => {
      if (!createdSessionId || discarded) return
      discarded = true
      await window.uniagent.deleteSession(createdSessionId)
    }
    try {
      const session = sourceAgentId === targetAgentId
        ? await window.uniagent.forkSameSession(sourceAgentId, nativeId, cwd, point, compatibilityMode)
        : await window.uniagent.forkCrossSession(sourceAgentId, nativeId, targetAgentId, point)
      if (!session) throw new Error('无法创建独立分支，请刷新后重试')
      createdSessionId = session.id
      if (!ownsOperation()) {
        await discardCreatedFork()
        return
      }
      const events = await window.uniagent.getEvents(session.id)
      if (!ownsOperation()) {
        await discardCreatedFork()
        return
      }
      const key = sessionDedupKey(session)
      setSessions((prev) => [session, ...prev.filter((s) => sessionDedupKey(s) !== key)])
      setEventsBySession((prev) => ({ ...prev, [session.id]: events }))
      setActiveId(session.id)
      setPanel(null)
    } catch (error) {
      try {
        await discardCreatedFork()
      } catch {
        // Preserve the original fork/hydration failure if cleanup also fails.
      }
      if (ownsOperation()) setForkError(errorMessage(error))
    } finally {
      if (operation.activeToken === token) {
        operation.activeToken = null
        setForkBusy(null)
      }
    }
  }

  async function handleHistoryPositionFork(): Promise<void> {
    if (!activeSession?.nativeSessionId || !historyForkConfirmation ||
        historyForkConfirmation.kind === 'import' || forkOperationRef.current.activeToken !== null) return
    const action = historyForkConfirmation
    setHistoryForkConfirmation(null)
    if (!action.point || !activeHistoryForkPoints.includes(action.point)) {
      setForkError('所选分叉位置已不可用，请重新选择')
      return
    }
    if (action.kind === 'cross') {
      if (!eligibleCrossForkTargets(activeAgent, agents).some((agent) => agent.id === action.targetAgentId)) {
        setForkError('所选 Agent 当前不可用，请重新选择')
        return
      }
      await handleCrossImport(activeSession.config.agentId, activeSession.nativeSessionId, action.targetAgentId, action.point)
    } else {
      await handleForkSame(
        activeSession.config.agentId,
        activeSession.nativeSessionId,
        activeSession.config.workdir,
        action.point,
        action.compatibilityMode === true
      )
    }
  }

  async function handleLatestSessionFork(): Promise<void> {
    if (!latestSessionFork || latestSessionFork.action.kind === 'import' || forkOperationRef.current.activeToken !== null) return
    const source = sessions.find((session) => session.id === latestSessionFork.sessionId)
    const targetAgentId = latestSessionFork.action.kind === 'cross'
      ? latestSessionFork.action.targetAgentId
      : source?.config.agentId
    if (!source?.nativeSessionId || !targetAgentId ||
        !latestForkTargets.some((agent) => agent.id === targetAgentId)) {
      setLatestSessionFork(null)
      setForkError('当前会话或所选 Agent 已不可用，请刷新后重试')
      return
    }
    setLatestSessionFork(null)
    await handleForkSession(
      source.config.agentId,
      source.nativeSessionId,
      targetAgentId,
      source.config.workdir,
      undefined,
      latestSessionFork.action.kind === 'same' && latestSessionFork.action.compatibilityMode === true
    )
  }

  function forgetSidebarAttention(ids: string[]): void {
    const removed = new Set(ids)
    setUnreadBySession(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))))
    setSavedPendingInteractions(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))))
    for (const id of ids) hydratedSessionsRef.current.delete(id)
    setHydratedSessions(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))))
  }

  // G2-4: archive / unarchive / permanently delete a session.
  async function handleArchive(id: string): Promise<void> {
    const updated = await window.uniagent.archiveSession(id)
    if (updated) {
      forgetSidebarAttention([id])
      archivedEventCaches.current.add(id)
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
      setEventsBySession(prev => { const next = { ...prev }; delete next[id]; return next })
    }
    setActiveId((current) => (current === id ? null : current))
  }
  async function handleUnarchive(id: string): Promise<void> {
    const updated = await window.uniagent.unarchiveSession(id)
    if (updated) {
      archivedEventCaches.current.delete(id)
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
    }
  }

  // 需求4: rename (locks auto-titling) + pin/unpin. Both persist via main and
  // return the updated session so the list reflects it immediately.
  async function handleRename(id: string, title: string): Promise<void> {
    const updated = await window.uniagent.renameSession(id, title)
    if (updated) setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
  }
  async function handlePin(id: string, pinned: boolean): Promise<void> {
    const updated = await window.uniagent.pinSession(id, pinned)
    if (updated) setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
  }
  async function handleDelete(id: string): Promise<void> {
    const team = teamCatalog.projects.find(p => p.memberSessions[p.team.leaderMemberId] === id)
    try {
      await window.uniagent.deleteSession(id)
      const deletedIds = team ? Object.values(team.memberSessions) : [id]
      forgetSidebarAttention(deletedIds)
      for (const deletedId of deletedIds) archivedEventCaches.current.delete(deletedId)
      setEventView(prev => {
        const zcodeCursors = { ...prev.zcodeCursors }
        for (const deletedId of deletedIds) delete zcodeCursors[deletedId]
        return { ...prev, zcodeCursors }
      })
      setSessions((prev) => prev.filter((s) => !deletedIds.includes(s.id)))
      setEventsBySession((prev) => {
        const next = { ...prev }
        for (const deletedId of deletedIds) delete next[deletedId]
        return next
      })
      if (activeId && deletedIds.includes(activeId)) setActiveId(null)
      if (team) refreshTeams()
    } catch (error) {
      if (team) setTeamError(String(error))
      else throw error
    }
  }

  // Opening a session closes any open history/scheduled panel so the session
  // view takes the main area.
  function handleSelect(id: string): void {
    setSessionReturnId(null)
    invalidateForkOperation()
    setPanel(null)
    setQuickCreateSeed(null)
    setReviewOpen(false)
    setReviewScope({ kind: 'workspace' })
    setReviewTurnDiff('')
    setReviewInitialFile(undefined)
    setActiveId(id)
    setSideChatOpen(sideOpenBySessionRef.current[id] ?? false)
    const rowId = teamRowSessionId(teamRowIdsRef.current, id)
    setUnreadBySession((prev) => (prev[rowId] ? { ...prev, [rowId]: undefined } : prev))
  }
  function handleCardSessionJump(id: string): void {
    const sourceId = activeId
    handleSelect(id)
    if (sourceId && sourceId !== id) setSessionReturnId(sourceId)
  }

  // 需求1.3: batch archive / delete over a selection.
  async function handleArchiveMany(ids: string[]): Promise<void> {
    for (const id of ids) await handleArchive(id)
  }
  async function handleDeleteMany(ids: string[]): Promise<void> {
    for (const id of ids) await handleDelete(id)
  }

  const installedAgents = agents.filter((a) => a.lifecycle?.availability === 'available')

  // 需求15: persist sidebar width / collapsed across launches.
  useEffect(() => {
    localStorage.setItem('ua.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])
  // 需求补9 — when a workspace overlay opens, seed its cover state from the
  // persisted `coverSidebar` default (settings switch). Re-read on each open so a
  // changed default takes effect next time, while the header toggle only changes
  // the current open's cover state.
  useEffect(() => {
    if (!reviewOpen && !filesOpen) return
    let cancelled = false
    void window.uniagent.getAppSettings().then((settings) => {
      if (!cancelled) setOverlayCover(!!settings?.coverSidebar)
    })
    return () => {
      cancelled = true
    }
  }, [reviewOpen, filesOpen])
  useEffect(() => {
    localStorage.setItem('ua.sidebarCollapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])
  // 计时胶囊重构 — persist the summary dock's pinned state + width, and grow the
  // window's minimum width while the dock occupies layout space.
  const summaryDockOpen = summaryPinned && !!activeSession
  useEffect(() => {
    localStorage.setItem('ua.summaryPinned', summaryPinned ? '1' : '0')
  }, [summaryPinned])
  useEffect(() => {
    localStorage.setItem('ua.summaryWidth', String(summaryWidth))
  }, [summaryWidth])
  useEffect(() => {
    void window.uniagent.setSummaryDockWidth(summaryDockOpen ? summaryWidth : 0)
  }, [summaryDockOpen, summaryWidth])
  // Drag the dock's left edge to resize (clamped 300–480px), mirroring the
  // sidebar resize pattern.
  const summaryDragRef = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!summaryDragRef.current) return
      setSummaryWidth(Math.min(480, Math.max(300, window.innerWidth - e.clientX)))
    }
    const onUp = (): void => {
      if (summaryDragRef.current) {
        summaryDragRef.current = false
        document.body.classList.remove('resizing-summary')
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 需求15: drag the sidebar's right edge to resize (clamped 200–520px).
  const dragRef = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      setSidebarWidth(Math.min(520, Math.max(200, e.clientX)))
    }
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = false
        document.body.classList.remove('resizing-sidebar')
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const requestDockRef = useRef<HTMLDivElement>(null)
  // 需求12/13: a nav entry opens history / scheduled tasks in the MAIN area and
  // clears the active session so its inline panel takes over the chat area.
  function openPanel(p: 'history' | 'automations' | 'diagnostics' | 'settings' | 'settings-window' | 'capabilities' | 'capability-sync' | 'tokens'): void {
    // 离开设置视图（页内 / 全窗共用同一 SettingsPanel 实例，二者互切不丢状态）时过未保存守卫。
    const leavingSettingsView = (panel === 'settings' || panel === 'settings-window') && p !== 'settings' && p !== 'settings-window'
    if (leavingSettingsView && settingsNavigationGuard.current?.() === false) return
    invalidateForkOperation()
    setPanel(p)
    setQuickCreateSeed(null)
    setActiveId(null)
  }

  // 设置页内模式打开某分类（底部「设置」入口与各类深链），带分类导航。
  function openSettingsCategory(category: SettingsCategory): void {
    if ((panel === 'settings' || panel === 'settings-window') && category !== settingsCategory && settingsNavigationGuard.current?.() === false) return
    setSettingsCategory(category)
    setSettingsTeamId(undefined)
    setSettingsNavigationKey(key => key + 1)
    openPanel('settings')
  }

  // 全窗模式打开某分类（左侧侧栏快捷入口）：自带页面面板的分类直接开全窗面板，
  // 其余分类开无分类导航的设置内容页，铺满右侧主区域。
  function openSettingsWindowCategory(category: SettingsCategory): void {
    if (isSettingsPagePanel(category)) { openPanel(category); return }
    if ((panel === 'settings' || panel === 'settings-window') && category !== settingsCategory && settingsNavigationGuard.current?.() === false) return
    setSettingsCategory(category)
    setSettingsTeamId(undefined)
    setSettingsNavigationKey(key => key + 1)
    openPanel('settings-window')
  }

  function isSidebarShortcutActive(id: SettingsCategory): boolean {
    return isSettingsPagePanel(id) ? panel === id : panel === 'settings-window' && settingsCategory === id
  }

  // 工具能力同步详情页的返回目标：从哪打开就回到哪（设置页内 / 全窗 / 工具能力全窗面板）。
  const capabilitySyncReturn = useRef<'settings' | 'settings-window' | 'capabilities'>('capabilities')
  function openCapabilitySync(request: CapabilityInventorySyncRequest): void {
    capabilitySyncReturn.current = panel === 'settings' || panel === 'settings-window' ? panel : 'capabilities'
    setCapabilitySyncRequest({ ...request, selections: [...request.selections] })
    openPanel('capability-sync')
  }

  // 计时胶囊重构 — one summary card renderer shared by the timer capsule's hover
  // popover (unpinned) and the pinned right-hand dock.
  const summaryCard = (pinned: boolean): JSX.Element | null =>
    activeSession ? (
      <SummaryPanel
        pinned={pinned}
        session={activeSession}
        events={activeEvents}
        changeSet={reviewChangeSet}
        subagents={activeAgent?.capabilities.structuredSubagents === true ? activeSubAgents : []}
        onOpenSubAgent={handleOpenSubAgentList}
        onOpenReview={() => {
          setSummaryDismissed(true)
          setFilesOpen(false)
          setReviewScope({ kind: 'workspace' })
          setReviewTurnDiff('')
          setReviewInitialFile(undefined)
          setReviewOpen(true)
        }}
        onOpenRequirement={handleOpenRequirement}
        requirementsEnabled={requirementsEnabled}
        onOpenTeam={teamId => { setSummaryDismissed(true); setSettingsCategory('teams'); setSettingsTeamId(teamId); openPanel('settings') }}
        onTogglePin={() => setSummaryPinned((v) => !v)}
        onClose={() => (pinned ? setSummaryPinned(false) : setSummaryDismissed(true))}
      />
    ) : null

  const settingsCover = panel === 'settings'
  const sidebarHidden = sidebarCollapsed || settingsCover

  return (
    <div ref={(element) => { if (element) element.inert = startupBlocking }} className={`app ${sidebarHidden ? 'sidebar-collapsed' : ''} ${settingsCover ? 'settings-cover' : ''} ${overlayCover && (reviewOpen || filesOpen) ? 'overlay-cover' : ''}`}>
      {sidebarCollapsed && !settingsCover && (
        <button
          className="sidebar-reveal"
          onClick={() => setSidebarCollapsed(false)}
          title="展开侧栏"
        >
          <SidebarIcon filled />
        </button>
      )}
      <aside
        ref={(element) => { if (element) element.inert = sidebarHidden }}
        className={`sidebar ${sidebarHidden ? 'is-collapsed' : ''}`}
        style={{
          width: sidebarHidden ? 0 : sidebarWidth,
          minWidth: sidebarHidden ? 0 : sidebarWidth,
          overflow: sidebarHidden ? 'hidden' : undefined,
          pointerEvents: sidebarHidden ? 'none' : undefined
        }}
        aria-hidden={sidebarHidden}
      >
          <div className="drag-region" />
          <div className="sidebar-header">
            <div className="logo">
              <img className="logo-icon" src="./app-icon.svg" width={18} height={18} alt="" draggable={false} />
              {APP_NAME}
            </div>
            <div className="header-actions">
              <button
                className="btn-ghost"
                onClick={() => setSidebarCollapsed(true)}
                title="收起侧栏"
              >
                <SidebarIcon />
              </button>
              <button
                className="btn-new"
                onClick={() => openNewTask()}
                title="新建任务 (⌘N)"
                aria-label="新建任务"
              >
                <UiIcon name="plus" size={17} />
              </button>
            </div>
          </div>
          {sidebarShortcuts.length > 0 && <div className="sidebar-nav">
            {SETTINGS_CATEGORIES.filter(item => sidebarShortcuts.includes(item.id)).map(item => (
              <button
                key={item.id}
                className={`sidebar-nav-item ${isSidebarShortcutActive(item.id) ? 'active' : ''}`}
                onClick={() => openSettingsWindowCategory(item.id)}
              >
                <span className="nav-ic"><UiIcon name={item.icon} /></span> {item.label}
              </button>
            ))}
          </div>}
          <SessionList
            assistantPrivateSessionIds={assistantPrivateSessionIds}
            sessions={sidebarSessions}
            teamProjects={teamCatalog.projects}
            agents={agents}
            activeId={activeTeam ? activeTeam.memberSessions[activeTeam.team.leaderMemberId] : activeId}
            statusBySession={activityBySession}
            pendingInteractionBySession={pendingInteractionBySession}
            unreadBySession={unreadBySession}
            onSelect={handleSelect}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onDelete={handleDelete}
            onArchiveMany={handleArchiveMany}
            onDeleteMany={handleDeleteMany}
            onRename={handleRename}
            onPin={handlePin}
            onQuickCreate={openNewTask}
            onOpenRequirement={handleOpenRequirement}
            requirementsEnabled={requirementsEnabled}
          />
          {/* 需求6: 侧栏底部只留「设置」入口 —「CLI 状态」已迁入设置页。 */}
          <div className="sidebar-footer">
            <button
              className={`settings-entry ${panel === 'settings' ? 'active' : ''}`}
              onClick={() => openSettingsCategory('general')}
              title="设置"
            >
              <span className="nav-ic"><UiIcon name="settings" /></span> 设置
            </button>
            <QuotaHoverButton agents={agents} enabledAgentIds={enabledAgentIds} zcodeProviderId={activeSession?.config.agentId === 'zcode' ? activeSession.config.zcodeModelSelection?.providerId : undefined} />
          </div>
          <div
            className="sidebar-resizer"
            title="拖动调整宽度"
            onMouseDown={() => {
              dragRef.current = true
              document.body.classList.add('resizing-sidebar')
            }}
          />
      </aside>

      <main className={`main${sideChatOpen && activeSession && activeAgent?.capabilities.sideChat === true && !panel ? ' side-chat-open' : ''}${summaryDockOpen ? ' summary-dock-open' : ''}`}>
        {(teamError || teamCatalog.errors.length > 0) && <div className="team-error" role="alert">{teamError || teamCatalog.errors.join('；')}</div>}
        <div style={{ display: !panel && !activeSession && !activeTeam ? 'contents' : 'none' }}>
          <NewTaskPanel teams={teamCatalog.teams} teamUnavailableReasons={teamCatalog.unavailableReasons} onCreateTeam={handleCreateTeam} onManageTeams={() => { setSettingsCategory('teams'); setSettingsTeamId(undefined); openPanel('settings') }} key={newTaskKey} agents={agents} enabledAgentIds={enabledAgentIds} loading={agentsLoading || agentsRedetecting || agentChoiceSettingsLoading || sessionsLoading} loadError={sessionsLoadError} onCreate={handleCreate} onCreateNativeAction={handleCreateNativeAction} onCommitCreatedSession={handleCommitCreatedSession} promptPrefill={newTaskPrefill} onOpenAssistantSettings={() => { setSettingsCategory('assistants'); openPanel('settings') }} onOpenSettings={() => openPanel('settings')} onRedetect={redetectAgents} quickCreateSeed={quickCreateSeed} requirementsEnabled={requirementsEnabled} />
        </div>
        {panel === 'history' ? (
          <ResumePanel
            agents={installedAgents}
            e2eFixtures={e2eFixtures}
            onForkSame={handleForkSame}
            onImport={handleImport}
            onForkCross={handleCrossImport}
          />
        ) : panel === 'automations' ? (
          <AutomationsPanel onOpenSession={handleSelect} />
        ) : panel === 'diagnostics' ? (
          <DiagnosticsPanel />
        ) : panel === 'capabilities' ? (
          <AgentCapabilitiesPanel agents={agents.filter(agent => agent.builtin)} onOpenSync={openCapabilitySync} />
        ) : panel === 'tokens' ? (
          <TokenUsagePanel />
        ) : panel === 'capability-sync' ? (
          <CapabilitySyncPanel initialRequest={capabilitySyncRequest} onBack={() => { setCapabilitySyncRequest(null); openPanel(capabilitySyncReturn.current) }} />
        ) : panel === 'settings' || panel === 'settings-window' ? (
          <SettingsPanel windowed={panel === 'settings-window'} initialCategory={settingsCategory} initialTeamId={settingsTeamId}
            navigationKey={settingsNavigationKey}
            navigationGuard={settingsNavigationGuard}
            onCategoryChange={category => { setSettingsCategory(category); setSettingsTeamId(undefined) }}
            onSidebarShortcutsChange={setSidebarShortcuts}
            onRequirementsEnabledChange={setRequirementsEnabled}
            onOpenSession={handleSelect}
            agents={agents}
            detecting={agentsRedetecting}
            onRedetect={redetectAgents}
            onInitialize={beginInitialization}
            onAgentsChanged={setAgents}
            onAgentEnabledChange={setEnabledAgentIds}
            onOpenSync={openCapabilitySync}
            onBack={() => openNewTask()}
            e2eFixtures={e2eFixtures}
            onForkSame={handleForkSame}
            onImport={handleImport}
            onForkCross={handleCrossImport}
          />
        ) : activeTeam && activeMember && activeId ? (
          <MemberSession key={activeId} sessionId={activeId} p={activeTeam} agents={agents} sessions={runtimeSessions} events={eventsBySession[activeId] || []} loading={!eventsBySession[activeId]} onBack={() => handleSelect(activeTeam.memberSessions[activeTeam.team.leaderMemberId])} onForkLatest={sessionId => setLatestSessionFork({ sessionId, action: { kind: 'same' } })} />
        ) : activeSession ? (
          <TeamSessionProvider key={activeSession.id} project={activeTeam} sessions={runtimeSessions} agents={agents} onOpenMember={handleSelect}>
          <div className="session-view">
            <SessionHeader
              session={activeSession}
              agents={agents}
              onReturn={sessionReturnId && sessions.some((session) => session.id === sessionReturnId)
                ? () => handleSelect(sessionReturnId)
                : undefined}
              onOpenSide={activeToolSession || activeAgent?.capabilities.sideChat !== true ? undefined : () => { setOpenSubAgent(null); setSideChatOpen(true) }}
              onOpenFiles={() => { setReviewOpen(false); setFilesOpen(true) }}
              onForkLatest={currentSessionForkTargets(activeAgent, agents).length
                ? () => setLatestSessionFork({ sessionId: activeSession.id, action: { kind: 'same' } })
                : undefined}
              forkLatestDisabled={!activeSession.nativeSessionId || isSessionBusy(activeStatus) || sessionHydrating || !!forkBusy}
              onRefreshNativeSession={handleRefreshNativeSession}
              refreshingNativeSession={refreshingNativeSessionId === activeSession.id}
              nativeRefreshDisabled={isSessionBusy(activeStatus) || sessionHydrating || rewind?.phase === 'executing'}
            />
            {activeAgent?.capabilities.nativeGoal === true && activeSession.goal && (
              <div className="goal-status-shell">
                <GoalStatusBar
                  key={activeSession.id}
                  goal={activeSession.goal}
                  provider={activeAgent.adapter}
                  running={isSessionBusy(activeStatus)}
                  onRunNativeAction={handleRunNativeAction}
                />
              </div>
            )}
            <SessionConversation loading={sessionHydrating}
                workspaceNotice={activeSession.config.workspaceNotice}
                afterConversation={<WorktreeCreation key={activeSession.id} session={activeSession} />}
                onRequestEarlier={activeAgent?.adapter === 'zcode' && !isSessionBusy(activeStatus) &&
                  activeEvents.some(event => event.payload.zcodeProjection && event.payload.nativeHasEarlier) ? async () => {
                    const sessionId = activeSession.id
                    try {
                      await window.uniagent.loadZCodeEarlier(sessionId)
                      if (!sessionsRef.current.some(session => session.id === sessionId)) return
                      setEventsBySession(prev => ({ ...prev, [sessionId]: (prev[sessionId] || []).filter(event => event.payload.id !== 'zcode-history-error') }))
                    }
                    catch (error) {
                      if (!sessionsRef.current.some(session => session.id === sessionId)) return
                      setEventsBySession(prev => ({ ...prev, [sessionId]: mergeZCodeEvent(prev[sessionId] || [], {
                        sessionId, seq: Number.MAX_SAFE_INTEGER, ts: Date.now(), type: 'system_notice',
                        payload: { id: 'zcode-history-error', kind: 'warning', text: `历史加载失败：${error instanceof Error ? error.message : String(error)}` }
                      }) }))
                      throw error
                    }
                  } : undefined}
                events={conversationEvents}
                status={activeStatus}
                sessionId={activeSession.id}
                requestDockRef={activeToolSession ? undefined : requestDockRef}
                readOnly={activeSession.readOnly}
                onRespond={activeToolSession ? undefined : handleRespond}
                subagents={activeAgent?.capabilities.structuredSubagents === true ? activeSubAgents : undefined}
                onOpenSubAgent={activeAgent?.capabilities.structuredSubagents === true ? handleOpenSubAgent : undefined}
                waitingForHandoff={activeSession.waitingForHandoff}
                handoffSessionTargets={handoffSessionTargets}
                onJumpToSession={handleCardSessionJump}
                scrollToBottomSignal={scrollToBottomSignal}
                onOpenTurnReview={handleOpenTurnReview}
                onRewindToTurn={activeToolSession ? undefined : handleRewindToTurn}
                onOpenFile={handleOpenFile}
                onOpenReader={handleOpenReader}
                historyFork={!activeToolSession && activeSession.nativeSessionId ? {
                  agentName: activeAgent?.name || activeSession.config.agentId,
                  points: activeHistoryForkPoints,
                  busy: !!forkBusy,
                  onFork: (point) => setHistoryForkConfirmation({ kind: 'same', point }),
                } : undefined}
                onImplementPlan={activeSession.readOnly || activeToolSession ? undefined : handleImplementPlan}
                onRevisePlan={activeSession.readOnly || activeToolSession ? undefined : handleRevisePlan}
                selection={
                  !activeToolSession && activeAgent
                    ? {
                        annotations: comments?.annotations(annotationsBySession[activeSession.id] || [], activeSession.id) || [],
                        onSideComment: (selection) => { setSideChatOpen(false); void comments?.begin({ ...selection,
                          sourceText: activeEvents.find(event => event.seq === selection.seq)?.payload.text }) },
                        onComment: (a) => handleAddAnnotation(activeSession.id, a),
                        editRequest: annotationEditRequest?.sessionId === activeSession.id && !annotationEditRequest.annotation.filePath
                          ? annotationEditRequest
                          : undefined,
                        onEditComment: (id) => id.startsWith(COMMENT_ANNOTATION_PREFIX) ? comments?.select(id.slice(COMMENT_ANNOTATION_PREFIX.length)) : handleEditAnnotation(activeSession.id, id),
                        onUpdateComment: (id, comment) => handleUpdateAnnotation(activeSession.id, id, comment),
                        onRemoveComment: (id) => handleRemoveAnnotation(activeSession.id, id),
                        onEditRequestHandled: (nonce) => {
                          setAnnotationEditRequest((current) => current?.nonce === nonce ? null : current)
                        },
                        ...((activeAgent.adapter === 'codex' || activeAgent.adapter === 'traex')
                          ? { onDetail: handleSelectionDetail, onSide: handleSelectionSide }
                          : {})
                      }
                    : undefined
                }
              />
            {readerEvent && (
              <ImmersiveReader
                key={readerEvent.sessionId + ':' + readerEvent.seq}
                event={readerEvent}
                readOnly={activeToolSession}
                sessionTitle={activeSession.title}
                agentName={activeAgent?.name || activeSession.config.agentId}
                annotations={annotationsBySession[activeSession.id] || []}
                onAddComment={(annotation) => handleAddAnnotation(activeSession.id, annotation)}
                onUpdateComment={(id, comment) => handleUpdateAnnotation(activeSession.id, id, comment)}
                onRemoveComment={(id) => handleRemoveAnnotation(activeSession.id, id)}
                onOpenFile={(path, line) => {
                  setReaderEventSeq(null)
                  handleOpenFile(path, line)
                }}
                onClose={() => setReaderEventSeq(null)}
              />
            )}
            {reviewOpen &&
              (reviewScope.kind === 'turn'
                ? !!reviewScope.turnId
                : !!reviewChangeSet?.isGitRepo || !!reviewChangeSet?.items.length || !!latestDiff) && (
                <ReviewPanel
                  key={activeSession.id}
                  diff={reviewScope.kind === 'turn' ? reviewTurnDiff || (reviewScope.turnId === previousTurnId ? previousTurn?.diff || '' : '') : latestDiff}
                  sessionId={activeSession.id}
                  scope={reviewScope}
                  previousTurnId={previousTurnId}
                  repositoryChangeSet={reviewChangeSet}
                  onScopeChange={(nextScope) => {
                    setReviewScope(nextScope)
                    if (nextScope.kind === 'turn') {
                      setReviewTurnDiff(nextScope.turnId === previousTurnId ? previousTurn?.diff || '' : '')
                      setReviewInitialFile(undefined)
                    } else {
                      setReviewTurnDiff('')
                      setReviewInitialFile(undefined)
                    }
                  }}
                  initialFile={reviewScope.kind === 'turn' ? reviewInitialFile : undefined}
                  initialChangeSet={reviewScope.kind === 'workspace' ? reviewChangeSet : null}
                  onChangeSet={reviewScope.kind === 'workspace' ? setReviewChangeSet : undefined}
                  coverSidebar={overlayCover}
                  onToggleCover={() => setOverlayCover((v) => !v)}
                  onClose={() => setReviewOpen(false)}
                />
              )}
            {e2eFixtures && <Req2E2EModelPickerFixture />}
            {/* 需求4(反馈) — 任务列表胶囊固定在输入框上方，而非对话流中间。
                计时胶囊重构 — 常驻胶囊：运行中计时、结束后定格上一轮耗时，边框色
                表达状态；悬停弹出摘要悬浮窗（固定后由右侧面板承接）。 */}
            <TurnStatusBar
              events={conversationEvents}
              status={activeStatus}
              summary={summaryPinned ? undefined : summaryCard(false) ?? undefined}
              summaryOpen={summaryHover && !summaryDismissed && !summaryPinned}
              onTimerHoverChange={(hovering) => {
                setSummaryHover(hovering)
                if (!hovering) setSummaryDismissed(false)
              }}
            />
            <div className="interaction-dock-slot" ref={requestDockRef} />
            {activeSession.readOnly && !activeToolSession ? (
              <ForkBar
                session={activeSession}
                agents={installedAgents}
                onForkSame={() =>
                  handleForkSame(
                    activeSession.config.agentId,
                    activeSession.nativeSessionId || '',
                    activeSession.config.workdir
                  )
                }
                onImport={() =>
                  handleImport(
                    activeSession.config.agentId,
                    activeSession.nativeSessionId || '',
                    activeSession.config.workdir,
                    activeSession.title
                  )
                }
                onForkCross={(target) =>
                  handleCrossImport(
                    activeSession.config.agentId,
                    activeSession.nativeSessionId || '',
                    target
                  )
                }
              />
            ) : (
              <Composer
                key={`composer:${activeSession.id}`}
                sessionId={activeSession.id}
                status={activeStatus}
                runtimeStatus={activeRuntimeStatus}
                agent={activeAgent}
                config={activeSession.config}
                onSend={handleSend}
                onForceSend={handleForceSend}
                onInterrupt={handleInterrupt}
                interruptsTeam={!!activeTeam}
                allowRoleConfig={!!activeTeam}
                onUpdateConfig={handleUpdateConfig}
                onSetCollaborationMode={handleSetCollaborationMode}
                onRunNativeAction={handleRunNativeAction}
                queue={activeQueue}
                onDequeue={handleDequeue}
                onPromoteQueue={handlePromoteQueue}
                onEditQueueItem={handleEditQueueItem}
                onQueueEditingChange={(itemId) => {
                  if (activeId) void window.uniagent.setQueueEditing(activeId, itemId)
                }}
                capabilities={activeNativeCapabilities}
                capabilitiesReady={activeNativeCapabilitiesReady}
                draftSeed={composerDraftSeed}
                onConsumeDraftSeed={(seed) => {
                  setComposerDraftSeed((current) => current === seed ? null : current)
                }}
                contextUsed={contextInfo.used}
                contextWindow={contextWindow}
                prefill={composerPrefill}
                pendingComments={annotationsBySession[activeSession.id] || []}
                onEditPendingComment={(id) => handleEditAnnotation(activeSession.id, id)}
                onRemovePendingComment={(id) => handleRemoveAnnotation(activeSession.id, id)}
                onCompact={handleCompactSession}
                canCompact={compactAvailability.canCompact}
                compacting={compactAvailability.compacting}
                providerSwitchCompacting={compactAvailability.providerSwitchCompacting}
                preparingModel={!!modelPreparingBySession[activeSession.id]}
                disabledReason={compactAvailability.disabledReason}
                disabled={!activeAgent?.installed || !!activeAgent.incompatible || worktreeInputBlocked}
                inputPlaceholder={worktreeInputBlocked ? '工作树就绪后可继续输入' : undefined}
                sessionExternallyOccupied={activeSessionExternallyOccupied}
                toolSessionReadOnly={activeToolSession}
                onEnableToolSession={handleEnableToolSession}
                refreshingNativeSession={refreshingNativeSessionId === activeSession.id}
                onRefreshNativeSession={handleRefreshNativeSession}
              />
            )}
            {activeAgent?.capabilities.structuredSubagents === true && (
              <SubAgentPanel
                key={`subagent:${activeSession.id}`}
                open={!!openSubAgent}
                sessionId={activeSession.id}
                subagents={activeSubAgents}
                canCancel={(activeAgent?.adapter === 'grok' || activeAgent?.adapter === 'deepseek' || activeAgent?.adapter === 'kimi' || activeAgent?.adapter === 'mcode') && !activeToolSession && !activeSession.teamBinding && !activeSession.readOnly && !activeSession.archived && (activeSession.status === 'running' || activeSession.status === 'awaiting-approval')}
                activeThreadId={openSubAgent || ''}
                initialView={subPanelView}
                onSelect={setOpenSubAgent}
                onClose={() => setOpenSubAgent(null)}
              />
            )}
          </div>
          {summaryDockOpen && (
            <aside className="summary-dock" style={{ width: summaryWidth }} aria-label="会话摘要">
              <div
                className="summary-dock-grip"
                onMouseDown={(e) => {
                  e.preventDefault()
                  summaryDragRef.current = true
                  document.body.classList.add('resizing-summary')
                }}
                title="拖拽调整宽度"
              />
              {summaryCard(true)}
            </aside>
          )}
          </TeamSessionProvider>
        ) : null}
        {filesOpen && (
          <FileBrowser
            key={`files:${activeSession?.id || fileFocus?.root}`}
            sessionId={activeSession?.id || ''}
            workdir={activeSession?.config.workdir || fileFocus?.root || ''}
            rootPath={fileFocus?.root}
            focusPath={fileFocus?.path}
            focusLine={fileFocus?.line}
            annotations={activeSession ? annotationsBySession[activeSession.id] || [] : []}
            onAddComment={activeSession && !activeToolSession && !activeSession.readOnly && !activeSession.archived
              ? (annotation) => handleAddAnnotation(activeSession.id, annotation) : undefined}
            onUpdateComment={(id, comment) => activeSession && handleUpdateAnnotation(activeSession.id, id, comment)}
            onRemoveComment={(id) => activeSession && handleRemoveAnnotation(activeSession.id, id)}
            editRequest={annotationEditRequest?.annotation.filePath && annotationEditRequest.sessionId === activeSession?.id
              ? annotationEditRequest : undefined}
            onEditRequestHandled={(nonce) => {
              setAnnotationEditRequest((current) => current?.nonce === nonce ? null : current)
            }}
            onOpenFile={handleOpenFile}
            coverSidebar={overlayCover}
            onToggleCover={() => setOverlayCover((v) => !v)}
            onClose={() => {
              setFilesOpen(false)
              setFileFocus(null)
            }}
          />
        )}
        {activeSession && !activeToolSession && activeAgent?.capabilities.sideChat === true && (
          <SideChatPanel
            key={`side:${activeSession.id}`}
            open={sideChatOpen && !panel}
            sessionId={activeSession.id}
            agent={activeAgent}
            onClose={() => setSideChatOpen(false)}
            onPromote={handleSidePromoted}
            pendingComments={annotationsBySession[`side:${activeSession.id}`] || []}
            onRemovePendingComment={(id) => handleRemoveAnnotation(`side:${activeSession.id}`, id)}
            onClearComments={() => clearAnnotations(`side:${activeSession.id}`)}
          />
        )}
        {activeSession && !activeToolSession && !panel && !filesOpen && !readerEvent && <CommentPanel pending={annotationsBySession[activeSession.id] || []} />}
      </main>
      {commentNotice && <div className="lifecycle-progress-toast" role="status">{commentNotice}<button onClick={() => setCommentNotice('')}>关闭</button></div>}
      {!startupBlocking && startupProgress?.phase === 'failed' && (
        <div
          className={`lifecycle-progress-toast ${startupProgress?.phase === 'failed' ? 'is-error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {startupProgress?.message || '正在初始化 Agent…'}
          {startupProgress?.phase === 'failed' && <button onClick={() => setStartupProgress(null)}>跳过本次进入</button>}
        </div>
      )}
      {rewindWarning && (
        <div className="lifecycle-progress-toast rewind-warning-toast" role="status" aria-live="polite">
          <span>{rewindWarning}</span>
          <button onClick={() => setRewindWarning(null)}>知道了</button>
        </div>
      )}
      {latestSessionFork && latestForkSource && !panel && (
        <HistoryConfirmation
          action={latestSessionFork.action}
          agentName={latestForkSourceAgent?.name || latestForkSource.config.agentId}
          title={latestForkSource.title}
          sourceAgentId={latestForkSource.config.agentId}
          targetAgents={latestForkTargets}
          chooseTarget
          onChangeAction={(action) => setLatestSessionFork((current) => current ? { ...current, action } : null)}
          onCancel={() => setLatestSessionFork(null)}
          onConfirm={() => { void handleLatestSessionFork() }}
        />
      )}
      {/* Message forks share the history confirmation and loading flow. */}
      {historyForkConfirmation && activeSession && !panel && (
        <HistoryConfirmation
          action={historyForkConfirmation}
          agentName={activeAgent?.name || activeSession.config.agentId}
          title={activeSession.title}
          sourceAgentId={activeSession.config.agentId}
          targetAgents={[
            ...(activeAgent && supportsSessionCapability(activeAgent, 'sessionFork') ? [activeAgent] : []),
            ...eligibleCrossForkTargets(activeAgent, agents)
          ]}
          selectedEvent={historyForkConfirmation.kind !== 'import'
            ? activeEvents.find((event) => event.seq === historyForkConfirmation.point?.eventSeq)
            : undefined}
          onChangeAction={setHistoryForkConfirmation}
          onCancel={() => setHistoryForkConfirmation(null)}
          onConfirm={() => { void handleHistoryPositionFork() }}
        />
      )}
      {forkBusy && (
        <dialog
          ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }}
          className="modal-overlay history-confirm-overlay"
          aria-labelledby="fork-loading-title"
          onCancel={(event) => { event.preventDefault(); invalidateForkOperation() }}
        >
          <div className="loading-modal" role="status" aria-live="polite" aria-busy="true">
            <div className="loading-spinner" aria-hidden="true" />
            <div className="loading-modal-title" id="fork-loading-title">正在分叉到 {forkBusy}…</div>
            <div className="loading-modal-note">正在创建新会话，完成后自动打开。</div>
            <button className="loading-modal-cancel" autoFocus onClick={invalidateForkOperation}>取消</button>
          </div>
        </dialog>
      )}
      {forkError && !forkBusy && (
        <div className="modal-overlay" role="alertdialog" aria-modal="true">
          <div className="loading-modal">
            <div className="loading-modal-title">创建分支失败</div>
            <div className="loading-modal-note">{forkError}</div>
            <button className="loading-modal-cancel" onClick={() => setForkError('')}>
              关闭
            </button>
          </div>
        </div>
      )}
      {/* 需求三（会话节点回退）— preflight loading / confirm / executing / error. One
          overlay drives the whole "先检查、再变更、后回填" flow; the timeline is only
          truncated inside handleRewindConfirm's success path. */}
      {rewind && rewind.sessionId === activeId && (
        <div className="modal-overlay" role="alertdialog" aria-modal="true">
          <div className="loading-modal rewind-modal">
            {rewind.phase === 'preview' || rewind.phase === 'executing' ? (
              <>
                <div className="loading-spinner" />
                <div className="loading-modal-title">
                  {rewind.phase === 'preview' ? '正在检查是否可回退…' : '正在回退会话与文件…'}
                </div>
                <div className="loading-modal-note">
                  {rewind.phase === 'preview'
                    ? '核对本轮之后的文件改动与会话状态，暂不改动界面。'
                    : '反向恢复文件并切换原生历史，完成后再更新界面。'}
                </div>
              </>
            ) : rewind.phase === 'confirm' ? (
              <>
                <div className="loading-modal-title">回退到本轮对话发起前</div>
                <div className="rewind-summary">
                  {rewind.preview.keepThroughTurn !== undefined && (
                    <div>
                      {rewind.preview.keepThroughTurn > 0
                        ? `保留第 1–${rewind.preview.keepThroughTurn} 轮`
                        : '不保留更早轮次'}
                    </div>
                  )}
                  {rewind.preview.removeFromTurn !== undefined &&
                    rewind.preview.removeThroughTurn !== undefined && (
                      <div>
                        移除第 {rewind.preview.removeFromTurn}–{rewind.preview.removeThroughTurn} 轮
                      </div>
                    )}
                  <div>
                    回滚 {rewind.preview.files.length} 个文件的改动
                    {rewind.preview.files.length > 0 && (
                      <span className="rewind-files">
                        {rewind.preview.files.slice(0, 6).map((f) => (
                          <span key={f.path} className="rewind-file" title={f.path}>
                            {f.path}
                          </span>
                        ))}
                        {rewind.preview.files.length > 6 && (
                          <span className="rewind-file">
                            +{rewind.preview.files.length - 6} 个
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <div className="rewind-actions">
                  <button className="loading-modal-cancel" onClick={() => setRewind(null)}>
                    取消
                  </button>
                  <button className="rewind-confirm" onClick={handleRewindConfirm}>
                    检查并回退
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="loading-modal-title">回退未执行</div>
                <div className="loading-modal-note">{rewind.message}</div>
                <button className="loading-modal-cancel" onClick={() => setRewind(null)}>
                  关闭
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '请稍后重试。'
}

function Req2E2EModelPickerFixture(): JSX.Element {
  const [value, setValue] = useState('fixture-a')
  return (
    <div className="req2-model-picker-fixture" aria-hidden>
      <ModelPicker
        models={[
          { id: 'fixture-a', label: 'Fixture A', efforts: [] },
          { id: 'fixture-b', label: 'Fixture B', efforts: [] }
        ]}
        value={value}
        onChange={setValue}
      />
    </div>
  )
}

/** Merge startup state under live pushes so a late snapshot cannot resurrect stale work. */
export function mergeQueueSnapshots(
  snapshot: Record<string, QueueItem[]>,
  live: Record<string, QueueItem[]>
): Record<string, QueueItem[]> {
  return { ...snapshot, ...live }
}

export function eligibleCrossForkTargets(
  source: AgentDef | undefined,
  agents: AgentDef[]
): AgentDef[] {
  if (!isCrossForkSourceAgent(source) || !supportsSessionCapability(source, 'sessionLoad')) return []
  return agents.filter(
    (agent) =>
      agent.id !== source?.id &&
      isCrossForkTargetAgent(agent) &&
      supportsSessionCapability(agent, 'sessionLoad') &&
      supportsSessionCapability(agent, 'sessionResume')
  )
}

/**
 * Derive context-load + this-turn usage from the latest usage snapshot (Doc5
 * T1). The occupancy figure (`used`) is the context the model must carry — the
 * LAST call's input (`contextTokens`), which is bounded — NOT the per-turn input
 * sum. `turn` carries the per-turn breakdown + cost for the popover.
 */
export function computeContext(events: UAEvent[]): {
  used: number
  window?: number
  detail: { input?: number; output?: number; cached?: number; cost?: number | null }
} {
  // Replaced snapshots retain their display position, not their chronological position.
  const latestNotice = (kind: 'context' | 'usage'): UAEvent | undefined =>
    events.reduce<UAEvent | undefined>((found, event) =>
      event.type === 'system_notice' && event.payload?.kind === kind && event.payload.usage &&
      (!found || event.seq > found.seq) ? event : found, undefined)
  const contextEvent = latestNotice('context')
  const usageEvent = latestNotice('usage')
  const contextUsed = contextEvent ? boundedTokens(contextEvent.payload.usage.contextTokens) : undefined
  const usageUsed = usageEvent ? boundedTokens(usageEvent.payload.usage.contextTokens) : undefined
  // 需求(实时上下文): a live `context` tick updates only the occupancy figure.
  // It stays authoritative over a newer usage footer that carries no bounded
  // figure, so an asynchronous cumulative footer can never hide it.
  if (contextEvent && contextUsed !== undefined &&
      (!usageEvent || usageUsed === undefined || usageEvent.seq < contextEvent.seq)) {
    return { used: contextUsed, window: contextEvent.payload.usage.contextWindow, detail: {} }
  }
  if (usageEvent) {
    const u = usageEvent.payload.usage
    const input = u.inputTokens ?? u.input_tokens ?? 0
    const output = u.outputTokens ?? u.output_tokens ?? 0
    const cached = u.cachedInputTokens ?? u.cached_input_tokens ?? 0
    const cost = u.cost ?? usageEvent.payload.cost ?? null
    // Occupancy: how full the window is right now = the last call's input.
    // Never fall back to an input/output sum: for providers whose footer is
    // cumulative across model calls (Grok reports 2.4M billed tokens for a
    // 256k window), that number is unbounded and reads as a permanent 100%.
    return { used: usageUsed ?? 0, window: u.contextWindow, detail: { input, output, cached, cost } }
  }
  if (contextEvent && contextUsed !== undefined) {
    return { used: contextUsed, window: contextEvent.payload.usage.contextWindow, detail: {} }
  }
  return { used: 0, detail: {} }
}

/** Context occupancy must be a finite, non-negative token count. */
function boundedTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function SessionHeader({
  session,
  agents,
  onReturn,
  onOpenSide,
  onOpenFiles,
  onForkLatest,
  forkLatestDisabled,
  onRefreshNativeSession,
  refreshingNativeSession,
  nativeRefreshDisabled
}: {
  session: Session
  agents: AgentDef[]
  onReturn?: () => void
  onOpenSide?: () => void
  onOpenFiles?: () => void
  onForkLatest?: () => void
  forkLatestDisabled?: boolean
  onRefreshNativeSession?: () => void | Promise<void>
  refreshingNativeSession?: boolean
  nativeRefreshDisabled?: boolean
}): JSX.Element {
  const baseAgent = agents.find((a) => a.id === session.config.agentId)
  const agent = baseAgent ? agentForSession(baseAgent, session) : undefined
  const sideCapable = agent?.capabilities.sideChat === true
  // 改动2 — the top status bar is just a TITLE (会话名 + 工作目录) plus action
  // toggles. 计时胶囊重构 removed the 摘要 toggle: the summary card now opens from
  // the timer capsule (hover popover / pinned dock). Branch/changes live in the
  // summary card's 环境信息; the permission tier stays in the composer bottom.
  return (
    <div className="session-header">
      {onReturn && (
        <button type="button" className="session-return-btn" onClick={onReturn} title="返回点击前的 Session" aria-label="返回点击前的 Session">
          <UiIcon name="back" size={18} />
        </button>
      )}
      {session.config.workdir && onOpenFiles && (
        <button
          type="button"
          className="topbar-files-btn"
          onClick={onOpenFiles}
          title="文件查看器"
          aria-label="打开文件查看器"
        >
          <FolderIcon />
        </button>
      )}
      <span className="topbar-title" title={`${session.title || '未命名会话'} · ${session.config.workdir}`}>
        <span className="topbar-title-main">{session.title || '未命名会话'}</span>
        <span className="topbar-title-sub topbar-title-path">
          <span> · </span>
          <span className="topbar-title-path-value">{session.config.workdir}</span>
        </span>
      </span>
      {session.config.worktree && <span className="session-worktree-badge" title={`工作树 · ${session.config.worktree.workdir}`}><UiIcon name="fork" size={11} />工作树</span>}
      <span className="topbar-spacer" />
      {session.config.agentId === 'codex' && session.importMode === 'direct' && session.nativeSessionId && onRefreshNativeSession && (
        <button
          type="button"
          className="summary-toggle session-refresh-toggle"
          onClick={() => void onRefreshNativeSession()}
          disabled={refreshingNativeSession || nativeRefreshDisabled}
          aria-label="刷新原生会话"
          aria-busy={!!refreshingNativeSession}
          title={refreshingNativeSession ? '正在刷新原生会话' : nativeRefreshDisabled ? '正在处理会话，请稍后刷新' : '刷新原生会话'}
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="refresh" size={14} />
          </span>
          刷新
        </button>
      )}
      {onForkLatest && (
        <button
          type="button"
          className="summary-toggle session-refresh-toggle session-fork-toggle"
          onClick={onForkLatest}
          disabled={forkLatestDisabled}
          title={forkLatestDisabled ? '当前回复完成后可分叉' : '从最新内容分叉新会话'}
          aria-label="从最新内容分叉新会话"
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="fork" size={14} />
          </span>
          分叉
        </button>
      )}
      {sideCapable && onOpenSide && (
        <button
          className="summary-toggle session-side-toggle"
          onClick={onOpenSide}
          title="侧边对话（临时支线，不写回主会话）"
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="message-square" size={14} />
          </span>
          侧边
        </button>
      )}
    </div>
  )
}

/**
 * 计时胶囊重构 — the summary card content, shared by the timer capsule's hover
 * popover (unpinned) and the pinned right-hand dock. Positioning is owned by the
 * containers (`.timer-summary-pop` / `.summary-dock`); this renders only the
 * sections, and the header carries the new pin toggle next to the close button:
 *  · 环境信息: live git change stat + branch + workdir.
 *  · 子智能体: the avatar stack + running/done counts (click → detail panel).
 * (The old 状态 row is gone — the timer capsule itself carries the live state.)
 */
function SummaryPanel({
  pinned,
  session,
  events,
  changeSet,
  subagents,
  onOpenSubAgent,
  onOpenReview,
  onOpenRequirement,
  requirementsEnabled,
  onOpenTeam,
  onTogglePin,
  onClose
}: {
  pinned: boolean
  session: Session
  events: UAEvent[]
  changeSet: ReviewChangeSet | null
  subagents: UASubAgent[]
  onOpenSubAgent: (agentThreadId: string) => void
  onOpenReview: () => void
  onOpenRequirement: (path: string, root: string) => void
  requirementsEnabled: boolean
  onOpenTeam: (id: string) => void
  onTogglePin: () => void
  onClose: () => void
}): JSX.Element {
  // 需求4 — the App keeps `reviewChangeSet` fresh in the background (it refetches
  // on session switch and after every completed turn), so seed from that prop and
  // render immediately instead of blanking out and refetching on each open. We
  // still keep a local copy so a late background update repaints without churn.
  const { requirements } = useRequirements()
  const requirement = requirements.find(r => r.id === session.config.requirementId)
  const [cs, setCs] = useState<ReviewChangeSet | null>(changeSet)
  useEffect(() => { setCs(changeSet) }, [changeSet])

  const added = cs?.items.reduce((s, i) => s + (i.added || 0), 0) || 0
  const removed = cs?.items.reduce((s, i) => s + (i.removed || 0), 0) || 0
  const fileCount = cs?.items.length || 0
  const running = subagents.filter(
    (a) => a.status === 'running' || a.status === 'pendingInit'
  )
  const done = subagents.filter((a) => a.status !== 'running' && a.status !== 'pendingInit')

  return (
    <div className="summary-panel">
      <div className="sum-sec">
        <div className="summary-float-head">
          <span className="sum-h summary-float-title">环境信息</span>
          <span className="summary-float-actions">
            <button
              className={`summary-float-x summary-pin-toggle${pinned ? ' active' : ''}`}
              onClick={onTogglePin}
              title={pinned ? '取消固定' : '固定到右侧'}
              aria-label={pinned ? '取消固定' : '固定到右侧'}
              aria-pressed={pinned}
            >
              <UiIcon name="pin" size={14} />
            </button>
            <button className="summary-float-x" onClick={onClose} title="关闭" aria-label="关闭摘要">
              <UiIcon name="close" size={16} />
            </button>
          </span>
        </div>
        {(cs?.isGitRepo || events.some((event) => event.type === 'diff_update')) && (
          <button className="sum-row review-summary-entry" onClick={onOpenReview} title="Review 工作区变更">
            <span className="ic"><UiIcon name="file-diff" size={20} /></span>
            <span className="lbl">变更</span>
            <span className="val review-summary-count">
              {fileCount > 0 ? (
                <>
                  <span className="add">+{added.toLocaleString('en-US')}</span>{' '}
                  <span className="del">-{removed.toLocaleString('en-US')}</span>
                  <span className="files"> · {fileCount} 文件</span>
                </>
              ) : (
                <span className="files">无改动</span>
              )}
            </span>
          </button>
        )}
        {cs?.branch && (
          <div className="sum-row">
            <span className="ic"><UiIcon name="fork" size={20} /></span>
            <span className="lbl mono">{cs.branch}</span>
          </div>
        )}
        <div className="sum-row link" title={session.config.workdir}>
          <span className="ic"><UiIcon name="folder" size={20} /></span>
          <span className="lbl">{shortPath(session.config.workdir)}</span>
        </div>
        {requirementsEnabled && session.config.requirementId && <button type="button" className="sum-row requirement-summary" disabled={!requirement} title={requirement ? '打开需求上下文文档 context.md' : '需求不可用'} onClick={() => requirement && onOpenRequirement(requirement.docPath, requirement.dir)}>
          <span className="ic"><UiIcon name="file" size={20} /></span>
          <span className="lbl">所属需求 · {requirement?.name || session.config.requirementName || '需求不可用'}</span>
          {requirement?.status === 'archived' && <span className="requirement-status">已归档</span>}
          <UiIcon name="chevron-right" size={12} />
        </button>}
      </div>
      <TeamSummary onOpenTeam={onOpenTeam} />
      {/* 计时胶囊重构 — the 状态 row is removed: the persistent timer capsule
          already carries the session state via its border color + glyph. */}
      {subagents.length > 0 && (
        <div className="sum-sec">
          <button
            type="button"
            className="sum-agents"
            onClick={() => subagents[0] && onOpenSubAgent(subagents[0].agentThreadId)}
          >
            <span className="ic"><UiIcon name="users" size={20} /></span>
            <span className="run-n">子智能体{running.length > 0 ? ` · ${running.length} 个运行中` : ''}</span>
            <span className="done-n">{done.length} 完成</span>
          </button>
        </div>
      )}
    </div>
  )
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}

/**
 * 需求5（外部会话导入并发治理）— replaces the Composer for a READ-ONLY imported
 * snapshot. Instead of an input box the user gets explicit continuation choices:
 *  - 原Agent分叉: lossless byte-copy into a fresh native id under the same agent.
 *  - 原生Agent直接导入: reuse and resume the original native id.
 *  - 换Agent分叉: rebuild into another agent (labeled potentially lossy).
 */
export function ForkBar({
  session,
  agents,
  onForkSame,
  onImport,
  onForkCross
}: {
  session: Session
  agents: AgentDef[]
  onForkSame: () => void
  onImport: () => void
  onForkCross: (targetAgentId: string) => void
}): JSX.Element {
  const [pickCross, setPickCross] = useState(false)
  const [busy, setBusy] = useState(false)
  const sourceBase = agents.find((a) => a.id === session.config.agentId)
  const source = sourceBase ? agentForSession(sourceBase, session) : undefined
  const canForkSame = supportsSessionCapability(source, 'sessionFork')
  const canImportDirect =
    supportsSessionCapability(sourceBase, 'sessionLoad') &&
    supportsSessionCapability(sourceBase, 'sessionResume')
  const others = eligibleCrossForkTargets(source, agents)
  const run = async (fn: () => Promise<void> | void): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
      setPickCross(false)
    }
  }
  return (
    <div className="fork-bar">
      <div className="fork-bar-note">
        <span className="fork-bar-badge">只读快照</span>
        {canImportDirect ? (
          <>这是从原生 CLI 历史导入的<strong>只读快照</strong>。可分叉出独立会话，或直接导入并续写原生会话；
          直接导入后请勿在 TUI/其它窗口中并发使用。</>
        ) : (
          <>这是从原生 CLI 历史导入的<strong>只读快照</strong>。当前 Agent 不支持直接导入，请选择可用的分叉操作。</>
        )}
      </div>
      <div className="fork-bar-actions">
        {canForkSame && (
          <button
            className="fork-btn fork-btn-primary"
            disabled={busy || !session.nativeSessionId}
            title="复制原生会话为新分支，无损保留全部上下文，可直接续跑"
            onClick={() => run(onForkSame)}
          >
            <UiIcon name="fork" size={14} /> 原 Agent 分叉（无损）
          </button>
        )}
        {canImportDirect && (
          <button
            className="fork-btn"
            disabled={busy || !session.nativeSessionId}
            title="复用原生会话直接续跑；请勿与 TUI 或其它窗口并发使用"
            onClick={() => run(onImport)}
          >
            <UiIcon name="history" size={14} /> 原生 Agent 直接导入
          </button>
        )}
        {others.length > 0 && (
          <div className="fork-cross">
            <button
              className="fork-btn"
              disabled={busy}
              title="把会话归一化重建到另一个 Agent 后续跑（可能有损）"
              onClick={() => setPickCross((v) => !v)}
            >
              <UiIcon name="fork" size={14} /> 换 Agent 分叉…
            </button>
            {pickCross && (
              <div className="fork-cross-menu">
                <div className="fork-cross-hint">归一化重建，可能丢失推理/工具细节</div>
                {others.map((a) => (
                  <button
                    key={a.id}
                    className="fork-cross-target"
                    disabled={busy}
                    onClick={() => run(() => onForkCross(a.id))}
                  >
                    <AgentIcon agentId={a.id} adapter={a.adapter} size={13} />
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function supportsSessionCapability(
  agent: AgentDef | undefined,
  capability: 'sessionList' | 'sessionLoad' | 'sessionResume' | 'sessionFork'
): boolean {
  if (!agent || agent.installed === false || agent.incompatible) return false
  const advertised = agent.capabilities[capability]
  return (agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web') ? advertised === true : advertised !== false
}
