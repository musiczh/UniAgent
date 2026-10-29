import type { AgentDef, Session } from '@shared/types'
import { isToolSession } from '@shared/types'

/**
 * Sessions shown in the sidebar must be writable and backed by an Agent that
 * can currently run. Older releases persisted imported history snapshots
 * before direct-import provenance existed, so a forkless imported session is
 * writable only when it explicitly carries `importMode:'direct'`.
 */
export function isSidebarSessionEligible(session: Session, agents: AgentDef[]): boolean {
  if (isToolSession(session)) return false
  const agentAvailable = agents.some(
    (agent) =>
      agent.id === session.config.agentId &&
      agent.lifecycle?.availability === 'available'
  )
  if (!agentAvailable) return false

  const isImportedSnapshot =
    session.readOnly === true ||
    (session.origin === 'imported' &&
      session.forkedFrom == null &&
      !(session.importMode === 'direct' && session.readOnly === false))

  return !isImportedSnapshot
}
