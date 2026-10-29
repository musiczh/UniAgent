import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { TurnRunner } from '../src/main/adapter'
import { ClaudeSdkClient, claudeGoal, claudeReviewPrompt, initializeClaudeSdk } from '../src/main/claudeSdk'
import type { AgentDef, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-sdk-boundaries-'))
const bin = join(root,'claude.cjs'), wire = join(root,'wire.jsonl'), image = join(root,'image.png')
await writeFile(image, Buffer.from('fixture-image'))
await writeFile(bin, `#!${process.execPath}
const fs=require('node:fs');const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let waiting,active,legacyGoal='',goalWait;
fs.appendFileSync(${JSON.stringify(wire)},JSON.stringify({type:'fixture_start',args:process.argv.slice(2)})+'\\n');
const result=(uuid,extra={})=>send({type:'result',subtype:'success',is_error:false,result:'ok',user_message_uuid:uuid,session_id:'boundary-native',usage:{input_tokens:10,output_tokens:2},duration_ms:100,...extra});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);fs.appendFileSync(${JSON.stringify(wire)},line+'\\n');
 if(v.type==='control_request'){
  if(v.request.subtype==='interrupt'&&goalWait)result(goalWait,{subtype:'error_during_execution',is_error:true,errors:['interrupted']});
  send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{commands:[{name:'goal',builtin:true},{name:'code-review',builtin:true}],models:[]}}});return;
 }
 if(v.type==='control_response' && v.response.request_id==='elicit'){result(active,{result:JSON.stringify(v.response.response)});return;}
 if(v.type!=='user')return;
 send({...v,isReplay:true,session_id:'boundary-native'});
 const text=v.message.content;
 if(text==='wait'){waiting=v.uuid;return;}
 if(text==='steer'){
  result('unrelated-background');result(waiting,{queued_turn_count:1});setTimeout(()=>result(v.uuid),40);return;
 }
 if(text==='elicit'){active=v.uuid;send({type:'control_request',request_id:'elicit',request:{subtype:'elicitation',mcp_server_name:'fixture',message:'Enter count',requested_schema:{type:'object',properties:{count:{type:'number'}}}}});return;}
 if(text==='/goal clear'){legacyGoal='';send({type:'active_goal',value:null});result(v.uuid,{result:'Goal cleared: fixture'});return;}
 if(text==='/goal waiting'){goalWait=v.uuid;send({type:'active_goal',value:{condition:'waiting objective'}});return;}
 if(typeof text==='string' && text.startsWith('/goal legacy')){legacyGoal=text;result(v.uuid);return;}
 if(text==='/goal'){result(v.uuid,{result:legacyGoal.includes('pending')?'Goal active: pending (not yet evaluated)':'No goal set. Usage: /goal <condition>'});return;}
 if(typeof text==='string' && text.startsWith('/goal ')){
  send({type:'active_goal',value:{condition:'fixture objective'}});result(v.uuid);
  setTimeout(()=>send({type:'active_goal',value:null}),60);return;
 }
 if(text==='/code-review'){result(v.uuid,{result:'Not logged in · Please run /login'});return;}
 result(v.uuid);
});
`,{mode:0o700})
const agent: AgentDef = {id:'claude',name:'Claude',adapter:'claude',bin,installed:true,builtin:true,icon:'',models:[],capabilities:{modelSelect:true,reasoningEffort:false,streaming:true,permissionModes:[{id:'ask',label:'',hint:''}]}}
const runner = new TurnRunner('boundaries',{n:0}), events: UAEvent[] = []
runner.on('event',event=>events.push(event))
const config = {agentId:'claude',workdir:root,permissionMode:'ask' as const}
const until = async (predicate:()=>boolean) => {
  const deadline=Date.now()+5000
  while (!predicate()) { assert.ok(Date.now()<deadline,'SDK boundary timed out'); await new Promise(resolve=>setTimeout(resolve,10)) }
}
try {
  const env={...process.env,HOME:root,CLAUDE_CONFIG_DIR:join(root,'.claude')}
  const [a,b]=await Promise.all([initializeClaudeSdk(bin,env),initializeClaudeSdk(bin,env)])
  assert.equal(a,b,'concurrent model and protocol checks share one initialization flight')
  const probes=(await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(value=>value.type==='fixture_start')
  assert.equal(probes.length,1)
  assert.ok(probes[0].args.includes('--strict-mcp-config'),'startup health must not wait for unrelated user MCP servers')
  let doneCount=0
  runner.on('done',()=>doneCount++)
  let done=once(runner,'done')
  runner.start(agent,config,'wait')
  await until(()=>events.some(event=>event.type==='turn_started'))
  await runner.steer('steer')
  assert.equal(doneCount,0,'background/queued results cannot finish the active turn')
  await done
  assert.equal(doneCount,1)
  assert.equal(events.filter(event=>event.payload.kind==='usage').length,2,'unrelated result must not charge the active turn')

  done=once(runner,'done')
  const approval=once(runner,'event').catch(()=>{})
  runner.start(agent,config,'elicit')
  await until(()=>events.some(event=>event.type==='approval_request' && event.state==='pending'))
  const request=events.findLast(event=>event.type==='approval_request' && event.state==='pending')!
  assert.equal(request.payload.kind,'elicitation')
  assert.equal(request.payload.params.requestedSchema.properties.count.type,'number')
  runner.respond(request.payload.requestId,{action:'accept',content:{count:3}})
  await done; await approval
  const response=(await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.type==='control_response' && value.response.request_id==='elicit')
  assert.deepEqual(response.response.response,{action:'accept',content:{count:3}})

  const goal=claudeGoal('fixture objective')
  runner.configureClaudeGoal(goal)
  const goals:any[]=[]
  runner.on('goalChanged',value=>goals.push(value))
  done=once(runner,'done');const began=Date.now()
  runner.start(agent,config,'/goal fixture objective')
  await done
  assert.ok(Date.now()-began>=50,'Goal stays active until a native completion event')
  assert.equal(goals.at(-1).status,'complete')
  assert.equal(goals.at(-1).tokensUsed,12)
  assert.equal(goals.at(-1).timeUsedSeconds,0.1)
  for (const pending of [false,true]) {
    runner.configureClaudeGoal(claudeGoal('legacy objective'))
    done=once(runner,'done');runner.start(agent,config,pending?'/goal legacy pending':'/goal legacy complete');await done
    assert.equal(goals.at(-1).status,pending?'paused':'complete','older CLI goal status must be confirmed through SDK, never inferred from reply prose')
  }
  done=once(runner,'done');runner.start(agent,config,'ordinary while paused');await done
  assert.equal(goals.at(-1).status,'paused')
  assert.equal(goals.at(-1).tokensUsed,12,'ordinary messages cannot consume a paused Goal budget')
  runner.configureClaudeGoal(claudeGoal('waiting objective'))
  done=once(runner,'done');runner.start(agent,config,'/goal waiting')
  await until(()=>goals.at(-1)?.autonomous===true)
  await runner.stopClaudeSdk()
  assert.equal((await done)[0].interrupted,true)
  assert.equal(goals.at(-1).status,'paused','interrupt clears the native Goal without falsely completing it')
  assert.ok((await readFile(wire,'utf8')).includes('/goal clear'))
  assert.throws(()=>claudeGoal('objective',100),/没有公开/)
  assert.throws(()=>claudeGoal(' '),/不能为空/)
  const review={scope:{type:'baseBranch' as const,branch:'master'},instructions:'Only regressions'}
  assert.equal(claudeReviewPrompt(review),'/code-review master...HEAD\n\n补充要求：\nOnly regressions')
  assert.throws(()=>claudeReviewPrompt({scope:{type:'custom'},instructions:'--comment'}),/只生成报告/)
  assert.match(claudeReviewPrompt({scope:{type:'commit',sha:'abc1234'}}),/abc1234\^\.\.abc1234/)
  assert.match(claudeReviewPrompt({scope:{type:'uncommittedChanges'}}),/未跟踪/)
  assert.throws(()=>claudeReviewPrompt(review,{...config,roleSnapshot:{id:'limited',name:'Limited',agentId:'claude',permissionMode:'ask',skills:[]}}),/技能白名单.*内部子代理/)
  assert.equal(Object.hasOwn(config,'roleSnapshot'),false,'review instructions apply only to this turn')
  runner.configureClaudeGoal(undefined)
  done=once(runner,'done')
  runner.start(agent,config,'/code-review')
  assert.equal((await done)[0].failed,true,'a native local-command login error must not be reported as a successful review')

  const client=new ClaudeSdkClient({options:{pathToClaudeCodeExecutable:bin,cwd:root,env}})
  try {
    await client.ready
    await Promise.all([
      client.request('send',{uuid:'image',content:'inspect',attachments:[{kind:'image',path:image}],waitForReplay:true}),
      client.request('send',{uuid:'after-image',content:'follow-up',waitForReplay:true})
    ])
    const inputs=(await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(value=>value.type==='user')
    assert.deepEqual(inputs.slice(-2).map(input=>input.uuid),['image','after-image'],'asynchronous attachment reads must preserve submitted prompt order')
    const content=inputs.at(-2).message.content
    assert.deepEqual(content[1],{type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from('fixture-image').toString('base64')}})
    const closing=client.close()
    assert.equal(client.close(),closing,'all disposal callers await the same worker cleanup')
    await closing
  } finally {await client.close()}
  console.log('Claude SDK boundaries: initialization coalescing, steer receipts/results, MCP form types, native Goal, review and images passed')
} finally {await runner.disposeClaudeSdk();await rm(root,{recursive:true,force:true})}
