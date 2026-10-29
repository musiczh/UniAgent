import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokACPRunner } from '../src/main/grokACPRunner.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-grok-goal-runner-'))
const log = join(root, 'rpc.jsonl')
const executable = join(root, 'grok')
await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline')
const emit = frame => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\\n')
const reply = (id,result) => emit({id,result})
const sid = 'native-grok-goal'
let goal, prompt, serial=0, activePromptId
const now = () => 1791725747771 + ++serial
const native = update => emit({method:'_x.ai/session_notification',params:{sessionId:sid,update,_meta:{agentTimestampMs:now(),eventId:'event-'+serial}}})
const goalUpdate = status => {
  goal={goal_id:'goal-one',objective:'Confirm native workflow',status,token_budget:10000,tokens_used:40,elapsed_ms:2107,last_event:status==='active'?'goal_created':'goal_paused',last_event_timestamp:new Date(now()).toISOString()}
  native({sessionUpdate:'goal_updated',...goal,...(status==='active'?{planning:true}:{})})
}
const chunk = (id,text,start=1791725748000) => emit({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}},_meta:{promptId:id,turnStartMs:start,agentTimestampMs:now()}}})
const complete = id => native({sessionUpdate:'turn_completed',prompt_id:id,stop_reason:'end_turn',elapsed_ms:2107,usage:{input_tokens:30,output_tokens:10,total_tokens:40}})
fs.appendFileSync(process.env.UA_GROK_GOAL_LOG,JSON.stringify({kind:'env',goal:process.env.GROK_GOAL})+'\\n')
readline.createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line),p=f.params||{}
  fs.appendFileSync(process.env.UA_GROK_GOAL_LOG,JSON.stringify(f)+'\\n')
  if(f.method==='initialize')return reply(f.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{embeddedContext:true},sessionCapabilities:{resume:{}}},_meta:{agentVersion:'1.0.62',availableCommands:[{name:'goal'}]}})
  if(f.method==='session/new')return reply(f.id,{sessionId:sid,models:{currentModelId:'ua-test',availableModels:[{modelId:'ua-test'}]}})
  if(f.method==='_x.ai/session/state')return reply(f.id,{...(goal?{goal:{...goal,status:'active',created_at:'2026-10-11T13:35:47.771Z',history:[{event:'goal_created',timestamp:'2026-10-11T13:35:47.771Z'}],tokens_used_high_water:40}}:{}),summary:{updated_at:new Date(now()).toISOString()}})
  if(f.method==='session/set_mode')return reply(f.id,{})
  if(f.method==='session/prompt'){
    const text=p.prompt[0].text
    if(text==='/goal Confirm native workflow --budget 10000'){
      prompt=f.id;activePromptId='goal-prompt-1';goalUpdate('active');if(process.env.UA_GROK_PLANNING_HOLD!=='1')setTimeout(()=>chunk(activePromptId,'native first round'),10);return
    }
    if(text==='/goal pause'){goalUpdate('user_paused');complete('pause-command');return reply(f.id,{stopReason:'end_turn',_meta:{promptId:'pause-command'}})}
    if(text==='/goal resume'){prompt=f.id;activePromptId='goal-prompt-2';goalUpdate('active');setTimeout(()=>chunk(activePromptId,'native resumed'),10);return}
    if(text==='/goal clear'){goal=undefined;native({sessionUpdate:'goal_updated',status:'cleared',goal_id:'',objective:''});return reply(f.id,{stopReason:'end_turn'})}
    throw Error('Host injected extra parent prompt: '+text)
  }
  if(f.method==='session/cancel'){
    goalUpdate('user_paused');complete(activePromptId);if(prompt){reply(prompt,{stopReason:'cancelled',_meta:{promptId:activePromptId}});prompt=undefined};return
  }
  if(f.method==='_x.ai/interject'){
    reply(f.id,{result:{status:'queued'}})
    if(p.text==='finish-current')setTimeout(()=>{chunk(activePromptId,' second native round',1791725749000);goalUpdate('complete');complete(activePromptId);emit({method:'_x.ai/session/prompt_complete',params:{sessionId:sid,promptId:activePromptId,stopReason:'end_turn',agentResult:null}});if(prompt){reply(prompt,{stopReason:'end_turn',_meta:{promptId:activePromptId}});prompt=undefined}},10)
    return
  }
  if(f.id!==undefined)emit({id:f.id,error:{code:-32601,message:'Unknown method'}})
})
`, { mode: 0o700 })
const agent: AgentDef = { id: 'grok', name: 'Grok', adapter: 'grok', bin: executable, builtin: true,
  icon: '', models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] } }
const runner = new GrokACPRunner('app-grok-goal', { n: 0 }, agent, { agentId: 'grok', workdir: root, model: 'ua-test', permissionMode: 'full-access' }, undefined,
  { HOME: root, GROK_HOME: join(root, '.grok'), UA_GROK_GOAL_LOG: log })
const events: UAEvent[] = [], goals: any[] = [], done: any[] = []
runner.on('event', event => events.push(event))
runner.on('goalChanged', goal => goals.push(goal))
runner.on('done', result => done.push(result))
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Native runner condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
try {
  assert.equal(await runner.getGoal(), undefined)
  const created = await runner.setGoal({ objective: 'Confirm native workflow', tokenBudget: 10000 })
  assert.equal(created.autonomous, true)
  await until(() => events.some(event => event.type === 'agent_message' && event.payload.text === 'native first round'))
  await runner.steer('active-steer')
  await runner.updateGoal({ action: 'pause' })
  assert.equal(goals.at(-1).status, 'paused')
  assert.equal((await runner.getGoal())?.status, 'paused', 'late persisted active snapshot cannot restore paused native Goal')
  assert.equal(done.length, 1, 'pause cancels and waits for the owned native execution')
  await until(() => done.length === 1)
  assert.equal(events.filter(event => event.type === 'turn_started').length, 1, 'internal rounds retain the native parent prompt ownership')
  assert.equal(events.filter(event => event.type === 'turn_completed').length, 1)
  await assert.rejects(runner.steer('idle'), /运行|回合|引导/)
  await runner.updateGoal({ action: 'resume' })
  await until(() => events.some(event => event.type === 'agent_message' && event.payload.text === 'native resumed'))
  await runner.steer('finish-current')
  await until(() => done.length === 2)
  await runner.updateGoal({ action: 'clear' })
  assert.equal(goals.at(-1), undefined)
  const frames = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(frames[0].goal, '1')
  assert.equal(frames.filter(frame => frame.method === 'session/prompt').length, 3, 'set/resume/clear use prompts; active pause uses session/cancel')
  assert.deepEqual(frames.filter(frame => frame.method === '_x.ai/interject').map(frame => frame.params.text), ['active-steer', 'finish-current'])
  await runner.disposeAndWait()
  const planning = new GrokACPRunner('app-grok-planning', { n: 0 }, agent, { agentId: 'grok', workdir: root, model: 'ua-test', permissionMode: 'full-access' }, undefined,
    { HOME: root, GROK_HOME: join(root, '.grok'), UA_GROK_GOAL_LOG: log, UA_GROK_PLANNING_HOLD: '1' })
  const planningEvents: UAEvent[] = [], planningDone: any[] = []
  planning.on('event', event => planningEvents.push(event)); planning.on('done', result => planningDone.push(result))
  try {
    await planning.setGoal({ objective: 'Confirm native workflow', tokenBudget: 10000 })
    assert.equal(planningEvents.some(event => event.type === 'turn_started'), false, 'planning alone must not fabricate a parent model round')
    planning.interrupt()
    await until(() => planningDone.some(result => result.interrupted === true))
    assert.equal(planningEvents.filter(event => event.type === 'turn_started').length, 0)
    assert.equal((await planning.getGoal())?.status, 'paused')
  } finally { await planning.disposeAndWait() }
} finally { await runner.disposeAndWait(); await rm(root, { recursive: true, force: true }) }
console.log('grok-goal-runner: native command acknowledgement, active steer, prompt ownership and stale-state control passed')
