import assert from 'node:assert/strict'
import { projectDeepSeekGoal, projectDeepSeekSessionUsage } from '../src/main/deepseekGoalProjection.ts'

const goal = { objective: 'complete native task', phase: 'active', activation: 'armed', maxGoalRounds: 3,
  roundsStarted: 1, createdAt: 1000, updatedAt: 2000 }
const usage = { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 5 }
assert.equal(projectDeepSeekGoal({ goal, usage, autonomous: true })?.autonomous, true)
assert.equal(projectDeepSeekGoal({ goal: { ...goal, activation: 'disarmed' }, usage, autonomous: true })?.autonomous, false)
assert.equal(projectDeepSeekGoal({ goal: { ...goal, phase: 'paused' }, usage, autonomous: true })?.autonomous, false)
assert.deepEqual(projectDeepSeekGoal({ goal, usage })?.roundLimit, { maxRounds: 3, roundsStarted: 1 })
assert.equal(projectDeepSeekGoal({ goal, usage })?.tokenBudget, null)
assert.equal(projectDeepSeekGoal({ goal, usage })?.tokensUsed, 38)
assert.equal(projectDeepSeekSessionUsage(usage)?.contextTokens, undefined)
assert.equal(projectDeepSeekSessionUsage(usage)?.sessionInputTokens, 33)
assert.equal(projectDeepSeekGoal({ goal: null }), undefined)
assert.throws(() => projectDeepSeekGoal({ goal: { ...goal, phase: 'unknown' } }), /无效/)
console.log('deepseek-goal-projection: authority, round limit and cumulative usage passed')
