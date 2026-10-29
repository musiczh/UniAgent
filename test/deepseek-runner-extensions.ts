import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACPRunner } from '../src/main/acp/acpRunner.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

async function fixture(race = '') {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-extensions-'))
  const log = join(root, 'protocol.jsonl')
  const bin = join(root, 'dsh')
  const source = resolve('test/fixtures/fake-deepseek-extensions.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire(${JSON.stringify(source)})\n`)
  await chmod(bin, 0o755)
  const agent: AgentDef = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin,
    builtin: true, installed: true, icon: '', models: [], capabilities: { modelSelect: true,
      reasoningEffort: true, streaming: true, nativeGoal: true,
      permissionModes: [{ id: 'ask', label: 'Ask', hint: '' }] } }
  const runner = new ACPRunner('local-extension-session', { n: 0 }, agent,
    { agentId: 'deepseek', workdir: root, permissionMode: 'ask' }, undefined,
    { FAKE_DEEPSEEK_EXT_LOG: log, FAKE_DEEPSEEK_EXT_RACE: race })
  const events: UAEvent[] = []
  runner.on('event', event => events.push(event))
  return { runner, events,
    frames: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    cleanup: async () => { await runner.disposeAndWait(); await rm(root, { recursive: true, force: true }) } }
}

function next<T>(runner: ACPRunner, name: string, predicate: (value: T) => boolean = () => true): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { runner.off(name, onValue); reject(new Error(`Missing ${name}`)) }, 5000)
    const onValue = (value: T) => {
      if (!predicate(value)) return
      clearTimeout(timer); runner.off(name, onValue); resolveResult(value)
    }
    runner.on(name, onValue)
  })
}

// A host prompt or swallowed native lifecycle would duplicate work or leave Goal waiting forever.
async function nativeGoalAndQuestions(): Promise<void> {
  const test = await fixture()
  try {
    const probe = await test.runner.probeSession(false)
    assert.equal(probe.contract.nativeGoal, true)
    assert.equal(probe.contract.formElicitation, true)
    assert.equal(probe.contract.sessionForkAtTurn, true)
    assert.deepEqual(probe.contract.collaborationModes, ['default', 'plan'])
    const permission = next<UAEvent>(test.runner, 'event', event => event.type === 'approval_request' && event.state === 'pending' && event.payload.method === 'session/request_permission')
    const started = next<any>(test.runner, 'goalTurn', turn => turn.state === 'running')
    const goal = await test.runner.setGoal({ objective: 'native lifecycle', maxRounds: 4 })
    assert.equal(goal.roundLimit?.maxRounds, 4)
    assert.equal((await started).autonomous, true)
    const request = await permission
    assert.equal(request.payload.childSessionId, 'native-child')
    const question = next<UAEvent>(test.runner, 'event', event => event.type === 'approval_request' && event.state === 'pending' && event.payload.method === '_uniagent/ask_user_question')
    assert.deepEqual(test.runner.respondResult(request.payload.requestId, { outcome: { outcome: 'selected', optionId: 'allow' } }),
      { handled: true, hasPendingRequests: false })
    const asked = await question
    assert.equal(asked.payload.params.questions[0].allowOther, true)
    const done = next<any>(test.runner, 'done')
    assert.equal(test.runner.respondResult(asked.payload.requestId, { answers: { direction: { answers: ['Approve'] } } }).handled, false, 'ambiguous legacy answers cannot grant a native plan choice')
    test.runner.respondResult(asked.payload.requestId, { answers: [
      { id: 'direction', selected: ['Approve'], custom: 'custom direction' }, { id: 'details', selected: [], custom: 'free form details' }
    ] })
    assert.equal((await done).failed, false)
    assert.equal(test.events.findLast(event => event.type === 'agent_message')?.payload.text, 'Native answer')
    assert.equal(test.events.findLast(event => event.type === 'turn_completed')?.state, 'success')
    assert.equal((await test.runner.getGoal())?.status, 'complete')
    const usage = await test.runner.queryUsage()
    assert.equal(usage?.inputTokens, 16)
    assert.equal(usage?.outputTokens, 7)
    assert.equal(usage?.sessionInputTokens, 16)
    assert.equal(usage?.contextTokens, undefined, 'cumulative Goal usage is never current context occupancy')
    const frames = await test.frames()
    assert.equal(frames.some(row => row.frame?.method === 'session/prompt'), false)
    const reply = frames.find(row => row.frame?.id === 'uniagent:question' && row.frame?.result)
    assert.deepEqual(reply.frame.result, { answers: [
      { id: 'direction', selected: ['Approve'], custom: 'custom direction' },
      { id: 'details', selected: [], custom: 'free form details' }
    ] })
    assert.equal(test.runner.respondResult(asked.payload.requestId, {} as any).handled, false)
  } finally { await test.cleanup() }
}

// Native Plan and turn errors are authoritative even when ACP returns end_turn.
async function planAndNativeError(): Promise<void> {
  const test = await fixture()
  try {
    await test.runner.probeSession(false)
    const mode = next<string>(test.runner, 'collaborationModeChanged')
    await test.runner.startTurn('/native-plan')
    assert.equal(await mode, 'plan')
    await test.runner.startTurn('/another-command')
    const frames = await test.frames()
    assert.equal(frames.some(row => row.frame?.method === '_uniagent/set_mode' && row.frame.params.mode === 'default'), false,
      'a subsequent turn must preserve the native Plan event')
    const done = next<any>(test.runner, 'done')
    await test.runner.startTurn('native error')
    assert.equal((await done).failed, true)
    assert.equal(test.events.findLast(event => event.type === 'turn_completed')?.state, 'failed')
  } finally { await test.cleanup() }
}

// Old RPC snapshots must not re-arm Goal after a newer native notification.
async function rpcOrdering(): Promise<void> {
  const get = await fixture('get')
  try { assert.equal((await get.runner.getGoal())?.objective, 'newest get') }
  finally { await get.cleanup() }
  const test = await fixture()
  try {
    const set = await test.runner.setGoal({ objective: 'race set' })
    assert.equal(set.objective, 'newest set')
    assert.equal(set.autonomous, false)
    const updated = await test.runner.updateGoal({ action: 'edit', objective: 'race update' })
    assert.equal(updated?.objective, 'newest update')
    assert.equal(updated?.autonomous, false)
    await test.runner.setGoal({ objective: 'hold between rounds' })
    const done = next<any>(test.runner, 'done')
    test.runner.interrupt()
    await done
    assert.equal((await test.runner.getGoal())?.autonomous, false, 'interrupt disarms native Goal between rounds')
    const frames = await test.frames()
    assert.equal(frames.some(row => row.frame?.method === '_uniagent/goal_update' && row.frame.params.action === 'disarm'), true)
  } finally { await test.cleanup() }
}

async function armedLifecycleFailures(): Promise<void> {
  for (const kind of ['disconnect', 'protocol-error']) {
    const test = await fixture()
    try {
      await test.runner.setGoal({ objective: 'hold between rounds' })
      const done = next<any>(test.runner, 'done')
      ;(test.runner as any).connection.notify('_uniagent/fixture_fail', { kind })
      assert.equal((await done).failed, true, 'an armed Goal must fail when its transport disappears between rounds')
      assert.equal((test.runner as any).goalState.autonomous, false)
      assert.equal((test.runner as any).goalState.nativeActivation, 'disarmed')
    } finally { await test.cleanup() }
  }
  const test = await fixture()
  try {
    const runtimeEnv = { FAKE_DEEPSEEK_EXT_LOG: (test.runner as any).extraEnv.FAKE_DEEPSEEK_EXT_LOG, UA_RUNTIME_FINGERPRINT: 'before' }
    ;(test.runner as any).extraEnv = () => runtimeEnv
    await test.runner.setGoal({ objective: 'hold between rounds' })
    const connection = (test.runner as any).connection
    runtimeEnv.UA_RUNTIME_FINGERPRINT = 'after-plan-change'
    await test.runner.getGoal()
    assert.equal((test.runner as any).connection, connection, 'Goal controls must keep the armed native runtime after profile changes')
    assert.equal((await test.frames()).filter(row => row.kind === 'started').length, 1)
  } finally { await test.cleanup() }
}

async function nativeGoalOutputOrdering(): Promise<void> {
  const test = await fixture()
  try {
    await test.runner.setGoal({ objective: 'hold between rounds' })
    const notify = (params: any) => (test.runner as any).onNotification({ jsonrpc:'2.0',method:'_uniagent/session_update', params:{sessionId:'native-extension-session',...params} })
    const goal = {objective:'hold between rounds',phase:'active',activation:'armed',roundsStarted:2,createdAt:1,updatedAt:1}
    const standard = (round:number,text:string) => (test.runner as any).onNotification({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-extension-session',_meta:{'uniagent/nativeOutput':{turn:round,round,goalId:'fixture-goal',eventSeq:round}},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})
    const raw = (round:number,seq:number,type:string,data:any) => notify({kind:'event',goalRound:{turn:round,round,goalId:'fixture-goal'},event:{type,seq,time:Date.now(),data:{turn:round,step:1,...data}}})
    notify({kind:'goal_turn',state:'running',round:1,output:'native-events',goal,autonomous:true})
    raw(1,10,'tool/call',{callId:'native-goal-read',name:'read',arguments:'{"file_path":"fixture"}'})
    raw(1,11,'tool/result',{message:{toolCallId:'native-goal-read',content:[{type:'text',text:'complete native tool output'}],isError:false}})
    raw(1,12,'assistant/message',{message:{id:'goal-one',content:[{type:'reasoning',text:'native thought'},{type:'text',text:'native round one'}]}})
    notify({kind:'goal_turn',state:'success',round:1,output:'native-events',goal,autonomous:true})
    notify({kind:'goal_turn',state:'running',round:2,output:'native-events',goal,autonomous:true})
    standard(1,'delayed duplicate round one')
    raw(2,13,'assistant/message',{message:{id:'goal-two',content:[{type:'text',text:'native round two'}]}})
    notify({kind:'goal_turn',state:'success',round:2,output:'native-events',goal:{...goal,phase:'complete',activation:'disarmed'},autonomous:false})
    standard(2,'delayed duplicate round two')
    assert.deepEqual(test.events.filter(event=>event.type==='agent_message').map(event=>event.payload.text),['native round one','native round two'])
    assert.equal(test.events.filter(event=>event.type==='reasoning').length,1)
    const tools = test.events.filter(event=>event.type==='tool_call')
    assert.equal(tools.at(-1)?.state,'success')
    assert.equal(tools.at(-1)?.payload.output,'complete native tool output')
    assert.equal(test.events.filter(event=>event.type==='turn_completed').length,2)
    assert.ok(test.events.findIndex(event=>event.payload.nativeEventSeq===12)<test.events.findIndex(event=>event.type==='turn_completed'))
    assert.equal(test.events.find(event=>event.type==='agent_message')?.payload.turnId,'1')
    assert.equal(test.events.findLast(event=>event.type==='agent_message')?.payload.turnId,'2')
    assert.ok(test.events.every((event,index)=>event.sessionId==='local-extension-session' && (index===0 || event.seq>test.events[index-1].seq)), 'native projection keeps local session ownership and monotonic event sequence')
  } finally { await test.cleanup() }
}

async function ordinaryPromptToGoal(): Promise<void> {
  const test = await fixture()
  try {
    const started = next<UAEvent>(test.runner,'event',event=>event.type==='turn_started')
    const ordinary = test.runner.startTurn('hold ordinary turn')
    await started
    const notify = (params:any)=>(test.runner as any).onNotification({jsonrpc:'2.0',method:'_uniagent/session_update',params:{sessionId:'native-extension-session',...params}})
    notify({kind:'event',event:{type:'assistant/message',seq:20,time:Date.now(),data:{turn:1,step:1,message:{id:'ordinary-first',content:[{type:'text',text:'ordinary complete'}]}}}})
    notify({kind:'event',event:{type:'turn/end',seq:21,time:Date.now(),data:{turn:1,reason:{kind:'completed'}}}})
    const goal={objective:'automatic after ordinary',phase:'active',activation:'armed',roundsStarted:1,createdAt:1,updatedAt:1}
    notify({kind:'goal_turn',state:'running',round:1,output:'native-events',goal,autonomous:true})
    const active=(test.runner as any).activeTurn
    assert.equal((test.runner as any).nativeGoalRunning,true)
    assert.equal(test.events.filter(event=>event.type==='turn_started').length,2)
    assert.equal(test.events.filter(event=>event.type==='turn_completed').length,1)
    ;(test.runner as any).onNotification({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-extension-session',_meta:{'uniagent/nativeOutput':{turn:1,round:0,eventSeq:20}},update:{sessionUpdate:'agent_message_chunk',messageId:'ordinary-first',content:{type:'text',text:'late ordinary duplicate'}}}})
    ;(test.runner as any).connection.notify('_uniagent/fixture_release')
    await ordinary
    assert.equal((test.runner as any).activeTurn,active)
    assert.equal((test.runner as any).running,true,'late ordinary prompt response must not finish the Goal')
    notify({kind:'event',goalRound:{turn:2,round:1,goalId:'fixture'},event:{type:'assistant/message',seq:22,time:Date.now(),data:{turn:2,step:1,message:{id:'automatic-first',content:[{type:'text',text:'goal complete'}]}}}})
    notify({kind:'goal_turn',state:'success',round:1,output:'native-events',goal:{...goal,phase:'complete',activation:'disarmed'},autonomous:false})
    assert.equal((test.runner as any).running,false)
    assert.equal(test.events.filter(event=>event.type==='turn_completed').length,2)
    assert.deepEqual(test.events.filter(event=>event.type==='agent_message').map(event=>event.payload.text),['ordinary complete','goal complete'])
  } finally { await test.cleanup() }
}

// Official ACP asks with only a toolCallId after its marked stock update.
async function nativeCommandApprovalMetadata(): Promise<void> {
  const test = await fixture()
  try {
    const started = next<UAEvent>(test.runner, 'event', event => event.type === 'turn_started')
    const ordinary = test.runner.startTurn('hold ordinary turn')
    await started
    const native = (turn: number, seq: number, type: string, data: any = {}, childSessionId?: string) => (test.runner as any).onNotification({
      jsonrpc: '2.0', method: '_uniagent/session_update', params: { sessionId: 'native-extension-session', kind: 'event',
        ...(childSessionId ? { childSessionId } : {}),
        event: { type, seq, time: Date.now(), data: { turn, step: 1, ...data } } }
    })
    const stock = (turn: number, command: string) => (test.runner as any).onNotification({
      jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-extension-session',
        _meta: { 'uniagent/nativeOutput': { turn, eventSeq: 31 } },
        update: { sessionUpdate: 'tool_call', toolCallId: 'native-bash', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command } } }
    })
    const replies: any[] = []
    const connection = (test.runner as any).connection
    const respond = connection.respond.bind(connection)
    connection.respond = (id: any, result: any) => { replies.push({ id, result }); respond(id, result) }
    const options = [{ optionId: 'native-allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'native-deny', kind: 'reject_once', name: 'Deny' }]
    const permission = (id: string, childSessionId?: string) => {
      ;(test.runner as any).onRequest(connection, { jsonrpc: '2.0', id, method: 'session/request_permission', params: {
        sessionId: 'native-extension-session', toolCall: { toolCallId: 'native-bash' }, options,
        ...(childSessionId ? { _meta: { childSessionId } } : {})
      } })
      return test.events.findLast(event => event.type === 'approval_request' && event.state === 'pending')!
    }
    const args = { command: 'printf NATIVE_BASH_APPROVAL_OK', description: 'Print the native bash approval fixture', workdir: '/fixture' }
    native(41, 30, 'turn/start')
    native(41, 31, 'tool/call', { callId: 'native-bash', name: 'bash', arguments: JSON.stringify(args) })
    stock(41, args.command)
    const first = permission('approval-first')
    assert.equal(first.payload.kind, 'command', 'id-only native permission retains the command tool classification')
    assert.deepEqual(first.payload.params.rawInput, args, 'approval shows authoritative parsed native tool arguments')
    assert.deepEqual(first.payload.options, options)
    assert.equal(test.events.filter(event => event.type === 'command_exec').length, 1, 'native bash is visible once while stock ACP stays deduplicated')
    assert.equal(test.runner.respondResult(first.payload.requestId, { outcome: { outcome: 'selected', optionId: 'native-allow' } }).handled, true)
    assert.deepEqual(replies.pop(), { id: 'approval-first', result: { outcome: { outcome: 'selected', optionId: 'native-allow' } } })
    const child = permission('approval-child', 'native-child')
    assert.equal(child.payload.params.rawInput, undefined, 'a child with the same tool ID must not inherit parent command metadata')
    test.runner.respondResult(child.payload.requestId, { outcome: { outcome: 'selected', optionId: 'native-deny' } })
    ;(test.runner as any).connection.notify('_uniagent/fixture_release')
    await ordinary

    const secondStarted = next<UAEvent>(test.runner, 'event', event => event.type === 'turn_started')
    const secondTurn = test.runner.startTurn('hold ordinary turn')
    await secondStarted
    const beforeCurrentNativeTurn = test.events.length
    native(41, 32, 'tool/result', { message: { toolCallId: 'native-bash', content: [{ type: 'text', text: 'OLD_LOCAL_TURN_RESULT' }] } })
    assert.equal(test.events.length, beforeCurrentNativeTurn, 'a tool result cannot cross the local turn before its next native turn is bound')
    stock(41, 'STALE STOCK COMMAND')
    const missing = permission('approval-no-current-call')
    assert.equal(missing.payload.params.rawInput, undefined, 'a late old-turn stock update cannot repopulate cleared metadata')
    test.runner.respondResult(missing.payload.requestId, { outcome: { outcome: 'selected', optionId: 'native-deny' } })
    native(42, 40, 'turn/start')
    const currentArgs = { command: 'printf CURRENT_TURN', workdir: '/current' }
    native(42, 41, 'tool/call', { callId: 'native-bash', name: 'bash', arguments: JSON.stringify(currentArgs) })
    const currentEventCount = test.events.length
    stock(41, 'STALE STOCK COMMAND')
    native(41, 31, 'tool/call', { callId: 'native-bash', name: 'bash', arguments: JSON.stringify(args) })
    native(41, 32, 'tool/result', { message: { toolCallId: 'native-bash', content: [{ type: 'text', text: 'OLD_NATIVE_TURN_RESULT' }] } })
    const current = permission('approval-current')
    assert.deepEqual(current.payload.params.rawInput, currentArgs, 'neither old stock nor old raw tool calls overwrite the current native turn')
    test.runner.respondResult(current.payload.requestId, { outcome: { outcome: 'selected', optionId: 'native-allow' } })
    native(42, 42, 'tool/result', { message: { toolCallId: 'native-bash', content: [{ type: 'text', text: 'CURRENT_TURN_RESULT' }], isError: false } })
    const currentResult = test.events.findLast(event => event.type === 'command_exec')!
    assert.equal(currentResult.payload.command, currentArgs.command, 'the current native result must retain current command metadata after a late old call')
    assert.deepEqual(currentResult.payload.input, currentArgs)
    assert.equal(currentResult.payload.output, 'CURRENT_TURN_RESULT')
    assert.equal(currentResult.state, 'success')
    assert.equal(test.events.slice(currentEventCount).some(event => event.type === 'command_exec' && event.payload.command === args.command), false,
      'a late old raw call must not emit a command event into the new turn')
    native(41, 1, 'tool/call', { callId: 'native-bash', name: 'bash', arguments: JSON.stringify(args) }, 'cold-native-child')
    native(41, 2, 'tool/result', { message: { toolCallId: 'native-bash', content: [{ type: 'text', text: 'CHILD_RESULT' }], isError: false } }, 'cold-native-child')
    const childResult = (await test.runner.getSubAgentItems('cold-native-child')).at(-1)!
    assert.equal(childResult.payload.command, args.command, 'child transcript projection keeps its independent native turn and tool state')
    assert.equal(childResult.payload.output, 'CHILD_RESULT')
    assert.equal(test.events.findLast(event => event.type === 'command_exec')?.payload.command, currentArgs.command)
    ;(test.runner as any).connection.notify('_uniagent/fixture_release')
    await secondTurn
    await test.runner.setGoal({ objective: 'hold between rounds' })
    const goal = { objective: 'hold between rounds', phase: 'active', activation: 'armed', roundsStarted: 1, createdAt: 1, updatedAt: 1 }
    ;(test.runner as any).onNotification({ jsonrpc: '2.0', method: '_uniagent/session_update', params: {
      sessionId: 'native-extension-session', kind: 'goal_turn', state: 'running', turn: 43, round: 1, goal, autonomous: true
    } })
    native(43, 51, 'tool/call', { callId: 'native-bash', name: 'bash', arguments: JSON.stringify(args) })
    const goalApproval = permission('approval-goal')
    assert.equal(goalApproval.payload.kind, 'command', 'Goal rounds bind their native turn before the tool call')
    assert.deepEqual(goalApproval.payload.params.rawInput, args)
    test.runner.respondResult(goalApproval.payload.requestId, { outcome: { outcome: 'selected', optionId: 'native-allow' } })
    ;(test.runner as any).onNotification({ jsonrpc: '2.0', method: '_uniagent/session_update', params: {
      sessionId: 'native-extension-session', kind: 'goal_turn', state: 'success', turn: 43, round: 1,
      goal: { ...goal, phase: 'complete', activation: 'disarmed' }, autonomous: false
    } })
  } finally { await test.cleanup() }
}

await nativeGoalAndQuestions()
await planAndNativeError()
await rpcOrdering()
await armedLifecycleFailures()
await nativeGoalOutputOrdering()
await ordinaryPromptToGoal()
await nativeCommandApprovalMetadata()
console.log('deepseek-runner-extensions: native Goal, approvals/questions, Plan, turn errors and wire ordering passed')
