import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'

const root = mkdtempSync(join(tmpdir(), 'uniagent-fast-pricing-'))
process.env.UNIAGENT_USER_DATA = root
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })

const standard = { input: 1, cachedInput: 0.05, output: 5, source: 'auto' }
const priority = { input: 2, cachedInput: 0.1, output: 10 }
const usage = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 }
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

try {
  const pricing = await server.ssrLoadModule('/src/main/pricing.ts')
  const { AppServerRunner } = await server.ssrLoadModule('/src/main/appServerAdapter.ts')

  await test('reconciles exact model-specific priority rates and does not guess missing prices', async () => {
    pricing.savePricing({ version: 1, models: {
      terra: { ...standard },
      manual: { input: 4, cachedInput: 1, output: 8, source: 'manual' },
      'no-fast': { ...standard },
      'no-cache-rate': { ...standard }
    } })
    writeFileSync(join(root, 'litellm_prices.json'), JSON.stringify({
      terra: { input_cost_per_token: 1e-6, cache_read_input_token_cost: 0.05e-6, output_cost_per_token: 5e-6,
        input_cost_per_token_priority: 2e-6, cache_read_input_token_cost_priority: 0.1e-6, output_cost_per_token_priority: 10e-6 },
      manual: { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6,
        input_cost_per_token_priority: 2e-6, output_cost_per_token_priority: 10e-6 },
      'no-cache-rate': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6,
        input_cost_per_token_priority: 3e-6, output_cost_per_token_priority: 7e-6 }
    }))
    const file = await pricing.reconcilePricing(['terra', 'manual', 'no-fast', 'no-cache-rate'])
    assert.ok(file.models.terra.fast, 'existing auto prices need priority rates backfilled')
    near(file.models.terra.fast.input, priority.input)
    near(file.models.terra.fast.cachedInput, priority.cachedInput)
    near(file.models.terra.fast.output, priority.output)
    assert.equal(file.models.terra.input, 1, 'reconciliation preserves existing standard rates')
    assert.equal(file.models.manual.fast, undefined, 'manual prices are never overwritten with registry rates')
    near(pricing.computeCost(usage, 'terra', file), 0.74)
    near(pricing.computeCost(usage, 'terra', file, { fastMode: true }), 1.48)
    near(pricing.computeCost({ inputTokens: 15_053_771, cachedInputTokens: 14_812_800, outputTokens: 44_627 },
      'terra', file, { fastMode: true }), 2.409492)
    assert.equal(pricing.computeCost(usage, 'no-fast', file, { fastMode: true }), null)
    assert.equal(pricing.computeCost(usage, 'terra-unknown-version', file, { fastMode: true }), null)
    assert.equal(pricing.computeCost(usage, 'terra-unknown-version', file, { exactModel: true }), null)
    assert.equal(pricing.computeCost(usage, 'no-cache-rate', file, { fastMode: true }), null)
    near(pricing.computeCost({ ...usage, cachedInputTokens: 0 }, 'no-cache-rate', file, { fastMode: true }), 3.7)
    writeFileSync(join(root, 'litellm_prices.json'), JSON.stringify({
      terra: { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6,
        input_cost_per_token_priority: 2e-6, cache_read_input_token_cost_priority: 0.1e-6, output_cost_per_token_priority: 20e-6 }
    }))
    const updated = await pricing.reconcilePricing(['terra'])
    near(updated.models.terra.fast.output, 20)
  })

  await test('prices each turn at its requested tier and model and sums the priced turns', async () => {
    pricing.savePricing({ version: 1, models: {
      terra: { ...standard, fast: priority },
      second: { input: 3, cachedInput: 0.3, output: 7, source: 'auto', fast: { input: 9, cachedInput: 0.9, output: 21 } },
      'no-fast': { ...standard }
    } })
    class Transport extends EventEmitter {
      calls = []
      turn = 0
      async start() {}
      async request(method, params) {
        this.calls.push({ method, params })
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params?.threadId || 'thread-1' } }
        if (method === 'turn/start') return { turn: { id: `turn-${++this.turn}` } }
        return {}
      }
      notify() {}
      respond() {}
      interrupt() {}
      async dispose() {}
    }
    const agent = { id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex', icon: '', builtin: true,
      capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [{ id: 'read-only' }], streaming: true }, models: [] }
    const config = { agentId: 'codex', workdir: root, permissionMode: 'read-only', model: 'terra', fastMode: false }
    const transport = new Transport()
    const runner = new AppServerRunner('pricing-session', { n: 0 }, agent, config, undefined, undefined, () => transport)
    const events = []
    runner.on('event', event => events.push(event))
    const footer = () => events.filter(e => e.type === 'system_notice' && e.payload?.kind === 'usage').at(-1).payload.usage
    const complete = turn => {
      const total = { inputTokens: usage.inputTokens * turn, cachedInputTokens: usage.cachedInputTokens * turn, outputTokens: usage.outputTokens * turn }
      runner.onNotification('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total, last: usage } })
      runner.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: `turn-${turn}`, status: 'completed' } })
      return footer()
    }
    try {
      await runner.startTurn('first')
      assert.equal(transport.calls.find(c => c.method === 'turn/start').params.serviceTier, 'default')
      runner.updateConfig({ ...config, fastMode: true })
      const first = complete(1)
      near(first.cost, 0.74)
      near(first.sessionCost, 0.74)

      await runner.startTurn('second')
      assert.equal(transport.calls.filter(c => c.method === 'turn/start').at(-1).params.serviceTier, 'priority')
      runner.updateConfig({ ...config, model: 'second', fastMode: false })
      const second = complete(2)
      near(second.cost, 1.48)
      near(second.sessionCost, 2.22)

      await runner.startTurn('third')
      const third = complete(3)
      near(third.cost, 1.54)
      near(third.sessionCost, 3.76)

      runner.updateConfig({ ...config, model: 'second', fastMode: true })
      await runner.startTurn('another model fast')
      const fourth = complete(4)
      near(fourth.cost, 4.62)
      near(fourth.sessionCost, 8.38)

      runner.updateConfig({ ...config, model: 'no-fast', fastMode: true })
      await runner.startTurn('unknown')
      const fifth = complete(5)
      assert.equal(fifth.cost, null, 'do not silently substitute standard rates')
      assert.equal(fifth.sessionCost, null, 'a partial sum is not a session total')

      runner.updateConfig({ ...config, fastMode: false })
      await runner.startTurn('known again')
      const sixth = complete(6)
      near(sixth.cost, 0.74)
      assert.equal(sixth.sessionCost, null, 'an earlier unknown cost keeps the session total unknown')

      await runner.startTurn('no new usage')
      runner.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-7', status: 'completed' } })
      assert.equal(footer().cost, null, 'a missing usage tick is not a free turn')
    } finally { runner.dispose() }

    for (const baseline of ['complete', 'partial', 'absent']) {
      const resumedTransport = new Transport()
      const request = resumedTransport.request.bind(resumedTransport)
      resumedTransport.request = async (method, params) => {
        if (method === 'thread/resume' && baseline !== 'absent') {
          resumedTransport.emit('notification', 'thread/tokenUsage/updated', {
            threadId: 'thread-1', tokenUsage: { total: baseline === 'complete' ? usage : { totalTokens: 1_100_000 }, last: usage }
          })
        }
        return request(method, params)
      }
      const resumed = new AppServerRunner(`resumed-${baseline}`, { n: 0 }, agent,
        { ...config, fastMode: true }, 'thread-1', undefined, () => resumedTransport)
      const resumedEvents = []
      resumed.on('event', event => resumedEvents.push(event))
      try {
        await resumed.startTurn('continue')
        const total = { inputTokens: usage.inputTokens * 2, cachedInputTokens: usage.cachedInputTokens * 2, outputTokens: usage.outputTokens * 2 }
        resumed.onNotification('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total, last: usage } })
        resumed.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        const result = resumedEvents.filter(e => e.type === 'system_notice' && e.payload?.kind === 'usage').at(-1).payload.usage
        if (baseline === 'complete') near(result.cost, 1.48)
        else assert.equal(result.cost, null, 'an absent or incomplete resume baseline cannot be treated as zero')
        assert.equal(result.sessionCost, null, 'unpriced historical turns cannot be reconstructed from current settings')
      } finally { resumed.dispose() }
    }
  })
} finally {
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
