import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { TurnRunner } from '../src/main/adapter'
import { claudeSdkLaunch } from '../src/main/claudeSdk'
import type { AgentDef, UAEvent } from '../src/shared/types'

const projected: UAEvent[] = []
const projector = new TurnRunner('projection', { n: 0 })
projector.on('event', event => projected.push(event))
const send = (message: object) => (projector as any).onLine('claude', JSON.stringify(message))
const tool = (id: string, name: string, input: object, result: object, failed = false) => {
  send({ type:'assistant', message:{ content:[{type:'tool_use',id,name,input}] } })
  send({ type:'user', tool_use_result:result, message:{content:[{type:'tool_result',tool_use_id:id,content:'fixture',is_error:failed}]} })
}
tool('create-a','TaskCreate',{subject:'Read module'},{task:{id:'1',subject:'Read module'}})
tool('create-b','TaskCreate',{subject:'Test module'},{task:{id:'2',subject:'Test module'}})
tool('update-a','TaskUpdate',{taskId:'1',status:'completed'},{success:true,taskId:'1',statusChange:{from:'pending',to:'completed'}})
tool('failed-b','TaskUpdate',{taskId:'2',status:'completed'},{success:false,error:'fixture failure'},true)
const plans = projected.filter(event => event.type === 'plan_update')
assert.equal(plans.length, 3)
assert.deepEqual(plans.at(-1)!.payload.steps.map((step: any) => [step.id,step.status]), [['1','completed'],['2','pending']])
assert.equal(new Set(plans.map(event => event.payload.id)).size, 1)
tool('delete-b','TaskUpdate',{taskId:'2',status:'deleted'},{success:true,taskId:'2'})
assert.equal(projected.filter(event=>event.type==='plan_update').at(-1)!.state, 'success')
send({type:'system',subtype:'hook_started',hook_id:'hook',hook_name:'test',hook_event:'PreToolUse'})
send({type:'system',subtype:'hook_response',hook_id:'hook',hook_name:'test',hook_event:'PreToolUse',outcome:'cancelled'})
assert.deepEqual(projected.filter(event=>event.type==='hook').map(event=>event.state), ['running','cancelled'])
const off = claudeSdkLaunch('claude','/repo',['--effort','off'],{})
assert.deepEqual(off.options.thinking,{type:'disabled'})
assert.equal(off.options.effort,undefined)

const root = await mkdtemp(join(tmpdir(),'ua-sdk-projection-'))
const executable = join(root,'claude.cjs')
const controls = join(root,'controls.jsonl')
await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');let count=0;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);
 if(v.type==='control_request'){
  fs.appendFileSync(${JSON.stringify(controls)},v.request.subtype+'\\n');
  const commands=process.env.UA_SDK_ALIAS_COLLISION==='1'?[{name:'safe'},...(v.request.subtype==='reload_plugins'?[{name:'plugin:safe'}]:[])]:[];
  send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{commands,models:[],hooks_applied:true}}});return;
 }
 if(v.type!=='user')return;count++;
 send({type:'system',subtype:'init',session_id:'fixture-session',model:'fixture'});
 send({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:count,session_id:'fixture-session',usage:{input_tokens:10,output_tokens:2}});
});`, {mode:0o700})
const runner = new TurnRunner('persistent',{n:0})
const events: UAEvent[] = []
runner.on('event',event=>events.push(event))
const agent: AgentDef = {id:'claude',name:'Claude',adapter:'claude',bin:executable,icon:'',builtin:true,installed:true,version:'2.1.311',models:[],capabilities:{modelSelect:true,reasoningEffort:false,streaming:true,permissionModes:[{id:'ask',label:'',hint:''}]}}
try {
  for (const prompt of ['first','second']) {
    const done=once(runner,'done')
    runner.start(agent,{agentId:'claude',workdir:root,permissionMode:'ask'},prompt)
    assert.equal((await done)[0].failed,false)
  }
  assert.deepEqual(events.filter(event=>event.payload.kind==='usage').map(event=>event.payload.cost),[1,1], 'persistent SDK cumulative costs must be charged once per turn')
  assert.deepEqual((await readFile(controls,'utf8')).trim().split('\n'),['initialize','reload_plugins'],'subsequent turns reload native plugins and skills without creating a new session')
  const turns=events.filter(event=>event.type==='turn_started' && event.payload.turnId)
  assert.equal(turns.length,2)
  assert.notEqual(turns[0].payload.turnId,turns[1].payload.turnId,'rewind artifacts require a unique native user UUID for every turn')
  const prior = process.env.UA_SDK_ALIAS_COLLISION
  process.env.UA_SDK_ALIAS_COLLISION='1'
  const scoped=new TurnRunner('scoped',{n:0}), scopedEvents: UAEvent[]=[]
  scoped.on('event',event=>scopedEvents.push(event))
  try {
    const config={agentId:'claude',workdir:root,permissionMode:'ask' as const,roleSnapshot:{id:'safe',name:'Safe',agentId:'claude',permissionMode:'ask' as const,skills:['safe']}}
    for (const [index,prompt] of ['first allowed turn','must not run'].entries()) {
      const done=once(scoped,'done');scoped.start(agent,config,prompt)
      assert.equal((await done)[0].failed,index===1)
    }
    assert.equal(scopedEvents.filter(event=>event.payload.kind==='usage').length,1,'a newly installed ambiguous plugin must be rejected before the second model turn')
    assert.ok(scopedEvents.some(event=>event.type==='error' && /完整名称/.test(event.payload.message)))
  } finally {
    await scoped.disposeClaudeSdk()
    prior===undefined?delete process.env.UA_SDK_ALIAS_COLLISION:process.env.UA_SDK_ALIAS_COLLISION=prior
  }
  console.log('Claude SDK projection: incremental tasks, failed updates, hooks, MiMo thinking and persistent per-turn costs passed')
} finally { await runner.disposeClaudeSdk(); await rm(root,{recursive:true,force:true}) }
