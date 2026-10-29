/** Match an explicit exhausted allowance, never a bare HTTP status or "quota" mention. */
export function isProviderQuotaExceeded(message: string): boolean {
  return /\b(?:you(?:['’]ve| have) (?:hit|reached)|you exceeded) your (?:[\w-]+ )?usage limit\b/i.test(message) ||
    /\b(?:insufficient_quota|usage_limit_exceeded|usageLimitExceeded|quota_exceeded)\b/.test(message) ||
    /\b(?:quota|usage limit) (?:has been |is )?(?:exceeded|exhausted|reached)\b/i.test(message) ||
    /(?:额度|用量|配额)(?:或用量)?(?:已达上限|已耗尽|已用尽|不足)/.test(message)
}

/** Request throttling is not the same as an exhausted subscription allowance. */
export function isProviderRateLimited(message: string): boolean {
  return /\brate[ _-]limit(?:ed|ing|_exceeded)?\b|\btoo many requests\b|请求过于频繁|请求频率超限/i.test(message)
}

/** Some compatible providers mislabel a context overflow as an authentication error. */
export function providerContextLimit(message: unknown): { model?: string; tokens?: number } | undefined {
  if (typeof message !== 'string') return undefined
  const limit = /Your request exceeded ([\w.:/-]+) model token limit:\s*(\d+)/i.exec(message)
  if (limit) {
    const tokens = Number(limit[2])
    return { model: limit[1], ...(Number.isSafeInteger(tokens) && tokens > 0 ? { tokens } : {}) }
  }
  if (/\bcontext_length_exceeded\b|input exceeds the context window|maximum context length|ran out of room in the model's context window/i.test(message)) return {}
  return undefined
}
