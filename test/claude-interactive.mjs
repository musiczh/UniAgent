import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const markdownStub = {
  name: 'claude-ui-test-markdown',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './Markdown' && importer?.endsWith('/EventStream.tsx')) return '\0claude-ui-test-markdown'
  },
  load(id) {
    if (id === '\0claude-ui-test-markdown') return "import React from 'react'; export const Markdown = () => React.createElement('span')"
  }
}
const server = await createServer({
  root: process.cwd(), configFile: false, plugins: [markdownStub],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent'
})
try {
  const { TurnRunner, buildCommand } = await server.ssrLoadModule('/src/main/adapter.ts')
  const { Orchestrator } = await server.ssrLoadModule('/src/main/orchestrator.ts')
  const { BUILTIN_AGENTS } = await server.ssrLoadModule('/src/main/agents.ts')
  const { ApprovalCard, EventStream } = await server.ssrLoadModule('/src/renderer/components/EventStream.tsx')
  const claudeDef = BUILTIN_AGENTS.find((entry) => entry.id === 'claude')
  assert.ok(claudeDef)
  const agent = {
    id: 'claude', name: 'Claude Code', bin: 'claude', adapter: 'claude', icon: '', builtin: true,
    capabilities: { modelSelect: true, reasoningEffort: false, streaming: true, permissionModes: [{ id: 'ask', label: '请求批准' }] },
    models: []
  }
  const command = buildCommand(agent, { agentId: 'claude', workdir: '/repo', permissionMode: 'ask' }, 'hello', undefined, undefined, 'local', undefined, true)
  assert.ok(command.args.includes('--input-format'))
  assert.ok(command.args.includes('--permission-prompt-tool'))
  assert.ok(command.args.includes('stdio'))
  assert.ok(command.args.includes('--replay-user-messages'))
  assert.equal(command.args[command.args.indexOf('--permission-mode') + 1], 'manual')
  for (const resumeId of [undefined, 'native-session']) {
    const restricted = buildCommand(claudeDef, { agentId: 'claude', workdir: '/repo', permissionMode: 'deny-unapproved' }, 'Use allowed tools only', resumeId, undefined, 'local', undefined, true)
    assert.equal(restricted.args[restricted.args.indexOf('--permission-mode') + 1], 'dontAsk')
    assert.equal(restricted.args.includes('--dangerously-skip-permissions'), false)
  }
  assert.equal(command.args.includes('hello'), false)
  for (const resumeId of [undefined, 'native-session']) {
    const planned = buildCommand(claudeDef, {
      agentId: 'claude', workdir: '/repo', permissionMode: 'plan',
      roleSnapshot: { id: 'planner', name: 'Planner', agentId: 'claude', permissionMode: 'plan', instructions: 'Keep the project planning requirements.' }
    }, 'Plan only', resumeId, undefined, 'local', undefined, true)
    assert.equal(planned.args[planned.args.indexOf('--permission-mode') + 1], 'plan')
    assert.equal(planned.args.includes('--system-prompt'), false, 'business instructions must not replace the native prompt')
    assert.match(planned.args[planned.args.indexOf('--append-system-prompt') + 1], /Keep the project planning requirements\./)
    if (resumeId) assert.equal(planned.args[planned.args.indexOf('--resume') + 1], resumeId)
  }
  const resumed = buildCommand(agent, { agentId: 'claude', workdir: '/repo', permissionMode: 'ask' }, 'next', 'native-session', undefined, 'local', undefined, true)
  assert.deepEqual(resumed.args.slice(resumed.args.indexOf('--resume'), resumed.args.indexOf('--resume') + 2), ['--resume', 'native-session'])
  const configured = buildCommand(claudeDef, { agentId: 'claude', workdir: '/repo', permissionMode: 'ask', model: 'claude-sonnet-4-5', effort: 'high', additionalDirectories: ['/repo/shared'] }, 'next', 'native-session', undefined, 'local', undefined, true)
  assert.deepEqual(configured.args.slice(configured.args.indexOf('--model'), configured.args.indexOf('--model') + 2), ['--model', 'claude-sonnet-4-5'])
  assert.deepEqual(configured.args.slice(configured.args.indexOf('--effort'), configured.args.indexOf('--effort') + 2), ['--effort', 'high'])
  assert.deepEqual(configured.args.slice(configured.args.indexOf('--add-dir'), configured.args.indexOf('--add-dir') + 2), ['--add-dir', '/repo/shared'])
  const forked = buildCommand(claudeDef, { agentId: 'claude', workdir: '/repo', permissionMode: 'ask' }, 'forked prompt', undefined, undefined, 'local', { sessionId: 'source-session', messageId: 'assistant-message' }, true)
  assert.deepEqual(forked.args.slice(forked.args.indexOf('--resume'), forked.args.indexOf('--resume') + 4), ['--resume', 'source-session', '--fork-session', '--resume-session-at'])
  assert.equal(forked.args[forked.args.indexOf('--resume-session-at') + 1], 'assistant-message')

  const writes = []
  const events = []
  const runner = new TurnRunner('interactive', { n: 0 })
  const sdk = { respond(requestId, response) { writes.push({ requestId, response }) }, async request(method, args) { writes.push({ method, args }) }, async close() { writes.push({ method: 'close' }) } }
  runner.sdk = sdk
  runner.on('event', (event) => events.push(event))
  runner.onLine('claude', JSON.stringify({
    type: 'control_request', request_id: 'req-write',
    request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/repo/a.txt', content: 'hello' } }
  }))
  assert.equal(events.at(-1)?.payload.kind, 'fileChange')
  assert.deepEqual(events.at(-1)?.payload.params.changes, [{ path: '/repo/a.txt' }])
  assert.deepEqual(runner.respond('claude-req-write', { decision: 'accept' }), { handled: true, hasPendingRequests: false })
  assert.deepEqual(writes.at(-1), {
    requestId: 'req-write', response: {
      behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'hello' }
    }
  })

  runner.onLine('claude', JSON.stringify({
    type: 'control_request', request_id: 'req-deny',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf tmp' } }
  }))
  assert.deepEqual(runner.respond('claude-req-deny', { decision: 'reject' }), { handled: true, hasPendingRequests: false })
  assert.deepEqual(writes.at(-1).response, {
    behavior: 'deny', message: '用户拒绝了此操作'
  })

  runner.onLine('claude', JSON.stringify({
    type: 'control_request', request_id: 'req-question',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {
      questions: [{ id: 'platform', question: 'Which platform?', options: [{ label: 'Android' }, { label: 'iOS' }] }]
    } }
  }))
  assert.equal(events.at(-1)?.payload.kind, 'question')
  runner.respond('claude-req-question', { answers: { platform: { answers: ['Android'] } } })
  assert.deepEqual(writes.at(-1).response.updatedInput.answers, { 'Which platform?': 'Android' })

  runner.onLine('claude', JSON.stringify({
    type: 'control_request', request_id: 'req-multi-question',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {
      questions: [
        { id: 'targets', question: 'Which targets?' },
        { id: 'other', question: 'Anything else?' }
      ]
    } }
  }))
  runner.respond('claude-req-multi-question', { answers: {
    targets: { answers: ['Android', 'iOS'] },
    other: { answers: ['Other: Wear OS'] }
  } })
  assert.deepEqual(writes.at(-1).response.updatedInput.answers, {
    'Which targets?': 'Android, iOS', 'Anything else?': 'Other: Wear OS'
  })

  runner.onLine('claude', JSON.stringify({
    type: 'control_request', request_id: 'req-plan',
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'Implement safely' } }
  }))
  assert.equal(events.at(-1)?.payload.kind, 'planMode')
  assert.equal(runner.respond('claude-req-plan', { decision: 'approved' }).handled, true)
  assert.equal(writes.at(-1).response.behavior, 'allow')

  runner.interrupt()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(writes.some(item => item.method === 'interrupt'))
  assert.equal(writes.at(-1).method, 'close', 'stop also closes the SDK query so queued native input cannot run later')

  const compact = new TurnRunner('compact', { n: 0 })
  const compactEvents = []
  compact.claudeCompact = true
  compact.on('event', (event) => compactEvents.push(event))
  compact.onLine('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-session' }))
  compact.onLine('claude', JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
  assert.deepEqual(compactEvents.filter(({ type }) => type === 'context_compaction').map(({ state }) => state), ['running', 'success'])

  runner.interrupted = false
  runner.sdk = sdk
  runner.sdkActive = true
  await runner.steer('补充说明')
  const user = writes.at(-1)
  assert.equal(user.method, 'send')
  assert.equal(user.args.content, '补充说明')
  assert.match(user.args.uuid, /^[0-9a-f-]{36}$/)
  assert.equal(user.args.waitForReplay, true)

  assert.deepEqual({
    steer: claudeDef.capabilities.steer,
    followup: claudeDef.capabilities.followup,
    sessionFork: claudeDef.capabilities.sessionFork,
    sessionForkAtTurn: claudeDef.capabilities.sessionForkAtTurn,
    crossAgentFork: claudeDef.capabilities.crossAgentFork,
    structuredUsage: claudeDef.capabilities.structuredUsage,
    formElicitation: claudeDef.capabilities.formElicitation,
    freeTextElicitation: claudeDef.capabilities.freeTextElicitation,
    additionalDirectoriesNew: claudeDef.capabilities.additionalDirectoriesNew,
    additionalDirectoriesResume: claudeDef.capabilities.additionalDirectoriesResume
  }, {
    steer: true, followup: true, sessionFork: true, sessionForkAtTurn: true,
    crossAgentFork: true, structuredUsage: true, formElicitation: true, freeTextElicitation: true,
    additionalDirectoriesNew: true, additionalDirectoriesResume: true
  })

  const claudeApproval = renderToStaticMarkup(React.createElement(ApprovalCard, {
    ev: { sessionId: 'ui', seq: 1, ts: 1, type: 'approval_request', state: 'pending', payload: {
      requestId: 'approval', method: 'claude/canUseTool', kind: 'approval', params: { tool_name: 'Write', file_path: '/repo/a.txt' }
    } },
    onRespond() {}
  }))
  assert.match(claudeApproval, /批准/)
  assert.match(claudeApproval, /拒绝/)
  assert.doesNotMatch(claudeApproval, /本会话都批准/)
  const genericApproval = renderToStaticMarkup(React.createElement(ApprovalCard, {
    ev: { sessionId: 'ui', seq: 2, ts: 2, type: 'approval_request', state: 'pending', payload: {
      requestId: 'approval-other', method: 'generic', kind: 'approval', params: { tool_name: 'Write', file_path: '/repo/a.txt' }
    } },
    onRespond() {}
  }))
  assert.match(genericApproval, /本会话都批准/)

  const reviewDiff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
  const reviewEvents = [
    { sessionId: 'ui', seq: 1, ts: 1, type: 'user_message', payload: { text: 'edit' } },
    { sessionId: 'ui', seq: 2, ts: 2, type: 'agent_message', payload: { id: 'reply', text: 'done', phase: 'final_answer' } },
    { sessionId: 'ui', seq: 3, ts: 3, type: 'diff_update', payload: { diff: reviewDiff } },
    { sessionId: 'ui', seq: 4, ts: 4, type: 'turn_completed', state: 'success', payload: {} }
  ]
  const reviewHtml = renderToStaticMarkup(React.createElement(EventStream, {
    events: reviewEvents, status: 'idle', sessionId: 'ui', onOpenTurnReview() {}
  }))
  assert.match(reviewHtml, /class="turn-change-card"/)
  assert.match(reviewHtml, /审核 →/)
  assert.match(reviewHtml, /a\.txt/)

  const switchedModes = []
  const approvedSession = { config: { permissionMode: 'plan' }, status: 'awaiting-approval' }
  const approvalId = 'claude-plan-approval'
  const approvedRunner = {
    respond: () => ({ handled: true, hasPendingRequests: false }),
    setClaudePermissionMode: async (mode) => { switchedModes.push(mode) }
  }
  const orchestrator = {
    sessions: new Map([['plan-session', approvedSession]]),
    events: new Map([['plan-session', [{ type: 'approval_request', state: 'pending', payload: { requestId: approvalId, kind: 'planMode' } }]]]),
    runners: new Map([['plan-session', approvedRunner]]),
    protocolRunners: new Map(),
    zcodeRunners: new Map(),
    answeringAsyncQuestions: new Set(),
    sessionLogs: { backgroundWrites: false },
    retainAnsweredRequest() {},
    setStatus: (_session, status) => { approvedSession.status = status },
    persist() {}
  }
  Object.setPrototypeOf(orchestrator, Orchestrator.prototype)
  const planResponse = Orchestrator.prototype.respondToRequest.call(orchestrator, 'plan-session', approvalId, { decision: 'approved' })
  assert.equal(planResponse.handled, true)
  assert.equal(approvedSession.config.permissionMode, 'ask')
  assert.deepEqual(switchedModes, ['default'])

  const routedPrompts = []
  const runningSession = { config: { agentId: 'claude' }, status: 'running' }
  const routeRunner = { steer: async (prompt) => { routedPrompts.push(prompt) } }
  const routeBase = {
    sessions: new Map([['running-session', runningSession]]),
    getAgent: () => claudeDef,
    nativeActionReservations: new Set(), rewinding: new Set(),
    runners: new Map([['running-session', routeRunner]]),
    streamers: new Map(),
    record: (...args) => routedPrompts.push(args[1].payload.text)
  }
  await Orchestrator.prototype.forceSendStrict.call(routeBase, 'running-session', 'MCP force')
  assert.equal(routedPrompts[0], 'MCP force')

  const teamPrompts = []
  const teamSession = { teamBinding: { teamProjectId: 'team-1' }, config: { agentId: 'claude' }, status: 'running' }
  const teamBase = {
    sessions: new Map([['team-session', teamSession]]), getAgent: () => claudeDef,
    runners: new Map([['team-session', { steer: async (prompt) => { teamPrompts.push(prompt) } }]]),
    streamers: new Map(), protocolRunners: new Map(), record: (_id, event) => teamPrompts.push(event.payload.text)
  }
  await Orchestrator.prototype.steerTeamMessage.call(teamBase, 'team-session', 'Leader direct message')
  assert.deepEqual(teamPrompts, ['Leader direct message', 'Leader direct message'])

  const compactSession = { config: { agentId: 'claude' }, nativeSessionId: 'native-session', status: 'idle' }
  const compactRequests = []
  const compactOrchestrator = {
    sessions: new Map([['compact-session', compactSession]]),
    getAgent: () => claudeDef,
    nativeActionReservations: new Set(), rewinding: new Set(), pendingSends: new Map(),
    queues: new Map(), isBusy: () => false, isReady: () => true,
    sendMessage: async (_id, prompt) => compactRequests.push(prompt)
  }
  await Orchestrator.prototype.compactSession.call(compactOrchestrator, 'compact-session')
  assert.deepEqual(compactRequests, ['/compact'])

  const stopSession = { id: 'stop-session', status: 'running', config: { agentId: 'claude' } }
  let routedStops = 0
  const stopOrchestrator = {
    sessions: new Map([[stopSession.id, stopSession]]), teamStopVersions: new Map(), channelSendTurns: new Map(), feishuTeamInputs: new Set(),
    deferredDispatches: new Map(), editingQueueItems: new Map(), protocolPendingStarts: new Map(), recoveryStartTokens: new Map(),
    bumpSessionActivity() {}, isBusy: () => true, setStatus: (_session, status) => { stopSession.status = status },
    streamers: new Map(), protocolRunners: new Map(), runners: new Map([[stopSession.id, { interrupt: () => { routedStops++ } }]]),
    queues: new Map(), managementConfirmations: new Map(), zcodeStarts: new Set(), zcodeRunners: new Map()
  }
  Object.setPrototypeOf(stopOrchestrator, Orchestrator.prototype)
  Orchestrator.prototype.interrupt.call(stopOrchestrator, stopSession.id)
  assert.equal(routedStops, 1)
  assert.equal(stopSession.status, 'cancelling')

  const { TeamService } = await server.ssrLoadModule('/src/main/teamService.ts')
  const validateTeam = TeamService.prototype.validateTeam
  const teamDefinition = {
    leaderMemberId: 'leader',
    members: [
      { id: 'leader', role: { id: 'claude-leader', name: 'Claude Leader', agentId: 'claude', permissionMode: claudeDef.capabilities.permissionModes[0].id } },
      { id: 'worker', role: { id: 'codex-worker', name: 'Codex Worker', agentId: 'codex', permissionMode: BUILTIN_AGENTS.find((entry) => entry.id === 'codex').capabilities.permissionModes[0].id } }
    ]
  }
  validateTeam.call({ agents: () => BUILTIN_AGENTS }, teamDefinition)
  assert.doesNotThrow(() => validateTeam.call({ agents: () => [
    { ...claudeDef, capabilities: { ...claudeDef.capabilities, steer: false } },
    BUILTIN_AGENTS.find((entry) => entry.id === 'codex')
  ] }, teamDefinition), 'teams can continue through queued input without steer')

  const queueStates = await exerciseClaudeQueuePromotion(Orchestrator, claudeDef)
  assert.deepEqual(queueStates, { delivered: [], retried: ['pending'], retryNotice: true })
  console.log('claude interactive protocol: ok')
} finally {
  await server.close()
}

async function exerciseClaudeQueuePromotion(Orchestrator, claudeDef) {
  const run = async (steer) => {
    const session = { id: 'queue-session', status: 'running', config: { agentId: 'claude' }, pendingQueue: [] }
    const queue = [{ id: 'q1', prompt: 'queued follow-up', state: 'pending', attempts: 0 }]
    const notices = []
    const base = {
      isTeamMember: () => false, teamQuestions: new Map(),
      sessions: new Map([[session.id, session]]), queues: new Map([[session.id, queue]]),
      activeQueueItems: new Map(), editingQueueItems: new Map(),
      streamers: new Map(), protocolRunners: new Map(), runners: new Map([[session.id, { steer }]]),
      getAgent: () => claudeDef, isBusy: () => true,
      getQueue: (id) => base.queues.get(id) || [],
      commitQueue: (owner, next) => { base.queues.set(owner.id, next); owner.pendingQueue = next },
      emitQueue() {}, record: (_id, event) => { if (event.type === 'system_notice') notices.push(event.payload.text) },
      removeDeliveredQueueItem(owner, itemId) { base.queues.set(owner.id, base.queues.get(owner.id).filter((item) => item.id !== itemId)) },
      restoreQueueItemsToPending(owner, predicate, message) {
        notices.push(message)
        base.queues.set(owner.id, base.queues.get(owner.id).map((item) => predicate(item) ? { ...item, state: 'pending' } : item))
      }
    }
    Orchestrator.prototype.promoteQueueItem.call(base, session.id, 'q1')
    await new Promise((resolve) => setImmediate(resolve))
    return { state: (base.queues.get(session.id) || []).map((item) => item.state), notices }
  }
  const delivered = await run(async () => {})
  const retried = await run(async () => { throw new Error('no replay confirmation') })
  return {
    delivered: delivered.state,
    retried: retried.state,
    retryNotice: retried.notices.some((message) => message.includes('插话未获 Agent 确认'))
  }
}
