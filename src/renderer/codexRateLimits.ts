import type { CodexRateLimits, CodexRateWindow } from '@shared/types'
import type { CodexSourceQuotaWindow } from '@shared/codexSources'

/**
 * Presentation helpers for Codex 用量额度 (rate limits), shared by the context
 * meter popover and the settings Agent detail page so both render identical
 * labels / colors / reset text.
 */

export type QuotaLevel = 'ok' | 'warn' | 'danger'

export interface QuotaView {
  /** window_minutes → 「5 小时限额」/「周限额」/「N 小时限额」. */
  label: string
  /** Fine-print window description for the settings row. */
  sub: string
  /** 100 − used_percent, clamped to [0,100]. */
  remainPercent: number
  /** used_percent, clamped — drives the progress bar fill width. */
  usedPercent: number
  /** >20% ok / ≤20% warn / ≤5% danger. */
  level: QuotaLevel
  /** e.g. "约 3 小时后刷新". */
  resetRelative: string
  /** Absolute reset moment, e.g. "今天 02:00" / "7 月 2 日 16:00". */
  resetAbsolute: string
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

function windowLabel(windowMinutes: number): { label: string; sub: string } {
  if (windowMinutes === 300) return { label: '5 小时限额', sub: '短周期窗口 · 每 5 小时刷新' }
  if (windowMinutes === 10080) return { label: '周限额', sub: '主配额窗口 · 每 7 天刷新' }
  const hours = Math.round(windowMinutes / 60)
  return { label: `${hours} 小时限额`, sub: `每 ${hours} 小时刷新` }
}

function levelFor(remainPercent: number): QuotaLevel {
  if (remainPercent <= 5) return 'danger'
  if (remainPercent <= 20) return 'warn'
  return 'ok'
}

/** Relative "约 N 分/小时/天后刷新"; past-due → "即将刷新". */
function relativeReset(resetsAtMs: number, now: number): string {
  const diff = resetsAtMs - now
  if (diff <= 0) return '即将刷新'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `约 ${Math.max(1, mins)} 分钟后刷新`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `约 ${hours} 小时后刷新`
  const days = Math.round(hours / 24)
  return `约 ${days} 天后刷新`
}

/** Absolute reset moment; same-day → "今天 HH:mm", else "M 月 D 日 HH:mm". */
function absoluteReset(resetsAtMs: number, now: number): string {
  const d = new Date(resetsAtMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const nd = new Date(now)
  const sameDay =
    d.getFullYear() === nd.getFullYear() && d.getMonth() === nd.getMonth() && d.getDate() === nd.getDate()
  if (sameDay) return `今天 ${hh}:${mm}`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hh}:${mm}`
}

export function quotaResetText(resetsAtMs: number, now = Date.now()): string {
  return `${relativeReset(resetsAtMs, now)} · ${absoluteReset(resetsAtMs, now)}`
}

export function quotaView(win: CodexRateWindow, now = Date.now()): QuotaView {
  const usedPercent = clampPercent(win.usedPercent)
  const remainPercent = clampPercent(100 - usedPercent)
  const resetsAtMs = win.resetsAt * 1000
  const { label, sub } = windowLabel(win.windowMinutes)
  return {
    label,
    sub,
    remainPercent,
    usedPercent,
    level: levelFor(remainPercent),
    resetRelative: relativeReset(resetsAtMs, now),
    resetAbsolute: absoluteReset(resetsAtMs, now)
  }
}

/**
 * Ordered windows for display: 5h (300) first when present, then weekly, then
 * any others. Null windows are dropped, so a plan that exposes only the weekly
 * window simply renders that one row (both popover and settings show every
 * returned window).
 */
export function orderedWindows(rl: CodexRateLimits | null | undefined): CodexRateWindow[] {
  if (!rl) return []
  const wins = [rl.primary, rl.secondary].filter((w): w is CodexRateWindow => !!w)
  return wins.sort((a, b) => {
    const rank = (m: number): number => (m === 300 ? 0 : m === 10080 ? 1 : 2)
    return rank(a.windowMinutes) - rank(b.windowMinutes)
  })
}

export function orderedSourceWindows(windows: CodexSourceQuotaWindow[]): CodexSourceQuotaWindow[] {
  const rank = (label: string): number => label === '5 小时额度' ? 0 : 1
  return [...windows].sort((a, b) => rank(a.label) - rank(b.label))
}
