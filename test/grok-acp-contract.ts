import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { ACPConnection } from '../src/main/acp/acpConnection.ts'
import {
  GrokACPRunner,
  GROK_PERMISSION_MODES,
  deleteGrokSession,
  listGrokSessions,
  loadGrokSessionEvents,
  probeGrokACP
} from '../src/main/grokACPRunner.ts'
import { buildTextPromptBlocks } from '../src/main/acp/acpPromptBlocks.ts'
import { normalizeQuestions, encodeAnswer } from '../src/shared/questions.ts'
import { normalizeGrokSubagentNotification } from '../src/shared/subAgentLifecycle.ts'
import type { AgentDef } from '../src/shared/types.ts'

// Break caught: Grok cannot be registered as a first-class adapter.
const grokAgent: AgentDef = {
  id: 'grok',
  name: 'Grok',
  bin: 'grok',
  adapter: 'grok',
  icon: 'grok',
  builtin: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    permissionModes: []
  },
  models: []
}
assert.equal(grokAgent.adapter, 'grok')

// Break caught: Grok's machine-readable option values are replaced by labels,
// making an answer impossible to correlate with the advertised option.
const questionFields = normalizeQuestions('grok', {
  questions: [
    {
      id: 'scope',
      header: '范围',
      question: '检查哪个范围？',
      options: [
        { value: 'workspace', label: '当前工作区', description: '仅当前仓库' },
        { value: 'all', label: '全部目录' }
      ]
    },
    {
      id: 'checks',
      question: '选择检查项',
      multiSelect: true,
      options: [
        { value: 'tests', label: '测试' },
        { value: 'types', label: '类型' }
      ]
    },
    { id: 'note', question: '补充说明' }
  ]
})
assert.equal(questionFields.length, 3)
assert.equal(questionFields[0].type, 'single')
assert.deepEqual(questionFields[0].options[0], {
  value: 'workspace',
  label: '当前工作区',
  description: '仅当前仓库'
})
assert.equal(questionFields[1].type, 'multi')
assert.equal(questionFields[2].type, 'text')
assert.deepEqual(
  encodeAnswer('grok', questionFields, {
    '检查哪个范围？': { choice: ['workspace'], text: '', other: '' },
    '选择检查项': { choice: ['tests', 'types'], text: '', other: '' },
    '补充说明': { choice: [], text: '只报告问题', other: '' }
  }),
  {
    outcome: 'accepted',
    answers: {
      '检查哪个范围？': ['当前工作区'],
      '选择检查项': ['测试', '类型'],
      '补充说明': ['只报告问题']
    }
  }
)

// Break caught: Grok child lifecycle updates are dropped or attributed to the
// parent session instead of the child session.
const spawned = normalizeGrokSubagentNotification({
  type: 'subagent_spawned',
  subagent_id: 'agent-child',
  child_session_id: 'session-child',
  parent_session_id: 'session-parent',
  parent_prompt_id: 'prompt-parent',
  description: 'Inspect history',
  model: 'grok-4.6'
}, 1000)
assert.deepEqual(spawned, {
  agentThreadId: 'session-child',
  nativeTaskId: 'agent-child',
  parentThreadId: 'session-parent',
  dispatchId: 'prompt-parent',
  name: 'Inspect history',
  status: 'running',
  tool: 'spawn_subagent',
  startedAt: 1000
})

// Break caught: terminal output/usage is lost, or child usage is shaped like a
// parent turn usage event and later counted twice.
const finished = normalizeGrokSubagentNotification({
  type: 'subagent_finished',
  subagent_id: 'agent-child',
  child_session_id: 'session-child',
  parent_session_id: 'session-parent',
  parent_prompt_id: 'prompt-parent',
  description: 'Inspect history',
  status: 'completed',
  output: 'History path verified',
  tokens: { input_tokens: 120, output_tokens: 30, total_tokens: 150 }
}, 2500)
assert.deepEqual(finished, {
  agentThreadId: 'session-child',
  nativeTaskId: 'agent-child',
  parentThreadId: 'session-parent',
  dispatchId: 'prompt-parent',
  name: 'Inspect history',
  status: 'completed',
  tool: 'spawn_subagent',
  message: 'History path verified',
  endedAt: 2500,
  tokens: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
})

assert.equal(normalizeGrokSubagentNotification({ type: 'response_completed' }, 3000), undefined)

type JsonFrame = Record<string, any>

async function runFakeGrok(scenario: Record<string, unknown> = {}): Promise<{
  request: (method: string, params?: unknown) => Promise<JsonFrame>
  notifications: JsonFrame[]
  close: () => Promise<void>
  logPath: string
  statePath: string
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-grok-contract-'))
  const logPath = join(dir, 'protocol.jsonl')
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify({ sessions: [] }), 'utf8')
  const fixture = resolve(process.cwd(), 'test/fixtures/fake-grok.cjs')
  const child = spawn(process.execPath, [
    fixture,
    'agent',
    '--no-leader',
    '--model',
    'grok-4.6',
    '--reasoning-effort',
    'high',
    'stdio'
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FAKE_GROK_LOG: logPath,
      FAKE_GROK_STATE: statePath,
      FAKE_GROK_SCENARIO: JSON.stringify(scenario)
    }
  })
  const pending = new Map<number, (frame: JsonFrame) => void>()
  const notifications: JsonFrame[] = []
  let nextId = 1
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line)
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      pending.get(frame.id)!(frame)
      pending.delete(frame.id)
    } else {
      notifications.push(frame)
    }
  })
  const request = (method: string, params: unknown = {}): Promise<JsonFrame> => {
    const id = nextId++
    const result = new Promise<JsonFrame>((resolveFrame, reject) => {
      pending.set(id, resolveFrame)
      setTimeout(() => {
        if (!pending.delete(id)) return
        reject(new Error(`fake Grok ${method} timed out: ${Buffer.concat(stderr).toString('utf8')}`))
      }, 2_000).unref()
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return result
  }
  const close = async (): Promise<void> => {
    child.stdin.end()
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit()
      child.once('exit', () => resolveExit())
      setTimeout(() => { child.kill('SIGTERM'); resolveExit() }, 2_000).unref()
    })
  }
  return { request, notifications, close, logPath, statePath, dir }
}

// Break caught: the fixture drifts away from the verified Grok CLI argv or ACP
// handshake, allowing provider tests to pass against an invented protocol.
const fake = await runFakeGrok()
try {
  const initialized = await fake.request('initialize', { protocolVersion: 1 })
  assert.equal(initialized.result.protocolVersion, 1)
  assert.equal('agentInfo' in initialized.result, false)
  assert.deepEqual(initialized.result.agentCapabilities.promptCapabilities, {
    image: false,
    audio: false,
    embeddedContext: true
  })
  assert.deepEqual(Object.keys(initialized.result.agentCapabilities.sessionCapabilities).sort(), [
    'close',
    'list',
    'resume'
  ])

  const created = await fake.request('session/new', { cwd: fake.dir, mcpServers: [] })
  assert.equal(created.result.sessionId, 'grok-session-1')
  assert.equal(created.result.models.currentModelId, 'grok-4.6')
  assert.equal(created.result.models.availableModels[0]._meta.totalContextTokens, 500000)
  assert.deepEqual(created.result.models.availableModels[0]._meta.reasoningEfforts, [
    { id: 'xhigh', value: 'xhigh', label: 'Extra High', default: false },
    { id: 'high', value: 'high', label: 'High', default: true },
    { id: 'medium', value: 'medium', label: 'Medium', default: false },
    { id: 'low', value: 'low', label: 'Low', default: false }
  ])
  assert.deepEqual(created.result.modes.availableModes.map((mode: any) => mode.id), ['build', 'plan'])
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  assert.ok(fake.notifications.some((frame) =>
    frame.method === 'session/update' &&
    frame.params?.update?.sessionUpdate === 'available_commands_update'
  ))
  await fake.request('session/close', { sessionId: created.result.sessionId })
} finally {
  await fake.close()
}
const records = (await readFile(fake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
assert.deepEqual(records.find((record) => record.kind === 'argv')?.argv, [
  'agent',
  '--no-leader',
  '--model',
  'grok-4.6',
  '--reasoning-effort',
  'high',
  'stdio'
])
await rm(fake.dir, { recursive: true, force: true })

const unauthenticated = await runFakeGrok({ authenticationRequired: true })
try {
  assert.ok((await unauthenticated.request('initialize')).result)
  const session = await unauthenticated.request('session/new', { cwd: unauthenticated.dir })
  assert.equal(session.error.code, -32000)
  assert.equal(session.error.message, 'Authentication required')
} finally {
  await unauthenticated.close()
  await rm(unauthenticated.dir, { recursive: true, force: true })
}

// Break caught: the reusable ACP transport hard-codes an unrelated argv instead of
// launching the provider command supplied by the Grok adapter.
const transportDir = await mkdtemp(join(tmpdir(), 'uniagent-grok-transport-'))
const transportLog = join(transportDir, 'protocol.jsonl')
const transportState = join(transportDir, 'state.json')
await writeFile(transportState, JSON.stringify({ sessions: [] }), 'utf8')
const transport = new ACPConnection({
  bin: process.execPath,
  args: [
    resolve(process.cwd(), 'test/fixtures/fake-grok.cjs'),
    'agent',
    '--no-leader',
    '--model',
    'grok-4.6',
    '--reasoning-effort',
    'high',
    'stdio'
  ],
  cwd: transportDir,
  env: { ...process.env, FAKE_GROK_LOG: transportLog, FAKE_GROK_STATE: transportState },
  providerLabel: 'Grok',
  validateInitialize: (value) => {
    assert.equal(value.protocolVersion, 1)
    assert.ok(value.agentCapabilities)
  }
})
try {
  const initialized = await transport.initialize()
  assert.equal(initialized.protocolVersion, 1)
  assert.deepEqual((await transport.request('session/list')).sessions, [])
} finally {
  transport.close()
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
}
const transportRecords = (await readFile(transportLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
assert.deepEqual(transportRecords.find((record) => record.kind === 'argv')?.argv, [
  'agent',
  '--no-leader',
  '--model',
  'grok-4.6',
  '--reasoning-effort',
  'high',
  'stdio'
])
const initializeFrame = transportRecords.find((record) =>
  record.kind === 'inbound' && record.frame?.method === 'initialize'
)?.frame
// Break caught: Grok rejects a boolean elicitation.form; Kimi also needs this
// capability to keep multi-question forms instead of its single-question bridge.
// The capability must use the object form, and MiniMax Code only sends its
// Plan review (`elicitation/create`) to clients that declare it.
const elicitation = initializeFrame?.params?.clientCapabilities?.elicitation
assert.notEqual(elicitation, true, 'elicitation.form must never be the boolean form')
assert.ok(
  elicitation === undefined || (typeof elicitation === 'object' && elicitation !== null && typeof elicitation.form === 'object'),
  'elicitation.form must be an object'
)
// Break caught: the client advertises reverse terminal support without handling
// terminal/create, causing Kimi auth/tool execution to call a missing method.
assert.notEqual(initializeFrame?.params?.clientCapabilities?.terminal, true)
await rm(transportDir, { recursive: true, force: true })

async function createRunnerFake(): Promise<{
  dir: string
  bin: string
  logPath: string
  statePath: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-grok-runner-'))
  const bin = join(dir, 'grok')
  const logPath = join(dir, 'protocol.jsonl')
  const statePath = join(dir, 'state.json')
  const fixture = resolve(process.cwd(), 'test/fixtures/fake-grok.cjs')
  await writeFile(statePath, JSON.stringify({ sessions: [] }), 'utf8')
  await writeFile(bin, `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(logPath)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(statePath)}
require(${JSON.stringify(fixture)})
`, 'utf8')
  await chmod(bin, 0o755)
  return { dir, bin, logPath, statePath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error(`${label} was not observed within ${timeoutMs}ms`)
}

// Break caught: the Grok runner loses negotiated state or normalizes streamed
// frames differently from the existing UniAgent session contract.
const runnerFake = await createRunnerFake()
try {
  const runnerAgent: AgentDef = {
    ...grokAgent,
    bin: runnerFake.bin,
    capabilities: { ...grokAgent.capabilities, permissionModes: GROK_PERMISSION_MODES }
  }
  const events: any[] = []
  const contracts: any[] = []
  const nativeIds: string[] = []
  const runner = new GrokACPRunner(
    'local-grok',
    { n: 0 },
    runnerAgent,
    {
      agentId: 'grok',
      model: 'grok-4.6',
      effort: 'high',
      permissionMode: 'ask',
      workdir: runnerFake.dir
    }
  )
  runner.on('event', (event) => events.push(event))
  runner.on('contract', (contract) => contracts.push(structuredClone(contract)))
  runner.on('nativeSession', ({ nativeSessionId }) => nativeIds.push(nativeSessionId))
  await runner.startTurn('stream')
  const firstSessionRequest = (await readFile(runnerFake.logPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'inbound' && record.frame?.method === 'session/new')
  assert.equal(firstSessionRequest.frame.params.mcpServers.length, 1)
  assert.equal(firstSessionRequest.frame.params.mcpServers[0].name, 'uniagent')
  assert.equal(firstSessionRequest.frame.params.mcpServers[0].command, process.execPath)
  assert.equal(
    firstSessionRequest.frame.params.mcpServers[0].env.find(
      (entry: { name: string; value: string }) => entry.name === 'UNIAGENT_CALLER_SESSION'
    )?.value,
    'local-grok',
    'Grok must receive the provider-neutral UniAgent handoff MCP descriptor'
  )
  assert.deepEqual(nativeIds, ['grok-session-1'])
  assert.equal(events.filter((event) => event.type === 'turn_started').length, 1)
  assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)
  assert.equal(events.find((event) => event.type === 'reasoning')?.payload.text, 'Inspecting')
  assert.equal(events.find((event) => event.type === 'agent_message')?.payload.text, 'Grok reply')
  assert.equal(events.find((event) => event.type === 'command_exec')?.payload.command, 'pwd')
  assert.equal(events.some(event => event.type === 'system_notice' && event.payload.kind === 'usage'), false, 'private usage metadata is ignored')
  assert.ok(contracts.at(-1)?.commands.includes('review'))
  assert.deepEqual(contracts.at(-1)?.permissionModes.map((mode: any) => mode.id), [
    'ask',
    'full-access'
  ])
  runner.dispose()

  // Break caught: Grok edit tools render as opaque generic calls instead of
  // the same file-change card used by the existing adapters.
  const editEvents: any[] = []
  const edit = new GrokACPRunner(
    'local-edit',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'high', permissionMode: 'ask', workdir: runnerFake.dir }
  )
  edit.on('event', (event) => editEvents.push(event))
  await edit.startTurn('edit')
  edit.dispose()
  assert.deepEqual(
    editEvents.find((event) => event.type === 'file_change')?.payload.changes,
    [{
      path: '/fixture/workspace/fixture.txt',
      kind: 'modify',
      oldText: 'before\n',
      newText: 'after\n'
    }]
  )
  assert.equal(editEvents.some((event) =>
    event.type === 'tool_call' && event.payload.id === 'grok-edit-1'
  ), false)

  // Break caught: Grok reports a completed compaction but UniAgent neither
  // records it nor drops the live context meter to the native post-compact size.
  const compactEvents: any[] = []
  const compact = new GrokACPRunner(
    'local-compact',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'high', permissionMode: 'ask', workdir: runnerFake.dir }
  )
  compact.on('event', (event) => compactEvents.push(event))
  await compact.startTurn('/compact')
  compact.dispose()
  assert.equal(compactEvents.some(event => event.type === 'context_compaction'), false, 'private compaction metadata is ignored')

  const resumedEvents: any[] = []
  const resumed = new GrokACPRunner(
    'local-resumed',
    { n: 0 },
    runnerAgent,
    {
      agentId: 'grok',
      model: 'grok-4.6',
      effort: 'high',
      permissionMode: 'ask',
      workdir: runnerFake.dir
    },
    'grok-session-1'
  )
  resumed.on('event', (event) => resumedEvents.push(event))
  await resumed.startTurn('stream')
  resumed.dispose()
  const resumedMessages = resumedEvents.filter((event) => event.type === 'agent_message')
  assert.equal(new Set(resumedMessages.map((event) => event.payload.id)).size, 1)
  assert.equal(resumedMessages.at(-1)?.payload.text, 'Grok reply')

  const blocking = new GrokACPRunner(
    'local-cancel',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'low', permissionMode: 'ask', workdir: runnerFake.dir }
  )
  const blockingEvents: any[] = []
  blocking.on('event', (event) => blockingEvents.push(event))
  const blockedTurn = blocking.startTurn('wait')
  await waitFor(
    async () => (await readFile(runnerFake.logPath, 'utf8')).split('\n').some((line) => {
      if (!line) return false
      const record = JSON.parse(line)
      return record.kind === 'inbound' &&
        record.frame?.method === 'session/prompt' &&
        record.frame?.params?.prompt?.some((block: any) => block.type === 'text' && block.text === 'wait')
    }),
    'blocking prompt'
  )
  blocking.interrupt()
  await blockedTurn
  await waitFor(
    async () => (await readFile(runnerFake.logPath, 'utf8')).includes('session/cancel'),
    'session/cancel notification'
  )
  assert.equal(blockingEvents.at(-1)?.type, 'turn_completed')
  assert.equal(blockingEvents.at(-1)?.state, 'cancelled')
  blocking.dispose()

  const runnerRecords = (await readFile(runnerFake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const invocations = runnerRecords.filter((record) => record.kind === 'argv').map((record) => record.argv)
  assert.ok(invocations.every(argv => JSON.stringify(argv) === JSON.stringify(['--no-auto-update','agent','--no-leader','stdio'])))
  assert.ok(runnerRecords.some((record) =>
    record.kind === 'inbound' && record.frame?.method === 'session/resume'
  ))
  assert.ok(runnerRecords.some((record) =>
    record.kind === 'inbound' && record.frame?.method === 'session/cancel' && record.frame?.id === undefined
  ))

  const planEvents: any[] = []
  const plan = new GrokACPRunner(
    'local-plan',
    { n: 0 },
    runnerAgent,
    {
      agentId: 'grok',
      model: 'grok-4.6',
      effort: 'high',
      permissionMode: 'ask',
      collaborationMode: 'plan',
      workdir: runnerFake.dir
    }
  )
  plan.on('event', (event) => planEvents.push(event))
  await plan.startTurn('stream')
  plan.dispose()
  const planRecords = (await readFile(runnerFake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const setMode = planRecords.find((record) =>
    record.kind === 'inbound' && record.frame?.method === 'session/set_mode'
  )
  assert.equal(setMode?.frame?.params?.modeId, 'plan')
  assert.ok(planEvents.some((event) => event.type === 'plan_update') === false)

  const permissionEvents: any[] = []
  const permission = new GrokACPRunner(
    'local-permission',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'high', permissionMode: 'ask', workdir: runnerFake.dir }
  )
  permission.on('event', (event) => permissionEvents.push(event))
  const permissionTurn = permission.startTurn('permission')
  await waitFor(
    () => permissionEvents.some((event) => event.type === 'approval_request' && event.state === 'pending'),
    'permission request'
  )
  const permissionRequest = permissionEvents.find((event) => event.type === 'approval_request' && event.state === 'pending')
  assert.deepEqual(permissionRequest.payload.options.map((option: any) => option.optionId), [
    'allow_once',
    'allow_always',
    'reject_once'
  ])
  assert.deepEqual(permission.respondResult(permissionRequest.payload.requestId, {
    outcome: { outcome: 'selected', optionId: 'allow_always' }
  }), { handled: true, hasPendingRequests: false })
  await permissionTurn
  permission.dispose()

  // Break caught: Grok 1.0.34 leaks internal skills-bus responses whose ids the
  // client never issued; the transport must drop frames with a foreign id shape
  // (string/null) instead of failing the whole session.
  const foreignEvents: any[] = []
  const foreign = new GrokACPRunner(
    'local-foreign',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'high', permissionMode: 'ask', workdir: runnerFake.dir },
    undefined,
    { FAKE_GROK_SCENARIO: JSON.stringify({ foreignResponses: true }) }
  )
  foreign.on('event', (event) => foreignEvents.push(event))
  await foreign.startTurn('stream')
  foreign.dispose()
  assert.equal(foreignEvents.at(-1)?.type, 'turn_completed')
  assert.equal(foreignEvents.at(-1)?.state, 'success')
  assert.equal(foreignEvents.find((event) => event.type === 'agent_message')?.payload.text, 'Grok reply')

  // Break caught: the foreign-id tolerance must not extend to numeric ids —
  // those are indistinguishable from broken late-response bookkeeping.
  const numericEvents: any[] = []
  const numeric = new GrokACPRunner(
    'local-unknown-numeric',
    { n: 0 },
    runnerAgent,
    { agentId: 'grok', model: 'grok-4.6', effort: 'high', permissionMode: 'ask', workdir: runnerFake.dir },
    undefined,
    { FAKE_GROK_SCENARIO: JSON.stringify({ unknownNumericResponse: true }) }
  )
  numeric.on('event', (event) => numericEvents.push(event))
  await numeric.startTurn('stream')
  numeric.dispose()
  assert.equal(numericEvents.at(-1)?.type, 'turn_completed')
  assert.equal(numericEvents.at(-1)?.state, 'failed')
  assert.match(
    numericEvents.find((event) => event.type === 'error')?.payload?.message || '',
    /未知 JSON-RPC 响应 id/
  )

  const attachmentFile = join(runnerFake.dir, 'attachment.txt')
  await writeFile(attachmentFile, 'fixture marker', 'utf8')
  assert.deepEqual(await buildTextPromptBlocks('read', [{
    kind: 'file', path: attachmentFile, name: 'attachment.txt', mime: 'text/plain'
  }], { imageAttachments: false, fileAttachments: true }), [
    { type: 'text', text: 'read' },
    { type: 'resource_link', uri: new URL(`file://${attachmentFile}`).href, name: 'attachment.txt', mimeType: 'text/plain' }
  ])
  // Break caught: arbitrary binary files are advertised to Grok as supported text attachments.
  const binaryAttachment = join(runnerFake.dir, 'attachment.bin')
  await writeFile(binaryAttachment, Buffer.from([0x47, 0x72, 0x6f, 0x6b, 0x00, 0xff]))
  await assert.rejects(
    () => buildTextPromptBlocks('read', [{
      kind: 'file', path: binaryAttachment, name: 'attachment.bin', mime: 'application/octet-stream'
    }], { imageAttachments: false, fileAttachments: true }),
    /仅支持文本文件附件/
  )
  await assert.rejects(
    () => buildTextPromptBlocks('', [{ kind: 'image', path: attachmentFile, name: 'image.png', mime: 'image/png' }], {
      imageAttachments: false, fileAttachments: true
    }),
    /不支持图片输入/
  )

  const beforeProbe = (await readFile(runnerFake.logPath, 'utf8')).split('\n').filter(Boolean).length
  const probe = await probeGrokACP(runnerFake.bin, runnerFake.dir, { GROK_HOME: join(runnerFake.dir, 'native-home') })
  assert.equal(probe.status, 'ready')
  const probeRecords = (await readFile(runnerFake.logPath, 'utf8')).split('\n').filter(Boolean).slice(beforeProbe).map((line) => JSON.parse(line))
  assert.equal(probeRecords.some((record) => record.frame?.method === 'session/prompt'), false)
  assert.ok(probeRecords.filter(record => record.kind === 'argv' && record.argv.includes('stdio')).every(record => record.grokHome?.includes('uniagent-grok-probe-')), 'probe storage is temporary instead of relying on logical session deletion')
  const unavailable = await probeGrokACP(runnerFake.bin, runnerFake.dir, { GROK_HOME: join(runnerFake.dir, 'native-home'), FAKE_GROK_SCENARIO: JSON.stringify({ serviceUnavailable: true }) })
  assert.equal(unavailable.status, 'incompatible', 'generic ACP -32000 does not mean missing authentication')
  const needsAuth = await probeGrokACP(runnerFake.bin, runnerFake.dir, { GROK_HOME: join(runnerFake.dir, 'native-home'), FAKE_GROK_SCENARIO: JSON.stringify({ authenticationRequired: true }) })
  assert.equal(needsAuth.status, 'needs-auth')

  const history = await listGrokSessions(runnerFake.bin, runnerFake.dir)
  assert.ok(history.some((entry) => entry.id === 'grok-session-1' && entry.agentId === 'grok'))
  const loaded = await loadGrokSessionEvents('grok-session-1', runnerFake.bin, runnerFake.dir)
  assert.equal(loaded.cwd, runnerFake.dir)
  assert.equal(loaded.model, 'grok-4.6')
  assert.ok(loaded.events.some((event) => event.type === 'user_message' && event.payload.text === 'stream'))
  assert.ok(loaded.events.some((event) => event.type === 'reasoning' && event.payload.text === 'Inspecting'))
  assert.ok(loaded.events.some((event) => event.type === 'agent_message' && event.payload.text === 'Grok reply'))
  await deleteGrokSession('grok-session-1', runnerFake.bin, runnerFake.dir)
  assert.equal((await listGrokSessions(runnerFake.bin, runnerFake.dir)).some((entry) => entry.id === 'grok-session-1'), true, 'undeclared native delete preserves native history')
} finally {
  await runnerFake.cleanup()
}

console.log('grok-acp-contract: shared contracts ok')
