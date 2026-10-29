#!/usr/bin/env node
'use strict'
const { appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const log = value => appendFileSync(process.env.FAKE_DEEPSEEK_EXT_LOG, JSON.stringify(value) + '\n')
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => send({ id, result })
const nativeId = 'native-extension-session'
const usage = { uncachedInputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 7 }
let mode = 'default'
let seq = 0
let goal = null
let cancelled = false
let heldPrompt
const view = () => ({ goal, autonomous: goal?.phase === 'active' && goal.activation === 'armed',
  continuation: 'native', limit: { kind: 'rounds', maxRounds: goal?.maxGoalRounds, roundsStarted: goal?.roundsStarted }, usage })
const goalNotice = (extra = {}) => send({ method: '_uniagent/session_update', params: { sessionId: nativeId, kind: 'goal', ...view(), ...extra } })
const native = (type, data) => send({ method: '_uniagent/session_update', params: { sessionId: nativeId, kind: 'event', event: { type, data, seq: ++seq, time: Date.now() } } })
const text = value => send({ method: 'session/update', params: { sessionId: nativeId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value }, _meta: { messageId: 'native-message' } } } })
const session = () => ({ sessionId: nativeId, modes: { currentModeId: mode,
  availableModes: ['default', 'plan'].map(id => ({ id, name: id })) }, configOptions: [],
  models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture' }] } })
const finishGoal = () => {
  goal = { ...goal, phase: 'complete', activation: 'disarmed', updatedAt: Date.now(), revision: goal.revision + 1 }
  send({ method: '_uniagent/session_update', params: { sessionId: nativeId, kind: 'goal_turn', state: 'success', round: 1, ...view() } })
}
const permission = () => send({ id: 'uniagent:permission', method: 'session/request_permission', params: { sessionId: nativeId,
  toolCall: { toolCallId: 'native-tool', title: 'Read fixture', kind: 'read' },
  _meta: { childSessionId: 'native-child' }, options: [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
  ] } })
const question = () => send({ id: 'uniagent:question', method: '_uniagent/ask_user_question', params: { sessionId: nativeId,
  questions: [{ id: 'direction', question: 'Choose a direction', options: [{ label: 'Approve' }, { label: 'Reject' }] },
    { id: 'details', question: 'Provide details' }] } })
log({ kind: 'started', argv: process.argv.slice(2) })
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  log({ kind: 'inbound', frame })
  const { id, method, params = {} } = frame
  if (!method) {
    if (id === 'uniagent:permission') question()
    else if (id === 'uniagent:question') { text('Native answer'); finishGoal() }
    return
  }
  if (method === 'initialize') return reply(id, { protocolVersion: 1, _meta: { 'uniagent/bridge': { version: 1 } },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {}, delete: {} } } })
  if (method === 'session/new' || method === 'session/resume') return reply(id, session())
  if (method === '_uniagent/capabilities') return reply(id, { version: 1, flags: { nativeGoal: true, tokenBudget: false,
    pluginManagement: true, history: true, inventory: true, subagents: true, questions: true,
    steer: true, commands: true, planMode: true, usage: true, sessionFork: true, sessionForkAtTurn: true },
    commands: [{ name: 'compact' }, { name: 'plan' }] })
  if (method === '_uniagent/set_mode') { mode = params.mode; return reply(id, { mode }) }
  if (method === '_uniagent/goal_get') {
    if (process.env.FAKE_DEEPSEEK_EXT_RACE === 'get') {
      const stale = { ...view(), goal: { id: 'fixture-goal', revision: 1, objective: 'stale get', phase: 'active',
        activation: 'armed', roundsStarted: 0, createdAt: 1, updatedAt: 1 } }
      goal = { ...stale.goal, objective: 'newest get', phase: 'paused', activation: 'disarmed', revision: 2 }
      goalNotice()
      return reply(id, stale)
    }
    return reply(id, view())
  }
  if (method === '_uniagent/goal_set') {
    goal = { id: 'fixture-goal', revision: 1, objective: params.objective, phase: 'active', activation: 'armed',
      maxGoalRounds: params.maxRounds, roundsStarted: 1, createdAt: Date.now(), updatedAt: Date.now() }
    const stale = view()
    if (params.objective === 'race set') {
      goal = { ...goal, objective: 'newest set', phase: 'paused', activation: 'disarmed', revision: 2 }
      goalNotice()
      return reply(id, stale)
    }
    reply(id, view())
    if (params.objective === 'hold between rounds') return
    setImmediate(() => {
      if (cancelled) return
      send({ method: '_uniagent/session_update', params: { sessionId: nativeId, kind: 'goal_turn', state: 'running', round: 1, ...view() } })
      permission()
    })
    return
  }
  if (method === '_uniagent/goal_update') {
    const stale = view()
    if (params.action === 'edit') goal = { ...goal, objective: params.objective || goal.objective, maxGoalRounds: params.maxRounds || goal.maxGoalRounds }
    else if (params.action === 'resume') goal = { ...goal, phase: 'active', activation: 'armed' }
    else if (params.action === 'pause') goal = { ...goal, phase: 'paused', activation: 'disarmed' }
    else if (params.action === 'disarm') { cancelled = true; goal = { ...goal, activation: 'disarmed' } }
    else if (params.action === 'clear') goal = null
    if (params.objective === 'race update') {
      goal = { ...goal, objective: 'newest update', phase: 'paused', activation: 'disarmed' }
      goalNotice()
      return reply(id, stale)
    }
    goalNotice()
    return reply(id, view())
  }
  if (method === '_uniagent/fixture_fail') {
    if (params.kind === 'disconnect') process.exit(0)
    else process.stdout.write('invalid acp frame\n')
    return
  }
  if (method === '_uniagent/fixture_release') { if (heldPrompt !== undefined) reply(heldPrompt, {stopReason:'end_turn'}); heldPrompt = undefined; return }
  if (method === '_uniagent/command') {
    if (params.line === '/native-plan') { mode = 'plan'; native('plan/mode', { active: true }) }
    return reply(id, { result: { kind: 'success', text: 'command complete' } })
  }
  if (method === 'session/prompt') {
    if (params.prompt?.some(block=>block.text==='hold ordinary turn')) { heldPrompt = id; return }
    text('ordinary answer')
    native('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'native provider failure' } } })
    return reply(id, { stopReason: 'end_turn' })
  }
  if (method === 'session/cancel') return
  if (method === 'session/close') return reply(id, {})
  reply(id, {})
})
