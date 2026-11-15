import type { Attachment, UAEvent } from './types'
import { routerAssignmentCall, type RouterRequest } from './router'

export interface RouterClarificationOption {
  /** Identifier from persisted legacy cards; never a binding to a routing target. */
  objectId?: string
  label: string
  description?: string
}
export interface RouterClarificationRound {
  id: string
  answeredAt: number
  answer: string
  attachments?: Attachment[]
  snapshot: Omit<RouterRequest, 'clarifications' | 'context'>
}
export interface RouterCardView {
  key: string
  request: RouterRequest
  clarification?: RouterClarificationRound
}
export function routerCardView(request: RouterRequest, event?: UAEvent): RouterCardView {
  const version = event && routerAssignmentCall(event)?.version
  const clarification = event && request.clarifications?.find(round => typeof version === 'number'
    ? version <= round.snapshot.version
    : event.ts >= (round.snapshot.roundStartedAt || 0) && event.ts <= round.answeredAt)
  return clarification ? { key: request.requestId + ':' + clarification.id, request: clarification.snapshot, clarification }
    : { key: request.requestId + ':' + (request.roundId || 'current'), request }
}
export function routerCardViews(request: RouterRequest): RouterCardView[] {
  const completed = (request.clarifications || []).map(clarification => ({ key: request.requestId + ':' + clarification.id, request: clarification.snapshot, clarification }))
  return request.state === 'queued' && !request.autoRecovery?.nextAt ? completed : [...completed, routerCardView(request)]
}
