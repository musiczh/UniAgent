import type { Session } from './types'
import { isToolSession } from './types'
import { TASK_EXECUTION_LABELS, sessionDisplayTitle } from './task'
import type { TaskDecision } from './taskDecisions'
import { isNativeTaskDecision } from './taskDecisions'
import { taskHasEndedRound } from './taskLifecycle'
import { taskDisplayDescription } from './taskTitle'
import type { RouterRequest } from './router'
import type { WorktreeStatusBinding } from './sessionWorktreeStatus'

export const TASK_BOARD_COLUMNS = { active: '进行中', decision: '待决策', standby: '待推进', archived: '已归档' } as const
export type TaskBoardColumn = keyof typeof TASK_BOARD_COLUMNS
export interface TaskBoardQuery { pages?: Partial<Record<TaskBoardColumn, number>>; includeArchived?: boolean; requirementId?: string }
export interface TaskBoardEntry {
  id: string; title: string; column: TaskBoardColumn | 'archived'; status: string; priority: 'high' | 'medium' | 'normal'
  description?: string
  attentionDetail?: string
  decisionCount: number; projectId?: string; requirementId?: string; updatedAt: number
  agentId?: string; executionStatus?: Session['status']; readOnly?: boolean; canPause?: boolean; canDecide?: boolean; canDelete?: boolean; teamTask?: boolean
  routerRequestId?: string; routerRequestVersion?: number
  worktree?: WorktreeStatusBinding
}
export interface TaskBoardPage { items: TaskBoardEntry[]; total: number; page: number; pages: number }
export interface TaskFocusEntry { id: string; title: string; readOnly: boolean; description?: string; updatedAt: number }
export interface TaskBoardSnapshot { columns: Record<TaskBoardColumn, TaskBoardPage>; focus: TaskFocusEntry[]; archived?: TaskBoardPage; archivedCount: number; updatedAt: number }

export function projectTaskBoard(sessions: Session[], decisions: (id: string) => readonly TaskDecision[], query: TaskBoardQuery = {}, visibleTeam: (session: Session) => boolean = () => false, routerRequests: readonly RouterRequest[] = []): TaskBoardSnapshot {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['pages','includeArchived','requirementId'].includes(key)) ||
    query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean' ||
    query.requirementId !== undefined && (typeof query.requirementId !== 'string' || !query.requirementId || query.requirementId.length > 200) ||
    query.pages !== undefined && (!query.pages || typeof query.pages !== 'object' || Array.isArray(query.pages) || Object.entries(query.pages).some(([key, page]) => !['active','decision','standby','archived'].includes(key) || !Number.isSafeInteger(page) || page! < 0))) throw new Error('无效看板分页参数')
  const rows: Record<TaskBoardColumn | 'archived', TaskBoardEntry[]> = { active: [], decision: [], standby: [], archived: [] }
  const focus: TaskFocusEntry[] = []
  const requests = new Map<string, RouterRequest>()
  for (const request of routerRequests) if (!requests.has(request.requestId) || requests.get(request.requestId)!.version <= request.version) requests.set(request.requestId, request)
  const committing = new Set([...requests.values()].filter(request => request.state === 'committing').map(request => request.requestId))
  const unique = new Map<string, Session>()
  for (const session of sessions) {
    if (isToolSession(session) || session.config.managedPurpose || session.config.assistantSnapshot || session.teamBinding && !visibleTeam(session)) continue
    if (session.taskRegistration && committing.has(session.taskRegistration.requestId)) continue
    if (query.requirementId && session.config.requirementId !== query.requirementId) continue
    const previous = unique.get(session.id)
    if (!previous || (session.updatedAt || session.createdAt) >= (previous.updatedAt || previous.createdAt)) unique.set(session.id, session)
  }
  for (const session of unique.values()) {
    const archived = session.archived || session.taskState?.phase === 'archived'
    const pending = archived ? [] : decisions(session.id)
    const hint = archived ? undefined : session.taskState?.decisionHint
    const native = pending.filter(isNativeTaskDecision)
    const stale = (hint?.count || 0) > native.length
    if (!archived && (native.length || stale || session.status === 'awaiting-approval')) focus.push({ id: session.id, title: sessionDisplayTitle(session), readOnly: !!session.readOnly, description: taskDisplayDescription(session), updatedAt: session.updatedAt || session.createdAt })
    const running = ['running','queued','cancelling'].includes(session.status) || !!session.pendingQueue?.some(item => item.state === 'pending') || !!session.recovery && session.recovery.phase !== 'stopped'
    const standby = session.taskState?.phase === 'standby'
    const outcome = !standby && taskHasEndedRound(session)
    const count = archived ? 0 : Math.max(native.length, hint?.count || 0) + (outcome || pending.some(d => d.type === 'exception') || session.taskState?.error ? 1 : 0)
    const priority = pending.some(d => d.priority === 'high') || stale && hint?.priority === 'high' ? 'high' : count ? 'medium' : 'normal'
    const blocked = session.status === 'awaiting-approval' || native.some(d => d.blocking) || stale && !running
    const column = archived ? 'archived' : blocked || session.taskState?.error ? 'decision' : running ? 'active' : native.length || outcome ? 'decision' : standby ? 'standby' : 'active'
    const focusDecision = pending.find(d => d.priority === 'high') || pending[0]
    let status: string
    if (archived) status = '已归档'
    else if (session.taskState?.error) status = '状态待确认'
    else if (stale) status = '需处理 · 待读取核对'
    else if (focusDecision) status = focusDecision.status !== 'open' ? '响应结果待确认' : focusDecision.type === 'question' && !focusDecision.blocking ? '需回答 · 执行继续' : focusDecision.title
    else if (session.status === 'awaiting-approval') status = '需处理 · 待读取核对'
    else if (column === 'standby') status = '暂缓推进'
    else if (column === 'decision') status = '待你决定'
    else status = session.taskRegistration?.phase === 'provisioning' ? '准备任务' : TASK_EXECUTION_LABELS[session.status]
    const readOnly = !!(session.readOnly || session.teamBinding || session.config.assistantSnapshot)
    const item: TaskBoardEntry = { id: session.id, title: sessionDisplayTitle(session), column: !archived && session.status === 'awaiting-approval' && !count ? 'decision' : column,
      description: session.taskMetadata?.description?.trim() || undefined,
      attentionDetail: focusDecision?.detail,
      status, priority: !archived && session.status === 'awaiting-approval' ? 'high' : priority, decisionCount: !archived && session.status === 'awaiting-approval' ? Math.max(1, count) : count,
      projectId: session.config.projectId, requirementId: session.config.requirementId, updatedAt: session.updatedAt || session.createdAt,
      agentId: session.config.agentId, executionStatus: session.status, readOnly, canDelete: true, teamTask: !!session.teamBinding,
      ...(session.config.worktree ? { worktree: { id: session.config.worktree.id, state: session.config.worktree.state, removedAt: session.config.worktree.removedAt, lastError: session.config.worktree.lastError, workdir: session.config.worktree.workdir, baseRef: session.config.worktree.baseRef, branch: session.config.worktree.branch } } : {}),
      canPause: !readOnly && !archived && session.status !== 'cancelling' && running,
      canDecide: !readOnly && !archived && !running && !blocked && !native.length && !hint?.count && !session.taskState?.error && session.taskRegistration?.delivery !== 'unknown' && (taskHasEndedRound(session) || standby) }
    rows[item.column].push(item)
  }
  for (const request of requests.values()) {
    if (request.state === 'bound' || request.state === 'cancelled') continue
    const requirementId = request.scope.kind === 'requirement' ? request.scope.requirementId : undefined
    if (query.requirementId && requirementId !== query.requirementId) continue
    rows.active.push({ id: 'router:' + request.requestId, routerRequestId: request.requestId, routerRequestVersion: request.version,
      title: request.prompt.trim().replace(/\s+/g, ' ').slice(0, 160) || '自动归属任务', column: 'active',
      status: request.state === 'needs_input' ? '待确认' : request.state === 'failed' ? '路由失败' : '路由中',
      priority: 'normal', decisionCount: 0, requirementId, projectId: request.scope.kind === 'space' ? request.scope.projectId : undefined,
      updatedAt: request.updatedAt, readOnly: true, canPause: false, canDecide: false, canDelete: request.state === 'failed' })
  }
  const rank = { high: 0, medium: 1, normal: 2 }
  const page = (key: keyof typeof rows): TaskBoardPage => {
    const items = rows[key].sort((a, b) => rank[a.priority] - rank[b.priority] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const pages = Math.max(1, Math.ceil(items.length / 30)), current = Math.min(query.pages?.[key] || 0, pages - 1)
    return { items: items.slice(current * 30, (current + 1) * 30), total: items.length, page: current, pages }
  }
  const archived = page('archived')
  return { columns: { active: page('active'), decision: page('decision'), standby: page('standby'), archived }, focus, archived: query.includeArchived === false ? undefined : archived, archivedCount: rows.archived.length, updatedAt: Date.now() }
}
