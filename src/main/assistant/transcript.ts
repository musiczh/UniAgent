import { stripAssistantContext } from './context'
import type { IndexedMessage, IndexedSession } from '../../shared/assistant'
import type { Session, UAEvent } from '../../shared/types'

export function assistantIndexedSession(session: Session): IndexedSession {
  return { id: session.id, title: session.title, agentId: session.config.agentId, createdAt: session.createdAt, archived: !!session.archived,
    ...(session.forkedFrom ? { lineageRoot: `${session.forkedFrom.agentId}:${session.forkedFrom.nativeId}` } : {}) }
}
export function assistantIndexedMessage(event: UAEvent): IndexedMessage | undefined {
  const role = ['user_message','goal_message'].includes(event.type) ? 'user' : event.type === 'agent_message' ? 'assistant' : event.type === 'tool_call' && event.state === 'success' ? 'tool' : undefined
  if (!role || event.payload?.source === 'team_event' || event.payload?.subagentId || event.payload?.channel === 'side' || event.payload?.asyncQuestion) return undefined
  const content = role === 'tool' ? JSON.stringify(event.payload?.output ?? event.payload?.result ?? '') : event.payload?.displayText ?? event.payload?.text
  if (typeof content !== 'string' || !content.trim()) return undefined
  return { id: `${event.sessionId}:${role}:${String(event.payload?.assistantMessageId || event.payload?.zcodeQueueItemId || event.payload?.id || event.seq)}`, sessionId: event.sessionId, seq: event.seq, ts: event.ts, role, content: (role === 'user' ? stripAssistantContext(content) : content).slice(0,65536), visibility: 'live' }
}
