#!/usr/bin/env node

// Deterministic Grok ACP fixture. Stdout is reserved for JSON-RPC while all
// invocation and frame observability is written to the caller-owned JSONL log.
const { appendFileSync, readFileSync, writeFileSync, renameSync } = require('node:fs')
const { createInterface } = require('node:readline')

const rawArgv = process.argv.slice(2)
const argv = rawArgv.filter(arg => arg !== '--no-auto-update')
const logPath = process.env.FAKE_GROK_LOG
const statePath = process.env.FAKE_GROK_STATE
const scenario = (() => {
  try {
    return JSON.parse(process.env.FAKE_GROK_SCENARIO || '{}')
  } catch {
    return {}
  }
})()

function append(record) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...record }) + '\n', 'utf8')
}

function readState() {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    return { sessions: Array.isArray(value.sessions) ? value.sessions : [] }
  } catch {
    return { sessions: [] }
  }
}

function writeState(value) {
  if (statePath) {
    const temporary = statePath + '.' + process.pid + '.tmp'
    writeFileSync(temporary, JSON.stringify(value), 'utf8')
    renameSync(temporary, statePath)
  }
}

append({ kind: 'argv', argv: rawArgv, grokHome: process.env.GROK_HOME })

if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(scenario.native ? 'grok 1.0.62 (1474f9cbdd91)\n' : 'grok 1.0.13 (5e9a58528b76)\n')
  process.exit(0)
}

if (argv[0] === 'update' && argv[1] === '--check' && argv[2] === '--json') {
  process.stdout.write(JSON.stringify({ current: '1.0.13', latest: '1.0.13', channel: 'stable', updateAvailable: false }) + '\n')
  process.exit(0)
}

const inventorySecret = scenario.inventorySecret || 'GROK_INVENTORY_SENTINEL'
const inventoryCommands = {
  'inspect --json': {
    grokVersion: '1.0.13',
    channel: 'stable',
    cwd: '/fixture/workspace',
    projectRoot: '/fixture/workspace',
    projectTrusted: true,
    projectInstructions: [{
      path: '/fixture/workspace/AGENTS.md', scope: 'project', fileType: 'AGENTS.md',
      sizeBytes: 120, approxTokens: 30, vendor: 'grok', compatibilityStatus: 'native',
      env: { API_TOKEN: inventorySecret }
    }],
    permissions: { nested: { authorization: `Bearer ${inventorySecret}` } },
    loginPolicy: { password: inventorySecret },
    hooks: [{
      event: 'PreToolUse', hookType: 'command', target: 'check.sh',
      source: { type: 'project', path: '/fixture/workspace/.grok/hooks.json' },
      matcher: '*', vendor: 'grok', compatibilityStatus: 'native',
      headers: { Authorization: `Bearer ${inventorySecret}` }
    }],
    skills: [{
      name: 'review-code', description: 'Review repository changes',
      source: { type: 'user', path: '/fixture/.grok/skills/review-code' }, userInvocable: true,
      credential: inventorySecret
    }],
    agents: [{ name: 'researcher', description: 'Research agent', source: { type: 'user', token: inventorySecret } }],
    plugins: [{
      name: 'fixture-plugin', scope: 'user', path: '/fixture/.grok/plugins/fixture-plugin', enabled: true,
      provides: { skills: 1, agents: 1, hooks: 1, mcpServers: 1 }, secret: inventorySecret
    }],
    marketplaces: [],
    mcpServers: [{
      name: 'fixture-mcp', transport: 'stdio', target: 'node server.js',
      source: { type: 'project', path: '/fixture/workspace/.grok/settings.json' },
      compatibilityStatus: 'native', vendor: 'grok',
      env: { ACCESS_KEY: inventorySecret }, headers: { authorization: inventorySecret }
    }],
    lspServers: [],
    configSources: { layers: [{ type: 'project', path: '/fixture/workspace/.grok/settings.json', token: inventorySecret }] },
    externalCompat: { cells: [{ key: inventorySecret }] }
  },
  'mcp list --json': [],
  'plugin list --json': []
}
const inventoryKey = argv.join(' ')
if (Object.prototype.hasOwnProperty.call(inventoryCommands, inventoryKey)) {
  if (scenario.inventoryMalformed === inventoryKey) process.stdout.write(`{malformed-${inventorySecret}`)
  else process.stdout.write(JSON.stringify(inventoryCommands[inventoryKey]) + '\n')
  process.exit(0)
}

if (argv[0] === 'sessions' && argv[1] === 'delete' && typeof argv[2] === 'string') {
  if (scenario.deleteFails === true) {
    process.stderr.write('fixture Grok deletion failed\n')
    process.exit(23)
  }
  const state = readState()
  if (!scenario.deleteNoop) state.sessions = state.sessions.filter((session) => session.sessionId !== argv[2])
  writeState(state)
  process.exit(0)
}

const expectedPrefix = ['agent', '--no-leader']
const isAgent = expectedPrefix.every((value, index) => argv[index] === value) && argv.at(-1) === 'stdio'
if (!isAgent) {
  process.stderr.write(`unsupported fake Grok invocation: ${JSON.stringify(argv)}\n`)
  process.exit(2)
}
if (!logPath || !statePath) {
  process.stderr.write('FAKE_GROK_LOG and FAKE_GROK_STATE are required\n')
  process.exit(2)
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

function update(sessionId, value, meta) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: value, ...(meta ? { _meta: meta } : {}) }
  })
}

function initializeResult() {
  return {
    protocolVersion: 1,
    ...(scenario.native ? {agentInfo:{name:'Grok',version:'1.0.62'}} : {}),
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} }
    }
  }
}

function sessionResult(sessionId) {
  if (scenario.native) return {sessionId,configOptions:[{id:'model',category:'model',type:'select',currentValue:'grok-4.7',options:[{value:'grok-4.7',name:'Grok 4.7'},{value:'grok-4.6',name:'Grok 4.6'}]}]}
  return {
    sessionId,
    configOptions: [{ id:'model', category:'model', type:'select', name:'Model', currentValue:'grok-4.6', options:[{value:'grok-4.6',name:'Grok 4.6'}] }],
    models: {
      currentModelId: 'grok-4.6',
      availableModels: [{
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
        // Verified against Grok 1.0.34: efforts are {id, value, label, default}
        // objects and the context window moved to totalContextTokens.
        _meta: {
          totalContextTokens: 500000,
          supportsReasoningEffort: true,
          reasoningEffort: 'high',
          reasoningEfforts: [
            { id: 'xhigh', value: 'xhigh', label: 'Extra High', default: false },
            { id: 'high', value: 'high', label: 'High', default: true },
            { id: 'medium', value: 'medium', label: 'Medium', default: false },
            { id: 'low', value: 'low', label: 'Low', default: false }
          ]
        }
      }]
    },
    modes: {
      currentModeId: 'build',
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' }
      ]
    }
  }
}

function publishCommands(sessionId) {
  update(sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      ...(scenario.native && process.env.GROK_GOAL !== '0' ? [{name:'goal'}] : []),
      { name: 'compact', description: 'Compact the current context' },
      { name: 'review', description: 'Review current changes' }
    ]
  })
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
let goal = scenario.initialGoal ? {goal_id:'restored-goal',objective:'Restored active goal',status:'active',token_budget:10000,tokens_used:0,elapsed_ms:0} : undefined
const usage = {inputTokens:100,outputTokens:20,totalTokens:120,cachedReadTokens:30,cacheCreationTokens:0,reasoningTokens:7,modelCalls:1}
function native(sessionId,value) { send({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId,update:value}}) }
function subagent(sessionId,type,value) {
  if(scenario.native) native(sessionId,{sessionUpdate:type,...value})
  else send({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId,type,...value}})
}
function goalUpdate(sessionId,status) {
  if(status === 'cleared') {goal=undefined;native(sessionId,{sessionUpdate:'goal_updated',status:'cleared'});return}
  goal={...goal,status,last_event:status === 'active'?'goal_created':'goal_paused',last_event_timestamp:new Date().toISOString()}
  native(sessionId,{sessionUpdate:'goal_updated',...goal,...(scenario.plannerPermission ? {planning:true} : {})})
}

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
    if(scenario.native && interaction.kind === 'question') {
      const value=frame.result
      const valid=value?.outcome === 'cancelled' || value?.outcome === 'accepted' && Array.isArray(value.answers?.['Which scope?']) && value.answers['Which scope?'].every(answer=>typeof answer==='string')
      update(interaction.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'ask-1',kind:'other',title:'ask_user_question',status:valid?'completed':'failed',rawOutput:valid?'Answer accepted':'missing field outcome'})
    }
    if(scenario.native && interaction.kind === 'planner') return
    update(interaction.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: interaction.kind === 'permission' ? 'Permission resolved' : 'Question resolved' }
    })
    reply(interaction.promptId, { stopReason: 'end_turn' })
    return
  }
  const params = frame.params && typeof frame.params === 'object' ? frame.params : {}
  switch (frame.method) {
    case '_x.ai/session/state':
      if(!scenario.native) break
      if(scenario.malformedState){reply(frame.id,{});return}
      reply(frame.id,{summary:{updated_at:new Date().toISOString()},
        ...(scenario.contextSignals?{signals:{
          contextTokensUsed:scenario.contextSignals.contextTokensUsed,
          contextWindowTokens:scenario.contextSignals.contextWindowTokens,
          contextWindowUsage:scenario.contextSignals.contextWindowTokens
            ? Math.round(scenario.contextSignals.contextTokensUsed / scenario.contextSignals.contextWindowTokens * 100) : 0
        }}:{}),
        ...(goal?{goal:{...goal,created_at:new Date().toISOString(),tokens_used_high_water:0}}:{})});return
    case '_x.ai/session/fork': {
      if(!scenario.native) break
      const state=readState(),source=state.sessions.find(s=>s.sessionId===params.sourceSessionId)
      if(!source || params.sourceCwd !== source.cwd){fail(frame.id,-32004,'FS_NOT_FOUND');return}
      const newSessionId='grok-fork-'+require('node:crypto').randomUUID()
      state.sessions.push({...source,sessionId:newSessionId,cwd:params.newCwd});writeState(state)
      reply(frame.id,{newSessionId,parentSessionId:source.sessionId,newCwd:params.newCwd,chatMessagesCopied:0,updatesCopied:0,planStateCopied:false});return
    }
    case '_x.ai/interject':
      if(!scenario.native) break
      if(scenario.steerUnsupported){fail(frame.id,-32601,'Method not found');return}
      if(scenario.steerNoAck)return
      if(scenario.steerEndsFirst && pendingPrompt){reply(pendingPrompt.id,{stopReason:'end_turn'});pendingPrompt=null}
      setTimeout(()=>reply(frame.id,{result:{status:'queued'}}),scenario.steerEndsFirst?25:0);return
    case '_x.ai/subagent/cancel':
      if(!scenario.native) break
      if(scenario.cancelUnsupported){fail(frame.id,-32601,'Method not found');return}
      reply(frame.id,{result:{subagentId:params.subagentId,cancelled:params.subagentId==='agent-child'}});return
    case 'initialize':
      reply(frame.id, initializeResult())
      return
    case 'session/new': {
      if (scenario.serviceUnavailable) { fail(frame.id, -32000, 'Service unavailable'); return }
      if (scenario.authenticationRequired === true) {
        fail(frame.id, -32000, 'Authentication required')
        return
      }
      const state = readState()
      const sessionId = `grok-session-${state.sessions.length + 1}`
      state.sessions.push({
        sessionId,
        cwd: params.cwd,
        title: 'Fake Grok session',
        updatedAt: '2026-09-04T12:00:00.000Z',
        transcript: []
      })
      writeState(state)
      reply(frame.id, sessionResult(sessionId))
      publishCommands(sessionId)
      return
    }
    case 'session/list': {
      const rows=readState().sessions,start=Number(params.cursor)||0,size=scenario.pageSize||rows.length||1
      reply(frame.id, { sessions: rows.slice(start,start+size), nextCursor:start+size<rows.length ? String(start+size) : null })
      return
    }
    case 'session/load': {
      if(scenario.forkLoadFails && params.sessionId.startsWith('grok-fork-')){fail(frame.id,-32004,'fork load failed');return}
      const session = findSession(params.sessionId)
      if (!session) {
        fail(frame.id, -32004, 'FS_NOT_FOUND')
        return
      }
      for (const entry of session.transcript || []) {
        update(params.sessionId, {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' :
            entry.role === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text }
        })
      }
      for (const notification of session.notifications || []) {
        send({ jsonrpc: '2.0', ...notification })
      }
      reply(frame.id, sessionResult(params.sessionId))
      publishCommands(params.sessionId)
      return
    }
    case 'session/resume':
      if (!findSession(params.sessionId)) {
        fail(frame.id, -32004, 'FS_NOT_FOUND')
        return
      }
      reply(frame.id, sessionResult(params.sessionId))
      publishCommands(params.sessionId)
      return
    case 'session/close':
      reply(frame.id, {})
      return
    case 'session/set_config_option': {
      if (!scenario.native) break
      const result=sessionResult(params.sessionId)
      const option=result.configOptions.find(option=>option.id===params.configId)
      if (!option || !option.options.some(value=>value.value===params.value)) {fail(frame.id,-32602,'Invalid config option');return}
      option.currentValue=params.value
      reply(frame.id,{configOptions:result.configOptions})
      update(params.sessionId,{sessionUpdate:'config_option_update',configOptions:result.configOptions})
      return
    }
    case 'session/set_mode':
      reply(frame.id, {})
      update(params.sessionId, {
        sessionUpdate: 'current_mode_update',
        currentModeId: params.modeId
      })
      return
    case 'session/prompt': {
      const text = contentText(params.prompt)
      if(scenario.native && text.startsWith('/goal ')) {
        const objective=text.slice(6)
        if(['pause','resume','clear'].includes(objective)){goalUpdate(params.sessionId,objective==='pause'?'user_paused':objective==='resume'?'active':'cleared');reply(frame.id,{stopReason:'end_turn'});return}
        goal={goal_id:'goal-'+frame.id,objective:objective.replace(/ --budget \d+$/,''),status:'active',token_budget:10000,tokens_used:0,elapsed_ms:0}
        pendingPrompt={id:frame.id,sessionId:params.sessionId};goalUpdate(params.sessionId,'active')
        if(scenario.goalDisconnect){setTimeout(()=>process.exit(25),10);return}
        if(scenario.plannerPermission){pendingInteraction={kind:'planner',requestId:0,promptId:frame.id,sessionId:params.sessionId};send({jsonrpc:'2.0',id:0,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{toolCallId:'planner-write',kind:'edit'},options:[{optionId:'allow_once',kind:'allow_once',name:'Allow'}]}})}
        else send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Goal business round'}},_meta:{promptId:'goal-parent-'+frame.id}}})
        return
      }
      if (text === 'wait') {
        pendingPrompt = { id: frame.id, sessionId: params.sessionId }
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
            toolCall: { toolCallId: 'tool-edit-1', kind: 'edit', title: 'Write fixture.txt' },
            options: [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
            ]
          }
        })
        return
      }
      if (text === 'question') {
        if (scenario.childQuestion) subagent(params.sessionId,'subagent_spawned',{subagent_id:'agent-child',child_session_id:'session-child',parent_session_id:params.sessionId,description:'Child question'})
        pendingInteraction = {
          kind: 'question',
          requestId: scenario.native ? 0 : 'question-1',
          promptId: frame.id,
          sessionId: params.sessionId
        }
        send({
          jsonrpc: '2.0',
          id: pendingInteraction.requestId,
          method: '_x.ai/ask_user_question',
          params: {
            sessionId: scenario.questionForeign ? 'unowned-child' : scenario.childQuestion ? 'session-child' : params.sessionId,
            toolCallId: 'ask-1',
            mode: scenario.native ? scenario.questionMode || 'default' : 'blocking',
            questions: [{
              ...(scenario.native ? {} : {id:'scope'}),
              header: 'Scope',
              question: 'Which scope?',
              options: [
                { value: 'workspace', label: 'Workspace' },
                { value: 'all', label: scenario.duplicateLabels ? 'Workspace' : 'All files' }
              ]
            }]
          }
        })
        return
      }
      if (text === 'subagent') {
        const common = {
          subagent_id: 'agent-child',
          child_session_id: 'session-child',
          parent_session_id: params.sessionId,
          parent_prompt_id: `prompt-${frame.id}`,
          description: 'Inspect history'
        }
        subagent(params.sessionId,'subagent_spawned',common)
        update('session-child', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Child inspecting' }
        })
        if(scenario.native && scenario.childRunning){pendingPrompt={id:frame.id,sessionId:params.sessionId};return}
        subagent(params.sessionId,'subagent_progress',{status:'running',...common})
        update('session-child', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Child result' }
        })
        subagent(params.sessionId,'subagent_finished',{
            status: 'completed',
            output: 'Child result',
            tokens: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            ...common
        })
        reply(frame.id, {
          stopReason: 'end_turn',
          _meta: { promptId: `prompt-${frame.id}`, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }
        })
        return
      }
      if (text === 'edit') {
        update(params.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'grok-edit-1',
          title: 'Edit fixture.txt'
        })
        update(params.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'grok-edit-1',
          kind: 'edit',
          status: 'completed',
          content: [{
            type: 'diff',
            path: '/fixture/workspace/fixture.txt',
            oldText: 'before\n',
            newText: 'after\n'
          }]
        })
        reply(frame.id, { stopReason: 'end_turn' })
        return
      }
      if (text === '/compact') {
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session_notification',
          params: {
            sessionId: params.sessionId,
            type: 'auto_compact_completed',
            tokens_before: 120000,
            tokens_after: 18000,
            summary_preview: 'Retained the current implementation plan.'
          }
        })
        reply(frame.id, { stopReason: 'end_turn' })
        return
      }
      if (scenario.foreignResponses === true) {
        // Grok 1.0.34 leaks internal skills-bus responses onto the ACP stream.
        send({ jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 1 } } })
        send({ jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 1 } } })
      }
      if (scenario.unknownNumericResponse === true) {
        send({ jsonrpc: '2.0', id: 424242, result: { leaked: true } })
      }
      const state = readState()
      const stored = state.sessions.find((session) => session.sessionId === params.sessionId)
      if (stored) {
        stored.transcript = [...(stored.transcript || []),
          { role: 'user', text },
          { role: 'thought', text: 'Inspecting' },
          { role: 'assistant', text: 'Grok reply' }
        ]
        writeState(state)
      }
      update(params.sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting' }
      }, scenario.contextTicks ? { totalTokens: scenario.contextTicks[0] } : undefined)
      if(scenario.native){
        const promptId='prompt-'+frame.id
        if(scenario.contextTicks) update(params.sessionId, {
          sessionUpdate: 'tool_call', toolCallId: 'context-tick', title: 'Context tick', kind: 'read'
        }, { totalTokens: scenario.contextTicks[1] })
        if(scenario.imageDropped)native(params.sessionId,{sessionUpdate:'image_dropped',notes:['Image was dropped before send']})
        native(params.sessionId,{sessionUpdate:'turn_completed',prompt_id:promptId,stop_reason:'end_turn',usage})
        reply(frame.id,{stopReason:'end_turn',_meta:{promptId,usage,
          ...(scenario.contextMeta?{inputTokens:scenario.contextMeta.inputTokens,outputTokens:1,totalTokens:scenario.contextMeta.inputTokens+1,
            ...(scenario.contextMeta.contextWindow?{contextWindow:scenario.contextMeta.contextWindow}:{})}:{})}});return
      }
      update(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'grok-tool-1',
        title: 'Run pwd'
      })
      update(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'grok-tool-1',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pwd' },
        rawOutput: { output: '/fixture' }
      })
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Grok reply' }
      })
      send({
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: {
          sessionId: params.sessionId,
          type: 'response_completed',
          prompt_id: `prompt-${frame.id}`,
          usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 }
        }
      })
      reply(frame.id, {
        stopReason: 'end_turn',
        _meta: {
          promptId: `prompt-${frame.id}`,
          usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 }
        }
      })
      return
    }
    case 'session/cancel':
      if(scenario.native && goal)goalUpdate(params.sessionId,'user_paused')
      send({
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: { sessionId: params.sessionId, type: 'turn_completed', stop_reason: 'cancelled' }
      })
      if (pendingPrompt && pendingPrompt.sessionId === params.sessionId) {
        reply(pendingPrompt.id, { stopReason: 'cancelled',...(scenario.native?{_meta:{promptId:'cancel-'+pendingPrompt.id,usage:{inputTokens:0,outputTokens:0,cachedReadTokens:0,usageIsIncomplete:true}}}:{}) })
        pendingPrompt = null
      }
      return
    default:
      if (frame.id !== undefined) fail(frame.id, -32601, `Method not found: ${String(frame.method)}`)
  }
  if(frame.id !== undefined && frame.method?.startsWith('_x.ai/'))fail(frame.id,-32601,'Method not found')
})
