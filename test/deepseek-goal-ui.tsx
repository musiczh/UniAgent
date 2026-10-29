import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GoalStatusBar, GoalUsageRecord, displayedGoalTimeSeconds } from '../src/renderer/components/GoalStatusBar.tsx'
import * as goalUI from '../src/renderer/components/GoalStatusBar.tsx'
import * as composerUI from '../src/renderer/components/Composer.tsx'
import { parseNativeThreadAction, type GoalState } from '../src/shared/nativeCapabilities.ts'

const goal: GoalState = { objective: 'native fixture', status: 'active', tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2, continuation: 'native', autonomous: false, nativeActivation: 'disarmed', roundLimit: { maxRounds: 3, roundsStarted: 1 } }
const render = (value: GoalState) => renderToStaticMarkup(createElement(GoalStatusBar, { goal: value, running: true }))
assert.match(render(goal), /待继续/)
assert.match(render({ ...goal, autonomous: true }), /自动执行/)
assert.match(render({ ...goal, status: 'paused' }), /已暂停/)
assert.equal(displayedGoalTimeSeconds(goal, 5000, true), 3, 'disarmed native Goal does not accrue execution time')
assert.equal(displayedGoalTimeSeconds({ ...goal, autonomous: true }, 5000, true), 3, 'native timestamps are not execution duration')
const nativeUsage = renderToStaticMarkup(createElement(GoalUsageRecord, { goal, now: 5000, live: true }))
assert.match(nativeUsage, /会话累计 10 Token/)
assert.match(nativeUsage, /已运行 1 \/ 3 回合/)
assert.doesNotMatch(nativeUsage, /执行时间|已使用/)
assert.match(render({ ...goal, status: 'complete' }), /会话累计 10 Token/)
for (const provider of ['kimi', 'grok']) {
  const measuredNativeUsage = renderToStaticMarkup(createElement(GoalUsageRecord, { goal, now: 5000, live: true, provider }))
  assert.match(measuredNativeUsage, /已使用 10 Token/)
  assert.match(measuredNativeUsage, /执行时间 3 秒/)
  assert.doesNotMatch(measuredNativeUsage, /会话累计/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(GoalStatusBar, { goal: { ...goal, status: 'complete' }, provider })), /会话累计/)
}
const measuredGoal = { ...goal, continuation: undefined }
assert.equal(displayedGoalTimeSeconds(measuredGoal, 5000, true), 6)
assert.match(renderToStaticMarkup(createElement(GoalUsageRecord, { goal: measuredGoal, now: 5000, live: true })), /执行时间 6 秒/)

assert.equal(typeof goalUI.goalRoundProgress, 'function')
assert.equal(goalUI.goalRoundProgress(goal), '已运行 1 / 3 回合')
assert.equal(goalUI.goalRoundProgress({ ...goal, roundLimit: { maxRounds: null, roundsStarted: 2 } }), '已运行 2 回合')
assert.equal(goalUI.goalRoundProgress({ ...goal, continuation: undefined }), undefined)

assert.equal(typeof composerUI.buildNativeGoalRoundLimit, 'function')
assert.deepEqual(composerUI.buildNativeGoalRoundLimit(''), {})
assert.deepEqual(composerUI.buildNativeGoalRoundLimit(' 3 '), { maxRounds: 3 })
for (const invalid of ['0','-1','1.5','abc','9007199254740992']) assert.throws(() => composerUI.buildNativeGoalRoundLimit(invalid), /回合/)
const action = { type: 'goal.set', objective: 'finish fixture', ...composerUI.buildNativeGoalRoundLimit('3') }
assert.deepEqual(parseNativeThreadAction(action), action)
assert.equal('tokenBudget' in action, false, 'round limit must never masquerade as Token budget')
const options = renderToStaticMarkup(createElement(composerUI.NativeGoalOptions, { value:'3', disabled:false, onChange:()=>{} }))
assert.match(options, /aria-label="DeepSeek Goal 最多回合"/)
assert.match(options, /min="1"/)
assert.match(options, /value="3"/)
assert.doesNotMatch(options, /Token|tokenBudget/)
assert.match(renderToStaticMarkup(createElement(composerUI.NativeGoalOptions, { value:'', disabled:true, onChange:()=>{} })), /disabled=""/)

// Each native provider accepts a different Goal limit. Retaining both drafts
// during provider changes must never reinterpret rounds as Token or vice versa.
assert.equal(typeof composerUI.buildNativeGoalLimits, 'function')
assert.deepEqual(composerUI.buildNativeGoalLimits('deepseek', { maxRounds:'3', tokenBudget:'1200' }), { maxRounds:3 })
assert.deepEqual(composerUI.buildNativeGoalLimits('grok', { maxRounds:'3', tokenBudget:'1200' }), { tokenBudget:1200 })
assert.deepEqual(composerUI.buildNativeGoalLimits('mcode', { maxRounds:'3', tokenBudget:'1200' }), { tokenBudget:1200 })
for (const invalid of ['0', '-1', '1.5', 'abc', '9007199254740992']) assert.throws(() => composerUI.buildNativeGoalLimits('mcode', { tokenBudget:invalid }), /Token 预算/)
assert.deepEqual(composerUI.buildNativeGoalLimits('kimi', { maxRounds:'3', tokenBudget:'1200' }), {})
assert.deepEqual(composerUI.buildNativeGoalLimits('grok', { maxRounds:'invalid', tokenBudget:'' }), {})
assert.deepEqual(composerUI.buildNativeGoalLimits('deepseek', { maxRounds:'', tokenBudget:'invalid' }), {})
assert.deepEqual(composerUI.buildNativeGoalLimits('kimi', { maxRounds:'invalid', tokenBudget:'invalid' }), {})
for (const invalid of ['0','-1','1.5','abc','9007199254740992']) assert.throws(() => composerUI.buildNativeGoalLimits('grok', { tokenBudget:invalid }), /Token 预算/)
const grokAction = { type:'goal.set', objective:'finish fixture', ...composerUI.buildNativeGoalLimits('grok', { tokenBudget:' 1200 ' }) }
assert.deepEqual(parseNativeThreadAction(grokAction), grokAction)
assert.equal('maxRounds' in grokAction, false)
const grokOptions = renderToStaticMarkup(createElement(composerUI.NativeGoalOptions, { provider:'grok', value:'1200', disabled:false, onChange:()=>{} }))
assert.match(grokOptions, /aria-label="Grok Goal Token 预算"/)
assert.match(grokOptions, /min="1"/)
assert.match(grokOptions, /value="1200"/)
assert.doesNotMatch(grokOptions, /最多回合/)
const kimiOptions = renderToStaticMarkup(createElement(composerUI.NativeGoalOptions, { provider:'kimi', value:'1200', disabled:false, onChange:()=>{} }))
assert.match(kimiOptions, /原生 Goal.*预算不可设置/)
assert.doesNotMatch(kimiOptions, /<input/)
console.log('Native Goal UI: activation, cumulative usage, provider-specific validated limits passed')
