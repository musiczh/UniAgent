import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const sandbox = await mkdtemp(join(tmpdir(), 'ua-final-phase-'))
const previousHome = process.env.HOME
process.env.HOME = sandbox
const claudeId = '11111111-1111-4111-8111-111111111111'
const claudeDir = join(sandbox, '.claude', 'projects', '-repo')
await mkdir(claudeDir, { recursive: true })
await writeFile(join(claudeDir, `${claudeId}.jsonl`), [
  JSON.stringify({ type: 'user', cwd: '/repo', message: { content: '开始' } }),
  JSON.stringify({ type: 'assistant', message: { id: 'commentary', stop_reason: 'tool_use', content: [{ type: 'text', text: '过程消息' }] } }),
  JSON.stringify({ type: 'assistant', message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude 最终回复' }] } }),
  JSON.stringify({ type: 'assistant', message: { id: 'error', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } }),
].join('\n'))

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { loadCodexLikeEvents, loadSessionEvents } = await server.ssrLoadModule('/src/main/history.ts')
  const { TurnRunner } = await server.ssrLoadModule('/src/main/adapter.ts')
  const { AppServerRunner } = await server.ssrLoadModule('/src/main/appServerAdapter.ts')

  const execEvents = []
  const execRunner = new TurnRunner('codex-exec', { n: 0 })
  execRunner.on('event', (event) => execEvents.push(event))
  execRunner.onLine('codex', JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Codex exec final', phase: 'final_answer' }
  }))
  assert.equal(
    execEvents.find(({ type }) => type === 'agent_message')?.payload.phase,
    'final_answer',
    'Codex exec must preserve its native final-answer phase',
  )
  execRunner.onLine('codex', JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call', id: 'handoff-exec', server: 'uniagent',
      tool: 'create_uniagent_task', arguments: { prompt: 'review', wait: true },
      duration: { secs: 2, nanos: 500_000_000 }, status: 'completed',
    },
  }))
  assert.deepEqual(
    execEvents.find(({ payload }) => payload.id === 'handoff-exec')?.payload,
    {
      id: 'handoff-exec', provider: 'mcp', server: 'uniagent', name: 'create_uniagent_task',
      input: { prompt: 'review', wait: true }, durationMs: 2_500, raw: {
        type: 'mcp_tool_call', id: 'handoff-exec', server: 'uniagent',
        tool: 'create_uniagent_task', arguments: { prompt: 'review', wait: true },
        duration: { secs: 2, nanos: 500_000_000 }, status: 'completed',
      },
    },
    'Codex exec MCP completion must expose fields needed for exact handoff timing',
  )

  const appServerEvents = []
  const appServerRunner = new AppServerRunner(
    'codex-app-server',
    { n: 0 },
    {
      id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex', icon: '', builtin: true,
      capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
      models: [], installed: true,
    },
    { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
  )
  appServerRunner.on('event', (event) => appServerEvents.push(event))
  appServerRunner.threadId = 'thread-1'
  appServerRunner.onNotification('item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id: 'final', type: 'agentMessage', text: 'Codex app-server final', phase: 'final_answer' },
  })
  assert.equal(
    appServerEvents.find(({ type }) => type === 'agent_message')?.payload.phase,
    'final_answer',
    'Codex app-server must preserve its native final-answer phase',
  )
  appServerRunner.dispose()

  const claudeLiveEvents = []
  const claudeRunner = new TurnRunner('claude-live', { n: 0 })
  claudeRunner.on('event', (event) => claudeLiveEvents.push(event))
  claudeRunner.claudePartial = true
  for (const record of [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'claude-message' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude final' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude final' }] } },
  ]) claudeRunner.onLine('claude', JSON.stringify(record))
  const claudeLiveReplies = claudeLiveEvents.filter(({ type }) => type === 'agent_message')
  assert.equal(claudeLiveReplies.at(-1)?.payload.phase, 'final_answer')
  assert.equal(
    new Set(claudeLiveReplies.map(({ payload }) => payload.id)).size,
    1,
    'Claude streamed completion must update the existing reply instead of duplicating it',
  )
  // Claude Code 2.1.x emits one completed assistant message per content block.
  const claudeSplitEvents = []
  const claudeSplitRunner = new TurnRunner('claude-split', { n: 0 })
  claudeSplitRunner.on('event', (event) => claudeSplitEvents.push(event))
  claudeSplitRunner.claudePartial = true
  const splitMessage = (block) => ({ type: 'assistant', message: { id: 'claude-split-message', stop_reason: null, content: [block] } })
  for (const record of [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'claude-split-message' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    splitMessage({ type: 'thinking', thinking: '' }),
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '先执行命令' } } },
    splitMessage({ type: 'text', text: '先执行命令' }),
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } } },
    splitMessage({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } }),
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    { type: 'result', subtype: 'success', usage: {} },
  ]) claudeSplitRunner.onLine('claude', JSON.stringify(record))
  assert.deepEqual(
    [...new Set(claudeSplitEvents.filter(({ type }) => type === 'agent_message').map(({ payload }) => payload.id))],
    ['claude-split-message-1'],
    'Claude per-block completions must update the streamed text block instead of duplicating it',
  )
  assert.equal(
    claudeSplitEvents.findLast(({ type }) => type === 'agent_message')?.payload.phase,
    undefined,
    'text before a tool call must remain commentary even when the turn succeeds',
  )
  const claudeNullStopEvents = []
  const claudeNullStopRunner = new TurnRunner('claude-null-stop', { n: 0 })
  claudeNullStopRunner.on('event', (event) => claudeNullStopEvents.push(event))
  claudeNullStopRunner.claudePartial = true
  for (const record of [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'claude-final-message' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '实际最终回复' } } },
    { type: 'assistant', message: { id: 'claude-final-message', stop_reason: null, content: [{ type: 'text', text: '实际最终回复' }] } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'result', subtype: 'success', usage: {} },
  ]) claudeNullStopRunner.onLine('claude', JSON.stringify(record))
  assert.equal(claudeNullStopEvents.findLast(({ type }) => type === 'agent_message')?.payload.phase, 'final_answer')
  assert.deepEqual(
    [...new Set(claudeNullStopEvents.filter(({ type }) => type === 'agent_message').map(({ payload }) => payload.id))],
    ['claude-final-message-0'],
    'result must mark the streamed reply in place',
  )
  const claudeErrorEvents = []
  const claudeErrorRunner = new TurnRunner('claude-error-result', { n: 0 })
  claudeErrorRunner.on('event', (event) => claudeErrorEvents.push(event))
  claudeErrorRunner.onLine('claude', JSON.stringify({
    type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'incomplete' }] }
  }))
  claudeErrorRunner.onLine('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, usage: {} }))
  assert.equal(claudeErrorEvents.some(({ type, payload }) => type === 'agent_message' && payload.phase === 'final_answer'), false)
  for (const stopReason of ['tool_use', 'stop_sequence']) {
    const events = []
    const runner = new TurnRunner(`claude-${stopReason}`, { n: 0 })
    runner.on('event', (event) => events.push(event))
    runner.onLine('claude', JSON.stringify({
      type: 'assistant',
      message: { stop_reason: stopReason, content: [{ type: 'text', text: stopReason }] },
    }))
    assert.equal(
      events.find(({ type }) => type === 'agent_message')?.payload.phase,
      undefined,
      `Claude ${stopReason} text must not be marked as a final answer`,
    )
  }

  const codex = await loadCodexLikeEvents('', 'codex', 'codex-session', async () => new Map(), [
    JSON.stringify({ type: 'event_msg', turn_id: 'turn-1', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '开始' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Codex 过程消息', phase: 'commentary' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Codex 最终回复', phase: 'final_answer' } }),
  ].join('\n'))
  assert.deepEqual(
    codex.events.filter(({ type }) => type === 'agent_message').map(({ payload }) => payload.phase),
    ['commentary', 'final_answer'],
    'Codex history must preserve its native message phase',
  )
  const codexResponseItem = await loadCodexLikeEvents('', 'codex', 'codex-response-item', async () => new Map(), [
    JSON.stringify({ type: 'event_msg', turn_id: 'turn-2', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Codex response-item final' }],
    } }),
  ].join('\n'))
  assert.equal(
    codexResponseItem.events.find(({ type }) => type === 'agent_message')?.payload.phase,
    'final_answer',
    'Codex response-item history must preserve its native final-answer phase',
  )

  const claude = await loadSessionEvents('claude', claudeId)
  assert.deepEqual(
    claude.events.filter(({ type }) => type === 'agent_message').map(({ payload }) => payload.phase),
    [undefined, 'final_answer', undefined],
    'Claude history must map only end_turn text to final_answer',
  )
  console.log('final answer phase: ok')
} finally {
  await server.close()
  process.env.HOME = previousHome
  await rm(sandbox, { recursive: true, force: true })
}
