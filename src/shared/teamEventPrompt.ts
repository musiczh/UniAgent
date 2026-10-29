import type { TeamInboxItem } from './teamTypes'

export interface TeamEventPromptPayload {
  projectId?: string
  runId?: number
  revision?: number
  inboxSeq?: number
  summary?: string
  events?: Array<Partial<Omit<TeamInboxItem, 'kind' | 'state' | 'attachments'>> & { kind?: string; state?: string }>
}

export type ParsedTeamEventPrompt =
  | { kind: 'not-event' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'parsed'; payload: TeamEventPromptPayload }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Parse the persisted team envelope; missing fields stay missing, invalid data stays available. */
export function parseTeamEventPrompt(value: unknown): ParsedTeamEventPrompt {
  if (typeof value !== 'string' || !value.startsWith('[team_event：')) return { kind: 'not-event' }
  const json = value.replace(/\r\n?/g, '\n').split('\n', 3)[1]
  if (!json) return { kind: 'invalid', raw: value }
  try {
    const payload = record(JSON.parse(json))
    if (!payload || payload.events !== undefined &&
      (!Array.isArray(payload.events) || payload.events.some(item => !record(item)))) {
      return { kind: 'invalid', raw: value }
    }
    return { kind: 'parsed', payload: {
      projectId: text(payload.projectId),
      runId: finiteNumber(payload.runId),
      revision: finiteNumber(payload.revision),
      inboxSeq: finiteNumber(payload.inboxSeq),
      summary: text(payload.summary),
      events: Array.isArray(payload.events) ? payload.events.map(item => ({
        eventId: text(item.eventId),
        seq: finiteNumber(item.seq),
        runId: finiteNumber(item.runId),
        assignmentId: text(item.assignmentId),
        attempt: finiteNumber(item.attempt),
        kind: text(item.kind),
        summary: text(item.summary),
        state: text(item.state),
        resultRef: text(item.resultRef),
      })) : undefined,
    } }
  } catch {
    return { kind: 'invalid', raw: value }
  }
}
