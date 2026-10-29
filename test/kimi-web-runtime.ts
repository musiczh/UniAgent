import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiWebRuntime, kimiWebCapabilities } from '../src/main/kimiWebRuntime.ts'

const root = mkdtempSync(join(tmpdir(), 'uniagent-kimi-web-fixture-'))
const home = join(root, 'home'); mkdirSync(home)
const fixture = join(root, 'web.cjs')
writeFileSync(fixture, `
const fs = require('node:fs'), http = require('node:http');
fs.writeFileSync(process.env.KIMI_CODE_HOME + '/server.token', 'fixture-secret', {mode: 0o600});
let goal = null, active = null, queued = [], rows = [];
let profile = {model:'local',permission_mode:'manual',plan_mode:false};
const ownedTask={id:'task-owned',session_id:'session_fixture',kind:'subagent',agent_id:'child-owned',status:'running',description:'Owned child'};
const server = http.createServer(async (req,res) => {
 if(req.headers.authorization !== 'Bearer fixture-secret') {res.writeHead(401);return res.end(JSON.stringify({code:40101,data:null}));}
 let text=''; for await(const chunk of req) text+=chunk;
 const body=text?JSON.parse(text):null; rows.push({url:req.url,body});
 let data={};
 if(req.url==='/api/v1/meta') data={dangerous_bypass_auth:false,backend:'v2',server_version:'2.2.0'};
 else if(req.url==='/openapi.json') return res.end(JSON.stringify({paths:{'/api/v1/sessions/{session_id}/goal':{get:{}},'/api/v1/sessions/{session_id}/profile':{post:{}},'/api/v1/sessions/{session_id}/prompts':{post:{}},'/api/v1/sessions/{session_id}/prompts/{tail}':{post:{}}}}));
 else if(req.url==='/asyncapi.json') return res.end(JSON.stringify({asyncapi:'3.0.0'}));
 else if(req.url==='/api/v1/sessions?busy=true&page_size=100') data={items:active?[{id:'session_fixture'}]:[],has_more:false};
 else if(req.url==='/api/v1/sessions') data={id:'session_fixture'};
 else if(req.url==='/api/v1/models') data={items:[{model:'local',capabilities:[]}]};
 else if(req.url.endsWith('/tasks')) data={items:[ownedTask,{...ownedTask,id:'foreign',session_id:'another-session',agent_id:'foreign'}]};
 else if(req.url.includes('/tasks/task-owned?')) data={...ownedTask,output_preview:'child output'};
 else if(req.url.endsWith('/tasks/task-owned:cancel')) {ownedTask.status='cancelled';data={cancelled:true};}
 else if(req.url.includes('/transcript?')) data={agent_id:req.url.includes('child-cold')?'child-cold':'child-owned',has_more:false,items:[{kind:'turn',turnId:'1',ordinal:1,state:'completed',steps:[{stepId:'1.1',state:'completed',frames:[{kind:'text',role:'assistant',frameId:'1.1.f1',text:'Full child history'},{kind:'tool',toolCallId:'call-child',frameId:'1.1.f2',name:'Read',state:'done',input:{path:'/fixture'},output:'native result'}]}]}]};
 else if(req.url.endsWith('/status')) data={busy:!!active,model:profile.model,permission:profile.permission_mode,plan_mode:profile.plan_mode,context_tokens:42,max_context_tokens:8192};
 else if(req.url.endsWith('/goal')) data=goal;
 else if(req.url.endsWith('/profile')) {const a=body.agent_config||{}; if(a.model!=='schema-accepted-but-not-applied') Object.assign(profile,a); if(a.goal_objective) goal={goalId:'g',objective:a.goal_objective,status:'active',turnsUsed:0,tokensUsed:0,wallClockMs:0,budget:{tokenBudget:null,turnBudget:null,wallClockBudgetMs:null,remainingTokens:null,remainingTurns:null,remainingWallClockMs:null,tokenBudgetReached:false,turnBudgetReached:false,wallClockBudgetReached:false,overBudget:false}}; if(a.goal_control==='pause')goal.status='paused'; if(a.goal_control==='resume')goal.status='active'; if(a.goal_control==='cancel')goal=null; data={id:'session_fixture'};}
 else if(req.url.endsWith('/prompts') && req.method==='GET') data={active,queued};
 else if(req.url.endsWith('/prompts')) {data={prompt_id:body.prompt_id,status:active?'queued':'running',content:body.content};if(body.content?.[0]?.text==='late immediate followup'){data.status='running';active=data;}else if(active)queued.push(data);else active=data;}
 else if(req.url.endsWith(':steer')) {const id=req.url.split('/').pop().slice(0,-6); if(queued.find(p=>p.prompt_id===id)?.content?.[0]?.text==='late queued conflict'){return res.end(JSON.stringify({code:40402,data:null}));}queued=queued.filter(p=>p.prompt_id!==id);data={steered:true,prompt_ids:[id]};}
 else if(req.url.endsWith(':abort')) {active=null;data={aborted:true};}
 else if(req.url.endsWith('/snapshot')) data={as_of_seq:0,epoch:'fixture',rows,session:{usage:{input_tokens:10,cache_read_tokens:3,cache_creation_tokens:2,output_tokens:5}}};
 res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data}));
}); server.listen(0,'127.0.0.1',()=>process.stdout.write('Kimi server: http://127.0.0.1:'+server.address().port+'#token=fixture-secret\\n'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`)
let released = 0
const options = { bin: process.execPath, argsPrefix: [fixture], sessionId: 'u', config: { agentId: 'kimi' as const, workdir: root, model: 'local', permissionMode: 'ask' as const }, env: { KIMI_CODE_HOME: home }, acquireWritableRuntime: async () => () => { released++ } }
let runtime: KimiWebRuntime | undefined
try {
  runtime = await KimiWebRuntime.start(options)
  assert.equal(runtime.nativeSessionId, 'session_fixture')
  assert.equal(kimiWebCapabilities.goalBudget, false)
  await runtime.setProfile({ plan_mode: true })
  assert.equal((await runtime.status()).plan_mode, true)
  await runtime.setProfile({ permission_mode: 'yolo' })
  assert.equal((await runtime.status()).plan_mode, true, 'permissions and Plan are independent')
  await runtime.setProfile({ permission_mode: 'auto' })
  assert.equal((await runtime.status()).permission, 'auto')
  assert.equal((await runtime.status()).plan_mode, true, 'unattended permissions must preserve native Plan state')
  await runtime.setProfile({ permission_mode: 'manual', plan_mode: false })
  assert.equal((await runtime.status()).plan_mode, false)
  await assert.rejects(runtime.setProfile({ model: 'schema-accepted-but-not-applied' }), /profile_not_applied/)
  await assert.rejects(KimiWebRuntime.start(options), /runtime_already_owned/)
  assert.equal((await runtime.createGoal({ objective: 'native objective' }))?.status, 'active')
  await assert.rejects(runtime.createGoal({ objective: 'budgeted', tokenBudget: 10 }), /goal_budget_unsupported/)
  assert.equal((await runtime.controlGoal('pause'))?.status, 'paused')
  assert.equal((await runtime.controlGoal('resume'))?.status, 'active')
  assert.equal(await runtime.controlGoal('cancel'), null)
  const prompt = await runtime.submitPrompt('starter')
  const steering = await runtime.steer('literal steer $HOME')
  assert.equal(steering.steered, true)
  await runtime.abortPrompt(prompt.prompt_id)
  await assert.rejects(runtime.steer('late'), /no_active_turn/)
  assert.equal((await runtime.listSubagentTasks()).length, 1)
  assert.equal((await runtime.getSubagentTask('child-owned')).id, 'task-owned')
  await assert.rejects(runtime.getSubagentTask('foreign'), /subagent_not_owned/)
  const transcript = await runtime.getSubagentTranscript('child-owned')
  assert.ok(transcript.some(event => event.type === 'agent_message' && event.payload.text === 'Full child history'))
  assert.ok(transcript.some(event => event.type === 'tool_call' && event.payload.result === 'native result'))
  await assert.rejects(runtime.getSubagentTranscript('child-cold'), /subagent_not_owned/)
  await assert.rejects(runtime.getSubagentTranscript('child-cold', { nativeTaskId: 'task-cold', parentNativeSessionId: 'foreign' }), /subagent_not_owned/)
  assert.ok((await runtime.getSubagentTranscript('child-cold', { nativeTaskId: 'task-cold', parentNativeSessionId: runtime.nativeSessionId })).some(event => event.type === 'turn_completed'))
  await runtime.cancelSubagentTask('child-owned')
  assert.equal((await runtime.getSubagentTask('child-owned')).status, 'cancelled')
  const usage = await runtime.submitSlash('/usage')
  assert.equal(usage.kind, 'notice')
  assert.ok(usage.kind === 'notice' && usage.text.includes('15 input, 5 output'))
  await runtime.submitPrompt('held starter')
  assert.equal((await runtime.steer('late queued conflict')).steered, false)
  assert.equal((await runtime.steer('late immediate followup')).steered, false)
  const snapshot = await runtime.snapshot() as any
  const profile = snapshot.rows.find((row: any) => row.body?.agent_config?.model)
  assert.deepEqual(profile.body.agent_config, { model: 'local', permission_mode: 'manual', plan_mode: false })
  assert.ok(snapshot.rows.some((row: any) => row.url.endsWith(steering.prompt_id + ':steer')))
  await runtime.abortSession()
  await runtime.closeAndWait(); runtime = undefined
  assert.equal(released, 1)
  runtime = await KimiWebRuntime.start({ ...options, config: { ...options.config, collaborationMode: 'plan' }, nativeSessionId: 'session_fixture' })
  assert.equal((await runtime.status()).plan_mode, true, 'cold resume must reapply the persisted Plan selection')
  await runtime.cancelSubagentTask('child-owned')
  await runtime.closeAndWait(); runtime = undefined
  assert.equal(released, 2)
} finally { await runtime?.closeAndWait(); rmSync(root, { recursive: true, force: true }) }
console.log('Kimi web runtime: native Goal, queue steer, profile, ownership and exact child shutdown passed')
