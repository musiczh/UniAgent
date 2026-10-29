import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { TurnRunner } = await server.ssrLoadModule('/src/main/adapter.ts')
  const { normalizeClaudeRateLimits } = await server.ssrLoadModule('/src/main/claudeRateLimits.ts')

  // Captured from Claude Code CLI 2.1.281 `--output-format stream-json`.
  const realEvent = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1790250000,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.35, resetsAt: 1790250000 },
        seven_day: { utilization: 0.03, resetsAt: 1790488800 }
      }
    },
    uuid: '62d53289-ac2d-4024-8d92-bedcfe68b0c4',
    session_id: '4602816b-e3db-4607-93da-322aed2f9882'
  }

  const events = []
  const limits = []
  const runner = new TurnRunner('claude-rate-limits', { n: 0 })
  runner.on('event', (event) => events.push(event))
  runner.on('rateLimits', (snapshot) => limits.push(snapshot))
  runner.onLine('claude', JSON.stringify(realEvent))
  assert.equal(events.length, 0, 'rate_limit_event must not add a transcript event')
  assert.equal(limits.length, 1, 'rate_limit_event must surface one quota snapshot')
  assert.deepEqual(limits[0].primary, { usedPercent: 35, windowMinutes: 300, resetsAt: 1790250000 })
  assert.deepEqual(limits[0].secondary, { usedPercent: 3, windowMinutes: 10080, resetsAt: 1790488800 })
  assert.equal(typeof limits[0].capturedAt, 'number')

  // Accounts without unified subscription windows (e.g. API key) show nothing.
  assert.equal(normalizeClaudeRateLimits({ status: 'allowed', resetsAt: 1790250000 }), null)
  assert.equal(normalizeClaudeRateLimits(undefined), null)
  assert.equal(normalizeClaudeRateLimits({ unifiedWindows: { five_hour: { utilization: 0.5 } } }), null,
    'a window without resetsAt is unusable')

  const weeklyOnly = normalizeClaudeRateLimits({ unifiedWindows: { seven_day: { utilization: 1.2, resetsAt: 1790488800 } } }, 42)
  assert.deepEqual(weeklyOnly, {
    primary: null,
    secondary: { usedPercent: 120, windowMinutes: 10080, resetsAt: 1790488800 },
    capturedAt: 42
  }, 'a single window is kept and over-cap utilization is passed through for display clamping')

  const silent = []
  const bare = new TurnRunner('claude-rate-limits-bare', { n: 0 })
  bare.on('rateLimits', (snapshot) => silent.push(snapshot))
  bare.onLine('claude', JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))
  assert.equal(silent.length, 0, 'events without usable windows must not clear the last snapshot')

  console.log('claude rate limits: ok')
} finally {
  await server.close()
}
