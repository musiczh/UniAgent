import type { CodexRateLimits, CodexRateWindow } from '../shared/types'

/**
 * Latest Claude Code account quota (用量额度). The CLI reports subscription
 * windows only through the live `rate_limit_event` in stream-json output (its
 * `unifiedWindows` 5-hour / 7-day utilization); nothing is persisted on disk,
 * so the snapshot lives in memory for this app run. It reuses the Codex quota
 * shape so the popover renders both identically.
 */

let latest: CodexRateLimits | null = null

function toWindow(raw: any, windowMinutes: number): CodexRateWindow | null {
  const utilization = raw?.utilization
  const resetsAt = raw?.resetsAt
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  return { usedPercent: utilization * 100, windowMinutes, resetsAt }
}

export function normalizeClaudeRateLimits(info: any, capturedAt = Date.now()): CodexRateLimits | null {
  const windows = info?.unifiedWindows
  const primary = toWindow(windows?.five_hour, 300)
  const secondary = toWindow(windows?.seven_day, 10080)
  if (!primary && !secondary) return null
  return { primary, secondary, capturedAt }
}

export function rememberClaudeRateLimits(snapshot: CodexRateLimits): CodexRateLimits {
  latest = snapshot
  return latest
}

export function getClaudeRateLimits(): CodexRateLimits | null {
  return latest
}
