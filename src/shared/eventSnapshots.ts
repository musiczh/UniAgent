import type { UAEvent } from './types'

const SNAPSHOTS = new Set<UAEvent['type']>([
  'agent_message', 'reasoning', 'command_exec', 'diff_update', 'queue_status', 'plan_update'
])

/** Keep the first observed compaction start when lifecycle snapshots are replaced. */
export function withCompactionTiming(event: UAEvent, previous?: UAEvent): UAEvent {
  if (event.type !== 'context_compaction') return event
  const startedAt = previous?.payload?.startedAt ??
    (previous?.state === 'running' ? previous.ts : event.payload?.startedAt ??
      (event.state === 'running' ? event.ts : undefined))
  if (!Number.isFinite(startedAt)) return event
  const durationMs = event.state === 'running' ? undefined
    : Number.isFinite(event.payload?.durationMs) && event.payload.durationMs >= 0 ? event.payload.durationMs
      : Number.isFinite(previous?.payload?.durationMs) ? previous!.payload.durationMs
        : Math.max(0, event.ts - startedAt)
  return { ...event, payload: { ...event.payload, startedAt, ...(durationMs === undefined ? {} : { durationMs }) } }
}

/** Identified usage records are cumulative snapshots, even when already successful. */
export function usageSnapshotKey(event: UAEvent): string | undefined {
  const { id, turnId, kind } = event.payload || {}
  if (event.type !== 'system_notice' || kind !== 'usage' || !id || turnId == null) return undefined
  return JSON.stringify([event.sessionId, turnId, id])
}

/** Older transcripts may contain every intermediate settlement of the same turn. */
export function coalesceUsageSnapshots(events: UAEvent[]): UAEvent[] {
  const positions = new Map<string, number>()
  const result: UAEvent[] = []
  for (const event of events) {
    const key = usageSnapshotKey(event)
    const index = key === undefined ? undefined : positions.get(key)
    if (index !== undefined) result[index] = event
    else {
      if (key !== undefined) positions.set(key, result.length)
      result.push(event)
    }
  }
  return result
}

/** Replace cumulative streaming snapshots without moving their timeline position. */
export function appendEventSnapshot(events: UAEvent[], event: UAEvent, preserveTimeline = true): number {
  const usageKey = usageSnapshotKey(event)
  if (usageKey !== undefined) {
    const index = events.findLastIndex(prior => usageSnapshotKey(prior) === usageKey)
    if (index >= 0) {
      events[index] = event
      return index
    }
  }
  const id = event.payload?.id
  if (id && SNAPSHOTS.has(event.type)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const prior = events[i]
      if (prior.type === 'turn_completed' || prior.type === 'turn_started' ||
          prior.type === 'user_message' || prior.type === 'goal_message') break
      if (prior.type !== event.type || prior.payload?.id !== id) continue
      if (prior.state === 'running' && prior.payload?.turnId === event.payload?.turnId) {
        events[i] = { ...event, ...(preserveTimeline ? { seq: prior.seq, ts: prior.ts } : {}),
          payload: { ...prior.payload, ...event.payload } }
        return i
      }
      break
    }
  }
  events.push(event)
  return events.length - 1
}
