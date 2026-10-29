import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isKimiAuthorizationError, startKimiLogin, type KimiLoginState } from '../src/main/kimiAuth.ts'

assert.equal(isKimiAuthorizationError('The provided authorization grant is invalid'), true)
assert.equal(isKimiAuthorizationError('network timeout'), false)
for (const message of [
  "Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
  'Authentication required: quota_exceeded',
  'Authentication required: Quota exhausted'
]) {
  assert.equal(isKimiAuthorizationError(message), false, '额度耗尽不能触发登录')
  assert.equal(isKimiAuthorizationError(new Error(message)), false, 'Error 中的额度原因不能被认证前缀遮蔽')
}
assert.equal(isKimiAuthorizationError('Authentication required'), true)
assert.equal(isKimiAuthorizationError('Authentication required: invalid API key'), true)
assert.equal(isKimiAuthorizationError('Authentication required: quota service authorization failed'), true, '仅提到 quota 不能判为额度耗尽')

const dir = await mkdtemp(join(tmpdir(), 'uniagent-kimi-login-'))
try {
  const fake = join(dir, 'kimi')
  await writeFile(fake, '#!/bin/sh\necho run >> "$KIMI_CODE_HOME/count"\necho "Opening browser for Kimi device login: https://auth.kimi.com/device?code=test" >&2\nsleep .1\nexit 0\n')
  await chmod(fake, 0o755)
  const states: KimiLoginState[] = []
  const attempt = startKimiLogin(fake, dir)
  await Promise.all([new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('login state timeout')), 2000)
    attempt.subscribe(state => {
      states.push(state)
      if (state.status === 'success' || state.status === 'failed') { clearTimeout(timeout); resolve() }
    })
  }), new Promise<void>((resolve) => startKimiLogin(fake, dir).subscribe(state => { if (state.status === 'success') resolve() }))])
  assert.deepEqual(states.map(state => state.status), ['starting', 'awaiting', 'success'])
  assert.equal(states.at(-1)?.url, 'https://auth.kimi.com/device?code=test')
  assert.equal((await readFile(join(dir, 'count'), 'utf8')).trim(), 'run')
} finally { await rm(dir, { recursive: true, force: true }) }

console.log('kimi-oauth-login: invalid grants trigger one parsed device-login flow')
