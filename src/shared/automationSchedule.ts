export type ScheduleDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'custom'

export interface ParsedSchedule {
  ok: boolean
  cronMode: boolean
  cronFields: 5 | 6
  second: number
  freq: ScheduleFrequency
  hour: number
  minute: number
  days: Set<ScheduleDay>
  monthDays: Set<number>
  raw: string
}

const SCHEDULE_DAYS: ScheduleDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

export function nextScheduleRuns(schedule: ParsedSchedule, count = 3, from = new Date()): Date[] {
  if (!schedule.ok || schedule.freq === 'custom' || count < 1) return []
  const runs: Date[] = []
  const jsDay: ScheduleDay[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
  for (let offset = 0; offset < 1100 && runs.length < count; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset,
      schedule.hour, schedule.minute, schedule.second, 0)
    if (candidate <= from || candidate.getHours() !== schedule.hour || candidate.getMinutes() !== schedule.minute) continue
    if (schedule.freq === 'daily' ||
        (schedule.freq === 'weekly' && schedule.days.has(jsDay[candidate.getDay()])) ||
        (schedule.freq === 'monthly' && schedule.monthDays.has(candidate.getDate()))) runs.push(candidate)
  }
  return runs
}
const CRON_DAY_REVERSE: Record<string, ScheduleDay> = {
  '0': 'SU',
  '1': 'MO',
  '2': 'TU',
  '3': 'WE',
  '4': 'TH',
  '5': 'FR',
  '6': 'SA',
  '7': 'SU'
}

function invalidSchedule(raw: string, cronMode = false, cronFields: 5 | 6 = 6): ParsedSchedule {
  return {
    ok: false,
    cronMode,
    cronFields,
    second: 0,
    freq: 'custom',
    hour: 9,
    minute: 0,
    days: new Set<ScheduleDay>(),
    monthDays: new Set<number>(),
    raw
  }
}

function integer(value: string | undefined, min: number, max: number): number | null {
  if (value == null || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return n >= min && n <= max ? n : null
}

function numberSet(value: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>()
  for (const segment of value.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(segment)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < min || end > max || start > end) return null
      for (let n = start; n <= end; n += 1) result.add(n)
      continue
    }
    const n = integer(segment, min, max)
    if (n == null) return null
    result.add(n)
  }
  return result.size ? result : null
}

/** Parse the RRULE and five/six-field cron subset represented by the editor. */
export function parseScheduleExpression(expression: string): ParsedSchedule {
  const raw = expression.trim()
  if (!raw) return invalidSchedule(raw)

  if (/^(?:RRULE:)?FREQ=/i.test(raw)) {
    const fields = new Map<string, string>()
    for (const item of raw.replace(/^RRULE:/i, '').split(';')) {
      const at = item.indexOf('=')
      if (at < 1) return invalidSchedule(raw)
      const key = item.slice(0, at).toUpperCase()
      if (fields.has(key) || !['FREQ', 'BYHOUR', 'BYMINUTE', 'BYDAY', 'BYMONTHDAY'].includes(key)) {
        return invalidSchedule(raw)
      }
      fields.set(key, item.slice(at + 1))
    }
    const rawFreq = fields.get('FREQ')?.toUpperCase()
    const freq: ScheduleFrequency =
      rawFreq === 'DAILY' ? 'daily' : rawFreq === 'WEEKLY' ? 'weekly' : rawFreq === 'MONTHLY' ? 'monthly' : 'custom'
    const hour = fields.has('BYHOUR') ? integer(fields.get('BYHOUR'), 0, 23) : 9
    const minute = fields.has('BYMINUTE') ? integer(fields.get('BYMINUTE'), 0, 59) : 0
    if (freq === 'custom' || hour == null || minute == null) return invalidSchedule(raw)

    const days = new Set<ScheduleDay>()
    if (fields.has('BYDAY')) {
      for (const day of fields.get('BYDAY')!.toUpperCase().split(',')) {
        if (!SCHEDULE_DAYS.includes(day as ScheduleDay)) return invalidSchedule(raw)
        days.add(day as ScheduleDay)
      }
    }
    const monthDays = fields.has('BYMONTHDAY') ? numberSet(fields.get('BYMONTHDAY')!, 1, 31) : new Set<number>()
    if (monthDays == null) return invalidSchedule(raw)
    if ((freq === 'daily' && (days.size > 0 || monthDays.size > 0)) || (freq === 'weekly' && monthDays.size > 0) || (freq === 'monthly' && days.size > 0)) {
      return invalidSchedule(raw)
    }
    if (freq === 'weekly' && days.size === 0) return invalidSchedule(raw)
    if (freq === 'monthly' && monthDays.size === 0) monthDays.add(1)
    return { ok: true, cronMode: false, cronFields: 6, second: 0, freq, hour, minute, days, monthDays, raw }
  }

  const parts = raw.split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) return invalidSchedule(raw)
  const cronFields = parts.length as 5 | 6
  const offset = cronFields === 6 ? 1 : 0
  const second = cronFields === 6 ? integer(parts[0], 0, 59) : 0
  const minute = integer(parts[offset], 0, 59)
  const hour = integer(parts[offset + 1], 0, 23)
  const dom = parts[offset + 2]
  const month = parts[offset + 3]
  const dow = parts[offset + 4]
  if (second == null || minute == null || hour == null || month !== '*') return invalidSchedule(raw, true, cronFields)
  if (dom !== '*' && dow !== '*') return invalidSchedule(raw, true, cronFields)

  const monthDays = dom === '*' ? new Set<number>() : numberSet(dom, 1, 31)
  if (monthDays == null) return invalidSchedule(raw, true, cronFields)
  const days = new Set<ScheduleDay>()
  if (dow !== '*') {
    const cronDays = numberSet(dow, 0, 7)
    if (cronDays == null) return invalidSchedule(raw, true, cronFields)
    for (const n of cronDays) days.add(CRON_DAY_REVERSE[String(n)])
  }
  const freq: ScheduleFrequency = monthDays.size ? 'monthly' : days.size ? 'weekly' : 'daily'
  return { ok: true, cronMode: true, cronFields, second, freq, hour, minute, days, monthDays, raw }
}
