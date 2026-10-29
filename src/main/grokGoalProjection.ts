import type { GoalState } from '../shared/nativeCapabilities.ts'

type JsonRecord = Record<string, any>
export interface GrokGoalProjectionOptions { previous?: GoalState; nativeTimestamp?: number }
export type GrokGoalCommand = { objective: string; tokenBudget?: number; maxRounds?: number } | 'status' | 'pause' | 'resume' | 'clear'
const identities = new WeakMap<GoalState, string>()
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
const epoch = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return 0
  return count(Date.parse(value))
}
const invalid = (): never => { throw new Error('Grok 返回了无效目标状态') }

/** Project native Goal use and elapsed time; session usage is a separate cumulative counter. */
export function projectGrokGoal(value: unknown, options: GrokGoalProjectionOptions = {}): GoalState | undefined {
  if (!record(value)) return undefined
  const envelope = record(value.params) ? value.params : record(value.result) ? value.result : value
  const notification = record(envelope.update) ? envelope.update : envelope
  const live = notification.sessionUpdate === 'goal_updated'
  const goal = live ? notification : envelope.goal
  if (goal === null || goal === undefined) return undefined
  if (!record(goal)) return invalid()
  if (goal.status === 'cleared') return undefined
  if (typeof goal.goal_id !== 'string' || !goal.goal_id || typeof goal.objective !== 'string' || !goal.objective.trim() ||
      !['active', 'infra_paused', 'no_progress_paused', 'user_paused', 'blocked', 'complete', 'budget_limited'].includes(goal.status) || goal.planning !== undefined && typeof goal.planning !== 'boolean') return invalid()
  const same = !!options.previous && identities.get(options.previous) === goal.goal_id
  const history = Array.isArray(goal.history) ? goal.history.filter(record) : []
  const historyAt = Math.max(0, ...history.map(entry => epoch(entry.timestamp)))
  const eventAt = live ? epoch(goal.last_event_timestamp) : historyAt
  const nativeTimestamp = count(options.nativeTimestamp) || count(envelope._meta?.agentTimestampMs)
  const updatedAt = nativeTimestamp || (live ? eventAt : epoch(envelope.summary?.updated_at) || historyAt)
  // Persisted status can lag notification epochs even when the session summary was saved later.
  if (same && !live && eventAt > 0 && eventAt < options.previous!.updatedAt) {
    const persistedCreated = epoch(goal.created_at)
    if (persistedCreated && persistedCreated < options.previous!.createdAt) {
      const corrected = { ...options.previous!, createdAt: persistedCreated }
      identities.set(corrected, goal.goal_id)
      return corrected
    }
    return options.previous
  }
  if (same && live && updatedAt > 0 && updatedAt < options.previous!.updatedAt) return options.previous
  const nativeCreated = epoch(goal.created_at) || (live && goal.last_event === 'goal_created' ? eventAt :
    epoch(history.find(entry => entry.event === 'goal_created')?.timestamp))
  const createdAt = live && same && options.previous!.createdAt > 0 ? options.previous!.createdAt : nativeCreated || (same ? options.previous!.createdAt : 0)
  const pauseMessage = typeof goal.pause_message === 'string' ? goal.pause_message : typeof goal.last_event_detail === 'string'
    ? goal.last_event_detail : typeof history.at(-1)?.detail === 'string' ? history.at(-1)!.detail : undefined
  const state: GoalState = {
    objective: goal.objective, status: goal.status === 'active' ? 'active' : goal.status === 'complete' ? 'complete'
      : goal.status === 'budget_limited' ? 'budgetLimited' : goal.status === 'blocked' ? 'blocked' : 'paused',
    tokenBudget: Number.isSafeInteger(goal.token_budget) && goal.token_budget > 0 ? goal.token_budget : null,
    tokensUsed: count(live ? goal.tokens_used : goal.tokens_used_high_water), timeUsedSeconds: count(goal.elapsed_ms) / 1000,
    createdAt, updatedAt, continuation: 'native', autonomous: goal.status === 'active',
    ...(['infra_paused', 'no_progress_paused', 'blocked'].includes(goal.status) ? { blockedReason: { code: typeof goal.evaluator_blocker_key === 'string' && goal.evaluator_blocker_key.trim() ? goal.evaluator_blocker_key : goal.status, ...(pauseMessage ? { message: pauseMessage } : {}) } } : {})
  }
  identities.set(state, goal.goal_id)
  return state
}

/** Grok splits the final --budget; quotes and newlines stay literal in the objective. */
export function buildGrokGoalCommand(request: GrokGoalCommand): string {
  if (typeof request === 'string') {
    if (!['status', 'pause', 'resume', 'clear'].includes(request)) throw new Error('Grok 不支持此目标操作')
    return `/goal ${request}`
  }
  if (!record(request) || Object.keys(request).some(key => !['objective', 'tokenBudget', 'maxRounds'].includes(key)) ||
      typeof request.objective !== 'string' || !request.objective.trim() || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(request.objective) ||
      request.tokenBudget === undefined && /--budget/.test(request.objective) ||
      ['status', 'pause', 'resume', 'clear'].includes(request.objective.trim().toLowerCase()) ||
      request.tokenBudget !== undefined && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0)) {
    throw new Error('无效的 Grok 目标请求')
  }
  if (request.maxRounds !== undefined) throw new Error('Grok 原生目标不支持回合上限')
  return `/goal ${request.objective.trim()}${request.tokenBudget === undefined ? '' : ` --budget ${request.tokenBudget}`}`
}
