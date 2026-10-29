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
  const { mergeSubAgentSnapshot } = await server.ssrLoadModule('/src/shared/subAgentLifecycle.ts')
  const runner = new AppServerRunner(
    'adapter-fixture',
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
    { agentId: 'codex', workdir: process.cwd(), permissionMode: 'read-only', model: 'parent-model' },
    'parent-thread'
  )
  const events = []
  runner.on('event', (event) => events.push(event))
  const notify = (method, params) => runner.onNotification(method, params)

  notify('thread/started', { thread: {
    id: 'child-a', agentNickname: 'Dirac',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-thread' } } }
  } })

  const dispatchA = {
    id: 'dispatch-a',
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    senderThreadId: 'parent-thread',
    receiverThreadIds: ['child-a'],
    prompt: 'prompt-a',
    model: 'model-a',
    agentsStates: {
      'child-a': { status: 'running', agentPath: '/agents/child-a.md' },
      'bystander-child': { status: 'running', agentPath: '/agents/bystander.md' }
    }
  }
  notify('item/started', { threadId: 'parent-thread', item: dispatchA })
  assert.equal(events.find(event => event.type === 'subagent').payload.agents[0].name, 'Dirac',
    'native thread nicknames must take precedence over fallback agent paths')
  assert.equal(runner.childModel.get('child-a'), 'model-a')
  assert.equal(
    runner.childModel.has('bystander-child'),
    false,
    'dispatch model cache must be scoped to receiverThreadIds'
  )
  assert.equal(runner.childPrompt.has('bystander-child'), false)

  const dispatchB = {
    ...dispatchA,
    id: 'dispatch-b',
    tool: 'sendInput',
    prompt: 'prompt-b',
    model: 'model-b',
    agentsStates: { 'child-a': { status: 'running', agentPath: '/agents/child-a.md' } }
  }
  notify('item/started', { threadId: 'parent-thread', item: dispatchB })
  notify('item/completed', { threadId: 'parent-thread', item: dispatchB })
  assert.equal(runner.childPrompt.get('child-a'), 'prompt-a', 'an appended question must preserve the initial task')
  assert.equal(runner.childModel.get('child-a'), 'model-a', 'an appended question must not restart the child model')
  const childSnapshots = events
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
    .filter((agent) => agent.agentThreadId === 'child-a')
  assert.equal(childSnapshots.at(-1).generation, 1, 'an appended question must stay in the active generation')
  assert.equal(childSnapshots.at(-1).prompt, 'prompt-a')
  assert.equal(childSnapshots.at(-1).tool, 'sendInput')
  assert.equal(childSnapshots.at(-1).status, 'running')
  assert.equal(
    childSnapshots.some((agent) => agent.status === 'completed' || agent.status === 'interrupted'),
    false,
    'an appended question must not synthesize a terminal lifecycle state'
  )
  const eventCountBeforeStale = events.length
  notify('item/completed', {
    threadId: 'parent-thread',
    item: {
      ...dispatchA,
      agentsStates: { 'child-a': { status: 'completed', agentPath: '/agents/child-a.md' } }
    }
  })
  assert.equal(events.length, eventCountBeforeStale, 'a delayed older item must not end the appended interaction')
  const staleTerminalActivity = {
    id: 'terminal-a',
    type: 'subAgentActivity',
    kind: 'interrupted',
    agentThreadId: 'child-a',
    occurredAt: Date.now() - 60_000
  }
  const beforeStaleTerminal = events.length
  notify('item/completed', { threadId: 'parent-thread', item: staleTerminalActivity })
  assert.equal(
    events.length,
    beforeStaleTerminal,
    'a terminal activity older than the active dispatch must not terminate it'
  )

  const beforeRetry = events.length
  notify('error', {
    threadId: 'child-a', turnId: 'child-turn', willRetry: true,
    error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }
  })
  assert.equal(events.length, beforeRetry, 'a recoverable child disconnect must not emit a terminal status')
  assert.equal(runner.terminalSubAgentThreads.has('child-a'), false,
    'retrying must leave the child generation open for its real completion')

  // The child's own completion wins. Parent cleanup reports the same terminal
  // state later, but must not emit a replacement event with a later endedAt.
  const generation1TerminalsBefore = events.filter((event) =>
    event.type === 'subagent' &&
    event.payload.agents.some((agent) =>
      agent.agentThreadId === 'child-a' && agent.generation === 1 && agent.status === 'completed'
    )
  ).length
  notify('turn/completed', { threadId: 'child-a', turn: { id: 'child-turn', status: 'completed' } })
  const terminalsAfterChild = events.filter((event) =>
    event.type === 'subagent' &&
    event.payload.agents.some((agent) =>
      agent.agentThreadId === 'child-a' && agent.generation === 1 && agent.status === 'completed'
    )
  )
  runner.childThreads.add('bystander-child')
  runner.markChildStatus('child-a', 'completed')
  const terminalsAfterParent = events.filter((event) =>
    event.type === 'subagent' &&
    event.payload.agents.some((agent) =>
      agent.agentThreadId === 'child-a' && agent.generation === 1 && agent.status === 'completed'
    )
  )
  assert.equal(terminalsAfterChild.length, generation1TerminalsBefore + 1)
  assert.equal(
    terminalsAfterParent.length,
    terminalsAfterChild.length,
    'duplicate completion paths must preserve the first terminal endedAt/event'
  )
  assert.equal(
    terminalsAfterParent.at(-1).payload.agents[0].endedAt,
    terminalsAfterChild.at(-1).payload.agents[0].endedAt
  )

  const dispatchC = {
    ...dispatchA,
    id: 'dispatch-c',
    tool: 'sendInput',
    prompt: 'prompt-c',
    model: 'model-c',
    agentsStates: { 'child-a': { status: 'running', agentPath: '/agents/child-a.md' } }
  }
  notify('item/started', { threadId: 'parent-thread', item: dispatchC })
  const reopened = events
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
    .filter((agent) => agent.agentThreadId === 'child-a')
    .at(-1)
  assert.equal(reopened.generation, 2, 'sendInput after a true terminal state must reopen the child')
  assert.equal(reopened.prompt, 'prompt-c')
  assert.equal(reopened.status, 'running')
  notify('item/started', {
    threadId: 'parent-thread',
    item: { ...dispatchC, id: 'dispatch-d', prompt: 'prompt-d', model: 'model-d' }
  })
  const appendedAfterReopen = events
    .filter((event) => event.type === 'subagent')
    .flatMap((event) => event.payload.agents)
    .filter((agent) => agent.agentThreadId === 'child-a')
    .at(-1)
  assert.equal(appendedAfterReopen.generation, 2)
  assert.equal(appendedAfterReopen.prompt, 'prompt-c')

  notify('item/started', { threadId: 'parent-thread', item: {
    ...dispatchA, id: 'named-dispatch', receiverThreadIds: ['named-child', 'other-child'],
    receiverAgents: [
      { threadId: 'other-child', agentNickname: 'Curie' },
      { threadId: 'named-child', agentNickname: '  Dalton  ' }
    ],
    agentsStates: { 'named-child': { status: 'running' }, 'other-child': { status: 'running' } }
  } })
  const namedAgents = events.at(-1).payload.agents
  assert.deepEqual(namedAgents.map(({ agentThreadId, name }) => [agentThreadId, name]),
    [['named-child', 'Dalton'], ['other-child', 'Curie']],
    'receiver nicknames must match thread identity rather than array order')
  notify('item/completed', { threadId: 'parent-thread', item: {
    ...dispatchA, id: 'named-wait', tool: 'wait', receiverThreadIds: ['named-child'],
    agentsStates: { 'named-child': { status: 'completed' } }
  } })
  assert.equal(events.at(-1).payload.agents[0].name, 'Dalton',
    'status-only updates must retain the native nickname')
  notify('thread/started', { thread: {
    id: 'named-child', agentNickname: 'Dalton',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-thread' } } }
  } })
  const mergedNamed = events.filter(event => event.type === 'subagent')
    .flatMap(event => event.payload.agents).filter(agent => agent.agentThreadId === 'named-child')
    .reduce((previous, incoming) => mergeSubAgentSnapshot(previous, incoming), undefined)
  assert.equal(mergedNamed.status, 'completed', 'late nickname metadata must not reopen a terminal child')

  notify('thread/started', { thread: {
    id: 'child-a', agentNickname: 'Popper',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'another-parent' } } }
  } })
  assert.equal(runner.childName('child-a'), 'Dirac', 'foreign thread metadata must not rename a child')

  for (const [id, notification] of [
    ['fatal-child', ['error', { willRetry: false, error: { message: 'request failed' } }]],
    ['legacy-fatal-child', ['error', { error: { message: 'request failed' } }]],
    ['failed-turn-child', ['turn/completed', { turn: { id: 'failed-turn', status: 'failed' } }]]
  ]) {
    notify('thread/started', { thread: {
      id, source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-thread' } } }
    } })
    notify(notification[0], { threadId: id, ...notification[1] })
    notify('turn/completed', { threadId: id, turn: { id: 'after-failure', status: 'completed' } })
    const terminals = events.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
      .filter(agent => agent.agentThreadId === id && ['completed', 'errored'].includes(agent.status))
    assert.deepEqual(terminals.map(agent => agent.status), ['errored'], 'a true failure must remain terminal')
  }

  const encrypted = `gAAAAA${'B'.repeat(92)}==`
  for (const [index, prompt] of [encrypted, ' \n ', '检查已有实现'].entries()) {
    const threadId = `input-child-${index}`
    notify('item/started', { threadId: 'parent-thread', item: {
      ...dispatchA, id: `input-dispatch-${index}`, receiverThreadIds: [threadId], prompt,
      agentsStates: { [threadId]: { status: 'running' } }
    } })
    const snapshot = events.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents)
      .filter(agent => agent.agentThreadId === threadId).at(-1)
    assert.equal(snapshot.prompt, index === 2 ? prompt : undefined,
      'only readable dispatch input may enter the roster or prompt cache')
    assert.equal(runner.childPrompt.get(threadId), snapshot.prompt)
    assert.equal(snapshot.status, 'running', 'hiding input must not hide child activity')
  }

  console.log('subagent-adapter integration: ok')
} finally {
  await server.close()
}
