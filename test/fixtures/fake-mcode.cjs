#!/usr/bin/env node

// Deterministic MiniMax Code ACP fixture.
//
// The wire shapes below are copied from the real `mcode 0.6.12` ACP server
// (see docs/minimax-code-acp-integration-proposal.md §4.2–4.6):
//   - `initialize` advertises the `mcode/*` extension surface in
//     `_meta["minimax-code/extensions"]`.
//   - `configOptions` carries three entries: `permissionMode` (category
//     `_permission`, process scoped), `model` (category `model`, encoded
//     `m:<provider>:<model>:u` / `m:<provider>:<model>:v:<variant>`) and
//     `thinkingEffort` (category `thought_level`, which disappears for models
//     that do not advertise it).
//   - `session/delete` is NOT registered and must answer -32601.
//   - Permission options are `allow-once` / `allow-always` / `deny`.
//   - File writes arrive as `rawInput.path` + `rawInput.content` with no
//     ACP `diff` block.
//
// Stdout is reserved for JSON-RPC; every frame is mirrored to the
// caller-owned JSONL log for assertions.
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const argv = process.argv.slice(2)
const logPath = process.env.FAKE_MCODE_LOG
const scenario = (() => {
  try {
    return JSON.parse(process.env.FAKE_MCODE_SCENARIO || '{}')
  } catch {
    return {}
  }
})()
const nativeHome = process.env.MINIMAX_DATA_DIR
const statePath = scenario.nativeData ? join(nativeHome, 'sessions.json') : process.env.FAKE_MCODE_STATE
if (scenario.nativeData) mkdirSync(nativeHome, { recursive: true })
function nativeConfig() { try { return JSON.parse(readFileSync(join(nativeHome, 'config.yaml'), 'utf8')) } catch { return {} } }
function nativeAuthenticated() { return !!nativeConfig().apiKey || nativeConfig().provider === 'third-party' || existsSync(join(nativeHome, 'auth/prod/session.json')) }

function append(record) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...record }) + '\n', 'utf8')
}

function readState() {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    return { sessions: Array.isArray(value.sessions) ? value.sessions : [], goal: value.goal }
  } catch {
    return { sessions: [], goal: undefined }
  }
}

function writeState(value) {
  if (statePath) {
    const temporary = statePath + '.' + process.pid + '.tmp'
    writeFileSync(temporary, JSON.stringify(value), 'utf8')
    renameSync(temporary, statePath)
  }
}

append({ kind: 'argv', argv, ...(scenario.nativeData ? { dataDir: nativeHome } : {}) })

// ---- CLI surface (no ACP) ---------------------------------------------------

if (argv.length === 1 && argv[0] === '--version') {
  if (scenario.versionFailure) process.exit(1)
  process.stdout.write('0.6.12\n')
  process.exit(0)
}

if (argv[0] === 'provider' && argv[1] === 'set-minimax-key') {
  const key = process.env.MCODE_PROVIDER_API_KEY
  if (!key) {
    process.stderr.write('MCODE_PROVIDER_API_KEY is required\n')
    process.exit(1)
  }
  const state = readState()
  if (scenario.nativeData) writeFileSync(join(nativeHome, 'config.yaml'), JSON.stringify({ ...nativeConfig(), apiKey: key }), { mode: 0o600 })
  if (!scenario.nativeData) writeState({ ...state, key })
  process.stdout.write('MiniMax API Key saved and selected.\n')
  process.exit(0)
}

if (argv[0] === 'provider' && argv[1] === 'test' && argv[2] === 'minimax_api') {
  if (scenario.nativeData) {
    process.stdout.write(JSON.stringify({ success: nativeConfig().apiKey === 'valid-fixture-key' }))
    process.exit(0)
  }
  const state = readState()
  const key = process.env.MCODE_PROVIDER_API_KEY || state.key
  if (!key) {
    process.stderr.write('No MiniMax API Key configured\n')
    process.exit(1)
  }
  process.stdout.write('Provider available: minimax_api\n')
  process.exit(0)
}

if (scenario.nativeData && argv[0] === 'login') {
  process.stderr.write('Open: https://agent.minimax.cn/device?user_code=fixture\nCode: fixture\nWaiting for authorization…\n')
  setTimeout(() => {
    mkdirSync(join(nativeHome, 'auth/prod'), { recursive: true })
    writeFileSync(join(nativeHome, 'auth/prod/session.json'), '{}', { mode: 0o600 })
    process.exit(0)
  }, scenario.loginHold ? 60_000 : 150)
  return
}

// ---- ACP surface ------------------------------------------------------------

if (argv.length !== 1 || argv[0] !== 'acp') {
  process.stderr.write(`unsupported fake MiniMax Code invocation: ${JSON.stringify(argv)}\n`)
  process.exit(2)
}
if (!logPath || !statePath) {
  process.stderr.write('FAKE_MCODE_LOG and FAKE_MCODE_STATE are required\n')
  process.exit(2)
}

const MODEL_WITH_EFFORT = 'm:minimax:MiniMax-M3.1-Flash:v:thinking'
const MODEL_WITHOUT_EFFORT = 'm:minimax:MiniMax-M3:v:thinking'
const MODEL_OPTIONS = [
  { value: 'm:minimax:MiniMax-M3.1-Flash:u', name: 'MiniMax-M3.1-Flash' },
  { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'MiniMax-M3.1-Flash' },
  { value: 'm:minimax:MiniMax-M3:u', name: 'MiniMax-M3' },
  { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'MiniMax-M3' }
]
const PERMISSION_OPTIONS = [
  { value: 'default', name: 'Ask' },
  { value: 'auto', name: 'Auto' },
  { value: 'bypassPermissions', name: 'Full access' }
]
const EFFORT_OPTIONS = [
  { value: 'default', name: 'Default' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra High' },
  { value: 'max', name: 'Max' }
]

// Session scoped configuration mirrors the real runtime: the permission mode
// is process scoped, the model and the thinking effort are session scoped.
let permissionMode = 'bypassPermissions'
let model = MODEL_WITH_EFFORT
let thinkingEffort = 'default'
let mode = 'default'
let pendingMode

function advertisesEffort(value) {
  return !String(value).startsWith('m:minimax:MiniMax-M3:')
}

function configOptions() {
  const options = [
    {
      id: 'permissionMode',
      category: '_permission',
      type: 'select',
      name: 'Permission Mode',
      currentValue: permissionMode,
      options: PERMISSION_OPTIONS,
      _meta: { 'minimax-code/scope': 'process' }
    },
    {
      id: 'model',
      category: 'model',
      type: 'select',
      name: 'Model',
      currentValue: model,
      options: MODEL_OPTIONS
    }
  ]
  if (advertisesEffort(model)) {
    options.push({
      id: 'thinkingEffort',
      category: 'thought_level',
      type: 'select',
      name: 'Thinking Effort',
      currentValue: thinkingEffort,
      options: EFFORT_OPTIONS
    })
  }
  return scenario.noPermissionOption ? options.filter(option => option.id !== 'permissionMode') : options
}

function modes() {
  return {
    currentModeId: mode,
    availableModes: [
      { id: 'default', name: 'Default', description: 'Work normally with the configured tools and permission policy.' },
      { id: 'plan', name: 'Plan', description: 'Research and prepare an implementation plan before making changes.' }
    ]
  }
}

function sessionResult(sessionId) {
  return { sessionId, modes: modes(), configOptions: configOptions() }
}

function send(frame) {
  append({ kind: 'outbound', frame })
  process.stdout.write(JSON.stringify(frame) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}
function update(sessionId, value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
}

function initializeResult() {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
    },
    authMethods: [
      { type: 'terminal', id: 'minimax-code-login', name: 'Sign in to MiniMax Code', args: ['login'] }
    ],
    agentInfo: { name: 'minimax-code', title: 'MiniMax Code', version: '0.6.12' },
    _meta: {
      'minimax-code/extensions': {
        version: 1,
        methods: [
          'session/activate',
          'mcode/session/activate',
          'mcode/session/steer',
          'mcode/session/queue/list',
          'mcode/session/queue/enqueue',
          'mcode/session/queue/update',
          'mcode/session/queue/delete',
          'mcode/session/queue/steer',
          'mcode/session/goal/get',
          'mcode/session/goal/create',
          'mcode/session/goal/patch',
          'mcode/session/goal/clear',
          'mcode/session/delegation/get',
          'mcode/session/delegation/stop'
        ],
        notifications: [
          'mcode/session/current_session_update',
          'mcode/session/queue_update',
          'mcode/session/goal_update',
          'mcode/session/delegation_update'
        ]
      }
    }
  }
}

function contentText(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('')
    : ''
}

function findSession(sessionId) {
  return readState().sessions.find((session) => session.sessionId === sessionId)
}

let pendingPrompt = null
let pendingInteraction = null
let pendingSteer = null
let goal = null

createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.stderr.write('invalid JSON-RPC frame\n')
    return
  }
  append({ kind: 'inbound', frame })
  if (frame.method === undefined && pendingInteraction && frame.id === pendingInteraction.requestId) {
    const interaction = pendingInteraction
    pendingInteraction = null
    update(interaction.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: interaction.kind === 'permission' ? 'Permission resolved' : 'Review accepted' }
    })
    reply(interaction.promptId, { stopReason: 'end_turn' })
    return
  }
  const params = frame.params && typeof frame.params === 'object' ? frame.params : {}
  switch (frame.method) {
    case 'initialize':
      reply(frame.id, initializeResult())
      return
    case 'session/new': {
      if (scenario.networkFailure) { fail(frame.id, -32000, 'Service unavailable'); return }
      if (scenario.authenticationRequired === true || scenario.nativeData && !nativeAuthenticated()) {
        fail(frame.id, -32000, 'Authentication required: Run `mcode login` and try again.')
        return
      }
      const state = readState()
      const sessionId = `mvs_${String(state.sessions.length + 1).padStart(32, '0')}`
      state.sessions.push({
        sessionId,
        cwd: params.cwd,
        title: 'Fake MiniMax Code session',
        updatedAt: '2026-10-19T12:00:00.000Z',
        transcript: []
      })
      writeState(state)
      reply(frame.id, sessionResult(sessionId))
      update(sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'help', description: 'Show available commands' },
          { name: 'compact', description: 'Compact the current context' }
        ]
      })
      return
    }
    case 'session/list':
      reply(frame.id, { sessions: readState().sessions, nextCursor: null })
      return
    case 'session/load': {
      const session = findSession(params.sessionId)
      if (!session) {
        fail(frame.id, -32004, 'FS_NOT_FOUND')
        return
      }
      for (const entry of session.transcript || []) {
        update(params.sessionId, {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk'
            : entry.role === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text }
        })
      }
      reply(frame.id, { modes: modes(), configOptions: configOptions(), _meta: { 'minimax-code/scope': 'session' } })
      return
    }
    case 'session/resume': {
      if (!findSession(params.sessionId)) {
        fail(frame.id, -32004, 'FS_NOT_FOUND')
        return
      }
      reply(frame.id, { modes: modes(), configOptions: configOptions() })
      return
    }
    case 'session/close':
      reply(frame.id, {})
      return
    case 'session/activate':
      reply(frame.id, {})
      return
    case 'session/fork': {
      if (!findSession(params.sessionId)) {
        fail(frame.id, -32602, 'message-boundary-not-found')
        return
      }
      const state = readState()
      const sessionId = `mvs_${String(state.sessions.length + 1).padStart(32, '0')}`
      state.sessions.push({
        sessionId,
        cwd: params.cwd,
        title: 'Fake MiniMax Code fork',
        updatedAt: '2026-10-19T12:00:00.000Z',
        transcript: structuredClone(findSession(params.sessionId).transcript || [])
      })
      writeState(state)
      reply(frame.id, sessionResult(sessionId))
      return
    }
    case 'session/set_mode':
      pendingMode = params.modeId
      reply(frame.id, { _meta: { 'minimax-code/transition': 'next_prompt' } })
      return
    case 'session/set_config_option': {
      if (params.configId === 'permissionMode') {
        if (scenario.permissionUnsupported) { fail(frame.id, -32601, 'Method not found'); return }
        if (!PERMISSION_OPTIONS.some((option) => option.value === params.value)) {
          fail(frame.id, -32602, `Unsupported permission mode: ${params.value}`)
          return
        }
        permissionMode = params.value
      } else if (params.configId === 'model') {
        if (!MODEL_OPTIONS.some((option) => option.value === params.value)) {
          fail(frame.id, -32602, `Invalid model config value: ${params.value}`)
          return
        }
        model = params.value
        if (!advertisesEffort(model)) thinkingEffort = 'default'
      } else if (params.configId === 'thinkingEffort') {
        if (!advertisesEffort(model)) {
          fail(frame.id, -32602, `Thinking effort is not advertised for the selected model: ${params.value}`)
          return
        }
        if (!EFFORT_OPTIONS.some((option) => option.value === params.value)) {
          fail(frame.id, -32602, `Invalid thinking effort: ${params.value}`)
          return
        }
        thinkingEffort = params.value
      } else {
        fail(frame.id, -32602, `Unknown config option: ${params.configId}`)
        return
      }
      const options = configOptions()
      reply(frame.id, { configOptions: options })
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: options })
      return
    }
    case 'mcode/session/steer': {
      if (!pendingSteer) {
        fail(frame.id, -32602, 'Steering requires an admitted, active ACP prompt Turn for this Session.')
        return
      }
      const steer = pendingSteer
      pendingSteer = null
      reply(frame.id, { turnId: `steer-${steer.promptId}`, mode: 'steered' })
      update(steer.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Steered: ${params.text}` }
      })
      reply(steer.promptId, { stopReason: 'end_turn' })
      return
    }
    case 'mcode/session/goal/get':
      reply(frame.id, { goal: goal || null })
      return
    case 'mcode/session/goal/create': {
      goal = {
        goalId: `tg_${String(readState().sessions.length + 1).padStart(8, '0')}`,
        sessionId: params.sessionId,
        objective: params.objective,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokensUsed: 0,
        turnsUsed: 0,
        timeUsedSeconds: 0,
        tokenBudget: typeof params.tokenBudget === 'number' ? params.tokenBudget : null,
        statusReason: null,
        executionWait: null,
        hasKickoff: true
      }
      reply(frame.id, { goal })
      if (scenario.goalNotifications) send({
        jsonrpc: '2.0',
        method: 'mcode/session/goal_update',
        params: { sessionId: params.sessionId, goal }
      })
      if (scenario.goalCompletes === true || scenario.goalFinalStatus) {
        // The real runtime drives the goal on its own and never notifies the
        // client about the progress; the client has to poll `goal/get`.
        setTimeout(() => {
          goal.status = scenario.goalFinalStatus || 'complete'
          goal.statusReason = 'complete(verifier_met)'
          goal.tokensUsed = 36600
          goal.turnsUsed = 1
        }, 200)
      }
      return
    }
    case 'mcode/session/goal/patch': {
      if (!goal) {
        fail(frame.id, -32602, 'No active goal for this Session.')
        return
      }
      if (params.status) goal.status = params.status
      if (typeof params.objective === 'string') goal.objective = params.objective
      if (typeof params.tokenBudget === 'number') goal.tokenBudget = params.tokenBudget
      goal.updatedAt = Date.now()
      if (params.status === 'paused') goal.statusReason = 'paused(user_requested)'
      reply(frame.id, { goal })
      if (scenario.goalNotifications) send({
        jsonrpc: '2.0',
        method: 'mcode/session/goal_update',
        params: { sessionId: params.sessionId, goal }
      })
      return
    }
    case 'mcode/session/goal/clear': {
      goal = null
      reply(frame.id, { cleared: true })
      if (scenario.goalNotifications) send({
        jsonrpc: '2.0',
        method: 'mcode/session/goal_update',
        params: { sessionId: params.sessionId, goal: null }
      })
      return
    }
    case 'session/prompt': {
      if (pendingMode) {
        mode = pendingMode
        pendingMode = undefined
        update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode })
      }
      const text = contentText(params.prompt)
      if (text === 'fail-turn') {
        setTimeout(() => fail(frame.id, -32603, 'fixture turn failed'), 100)
        return
      }
      // Record the permission mode that is actually in force for this turn.
      append({ kind: 'effective-permission', value: permissionMode })
      if (text === 'wait') {
        pendingPrompt = { id: frame.id, sessionId: params.sessionId }
        return
      }
      if (text === 'steer') {
        pendingSteer = { id: frame.id, promptId: frame.id, sessionId: params.sessionId }
        update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Working' } })
        return
      }
      if (text === 'permission') {
        pendingInteraction = {
          kind: 'permission',
          requestId: 'permission-1',
          promptId: frame.id,
          sessionId: params.sessionId
        }
        send({
          jsonrpc: '2.0',
          id: pendingInteraction.requestId,
          method: 'session/request_permission',
          params: {
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'tool-write-1', kind: 'edit', title: 'Write probe-marker.txt' },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          }
        })
        return
      }
      if (text === 'review') {
        pendingInteraction = {
          kind: 'elicitation',
          requestId: 'elicitation-1',
          promptId: frame.id,
          sessionId: params.sessionId
        }
        send({
          jsonrpc: '2.0',
          id: pendingInteraction.requestId,
          method: 'elicitation/create',
          params: {
            sessionId: params.sessionId,
            requestedSchema: {
              type: 'object',
              properties: {
                decision: { type: 'string', enum: ['accept', 'reject'], title: 'Decision' },
                notes: { type: 'string', title: 'Notes' }
              },
              required: ['decision']
            }
          }
        })
        return
      }
      if (text === 'edit') {
        update(params.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_function_write',
          title: 'write',
          name: 'write',
          kind: 'edit'
        })
        update(params.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_function_write',
          status: 'in_progress',
          rawInput: { path: '/fixture/workspace/marker.txt', content: 'hello\n' },
          content: [{ type: 'content', content: { type: 'text', text: 'hello\n' } }],
          locations: [{ path: '/fixture/workspace/marker.txt' }]
        })
        update(params.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_function_write',
          status: 'completed',
          rawOutput: { content: [{ type: 'text', text: 'Successfully wrote 6 bytes' }] }
        })
        reply(frame.id, { stopReason: 'end_turn' })
        return
      }
      const state = readState()
      const stored = state.sessions.find((session) => session.sessionId === params.sessionId)
      if (stored) {
        stored.transcript = [...(stored.transcript || []),
          { role: 'user', text },
          { role: 'thought', text: 'Inspecting' },
          { role: 'assistant', text: 'MiniMax Code reply' }
        ]
        writeState(state)
      }
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting' } })
      update(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_function_shell',
        title: 'shell',
        name: 'shell',
        kind: 'execute'
      })
      update(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_function_shell',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pwd' },
        rawOutput: { output: '/fixture' }
      })
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MiniMax Code reply' } })
      update(params.sessionId, { sessionUpdate: 'usage_update', used: 20733, size: 512000, cost: { amount: 0, currency: 'USD' } })
      update(params.sessionId, { sessionUpdate: 'session_info_update', title: '创建并读取 marker.txt 文件', updatedAt: '2026-10-19T17:12:54.512Z' })
      reply(frame.id, { stopReason: 'end_turn' })
      return
    }
    case 'session/cancel':
      if (pendingPrompt && pendingPrompt.sessionId === params.sessionId) {
        reply(pendingPrompt.id, { stopReason: 'cancelled' })
        pendingPrompt = null
      }
      if (pendingSteer && pendingSteer.sessionId === params.sessionId) {
        reply(pendingSteer.promptId, { stopReason: 'cancelled' })
        pendingSteer = null
      }
      return
    default:
      // `session/delete` is intentionally not implemented: the real runtime
      // answers -32601 for it, so UniAgent must not offer native deletion.
      if (frame.id !== undefined) fail(frame.id, -32601, `Method not found: ${String(frame.method)}`)
  }
})
