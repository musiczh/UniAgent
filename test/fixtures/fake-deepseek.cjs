const fs = require('node:fs')
const readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('0.2.1-rc.2'); process.exit(0) }
const log = frame => process.env.FAKE_DSH_LOG && fs.appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(frame) + '\n')
log({ argv: process.argv.slice(2), generation:process.env.FAKE_DSH_GENERATION })
const send = frame => { log({ outbound: frame }); console.log(JSON.stringify(frame)) }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'dsh-existing', update: value } })
const stateFile = process.env.FAKE_DSH_STATE
let saved = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : undefined
let model = saved?.model || 'deepseek-official/flash', effort = saved?.effort || '', pendingPrompt
const config = () => ({ configOptions: [
  { id: 'model', type: 'select', currentValue: model, options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [{ value: 'deepseek-official/flash', name: 'Flash' }, { value: 'deepseek-official/pro', name: 'Pro' }] }] },
  { id: 'reasoning_effort', type: 'select', currentValue: effort, options: ['', 'off', 'low', 'high', 'max'].map(value => ({ value, name: value || 'Default' })) }
] })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); log({ inbound: frame })
  const { id, method, params = {} } = frame
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }, authMethods: [], agentCapabilities: { promptCapabilities: { image: true, embeddedContext: false }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } } })
  if (method === 'session/new') return reply(id, { sessionId: 'dsh-existing', ...config() })
  if (method === 'session/resume') return reply(id, config())
  if (method === 'session/set_config_option') {
    if (params.value === 'invalid') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid model' } })
    if (params.configId === 'reasoning_effort' && params.value === process.env.FAKE_DSH_REJECT_EFFORT) return send({ jsonrpc:'2.0', id, error:{ code:-32602, message:'Rejected effort' } })
    if (params.configId === 'model') model = params.value; else effort = params.value
    return reply(id, config())
  }
  if (method === 'session/prompt') {
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ model, effort }))
    if (params.prompt[0]?.text === 'cancel-me') { pendingPrompt = id; return }
    if (params.prompt[0]?.text === 'bad-key') return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: 'INVALID_CREDENTIAL: invalid API key' } })
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thought' }, messageId: 'thought-1' })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First' }, messageId: 'message-1' })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second' }, messageId: 'message-2' })
    update({ sessionUpdate: 'tool_call', toolCallId: 'bash-1', title: 'bash', kind: 'other', status: 'pending', rawInput: { command: 'pwd' } })
    pendingPrompt = id
    return send({ jsonrpc: '2.0', id: 'approval-1', method: 'session/request_permission', params: { sessionId: 'dsh-existing', toolCall: { toolCallId: 'bash-1' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } })
  }
  if (id === 'approval-1' && frame.result) {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'bash-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/work' } }] })
    update({ sessionUpdate: 'usage_update', used: 128, size: 1000000 })
    return reply(pendingPrompt, { stopReason: 'end_turn' })
  }
  if (method === 'session/cancel') return reply(pendingPrompt, { stopReason: 'cancelled' })
  if (method === 'session/close') return reply(id, {})
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported ' + method } })
})
