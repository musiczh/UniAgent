import type { KabooPeriod, KabooUsageQuery } from './types'

const PERIODS = new Set<KabooPeriod>(['day', 'week', 'month', 'year', 'all'])
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function isTokenUsageDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function dayNumber(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

function utcWeekday(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function isNaturalRange(period: Exclude<KabooPeriod, 'all'>, start: string, end: string): boolean {
  const [startYear, startMonth, startDay] = start.split('-').map(Number)
  const [endYear, endMonth, endDay] = end.split('-').map(Number)
  if (period === 'day') return start === end
  if (period === 'week') return utcWeekday(start) === 1 && utcWeekday(end) === 0 && dayNumber(end) - dayNumber(start) === 6
  if (period === 'month') {
    const lastDay = new Date(Date.UTC(startYear, startMonth, 0)).getUTCDate()
    return startDay === 1 && startYear === endYear && startMonth === endMonth && endDay === lastDay
  }
  // Kaboo caps a range at 365 days, so a leap year arrives as Jan 1 + 365 days
  // (ends Dec 30) rather than the full 366-day calendar year; accept both shapes.
  return startMonth === 1 && startDay === 1 && startYear === endYear &&
    endMonth === 12 && (endDay === 31 || dayNumber(end) - dayNumber(start) === 364)
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function validateTokenUsageQuery(value: unknown): KabooUsageQuery | undefined {
  const query = record(value)
  if (!query || !PERIODS.has(query.period as KabooPeriod) || !validTimeZone(query.timeZone) ||
      !validInstant(query.now)) return undefined

  const period = query.period as KabooPeriod
  const expectedKeys = period === 'all' ? ['now', 'period', 'timeZone'] : ['end', 'now', 'period', 'start', 'timeZone']
  if (Object.keys(query).sort().join() !== expectedKeys.join()) return undefined
  if (period === 'all') {
    return { period, now: query.now, timeZone: query.timeZone }
  }
  if (!isTokenUsageDate(query.start) || !isTokenUsageDate(query.end)) return undefined
  const days = dayNumber(query.end) - dayNumber(query.start) + 1
  const expected = period === 'day' ? [1, 1] : period === 'week' ? [7, 7] : period === 'month' ? [28, 31] : [365, 366]
  if (days < expected[0] || days > expected[1] || !isNaturalRange(period, query.start, query.end) ||
      query.start > localDate(query.now, query.timeZone)) return undefined
  return { period, start: query.start, end: query.end, now: query.now, timeZone: query.timeZone }
}
