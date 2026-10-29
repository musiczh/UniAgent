import type { UAEvent } from '@shared/types'
import type { ZCodeEventCursor, ZCodeEventsSnapshot } from '@shared/zcode'

/** Native rows can update across turn boundaries; ids, not transcript positions, own them. */
export function mergeZCodeEvent(events: UAEvent[], event: UAEvent, cursor?: ZCodeEventCursor): UAEvent[] {
  if (event.payload.zcodeProjection && cursor &&
    (event.payload.projectionGeneration < cursor.generation ||
      event.payload.projectionGeneration === cursor.generation && event.seq <= cursor.upToEventSeq)) return events
  const id = event.payload.id ?? event.payload.requestId
  const index = events.findIndex(item => item.type === event.type &&
    (id ? (item.payload.id ?? item.payload.requestId) === id : item.seq === event.seq))
  if (index >= 0) {
    const existing = events[index]
    if (event.payload.zcodeProjection && existing.payload.zcodeProjection &&
      (event.payload.projectionGeneration < existing.payload.projectionGeneration ||
        event.payload.projectionGeneration === existing.payload.projectionGeneration && event.seq <= existing.seq)) return events
    const next = [...events]
    next[index] = event.type === 'approval_request' && !event.payload.zcodeProjection
      ? { ...event, payload: { ...next[index].payload, ...event.payload } } : event
    return next
  }
  if (event.type === 'user_message' && !event.payload.optimistic) {
    const optimistic = events.findIndex(item => item.type === 'user_message' && item.payload.optimistic &&
      item.payload.text === event.payload.text && event.ts >= item.ts)
    if (optimistic >= 0) {
      const next = [...events]
      next[optimistic] = { ...event, payload: { ...next[optimistic].payload, ...event.payload, optimistic: false } }
      return next
    }
  }
  return [...events, event]
}

export function mergeZCodeSnapshot(snapshot: ZCodeEventsSnapshot, live: UAEvent[], cursor?: ZCodeEventCursor): UAEvent[] {
  if (cursor && (snapshot.generation < cursor.generation ||
    snapshot.generation === cursor.generation && snapshot.upToEventSeq < cursor.upToEventSeq)) return live
  // A newer subscription delta can arrive before the delayed history IPC response.
  if (live.some(event => event.payload.zcodeProjection && event.payload.projectionGeneration > snapshot.generation)) return live
  const afterSnapshot = live.filter(event => event.payload.optimistic || event.seq > snapshot.upToEventSeq &&
    (!event.payload.zcodeProjection || event.payload.projectionGeneration >= snapshot.generation))
  return afterSnapshot.reduce((events, event) => {
    if (event.payload.optimistic && snapshot.events.some(item => item.type === event.type && item.payload.text === event.payload.text && item.ts >= event.ts)) return events
    return mergeZCodeEvent(events, event)
  }, [...snapshot.events])
}
