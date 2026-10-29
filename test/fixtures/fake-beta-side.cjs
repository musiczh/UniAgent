#!/usr/bin/env node
'use strict'
const assert = require('node:assert/strict')
const { appendFileSync, readFileSync, writeFileSync, renameSync } = require('node:fs')
const { createInterface } = require('node:readline')
const provider = process.env.FAKE_BETA_PROVIDER
const log = value => appendFileSync(process.env.FAKE_BETA_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n')
const state = () => JSON.parse(readFileSync(process.env.FAKE_BETA_STATE, 'utf8'))
const save = value => {
  const temporary = `${process.env.FAKE_BETA_STATE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, process.env.FAKE_BETA_STATE)
}
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => send({ id, result })
log({ kind: 'started', argv: process.argv.slice(2), owner: process.env.FAKE_BETA_OWNER })
if (process.argv[2] === 'sessions') {
  const data = state(); delete data.sessions[process.argv[4]]; save(data); process.exit(0)
}
let mode = provider === 'grok' ? 'build' : 'default'
let model = 'audit-local'
const options = () => [
  { id: 'model', category: 'model', type: 'select', currentValue: model, options: ['audit-local','audit-other'].map(value => ({ value, name: value })) },
  { id: provider === 'kimi' ? 'thinking' : 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }
]
const session = sessionId => ({ sessionId, configOptions: options(), modes: { currentModeId: mode, availableModes: ['default','build','plan','auto','yolo'].map(id => ({ id, name:id })) }, models: { currentModelId: model, availableModels: [{ modelId:model, name:model }] } })
const update = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
let pending
let requestId = 9000
const finish = stopReason => {
  if (!pending) return
  const current = pending; pending = undefined
  update(current.sessionId, `answer:${current.text}`)
  reply(current.id, { stopReason })
}
process.once('SIGTERM', () => { log({ kind:'closed' }); process.exit(0) })
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  const { id, method, params } = frame
  log({ kind:'request', method, params, ...(method ? {} : { result:frame.result }) })
  if (!method) { if (pending?.approvalId === id) finish('end_turn'); return }
  if (method === 'initialize') return reply(id, { protocolVersion:1, agentCapabilities: { loadSession:true, promptCapabilities:{ image:true, embeddedContext:true }, sessionCapabilities:{ fork:{}, resume:{}, close:{}, delete:{} } }, ...(provider === 'deepseek' ? { _meta:{ 'uniagent/bridge':{version:1} } } : provider === 'grok' ? { _meta:{ agentVersion:'1.0.50' } } : {}) })
  if (['session/fork','_x.ai/session/fork','_uniagent/fork'].includes(method)) {
    const source = params.sessionId || params.sourceSessionId
    const data = state(); assert.ok(data.sessions[source], 'source exists')
    const nativeId = `fork-${++data.serial}`
    data.sessions[nativeId] = [...data.sessions[source]]; save(data)
    if (process.env.FAKE_BETA_FORK_DELAY) return setTimeout(() => reply(id, provider === 'grok' ? { newSessionId:nativeId } : session(nativeId)), Number(process.env.FAKE_BETA_FORK_DELAY))
    return reply(id, provider === 'grok' ? { newSessionId:nativeId } : session(nativeId))
  }
  if (method === 'session/close') return reply(id,{})
  if (method === 'session/delete') { const data=state(); delete data.sessions[params.sessionId]; save(data); return reply(id,{}) }
  if (method === 'session/resume') {
    assert.ok(state().sessions[params.sessionId], 'resume existing independent fork')
    send({ method:'session/update', params:{ sessionId:params.sessionId, update:{ sessionUpdate:'available_commands_update', availableCommands:[{ name:'compact', description:'Compact' }] } } })
    return reply(id, session(params.sessionId))
  }
  if (method === '_uniagent/capabilities') return reply(id,{ version:1, flags:{ planMode:true, commands:true, compaction:true, steer:true }, commands:[{ name:'compact' }] })
  if (method === 'session/set_config_option') { if (params.configId==='model') model=params.value; return reply(id, session(params.sessionId)) }
  if (method === 'session/set_mode' || method === '_uniagent/set_mode') { mode=params.modeId||params.mode; return reply(id,{ mode }) }
  if (method === '_uniagent/steer' || method === '_x.ai/interject') { assert.ok(pending); const data=state(); data.sessions[params.sessionId].push(params.text || params.prompt.filter(block=>block.type==='text').map(block=>block.text).join('\n')); save(data); return reply(id,method === '_x.ai/interject'?{result:{status:'queued'}}:{accepted:true}) }
  if (method === 'session/cancel') { finish('cancelled'); return }
  if (method === 'session/prompt' || method === '_uniagent/command') {
    const text = params.line || params.prompt.filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const data = state(); assert.notEqual(params.sessionId, 'source'); data.sessions[params.sessionId].push(text); save(data)
    if (method === '_uniagent/command') return reply(id,{result:{kind:'success',text:'compacted'}})
    pending={id,sessionId:params.sessionId,text}
    if (text==='hold') return
    if (text==='approval') { pending.approvalId=++requestId; send({ id:requestId, method:'session/request_permission', params:{sessionId:params.sessionId, toolCall:{toolCallId:'permission',title:'Write'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}}); return }
    finish('end_turn'); return
  }
  reply(id,{})
})
