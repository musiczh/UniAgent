import assert from 'node:assert/strict'
import { modelSourceQuotaProvider } from '../src/shared/modelSourceQuota'
import { sourceDraft, validateModelSource } from '../src/shared/modelSources'
import { normalizeQuotaResponse } from '../src/main/codexSourceQuota'

const source = (baseUrl: string, template = 'auto') => ({ ...sourceDraft('custom'), quotaQuery: { template }, endpoints: [{ id: 'chat', protocol: 'openai-chat' as const, baseUrl, auth: 'bearer' as const }] })
assert.equal(modelSourceQuotaProvider(source('https://api.minimax.io/v1') as any)?.preset, 'minimax')
for (const [base, preset] of [
  ['https://api.minimaxi.com/anthropic', 'minimax-cn'], ['https://api.minimax.cn/v1', 'minimax-cn'],
  ['https://api.siliconflow.cn/v1', 'siliconflow-cn'], ['https://api.siliconflow.com/v1', 'siliconflow'],
  ['https://openrouter.ai/api/v1', 'openrouter'], ['https://api.stepfun.com/v1', 'stepfun'], ['https://api.novita.ai/v3/openai', 'novita'],
  ['https://api.kimi.ai/coding/v1', 'kimi-code-global']
]) assert.equal(modelSourceQuotaProvider(source(base) as any)?.preset, preset)
for (const base of ['https://api.minimax.io.attacker.test/v1', 'https://attacker.test/api.minimax.io/v1', 'https://user:pass@api.minimax.io/v1', 'http://api.minimax.io/v1', 'https://api.minimax.io:8443/v1', 'https://api.minimax.io/unrelated']) {
  assert.equal(modelSourceQuotaProvider(source(base) as any), undefined, base)
}
assert.equal(modelSourceQuotaProvider(source('https://proxy.example/v1', 'openrouter') as any), undefined, 'manual provider selection never sends a proxy key to an official host')
assert.equal(modelSourceQuotaProvider(source('https://proxy.example/v1', 'sub2api') as any)?.baseUrl, 'https://proxy.example/v1')
assert.equal(modelSourceQuotaProvider(source('https://proxy.example/v1', 'new-api') as any)?.preset, 'new-api')
assert.equal(modelSourceQuotaProvider(source('https://api.deepseek.com', 'console') as any), undefined)
assert.equal(modelSourceQuotaProvider(sourceDraft('ark-coding-plan', 'coding'))?.preset, 'ark-coding-plan')
assert.equal(modelSourceQuotaProvider(sourceDraft('ark-coding-plan', 'agent'))?.preset, 'ark-agent-plan')
for (const query of [{ template: 'execute-script' }, { template: 'new-api', unit: 'USD' }, { template: 'new-api', quotaPerUnit: 0 }, { template: 'new-api', userId: '1\r\nX: value' }]) {
  assert.throws(() => validateModelSource({ ...source('https://proxy.example/v1'), quotaQuery: query } as any), /额度|查询|用户/)
}
assert.deepEqual((validateModelSource({ ...source('https://proxy.example/v1'), quotaQuery: { template: 'new-api', userId: '12', unit: 'USD', quotaPerUnit: 500000 } } as any) as any).quotaQuery, { template: 'new-api', userId: '12', unit: 'USD', quotaPerUnit: 500000 })
const parse = (preset: string, raw: unknown, query?: any) => (normalizeQuotaResponse as any)(preset, raw, 1234, query)
const mini = { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'video', current_interval_remaining_percent: 1 }, { model_name: 'general', current_interval_remaining_percent: 75, current_weekly_status: 2, current_weekly_remaining_percent: 0, end_time: 1794931200000 }] }
assert.deepEqual(parse('minimax', mini).windows.map((window: any) => [window.label, window.usedPercent]), [['5 小时额度', 25], ['每周额度', 100]])
assert.equal(parse('minimax-cn', { ...mini, model_remains: [{ ...mini.model_remains[1], current_weekly_status: 3 }] }).windows.length, 1)
assert.throws(() => parse('minimax', { base_resp: { status_code: 1004 }, model_remains: mini.model_remains }), /额度/)
assert.throws(() => parse('minimax', { model_remains: [{ model_name: 'general' }] }), /额度/)
assert.equal(parse('siliconflow-cn', { code: 20000, data: { totalBalance: '12.5', chargeBalance: '10', balance: '2.5' } }).balances[0].total, '12.5')
assert.equal(parse('siliconflow', { code: 20000, data: { totalBalance: '0' } }).balances[0].currency, 'USD')
assert.equal(parse('openrouter', { data: { total_credits: 10, total_usage: 12 } }).balances[0].total, '-2')
assert.equal(parse('stepfun', { balance: '30', total_cash_balance: '20', total_voucher_balance: '10' }).balances[0].currency, 'CNY')
assert.equal(parse('novita', { availableBalance: 125001 }).balances[0].total, '12.5001')
for (const preset of ['siliconflow', 'openrouter', 'stepfun', 'novita']) assert.throws(() => parse(preset, {}), /额度/)
assert.throws(() => parse('siliconflow', { code: 40100, data: { totalBalance: 100 } }), /额度/)
const coding = parse('ark-coding-plan', { Result: { QuotaUsage: [{ Level: 'session', Percent: 0, ResetTimestamp: -1 }, { Level: 'weekly', Percent: 58, ResetTimestamp: 1795392000 }, { Level: 'monthly', Percent: 92 }] } })
assert.deepEqual(coding.windows.map((window: any) => window.usedPercent), [0, 58, 92])
assert.equal(coding.windows[0].resetsAt, undefined)
assert.equal(coding.windows[1].resetsAt, 1795392000000)
const agent = parse('ark-agent-plan', { Result: { PlanType: 'Large', AFPFiveHour: { Quota: 50, Used: 12.5 }, AFPWeekly: { Quota: 500, Used: 150 }, AFPMonthly: { Quota: 2000, Used: 850.5 }, AFPDaily: { Quota: 100, Used: 50 } } })
assert.deepEqual(agent.windows.map((window: any) => window.usedPercent), [25, 30, 42.525])
assert.match(agent.planType, /Agent Plan/)
assert.throws(() => parse('ark-coding-plan', { Result: { AFPFiveHour: { Quota: 100, Used: 10 } } }), /额度/)
assert.throws(() => parse('ark-agent-plan', { Result: { QuotaUsage: [{ Level: 'weekly', Percent: 10 }] } }), /额度/)
for (const raw of [{ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'fixture-secret-must-not-leak' } } }, { Result: { QuotaUsage: [{ Level: 'weekly' }] } }]) {
  assert.throws(() => parse('ark-coding-plan', raw), error => error instanceof Error && /额度/.test(error.message) && !error.message.includes('fixture-secret'))
}
assert.deepEqual(parse('sub2api', { isValid: true, planName: 'Unlimited', remaining: -1, unit: 'USD' }).amount, { unit: 'USD', unlimited: true })
assert.equal(parse('sub2api', { remaining: 8, quota: { limit: 10, used: 2, unit: 'USD' } }).amount.remaining, 8)
assert.throws(() => parse('sub2api', { isValid: false, remaining: 100 }), /额度/)
assert.throws(() => parse('sub2api', {}), /额度/)
const newApi = { success: true, data: { group: 'team', quota: 1000000, used_quota: 500000 } }
assert.deepEqual(parse('new-api', newApi).amount, { remaining: 1000000, used: 500000, total: 1500000, unit: '额度' })
assert.deepEqual(parse('new-api', newApi, { template: 'new-api', unit: 'USD', quotaPerUnit: 500000 }).amount, { remaining: 2, used: 1, total: 3, unit: 'USD' })
assert.throws(() => parse('new-api', { success: false, data: newApi.data }), /额度/)
console.log('model-source-quota-providers: provider identity, origin boundaries, plan separation and query configuration passed')
