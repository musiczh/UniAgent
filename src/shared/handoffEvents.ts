import type { UAEvent } from './types'

/** Recognize current actions and persisted calls from before MCP consolidation. */
export function handoffTaskAction(event: Pick<UAEvent, 'payload'>): 'create' | 'followup' | 'get' | 'stop' | undefined {
  const { name, input } = event.payload || {}
  if (name === 'uniagent_task') {
    const action = input?.action
    if (action === 'create' || action === 'followup' || action === 'get' || action === 'stop') return action
  }
  if (name === 'create_uniagent_task') return input?.followupTaskId ? 'followup' : 'create'
  if (name === 'get_uniagent_task') return 'get'
  if (name === 'stop_uniagent_task') return 'stop'
  return undefined
}

/** MCP results may be plain text or a list of text blocks. */
export function handoffResultText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const value = result as { text?: unknown; content?: unknown }
  if (typeof value.text === 'string') return value.text
  if (!Array.isArray(value.content)) return ''
  return value.content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n')
}

export function handoffTaskIdFromResult(result: unknown): string {
  const text = handoffResultText(result)
  return text.match(/taskId=([0-9a-f-]{36})\b/i)?.[1]
    || text.match(/handoff id ([0-9a-f-]{36})\b/i)?.[1]
    || ''
}

export function isHandoffEndEvent(event: UAEvent): boolean {
  return event.type === 'system_notice' && event.payload?.kind === 'handoff_end' &&
    typeof event.payload.taskId === 'string'
}

export function handoffTerminalStatus(status: string): 'completed' | 'failed' | 'stopped' | undefined {
  if (status === 'idle' || status === 'completed') return 'completed'
  if (status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'interrupted' || status === 'archived') return 'stopped'
  return undefined
}
