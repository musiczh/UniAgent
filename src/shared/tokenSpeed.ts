import type { UAEvent } from './types'

/** Token counts and timing must describe the same native model call. */
export interface TokenSpeedSample {
  outputTokens?: number
  durationMs?: number
  metric: 'generation' | 'request'
  source: string
  model?: string
  incomplete?: boolean
  /** Native request start, used to reject delayed samples from an earlier user task. */
  startedAt?: number
}

export interface TokenSpeedSummary extends TokenSpeedSample {
  outputTokens: number
  durationMs: number
  samples: number
  partial: boolean
}

export function isTaskTurnInput(event: UAEvent): boolean {
  return event.type === 'goal_message' || event.type === 'user_message' &&
    event.payload?.appendedToTurn !== true && !event.payload?.text?.startsWith('[team_event：')
}

/** Replayed settlements replace a call; tool/approval wall time never enters the denominator. */
export function tokenSpeedForTurn(events: UAEvent[], running: boolean): TokenSpeedSummary | undefined {
  const start = events.findLastIndex(isTaskTurnInput)
  const calls = new Map<string, TokenSpeedSample>()
  for (let i = Math.max(0, start); i < events.length; i++) {
    const event = events[i]
    if (event.type !== 'system_notice' || event.payload?.kind !== 'token_speed' || typeof event.payload.id !== 'string' || !event.payload.id) continue
    const sample = event.payload.speed as TokenSpeedSample | undefined
    if (!sample || !['generation', 'request'].includes(sample.metric) || typeof sample.source !== 'string' ||
        sample.model !== undefined && typeof sample.model !== 'string') continue
    if (sample.startedAt !== undefined && (!Number.isFinite(sample.startedAt) || start >= 0 && sample.startedAt < events[start].ts)) continue
    calls.set(event.payload.id, sample)
  }
  const samples = [...calls.values()].sort((a, b) => a.startedAt !== undefined && b.startedAt !== undefined ? a.startedAt - b.startedAt : 0)
  const valid = samples.filter((sample): sample is TokenSpeedSample & { outputTokens: number; durationMs: number } =>
    Number.isSafeInteger(sample.outputTokens) && sample.outputTokens! >= 0 &&
    typeof sample.durationMs === 'number' && Number.isFinite(sample.durationMs) && sample.durationMs > 0)
  const last = valid.findLast(sample => sample.outputTokens > 0)
  if (!last) return undefined
  // Different models and request/stream timings must not be blended into one speed.
  const matching = valid.filter(sample => sample.metric === last.metric && sample.model === last.model && sample.source === last.source)
  const selected = running ? [last] : matching
  const outputTokens = selected.reduce((sum, sample) => sum + sample.outputTokens, 0)
  const durationMs = selected.reduce((sum, sample) => sum + sample.durationMs, 0)
  if (!Number.isSafeInteger(outputTokens) || !Number.isFinite(durationMs) || !Number.isFinite(outputTokens * 1000 / durationMs)) return undefined
  return { ...last, outputTokens, durationMs, samples: selected.length,
    partial: matching.length !== samples.length || samples.some(sample => sample.incomplete === true) }
}
