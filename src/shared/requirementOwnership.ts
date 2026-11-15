import type { Requirement } from './requirementTypes'
import type { Session } from './types'

/** Ties retain an existing owner, then use a stable ID order, never array order. */
export function requirementOwnerByUsage(
  requirement: Pick<Requirement, 'id' | 'projectId'>,
  sessions: Pick<Session, 'id' | 'config'>[],
  projectIds: ReadonlySet<string>
): string | undefined {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const session of sessions) {
    const id = session.config.projectId
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (session.config.requirementId === requirement.id && id && projectIds.has(id)) counts.set(id, (counts.get(id) || 0) + 1)
  }
  let highest = 0
  for (const count of counts.values()) highest = Math.max(highest, count)
  const candidates = [...counts.keys()].filter(id => counts.get(id) === highest).sort()
  if (requirement.projectId && projectIds.has(requirement.projectId) && (!highest || candidates.includes(requirement.projectId))) return requirement.projectId
  return candidates[0]
}
