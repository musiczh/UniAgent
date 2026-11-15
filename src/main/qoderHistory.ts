import type { SessionSummary, UAEvent } from '../shared/types'
import { qoderOperation } from './qoderSdk.ts'
import { QoderRunner } from './qoderRunner.ts'

export function projectQoderHistory(messages: any[], nativeId: string): UAEvent[] {
  const events: UAEvent[] = []
  const runner = new QoderRunner(nativeId, { n: 0 })
  let timestamp = 0
  runner.on('event', event => events.push({ ...event, ts: timestamp || event.ts }))
  for (const message of messages) {
    timestamp = Date.parse(message.timestamp || '') || 0
    const content = message.message?.content
    if (message.type === 'user' && !message.parent_tool_use_id && (typeof content === 'string' || Array.isArray(content) && content.some(block => block.type === 'text'))) {
      const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text) events.push({ sessionId: nativeId, seq: 0, ts: timestamp, type: 'user_message', payload: { text, nativeMessageId: message.uuid } })
    }
    const start = events.length
    runner.acceptMessage(message)
    for (const event of events.slice(start)) if (event.type === 'agent_message' || event.type === 'reasoning') event.payload.nativeMessageId = message.uuid
  }
  return events.map((event, seq) => ({ ...event, seq }))
}

export async function listQoderHistory(bin: string): Promise<SessionSummary[]> {
  const sessions: import('@qoder-ai/qoder-agent-sdk').SDKSessionInfo[] = await qoderOperation(bin, 'listSessions')
  return sessions.map(session => ({ id: session.sessionId, agentId: 'qoder', title: session.customTitle || session.summary || session.firstPrompt || 'Qoder 会话',
    cwd: session.cwd, createdAt: session.createdAt || session.lastModified, updatedAt: session.lastModified, status: 'idle' }))
}

export async function loadQoderHistory(bin: string, nativeId: string, cwd?: string): Promise<{ events: UAEvent[]; cwd?: string }> {
  const messages = await qoderOperation(bin, 'history', { sessionId: nativeId }, cwd)
  return { events: projectQoderHistory(messages, nativeId), cwd }
}
