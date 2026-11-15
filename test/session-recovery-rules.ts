import assert from 'node:assert/strict'
import { defaultRecoverySettings, parseRecoverySettings, parseRecoveryDecision, recoveryCandidate, recoveryDelayMs } from '../src/shared/sessionRecovery'

const settings = parseRecoverySettings({ ...defaultRecoverySettings(), enabled: true, agentId: 'codex', model: 'judge',
  selectedErrors: ['capacity'], rules: [
    { id: 'temporary', effect: 'retry', description: '模型暂时繁忙', enabled: true },
    { id: 'auth', effect: 'no-retry', description: '需要重新登录', enabled: true },
    { id: 'disabled', effect: 'retry', description: '停用规则', enabled: false }
  ] })
const decision = (retry: boolean, ids: string[]) => JSON.stringify({ retry, matchedRuleIds: ids, reason: '根据当前错误和执行状态判断。' })

assert.equal(recoveryCandidate(settings, 'capacity', 2), true)
assert.equal(recoveryCandidate(settings, 'capacity', 3), false, 'count limit precedes model invocation')
assert.equal(recoveryCandidate({ ...settings, enabled: false }, 'capacity', 0), false)
assert.equal(recoveryCandidate({ ...settings, rules: [] }, 'unknown', 0), false)
assert.equal(recoveryCandidate(settings, 'unknown', 0), true, 'natural-language matching requires a judge call')
assert.equal(parseRecoveryDecision(decision(true, []), settings, 'capacity').retry, true)
assert.equal(parseRecoveryDecision(decision(false, []), settings, 'capacity').retry, false, 'an inclusion never forces retry')
assert.equal(parseRecoveryDecision(decision(true, ['temporary']), settings, 'unknown').retry, true)
assert.equal(parseRecoveryDecision(decision(true, []), settings, 'unknown').retry, false, 'unknown errors require a positive rule match')
assert.equal(parseRecoveryDecision(decision(true, ['auth', 'temporary']), settings, 'capacity').retry, false, 'deny beats both a selected type and a retry rule')
assert.equal(parseRecoveryDecision(decision(true, ['auth']), settings, 'unknown').retry, false)
assert.equal(parseRecoveryDecision(decision(true, []), { ...settings, selectedErrors: [], rules: settings.rules.filter(rule => rule.effect === 'no-retry') }, 'unknown').retry, false, 'unmatched deny-only rules do not implicitly include all failures')
for (const output of ['', '```json\n{}\n```', '{"retry":"true"}', decision(true, ['disabled']), decision(true, ['invented']),
  JSON.stringify({ retry: true, matchedRuleIds: [], reason: '', command: 'run' })]) {
  assert.throws(() => parseRecoveryDecision(output, settings, 'capacity'))
}
for (const patch of [{ maxRetries: 0 }, { maxRetries: 11 }, { maxRetries: 1.5 }, { initialDelaySeconds: 0 },
  { initialDelaySeconds: 121 }, { model: '' }, { rules: [{ id: 'deny', effect: 'unknown', description: '登录', enabled: true }] },
  { rules: [settings.rules[0], settings.rules[0]] }]) {
  assert.throws(() => parseRecoverySettings({ ...settings, ...patch }))
}
assert.deepEqual([1, 2, 3, 4].map(attempt => recoveryDelayMs(settings, attempt, 0)), [30000, 60000, 120000, 120000])
assert.equal(recoveryDelayMs(settings, 1, 1), 33000)
assert.equal(recoveryDelayMs(settings, 3, 1), 120000)
assert.equal(defaultRecoverySettings().enabled, false)
console.log('PASS recovery rules: limits, natural-language inclusion, deny precedence, invalid output and bounded backoff')
