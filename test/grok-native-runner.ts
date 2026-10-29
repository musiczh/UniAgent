import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GrokACPRunner } from '../src/main/grokACPRunner.ts'
import { ACPTimeoutError } from '../src/main/acp/acpConnection.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

async function until(predicate:()=>boolean):Promise<void> {
  const end=Date.now()+2500
  while(!predicate()){if(Date.now()>end)throw new Error('Grok fixture condition timed out');await new Promise(r=>setTimeout(r,10))}
}
async function fixture(scenario:Record<string,unknown>, action:(runner:GrokACPRunner,events:UAEvent[],frames:()=>Promise<any[]>)=>Promise<void>,probe=true):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),'ua-grok-native-runner-')),log=join(root,'frames.jsonl'),state=join(root,'state.json'),bin=join(root,'grok.cjs')
  await writeFile(state,JSON.stringify({sessions:[]}))
  await writeFile(bin,`#!${process.execPath}\nrequire(${JSON.stringify(resolve('test/fixtures/fake-grok.cjs'))})\n`);await chmod(bin,0o700)
  const agent:AgentDef={id:'grok',adapter:'grok',name:'Grok',icon:'grok',builtin:true,bin,models:[],capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[]}}
  const runner=new GrokACPRunner('local',{n:0},agent,{agentId:'grok',model:'grok-4.7',workdir:root,permissionMode:'ask'},undefined,
    {HOME:root,GROK_HOME:join(root,'.grok'),FAKE_GROK_LOG:log,FAKE_GROK_STATE:state,FAKE_GROK_SCENARIO:JSON.stringify({native:true,...scenario})})
  const events:UAEvent[]=[];runner.on('event',event=>events.push(event))
  try {if(probe)await runner.probeSession(false);await action(runner,events,async()=>String(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)))}
  finally {await runner.disposeAndWait();await rm(root,{recursive:true,force:true})}
}

await fixture({},async(runner,events,frames)=>{
  assert.equal((await runner.probeSession(false)).contract.steer,true)
  await runner.startTurn('ordinary')
  const usages=events.filter(e=>e.payload.kind==='usage')
  assert.equal(usages.length,1,'notification and prompt result must not double-count usage')
  assert.equal(usages[0].payload.usage.cachedInputTokens,30)
  await runner.startTurn('ordinary again');assert.equal(events.filter(e=>e.payload.kind==='usage').length,2)
  const question=runner.startTurn('question');await until(()=>events.some(e=>e.payload.method==='_x.ai/ask_user_question'))
  const id=events.find(e=>e.payload.method==='_x.ai/ask_user_question')!.payload.requestId
  assert.throws(()=>runner.respondResult(id,{answers:{scope:{answers:['Workspace']}}}))
  assert.equal(runner.respondResult(id,{outcome:'accepted',answers:{'Which scope?':['Workspace']}}).handled,true)
  assert.equal(runner.respondResult(id,{outcome:'accepted',answers:{'Which scope?':['Workspace']}}).handled,false)
  await question
  assert.ok(events.some(e=>e.type==='tool_call'&&e.payload.id==='ask-1'&&e.state==='success'))
  const responses=(await frames()).filter(row=>row.kind==='inbound'&&row.frame.id===0&&row.frame.result)
  assert.deepEqual(responses.at(-1).frame.result,{outcome:'accepted',answers:{'Which scope?':['Workspace']}})
  await assert.rejects(runner.steer('idle'),/活动/)
  const prior=(runner as any).config
  const changed=await runner.updateConfig({...prior,model:'grok-4.6'})
  assert.equal(changed.contract?.imageAttachments,false)
  assert.equal(changed.contract?.nativeGoal,true,'model refresh preserves native capabilities')
  assert.equal((await runner.updateConfig({...prior,model:'grok-4.7'})).contract?.imageAttachments,true)
  assert.equal(events.some(e=>e.payload.kind==='context'),false,'no bounded signal means no fabricated occupancy')
})

// Break caught: the meter stayed at 0 for the whole turn because Grok's live
// session updates (which stamp the bounded context size) were ignored.
await fixture({contextTicks:[4000,9000]},async(runner,events)=>{
  await runner.startTurn('ordinary')
  const ticks=events.filter(e=>e.type==='system_notice'&&e.payload.kind==='context').map(e=>e.payload.usage.contextTokens)
  assert.deepEqual(ticks,[4000,9000],'live updates fill the meter before the turn completes')
  assert.ok(events.find(e=>e.payload.kind==='context')!.seq<events.find(e=>e.type==='turn_completed')!.seq)
})

// Break caught: Grok's prompt result carries both the last call's bounded input
// and the turn's cumulative usage; only the former may drive the context meter.
await fixture({contextMeta:{inputTokens:3210,contextWindow:256000}},async(runner,events)=>{
  await runner.startTurn('ordinary')
  const contexts=events.filter(e=>e.type==='system_notice'&&e.payload.kind==='context')
  assert.equal(contexts.length,1)
  assert.deepEqual(contexts[0].payload.usage,{contextTokens:3210,contextWindow:256000,modelId:'grok-4.7'})
  assert.ok(contexts[0].seq>events.find(e=>e.payload.kind==='usage')!.seq,'context tick follows the cumulative usage footer')
  assert.ok(contexts[0].seq<events.find(e=>e.type==='turn_completed')!.seq,'context tick lands before the turn closes')
})

// Break caught: resume/reconnect only replayed the cumulative usage footer, so
// the meter stayed at 100% until the next prompt completed.
await fixture({contextSignals:{contextTokensUsed:127539,contextWindowTokens:256000}},async(runner,events)=>{
  await until(()=>events.some(e=>e.type==='system_notice'&&e.payload.kind==='context'))
  const context=events.find(e=>e.type==='system_notice'&&e.payload.kind==='context')!
  assert.deepEqual(context.payload.usage,{contextTokens:127539,contextWindow:256000,modelId:'grok-4.7'})
})

await fixture({questionMode:'future-mode'},async(runner,events,frames)=>{
  await runner.startTurn('question')
  assert.equal(events.some(e=>e.type==='approval_request'&&e.state==='pending'),false)
  assert.ok((await frames()).some(row=>row.frame?.result?.outcome==='cancelled'))
})
for (const scenario of [{questionForeign:true},{duplicateLabels:true}]) await fixture(scenario,async(runner,events,frames)=>{
  await runner.startTurn('question')
  assert.equal(events.some(event=>event.type==='approval_request'&&event.state==='pending'),false)
  assert.ok((await frames()).some(row=>row.frame?.result?.outcome==='cancelled'),'unowned or ambiguous requests are cancelled')
})
await fixture({childQuestion:true},async(runner,events)=>{
  const turn=runner.startTurn('question')
  await until(()=>events.some(event=>event.type==='approval_request'&&event.state==='pending'))
  const request=events.find(event=>event.type==='approval_request'&&event.state==='pending')!
  assert.equal(request.payload.childSessionId,'session-child')
  assert.equal(runner.respondResult(request.payload.requestId,{outcome:'accepted',answers:{'Which scope?':['Workspace']}}).handled,true)
  await turn
})

await fixture({},async(runner,events,frames)=>{
  mock.timers.enable({apis:['setTimeout']})
  try {
    const turn=runner.startTurn('question'),deadline=Date.now()+2500
    while(!events.some(event=>event.type==='approval_request'&&event.state==='pending')) {
      if(Date.now()>deadline)throw new Error('question timer fixture did not become pending')
      await new Promise<void>(resolve=>setImmediate(resolve))
    }
    const request=events.find(event=>event.type==='approval_request'&&event.state==='pending')!
    mock.timers.tick(300001)
    mock.timers.reset()
    await turn
    assert.equal(runner.respondResult(request.payload.requestId,{outcome:'accepted',answers:{'Which scope?':['Workspace']}}).handled,false)
    assert.ok((await frames()).some(row=>row.frame?.id===0&&row.frame.result?.outcome==='cancelled'))
  } finally {mock.timers.reset()}
})

await fixture({initialGoal:true},async(runner,events,frames)=>{
  await runner.startTurn('ordinary after restore')
  assert.ok(events.some(event=>event.type==='error'&&event.payload.message.includes('恢复的 Grok 目标')))
  assert.equal((await frames()).some(row=>row.frame?.method==='session/prompt'),false,'active restored Goal must not receive a competing prompt')
  await runner.updateGoal({action:'pause'});await runner.updateGoal({action:'clear'})
  await until(()=>!runner.isRunning())
  await runner.startTurn('ordinary after explicit clear')
  assert.equal(events.filter(event=>event.type==='turn_completed').at(-1)?.state,'success')
},false)

await fixture({plannerPermission:true},async(runner,events)=>{
  const goal=await runner.setGoal({objective:'Plan review',tokenBudget:10000})
  assert.equal(goal.status,'active');assert.equal(runner.isRunning(),true)
  await until(()=>events.some(e=>e.type==='approval_request'&&e.state==='pending'))
  assert.equal(events.some(e=>e.type==='turn_started'),false,'planning alone must not fabricate a business turn')
  const request=events.find(e=>e.type==='approval_request'&&e.state==='pending')!.payload.requestId
  runner.interrupt();await until(()=>!runner.isRunning())
  assert.equal((await runner.getGoal())?.status,'paused')
  assert.equal(runner.respondResult(request,{outcome:{outcome:'selected',optionId:'allow_once'}}).handled,false)
  assert.equal(events.some(e=>e.payload.kind==='usage'),false,'partial zero counters are not a completed zero-cost turn')
  assert.ok(events.some(e=>e.payload.nativeUsage?.usageIsIncomplete))
  await runner.updateGoal({action:'clear'});assert.equal(await runner.getGoal(),undefined)
})

await fixture({},async(runner,events)=>{
  await runner.setGoal({objective:'Execute review'})
  await until(()=>events.some(e=>e.type==='turn_started'))
  assert.equal((await runner.steer('keep scope')).appendedToTurn,true)
  await assert.rejects(runner.steer('attachment',[{kind:'file',path:'/tmp/file'} as any]),/纯文本/)
  await runner.updateGoal({action:'pause'});assert.equal((await runner.getGoal())?.status,'paused')
  assert.equal(events.filter(e=>e.type==='turn_completed').length,1)
  await runner.updateGoal({action:'clear'})
})

await fixture({steerEndsFirst:true},async(runner)=>{
  const turn=runner.startTurn('wait');await until(()=>runner.isRunning())
  await new Promise(r=>setTimeout(r,20))
  await assert.rejects(runner.steer('late'),ACPTimeoutError);await turn
})

await fixture({steerUnsupported:true},async(runner)=>{
  const turn=runner.startTurn('wait');await new Promise(r=>setTimeout(r,20))
  await assert.rejects(runner.steer('rejected'),/Method not found/)
  assert.equal((runner as any).contract.steer,false)
  runner.interrupt();await turn;await runner.startTurn('stable still works')
})

await fixture({malformedState:true},async(runner,events)=>{
  assert.equal((runner as any).contract.nativeGoal,false)
  await assert.rejects(runner.setGoal({objective:'Unverified'}),/未开放/)
  await runner.startTurn('ordinary fallback')
  assert.ok(events.some(event=>event.type==='turn_completed'&&event.state==='success'))
})
await fixture({imageDropped:true},async(runner,events)=>{
  await runner.startTurn('image admission result')
  assert.ok(events.some(event=>event.payload.kind==='warning'&&event.payload.text.includes('图片未送达')))
  assert.equal((runner as any).contract.imageAttachments,true,'an individual drop does not permanently disable image transport')
})
await fixture({goalDisconnect:true},async(runner,_events,frames)=>{
  const completed:any[]=[];runner.on('done',value=>completed.push(value))
  await runner.setGoal({objective:'Disconnect during planning'})
  await until(()=>completed.some(value=>value.failed))
  assert.equal((runner as any).contract.grokNative.confirmed,false)
  assert.equal(runner.isRunning(),true,'unknown native execution keeps the scheduling guard')
  await runner.startTurn('must not replay')
  assert.equal((await frames()).filter(row=>row.frame?.method==='session/prompt').length,1)
})

await fixture({childRunning:true,cancelUnsupported:true},async(runner,events)=>{
  const turn=runner.startTurn('subagent');await until(()=>events.some(event=>event.type==='subagent'))
  await assert.rejects(runner.cancelSubAgent('session-child'),/Method not found/)
  assert.equal((runner as any).contract.structuredSubagents,false)
  runner.interrupt();await turn;await runner.startTurn('ordinary fallback')
})

await fixture({childRunning:true},async(runner,events,frames)=>{
  const turn=runner.startTurn('subagent');await until(()=>events.some(e=>e.type==='subagent'))
  const child=events.find(e=>e.type==='subagent')!.payload.agents[0]
  assert.equal(child.nativeTaskId,'agent-child');assert.equal(child.agentThreadId,'session-child')
  await until(()=>runner.getSubAgentItems('session-child').length>0)
  assert.equal(events.some(e=>e.type==='reasoning'&&e.payload.text==='Child inspecting'),false)
  await assert.rejects(runner.cancelSubAgent('agent-child'),/不属于/)
  await runner.cancelSubAgent('session-child')
  assert.ok((await frames()).some(row=>row.frame?.method==='_x.ai/subagent/cancel'&&row.frame.params.subagentId==='agent-child'))
  runner.interrupt();await turn
})
console.log('grok-native-runner: first use, questions, usage dedupe, planning cancellation, steer races and child ownership passed')
