#!/usr/bin/env node
// Upgrade fixture: accepts only stable ACP; rejects provider metadata and CLI flags.
const fs = require('node:fs')
const readline = require('node:readline')
const scenario = JSON.parse(process.env.UA_STABLE_SCENARIO || '{}')
const argv = process.argv.slice(2)
const log = frame => fs.appendFileSync(process.env.UA_STABLE_LOG, JSON.stringify(frame) + '\n')
if (argv.includes('--version')) { console.log('99.0.0'); process.exit(0) }
log({ argv })
if (argv.includes('web') || argv.includes('--model') || argv.includes('--reasoning-effort')) process.exit(2)
let model = 'new-model', mode = 'default', pendingPrompt
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const reply = (id, result) => send({ id, result })
const error = (id, message) => send({ id, error: { code: -32601, message } })
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const options = () => scenario.noOptions ? {} : { configOptions: [{ id: 'renamed-model-selector', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ value: 'new-model', name: 'New' }, { value: 'another-model', name: 'Another' }] }] }
readline.createInterface({ input: process.stdin }).on('line', line => {
 const frame = JSON.parse(line); log(frame)
 const { id, method, params = {} } = frame
 if (!method) { if (id === 'approval' && pendingPrompt) { update('stable-id', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'APPROVAL_OK' } }); reply(pendingPrompt, { stopReason: 'end_turn' }); pendingPrompt = undefined }; return }
 if (method === 'initialize') return setTimeout(() => reply(id, { protocolVersion: 1, agentInfo: { name: 'future-cli', version: '99.0.0' }, agentCapabilities: { loadSession: !scenario.noLoad, promptCapabilities: { image: !scenario.noAttachments, embeddedContext: !scenario.noAttachments }, sessionCapabilities: { ...(scenario.noResume ? {} : { resume: {} }), list: {}, delete: {}, close: {}, fork: {} } }, _meta: { agentVersion: '99.0.0', 'uniagent/bridge': { version: 1 }, availableCommands: [{ name: 'goal' }] } }), scenario.initializeDelay || 0)
 if (method === 'session/new' || method === 'session/resume' || method === 'session/load') {
   if (params._meta) return error(id, 'Provider metadata removed in upgrade')
   if (method === 'session/resume' && scenario.noResume) return error(id, 'resume not declared')
   if (scenario.replay && method === 'session/load') update(params.sessionId, { sessionUpdate:'agent_message_chunk', content:{type:'text',text:'OLD_REPLAY'} })
   if (scenario.openingUpdates) {
     update(params.sessionId || 'stable-id', { sessionUpdate:'config_option_update', ...options() })
     update(params.sessionId || 'stable-id', { sessionUpdate:'current_mode_update', currentModeId:mode })
   }
   return reply(id, { ...(scenario.foreignId ? { sessionId:'foreign-session' } : {}), ...(method === 'session/new' ? { sessionId: 'stable-id' } : {}), ...options(), ...(scenario.noModes ? {} : { modes: { currentModeId: mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } }) })
 }
 if (method === 'session/set_config_option' && params.configId === 'renamed-model-selector') { model = params.value; return reply(id, options()) }
 if (scenario.rejectMode && method === 'session/set_mode') return error(id,'mode removed')
 if (method === 'session/set_mode' && !scenario.noModes && ['default','plan'].includes(params.modeId)) { mode = params.modeId; return reply(id, {}) }
 if (method === 'session/prompt') {
   if (params.prompt.some(x => x.text === 'report-mode')) {
     update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MODE_' + mode } })
     return reply(id, { stopReason: 'end_turn' })
   }
   if (params.prompt.some(x => x.text === 'approval')) { pendingPrompt = id; return send({ id: 'approval', method: 'session/request_permission', params: { sessionId: 'stable-id', toolCall: { toolCallId: 'tool', title: 'Run', kind: 'execute', rawInput: { command: 'pwd' } }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }] } }) }
   if (params.prompt.some(x => x.text === 'cancel')) { pendingPrompt = id; return }
   update(params.sessionId, { sessionUpdate: 'future_update', newField: true })
   update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THINK_OK' } })
   update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STABLE_OK' } })
   return reply(id, { stopReason: 'end_turn' })
 }
 if (method === 'session/cancel') { if (pendingPrompt) reply(pendingPrompt, { stopReason: 'cancelled' }); pendingPrompt = undefined; return }
 if (method === 'session/close' || method === 'session/delete') return reply(id, {})
 if (method === 'session/list') return reply(id, { sessions: [{ sessionId: 'stable-id', cwd: process.cwd(), title: 'Stable' }] })
 return error(id, 'Unstable method removed: ' + method)
})
