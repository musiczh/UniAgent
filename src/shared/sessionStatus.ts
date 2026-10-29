import type { Session, SessionStatus } from './types'
import type { TeamProject } from './teamTypes'
import { teamInteractionForUser } from './teamQuestions'

/** A team can remain active between native Leader turns. Never send this state to a runner. */
export type SessionActivityStatus = SessionStatus | 'waiting_members'

export function isSessionBusy(status?: string): boolean {
  return status === 'running' || status === 'queued' || status === 'awaiting-approval' ||
    status === 'cancelling' || status === 'waiting_members'
}

/** One display state for the sidebar, timer, transcript and stop action. */
export function sessionActivityStatus(session: Session, project?: TeamProject, sessions: readonly Session[] = []): SessionActivityStatus {
  const native = session.status
  if (!project || session.id !== project.memberSessions[project.team.leaderMemberId] ||
    project.archivedAt || !['ready', 'running', 'waiting_members', 'waiting_user', 'stopping'].includes(project.status) ||
    ['error', 'cancelled', 'interrupted', 'archived'].includes(native)) return native

  const members = new Set(Object.values(project.memberSessions).filter(id => id !== session.id))
  const pendingWork = project.assignments.some(a => a.runId === project.runId && !a.endedAt &&
    ['queued', 'running', 'blocked', 'cancelling'].includes(a.status)) ||
    sessions.some(s => members.has(s.id) && isSessionBusy(s.status)) ||
    project.inbox.some(e => e.runId === project.runId && e.state === 'pending' && e.kind !== 'progress')

  if (native === 'cancelling' || project.status === 'stopping') {
    return isSessionBusy(native) || pendingWork ? 'cancelling' : native
  }
  if (project.interactions.some(i => i.runId === project.runId && i.state === 'pending' &&
    teamInteractionForUser(i, project.team.leaderMemberId))) return 'awaiting-approval'
  if (isSessionBusy(native)) return native
  return pendingWork ? 'waiting_members' : native
}
