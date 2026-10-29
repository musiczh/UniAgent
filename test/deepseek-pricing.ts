import assert from 'node:assert/strict'
import { deepseekCost, deepseekModelId, isDeepSeekPeak } from '../src/main/deepseekPricing.ts'

const at = (iso: string): number => Date.parse(iso)
const near = (actual: number | null, expected: number, message: string): void => {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`)
}
const million = (overrides: Record<string, number> = {}): {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
} => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...overrides })

// Peak windows are 01:00-04:00 and 06:00-10:00 UTC (09:00-12:00 and
// 14:00-18:00 Beijing) on Monday-Friday, excluding Chinese public holidays.
assert.equal(isDeepSeekPeak(at('2026-10-19T00:59:59.999Z')), false, '08:59 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-19T01:00:00.000Z')), true, '09:00 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-19T03:59:59.999Z')), true, '11:59 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-19T04:00:00.000Z')), false, '12:00 Beijing lunch')
assert.equal(isDeepSeekPeak(at('2026-10-19T05:59:59.999Z')), false, '13:59 Beijing lunch')
assert.equal(isDeepSeekPeak(at('2026-10-19T06:00:00.000Z')), true, '14:00 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-19T09:59:59.999Z')), true, '17:59 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-19T10:00:00.000Z')), false, '18:00 Beijing Monday')
assert.equal(isDeepSeekPeak(at('2026-10-17T02:00:00.000Z')), false, 'Saturday')
assert.equal(isDeepSeekPeak(at('2026-10-18T02:00:00.000Z')), false, 'Sunday')
assert.equal(isDeepSeekPeak(at('2026-10-01T02:00:00.000Z')), false, 'National Day Thursday')
assert.equal(isDeepSeekPeak(at('2026-02-16T02:00:00.000Z')), false, 'Spring Festival Monday')
assert.equal(isDeepSeekPeak(at('2025-01-29T02:00:00.000Z')), false, '2025 Spring Festival Wednesday')
assert.equal(isDeepSeekPeak(at('2025-10-06T02:00:00.000Z')), false, '2025 National Day Monday')
assert.equal(isDeepSeekPeak(at('2026-10-12T02:00:00.000Z')), true, 'ordinary Monday after the holiday')

// Harness routes arrive as JSON pairs; legacy Flash names still mean Flash.
assert.equal(deepseekModelId('["deepseek-official","deepseek-flash"]'), 'deepseek-flash')
assert.equal(deepseekModelId('["deepseek-account","deepseek-v4-pro"]'), 'deepseek-v4-pro')
assert.equal(deepseekModelId('deepseek-v4-flash'), 'deepseek-flash')
assert.equal(deepseekModelId('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
assert.equal(deepseekModelId('openai/gpt-5'), 'gpt-5')
assert.equal(deepseekModelId(undefined), undefined)
assert.equal(deepseekModelId('[]'), undefined)

const peak = '2026-10-19T02:00:00.000Z'
const offPeak = '2026-10-19T04:30:00.000Z'

// Flash official peak USD per 1M tokens: 0.30 miss / 0.006 hit / 1.20 output.
near(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), 'deepseek-flash', peak), 0.3, 'flash miss peak')
near(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), 'deepseek-flash', offPeak), 0.15, 'flash miss off-peak')
near(deepseekCost(million({ cacheReadTokens: 1_000_000 }), 'deepseek-flash', peak), 0.006, 'flash hit peak')
near(deepseekCost(million({ cacheReadTokens: 1_000_000 }), 'deepseek-flash', offPeak), 0.003, 'flash hit off-peak')
near(deepseekCost(million({ outputTokens: 1_000_000 }), 'deepseek-flash', peak), 1.2, 'flash output peak')
near(deepseekCost(million({ outputTokens: 1_000_000 }), 'deepseek-flash', offPeak), 0.6, 'flash output off-peak')

// DeepSeek has no separate cache-write price: writes bill as cache-miss input.
near(deepseekCost(million({ cacheWriteTokens: 1_000_000 }), 'deepseek-flash', peak), 0.3, 'flash cache write = miss')

// Pro official peak USD per 1M tokens: 1.32 miss / 0.044 hit / 3.96 output.
near(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), 'deepseek-v4-pro', peak), 1.32, 'pro miss peak')
near(deepseekCost(million({ cacheReadTokens: 1_000_000 }), 'deepseek-v4-pro', offPeak), 0.022, 'pro hit off-peak')
near(deepseekCost(million({ outputTokens: 1_000_000 }), 'deepseek-v4-pro', peak), 3.96, 'pro output peak')

// Mixed buckets, route JSON and legacy aliases.
near(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), '["deepseek-official","deepseek-flash"]', peak), 0.3, 'route JSON')
near(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), 'deepseek-v4-flash', peak), 0.3, 'legacy alias')
near(deepseekCost({ uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 7 }, 'deepseek-flash', offPeak), 0.00000621, 'mixed sample')

// Unknown or missing routes stay unpriceable instead of silently showing zero.
assert.equal(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), 'deepseek-chat', peak), null)
assert.equal(deepseekCost(million({ uncachedInputTokens: 1_000_000 }), undefined, peak), null)
assert.equal(deepseekCost(million(), 'deepseek-flash', peak), 0)

console.log('deepseek-pricing: peak/off-peak, cache buckets, route aliases and unknown-model handling passed')
