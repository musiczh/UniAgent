import assert from 'node:assert/strict'
import { normalizeDeepSeekHistory, projectDeepSeekNativeEvent, type DeepSeekProjectionContext } from '../src/main/deepseekEventProjection.ts'

const native = (seq: number, type: string, data: any, extra: any = {}) => ({ seq, time: 1700000000000 + seq, type, data, ...extra })
const message = (id: string, role: string, content: any[], source: any) => ({ id, role, content, source })
const modelSource = { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }
const snapshot = {
  session: { id: 'native-session', cwd: '/fixture/work', parentSession: 'native-parent', isSeeded: true },
  inheritedEventCount: 3,
  events: [
    native(0, 'turn/start', { turn: 1 }),
    native(1, 'request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } }, reason: 'initial' }),
    native(2, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 262144 }),
    native(3, 'session/live', { inherited: true }),
    native(4, 'user/message', message('user-one', 'user', [{ type: 'text', text: 'Question' }], { kind: 'user' }), { surfaceOp: 'append' }),
    native(5, 'assistant/message', { turn: 1, step: 0, message: message('reply-one', 'assistant', [{ type: 'reasoning', text: 'Thought' }, { type: 'text', text: 'First answer' }, { type: 'tool-call', id: 'tool-one', name: 'read', arguments: '{"path":"a.ts"}' }], modelSource), stream: [], usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 4, totalTokens: 40 } }, { surfaceOp: 'append' }),
    native(6, 'tool/call', { turn: 1, step: 0, callId: 'tool-one', name: 'read', arguments: '{"path":"a.ts"}' }),
    native(7, 'tool/result', { turn: 1, step: 0, message: { ...message('result-one', 'tool', [{ type: 'text', text: 'File text' }], { kind: 'tool', callId: 'tool-one' }), toolCallId: 'tool-one' }, meta: { marker: 'private-presentation' } }, { surfaceOp: 'append' }),
    native(8, 'assistant/message', { turn: 1, step: 1, message: message('reply-two', 'assistant', [{ type: 'text', text: 'Cancelled prefix' }], modelSource), stream: [], interrupted: true, usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 1 } }, { surfaceOp: 'append' }),
    native(9, 'todo/write', { todos: [{ content: 'Inspect', status: 'completed' }, { content: 'Finish', status: 'in_progress' }] }),
    native(10, 'plan/mode', { active: true }),
    native(11, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  ]
}

// Break caught: dropping inherited content, misreading request/header.config,
// losing reasoning or cancelled prefixes, or duplicating call/result cards.
const history = normalizeDeepSeekHistory(snapshot)
assert.equal(history.cwd, '/fixture/work')
assert.equal(history.model, '["deepseek-official","deepseek-flash"]')
assert.equal(history.effort, 'high')
assert.deepEqual(history.events.filter(event => ['user_message', 'reasoning', 'agent_message'].includes(event.type)).map(event => [event.type, event.payload.text, event.state]), [
  ['user_message', 'Question', 'success'], ['reasoning', 'Thought', 'success'], ['agent_message', 'First answer', 'success'], ['agent_message', 'Cancelled prefix', 'cancelled']
])
const tool = history.events.filter(event => event.type === 'tool_call')
assert.equal(tool.length, 1)
assert.equal(tool[0].payload.output, 'File text')
assert.deepEqual(tool[0].payload.input, { path: 'a.ts' })
assert.equal(tool[0].payload.meta.marker, 'private-presentation')
assert.equal(tool[0].state, 'success')
assert.equal(tool[0].payload.provider, undefined, 'non-MCP tools must not gain provider/server fields')
assert.equal(tool[0].payload.name, 'read')
assert.equal(history.events.find(event => event.type === 'turn_completed')?.state, 'cancelled')

// Break caught: native bash calls bypass the command renderer when standard ACP
// tool frames are suppressed, or call/result produce two cards with different types.
const bashContext: DeepSeekProjectionContext = { sessionId: 'bash-live' }
const bashArguments = { command: 'printf NATIVE_BASH_APPROVAL_OK', description: 'Print the native bash approval fixture', workdir: '/fixture/work' }
const bashCall = native(20, 'tool/call', { turn: 4, step: 1, callId: 'bash-command', name: 'bash', arguments: JSON.stringify(bashArguments) })
const bashResult = native(21, 'tool/result', { turn: 4, step: 1, message: { ...message('bash-result', 'tool', [{ type: 'text', text: 'NATIVE_BASH_APPROVAL_OK\n[exit code: 0]' }], { kind: 'tool', callId: 'bash-command' }), toolCallId: 'bash-command', isError: false } })
const liveBash = projectDeepSeekNativeEvent(bashCall, bashContext)[0]
assert.equal(liveBash.type, 'command_exec')
assert.equal(liveBash.state, 'running')
assert.equal(liveBash.payload.command, bashArguments.command)
assert.equal(liveBash.payload.cwd, bashArguments.workdir)
assert.equal(liveBash.payload.output, '')
const finishedBash = projectDeepSeekNativeEvent(bashResult, bashContext)[0]
assert.equal(finishedBash.type, 'command_exec')
assert.equal(finishedBash.state, 'success')
assert.equal(finishedBash.payload.id, liveBash.payload.id)
assert.equal(finishedBash.payload.command, bashArguments.command)
assert.equal(finishedBash.payload.output, 'NATIVE_BASH_APPROVAL_OK\n[exit code: 0]')
const bashHistory = normalizeDeepSeekHistory({ session: { id: 'bash-history' }, events: [bashCall, bashResult] })
assert.equal(bashHistory.events.length, 1)
assert.equal(bashHistory.events[0].type, 'command_exec')
assert.equal(bashHistory.events[0].state, 'success')
assert.equal(bashHistory.events[0].payload.command, bashArguments.command)
const interruptedBash = normalizeDeepSeekHistory({ session: { id: 'bash-interrupted' }, events: [bashCall, native(22, 'turn/end', { turn: 4, reason: { kind: 'aborted' } })] })
assert.equal(interruptedBash.events.find(event => event.type === 'command_exec')?.state, 'cancelled')
assert.deepEqual(history.events.find(event => event.type === 'plan_update')?.payload.steps, [{ text: 'Inspect', status: 'completed' }, { text: 'Finish', status: 'in_progress' }])
assert.equal(history.events.find(event => event.payload.kind === 'collaboration_mode')?.payload.active, true)
assert.deepEqual(history.events.map(event => event.seq), history.events.map((_, index) => index))

// Break caught: interpreting input as inclusive, counting reasoning twice,
// replacing turn usage with the last step, or confusing total with context.
const usage = history.events.filter(event => event.payload.kind === 'usage')
assert.equal(usage.length, 1)
assert.deepEqual({ input: usage[0].payload.usage.inputTokens, output: usage[0].payload.usage.outputTokens, read: usage[0].payload.usage.cachedInputTokens, write: usage[0].payload.usage.cacheCreationInputTokens, context: usage[0].payload.usage.contextTokens }, { input: 43, output: 9, read: 25, write: 4, context: 10 })
assert.equal(usage[0].payload.usage.contextWindow, 262144)
// The fixture timestamps are off-peak; Flash then bills 0.15 / 0.003 / 0.6
// USD per 1M for miss / hit / output, and cache writes as miss input.
const near = (actual: number | null | undefined, expected: number, message: string): void => {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`)
}
near(usage[0].payload.usage.cost, 0.000008175, 'turn cost from both steps')

// Break caught: a failed attempt becomes an assistant answer, or an open tool
// appears running forever after cancelled/interrupted history is imported.
const unfinished = normalizeDeepSeekHistory({ session: { id: 'interrupted' }, inheritedEventCount: 0, events: [
  native(0, 'turn/start', { turn: 2 }),
  native(1, 'tool/call', { turn: 2, step: 0, callId: 'open-tool', name: 'write', arguments: '{}' }),
  native(2, 'assistant/attempt', { turn: 2, step: 1, stream: [{ type: 'text-chunks', index: 0, time0: 1700000000000, dt: [0], texts: ['Attempt only'] }] }),
  native(3, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } })
] })
assert.equal(unfinished.events.some(event => event.type === 'agent_message'), false)
assert.equal(unfinished.events.find(event => event.type === 'tool_call')?.state, 'cancelled')

// Break caught: compaction appears successful before its end, summary/prune
// prices get mislabeled as full context, or summary content is lost on merge.
const compaction = normalizeDeepSeekHistory({ session: { id: 'compact' }, inheritedEventCount: 0, events: [
  native(0, 'compaction/start', { compactionId: 'compact-one', turn: null }),
  native(1, 'compaction/summary', { compactionId: 'compact-one', summary: [{ type: 'text', text: 'Compact summary' }], shadowedRange: { start: 3, end: 7 }, shadowedSeqs: [3, 7], shadowedTokenCount: 900, provider: 'deepseek-official', model: 'deepseek-flash', usage: { inputTokens: 2, outputTokens: 1 } }),
  native(2, 'compaction/end', { compactionId: 'compact-one', turn: null }),
  native(3, 'compaction/start', { compactionId: 'compact-failed', turn: null }),
  native(4, 'compaction/end', { compactionId: 'compact-failed', turn: null, error: 'Cancelled' }),
  native(5, 'compaction/prune', { shadowedRange: { start: 3, end: 7 }, shadowedSeqs: [3, 7], shadowedTokenCount: 12 })
] })
const cards = compaction.events.filter(event => event.type === 'context_compaction')
assert.deepEqual(cards.map(event => event.state), ['success', 'failed', 'success'])
assert.equal(cards[0].payload.summaryPreview, 'Compact summary')
assert.equal(cards[0].payload.shadowedTokenCount, 900)
for (const card of cards) {
  assert.equal('tokensBefore' in card.payload, false)
  assert.equal('tokensAfter' in card.payload, false)
}
near(compaction.events.find(event => event.payload.kind === 'usage')?.payload.usage.cost, 0.0000009, 'compaction summary cost')

// Break caught: replaying the same native usage event double bills a live turn.
const context: DeepSeekProjectionContext = { sessionId: 'local-live' }
projectDeepSeekNativeEvent(snapshot.events[2], context)
const first = projectDeepSeekNativeEvent(snapshot.events[5], context).find(event => event.payload.kind === 'usage')!
const repeated = projectDeepSeekNativeEvent(snapshot.events[5], context).find(event => event.payload.kind === 'usage')!
assert.equal(first.payload.usage.inputTokens, 33)
assert.equal(repeated.payload.usage.inputTokens, 33)
assert.equal(first.sessionId, 'local-live')
near(first.payload.usage.cost, 0.00000621, 'live step cost')
const afterAttempt = projectDeepSeekNativeEvent(native(6, 'assistant/attempt', { turn: 1, step: 2, stream: [{ type: 'chunk', time: 1700000000006, chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 5 } } }] }), context).find(event => event.payload.kind === 'usage')!
assert.equal(afterAttempt.payload.usage.contextTokens, 33)
assert.equal(compaction.events.find(event => event.payload.kind === 'usage')?.payload.usage.contextTokens, undefined)
// Break caught: failed/cancelled attempts lose billable stream usage, or a
// replacement settlement is charged twice before an explicit retry.
const attemptContext: DeepSeekProjectionContext = { sessionId: 'attempt-live' }
projectDeepSeekNativeEvent(native(0, 'request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } }), attemptContext)
const sample = (seq: number, inputTokens: number) => native(seq, 'assistant/attempt', { turn: 7, step: 0, stream: [{ type: 'chunk', time: 1700000000000 + seq, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 } } }] })
const firstAttempt = projectDeepSeekNativeEvent(sample(1, 5), attemptContext).find(event => event.payload.kind === 'usage')!
assert.equal(firstAttempt.payload.usage.inputTokens, 9)
near(firstAttempt.payload.usage.cost, 0.000002109, 'first attempt cost')
const replacement = projectDeepSeekNativeEvent(sample(2, 7), attemptContext).find(event => event.payload.kind === 'usage')!
assert.equal(replacement.payload.usage.inputTokens, 11)
near(replacement.payload.usage.cost, 0.000002409, 'replacement settlement is charged once')
projectDeepSeekNativeEvent(native(3, 'llm/retry-started', { turn: 7, step: 0 }), attemptContext)
const retried = projectDeepSeekNativeEvent(sample(4, 6), attemptContext).find(event => event.payload.kind === 'usage')!
assert.equal(retried.payload.usage.inputTokens, 21)
near(retried.payload.usage.cost, 0.000004668, 'retry adds a second billed attempt')
// Break caught: pricing a peak-hour sample at the off-peak half rate, or losing
// the route carried by request/header.
const peakContext: DeepSeekProjectionContext = { sessionId: 'peak-live' }
projectDeepSeekNativeEvent(native(40, 'request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } }), peakContext)
const peakUsage = projectDeepSeekNativeEvent(native(41, 'assistant/message', {
  turn: 3, step: 0,
  message: message('peak-reply', 'assistant', [{ type: 'text', text: 'Peak' }], modelSource),
  usage: { inputTokens: 1_000_000, outputTokens: 0 }
}, { time: Date.parse('2026-10-19T02:00:00.000Z') }), peakContext).find(event => event.payload.kind === 'usage')!
near(peakUsage.payload.usage.cost, 0.3, 'peak-hour miss cost')
// Break caught: a model-requested tool with no recorded start loses its name
// and arguments when the native interrupted-result repair is replayed.
const notStarted = normalizeDeepSeekHistory({ session: { id: 'fork-tool' }, inheritedEventCount: 0, events: [
  native(0, 'assistant/message', { turn: 3, step: 0, message: message('reply-tool', 'assistant', [{ type: 'tool-call', id: 'unstarted', name: 'read', arguments: '{\"path\":\"b.ts\"}' }], modelSource), stream: [] }, { surfaceOp: 'append' }),
  native(1, 'tool/result', { turn: 3, step: 0, message: { ...message('repair', 'tool', [{ type: 'text', text: 'Not started' }], { kind: 'tool', callId: 'unstarted' }), toolCallId: 'unstarted', isError: true }, error: { name: 'Interrupted', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
] })
assert.equal(notStarted.events.find(event => event.type === 'tool_call')?.payload.name, 'read')
assert.deepEqual(notStarted.events.find(event => event.type === 'tool_call')?.payload.input, { path: 'b.ts' })
assert.equal(notStarted.events.find(event => event.type === 'tool_call')?.state, 'failed')
const imageRef = { attachmentId: 'native-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
const image = { type: 'image', attachment: imageRef }
const pureImage = projectDeepSeekNativeEvent(native(20, 'assistant/message', { turn: 3, step: 1, message: message('image-only', 'assistant', [image], modelSource), stream: [] }), {})
assert.equal(pureImage.length, 1, 'an image-only native assistant message creates a visible existing image card')
assert.equal(pureImage[0].type, 'tool_call')
assert.equal(pureImage[0].payload.name, 'image_generation')
assert.deepEqual(pureImage[0].payload.result.nativeImage, { eventSeq: 20, blockIndex: 0 })
assert.deepEqual(pureImage[0].payload.result.attachment, imageRef)
const imageTool = projectDeepSeekNativeEvent(native(21, 'tool/result', { turn: 3, step: 1, message: { ...message('image-result', 'tool', [image], { kind: 'tool', callId: 'image-tool' }), toolCallId: 'image-tool' }, meta: { caption: 'native image' } }), {})
const imageToolEvent = imageTool.find(event => event.payload.id === 'image-tool')
assert.deepEqual(imageToolEvent?.payload.result, { content: [image], meta: { caption: 'native image' } }, 'tool details receive the visible result field, including non-text content and metadata')
assert.deepEqual(imageToolEvent?.payload.nativeImages, [{ eventSeq: 21, blockIndex: 0, toolResult: true }],
  'a tool-returned image stays on the call so the row can preview it inline')
assert.equal(imageTool.filter(event => event.payload.name === 'image_generation').length, 0,
  'a tool-returned image must not become a standalone card in the middle of the timeline')
const twoImages = projectDeepSeekNativeEvent(native(22, 'tool/result', { turn: 3, step: 1,
  message: { ...message('two-images', 'tool', [{ type: 'text', text: 'two' }, image, image], { kind: 'tool', callId: 'two-image-tool' }), toolCallId: 'two-image-tool' } }), {})
assert.deepEqual(twoImages[0].payload.nativeImages,
  [{ eventSeq: 22, blockIndex: 1, toolResult: true }, { eventSeq: 22, blockIndex: 2, toolResult: true }],
  'every image block keeps its own selector, in reading order')
assert.deepEqual(projectDeepSeekNativeEvent(native(23, 'tool/result', { turn: 3, step: 1, message: { ...message('text-result', 'tool', [{ type: 'text', text: 'visible tool result' }], { kind: 'tool', callId: 'text-tool' }), toolCallId: 'text-tool' } }), {})[0].payload.result, 'visible tool result')
assert.equal('nativeImages' in projectDeepSeekNativeEvent(native(24, 'tool/result', { turn: 3, step: 1, message: { ...message('plain-result', 'tool', [{ type: 'text', text: 'plain' }], { kind: 'tool', callId: 'plain-tool' }), toolCallId: 'plain-tool' } }), {})[0].payload, false,
  'text-only results never grow an image field')
// Break caught: MCP tool names must be split into provider/server/name — the
// renderer recognizes handoff cards (create_uniagent_task) only through those
// structured fields, so a raw mcp__ name renders as a plain chain row and the
// task card never appears (live turn and restored history alike).
const handoffArgs = { prompt: '审查方案', wait: true, agent: 'codex' }
const mcpContext: DeepSeekProjectionContext = { sessionId: 'mcp-live' }
const mcpCall = projectDeepSeekNativeEvent(native(30, 'tool/call', { turn: 5, step: 0, callId: 'handoff-one', name: 'mcp__uniagent__create_uniagent_task', arguments: JSON.stringify(handoffArgs) }), mcpContext)[0]
assert.equal(mcpCall.type, 'tool_call')
assert.equal(mcpCall.state, 'running')
assert.equal(mcpCall.payload.provider, 'mcp')
assert.equal(mcpCall.payload.server, 'uniagent')
assert.equal(mcpCall.payload.name, 'create_uniagent_task')
assert.deepEqual(mcpCall.payload.input, handoffArgs)
const mcpDone = projectDeepSeekNativeEvent(native(31, 'tool/result', { turn: 5, step: 0, message: { ...message('handoff-result', 'tool', [{ type: 'text', text: 'taskId=53f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e\n\n[uniagent:event=started]' }], { kind: 'tool', callId: 'handoff-one' }), toolCallId: 'handoff-one' } }), mcpContext)[0]
assert.equal(mcpDone.payload.provider, 'mcp', 'the cached call keeps its MCP identity on the result update')
assert.equal(mcpDone.payload.server, 'uniagent')
assert.equal(mcpDone.payload.name, 'create_uniagent_task')
const mcpHistory = normalizeDeepSeekHistory({ session: { id: 'mcp-history' }, events: [
  native(0, 'tool/call', { turn: 5, step: 0, callId: 'handoff-one', name: 'mcp__uniagent__create_uniagent_task', arguments: JSON.stringify(handoffArgs) }),
  native(1, 'tool/result', { turn: 5, step: 0, message: { ...message('handoff-result', 'tool', [{ type: 'text', text: 'done' }], { kind: 'tool', callId: 'handoff-one' }), toolCallId: 'handoff-one' } })
] })
const mcpEvent = mcpHistory.events.find(event => event.type === 'tool_call')!
assert.equal(mcpEvent.payload.provider, 'mcp')
assert.equal(mcpEvent.payload.server, 'uniagent')
assert.equal(mcpEvent.payload.name, 'create_uniagent_task')
assert.deepEqual(mcpEvent.payload.input, handoffArgs)
console.log('deepseek-event-projection: native history, cancelled prefixes, tool updates, four-bucket usage and compaction semantics passed')
