import type { Project, Session } from '@shared/types'
import { isToolSession } from '@shared/types'
import type { Requirement } from '@shared/requirementTypes'
import type { SessionActivityStatus } from '@shared/sessionStatus'
import { isSessionBusy } from '@shared/sessionStatus'
import { TASK_EXECUTION_LABELS } from '@shared/task'
import { taskHasEndedRound } from '@shared/taskLifecycle'

export type BrowserLocation = { kind: 'space' | 'requirement'; id: string } | { kind: 'assistant' }
export const BROWSER_LOCATION_KEY = 'ua.scopeBrowser.location'
export const BROWSER_EXPANDED_KEY = 'ua.scopeBrowser.expanded'

export function readBrowserValue<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
export function saveBrowserValue(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Browsing remains usable when local preferences cannot be saved. */ }
}
export function isAssistantConversation(session: Session): boolean {
  return !!session.config.assistantSnapshot && !session.teamBinding && !session.handoffId
}
export function browserTaskStatus(session: Session, activity?: SessionActivityStatus, pending = false): string {
  if (session.archived) return '已归档'
  if (pending || activity === 'awaiting-approval') return '需处理'
  if (session.taskState?.error) return '状态待确认'
  if (session.taskState?.decisionHint?.count) return '需处理'
  if (session.taskState?.awaitingAcceptance) return '待验收'
  if (session.taskState?.phase === 'standby') return '待推进'
  if (session.readOnly) return '只读记录'
  if (session.taskRegistration?.delivery === 'unknown') return '交付待确认'
  if (session.taskRegistration?.phase === 'provisioning') return '准备任务'
  return activity === 'waiting_members' ? '等待成员' : TASK_EXECUTION_LABELS[activity || session.status]
}
export function scopeSessions(sessions: Session[], location: BrowserLocation, requirementsEnabled = true): Session[] {
  return sessions.filter(session => !isToolSession(session) && !session.config.managedPurpose && (location.kind === 'assistant' ? isAssistantConversation(session) : !isAssistantConversation(session) && (
    location.kind === 'requirement' ? session.config.requirementId === location.id : session.config.projectId === location.id && (!requirementsEnabled || !session.config.requirementId)
  )))
}
export function sessionBrowserLocation(session: Session, requirements: Requirement[], projects: Project[], requirementsEnabled: boolean): BrowserLocation | undefined {
  if (isAssistantConversation(session)) return { kind: 'assistant' }
  if (requirementsEnabled && requirements.some(item => item.id === session.config.requirementId)) return { kind: 'requirement', id: session.config.requirementId! }
  return projects.some(item => item.id === session.config.projectId) ? { kind: 'space', id: session.config.projectId! } : undefined
}
export function browserAttention(sessions: Session[], requirements: Requirement[], pending: Record<string, boolean>, unread: Record<string, unknown>, requirementsEnabled = true): Map<string, { waiting: number; unread: number }> {
  const owners = new Map(requirements.map(r => [r.id, r.projectId]))
  const result = new Map<string, { waiting: number; unread: number }>()
  for (const session of sessions) {
    if (session.archived || session.config.managedPurpose || isToolSession(session)) continue
    const waiting = !!pending[session.id] || session.status === 'awaiting-approval' || !!session.taskState?.awaitingAcceptance || !!session.taskState?.error || !!session.taskState?.decisionHint?.count
    if (!waiting && !unread[session.id]) continue
    const space = requirementsEnabled && session.config.requirementId ? owners.get(session.config.requirementId) : session.config.projectId
    const keys = isAssistantConversation(session) ? ['assistant'] : [space && 'space:' + space, requirementsEnabled && session.config.requirementId && 'requirement:' + session.config.requirementId].filter(Boolean) as string[]
    for (const key of keys) {
      const count = result.get(key) || { waiting: 0, unread: 0 }
      if (waiting) count.waiting++; else count.unread++
      result.set(key, count)
    }
  }
  return result
}

export interface RequirementTaskCounts { running: number; acceptance: number; waiting: number; unread: number }

export function browserRequirementTaskCounts(sessions: Session[], status: Record<string, SessionActivityStatus>, pending: Record<string, boolean>, unread: Record<string, unknown>): Map<string, RequirementTaskCounts> {
  const unique = new Map<string, Session>()
  for (const session of sessions) {
    const previous = unique.get(session.id)
    if (!previous || (session.updatedAt ?? session.createdAt) >= (previous.updatedAt ?? previous.createdAt)) unique.set(session.id, session)
  }
  const result = new Map<string, RequirementTaskCounts>()
  for (const session of unique.values()) {
    const requirementId = session.config.requirementId
    if (!requirementId || session.archived || session.status === 'archived' || session.taskState?.phase === 'archived' || isToolSession(session) || isAssistantConversation(session)) continue
    const activity = status[session.id] || session.status
    const recovering = !!session.recovery && session.recovery.phase !== 'stopped'
    const running = activity !== 'awaiting-approval' && (isSessionBusy(activity) || recovering || !!session.pendingQueue?.some(item => item.state === 'pending'))
    const waiting = !!pending[session.id] || activity === 'awaiting-approval' || !!session.taskState?.decisionHint?.count || !!session.taskState?.error ||
      !recovering && ['error', 'interrupted', 'cancelled'].includes(activity)
    const acceptance = unread[session.id] === 'main' && !running && !waiting && session.taskState?.phase !== 'standby' &&
      (!!session.taskState?.awaitingAcceptance || taskHasEndedRound({ ...session, status: activity as Session['status'] }))
    const progress = !waiting && !acceptance && !!unread[session.id]
    if (!running && !waiting && !acceptance && !progress) continue
    const count = result.get(requirementId) || { running: 0, acceptance: 0, waiting: 0, unread: 0 }
    if (running) count.running++
    if (waiting) count.waiting++
    if (acceptance) count.acceptance++
    if (progress) count.unread++
    result.set(requirementId, count)
  }
  return result
}
