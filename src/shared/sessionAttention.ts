import type { UAEvent } from './types'
import { interactionRequestKey } from './interactionRequests'

export type ReplyUnreadKind = 'main' | 'side'
export interface SessionAttentionSnapshot {
  revision: number
  unreadBySession: Partial<Record<string, ReplyUnreadKind>>
}
export interface SessionAttentionChannel {
  sessionId: string
  ownerId: string
  source: ReplyUnreadKind
  requests: Record<string, { unread: boolean; settled: boolean }>
  result?: { identity: string; unread: boolean }
}
export interface SessionAttentionData {
  version: 1
  legacyImported: boolean
  channels: SessionAttentionChannel[]
}
export interface LegacySessionAttention {
  unread: Partial<Record<string, ReplyUnreadKind>>
  pending: Record<string, string[]>
}

export function attentionRequestIdentity(event: UAEvent): string {
  return JSON.stringify([interactionRequestKey(event) || `event:${event.seq}:${event.ts}`, event.payload.teamRevision ?? null])
}

export function parseSessionAttentionData(value: unknown): SessionAttentionData {
  const data = value as SessionAttentionData
  if (!data || data.version !== 1 || typeof data.legacyImported !== 'boolean' || !Array.isArray(data.channels)) throw new Error('未读状态格式无效')
  for (const channel of data.channels) {
    if (!channel || typeof channel.sessionId !== 'string' || !channel.sessionId || typeof channel.ownerId !== 'string' || !channel.ownerId ||
      !['main', 'side'].includes(channel.source) || !channel.requests || typeof channel.requests !== 'object' || Array.isArray(channel.requests) ||
      Object.values(channel.requests).some(request => !request || typeof request.unread !== 'boolean' || typeof request.settled !== 'boolean') ||
      channel.result !== undefined && (typeof channel.result.identity !== 'string' || typeof channel.result.unread !== 'boolean')) throw new Error('未读状态记录无效')
  }
  return data
}
