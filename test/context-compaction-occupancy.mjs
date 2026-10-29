// 需求2(主动压缩更新) — a successful compaction must refresh the composer's
// context-load meter immediately, not on the next turn. The occupancy figure the
// meter reads is the `contextTokens` carried by a `kind:'context'` system_notice.
//
// This drives the REAL AppServerRunner with the exact JSON-RPC frames the packaged
// app-server emits around a compaction (captured on-device via UA_DUMP_COMPACT):
//   1. a pre-compaction token tick with a live per-call input, and
//   2. the synthetic post-compaction tick whose `last.inputTokens` is 0 while
//      `last.totalTokens` carries the NEW (compacted) context size.
// The regression this guards against: reading `last.inputTokens` blindly yields 0
// after compaction, which the renderer ignores, leaving the bar stuck at the old
// (pre-compaction) figure. We assert the emitted occupancy DROPS to the compacted
// total and is never a misleading 0.
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { AppServerRunner } = await server.ssrLoadModule('/src/main/appServerAdapter.ts')
  const runner = new AppServerRunner(
    'occupancy-fixture',
    { n: 1 },
    {
      id: 'codex',
      name: 'Codex',
      bin: 'codex',
      adapter: 'codex',
      icon: '',
      builtin: true,
      capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [], streaming: true },
      models: []
    },
    { agentId: 'codex', workdir: process.cwd(), permissionMode: 'read-only', model: 'm' },
    'parent-thread'
  )
  const events = []
  runner.on('event', (event) => events.push(event))
  const notify = (method, params) => runner.onNotification(method, params)
  const contextNotices = () =>
    events.filter((e) => e.type === 'system_notice' && e.payload?.kind === 'context' && e.payload.usage)

  // 1. A normal in-turn tick: occupancy = the last call's input (bounded).
  notify('thread/tokenUsage/updated', {
    threadId: 'parent-thread',
    turnId: 'turn-1',
    tokenUsage: {
      total: { totalTokens: 24869, inputTokens: 24800, outputTokens: 69 },
      last: { totalTokens: 24869, inputTokens: 24800, outputTokens: 69 },
      modelContextWindow: 258400
    }
  })
  const preCompact = contextNotices().at(-1)
  assert.ok(preCompact, 'a token tick must emit a context occupancy notice')
  assert.equal(preCompact.payload.usage.contextTokens, 24800, 'occupancy is the last call input pre-compaction')
  assert.equal(preCompact.payload.usage.contextWindow, 258400)

  // 2. The synthetic post-compaction tick: no real model call happened, so
  //    `last.inputTokens` is 0 and only `last.totalTokens` is meaningful (the new
  //    compacted context size). The meter must fall to that, not read 0.
  const before = contextNotices().length
  notify('thread/tokenUsage/updated', {
    threadId: 'parent-thread',
    turnId: 'turn-2',
    tokenUsage: {
      total: { totalTokens: 49619, inputTokens: 49543, outputTokens: 76 },
      last: { totalTokens: 4619, inputTokens: 0, outputTokens: 0 },
      modelContextWindow: 258400
    }
  })
  const postCompact = contextNotices().at(-1)
  assert.equal(contextNotices().length, before + 1, 'the post-compaction tick emits exactly one occupancy notice')
  assert.equal(
    postCompact.payload.usage.contextTokens,
    4619,
    'post-compaction occupancy falls to the compacted total, not the stale input'
  )
  assert.ok(
    postCompact.payload.usage.contextTokens < preCompact.payload.usage.contextTokens,
    'occupancy must strictly drop after compaction'
  )
  assert.notEqual(postCompact.payload.usage.contextTokens, 0, 'occupancy must never be a misleading 0')

  notify('thread/tokenUsage/updated', {
    threadId: 'parent-thread',
    tokenUsage: {
      total: { totalTokens: 249036, inputTokens: 0, outputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      modelContextWindow: 249036
    }
  })
  assert.equal(contextNotices().at(-1).payload.usage.contextTokens, 249036,
    '原生满窗口标记必须显示已满，不能发布 0 后让界面回退到旧模型用量')

  // 3. A child thread's tick must NOT touch the main chat's occupancy meter.
  runner.childThreads?.add?.('child-x')
  const beforeChild = contextNotices().length
  notify('thread/tokenUsage/updated', {
    threadId: 'child-x',
    turnId: 'child-turn',
    tokenUsage: { total: { inputTokens: 999 }, last: { inputTokens: 999 }, modelContextWindow: 258400 }
  })
  assert.equal(contextNotices().length, beforeChild, "a child's token tick must not emit a main occupancy notice")

  console.log('context-compaction-occupancy: ok')
} finally {
  await server.close()
}
