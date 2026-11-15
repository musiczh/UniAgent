import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { RequirementDistiller } from '../src/main/requirementDistiller'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { Session, UAEvent } from '../src/shared/types'

const home=await mkdtemp(join(tmpdir(),'requirement-distiller-')), store=new RequirementStore(home)
const requirement=await store.create({name:'后台整理'})
const sessions=['a','b','c','d','e','f'].map(id=>({id,title:id,status:'idle',config:{agentId:'codex',workdir:home,requirementId:requirement.id}} as Session))
const events=(id:string):UAEvent[]=>[{sessionId:id,seq:0,ts:1,type:'user_message',payload:{text:'需要保留原有登录态'}},{sessionId:id,seq:1,ts:2,type:'agent_message',payload:{text:'**Git 暂存**（没有 commit，没有 push）。已检查登录实现，尚未修改和验证。'}},{sessionId:id,seq:2,ts:3,type:'turn_completed',state:'success',payload:{}}]
store.configureContext({events:async id=>events(id),requirementId:id=>sessions.some(s=>s.id===id)?requirement.id:undefined})
let calls=0, fail=false, release:(()=>void)|undefined, block=false, configured=true, selectedModel='original-model', badCitation=false
const models:string[]=[]
const order:string[]=[], messages:string[]=[]
const options={session:(id:string)=>sessions.find(s=>s.id===id),unsupported:()=>configured?undefined:'未配置',delayMs:60000,
 report:(_id:string,message:string)=>messages.push(message),extract:async(session:Session,prompt:string)=>{
   calls++;order.push(session.id);models.push(selectedModel)
   if(block)await new Promise<void>(resolve=>{release=resolve})
   if(fail&&session.id!=='d')throw new Error('network unavailable')
   if(prompt.includes('只整理检索标签'))return JSON.stringify({labels:['登录']})
   return JSON.stringify({title:'登录任务',summary:'保留登录态',work:['已检查登录实现'],results:['尚未修改'],verification:['尚未验证'],remaining:['继续实现'],citations:[badCitation?{eventIndex:1,quote:'Git 暂存（没有 commit，没有 push）'}:{eventIndex:1,passageId:'p0'}]})
 }}
let worker=new RequirementDistiller(store,options)
try{
 setRequirementsEnabled(true)
 for(let i=0;i<8;i++)worker.schedule(requirement.id,'a')
 worker.schedule(requirement.id,'b')
 block=true
 const run=worker.flush(requirement.id)
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10))
 assert.equal(calls,1)
 const running=await store.readCuration(requirement.id)
 assert.equal(running.status,'running');assert.equal(running.queue.length,1)
 const logicalId=running.sessionId
 selectedModel='next-model'
 await worker.resume(requirement.id,true)
 const queuedDuringRun=await store.readCuration(requirement.id)
 assert.equal(queuedDuringRun.status,'running','adding a queued event must preserve the active job status')
 assert.equal(queuedDuringRun.current?.id,running.current?.id)
 assert.equal(queuedDuringRun.queue.length,1)
 block=false;release!();await run
 assert.deepEqual(order,['a','b']);assert.equal((await store.readCuration(requirement.id)).sessionId,logicalId)
 assert.deepEqual(models,['original-model','next-model'],'configuration changed during a job applies to the next queued invocation')
 assert.equal((await store.readCuration(requirement.id)).queue.length,0)
 assert.equal((await store.taskDigests(requirement.id)).a.origin,'background')
 assert.equal((await store.taskDigests(requirement.id)).a.coverage,'partial')
 assert.equal((await store.taskDigests(requirement.id)).a.sources?.[0].quote,events('a')[1].payload.text,'host restores the exact Markdown passage instead of model-rewritten quotes')
 assert.equal((await store.context(requirement.id,'a',{action:'bootstrap'},{background:true})).unresolved.length,0,'fallback makes one task report, not per-event proposals')
 worker.schedule(requirement.id,'a');await worker.flush(requirement.id);assert.equal(calls,2,'unchanged task does not call model')
 const task={title:'登录任务',summary:'保留登录态',work:['已检查'],results:['尚未完成'],verification:['未运行'],remaining:['实现登录'],sources:[]}
 await store.context(requirement.id,'a',{action:'sync_task',task})
 worker.schedule(requirement.id,'a');await worker.flush(requirement.id)
 assert.equal(calls,3);assert.deepEqual((await store.taskDigests(requirement.id)).a.results,task.results)
 assert.deepEqual((await store.taskDigests(requirement.id)).a.labels,['登录'])
 assert.equal((await store.taskDigests(requirement.id)).a.origin,'agent')
 // Failed jobs are collected without stopping the remaining FIFO.
 fail=true;worker.schedule(requirement.id,'a',false,'reading');worker.schedule(requirement.id,'c');worker.schedule(requirement.id,'d')
 // Add a real short reading input to exercise a model failure.
 const boot=await store.context(requirement.id,'a',{action:'bootstrap'})
 await store.context(requirement.id,'a',{action:'commit',expectedRevision:boot.revision,operationId:'core',documents:[{id:'core',kind:'core',title:'目标',content:'需要保留原有登录态',sources:[{kind:'user',sessionId:'a',seq:0,quote:'需要保留原有登录态'}]}]})
 await worker.flush(requirement.id)
 const failed=await store.readCuration(requirement.id)
 assert.equal(failed.status,'idle','one failure must not stop later jobs')
 assert.equal(failed.queue.length,0)
 assert.equal(failed.failures?.length,2)
 assert.equal((await store.readOverview(requirement.id)).sync?.status,'pending','failed collection remains visible as unfinished work')
 assert.ok((await store.taskDigests(requirement.id)).d,'healthy job after failures is processed')
 await store.editCuration(requirement.id,state=>{for(let i=0;i<45;i++)state.history.push({id:'completed-'+i,at:i,title:'近期任务',detail:'完成',status:'completed'})})
 assert.equal((await store.readCuration(requirement.id)).history.length,40)
 assert.equal((await store.readCuration(requirement.id)).failures?.length,2,'failed collection survives recent-history truncation')
 const beforeRetry=calls;await worker.flush(requirement.id);assert.equal(calls,beforeRetry,'failed jobs do not retry automatically')
 // Reuse context callbacks for restored evidence reads.
 const restored=new RequirementStore(home);restored.configureContext({events:async id=>events(id),requirementId:()=>requirement.id})
 worker.dispose();worker=new RequirementDistiller(restored,{...options,summarize:async()=>JSON.stringify({goal:{text:'需求目标',refs:[{documentId:'core',passageId:'p0'}]},constraints:[],issues:[],next:[],stages:[],requirements:[]})})
 fail=false;worker.schedule(requirement.id,'c');await worker.resume(requirement.id);await worker.flush(requirement.id)
 assert.equal((await restored.readCuration(requirement.id)).failures?.length,2,'restart retains failed jobs independently of recent history')
 assert.equal(calls,beforeRetry,'startup does not silently retry model failures')
 block=true;release=undefined;worker.schedule(requirement.id,'e');worker.schedule(requirement.id,'b');const retryRun=worker.flush(requirement.id)
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10))
 await worker.retryFailed(requirement.id)
 assert.equal((await restored.readCuration(requirement.id)).current?.sessionId,'e','retry does not replace an active job')
 assert.deepEqual((await restored.readCuration(requirement.id)).queue.map(job=>job.sessionId),['b','a','c'],'failed jobs are appended behind already queued work')
 block=false;release!();await retryRun
 assert.equal((await store.readCuration(requirement.id)).sessionId,logicalId)
 assert.equal((await store.readCuration(requirement.id)).status,'idle')
 assert.equal((await store.readCuration(requirement.id)).failures?.length,0,'successful retries remove their failure records')
 // A pre-upgrade blocked head is collected before processing the rest.
 await restored.editCuration(requirement.id,state=>{state.status='failed';state.lastError='任务摘要引用不符';state.queue=[{id:'legacy',sessionId:'c',kind:'task',queuedAt:1},{id:'following',sessionId:'d',kind:'task',queuedAt:2}];state.history.push({id:'legacy',at:1,title:'旧失败任务',detail:'任务摘要引用不符',status:'failed'})})
 const priorCalls=calls;await worker.resume(requirement.id);await worker.flush(requirement.id)
 assert.equal(calls,priorCalls,'legacy failed head is not retried during recovery')
 assert.equal((await restored.readCuration(requirement.id)).failures?.[0].id,'legacy')
 assert.equal((await restored.readCuration(requirement.id)).queue.length,0)
 // Explicit pause keeps the interrupted job pending rather than counting it as a failure.
 block=true;release=undefined;worker.schedule(requirement.id,'f');const pausedRun=worker.flush(requirement.id)
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10))
 await worker.pause(requirement.id);block=false;release!();await pausedRun
 assert.equal((await restored.readCuration(requirement.id)).status,'paused')
 assert.equal((await restored.readCuration(requirement.id)).queue[0].sessionId,'f')
 assert.equal((await restored.readCuration(requirement.id)).failures?.length,1,'pause is not a failed task')
 await worker.resume(requirement.id,true);await worker.flush(requirement.id)
 sessions.push({id:'invalid',title:'引用错误',status:'idle',config:{agentId:'codex',workdir:home,requirementId:requirement.id}} as Session)
 badCitation=true;worker.schedule(requirement.id,'invalid');worker.schedule(requirement.id,'b');await worker.flush(requirement.id)
 assert.equal((await restored.readCuration(requirement.id)).status,'idle')
 assert.ok((await restored.readCuration(requirement.id)).failures?.some(item=>item.sessionId==='invalid'&&item.error.includes('引用不符')),'rewritten quotation is rejected and collected')
 assert.equal((await restored.taskDigests(requirement.id)).invalid,undefined,'invalid evidence is never saved')
 badCitation=false;await worker.retryFailed(requirement.id);await worker.flush(requirement.id)
 assert.ok((await restored.taskDigests(requirement.id)).invalid,'retry can recover by selecting the original host passage')
 configured=false;worker.schedule(requirement.id,'a');await worker.flush(requirement.id)
 assert.equal((await store.readCuration(requirement.id)).status,'unconfigured')
 assert.equal((await store.readCuration(requirement.id)).queue.length,1)
 await worker.pause(requirement.id);await worker.flush(requirement.id)
 assert.equal((await store.readCuration(requirement.id)).status,'paused')
 worker.schedule(requirement.id,'b');await worker.resume(requirement.id);await worker.flush(requirement.id)
 assert.equal((await store.readCuration(requirement.id)).status,'paused','new events and startup preserve explicit pause')
 assert.ok(messages.length)
 console.log('PASS FIFO failure isolation, persistent failed collection/retry, legacy recovery, pause, task aggregation and configuration gating')
}finally{worker.dispose();setRequirementsEnabled(false);await rm(home,{recursive:true,force:true})}
