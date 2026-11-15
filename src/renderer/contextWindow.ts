import type { UAEvent } from '../shared/types'
import { isSessionBusy } from '../shared/sessionStatus'

export function currentTurnContextWindow(
  events: UAEvent[],
  afterCorrectionSeq?: number
): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'user_message' || ev.type === 'goal_message') return undefined
    if (afterCorrectionSeq !== undefined && ev.seq <= afterCorrectionSeq) return undefined
    if (ev.type === 'system_notice' && ev.payload?.usage) {
      const window = ev.payload.usage.contextWindow
      if (typeof window === 'number') return window
    }
  }
  return undefined
}

function latestContextWindow(
  events: UAEvent[],
  afterCorrectionSeq?: number
): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (afterCorrectionSeq !== undefined && ev.seq <= afterCorrectionSeq) return undefined
    if (ev.type === 'system_notice' && ev.payload?.usage) {
      const window = ev.payload.usage.contextWindow
      if (typeof window === 'number') return window
    }
  }
  return undefined
}

export function displayedContextWindow(
  events: UAEvent[],
  status: string,
  configured?: number,
  backendConfigCorrectionSeq?: number
): number | undefined {
  if (isSessionBusy(status)) return currentTurnContextWindow(events, backendConfigCorrectionSeq) ?? configured
  return configured ?? latestContextWindow(events, backendConfigCorrectionSeq)
}

export function computeContext(events: UAEvent[]): {
  used: number
  usedPercentage?: number
  window?: number
  detail: { input?: number; output?: number; cached?: number; cost?: number | null }
} {
  // Replaced snapshots retain their display position, not their chronological position.
  const latestNotice = (kind: 'context' | 'usage'): UAEvent | undefined =>
    events.reduce<UAEvent | undefined>((found, event) =>
      event.type === 'system_notice' && event.payload?.kind === kind && event.payload.usage &&
      (!found || event.seq > found.seq) ? event : found, undefined)
  const contextEvent = latestNotice('context')
  const usageEvent = latestNotice('usage')
  const contextUsed = contextEvent ? boundedTokens(contextEvent.payload.usage.contextTokens) : undefined
  const usageUsed = usageEvent ? boundedTokens(usageEvent.payload.usage.contextTokens) : undefined
  // 需求(实时上下文): a live `context` tick updates only the occupancy figure.
  // It stays authoritative over a newer usage footer that carries no bounded
  // figure, so an asynchronous cumulative footer can never hide it.
  if (contextEvent && contextUsed !== undefined &&
      (!usageEvent || usageUsed === undefined || usageEvent.seq < contextEvent.seq)) {
    return { used: contextUsed, window: contextEvent.payload.usage.contextWindow, detail: {} }
  }
  if (usageEvent) {
    const u = usageEvent.payload.usage
    const input = u.inputTokens ?? u.input_tokens ?? 0
    const output = u.outputTokens ?? u.output_tokens ?? 0
    const cached = u.cachedInputTokens ?? u.cached_input_tokens ?? 0
    const cost = u.cost ?? usageEvent.payload.cost ?? null
    // Occupancy: how full the window is right now = the last call's input.
    // Never fall back to an input/output sum: for providers whose footer is
    // cumulative across model calls (Grok reports 2.4M billed tokens for a
    // 256k window), that number is unbounded and reads as a permanent 100%.
    return { used: usageUsed ?? 0, ...(typeof u.contextUsedPercentage === 'number' && Number.isFinite(u.contextUsedPercentage) ? { usedPercentage: u.contextUsedPercentage } : {}), window: u.contextWindow, detail: { input, output, cached, cost } }
  }
  if (contextEvent && contextUsed !== undefined) {
    return { used: contextUsed, window: contextEvent.payload.usage.contextWindow, detail: {} }
  }
  return { used: 0, detail: {} }
}

/** Context occupancy must be a finite, non-negative token count. */
function boundedTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
