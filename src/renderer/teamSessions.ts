import type { Session } from '@shared/types'
import type { TeamProject } from '@shared/teamTypes'

/** Display the real Leader Session. Member runtime statuses never replace its native status. */
export function teamSessionRows(projects: TeamProject[], sessions: Session[]): Session[] {
  const leaders = new Set(projects.map(p => p.memberSessions[p.team.leaderMemberId]))
  return sessions.filter(s => leaders.has(s.id))
}
export function teamCanArchive(p: TeamProject): boolean {
  return !p.archivedAt && !['initializing', 'running', 'stopping'].includes(p.status)
    && !p.interactions.some(i => i.runId === p.runId && i.state === 'pending')
    && (p.status === 'interrupted' || !p.assignments.some(a => a.runId === p.runId && ['queued', 'running', 'blocked', 'cancelling'].includes(a.status)))
}
