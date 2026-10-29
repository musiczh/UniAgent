import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { RequirementDistiller } from '../src/main/requirementDistiller'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { Session, UAEvent } from '../src/shared/types'

const home=await mkdtemp(join(tmpdir(),'requirement-distiller-'))
const store=new RequirementStore(home)
const requirement=await store.create({name:'后台整理'})
const session={id:'s',status:'idle',config:{agentId:'codex',workdir:home,requirementId:requirement.id}} as Session
const events:UAEvent[]=[{sessionId:'s',seq:1,ts:1,type:'user_message',payload:{text:'需要保留原有登录态'}}]
store.configureContext({events:async()=>events,requirementId:()=>requirement.id})
const messages:string[]=[]
let calls=0,result=''
const worker=new RequirementDistiller(store,{
  session:()=>session,unsupported:()=>undefined,report:(_id,message)=>messages.push(message),
  extract:async()=>{calls++;return result},delayMs:60000
})
const boot=()=>store.context(requirement.id,'s',{action:'bootstrap'})
try {
  setRequirementsEnabled(true)
  await store.recordInput(requirement.id,events[0])
  await store.finishTurn(requirement.id,{...events[0],seq:2,type:'turn_completed',state:'success'})
  result=JSON.stringify({candidates:[{target:'core',title:'保留登录态',content:'用户提出保留已有登录态，待合并到有效需求',eventIndex:0,quote:'保留原有登录态'}]})
  for(let i=0;i<10;i++)worker.schedule(requirement.id,'s')
  await Promise.all([worker.flush(requirement.id),worker.flush(requirement.id)])
  assert.equal(calls,1,'coalesced task, not a model invocation per notification')
  let c=await boot();assert.equal(c.sync.status,'synced');assert.equal(c.unresolved.length,1)
  assert.ok(!c.core.content.includes('保留原有登录态'),'background cannot activate requirements')
  assert.equal(messages.length,0)
  worker.schedule(requirement.id,'s');await worker.flush(requirement.id);assert.equal(calls,1,'no new input, no new model call')
  assert.equal((await boot()).unresolved.length,1)

  events.push({...events[0],seq:3,payload:{text:'新增验收条件'}});await store.recordInput(requirement.id,events[1])
  await store.finishTurn(requirement.id,{...events[1],seq:4,type:'turn_completed',state:'success'})
  result='invalid JSON'
  worker.schedule(requirement.id,'s');await worker.flush(requirement.id)
  c=await boot();assert.equal(c.sync.status,'pending');assert.equal(c.sync.background.status,'failed');assert.equal(messages.length,1)
  result=JSON.stringify({candidates:[]})
  const revision=c.revision
  worker.schedule(requirement.id,'s');await worker.flush(requirement.id)
  c=await boot();assert.equal(c.sync.status,'synced');assert.equal(c.revision,revision,'no-change extraction writes only the cursor')

  events.push({...events[0],seq:5,payload:{text:'继续'}});await store.recordInput(requirement.id,events[2])
  await store.finishTurn(requirement.id,{...events[2],seq:6,type:'turn_completed',state:'success'})
  const unsupported=new RequirementDistiller(store,{session:()=>session,unsupported:()=> '未验证该 Agent 的受限运行能力',extract:async()=>{throw new Error('must not run')},report:()=>{}})
  unsupported.schedule(requirement.id,'s');await unsupported.flush(requirement.id);unsupported.dispose()
  c=await boot();assert.equal(c.sync.status,'pending');assert.equal(c.sync.background.status,'unsupported')

  session.readOnly=true
  worker.schedule(requirement.id,'s');await worker.flush(requirement.id)
  assert.equal((await boot()).sync.status,'pending')
  session.readOnly=false
  result=JSON.stringify({candidates:[{target:'core',title:'错误证据',content:'错误',eventIndex:0,quote:'用户没有说过'}]})
  worker.schedule(requirement.id,'s');await worker.flush(requirement.id)
  assert.equal((await boot()).sync.status,'pending')
  assert.equal((await boot()).unresolved.length,1)
  const unavailable=new RequirementDistiller({setBackgroundStatus:async()=>{throw new Error('directory unavailable')}} as any,{
    session:()=>session,unsupported:()=> 'unsupported',extract:async()=>{throw new Error('must not run')},report:(_id,message)=>messages.push(message),delayMs:0
  })
  const previousReports=messages.length
  unavailable.schedule(requirement.id,'s')
  await new Promise(resolve=>setTimeout(resolve,20))
  unavailable.dispose()
  assert.equal(messages.length,previousReports+1,'scheduled storage failures are reported without an unhandled rejection')
  console.log('PASS requirement extraction coalescing, candidate-only writes, failure recovery, source proof and capability limits')
} finally {setRequirementsEnabled(false);worker.dispose();await rm(home,{recursive:true,force:true})}
