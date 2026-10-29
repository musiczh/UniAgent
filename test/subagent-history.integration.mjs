import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
const temp = await mkdtemp(join(tmpdir(), 'ua-req5-history-'))
const previousHome = process.env.HOME
process.env.HOME = temp

const record = (timestamp, payload) => JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: 'event_msg', payload })
const activity = (timestamp, child, kind, eventId) => record(timestamp, {
  type: 'sub_agent_activity',
  agent_thread_id: child,
  agent_path: `/agents/${child}.md`,
  kind,
  occurred_at_ms: timestamp,
  event_id: eventId
})
const rootedActivity = (timestamp, child, path, kind, eventId) => record(timestamp, {
  type: 'sub_agent_activity',
  agent_thread_id: child,
  agent_path: path,
  kind,
  occurred_at_ms: timestamp,
  event_id: eventId
})
const communication = (timestamp, payload) => JSON.stringify({
  timestamp: new Date(timestamp).toISOString(),
  type: 'inter_agent_communication',
  payload
})

try {
  const { exportNativeSession, loadCodexLikeEvents, loadSessionEvents, rolloutGenerationEndTimestamp } =
    await server.ssrLoadModule('/src/main/history.ts')
  const base = Date.parse('2026-08-23T00:00:00.000Z')
  const nativeParent = join(temp, 'native-nicknames.jsonl')
  const nativeCollab = (timestamp, id, tool, states, prompt) => record(timestamp, {
    type: 'item_completed', item: {
      type: 'CollabAgentToolCall', id, tool, sender_thread_id: 'nickname-parent',
      receiver_thread_ids: Object.keys(states),
      receiver_agents: [
        { thread_id: 'nickname-b', agent_nickname: 'Curie', agent_role: 'worker' },
        { thread_id: 'nickname-a', agent_nickname: 'Dirac', agent_role: 'worker' }
      ],
      agents_states: states, prompt
    }
  })
  await writeFile(nativeParent, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'nickname-parent' } }),
    nativeCollab(base, 'nickname-spawn', 'spawn_agent', { 'nickname-a': 'pending_init', 'nickname-b': 'running' }, '生成最终报告 v2。保留证据。'),
    nativeCollab(base + 100, 'nickname-append', 'send_input', { 'nickname-a': 'running' }, '补查截图数量'),
    nativeCollab(base + 200, 'nickname-wait', 'wait', { 'nickname-a': { completed: 'done' }, 'nickname-b': { interrupted: 'stopped' } }),
    nativeCollab(base + 250, 'nickname-fast', 'spawn_agent', { 'nickname-fast': { completed: 'done' } }, '核对截图。'),
    nativeCollab(base + 300, 'nickname-resume', 'resume_agent', { 'nickname-a': 'running' }, '更新最终报告 v3。')
  ].join('\n'))
  const nicknameEvents = (await loadCodexLikeEvents(nativeParent, 'codex', 'nickname-parent', async () => new Map())).events
  const nicknameAgents = nicknameEvents.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
  assert.ok(nicknameAgents.some(agent => agent.agentThreadId === 'nickname-a' && agent.name === 'Dirac'),
    'persisted receiver_agents must restore native nicknames')
  assert.ok(nicknameAgents.some(agent => agent.agentThreadId === 'nickname-b' && agent.name === 'Curie' && agent.status === 'interrupted'))
  assert.ok(nicknameAgents.some(agent => agent.tool === 'interacted' && agent.prompt === '生成最终报告 v2。保留证据。'),
    'follow-ups must preserve the dispatch task used by the summary')
  assert.ok(nicknameAgents.some(agent => agent.generation === 2 && agent.prompt === '更新最终报告 v3。'),
    'a newer dispatch must restore its own task')
  assert.deepEqual(nicknameAgents.filter(agent => agent.agentThreadId === 'nickname-fast').map(agent => agent.status),
    ['running', 'completed'], 'fast completed spawns must retain both lifecycle rows')

  const legacyChildId = 'nickname-legacy-child'
  const legacyDir = join(temp, '.codex', 'sessions', '2026', '08', '23')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, `rollout-fixture-${legacyChildId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: {
      id: legacyChildId,
      source: { subagent: { thread_spawn: { parent_thread_id: 'legacy-parent', agent_nickname: 'Dalton' } } }
    }
  }))
  const legacyParent = join(temp, 'legacy-nickname-parent.jsonl')
  await writeFile(legacyParent, [
    record(base, { type: 'sub_agent_activity', agent_thread_id: legacyChildId, kind: 'started' }),
    record(base + 100, { type: 'sub_agent_activity', agent_thread_id: legacyChildId, kind: 'completed' })
  ].join('\n'))
  const legacyAgents = (await loadCodexLikeEvents(legacyParent, 'codex', 'legacy-parent', async () => new Map()))
    .events.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
  assert.deepEqual(legacyAgents.map(agent => agent.name), ['Dalton', 'Dalton'],
    'legacy nameless lifecycle rows must recover the child session nickname')
  await writeFile(join(legacyDir, `rollout-fixture-${legacyChildId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: {
      id: legacyChildId,
      source: { subagent: { thread_spawn: { parent_thread_id: 'foreign-parent', agent_nickname: 'Foreign' } } }
    }
  }))
  const foreignAgents = (await loadCodexLikeEvents(legacyParent, 'codex', 'legacy-parent', async () => new Map()))
    .events.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
  assert.ok(foreignAgents.every(agent => !agent.name), 'foreign child metadata must leave fallback names unchanged')
  const paginatedChildId = 'paginated-child'
  const childHistoryDir = join(temp, '.codex', 'sessions', '2026', '08', '23')
  await mkdir(childHistoryDir, { recursive: true })
  const paginatedChild = join(childHistoryDir, `rollout-fixture-${paginatedChildId}.jsonl`)
  const nativeCommunication = (id, text, author = '/root', recipient = '/root/inspect') => ({
    type: 'response_item',
    payload: {
      type: 'agent_message', id, author, recipient,
      content: [{ type: 'input_text', text: `Message Type: MESSAGE\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${text}` }]
    }
  })
  // Ordinals deliberately have gaps; inherited records are restamped at spawn.
  const paginatedRecords = [
    { ordinal: 0, type: 'session_meta', payload: {
      id: paginatedChildId, cwd: '/child', agent_path: '/root/inspect',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-native' } } },
      subagent_history_start_ordinal: 40
    } },
    { ordinal: 4, type: 'session_meta', payload: { id: 'parent-native', cwd: '/parent' } },
    { ordinal: 9, type: 'compacted', payload: {} },
    { ordinal: 11, type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'inherited parent answer' }]
    } },
    { ordinal: 18, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inherited parent question' }]
    } },
    { ordinal: 35, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent-turn' } },
    { ordinal: 40, type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
    { ordinal: 41, ...nativeCommunication('assignment', 'inspect the settings') },
    { ordinal: 42, type: 'event_msg', payload: {
      type: 'exec_command_end', call_id: 'child-command', command: ['pwd'], exit_code: 0, aggregated_output: '/child'
    } },
    { ordinal: 43, ...nativeCommunication('followup', 'also inspect the fallback') },
    { ordinal: 44, ...nativeCommunication('sibling-input', 'ignore sibling input', '/root/sibling') },
    { ordinal: 45, ...nativeCommunication('other-recipient', 'ignore other recipient', '/root', '/root/other') },
    { ordinal: 46, type: 'event_msg', payload: { type: 'agent_message', message: 'child answer', phase: 'final_answer' } }
  ].map((entry, index) => ({ timestamp: new Date(base + (index < 6 ? 0 : index * 100)).toISOString(), ...entry }))
  await writeFile(paginatedChild, paginatedRecords.map(entry => JSON.stringify(entry)).join('\n'))
  const paginatedReplay = await loadSessionEvents('codex', paginatedChildId)
  assert.deepEqual(
    paginatedReplay.events.filter(event => ['user_message', 'agent_message'].includes(event.type))
      .map(event => [event.type, event.payload.text]),
    [['user_message', 'inspect the settings'], ['user_message', 'also inspect the fallback'], ['agent_message', 'child answer']],
    'native child replay must exclude inherited conversation and restore only messages from its direct parent'
  )
  assert.equal(paginatedReplay.cwd, '/child', 'inherited metadata must not overwrite child identity')
  assert.equal(paginatedReplay.events.some(event => event.type === 'context_compaction'), false)
  assert.equal(paginatedReplay.events.filter(event => event.type === 'command_exec').length, 1)
  assert.equal(paginatedReplay.events.filter(event => event.type === 'turn_started').length, 1)
  assert.equal(paginatedReplay.events.find(event => event.type === 'user_message' && event.payload.appendedToTurn)?.payload.text,
    'also inspect the fallback', 'parent follow-ups must stay inside the native child turn')
  assert.equal(await rolloutGenerationEndTimestamp(paginatedChild, base), base + 1200,
    'inherited terminal records restamped at spawn must not end the child generation')

  const unfinishedChild = join(temp, 'unfinished-paginated-child.jsonl')
  await writeFile(unfinishedChild, paginatedRecords.slice(0, -1).map(entry => JSON.stringify(entry)).join('\n'))
  assert.equal(await rolloutGenerationEndTimestamp(unfinishedChild, base), undefined,
    'a running child must not inherit a parent completion timestamp')

  const unreadableTask = nativeCommunication('encrypted-assignment', '')
  unreadableTask.payload.content.push({ type: 'encrypted_content', encrypted_content: 'opaque-history-content' })
  const encryptedReplay = (await loadCodexLikeEvents(paginatedChild, 'codex', paginatedChildId, async () => new Map(), [
    paginatedRecords[0],
    paginatedRecords[6],
    { timestamp: new Date(base + 700).toISOString(), ordinal: 41, ...unreadableTask },
    { timestamp: new Date(base + 800).toISOString(), ordinal: 42, ...nativeCommunication('readable-followup', 'readable follow-up') },
    { timestamp: new Date(base + 900).toISOString(), ordinal: 43, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'readable follow-up' }]
    } }
  ].map(entry => JSON.stringify(entry)).join('\n'))).events
  assert.deepEqual(encryptedReplay.filter(event => event.type === 'user_message').map(event => event.payload.text),
    ['readable follow-up'], 'unreadable parent messages must not create placeholder bubbles')
  assert.equal(JSON.stringify(encryptedReplay).includes('opaque-history-content'), false,
    'encrypted task content must never be rendered as text')
  assert.equal(JSON.stringify(encryptedReplay).includes('Message Type:'), false,
    'native inter-agent envelopes must not appear as task content')
  const legacyEncrypted = (await loadCodexLikeEvents(paginatedChild, 'codex', paginatedChildId, async () => new Map(), [
    JSON.stringify(paginatedRecords[0]),
    communication(base + 700, {
      id: 'legacy-encrypted', kind: 'new_task', author: '/root', recipient: '/root/inspect',
      encrypted_content: 'opaque-legacy-content'
    })
  ].join('\n'))).events
  assert.equal(legacyEncrypted.some(event => event.type === 'user_message'), false,
    'legacy encrypted payloads without readable content must not create messages')

  const opaqueFollowup = nativeCommunication('encrypted-followup', '')
  opaqueFollowup.payload.content.push({ type: 'encrypted_content', encrypted_content: 'opaque-followup' })
  const recoverableRecords = [
    paginatedRecords[0],
    paginatedRecords[6],
    { timestamp: new Date(base + 700).toISOString(), ordinal: 41, ...unreadableTask },
    { timestamp: new Date(base + 770).toISOString(), ordinal: 42, type: 'event_msg', payload: {
      type: 'exec_command_end', call_id: 'between-messages', command: ['pwd'], exit_code: 0
    } },
    { timestamp: new Date(base + 800).toISOString(), ordinal: 43, ...opaqueFollowup },
    { timestamp: new Date(base + 900).toISOString(), ordinal: 44, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'also inspect the fallback' }]
    } }
  ]
  const recoverableText = recoverableRecords.map(entry => JSON.stringify(entry)).join('\n')
  const parentHistoryFile = join(childHistoryDir, 'rollout-fixture-parent-native.jsonl')
  const dispatch = (timestamp, id, name, message, childId = paginatedChildId, path = '/root/inspect') => [
    JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: 'response_item', payload: {
      type: 'function_call', namespace: 'collaboration', name, call_id: id,
      arguments: JSON.stringify({ task_name: 'inspect', target: path, message })
    } }),
    record(timestamp + 1, { type: 'item_completed', item: {
      type: 'SubAgentActivity', id, kind: name === 'spawn_agent' ? 'started' : 'interacted',
      agent_thread_id: childId, agent_path: path
    } })
  ]
  const parentRecords = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'parent-native' } }),
    ...dispatch(base + 400, 'recover-spawn', 'spawn_agent', 'inspect the settings'),
    ...dispatch(base + 500, 'other-spawn', 'spawn_agent', 'sibling task', 'sibling', '/root/sibling'),
    ...dispatch(base + 750, 'recover-followup', 'send_message', 'also inspect the fallback')
  ]
  await writeFile(parentHistoryFile, parentRecords.join('\n'))
  const recover = async (text = recoverableText) => (await loadCodexLikeEvents(
    paginatedChild, 'codex', paginatedChildId, async () => new Map(), text
  )).events
  const recovered = await recover()
  assert.deepEqual(recovered.filter(event => ['user_message', 'command_exec'].includes(event.type))
    .map(event => [event.type, event.payload.text || event.payload.id]), [
      ['user_message', 'inspect the settings'], ['command_exec', 'between-messages'],
      ['user_message', 'also inspect the fallback']
    ], 'verified parent calls restore opaque messages in child order without duplicating plaintext copies')
  assert.equal(recovered.find(event => event.payload.text === 'also inspect the fallback')?.payload.appendedToTurn, true)
  assert.equal(JSON.stringify(recovered).includes('opaque-'), false)

  const encryptedInput = `gAAAAA${'B'.repeat(92)}==`
  const encryptedParentRecords = [
    parentRecords[0],
    ...dispatch(base + 400, 'recover-spawn', 'spawn_agent', encryptedInput),
    ...dispatch(base + 750, 'recover-followup', 'send_message', 'also inspect the fallback')
  ]
  await writeFile(parentHistoryFile, encryptedParentRecords.join('\n'))
  const opaqueChildText = recoverableRecords.map(entry => entry === recoverableRecords[4]
    ? { ...entry, ...opaqueFollowup } : entry).map(entry => JSON.stringify(entry)).join('\n')
  const opaqueRecovery = await recover(opaqueChildText)
  assert.deepEqual(opaqueRecovery.filter(event => event.type === 'user_message').map(event => event.payload.text),
    ['also inspect the fallback'], 'encrypted parent arguments must not become input or block a readable follow-up')
  assert.equal(JSON.stringify(opaqueRecovery).includes(encryptedInput), false)
  const opaqueDirect = (await loadCodexLikeEvents(paginatedChild, 'codex', paginatedChildId, async () => new Map(), [
    paginatedRecords[0], paginatedRecords[6],
    { timestamp: new Date(base + 700).toISOString(), ordinal: 41, ...nativeCommunication('opaque-direct', encryptedInput) },
    { timestamp: new Date(base + 800).toISOString(), ordinal: 42, ...nativeCommunication('readable-direct', '检查接口实现') }
  ].map(entry => JSON.stringify(entry)).join('\n'))).events
  assert.deepEqual(opaqueDirect.filter(event => event.type === 'user_message').map(event => event.payload.text),
    ['检查接口实现'], 'opaque text in a native communication must be hidden too')
  const opaqueRoster = (await loadCodexLikeEvents(parentHistoryFile, 'codex', 'parent-native', async () => new Map(), [
    encryptedParentRecords[0],
    nativeCollab(base, 'opaque-dispatch', 'spawn_agent', { 'opaque-child': 'running' }, encryptedInput)
      .replace('nickname-parent', 'parent-native')
  ].join('\n'))).events.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
  assert.ok(opaqueRoster.length > 0)
  assert.ok(opaqueRoster.every(agent => !agent.prompt), 'restored roster metadata must not expose encrypted tasks')
  await writeFile(parentHistoryFile, parentRecords.join('\n'))

  // Ambiguous or incomplete parent history must never attach another message.
  for (const records of [
    parentRecords.slice(0, -2),
    [...parentRecords, ...dispatch(base + 950, 'pending-message', 'send_message', 'not delivered yet')],
    parentRecords.map(line => line.replace('"agent_thread_id":"' + paginatedChildId + '"', '"agent_thread_id":"foreign-child"')),
    parentRecords.map(line => line.replace('"agent_path":"/root/inspect"', '"agent_path":"/root/other"')),
    parentRecords.map(line => line.replace('"namespace":"collaboration"', '"namespace":"unrelated"')),
    parentRecords.map(line => line.replace('"id":"parent-native"', '"id":"foreign-parent"')),
    parentRecords.map(line => {
      const entry = JSON.parse(line)
      if (entry.payload?.type === 'function_call') entry.payload.arguments = '{invalid json'
      return JSON.stringify(entry)
    }),
    parentRecords.map(line => {
      const entry = JSON.parse(line)
      if (entry.payload?.item?.id === 'recover-spawn') entry.timestamp = new Date(base + 1_000).toISOString()
      return JSON.stringify(entry)
    }),
    ['{invalid json', JSON.stringify({ type: 'session_meta', payload: { id: 'parent-native' } })]
  ]) {
    await writeFile(parentHistoryFile, records.join('\n'))
    assert.deepEqual((await recover()).filter(event => event.type === 'user_message').map(event => event.payload.text),
      ['also inspect the fallback'], 'uncertain parent provenance must leave only the readable child message')
  }
  await writeFile(parentHistoryFile, parentRecords.join('\n'))
  const conflictingPlaintext = recoverableRecords.map(entry => entry === recoverableRecords[4]
    ? { ...entry, ...nativeCommunication('encrypted-followup', 'different readable message') } : entry)
  assert.deepEqual((await recover(conflictingPlaintext.map(entry => JSON.stringify(entry)).join('\n')))
    .filter(event => event.type === 'user_message').map(event => event.payload.text),
  ['different readable message', 'also inspect the fallback'], 'conflicting plaintext must prevent positional recovery')

  const parentWithCompletion = [...parentRecords, record(base + 950, { type: 'item_completed', item: {
    type: 'SubAgentActivity', id: 'native-child-completed', kind: 'completed',
    agent_thread_id: paginatedChildId, agent_path: '/root/inspect'
  } })].join('\n')
  const restoredParent = (await loadCodexLikeEvents(
    parentHistoryFile, 'codex', 'parent-native', async () => new Map(), parentWithCompletion
  )).events
  const restoredChild = restoredParent.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
    .filter(agent => agent.agentThreadId === paginatedChildId)
  assert.deepEqual(restoredChild.map(agent => agent.status), ['running', 'running', 'completed'],
    'modern activity items must restore the child lifecycle instead of retaining stale saved failures')
  const { mergeSubAgentSnapshot } = await server.ssrLoadModule('/src/shared/subAgentLifecycle.ts')
  const correctedChild = restoredChild.reduce((saved, incoming) => mergeSubAgentSnapshot(saved, incoming), {
    agentThreadId: paginatedChildId, status: 'errored', startedAt: base + 400, endedAt: base + 600
  })
  assert.equal(correctedChild.status, 'completed', 'native replay must supersede the legacy erroneous retry snapshot')
  assert.equal(correctedChild.endedAt, base + 950, 'duration must extend to the actual native completion')

  const ordinaryFork = [...paginatedRecords, {
    timestamp: new Date(base + 2000).toISOString(), type: 'session_meta',
    payload: { id: 'ordinary-fork', forked_from_id: paginatedChildId }
  }]
  assert.ok((await loadCodexLikeEvents(paginatedChild, 'codex', 'ordinary-fork', async () => new Map(),
    ordinaryFork.map(entry => JSON.stringify(entry)).join('\n'))).events
    .some(event => event.payload.text === 'inherited parent answer'),
  'ordinary forks must retain inherited conversation even when their source was a subagent')
  for (const invalidOrdinal of [-1, 1.5, '40']) {
    const invalidHeader = { ...paginatedRecords[0], payload: {
      ...paginatedRecords[0].payload, subagent_history_start_ordinal: invalidOrdinal
    } }
    assert.ok((await loadCodexLikeEvents(paginatedChild, 'codex', paginatedChildId, async () => new Map(),
      [invalidHeader, ...paginatedRecords.slice(1)].map(entry => JSON.stringify(entry)).join('\n'))).events
      .some(event => event.payload.text === 'inherited parent answer'),
    'invalid boundary metadata must not truncate history')
  }

  const child = 'history-child'
  const parent = join(temp, 'parent.jsonl')
  await writeFile(parent, [
    activity(base, child, 'started', 'dispatch-a'),
    record(base + 6 * 60 * 60 * 1_000, { type: 'task_complete' })
  ].join('\n'))
  const replay = await loadCodexLikeEvents(
    parent,
    'traex',
    'parent',
    async (_agentId, generations) => new Map(generations.map(({ key }) => [key, base + 4_200]))
  )
  const childEvents = replay.events.filter((event) => event.type === 'subagent')
  assert.equal(childEvents.length, 2)
  assert.equal(childEvents.at(-1).payload.agents[0].endedAt, base + 4_200)
  assert.equal(
    childEvents.at(-1).payload.agents[0].endedAt - childEvents[0].payload.agents[0].startedAt,
    4_200,
    'child rollout end must bound duration even when parent EOF is six hours later'
  )
  let resolvedChildren
  await loadCodexLikeEvents(
    parent,
    'traex',
    'terminal-resolver-scope',
    async (_agentId, generations) => { resolvedChildren = generations.map(({ childId }) => childId); return new Map() }
  )
  assert.deepEqual(resolvedChildren, [child], 'resolver should inspect only dangling children')

  const reusedChild = join(temp, 'reused-child.jsonl')
  await writeFile(reusedChild, [
    JSON.stringify({
      timestamp: new Date(base + 1_000).toISOString(),
      type: 'inter_agent_communication',
      payload: { kind: 'final_answer', author: '/root/nested', recipient: '/root' }
    }),
    record(base + 4_200, { type: 'agent_message', message: 'generation one result', phase: 'final_answer' }),
    record(base + 60 * 60 * 1_000, { type: 'user_message', message: 'much later generation' }),
    record(base + 60 * 60 * 1_000 + 5_000, { type: 'task_complete' })
  ].join('\n'))
  assert.equal(
    await rolloutGenerationEndTimestamp(reusedChild, base),
    base + 4_200,
    'generation EOF must stop at the first child terminal boundary, not whole-thread EOF'
  )
  const nestedOnlyChild = join(temp, 'nested-only-child.jsonl')
  await writeFile(nestedOnlyChild, [
    JSON.stringify({
      timestamp: new Date(base + 1_000).toISOString(),
      type: 'inter_agent_communication',
      payload: { kind: 'final_answer', author: '/root/nested', recipient: '/root' }
    }),
    record(base + 5_000, { type: 'task_complete' })
  ].join('\n'))
  assert.equal(
    await rolloutGenerationEndTimestamp(nestedOnlyChild, base),
    base + 5_000,
    'nested-agent final answers must not terminate the containing child thread'
  )

  const terminalParent = join(temp, 'terminal-parent.jsonl')
  await writeFile(terminalParent, [
    activity(base, child, 'started', 'dispatch-terminal'),
    activity(base + 500, child, 'not_found', 'terminal-not-found')
  ].join('\n'))
  let terminalResolverIds
  await loadCodexLikeEvents(
    terminalParent,
    'traex',
    'terminal-parent',
    async (_agentId, generations) => { terminalResolverIds = generations.map(({ childId }) => childId); return new Map() }
  )
  assert.deepEqual(terminalResolverIds, [], 'already-terminal children must not trigger rollout scans')

  const generations = join(temp, 'generations.jsonl')
  await writeFile(generations, [
    activity(base, child, 'started', 'dispatch-a'),
    record(base + 100, { type: 'agent_message', message: 'parent activity between start and terminal' }),
    activity(base + 1_000, child, 'interacted', 'dispatch-b'),
    activity(base + 2_000, child, 'interacted', 'dispatch-c')
  ].join('\n'))
  const generationsReplay = await loadCodexLikeEvents(
    generations,
    'traex',
    'generations',
    async (_agentId, generationWindows) => new Map(generationWindows.map(({ key, startedAt }) => [
      key,
      base + 3_000
    ]))
  )
  const snapshots = generationsReplay.events
    .filter((event) => event.type === 'subagent')
    .map((event) => event.payload.agents[0])
  assert.deepEqual(
    snapshots.map(({ generation, status }) => [generation, status]),
    [[1, 'running'], [1, 'running'], [1, 'running'], [1, 'completed']],
    'running interactions must remain appended questions in one lifecycle generation'
  )
  assert.deepEqual(
    snapshots.filter(({ status }) => status === 'completed').map(({ endedAt }) => endedAt),
    [base + 3_000],
    'appended questions must not synthesize intermediate terminal states'
  )
  assert.deepEqual(
    generationsReplay.events.map((event) => [
      event.type,
      event.type === 'subagent' ? event.payload.agents[0].status : event.payload.text,
      event.ts
    ]),
    [
      ['subagent', 'running', base],
      ['agent_message', 'parent activity between start and terminal', base + 100],
      ['subagent', 'running', base + 1_000],
      ['subagent', 'running', base + 2_000],
      ['subagent', 'completed', base + 3_000]
    ],
    'appended questions must keep their chronological slots without lifecycle restarts'
  )
  assert.deepEqual(
    generationsReplay.events.map((event) => event.seq),
    generationsReplay.events.map((_, index) => index),
    'replay sequence numbers must remain monotonic after timestamp-window insertion'
  )

  const collaboration = join(temp, 'collaboration-metadata.jsonl')
  const childLate = 'history-child-late-metadata'
  const childPath = '/root/history_child'
  const childLatePath = '/root/history_child_late'
  await writeFile(collaboration, [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: { id: 'collaboration-parent', agent_path: '/root' }
    }),
    record(base + 10, {
      type: 'collab_agent_spawn_end',
      call_id: 'spawn-before',
      sender_thread_id: 'collaboration-parent',
      new_thread_id: child,
      new_agent_nickname: 'Curie',
      prompt: 'inspect the parser'
    }),
    rootedActivity(base + 11, child, childPath, 'started', 'spawn-before'),
    rootedActivity(base + 20, childLate, childLatePath, 'started', 'spawn-after'),
    record(base + 21, {
      type: 'collab_agent_spawn_end',
      call_id: 'spawn-after',
      sender_thread_id: 'collaboration-parent',
      new_thread_id: childLate,
      new_agent_nickname: 'Noether',
      prompt: 'audit late metadata'
    }),
    communication(base + 30, {
      id: 'child-final',
      kind: 'final_answer',
      author: childPath,
      recipient: '/root',
      content: 'child result stays inside the child card'
    }),
    rootedActivity(base + 40, childLate, childLatePath, 'interacted', 'followup-after'),
    record(base + 41, {
      type: 'collab_agent_interaction_end',
      call_id: 'followup-after',
      sender_thread_id: 'collaboration-parent',
      receiver_thread_id: childLate,
      receiver_agent_nickname: 'Noether',
      prompt: 'check one more edge case',
      status: { completed: 'follow-up result' }
    })
  ].join('\n'))
  const collaborationEvents = (await loadCodexLikeEvents(
    collaboration,
    'traex',
    'collaboration-parent',
    async (_agentId, generations) => new Map(generations.map(({ key, startedAt }) => [
      key,
      startedAt === base + 40 ? base + 17_000 : undefined
    ]))
  )).events
  const collaborationAgents = collaborationEvents
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
  assert.ok(
    collaborationAgents.some((agent) =>
      agent.agentThreadId === child &&
      agent.dispatchId === 'spawn-before' &&
      agent.name === 'Curie' &&
      agent.prompt === 'inspect the parser'
    ),
    'spawn metadata emitted before activity must enrich the matching generation'
  )
  assert.ok(
    collaborationAgents.some((agent) =>
      agent.agentThreadId === childLate &&
      agent.dispatchId === 'spawn-after' &&
      agent.name === 'Noether' &&
      agent.prompt === 'audit late metadata'
    ),
    'spawn metadata emitted after activity must enrich the already-built generation'
  )
  assert.ok(
    collaborationAgents.some((agent) =>
      agent.agentThreadId === childLate &&
      agent.dispatchId === 'spawn-after' &&
      agent.prompt === 'audit late metadata' &&
      agent.tool === 'interacted' &&
      agent.status === 'completed'
    ),
    'interaction activity must stay in the active generation without replacing its initial prompt'
  )
  assert.ok(
    collaborationAgents.some((agent) =>
      agent.agentThreadId === child && agent.message === 'child result stays inside the child card'
    ),
    'child-to-parent communication must enrich the child snapshot'
  )
  assert.equal(
    collaborationEvents.some((event) =>
      (event.type === 'user_message' || event.type === 'agent_message') &&
      event.payload.text === 'child result stays inside the child card'
    ),
    false,
    'child output must never be replayed as a parent assistant message'
  )

  const childConversation = join(temp, 'child-conversation.jsonl')
  await writeFile(childConversation, [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: {
        id: 'collaboration-child',
        source: { subagent: { thread_spawn: { agent_path: '/root/history_child' } } }
      }
    }),
    communication(base + 1, {
      id: 'assigned-task',
      kind: 'new_task',
      author: '/root',
      recipient: '/root/history_child',
      content: 'initial child task'
    }),
    communication(base + 2, {
      id: 'assigned-followup',
      kind: 'followup',
      author: '/root',
      recipient: '/root/history_child',
      content: 'child follow-up'
    }),
    communication(base + 2.1, {
      id: 'wrong-author', kind: 'followup', author: '/root/sibling',
      recipient: '/root/history_child', content: 'must ignore sibling input'
    }),
    communication(base + 2.2, {
      id: 'wrong-recipient', kind: 'followup', author: '/root',
      recipient: '/root/other_child', content: 'must ignore other recipient'
    }),
    record(base + 3, { type: 'agent_reasoning_raw_content', text: 'raw child reasoning' }),
    record(base + 4, {
      type: 'image_generation_end',
      call_id: 'image-call',
      status: 'completed',
      revised_prompt: 'draw the migration preview',
      result: 'large-base64-must-not-be-replayed',
      saved_path: '/tmp/generated-preview.png'
    }),
    record(base + 5, { type: 'agent_message', message: 'child answer' })
  ].join('\n'))
  const childConversationEvents = (await loadCodexLikeEvents(
    childConversation,
    'traex',
    'collaboration-child',
    async () => new Map()
  )).events
  assert.deepEqual(
    childConversationEvents
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    ['initial child task', 'child follow-up'],
    'a child rollout must restore tasks and follow-ups from its direct parent'
  )
  assert.equal(
    childConversationEvents.find((event) => event.type === 'reasoning')?.payload.text,
    'raw child reasoning',
    'raw reasoning events must restore through the normal reasoning path'
  )
  const restoredImage = childConversationEvents.find((event) =>
    event.type === 'tool_call' && event.payload.name === 'image_generation'
  )
  assert.deepEqual(
    restoredImage?.payload.result,
    { status: 'completed', savedPath: '/tmp/generated-preview.png' },
    'image generation must retain status and artifact path'
  )
  assert.equal(
    JSON.stringify(restoredImage).includes('large-base64-must-not-be-replayed'),
    false,
    'image generation replay must not embed the large base64 payload'
  )

  const collaborationResponseFallback = join(temp, 'collaboration-response-fallback.jsonl')
  await writeFile(collaborationResponseFallback, [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: { id: 'collaboration-response-fallback', agent_path: '/root/mixed_child' }
    }),
    communication(base + 1, {
      id: 'mixed-assignment',
      kind: 'new_task',
      author: '/root',
      recipient: '/root/mixed_child',
      content: 'assigned once'
    }),
    JSON.stringify({
      timestamp: new Date(base + 2).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'assigned once' }] }
    }),
    JSON.stringify({
      timestamp: new Date(base + 3).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'response-only child reply' }]
      }
    })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(
      collaborationResponseFallback, 'traex', 'collaboration-response-fallback', async () => new Map()
    )).events
      .filter((event) => event.type === 'user_message' || event.type === 'agent_message')
      .map((event) => [event.type, event.payload.text]),
    [
      ['user_message', 'assigned once'],
      ['agent_message', 'response-only child reply']
    ],
    'collaboration input must suppress only duplicate user fallback, not response-only assistant text'
  )

  const rawFallback = join(temp, 'raw-reasoning-response-fallback.jsonl')
  await writeFile(rawFallback, [
    record(base, { type: 'agent_reasoning_raw_content', text: 'reasoning only event' }),
    JSON.stringify({
      timestamp: new Date(base + 1).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fallback user' }] }
    }),
    JSON.stringify({
      timestamp: new Date(base + 2).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fallback reply' }] }
    })
  ].join('\n'))
  assert.deepEqual(
    (await loadCodexLikeEvents(rawFallback, 'traex', 'raw-fallback', async () => new Map())).events
      .filter((event) => ['reasoning', 'user_message', 'agent_message'].includes(event.type))
      .map((event) => [event.type, event.payload.text]),
    [
      ['reasoning', 'reasoning only event'],
      ['user_message', 'fallback user'],
      ['agent_message', 'fallback reply']
    ],
    'raw reasoning must not suppress response_item conversation fallback'
  )

  const codexSourceDir = join(temp, '.codex', 'sessions', '2026', '08', '31')
  await mkdir(codexSourceDir, { recursive: true })
  const historyBaseParentEventId = 'history-base-parent-event'
  const historyBaseBranchResponseId = 'history-base-branch-response'
  await writeFile(join(codexSourceDir, `rollout-2026-08-31T00-00-00-${historyBaseParentEventId}.jsonl`), [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: { id: historyBaseParentEventId, cwd: '/repo' }
    }),
    record(base + 1, { type: 'user_message', message: 'parent event user' }),
    record(base + 2, { type: 'agent_message', message: 'parent event reply' })
  ].join('\n'))
  await writeFile(join(codexSourceDir, `rollout-2026-08-31T00-00-01-${historyBaseBranchResponseId}.jsonl`), [
    JSON.stringify({
      timestamp: new Date(base + 10).toISOString(),
      type: 'session_meta',
      payload: {
        id: historyBaseBranchResponseId,
        cwd: '/repo',
        history_base: { thread_id: historyBaseParentEventId }
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 11).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'branch fallback user' }] }
    }),
    JSON.stringify({
      timestamp: new Date(base + 12).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'branch fallback reply' }] }
    })
  ].join('\n'))
  assert.deepEqual(
    (await loadSessionEvents('codex', historyBaseBranchResponseId)).events
      .filter((event) => event.type === 'user_message' || event.type === 'agent_message')
      .map((event) => [event.type, event.payload.text]),
    [
      ['user_message', 'parent event user'],
      ['agent_message', 'parent event reply'],
      ['user_message', 'branch fallback user'],
      ['agent_message', 'branch fallback reply']
    ],
    'each history_base segment must decide response_item message fallback independently when a branch has response-only conversation'
  )

  const historyBaseParentResponseId = 'history-base-parent-response'
  const historyBaseBranchEventId = 'history-base-branch-event'
  await writeFile(join(codexSourceDir, `rollout-2026-08-31T00-00-02-${historyBaseParentResponseId}.jsonl`), [
    JSON.stringify({
      timestamp: new Date(base + 20).toISOString(),
      type: 'session_meta',
      payload: { id: historyBaseParentResponseId, cwd: '/repo' }
    }),
    JSON.stringify({
      timestamp: new Date(base + 21).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent fallback user' }] }
    }),
    JSON.stringify({
      timestamp: new Date(base + 22).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'parent fallback reply' }] }
    })
  ].join('\n'))
  await writeFile(join(codexSourceDir, `rollout-2026-08-31T00-00-03-${historyBaseBranchEventId}.jsonl`), [
    JSON.stringify({
      timestamp: new Date(base + 30).toISOString(),
      type: 'session_meta',
      payload: {
        id: historyBaseBranchEventId,
        cwd: '/repo',
        history_base: { thread_id: historyBaseParentResponseId }
      }
    }),
    record(base + 31, { type: 'user_message', message: 'branch event user' }),
    record(base + 32, { type: 'agent_message', message: 'branch event reply' })
  ].join('\n'))
  assert.deepEqual(
    (await loadSessionEvents('codex', historyBaseBranchEventId)).events
      .filter((event) => event.type === 'user_message' || event.type === 'agent_message')
      .map((event) => [event.type, event.payload.text]),
    [
      ['user_message', 'parent fallback user'],
      ['agent_message', 'parent fallback reply'],
      ['user_message', 'branch event user'],
      ['agent_message', 'branch event reply']
    ],
    'history_base fallback must also preserve a response-only parent when the branch itself has event_msg conversation'
  )

  const pointerChildId = 'pointer-child'
  await writeFile(join(codexSourceDir, `rollout-fixture-${pointerChildId}.jsonl`), [
    { ...paginatedRecords[0], payload: {
      ...paginatedRecords[0].payload, id: pointerChildId,
      history_base: { thread_id: historyBaseParentResponseId }
    } },
    ...paginatedRecords.slice(6)
  ].map(entry => JSON.stringify(entry)).join('\n'))
  assert.deepEqual((await loadSessionEvents('codex', pointerChildId)).events
    .filter(event => ['user_message', 'agent_message'].includes(event.type))
    .map(event => event.payload.text),
  ['inspect the settings', 'also inspect the fallback', 'child answer'],
  'a paginated child must exclude parent history resolved through history_base')

  const inheritedCollaboration = join(temp, 'inherited-collaboration.jsonl')
  await writeFile(inheritedCollaboration, [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: { id: 'parent-native' } }),
    record(base + 1, {
      type: 'collab_agent_spawn_end', call_id: 'inherited-spawn',
      sender_thread_id: 'parent-native', new_thread_id: 'inherited-child',
      new_agent_nickname: 'Ada', prompt: 'inherited task'
    }),
    rootedActivity(base + 2, 'inherited-child', '/root/inherited', 'started', 'inherited-spawn'),
    JSON.stringify({ timestamp: new Date(base + 3).toISOString(), type: 'session_meta', payload: { id: 'branch-native' } })
  ].join('\n'))
  const inheritedAgents = (await loadCodexLikeEvents(
    inheritedCollaboration, 'traex', 'branch-native', async () => new Map()
  )).events.filter((event) => event.type === 'subagent').flatMap((event) => event.payload.agents)
  assert.ok(
    inheritedAgents.some((agent) => agent.agentThreadId === 'inherited-child' &&
      agent.name === 'Ada' && agent.prompt === 'inherited task'),
    'pagination replay must associate inherited collaboration metadata with its parent session segment'
  )

  const interruptedInteraction = join(temp, 'interrupted-interaction.jsonl')
  await writeFile(interruptedInteraction, [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: { id: 'interrupt-parent' } }),
    rootedActivity(base + 1, 'interrupt-child', '/root/interrupted', 'interacted', 'interrupt-call'),
    record(base + 2, {
      type: 'collab_agent_interaction_end', call_id: 'interrupt-call',
      completed_at_ms: base + 2, sender_thread_id: 'interrupt-parent',
      receiver_thread_id: 'interrupt-child', status: 'interrupted'
    })
  ].join('\n'))
  const interruptedAgents = (await loadCodexLikeEvents(
    interruptedInteraction, 'traex', 'interrupt-parent', async () => new Map()
  )).events.filter((event) => event.type === 'subagent').flatMap((event) => event.payload.agents)
  assert.equal(interruptedAgents.at(-1)?.status, 'interrupted')
  assert.equal(interruptedAgents.at(-1)?.endedAt, base + 2)

  const erroredInteraction = join(temp, 'errored-interaction.jsonl')
  await writeFile(erroredInteraction, [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: { id: 'errored-parent' } }),
    rootedActivity(base + 1, 'errored-child', '/root/errored', 'interacted', 'errored-call'),
    record(base + 2, {
      type: 'collab_agent_interaction_end',
      call_id: 'errored-call',
      completed_at_ms: base + 2,
      sender_thread_id: 'errored-parent',
      receiver_thread_id: 'errored-child',
      receiver_agent_nickname: 'Euler',
      prompt: 'inspect the failing tool',
      status: { errored: 'tool crashed with stacktrace' }
    })
  ].join('\n'))
  const erroredAgents = (await loadCodexLikeEvents(
    erroredInteraction, 'traex', 'errored-parent', async () => new Map()
  )).events.filter((event) => event.type === 'subagent').flatMap((event) => event.payload.agents)
  assert.equal(erroredAgents.at(-1)?.status, 'errored')
  assert.equal(
    erroredAgents.at(-1)?.message,
    'tool crashed with stacktrace',
    'collab errored reason must survive as generation.message'
  )

  const sourceId = '11111111-1111-4111-8111-111111111111'
  const sourceDir = join(temp, '.trae', 'cli', 'sessions', '2026', '08', '31')
  const now = new Date()
  const codexOutputDir = join(
    temp, '.codex', 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')
  )
  const traexOutputDir = join(
    temp, '.trae', 'cli', 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')
  )
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, `rollout-2026-08-31T00-00-00-${sourceId}.jsonl`), [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: {
      id: sourceId, cwd: '/repo', originator: 'trae-cli', cli_version: '1.0.0'
    } }),
    record(base + 1, { type: 'user_message', message: 'portable history' }),
    record(base + 2, {
      type: 'image_generation_end', call_id: 'image-portable', status: 'completed',
      revised_prompt: 'draw portable image', result: 'base64-must-stay-out',
      saved_path: '/tmp/portable.png', transparent_background: false
    }),
    record(base + 3, {
      type: 'collab_agent_spawn_end', call_id: 'portable-spawn', sender_thread_id: sourceId,
      new_thread_id: 'portable-child', new_agent_nickname: 'Grace', prompt: 'audit portability'
    }),
    rootedActivity(base + 4, 'portable-child', '/root/portable', 'started', 'portable-spawn'),
    communication(base + 5, {
      id: 'portable-result', kind: 'final_answer', author: '/root/portable', recipient: '/root',
      content: 'portable child result'
    }),
    record(base + 6, {
      type: 'sub_agent_activity', agent_thread_id: 'portable-child', agent_path: '/root/portable',
      kind: 'completed', occurred_at_ms: base + 6, event_id: 'portable-terminal'
    })
  ].join('\n'))
  const exported = await exportNativeSession('traex', sourceId, 'codex')
  assert.ok(exported?.nativeId, 'cross-agent export must create a Codex rollout')
  const codexFiles = await readdir(codexOutputDir)
  const codexFile = join(
    codexOutputDir, codexFiles.find((name) => name.endsWith(`-${exported.nativeId}.jsonl`))
  )
  const codexText = await readFile(
    codexFile,
    'utf8'
  )
  assert.equal(codexText.includes('base64-must-stay-out'), false)
  const codexRecords = codexText.trim().split('\n').map(JSON.parse)
  const imageItems = codexRecords.filter((item) =>
    item.payload?.type === 'image_generation_call' || item.payload?.type === 'image_generation_end'
  )
  assert.deepEqual(imageItems.map((item) => item.payload.call_id ?? item.payload.id), [
    'image-portable', 'image-portable'
  ])
  assert.ok(imageItems.every((item) => item.payload.result === ''))
  const exportedReplay = (await loadCodexLikeEvents(
    codexFile,
    'codex', exported.nativeId, async () => new Map()
  )).events
  assert.equal(
    exportedReplay.filter((event) => event.type === 'tool_call' && event.payload.name === 'image_generation').length,
    1,
    'paired native image records must restore as one image event'
  )
  const exportedSummary = exportedReplay.find((event) => event.payload?.kind === 'subagent_summary')
  assert.equal(exportedSummary?.payload.uniagentSubagentSummary?.[0]?.detailAvailable, false)
  assert.match(exportedSummary?.payload.text || '', /portable child result/)

  const claudeExport = await exportNativeSession('traex', sourceId, 'claude')
  assert.ok(claudeExport?.nativeId, 'cross-agent export must create a Claude session')
  const claudeText = await readFile(
    join(temp, '.claude', 'projects', '-repo', `${claudeExport.nativeId}.jsonl`), 'utf8'
  )
  assert.equal(claudeText.includes('base64-must-stay-out'), false)
  const claudeRecords = claudeText.trim().split('\n').map(JSON.parse)
  const imageUse = claudeRecords.find((item) =>
    Array.isArray(item.message?.content) &&
    item.message.content.some((block) => block.type === 'tool_use' && block.name === 'uniagent_image_history')
  )
  const imageResult = claudeRecords.find((item) =>
    Array.isArray(item.message?.content) &&
    item.message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === 'image-portable')
  )
  assert.equal(imageUse?.message.content[0].id, 'image-portable')
  assert.equal(imageResult?.parentUuid, imageUse?.uuid)
  assert.equal(imageResult?.sourceToolAssistantUUID, imageUse?.uuid)
  const returned = await exportNativeSession('claude', claudeExport.nativeId, 'codex')
  assert.ok(returned?.nativeId, 'Claude image history must export back to Codex')
  const returnedFiles = await readdir(codexOutputDir)
  const returnedText = await readFile(join(
    codexOutputDir, returnedFiles.find((name) => name.endsWith(`-${returned.nativeId}.jsonl`))
  ), 'utf8')
  const returnedRecords = returnedText.trim().split('\n').map(JSON.parse)
  const returnedImages = returnedRecords.filter((item) =>
    item.payload?.type === 'image_generation_call' || item.payload?.type === 'image_generation_end'
  )
  assert.deepEqual(returnedImages.map((item) => item.payload.call_id ?? item.payload.id), [
    'image-portable', 'image-portable'
  ])
  assert.equal(returnedImages.at(-1)?.payload.saved_path, '/tmp/portable.png')
  assert.equal(returnedText.includes('base64-must-stay-out'), false)
  assert.ok(returnedRecords.some((item) =>
    item.payload?.uniagentSubagentSummary?.[0]?.detailAvailable === false &&
    item.payload?.message?.includes('portable child result')
  ), 'Claude round-trip must retain the portable child summary marker and text')

  const claudeProjectDir = join(temp, '.claude', 'projects', '-repo')
  await mkdir(claudeProjectDir, { recursive: true })
  const claudeToolRoundTripId = 'claude-tool-roundtrip'
  await writeFile(join(claudeProjectDir, `${claudeToolRoundTripId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      uuid: 'claude-tool-assistant',
      cwd: '/repo',
      sessionId: claudeToolRoundTripId,
      timestamp: new Date(base + 100).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'tool_use', id: 'tool-read-file', name: 'read_file', input: { path: 'README.md' } }]
      }
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'claude-tool-user',
      parentUuid: 'claude-tool-assistant',
      sourceToolAssistantUUID: 'claude-tool-assistant',
      cwd: '/repo',
      sessionId: claudeToolRoundTripId,
      timestamp: new Date(base + 101).toISOString(),
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-read-file',
          content: JSON.stringify({ ok: true, lines: ['one', 'two'] }),
          is_error: false
        }]
      }
    })
  ].join('\n'))
  const codexToolExport = await exportNativeSession('claude', claudeToolRoundTripId, 'codex')
  assert.ok(codexToolExport?.nativeId, 'Claude tool history must export to Codex')
  const codexToolFiles = await readdir(codexOutputDir)
  const codexToolFile = join(
    codexOutputDir,
    codexToolFiles.find((name) => name.endsWith(`-${codexToolExport.nativeId}.jsonl`))
  )
  const codexToolRecords = (await readFile(codexToolFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const codexToolItems = codexToolRecords.filter((item) =>
    item.payload?.type === 'function_call' || item.payload?.type === 'function_call_output'
  )
  assert.equal(codexToolItems[0]?.payload.uniagentTool, undefined)
  assert.equal(codexToolItems[1]?.payload.uniagentTool?.eventType, 'tool_call')
  assert.deepEqual(
    codexToolItems.map((item) => [item.payload.type, item.payload.name ?? null, item.payload.call_id]),
    [
      ['function_call', 'read_file', 'tool-read-file'],
      ['function_call_output', null, 'tool-read-file']
    ],
    'Claude non-Bash tools must export as paired function_call/function_call_output response items for Codex'
  )
  const codexToolReplay = (await loadCodexLikeEvents(
    codexToolFile,
    'codex',
    codexToolExport.nativeId,
    async () => new Map()
  )).events
  assert.deepEqual(
    codexToolReplay.find((event) => event.type === 'tool_call' && event.payload.name === 'read_file')?.payload.result,
    { ok: true, lines: ['one', 'two'] },
    'Codex must read back ordinary Claude tool results after function_call export'
  )
  const traexToolExport = await exportNativeSession('claude', claudeToolRoundTripId, 'traex')
  assert.ok(traexToolExport?.nativeId, 'Claude tool history must export to TraeX')
  const traexToolFiles = await readdir(traexOutputDir)
  const traexToolFile = join(
    traexOutputDir,
    traexToolFiles.find((name) => name.endsWith(`-${traexToolExport.nativeId}.jsonl`))
  )
  const traexToolRecords = (await readFile(traexToolFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const traexToolItems = traexToolRecords.filter((item) =>
    item.payload?.type === 'function_call' || item.payload?.type === 'function_call_output'
  )
  assert.equal(traexToolItems[0]?.payload.uniagentTool, undefined)
  assert.equal(traexToolItems[1]?.payload.uniagentTool?.eventType, 'tool_call')
  assert.deepEqual(
    traexToolItems.map((item) => [item.payload.type, item.payload.name ?? null, item.payload.call_id]),
    [
      ['function_call', 'read_file', 'tool-read-file'],
      ['function_call_output', null, 'tool-read-file']
    ],
    'Claude non-Bash tools must export as paired function_call/function_call_output response items for TraeX'
  )
  const traexToolReplay = (await loadCodexLikeEvents(
    traexToolFile,
    'traex',
    traexToolExport.nativeId,
    async () => new Map()
  )).events
  assert.deepEqual(
    traexToolReplay.find((event) => event.type === 'tool_call' && event.payload.name === 'read_file')?.payload.result,
    { ok: true, lines: ['one', 'two'] },
    'TraeX must read back ordinary Claude tool results after function_call export'
  )

  const nativeFunctionPairs = join(temp, 'native-function-pairs.jsonl')
  await writeFile(nativeFunctionPairs, [
    JSON.stringify({
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: { id: 'native-function-segment-a' }
    }),
    JSON.stringify({
      timestamp: new Date(base + 1).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'read_file',
        arguments: JSON.stringify({ path: 'native.txt' }), call_id: 'native-tool'
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 2).toISOString(),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'native-tool', output: '{"text":"native result"}' }
    }),
    JSON.stringify({
      timestamp: new Date(base + 3).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' }), call_id: 'native-exec'
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 4).toISOString(),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'native-exec', output: '/repo' }
    }),
    record(base + 5, {
      type: 'exec_command_end', call_id: 'native-exec', command: 'pwd',
      aggregated_output: '/repo', exit_code: 0
    }),
    JSON.stringify({
      timestamp: new Date(base + 6).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'apply_patch',
        arguments: JSON.stringify({ patch: '*** Begin Patch' }), call_id: 'native-patch'
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 7).toISOString(),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'native-patch', output: 'Done!' }
    }),
    record(base + 8, {
      type: 'patch_apply_end', call_id: 'native-patch', success: true, changes: {}
    }),
    JSON.stringify({
      timestamp: new Date(base + 9).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'mcp_tool',
        arguments: JSON.stringify({ query: 'value' }), call_id: 'native-mcp'
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 10).toISOString(),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'native-mcp', output: '{"ok":true}' }
    }),
    record(base + 11, {
      type: 'mcp_tool_call_end',
      call_id: 'native-mcp',
      invocation: { server: 'fixture', tool: 'lookup', arguments: { query: 'value' } }
    }),
    JSON.stringify({
      timestamp: new Date(base + 12).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'must_not_cross_segments',
        arguments: '{}', call_id: 'cross-segment'
      }
    }),
    JSON.stringify({
      timestamp: new Date(base + 13).toISOString(),
      type: 'session_meta',
      payload: { id: 'native-function-segment-b' }
    }),
    JSON.stringify({
      timestamp: new Date(base + 14).toISOString(),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'cross-segment', output: 'wrong segment' }
    })
  ].join('\n'))
  const nativeFunctionEvents = (await loadCodexLikeEvents(
    nativeFunctionPairs, 'codex', 'native-function-pairs', async () => new Map()
  )).events
  assert.deepEqual(
    nativeFunctionEvents
      .filter((event) => event.type === 'tool_call' && event.payload.id === 'native-tool')
      .map((event) => [event.payload.id, event.payload.name, event.payload.input, event.payload.result]),
    [['native-tool', 'read_file', { path: 'native.txt' }, { text: 'native result' }]],
    'complete native function pairs must restore without a private marker or crossing session segments'
  )
  assert.equal(
    nativeFunctionEvents.filter((event) =>
      (event.type === 'command_exec' || event.type === 'tool_call') && event.payload.id === 'native-exec'
    ).length,
    1,
    'a native terminal event must suppress its duplicate response function pair'
  )
  assert.equal(
    nativeFunctionEvents.filter((event) =>
      (event.type === 'file_change' || event.type === 'tool_call') && event.payload.id === 'native-patch'
    ).length,
    1,
    'a native patch terminal event must suppress its duplicate response function pair'
  )
  assert.equal(
    nativeFunctionEvents.filter((event) =>
      event.type === 'tool_call' && event.payload.id === 'native-mcp'
    ).length,
    1,
    'a native MCP terminal event must suppress its duplicate response function pair'
  )

  const failedImageSourceId = '22222222-2222-4222-8222-222222222222'
  await writeFile(join(sourceDir, `rollout-2026-08-31T00-00-01-${failedImageSourceId}.jsonl`), [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: {
      id: failedImageSourceId, cwd: '/repo', originator: 'trae-cli', cli_version: '1.0.0'
    } }),
    record(base + 1, {
      type: 'image_generation_end',
      call_id: 'image-failed',
      status: 'failed',
      revised_prompt: 'draw the broken preview',
      result: '',
      saved_path: '/tmp/failed-preview.png',
      failure: { type: 'usageLimitExceeded', limitId: 'image_daily', resetsAt: 1_788_200_000 }
    })
  ].join('\n'))
  const failedClaudeExport = await exportNativeSession('traex', failedImageSourceId, 'claude')
  assert.ok(failedClaudeExport?.nativeId, 'failed image history must export to Claude')
  const failedClaudeText = await readFile(
    join(claudeProjectDir, `${failedClaudeExport.nativeId}.jsonl`),
    'utf8'
  )
  const failedClaudeRecords = failedClaudeText.trim().split('\n').map(JSON.parse)
  const failedClaudeResult = failedClaudeRecords.find((item) =>
    item.message?.content?.some((block) => block.type === 'tool_result' && block.tool_use_id === 'image-failed')
  )
  assert.deepEqual(
    JSON.parse(failedClaudeResult.message.content[0].content),
    {
      status: 'failed',
      savedPath: '/tmp/failed-preview.png',
      failure: { type: 'usageLimitExceeded', limitId: 'image_daily', resetsAt: 1_788_200_000 }
    },
    'Claude image tool_result must retain failed image object details'
  )
  const failedRoundTrip = await exportNativeSession('claude', failedClaudeExport.nativeId, 'codex')
  assert.ok(failedRoundTrip?.nativeId, 'failed Claude image history must export back to Codex')
  const failedRoundTripFiles = await readdir(codexOutputDir)
  const failedRoundTripFile = join(
    codexOutputDir,
    failedRoundTripFiles.find((name) => name.endsWith(`-${failedRoundTrip.nativeId}.jsonl`))
  )
  const failedRoundTripRecords = (await readFile(failedRoundTripFile, 'utf8'))
    .trim().split('\n').map(JSON.parse)
  const failedImageResponse = failedRoundTripRecords.find((item) =>
    item.type === 'response_item' && item.payload?.type === 'image_generation_call'
  )
  const failedImageEvent = failedRoundTripRecords.find((item) =>
    item.type === 'event_msg' && item.payload?.type === 'image_generation_end'
  )
  assert.ok(failedImageResponse, 'failed image export must include a native response_item')
  assert.ok(failedImageEvent, 'failed image export must include a native event_msg')
  assert.deepEqual(
    Object.keys(failedImageResponse.payload).sort(),
    ['id', 'result', 'revised_prompt', 'status', 'type'],
    'image response_item must stay within the native image_generation_call protocol shape'
  )
  assert.equal(failedImageResponse.payload.result, '')
  assert.equal(failedImageEvent.payload.saved_path, '/tmp/failed-preview.png')
  assert.deepEqual(
    failedImageEvent.payload.failure,
    { type: 'usageLimitExceeded', limitId: 'image_daily', resetsAt: 1_788_200_000 },
    'full failed-image details belong to the native image_generation_end event'
  )
  const failedRoundTripReplay = (await loadCodexLikeEvents(
    failedRoundTripFile,
    'codex',
    failedRoundTrip.nativeId,
    async () => new Map()
  )).events
  assert.deepEqual(
    failedRoundTripReplay.find((event) =>
      event.type === 'tool_call' && event.payload.name === 'image_generation'
    )?.payload.result,
    {
      status: 'failed',
      savedPath: '/tmp/failed-preview.png',
      failure: { type: 'usageLimitExceeded', limitId: 'image_daily', resetsAt: 1_788_200_000 }
    },
    'failed image object details must survive a Claude round-trip'
  )

  const capped = join(temp, 'capped.jsonl')
  const filler = Array.from({ length: 4_100 }, (_, index) =>
    record(base + index + 1, { type: 'user_message', message: `message-${index}` })
  )
  await writeFile(capped, [activity(base, child, 'started', 'dispatch-cap'), ...filler].join('\n'))
  const cappedReplay = await loadCodexLikeEvents(
    capped,
    'traex',
    'capped',
    async (_agentId, generations) => new Map(generations.map(({ key }) => [key, base + 2_000])),
    undefined,
    undefined,
    { replayEventLimit: 4_000 }
  )
  assert.equal(cappedReplay.events.length, 4_000)
  const cappedChild = cappedReplay.events.filter((event) => event.type === 'subagent')
  assert.equal(cappedChild.length, 2)
  assert.equal(cappedChild[0].payload.agents[0].status, 'running')
  assert.equal(cappedChild.at(-1).payload.agents[0].status, 'completed')
  assert.equal(cappedChild.at(-1).payload.agents[0].endedAt, base + 2_000)

  const multiCapped = join(temp, 'multi-capped.jsonl')
  const childB = 'history-child-b'
  await writeFile(multiCapped, [
    activity(base, child, 'started', 'dispatch-cap-a'),
    activity(base + 1, childB, 'started', 'dispatch-cap-b'),
    ...filler
  ].join('\n'))
  const multiCappedReplay = await loadCodexLikeEvents(
    multiCapped,
    'traex',
    'multi-capped',
    async (_agentId, generations) => new Map(generations.map(({ key }) => [key, base + 2_000])),
    undefined,
    undefined,
    { replayEventLimit: 4_000 }
  )
  const multiCappedChild = multiCappedReplay.events
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
  for (const id of [child, childB]) {
    const statuses = multiCappedChild.filter((agent) => agent.agentThreadId === id).map((agent) => agent.status)
    assert.deepEqual(statuses, ['running', 'completed'], `cap must preserve start+terminal for ${id}`)
  }

  const postCap = join(temp, 'post-cap.jsonl')
  await writeFile(postCap, [
    ...Array.from({ length: 4_000 }, (_, index) =>
      record(base + index, { type: 'user_message', message: `before-child-${index}` })
    ),
    activity(base + 5_000, child, 'started', 'dispatch-post-cap'),
    activity(base + 6_000, child, 'interrupted', 'terminal-post-cap')
  ].join('\n'))
  const postCapReplay = await loadCodexLikeEvents(
    postCap,
    'traex',
    'post-cap',
    async () => new Map(),
    undefined,
    undefined,
    { replayEventLimit: 4_000 }
  )
  const postCapChild = postCapReplay.events
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
  assert.deepEqual(
    postCapChild.map(({ status }) => status),
    ['running', 'interrupted'],
    'post-cap lifecycle events must retain chronological start -> terminal order'
  )

  const allProtected = join(temp, 'all-protected.jsonl')
  const protectedGenerationCount = 4_000
  await writeFile(allProtected, Array.from({ length: protectedGenerationCount }, (_, index) =>
    activity(base + index * 10, `protected-child-${index}`, 'started', `protected-dispatch-${index}`)
  ).join('\n'))
  const allProtectedReplay = await loadCodexLikeEvents(
    allProtected,
    'traex',
    'all-protected',
    async (_agentId, generationWindows) => new Map(generationWindows.map(({ key, startedAt }) => [
      key,
      (startedAt ?? base) + 1
    ])),
    undefined,
    undefined,
    { replayEventLimit: 4_000 }
  )
  assert.ok(
    allProtectedReplay.events.length <= 4_000,
    `all-protected replay exceeded hard cap: ${allProtectedReplay.events.length}`
  )
  const retainedProtected = new Map()
  for (const event of allProtectedReplay.events) {
    assert.equal(event.type, 'subagent', 'all-protected fixture must contain lifecycle events only')
    const agent = event.payload.agents[0]
    const key = `${agent.agentThreadId}:${agent.generation}`
    const phases = retainedProtected.get(key) ?? []
    phases.push(agent.status)
    retainedProtected.set(key, phases)
  }
  assert.ok(retainedProtected.size > 0, 'capacity trimming should retain complete generations')
  for (const [key, phases] of retainedProtected) {
    assert.deepEqual(phases, ['running', 'completed'], `retained generation ${key} must not be orphaned`)
  }
  assert.deepEqual(
    allProtectedReplay.events.map((event) => event.seq),
    allProtectedReplay.events.map((_, index) => index),
    'all-protected replay must also have monotonic sequence numbers'
  )

  // Regression: production replay must keep the full TraeX transcript. The old
  // 4000-event prefix cap silently dropped the newest turns/user messages, so a
  // reopened long session looked like it had stopped hours earlier and its last
  // turn never completed.
  const longTranscript = join(temp, 'traex-long-transcript.jsonl')
  const longMessageCount = 4_100
  await writeFile(longTranscript, Array.from({ length: longMessageCount }, (_, index) =>
    record(base + index, { type: 'user_message', message: `long-message-${index}` })
  ).join('\n'))
  const longReplay = await loadCodexLikeEvents(
    longTranscript,
    'traex',
    'long-transcript',
    async () => new Map()
  )
  assert.equal(
    longReplay.events.filter((event) => event.type === 'user_message').length,
    longMessageCount,
    'default replay must retain every user message beyond the legacy 4000-event prefix'
  )
  assert.equal(
    longReplay.events.at(-1)?.payload?.text,
    `long-message-${longMessageCount - 1}`,
    'default replay must keep the newest user message instead of stopping at an arbitrary prefix'
  )

  const outOfOrderTimestamps = join(temp, 'timestamps.jsonl')
  await writeFile(outOfOrderTimestamps, [
    record(base + 10_000, { type: 'agent_message', message: 'latest timestamp' }),
    JSON.stringify({
      timestamp: new Date(base + 1_000).toISOString(),
      type: 'turn_context',
      payload: { model: 'fixture-model' }
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'missing timestamp' } })
  ].join('\n'))
  const timestampReplay = await loadCodexLikeEvents(
    outOfOrderTimestamps,
    'traex',
    'timestamps',
    async () => new Map()
  )
  assert.equal(
    timestampReplay.events.at(-1).ts,
    base + 10_000,
    'a missing timestamp after an out-of-order line must inherit the maximum rollout timestamp'
  )

  console.log('subagent-history integration: ok')
} finally {
  await server.close()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(temp, { recursive: true, force: true })
}
