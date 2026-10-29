import type { GoalState } from '../shared/nativeCapabilities.ts'
import type { TurnUsage } from '../shared/types.ts'

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

/** Native projection is cumulative; never use it as the current context occupancy. */
export function projectDeepSeekSessionUsage(value: unknown): TurnUsage | undefined {
  if (!record(value) || !Number.isSafeInteger(value.uncachedInputTokens) || !Number.isSafeInteger(value.outputTokens)) return undefined
  const cachedInputTokens = count(value.cacheReadTokens)
  const inputTokens = count(value.uncachedInputTokens) + cachedInputTokens + count(value.cacheWriteTokens)
  return { inputTokens, outputTokens: count(value.outputTokens), cachedInputTokens,
    cacheCreationInputTokens: count(value.cacheWriteTokens), sessionInputTokens: inputTokens,
    sessionOutputTokens: count(value.outputTokens), sessionCachedInputTokens: cachedInputTokens }
}

/** Durable phase and live continuation authority are separate in the official SDK. */
export function projectDeepSeekGoal(value: unknown): GoalState | undefined {
  if (!record(value) || !record(value.goal)) return undefined
  const goal = value.goal
  if (typeof goal.objective !== 'string' || !['active', 'paused', 'blocked', 'complete'].includes(goal.phase) ||
      !['armed', 'disarmed'].includes(goal.activation)) throw new Error('DeepSeek 返回了无效目标状态')
  const usage = projectDeepSeekSessionUsage(value.usage)
  return {
    objective: goal.objective, status: goal.phase, tokenBudget: null,
    tokensUsed: usage ? usage.inputTokens + usage.outputTokens : 0,
    timeUsedSeconds: 0, createdAt: count(goal.createdAt), updatedAt: count(goal.updatedAt),
    continuation: 'native', autonomous: value.autonomous === true && goal.phase === 'active' && goal.activation === 'armed',
    nativeActivation: goal.activation,
    roundLimit: { maxRounds: Number.isSafeInteger(goal.maxGoalRounds) && goal.maxGoalRounds > 0 ? goal.maxGoalRounds : null,
      roundsStarted: count(goal.roundsStarted) },
    ...(record(goal.blockedReason) && typeof goal.blockedReason.code === 'string' && typeof goal.blockedReason.message === 'string'
      ? { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } } : {})
  }
}
