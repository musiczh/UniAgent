import { fileURLToPath } from 'node:url'
import type { Attachment, TurnUsage, UAEvent } from '../shared/types.ts'
import { buildTextPromptBlocks } from './acp/acpPromptBlocks.ts'
import type { KimiWebContent, KimiWebQuestionAnswer } from './kimiWebRuntime.ts'

export async function buildKimiWebContent(prompt: string, attachments?: Attachment[]): Promise<KimiWebContent[]> {
  const blocks = await buildTextPromptBlocks(prompt, attachments, { imageAttachments: true, fileAttachments: true, provider: 'kimi' })
  return blocks.map((block): KimiWebContent => {
    if (block.type === 'image') return { type: 'image', source: { kind: 'base64', media_type: block.mimeType, data: block.data } }
    if (block.type === 'resource') return { type: 'file', path: fileURLToPath(block.resource.uri), ...(block.resource.mimeType ? { media_type: block.resource.mimeType } : {}) }
    return { type: 'text', text: block.text }
  })
}
export function projectKimiWebUsage(value: any): TurnUsage | undefined {
  if (!value || !['inputOther', 'inputCacheRead', 'inputCacheCreation', 'output'].some(key => Number.isFinite(value[key]))) return undefined
  const n = (key: string) => Math.max(0, Number(value[key]) || 0)
  return { inputTokens: n('inputOther') + n('inputCacheRead') + n('inputCacheCreation'), outputTokens: n('output'), cachedInputTokens: n('inputCacheRead') }
}
export function kimiWebQuestionParams(row: any): { questions: any[] } {
  return { questions: (row.questions || []).map((question: any) => ({ ...question, multiSelect: question.multi_select === true, allowOther: question.allow_other === true })) }
}
/** Existing common question encoder returns exact option labels. Map to IDs. */
export function kimiWebQuestionAnswers(row: any, answer: any): Record<string, KimiWebQuestionAnswer> | undefined {
  if (!answer?.answers || Array.isArray(answer.answers) || typeof answer.answers !== 'object') return undefined
  const result: Record<string, KimiWebQuestionAnswer> = {}
  for (const question of row.questions || []) {
    const labels = answer.answers[question.id]?.answers
    if (!Array.isArray(labels) || labels.some(value => typeof value !== 'string') || new Set(labels).size !== labels.length) return undefined
    const selected: string[] = [], other: string[] = []
    for (const label of labels) {
      const option = question.options.find((entry: any) => entry.label === label)
      if (option) selected.push(option.id)
      else if (question.allow_other && label.trim()) other.push(label)
      else return undefined
    }
    if (!question.multi_select && selected.length + other.length > 1) return undefined
    result[question.id] = selected.length && other.length ? { kind: 'multi_with_other', option_ids: selected, other_text: other.join('\n') }
      : other.length ? { kind: 'other', text: other.join('\n') }
      : selected.length ? question.multi_select ? { kind: 'multi', option_ids: selected } : { kind: 'single', option_id: selected[0] }
      : { kind: 'skipped' }
  }
  return result
}

export function kimiWebSnapshotEvents(snapshot: any): Array<Pick<UAEvent, 'type' | 'state' | 'payload'>> {
  const events: Array<Pick<UAEvent, 'type' | 'state' | 'payload'>> = []
  for (const message of snapshot.messages?.items || []) {
    if (message.role === 'user') continue // Local outbox owns user-message persistence.
    for (let index = 0; index < (message.content || []).length; index++) {
      const part = message.content[index], id = `kimi-native-${message.id}-${index}`
      if (part.type === 'text' || part.type === 'thinking') events.push({ type: part.type === 'thinking' ? 'reasoning' : 'agent_message', state: 'success', payload: { id, text: part.text ?? part.thinking, nativeMessageId: message.id } })
      if (part.type === 'tool_use') events.push({ type: 'tool_call', state: 'running', payload: { id: part.tool_call_id, name: part.tool_name, input: part.input } })
      if (part.type === 'tool_result') events.push({ type: 'tool_call', state: part.is_error ? 'failed' : 'success', payload: { id: part.tool_call_id, output: part.output } })
    }
  }
  return events
}

type TranscriptEvent = Pick<UAEvent, 'type' | 'state' | 'payload'> & { ts?: number }

const COMPRESSION_CAPTION_OPENING = '<system>Image compressed to fit model limits:'
const COMPRESSION_CAPTION = /<system>Image compressed to fit model limits:[\s\S]*?<\/system>/g

/**
 * Kimi prepends a model-only caption before every image it compresses and folds
 * those caption text parts into `turn.prompt`. The caption is not user-authored,
 * so it must never reach the restored bubble: besides leaking internal text it
 * changes the visible prompt hash, which prevents the persisted submission
 * (attachments included) from being re-hydrated after an App restart.
 */
export function stripKimiPromptCaptions(text: string): string {
  return text.includes(COMPRESSION_CAPTION_OPENING) ? text.replace(COMPRESSION_CAPTION, '') : text
}

function transcriptTime(value: unknown, fallback?: number): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : fallback
}

export function kimiWebTranscriptEvents(items: any[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const turn of items) {
    if (turn.kind === 'marker' && turn.marker === 'compaction') {
      const phase = turn.payload?.phase
      events.push({ type: 'context_compaction', state: phase === 'started' ? 'running' : phase === 'cancelled' ? 'cancelled' : phase === 'blocked' ? 'failed' : 'success', ts: transcriptTime(turn.at), payload: { id: `kimi-native-marker-${turn.markerId}` } })
    }
    if (turn.kind !== 'turn') continue
    const startedAt = transcriptTime(turn.startedAt)
    const endedAt = transcriptTime(turn.endedAt, startedAt)
    const turnId = `kimi-native-turn-${turn.turnId}`
    if (turn.origin?.kind === 'user' && (typeof turn.prompt === 'string' || turn.attachmentIds?.length)) {
      const prompt = typeof turn.prompt === 'string' ? stripKimiPromptCaptions(turn.prompt) : ''
      events.push({ type: 'user_message', state: 'success', ts: startedAt, payload: { id: `${turnId}-user`, text: prompt } })
    }
    events.push({ type: 'turn_started', ts: startedAt, payload: { id: turnId, turnId: turn.turnId, nativeTurnId: turn.turnId } })
    let hasError = false
    for (const step of turn.steps || []) for (const frame of step.frames || []) {
      const id = `kimi-native-frame-${frame.frameId}`
      const ts = transcriptTime(step.endedAt, transcriptTime(step.startedAt, startedAt))
      if (frame.kind === 'text' && frame.role === 'assistant' || frame.kind === 'thinking') events.push({ type: frame.kind === 'thinking' ? 'reasoning' : 'agent_message', state: step.state === 'running' ? 'running' : 'success', ts, payload: { id, text: frame.text } })
      // Transcript user frames are steered inputs; task notifications use taskId.
      if (frame.kind === 'text' && frame.role === 'user' && !frame.taskId && (!frame.origin || ['user', 'skill_activation'].includes(frame.origin.kind))) events.push({ type: 'user_message', state: 'success', ts, payload: { id, text: stripKimiPromptCaptions(frame.text), appendedToTurn: true } })
      if (frame.kind === 'tool') events.push({ type: 'tool_call', state: frame.state === 'running' ? 'running' : frame.state === 'error' ? 'failed' : 'success', ts, payload: { id: frame.toolCallId, name: frame.name, input: frame.input, output: frame.output, result: frame.output } })
      if (frame.kind === 'notice') {
        hasError ||= frame.level === 'error'
        events.push({ type: frame.level === 'error' ? 'error' : 'system_notice', state: frame.level === 'error' ? 'failed' : 'success', ts, payload: { id, message: frame.message } })
      }
    }
    if (turn.error && !hasError) events.push({ type: 'error', state: 'failed', ts: endedAt, payload: { id: `${turnId}-error`, message: turn.error } })
    if (turn.state !== 'running' && turn.state !== 'queued') events.push({ type: 'turn_completed', state: turn.state === 'cancelled' ? 'cancelled' : turn.state === 'failed' ? 'failed' : 'success', ts: endedAt, payload: { id: turnId, turnId: turn.turnId } })
  }
  return events
}
