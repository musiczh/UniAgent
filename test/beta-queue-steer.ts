import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDurableQueueItem, Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { ACPTimeoutError } from '../src/main/acp/acpConnection.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'
const root = await mkdtemp(join(tmpdir(), 'uniagent-beta-queue-steer-'))
try {
  for (const provider of ['deepseek','grok','kimi'] as const) {
    const agent: AgentDef = { id:provider,name:provider,adapter:provider,bin:'/usr/bin/false',icon:'',builtin:true,models:[],capabilities:{modelSelect:false,reasoningEffort:false,permissionModes:[],steer:true} }
    const store = new SessionStore(join(root,provider+'.json'))
    const session: Session = {id:provider,title:provider,status:'running',createdAt:1,nativeSessionId:'native-'+provider,config:{agentId:provider,workdir:root}}
    const host = new Orchestrator(() => agent,store,join(root,'artifacts'))
    const internal = host as any
    internal.sessions.set(provider,session); internal.events.set(provider,[]); internal.seqRefs.set(provider,{n:0})
    let resolve!: (value:any) => void
    let reject!: (error:Error) => void
    let calls=0
    let nativeRunning=false
    const nativeRunner={isRunning:()=>nativeRunning,steer:async()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no})},dispose(){},removeAllListeners(){}}
    internal.protocolRunners.set(provider,nativeRunner)
    const enqueue = () => {const item=buildDurableQueueItem('queued-steer');internal.commitQueue(session,[item]);return item}
    let item=enqueue()
    host.promoteQueueItem(provider,item.id); host.promoteQueueItem(provider,item.id)
    assert.equal(calls,1,'a steering item cannot be submitted twice')
    assert.equal(host.getQueue(provider)[0].state,'steering')
    assert.equal(store.load()[0].pendingQueue?.[0].deliveryUncertain,true,'a restart while native steer is pending cannot replay uncertain delivery')
    assert.equal((await host.getEvents(provider)).length,0,'unacknowledged steer has no delivered user bubble')
    resolve({appendedToTurn:false,nativePromptId:'accepted-followup'})
    await new Promise(done=>setImmediate(done))
    assert.equal(host.getQueue(provider).length,0)
    const delivered=(await host.getEvents(provider)).at(-1)!
    assert.equal(delivered.payload.appendedToTurn,false)
    assert.equal(delivered.payload.nativePromptId,'accepted-followup')
    item=enqueue();host.promoteQueueItem(provider,item.id)
    reject(new ACPTimeoutError('lost delivery receipt'))
    await new Promise(done=>setImmediate(done))
    assert.equal(host.getQueue(provider)[0].deliveryUncertain,true)
    host.promoteQueueItem(provider,item.id)
    assert.equal(calls,2,'delivery uncertainty cannot trigger another native enqueue')
    assert.equal(store.load()[0].pendingQueue?.[0].deliveryUncertain,true)
    item = buildDurableQueueItem('late-steer')
    const backlog = buildDurableQueueItem('after-late-steer')
    internal.commitQueue(session,[item,backlog])
    session.status='running'
    const started:string[]=[]
    internal.prepareUserMessageRun=()=>({input:{},route:'protocol',config:session.config})
    internal.discardPreparedRun=()=>{}
    internal.run=(_session:Session,prompt:string)=>{started.push(prompt);session.status='running';return true}
    host.promoteQueueItem(provider,item.id)
    internal.afterTurn(session)
    await new Promise(done=>setImmediate(done))
    assert.deepEqual(started,[],'the completed turn must wait for its outstanding steer receipt')
    resolve({appendedToTurn:true})
    await new Promise(done=>setImmediate(done))
    await new Promise(done=>setImmediate(done))
    assert.deepEqual(started,['after-late-steer'],'late acknowledged steering must wake the next main queue item exactly once')
    internal.activeQueueItems.delete(provider)
    item=buildDurableQueueItem('accepted-native-followup')
    internal.commitQueue(session,[item,buildDurableQueueItem('waiting-for-native-followup')])
    session.status='running'
    host.promoteQueueItem(provider,item.id)
    internal.afterTurn(session)
    resolve({appendedToTurn:false,nativePromptId:'native-followup'})
    await new Promise(done=>setImmediate(done))
    assert.deepEqual(started,['after-late-steer'],'an accepted native follow-up owns completion and must not start a competing prompt')
    assert.equal(host.getQueue(provider)[0].prompt,'waiting-for-native-followup')
    const receipts:Array<(value:any)=>void>=[]
    nativeRunner.steer=async()=>new Promise(yes=>receipts.push(yes))
    const a=buildDurableQueueItem('native-followup-a'),b=buildDurableQueueItem('native-steer-b'),c=buildDurableQueueItem('backlog-c')
    internal.commitQueue(session,[a,b,c]);session.status='running'
    host.promoteQueueItem(provider,a.id);host.promoteQueueItem(provider,b.id)
    internal.afterTurn(session)
    receipts[0]({appendedToTurn:false,nativePromptId:'active-native-followup'})
    await new Promise(done=>setImmediate(done))
    nativeRunning=true
    receipts[1]({appendedToTurn:true})
    await new Promise(done=>setImmediate(done))
    await new Promise(done=>setImmediate(done))
    assert.equal(started.includes('backlog-c'),false,'another late steer receipt cannot consume backlog owned by an active native follow-up')
    nativeRunning=false
    internal.afterTurn(session)
    await new Promise(done=>setImmediate(done))
    assert.equal(started.filter(prompt=>prompt==='backlog-c').length,1)
    host.disposeAll()
  }
} finally { await rm(root,{recursive:true,force:true}) }
console.log('Beta queue steer: native delivery acknowledgement, follow-up ownership and uncertain delivery persistence passed')
