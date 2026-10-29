#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const readline = require('node:readline')

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('2.0.2\n')
  process.exit(0)
}

const logPath = process.env.FAKE_KIMI_LOG
const log = (value) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\n')
}
log({ kind: 'argv', argv })

let model = 'kimi-k2'
let thinking = 'medium'
let mode = 'default'
let authRequired = false
const sessionId = 'kimi-existing'

const configOptions = () => [
  {
    type: 'select', id: 'model', name: 'Model', currentValue: model,
    options: [
      { value: 'kimi-k2', name: 'Kimi K2' },
      { value: 'kimi-k2-turbo', name: 'Kimi K2 Turbo' }
    ]
  },
  {
    type: 'select', id: 'thinking', name: 'Thinking', currentValue: thinking,
    options: [
      { value: 'off', name: 'Off' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' }
    ]
  },
  {
    type: 'select', id: 'mode', name: 'Mode', currentValue: mode,
    options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value }))
  }
]

const modes = () => ({
  currentModeId: mode,
  availableModes: ['default', 'plan', 'auto', 'yolo'].map((id) => ({ id, name: id }))
})

const send = (frame) => {
  log({ kind: 'outbound', frame })
  process.stdout.write(JSON.stringify(frame) + '\n')
}
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const notify = (id, update) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: id, update }
})

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const frame = JSON.parse(line)
  log({ kind: 'inbound', frame })
  const { id, method, params = {} } = frame

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: {
          list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {}
        },
        mcpCapabilities: { http: true, sse: true }
      }
    })
    return
  }

  if (method === 'session/new') {
    notify(sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact' }, { name: 'usage' }]
    })
    respond(id, { sessionId, configOptions: configOptions(), modes: modes() })
    return
  }

  if (method === 'session/resume') {
    notify(params.sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact' }, { name: 'usage' }]
    })
    // Kimi 2.0.2 intentionally omits sessionId from resume responses.
    respond(id, { configOptions: configOptions(), modes: modes() })
    return
  }

  if (method === 'session/set_config_option') {
    if (params.configId === 'model') model = params.value
    if (params.configId === 'thinking') thinking = params.value
    respond(id, { configOptions: configOptions() })
    notify(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions() })
    return
  }

  if (method === 'session/set_mode') {
    mode = params.modeId
    respond(id, {})
    notify(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode })
    return
  }

  if (method === 'session/prompt') {
    if (params.prompt?.some((block) => block?.text === 'quota-failure')) {
      send({ jsonrpc: '2.0', id, error: {
        code: -32000,
        message: "Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."
      } })
      return
    }
    if (params.prompt?.some((block) => block?.text === 'quota-data-failure')) {
      send({ jsonrpc: '2.0', id, error: {
        code: -32000, message: 'Authentication required', data: 'quota_exceeded'
      } })
      return
    }
    if (params.prompt?.some((block) => block?.text?.includes('auth-failure'))) {
      authRequired = true
      send({ jsonrpc:'2.0', id, error:{ code:-32000, message:'Authentication required' } })
      return
    }
    notify(params.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Kimi thinking' }
    })
    notify(params.sessionId, { sessionUpdate: 'usage_update', used: 64, size: 262144 })
    notify(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Kimi reply' }
    })
    respond(id, { stopReason: 'end_turn' })
    return
  }

  if (method === 'authenticate') {
    if (authRequired) send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } })
    else respond(id, {})
    return
  }

  if (method === 'session/list') {
    respond(id, { sessions: [{ sessionId, title: 'Kimi fixture', cwd: process.cwd(), updatedAt: 1 }] })
    return
  }

  if (method === 'session/load') {
    notify(params.sessionId, {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Loaded question' }
    })
    notify(params.sessionId, {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Loaded thought' }
    })
    notify(params.sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Loaded answer' }
    })
    // Kimi 2.0.2 also omits sessionId from load responses.
    respond(id, { configOptions: configOptions(), modes: modes() })
    return
  }

  if (method === 'session/delete' || method === 'session/close') {
    respond(id, {})
    return
  }

  if (method === 'session/cancel') return
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } })
})
