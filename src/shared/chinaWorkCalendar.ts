/** 国办发明电〔2025〕7号：2026 年中国大陆放假调休安排。
 * https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
 * 未确认年份返回 null，不能按普通周一至周五猜测调休。
 */
export const CHINA_WORK_CALENDAR_YEARS = [2026] as const
const HOLIDAYS = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'], ['2026-10-01', '2026-10-07']
]
const MAKEUP_WORKDAYS = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'])

export function isChinaWorkday(date: Date): boolean | null {
  if (!Number.isFinite(date.getTime()) || !CHINA_WORK_CALENDAR_YEARS.some(year => year === date.getFullYear())) return null
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (MAKEUP_WORKDAYS.has(key)) return true
  if (HOLIDAYS.some(([start, end]) => key >= start && key <= end)) return false
  return date.getDay() !== 0 && date.getDay() !== 6
}
