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
