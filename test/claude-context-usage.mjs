import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

function usageOf(lines) {
  const events = []
  const runner = new TurnRunner('claude-context', { n: 0 })
  runner.on('event', (event) => events.push(event))
  for (const line of lines) runner.onLine('claude', JSON.stringify(line))
  return events.find(({ payload }) => payload?.kind === 'usage')?.payload.usage
}

let TurnRunner
try {
  ;({ TurnRunner } = await server.ssrLoadModule('/src/main/adapter.ts'))
  const call = (input, cacheRead, model = 'claude-opus-5-5', parent = null) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { model, content: [], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 1000, output_tokens: 50 } }
  })
  const result = (modelUsage) => ({
    type: 'result',
    total_cost_usd: 1,
    // Claude sums every API call of the turn here, far beyond the window.
    usage: { input_tokens: 20, cache_read_input_tokens: 2780000, cache_creation_input_tokens: 9000, output_tokens: 900 },
    modelUsage
  })

  const usage = usageOf([
    call(10, 90000),
    call(99999, 0, 'claude-haiku-4-5-20251001', 'toolu_subagent'),
    call(5, 120000),
    result({
      'claude-opus-5-5': { contextWindow: 1000000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200000 }
    })
  ])
  assert.equal(usage.contextTokens, 121005, 'occupancy is the last main-thread call input, not the turn sum')
  assert.equal(usage.contextWindow, 1000000, 'window comes from the main model in modelUsage')
  assert.equal(usage.inputTokens, 2789020, 'turn totals stay cumulative for the usage footer')

  const legacy = usageOf([result(undefined)])
  assert.equal(legacy.contextTokens, 2789020, 'without per-call usage the old total is kept')
  assert.equal(legacy.contextWindow, undefined)
  console.log('claude-context-usage: ok')
} finally {
  await server.close()
}
