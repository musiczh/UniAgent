/**
 * DeepSeek API list prices (USD per 1M tokens) used to fill the per-turn 费用
 * column. The DeepSeek Harness reports only token buckets (uncached input,
 * cache read, cache write, output) — no billed amount — so the UI cost is an
 * estimate computed here.
 *
 * Official English pricing page (fetched 2026-10-19):
 *   https://api-docs.deepseek.com/quick_start/pricing
 *
 * Rules included:
 *  - cache-hit input, cache-miss input and output have separate rates;
 *  - peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding
 *    Chinese public holidays; every other moment is off-peak;
 *  - off-peak rates are exactly half of the peak rates;
 *  - cache writes are billed at the cache-miss input rate (DeepSeek has no
 *    separate cache-write price).
 *
 * Prices are the peak rates; `deepseekCost` halves them off-peak.
 */

export interface DeepSeekTokenUsage {
  /** Prompt tokens that missed the cache (the provider's uncached input). */
  uncachedInputTokens: number
  /** Prompt tokens that hit the cache. */
  cacheReadTokens?: number
  /** Prompt tokens written to the cache; billed as cache-miss input. */
  cacheWriteTokens?: number
  /** Completion tokens (reasoning tokens are already included). */
  outputTokens: number
}

/** Peak-hour USD price per 1M tokens. */
interface DeepSeekPrice {
  inputMiss: number
  inputHit: number
  output: number
}

const PRICES: Record<string, DeepSeekPrice> = {
  'deepseek-flash': { inputMiss: 0.3, inputHit: 0.006, output: 1.2 },
  'deepseek-v4-pro': { inputMiss: 1.32, inputHit: 0.044, output: 3.96 }
}

/** Legacy model names still accepted by the API and billed at the Flash price. */
const ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
}

/**
 * Chinese public holidays for 2025-2026 (国办发明电〔2024〕12号 and
 * 国办发明电〔2025〕7号). DeepSeek treats these weekdays as off-peak. Extend
 * the list when the State Council publishes the next year's schedule; outside
 * known dates only the weekday/hour rule is applied.
 */
const CN_HOLIDAYS = new Set([
  ...holidayRange('2025-01-01', 1),
  ...holidayRange('2025-01-28', 8),
  ...holidayRange('2025-04-04', 3),
  ...holidayRange('2025-05-01', 5),
  ...holidayRange('2025-05-31', 3),
  ...holidayRange('2025-10-01', 8),
  ...holidayRange('2026-01-01', 3),
  ...holidayRange('2026-02-15', 9),
  ...holidayRange('2026-04-04', 3),
  ...holidayRange('2026-05-01', 5),
  ...holidayRange('2026-06-19', 3),
  ...holidayRange('2026-09-25', 3),
  ...holidayRange('2026-10-01', 7)
])

function holidayRange(start: string, days: number): string[] {
  const out: string[] = []
  const date = new Date(`${start}T00:00:00.000Z`)
  for (let i = 0; i < days; i += 1) {
    out.push(date.toISOString().slice(0, 10))
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return out
}

/** True while DeepSeek's peak-hour list price applies. */
export function isDeepSeekPeak(at: number | Date): boolean {
  const date = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(date.getTime())) return false
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  if (CN_HOLIDAYS.has(date.toISOString().slice(0, 10))) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * Resolve a model id from a Harness route (`["deepseek-official","deepseek-flash"]`)
 * or a plain model id. Returns the canonical priced id, or the lower-cased id
 * when it is not a known DeepSeek model.
 */
export function deepseekModelId(value: string | undefined): string | undefined {
  if (!value) return undefined
  let id = value.trim()
  if (!id) return undefined
  if (id.startsWith('[')) {
    try {
      const parsed = JSON.parse(id)
      if (!Array.isArray(parsed)) return undefined
      id = [...parsed].reverse().find(part => typeof part === 'string' && part.trim())?.trim() || ''
    } catch {
      return undefined
    }
  }
  if (!id) return undefined
  id = id.toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  return ALIASES[id] ?? id
}

/**
 * Estimated USD cost for one provider usage sample. Returns null when the route
 * is not a known DeepSeek model, so the UI keeps showing `—` instead of a
 * misleading zero.
 */
export function deepseekCost(
  usage: DeepSeekTokenUsage,
  model: string | undefined,
  at: number | Date
): number | null {
  const price = PRICES[deepseekModelId(model) ?? '']
  if (!price) return null
  const count = (value: number | undefined): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  const miss = count(usage.uncachedInputTokens) + count(usage.cacheWriteTokens)
  const hit = count(usage.cacheReadTokens)
  const output = count(usage.outputTokens)
  const factor = isDeepSeekPeak(at) ? 1 : 0.5
  const cost = ((miss * price.inputMiss) + (hit * price.inputHit) + (output * price.output)) * factor / 1e6
  return Number.isFinite(cost) ? cost : null
}
