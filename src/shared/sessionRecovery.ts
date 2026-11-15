/** User rules describe candidates; execution limits always remain host-owned. */
export interface RecoveryRule {
  id: string
  effect: 'retry' | 'no-retry'
  description: string
  enabled: boolean
}

export interface RecoverySettings {
  enabled: boolean
  agentId: string
  model: string
  maxRetries: number
  initialDelaySeconds: number
  selectedErrors: string[]
  rules: RecoveryRule[]
}

export interface RecoveryErrorType {
  key: string
  agentId: string
  label: string
  message: string
  count: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface RecoveryDecision {
  retry: boolean
  matchedRuleIds: string[]
  reason: string
}

export interface RecoveryProgress {
  chainId: string
  phase: 'judging' | 'waiting' | 'retrying' | 'stopped'
  attempts: number
  maxRetries: number
  reason: string
  nextRetryAt?: number
  matchedRuleIds: string[]
}

export function defaultRecoverySettings(): RecoverySettings {
  return { enabled: false, agentId: '', model: '', maxRetries: 3, initialDelaySeconds: 30, selectedErrors: [], rules: [] }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim())) throw new Error('恢复设置包含无效文本')
  return value.trim()
}

/** Reject malformed deny rules instead of silently removing their constraints. */
export function parseRecoverySettings(value: unknown): RecoverySettings {
  if (!object(value) || typeof value.enabled !== 'boolean') throw new Error('恢复设置格式无效')
  const agentId = text(value.agentId, 100, true)
  const model = text(value.model, 1000, true)
  if (!Number.isInteger(value.maxRetries) || Number(value.maxRetries) < 1 || Number(value.maxRetries) > 10) throw new Error('重试次数必须为 1～10 的整数')
  if (!Number.isInteger(value.initialDelaySeconds) || Number(value.initialDelaySeconds) < 5 || Number(value.initialDelaySeconds) > 120) throw new Error('初始等待时间必须为 5～120 秒的整数')
  if (!Array.isArray(value.selectedErrors) || value.selectedErrors.length > 100) throw new Error('错误类型最多选择 100 个')
  const selectedErrors = [...new Set(value.selectedErrors.map(key => text(key, 200)))]
  if (!Array.isArray(value.rules) || value.rules.length > 50) throw new Error('自然语言规则最多添加 50 条')
  const ids = new Set<string>()
  const rules = value.rules.map(raw => {
    if (!object(raw) || !['retry', 'no-retry'].includes(String(raw.effect)) || typeof raw.enabled !== 'boolean') throw new Error('自然语言规则格式无效')
    const id = text(raw.id, 100)
    if (ids.has(id)) throw new Error('规则标识重复')
    ids.add(id)
    return { id, effect: raw.effect as RecoveryRule['effect'], description: text(raw.description, 2000), enabled: raw.enabled }
  })
  if (value.enabled && (!agentId || !model)) throw new Error('开启自动恢复前请选择判断 Agent 和模型')
  return { enabled: value.enabled, agentId, model, maxRetries: Number(value.maxRetries), initialDelaySeconds: Number(value.initialDelaySeconds), selectedErrors, rules }
}

export function recoveryCandidate(settings: RecoverySettings, errorKey: string, attempts: number): boolean {
  return settings.enabled && attempts < settings.maxRetries &&
    (settings.selectedErrors.includes(errorKey) || settings.rules.some(rule => rule.enabled))
}

/** A positive decision needs an explicit inclusion; deny matches always win. */
export function parseRecoveryDecision(output: string, settings: RecoverySettings, errorKey: string): RecoveryDecision {
  if (output.length > 8192) throw new Error('恢复判断结果过长')
  let value: unknown
  try { value = JSON.parse(output) } catch { throw new Error('恢复判断未返回有效 JSON') }
  if (!object(value) || typeof value.retry !== 'boolean' || !Array.isArray(value.matchedRuleIds) ||
      Object.keys(value).some(key => !['retry', 'matchedRuleIds', 'reason'].includes(key))) throw new Error('恢复判断结果格式无效')
  const reason = text(value.reason, 500)
  const rules = new Map(settings.rules.filter(rule => rule.enabled).map(rule => [rule.id, rule]))
  const matchedRuleIds = [...new Set(value.matchedRuleIds.map(id => {
    const key = text(id, 100)
    if (!rules.has(key)) throw new Error('恢复判断引用了不存在或已停用的规则')
    return key
  }))]
  const denied = matchedRuleIds.some(id => rules.get(id)!.effect === 'no-retry')
  const included = settings.selectedErrors.includes(errorKey) || matchedRuleIds.some(id => rules.get(id)!.effect === 'retry')
  return { retry: value.retry && !denied && included, matchedRuleIds,
    reason: denied ? '命中“不重试”规则。' + reason : !included ? '未命中已选择的错误类型或“重试”规则。' : reason }
}

/** attempt is one-based; jitter avoids synchronized retries across sessions. */
export function recoveryDelayMs(settings: RecoverySettings, attempt: number, random = Math.random()): number {
  const base = Math.min(120, settings.initialDelaySeconds * 2 ** Math.max(0, attempt - 1)) * 1000
  return Math.round(Math.min(120000, base * (1 + Math.max(0, Math.min(1, random)) * 0.1)))
}
