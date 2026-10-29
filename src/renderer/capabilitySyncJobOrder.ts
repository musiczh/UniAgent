import type { CapabilitySyncJob } from '@shared/capabilitySync'

const TERMINAL = new Set(['completed', 'failed_no_change', 'rolled_back', 'rollback_failed', 'cancelled'])
const STATE_ORDER = new Map([
  'idle', 'scanning', 'scanned', 'planning', 'ready', 'blocked', 'backing_up', 'staging',
  'committing', 'verifying', 'completed', 'failed_no_change', 'rolling_back', 'rolled_back',
  'rollback_failed', 'cancelled'
].map((state, index) => [state, index]))

/** Positive means candidate is newer. Equal timestamps never regress a terminal job. */
export function compareCapabilitySyncJobs(candidate: CapabilitySyncJob, current: CapabilitySyncJob): number {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt - current.updatedAt
  if (candidate.id === current.id) {
    const candidateTerminal = TERMINAL.has(candidate.state)
    const currentTerminal = TERMINAL.has(current.state)
    if (candidateTerminal !== currentTerminal) return candidateTerminal ? 1 : -1
    const progress = (candidate.progress?.completed || 0) - (current.progress?.completed || 0)
    if (progress) return progress
    return (STATE_ORDER.get(candidate.state) || 0) - (STATE_ORDER.get(current.state) || 0)
  }
  return candidate.id.localeCompare(current.id)
}
