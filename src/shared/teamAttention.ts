import type { TeamProject } from './teamTypes'

/** Team member sessions never render as their own sidebar row: the Leader session
 *  row represents the whole team. Attention on any member therefore belongs to
 *  that row, so the unread dot and the Dock badge can be found and read together. */
export function teamRowSessionIds(
  projects: readonly Pick<TeamProject, 'team' | 'memberSessions'>[]
): Map<string, string> {
  const rows = new Map<string, string>()
  for (const project of projects) {
    const leader = project.memberSessions?.[project.team?.leaderMemberId]
    if (!leader) continue
    for (const sessionId of Object.values(project.memberSessions || {})) {
      if (sessionId) rows.set(sessionId, leader)
    }
  }
  return rows
}

/** The sidebar row that owns this session's unread state. */
export function teamRowSessionId(rows: ReadonlyMap<string, string>, sessionId: string): string {
  return rows.get(sessionId) || sessionId
}
