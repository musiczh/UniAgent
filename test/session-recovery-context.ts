import assert from 'node:assert/strict'
import { recoveryBlocked, recoveryError, recoveryPrompt, recoveryText, type RecoveryFailure } from '../src/main/recoveryContext'
import { defaultRecoverySettings } from '../src/shared/sessionRecovery'

const failure: RecoveryFailure = { sessionId: 'local-session', failureId: 'attempt-1', agentId: 'codex', model: 'execution-model',
  nativeSessionId: 'native-session', message: '<span>Selected model is at capacity. Please try a different model.</span>',
  delivery: 'accepted', terminal: true, interrupted: false, nativeRetrying: false }
assert.equal(recoveryError(failure).key, 'codex:capacity')
assert.equal(recoveryError(failure).message.includes('<span>'), false)
assert.equal(recoveryError({ ...failure, agentId: 'claude' }).key, 'claude:capacity')
assert.notEqual(recoveryError({ ...failure, message: 'HTTP 429 insufficient_quota' }).key, recoveryError({ ...failure, message: 'HTTP 429 rate_limit_exceeded' }).key)
assert.equal(recoveryError({ ...failure, message: 'Unknown failure request_id=abc at 2026-11-03T11:32:00Z' }).key,
  recoveryError({ ...failure, message: 'Unknown failure request_id=def at 2026-11-03T12:34:12Z' }).key)
assert.notEqual(recoveryError({ ...failure, message: 'invalid model A' }).key, recoveryError({ ...failure, message: 'invalid model B' }).key)
assert.equal(recoveryBlocked(failure), undefined)
for (const patch of [{ interrupted: true }, { terminal: false }, { nativeRetrying: true }, { blocked: true }, { nativeSessionId: undefined }, { delivery: 'unknown' as const }]) {
  assert.ok(recoveryBlocked({ ...failure, ...patch }))
}
assert.equal(recoveryBlocked({ ...failure, nativeSessionId: undefined, delivery: 'not-accepted' }), undefined)
const secret = 'sensitive-fixture-value'
const sanitized = recoveryText(`&lt;span&gt;error&lt;/span&gt; Bearer ${secret} api_key="${secret}" https://user:${secret}@example.test/error?credential=${secret} /Users/private/project`)
assert.ok(!sanitized.includes(secret))
assert.ok(!sanitized.includes('private'))
assert.ok(!sanitized.includes('<span>'))
const settings = { ...defaultRecoverySettings(), rules: [{ id: 'deny-auth', effect: 'no-retry' as const, description: '需要登录', enabled: true }] }
const prompt = recoveryPrompt({ ...failure, userRequest: 'a'.repeat(10000), progress: `Bearer ${secret}` }, settings, 2, [{ message: `api_key=${secret}`, reason: '需要登录' }])
const data = JSON.parse(prompt.split('背景数据：')[1])
assert.equal(data.execution.model, 'execution-model')
assert.equal(data.strategy.attempts, 2)
assert.equal(data.rules[0].effect, 'no-retry')
assert.equal(data.userRequest.length, 1500)
assert.ok(!prompt.includes(secret))
assert.ok(!prompt.includes('native-session'))
assert.ok(!prompt.includes('local-session'))
console.log('PASS recovery context: observed error types, stable identities, execution gates, redaction and bounded judge context')
