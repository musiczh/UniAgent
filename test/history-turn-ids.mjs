import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

// 需求1/2/3 — restored codex/traex sessions must carry the provider's NATIVE turn
// id as turn_started/turn_completed boundaries (thread id == the rollout session
// id) so historical turns support the same turn-scoped review + 回退 the live path
// does. Old id-less rollouts must NOT synthesize any boundary (no guessing).

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
const temp = await mkdtemp(join(tmpdir(), 'ua-history-turnids-'))
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = temp

const iso = (ms) => new Date(ms).toISOString()
const evt = (ms, payload) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload })

try {
  const { loadCodexLikeEvents } = await server.ssrLoadModule('/src/main/history.ts')
  const base = Date.parse('2026-08-27T00:00:00.000Z')
  const threadId = 'thread-1'

  // Three real turns (A,B,C). C is left OPEN (no task_complete) so EOF must close it.
  const turnA = '01a04169-548d-79d1'
  const turnB = '01a041d8-3965-74c1'
  const turnC = '01a041fb-6f41-7151'
  const withTurn = (ms, turn, payload) =>
    JSON.stringify({ timestamp: iso(ms), turn_id: turn, type: 'event_msg', payload })

  const multi = join(temp, 'multi.jsonl')
  await writeFile(multi, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId, cwd: '/repo' } }),
    // turn A
    withTurn(base + 1, turnA, { type: 'task_started' }),
    JSON.stringify({ timestamp: iso(base + 2), turn_id: turnA, type: 'turn_context', payload: { model: 'm' } }),
    evt(base + 3, { type: 'user_message', message: 'first prompt' }),
    evt(base + 4, { type: 'agent_message', message: 'reply A' }),
    withTurn(base + 5, turnA, { type: 'patch_apply_end', call_id: 'c1', success: true, changes: { 'a.ts': { type: 'update' } } }),
    withTurn(base + 6, turnA, { type: 'task_complete' }),
    // turn B
    withTurn(base + 7, turnB, { type: 'task_started' }),
    evt(base + 8, { type: 'user_message', message: 'second prompt' }),
    evt(base + 9, { type: 'agent_message', message: 'reply B' }),
    withTurn(base + 10, turnB, { type: 'task_complete' }),
    // turn C — no task_complete; EOF must close it
    withTurn(base + 11, turnC, { type: 'task_started' }),
    evt(base + 12, { type: 'user_message', message: 'third prompt' }),
    evt(base + 13, { type: 'agent_message', message: 'reply C' })
  ].join('\n'))

  const replay = await loadCodexLikeEvents(multi, 'traex', threadId)
  const seq = replay.events.map((e) => [
    e.type,
    e.payload?.turnId ?? e.payload?.text ?? null
  ])
  assert.deepEqual(seq, [
    ['user_message', 'first prompt'],
    ['turn_started', turnA],
    ['agent_message', 'reply A'],
    ['file_change', turnA],
    ['turn_completed', turnA],
    ['user_message', 'second prompt'],
    ['turn_started', turnB],
    ['agent_message', 'reply B'],
    ['turn_completed', turnB],
    ['user_message', 'third prompt'],
    ['turn_started', turnC],
    ['agent_message', 'reply C'],
    ['turn_completed', turnC]
  ], 'each turn must open on its user_message and close at the next boundary / EOF')

  for (const e of replay.events) {
    if (e.type === 'turn_started' || e.type === 'turn_completed') {
      assert.equal(e.payload.threadId, threadId, 'boundary must carry the rollout session id as threadId')
    }
  }

  // Steering stays in one timeline and one usage footer across native formats.
  const userFormats = [
    ['legacy', (ms, turnId, text, id) => evt(ms, { type: 'user_message', message: text })],
    ['completed', (ms, turnId, text, id) => withTurn(ms, turnId, {
      type: 'item_completed', item: { type: 'UserMessage', id, content: [{ type: 'text', text }] }
    })],
    ['response', (ms, turnId, text, id) => JSON.stringify({
      timestamp: iso(ms), type: 'response_item', payload: {
        type: 'message', role: 'user', id, content: [{ type: 'text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    })],
    ['canonical', (ms, turnId, text, id) => JSON.stringify({
      timestamp: iso(ms), type: 'history_mutation', payload: {
        operation: 'append', display_completions: [{ turn_id: turnId,
          item: { type: 'UserMessage', id, content: [{ type: 'text', text }] }
        }]
      }
    })]
  ]
  for (const agentId of ['codex', 'traex']) {
    for (const [format, user] of userFormats) {
      const folded = join(temp, `folded-${agentId}-${format}.jsonl`)
      const start = (ms, turnId) => ['response', 'canonical'].includes(format)
        ? evt(ms, { type: 'task_started' })
        : withTurn(ms, turnId, { type: 'task_started' })
      const total = (ms, input, output, cached) => evt(ms, { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }
      } })
      await writeFile(folded, [
        JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
        start(base + 1, turnA),
        user(base + 2, turnA, 'p1', 'initial'),
        evt(base + 3, { type: 'agent_message', message: 'working' }),
        total(base + 4, 100, 10, 80),
        user(base + 5, turnA, 'p2', 'steer'),
        total(base + 6, 300, 30, 240),
        evt(base + 7, { type: 'agent_message', message: 'done', phase: 'final_answer' }),
        withTurn(base + 8, turnA, { type: 'task_complete' }),
        start(base + 9, turnB),
        user(base + 10, turnB, 'p2', 'next'),
        total(base + 11, 350, 35, 280),
        withTurn(base + 12, turnB, { type: 'task_complete' })
      ].join('\n'))
      const foldedReplay = await loadCodexLikeEvents(folded, agentId, threadId)
      assert.deepEqual(
        foldedReplay.events.filter(event => event.payload?.kind !== 'usage')
          .map(event => [event.type, event.payload.turnId ?? event.payload.text, !!event.payload.appendedToTurn]),
        [
          ['user_message', 'p1', false], ['turn_started', turnA, false],
          ['agent_message', 'working', false], ['user_message', 'p2', true],
          ['agent_message', 'done', false], ['turn_completed', turnA, false],
          ['user_message', 'p2', false], ['turn_started', turnB, false], ['turn_completed', turnB, false]
        ],
        `${agentId}/${format}: steering must retain chronological messages inside one native turn; a new id starts a separate turn`
      )
      assert.deepEqual(
        foldedReplay.events.filter(event => event.payload?.kind === 'usage')
          .map(event => [event.payload.usage.inputTokens, event.payload.usage.outputTokens, event.payload.usage.cachedInputTokens]),
        [[300, 30, 240], [50, 5, 40]],
        `${agentId}/${format}: steering must not split or double-count the native turn's usage`
      )
    }
  }

  const segmented = join(temp, 'segmented.jsonl')
  await writeFile(segmented, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'first segment' }),
    JSON.stringify({ timestamp: iso(base + 3), type: 'session_meta', payload: { id: 'other-thread' } }),
    evt(base + 4, { type: 'user_message', message: 'second segment' })
  ].join('\n'))
  const segmentedEvents = (await loadCodexLikeEvents(segmented, 'codex', threadId)).events
  assert.equal(segmentedEvents.some(event => event.payload.appendedToTurn), false,
    'a new history segment must not inherit the preceding native turn')
  assert.equal(segmentedEvents.at(-1).type, 'user_message',
    'an id-less segment must not acquire a synthetic native turn boundary')

  const preciseUsage = join(temp, 'precise-usage.jsonl')
  const usageRecord = (ms, turnId, responseId, usage, turnUsage, threadUsage) =>
    JSON.stringify({
      timestamp: iso(ms),
      type: 'token_usage_record',
      payload: {
        thread_id: threadId,
        turn_id: turnId,
        response_id: responseId,
        usage,
        turn_token_usage: turnUsage,
        thread_token_usage: threadUsage
      }
    })
  const count = (ms, last, total) => evt(ms, {
    type: 'token_count',
    info: { last_token_usage: last, total_token_usage: total, model_context_window: 258_400 }
  })
  await writeFile(preciseUsage, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'usage A' }),
    usageRecord(base + 3, turnA, 'response-a1',
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    count(base + 4, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    evt(base + 4.5, { type: 'user_message', message: 'usage A follow-up' }),
    usageRecord(base + 5, turnA, 'response-a2',
      { input_tokens: 200, cached_input_tokens: 160, output_tokens: 20 },
      { input_tokens: 300, cached_input_tokens: 240, output_tokens: 30 },
      { input_tokens: 300, cached_input_tokens: 240, output_tokens: 30 }),
    count(base + 6, { input_tokens: 200, cached_input_tokens: 160, output_tokens: 20 },
      { input_tokens: 300, cached_input_tokens: 240, output_tokens: 30 }),
    withTurn(base + 7, turnA, { type: 'task_complete' }),
    withTurn(base + 8, turnB, { type: 'task_started' }),
    evt(base + 9, { type: 'user_message', message: 'usage B' }),
    JSON.stringify({ timestamp: iso(base + 10), type: 'compacted', payload: { id: 'compact-1' } }),
    usageRecord(base + 11, turnB, 'response-b1',
      { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 },
      { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 },
      { input_tokens: 350, cached_input_tokens: 280, output_tokens: 35 }),
    count(base + 12, { input_tokens: 45, cached_input_tokens: 40, output_tokens: 5 },
      { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 }),
    withTurn(base + 13, turnB, { type: 'task_complete' })
  ].join('\n'))
  const usageEvents = (await loadCodexLikeEvents(preciseUsage, 'codex', threadId)).events
    .filter((event) => event.type === 'system_notice' && event.payload?.kind === 'usage')
    .map((event) => event.payload.usage)
  assert.deepEqual(usageEvents, [{
    inputTokens: 300, outputTokens: 30, cachedInputTokens: 240,
    input_tokens: 300, output_tokens: 30, total_tokens: 330, cached_input_tokens: 240,
    contextTokens: 200, contextWindow: 258_400,
    sessionInputTokens: 300, sessionOutputTokens: 30, sessionCachedInputTokens: 240
  }, {
    inputTokens: 50, outputTokens: 5, cachedInputTokens: 40,
    input_tokens: 50, output_tokens: 5, total_tokens: 55, cached_input_tokens: 40,
    contextTokens: 45, contextWindow: 258_400,
    sessionInputTokens: 350, sessionOutputTokens: 35, sessionCachedInputTokens: 280
  }], 'token usage records must preserve exact turn and thread totals across compaction resets')

  const mixedUsage = join(temp, 'mixed-usage.jsonl')
  await writeFile(mixedUsage, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, 'legacy-a', { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'legacy A' }),
    count(base + 3, { input_tokens: 500, cached_input_tokens: 400, output_tokens: 50 },
      { input_tokens: 500, cached_input_tokens: 400, output_tokens: 50 }),
    withTurn(base + 4, 'legacy-a', { type: 'task_complete' }),
    withTurn(base + 5, 'legacy-b', { type: 'task_started' }),
    evt(base + 6, { type: 'user_message', message: 'legacy B after reset' }),
    count(base + 7, { input_tokens: 200, cached_input_tokens: 160, output_tokens: 20 },
      { input_tokens: 200, cached_input_tokens: 160, output_tokens: 20 }),
    withTurn(base + 8, 'legacy-b', { type: 'task_complete' }),
    withTurn(base + 9, 'precise-c', { type: 'task_started' }),
    evt(base + 10, { type: 'user_message', message: 'precise C after format switch' }),
    usageRecord(base + 11, 'precise-c', 'response-c1',
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    count(base + 12, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    withTurn(base + 13, 'precise-c', { type: 'task_complete' })
  ].join('\n'))
  const mixedUsageEvents = (await loadCodexLikeEvents(mixedUsage, 'codex', threadId)).events
    .filter((event) => event.type === 'system_notice' && event.payload?.kind === 'usage')
    .map((event) => event.payload.usage)
  assert.deepEqual(
    mixedUsageEvents.map((usage) => [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.sessionInputTokens,
      usage.sessionOutputTokens,
      usage.sessionCachedInputTokens
    ]),
    [
      [500, 50, 400, 500, 50, 400],
      [200, 20, 160, 700, 70, 560],
      [100, 10, 80, 800, 80, 640]
    ],
    'legacy resets and a later precise-format reset must remain additive without corrupting session totals'
  )

  const goalHistory = join(temp, 'goal.jsonl')
  await writeFile(goalHistory, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    JSON.stringify({
      timestamp: iso(base + 2),
      type: 'history_mutation',
      payload: {
        operation: 'append',
        turn_id: turnA,
        items: [{
          id: 'goal-message',
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the Goal bubble</command-args>\n<local-command-stdout>Goal set: ship the Goal bubble</local-command-stdout>'
          }]
        }]
      }
    }),
    JSON.stringify({
      timestamp: iso(base + 3),
      turn_id: turnA,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'ship the Goal bubble' }
    }),
    JSON.stringify({
      timestamp: iso(base + 4),
      turn_id: turnA,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'a real prompt in the same turn' }
    }),
    JSON.stringify({
      timestamp: iso(base + 5),
      type: 'history_mutation',
      payload: {
        operation: 'replace',
        items: [{ id: 'goal-message', type: 'message', role: 'user', content: [{
          type: 'input_text', text: '<command-name>/goal</command-name><command-args>ship the Goal bubble</command-args>'
        }] }]
      }
    }),
    JSON.stringify({
      timestamp: iso(base + 6),
      type: 'history_mutation',
      payload: {
        operation: 'append',
        turn_id: turnA,
        items: [{
          id: 'summary-message', type: 'message', role: 'user', content: [{
            type: 'input_text',
            text: 'A summary quoting <command-name>/goal</command-name><command-args>not a Goal</command-args>'
          }]
        }]
      }
    }),
    evt(base + 7, { type: 'agent_message', message: 'working on it' })
  ].join('\n'))
  const restoredGoal = (await loadCodexLikeEvents(goalHistory, 'traex', threadId)).events
  assert.deepEqual(
    restoredGoal.filter((event) => event.type === 'goal_message').map((event) => event.payload),
    [{ text: 'ship the Goal bubble' }],
    'a native Goal command must restore as a marked user bubble'
  )
  assert.deepEqual(
    restoredGoal.filter((event) => event.type === 'user_message').map((event) => event.payload.text),
    ['a real prompt in the same turn'],
    'only the Goal echo, not another user prompt in the same native turn, is deduplicated'
  )
  assert.equal(
    restoredGoal.filter((event) => event.type === 'turn_started').length,
    1,
    'a Goal marker must not fabricate a rewindable native turn boundary'
  )

  const goalPromptHistory = join(temp, 'goal-prompt.jsonl')
  const turnGoal = '01a041fc-goal-turn'
  await writeFile(goalPromptHistory, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    evt(base + 1, {
      type: 'thread_goal_updated',
      goal: { objective: 'ship Goal response', status: 'active' }
    }),
    withTurn(base + 2, turnGoal, { type: 'task_started' }),
    evt(base + 3, { type: 'user_message', message: 'ship Goal response' }),
    evt(base + 4, { type: 'agent_message', message: 'done' }),
    withTurn(base + 5, turnGoal, { type: 'task_complete' })
  ].join('\n'))
  const restoredGoalPrompt = (await loadCodexLikeEvents(
    goalPromptHistory, 'traex', threadId
  )).events
  assert.deepEqual(
    restoredGoalPrompt.map((event) => [
      event.type,
      event.payload?.turnId ?? event.payload?.text ?? null
    ]),
    [
      ['goal_message', 'ship Goal response'],
      ['turn_started', turnGoal],
      ['agent_message', 'done'],
      ['turn_completed', turnGoal]
    ],
    'a Goal update followed by a matching normal turn must restore as one marked user turn'
  )

  // Old id-less rollout (early codex): NO turn_id anywhere → emit NO boundaries
  // and NO turnId on file_change (never guess).
  const idless = join(temp, 'idless.jsonl')
  await writeFile(idless, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    evt(base + 1, { type: 'user_message', message: 'legacy prompt' }),
    evt(base + 2, { type: 'agent_message', message: 'legacy reply' }),
    evt(base + 3, { type: 'patch_apply_end', call_id: 'c9', success: true, changes: { 'z.ts': { type: 'update' } } }),
    evt(base + 4, { type: 'user_message', message: 'legacy follow-up' })
  ].join('\n'))
  const idlessReplay = await loadCodexLikeEvents(idless, 'codex', threadId)
  assert.equal(
    idlessReplay.events.some((e) => e.type === 'turn_started' || e.type === 'turn_completed'),
    false,
    'id-less rollouts must not synthesize turn boundaries'
  )
  assert.equal(idlessReplay.events.some(event => event.payload.appendedToTurn), false,
    'messages without native turn ids must not be guessed to be steering')
  const legacyFileChange = idlessReplay.events.find((e) => e.type === 'file_change')
  assert.ok(legacyFileChange)
  assert.equal(legacyFileChange.payload.turnId, undefined, 'id-less file_change must not carry a guessed turnId')

  // Newer TraeX rollouts persist visible messages as item_completed records
  // instead of the older user_message / agent_message event_msg variants.
  const completedMessages = join(temp, 'completed-messages.jsonl')
  await writeFile(completedMessages, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, {
      type: 'item_completed',
      item: { type: 'UserMessage', id: 'user-a', content: [{ type: 'text', text: 'restored prompt' }] }
    }),
    evt(base + 3, {
      type: 'item_completed',
      item: { type: 'AgentMessage', id: 'agent-a', content: [{ type: 'Text', text: 'restored reply' }], phase: 'final_answer' }
    }),
    withTurn(base + 4, turnA, { type: 'task_complete' })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(completedMessages, 'traex', threadId)).events
      .filter((event) => event.type === 'user_message' || event.type === 'agent_message')
      .map((event) => [event.type, event.payload.text]),
    [['user_message', 'restored prompt'], ['agent_message', 'restored reply']],
    'item_completed messages must survive rewind history replay'
  )

  const mixedMessages = join(temp, 'mixed-messages.jsonl')
  const responseMessage = (ms, role, text, id) => JSON.stringify({
    timestamp: iso(ms), type: 'response_item',
    payload: { type: 'message', role, ...(id ? { id } : {}), content: [{ type: 'text', text }] }
  })
  await writeFile(mixedMessages, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'continue' }),
    responseMessage(base + 3, 'user', 'continue'),
    evt(base + 4, { type: 'agent_message', message: 'legacy reply' }),
    responseMessage(base + 5, 'assistant', 'legacy reply'),
    withTurn(base + 6, turnA, { type: 'task_complete' }),
    withTurn(base + 7, turnB, { type: 'task_started' }),
    evt(base + 8, { type: 'item_completed', item: {
      type: 'UserMessage', id: 'modern-user', content: [{ type: 'text', text: 'continue' }]
    } }),
    responseMessage(base + 9, 'user', 'continue', 'modern-user'),
    evt(base + 10, { type: 'agent_message', message: 'process update' }),
    responseMessage(base + 11, 'assistant', 'process update'),
    evt(base + 12, { type: 'item_completed', item: {
      type: 'AgentMessage', id: 'modern-final', phase: 'final_answer',
      content: [{ type: 'Text', text: 'modern final reply' }]
    } }),
    responseMessage(base + 13, 'assistant', 'modern final reply', 'modern-final'),
    // Repeated identical inputs in one native turn are separate messages.
    evt(base + 14, { type: 'item_completed', item: {
      type: 'UserMessage', id: 'modern-steer', content: [{ type: 'text', text: 'continue' }]
    } }),
    responseMessage(base + 15, 'user', 'continue', 'modern-steer'),
    responseMessage(base + 16, 'assistant', 'response-only reply'),
    JSON.stringify({ timestamp: iso(base + 17), type: 'history_mutation', payload: {
      operation: 'append', turn_id: turnB, display_completions: [
        { item: { type: 'AgentMessage', id: 'modern-final', phase: 'final_answer',
          content: [{ type: 'Text', text: 'modern final reply' }] } },
        { item: { type: 'AgentMessage', id: 'display-only', phase: 'final_answer',
          content: [{ type: 'Text', text: 'display-only reply' }] } }
      ]
    } }),
    withTurn(base + 18, turnB, { type: 'task_complete' })
  ].join('\n'))
  const mixedMessageEvents = (await loadCodexLikeEvents(mixedMessages, 'codex', threadId)).events
  assert.deepEqual(
    mixedMessageEvents.filter(event => ['user_message', 'agent_message'].includes(event.type))
      .map(event => [event.type, event.payload.text]),
    [
      ['user_message', 'continue'], ['agent_message', 'legacy reply'],
      ['user_message', 'continue'], ['agent_message', 'process update'],
      ['agent_message', 'modern final reply'], ['user_message', 'continue'],
      ['agent_message', 'response-only reply'], ['agent_message', 'display-only reply']
    ],
    'mixed message formats must retain unique messages and repeated inputs without replaying duplicate copies'
  )
  assert.equal(mixedMessageEvents.find(event => event.payload?.id === 'modern-final')?.payload.phase,
    'final_answer', 'the completed final reply must retain its native id and phase')

  // TraeX canonical_v1 persists visible conversation items inside
  // history_mutation.display_completions instead of standalone response_item or
  // item_completed records. Reopening the session must restore that transcript.
  const canonicalHistory = join(temp, 'canonical-v1.jsonl')
  await writeFile(canonicalHistory, [
    JSON.stringify({
      timestamp: iso(base),
      type: 'session_meta',
      payload: {
        id: threadId,
        history_format: 'canonical_v1',
        history_mode: 'paginated'
      }
    }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    JSON.stringify({
      timestamp: iso(base + 2),
      type: 'history_mutation',
      payload: {
        operation: 'append',
        turn_id: turnA,
        display_completions: [
          {
            thread_id: threadId,
            turn_id: turnA,
            item: {
              type: 'UserMessage',
              id: 'canonical-user',
              content: [{ type: 'text', text: 'canonical prompt', text_elements: [] }]
            }
          },
          {
            thread_id: threadId,
            turn_id: turnA,
            item: {
              type: 'AgentMessage',
              id: 'canonical-agent',
              phase: 'final_answer',
              content: [{ type: 'Text', text: 'canonical reply' }]
            }
          },
          {
            thread_id: threadId,
            turn_id: turnA,
            item: {
              type: 'Reasoning',
              id: 'canonical-reasoning',
              summary_text: [],
              raw_content: ['canonical reasoning']
            }
          }
        ]
      }
    }),
    withTurn(base + 3, turnA, { type: 'task_complete' })
  ].join('\n'))
  const canonicalEvents = (await loadCodexLikeEvents(
    canonicalHistory, 'traex', threadId
  )).events
  assert.deepEqual(
    canonicalEvents.map((event) => [
      event.type,
      event.payload?.turnId ?? event.payload?.text ?? null,
      event.payload?.phase ?? null
    ]),
    [
      ['user_message', 'canonical prompt', null],
      ['turn_started', turnA, null],
      ['agent_message', 'canonical reply', 'final_answer'],
      ['reasoning', 'canonical reasoning', null],
      ['turn_completed', turnA, null]
    ],
    'canonical_v1 display completions must restore visible messages, reasoning, and turn boundaries'
  )

  // Mixed rollout: a new id-less task_started must clear the previous native id,
  // while a later identified turn can establish a fresh boundary again.
  const mixed = join(temp, 'mixed.jsonl')
  await writeFile(mixed, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'identified' }),
    withTurn(base + 3, turnA, { type: 'task_complete' }),
    evt(base + 4, { type: 'task_started' }),
    evt(base + 5, { type: 'user_message', message: 'legacy middle' }),
    evt(base + 6, { type: 'patch_apply_end', call_id: 'mixed', success: true, changes: { 'm.ts': { type: 'update' } } }),
    withTurn(base + 7, turnC, { type: 'task_started' }),
    evt(base + 8, { type: 'user_message', message: 'identified again' })
  ].join('\n'))
  const mixedEvents = (await loadCodexLikeEvents(mixed, 'traex', threadId)).events
  assert.deepEqual(
    mixedEvents.filter((e) => e.type === 'turn_started').map((e) => e.payload.turnId),
    [turnA, turnC],
    'an id-less task_started must not inherit the preceding turn id'
  )
  assert.equal(
    mixedEvents.find((e) => e.type === 'file_change')?.payload.turnId,
    undefined,
    'an id-less middle turn must not inherit turnId on file changes'
  )

  // Rollback records mutate the native transcript. Replaying them as no-ops
  // would resurrect discarded prompts/replies during preview and cross-agent
  // export. Cover both legacy Codex and modern TraeX wire formats.
  const rollback = join(temp, 'rollback.jsonl')
  const turnD = '01a04200-legacy-discarded'
  const turnE = '01a04201-modern-discarded'
  const turnF = '01a04202-replacement'
  await writeFile(rollback, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'kept before rollback' }),
    evt(base + 3, { type: 'agent_message', message: 'kept reply' }),
    withTurn(base + 4, turnA, { type: 'task_complete' }),
    withTurn(base + 5, turnD, { type: 'task_started' }),
    evt(base + 6, { type: 'user_message', message: 'legacy discarded prompt' }),
    evt(base + 7, { type: 'agent_reasoning_raw_content', text: 'legacy discarded reasoning' }),
    evt(base + 8, { type: 'agent_message', message: 'legacy discarded reply' }),
    evt(base + 9, { type: 'thread_rolled_back', num_turns: 1 }),
    withTurn(base + 10, turnE, { type: 'task_started' }),
    evt(base + 11, { type: 'user_message', message: 'modern discarded prompt' }),
    evt(base + 12, { type: 'agent_message', message: 'modern discarded reply' }),
    JSON.stringify({
      timestamp: iso(base + 13),
      type: 'history_mutation',
      payload: {
        operation: 'rollback',
        num_turns: 1,
        target_turn_id: turnE,
        target_commit_id: 'discarded-commit'
      }
    }),
    withTurn(base + 14, turnF, { type: 'task_started' }),
    evt(base + 15, { type: 'user_message', message: 'replacement prompt' }),
    evt(base + 16, { type: 'agent_message', message: 'replacement reply' }),
    withTurn(base + 17, turnF, { type: 'task_complete' })
  ].join('\n'))
  const rollbackEvents = (await loadCodexLikeEvents(rollback, 'traex', threadId)).events
  assert.deepEqual(
    rollbackEvents
      .filter((event) => event.type === 'user_message' || event.type === 'agent_message')
      .map((event) => event.payload.text),
    ['kept before rollback', 'kept reply', 'replacement prompt', 'replacement reply'],
    'legacy and modern rollback must remove discarded turns while preserving the replacement'
  )
  assert.deepEqual(
    rollbackEvents
      .filter((event) => event.type === 'turn_started')
      .map((event) => event.payload.turnId),
    [turnA, turnF],
    'rollback must remove the discarded native turn boundaries too'
  )
  assert.equal(
    rollbackEvents.some((event) => event.payload?.text?.includes('discarded')),
    false,
    'rollback must remove discarded reasoning and other turn-scoped detail'
  )

  const delayedModernTurnId = join(temp, 'delayed-modern-turn-id.jsonl')
  await writeFile(delayedModernTurnId, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'delayed kept' }),
    withTurn(base + 3, turnA, { type: 'task_complete' }),
    evt(base + 4, { type: 'task_started' }),
    JSON.stringify({
      timestamp: iso(base + 5), type: 'history_mutation',
      payload: { operation: 'append', turn_id: turnE, items: [] }
    }),
    evt(base + 6, { type: 'user_message', message: 'delayed discarded' }),
    JSON.stringify({
      timestamp: iso(base + 7), type: 'history_mutation',
      payload: { operation: 'rollback', num_turns: 1, target_turn_id: turnE }
    })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(delayedModernTurnId, 'traex', threadId)).events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    ['delayed kept'],
    'modern rollback must accept a turn id first persisted after task_started'
  )

  const multiRollback = join(temp, 'multi-rollback.jsonl')
  const turnG = '01a04203-multi-discarded-first'
  const turnH = '01a04204-multi-discarded-second'
  const turnI = '01a04205-multi-replacement'
  await writeFile(multiRollback, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'multi kept' }),
    withTurn(base + 3, turnA, { type: 'task_complete' }),
    withTurn(base + 4, turnG, { type: 'task_started' }),
    evt(base + 5, { type: 'user_message', message: 'multi discarded one' }),
    withTurn(base + 6, turnG, { type: 'task_complete' }),
    withTurn(base + 7, turnH, { type: 'task_started' }),
    evt(base + 8, { type: 'user_message', message: 'multi discarded two' }),
    evt(base + 9, { type: 'thread_rolled_back', num_turns: 2 }),
    withTurn(base + 10, turnI, { type: 'task_started' }),
    evt(base + 11, { type: 'user_message', message: 'multi replacement' })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(multiRollback, 'codex', threadId)).events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    ['multi kept', 'multi replacement'],
    'legacy rollback must remove the requested number of complete turns'
  )

  const malformedRollback = join(temp, 'malformed-rollback.jsonl')
  await writeFile(malformedRollback, [
    JSON.stringify({ timestamp: iso(base), type: 'session_meta', payload: { id: threadId } }),
    withTurn(base + 1, turnA, { type: 'task_started' }),
    evt(base + 2, { type: 'user_message', message: 'malformed kept A' }),
    withTurn(base + 3, turnA, { type: 'task_complete' }),
    withTurn(base + 4, turnB, { type: 'task_started' }),
    evt(base + 5, { type: 'user_message', message: 'malformed kept B' }),
    JSON.stringify({
      timestamp: iso(base + 6),
      type: 'history_mutation',
      payload: { operation: 'rollback', num_turns: 1, target_turn_id: turnA }
    }),
    evt(base + 7, { type: 'thread_rolled_back', num_turns: 99 }),
    JSON.stringify({
      timestamp: iso(base + 8),
      type: 'history_mutation',
      payload: { operation: 'rollback', num_turns: 1, target_turn_id: 'missing-turn' }
    })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(malformedRollback, 'traex', threadId)).events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    ['malformed kept A', 'malformed kept B'],
    'mismatched targets and oversized counts must be conservative no-ops'
  )

  // Diagnostics resolved by this parser release disappear only for the exact
  // report snapshot. The source file remains byte-for-byte untouched, and a
  // later regression with the same key must produce a fresh visible entry.
  const { DiagnosticsStore } = await server.ssrLoadModule('/src/main/diagnostics.ts')
  const closeLifecycle = join(temp, 'collab-close.jsonl')
  const { diagnostics: migrationDiagnostics } = await server.ssrLoadModule('/src/main/diagnostics.ts')
  migrationDiagnostics.clear()
  await writeFile(closeLifecycle, evt(base, {
    type: 'collab_close_end',
    call_id: 'close-running-child',
    sender_thread_id: threadId,
    receiver_thread_id: 'child-thread',
    status: 'running'
  }) + '\n' + JSON.stringify({
    timestamp: iso(base + 1),
    type: 'token_usage_record',
    payload: {
      thread_id: threadId,
      turn_id: turnA,
      thread_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }))
  assert.deepEqual(
    (await loadCodexLikeEvents(closeLifecycle, 'traex', threadId)).events
      .filter((event) => event.payload?.kind !== 'usage'),
    [],
    'collab_close_end is an operation result and must not fabricate timeline data'
  )
  assert.equal(
    migrationDiagnostics.list().some(({ code, field }) =>
      (code === 'unknown_event_msg_type' && field === 'collab_close_end') ||
      (code === 'unknown_rollout_record' && field === 'token_usage_record')
    ),
    false,
    'supported lifecycle and token-usage metadata must not create migration diagnostics'
  )
  const diagnosticsFile = join(temp, 'migration-diagnostics.jsonl')
  const cutoff = Date.parse('2026-09-08T13:25:46.286Z')
  const diagnostic = (id, ts, code, field, message = 'fixture') => ({
    id, ts, level: 'warn', agentId: 'traex', code, field, message, count: 7
  })
  const legacyResolved = diagnostic(
    'legacy-resolved', cutoff, 'unknown_event_msg_type', 'thread_rolled_back', 'old noise'
  )
  const futureSameKey = diagnostic(
    'future-same-key', cutoff + 1, 'unknown_event_msg_type', 'thread_rolled_back', 'new regression'
  )
  const oldUnknown = diagnostic(
    'old-unknown', cutoff - 1, 'unknown_event_msg_type', 'future_event'
  )
  const resolvedReportEntries = [
    ['token-usage', 'unknown_rollout_record', 'token_usage_record'],
    ['collab-close', 'unknown_event_msg_type', 'collab_close_end'],
    ['terminal', 'unknown_event_msg_type', 'terminal_interaction'],
    ['reasoning', 'unknown_event_msg_type', 'agent_reasoning_raw_content'],
    ['communication', 'unknown_rollout_record', 'inter_agent_communication'],
    ['interaction', 'unknown_event_msg_type', 'collab_agent_interaction_end'],
    ['spawn', 'unknown_event_msg_type', 'collab_agent_spawn_end']
  ].map(([id, code, field]) => diagnostic(id, cutoff, code, field))
  const diagnosticsRaw = [
    JSON.stringify(legacyResolved),
    ...resolvedReportEntries.map((entry) => JSON.stringify(entry)),
    '{malformed-future-line',
    JSON.stringify(futureSameKey),
    JSON.stringify(oldUnknown)
  ].join('\n') + '\n'
  await writeFile(diagnosticsFile, diagnosticsRaw)
  const diagnostics = new DiagnosticsStore(diagnosticsFile)
  assert.deepEqual(
    diagnostics.list().map(({ id }) => id),
    ['future-same-key', 'old-unknown'],
    'only exact resolved keys at or before the report cutoff must be hidden'
  )
  assert.match(diagnostics.formatReport(), /条目数: 2/)
  assert.equal(
    await readFile(diagnosticsFile, 'utf8'),
    diagnosticsRaw,
    'read-only cleanup must not rewrite or discard malformed/future diagnostic lines'
  )
  const repeatFile = join(temp, 'migration-diagnostics-repeat.jsonl')
  await writeFile(repeatFile, JSON.stringify(legacyResolved) + '\n')
  const repeatStore = new DiagnosticsStore(repeatFile)
  const realNow = Date.now
  Date.now = () => cutoff + 2
  try {
    const fresh = repeatStore.record({
      level: 'warn',
      agentId: 'traex',
      code: 'unknown_event_msg_type',
      field: 'thread_rolled_back',
      message: 'fresh regression'
    })
    assert.equal(fresh.count, 1, 'a future same-key diagnostic must not revive a hidden old count')
    assert.equal(fresh.message, 'fresh regression')
    assert.deepEqual(repeatStore.list().map(({ id }) => id), [fresh.id])
  } finally {
    Date.now = realNow
  }

  console.log('history-turn-ids: ok')
} finally {
  await server.close()
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  await rm(temp, { recursive: true, force: true })
}
