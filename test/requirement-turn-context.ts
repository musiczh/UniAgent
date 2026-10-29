import assert from 'node:assert/strict'
import { configureRequirementRuntime, prepareRequirementTurn, cancelRequirementPreparation, setRequirementsEnabled } from '../src/main/requirementRuntime'
import { stripAssistantContext } from '../src/main/assistant/context'
import { Orchestrator } from '../src/main/orchestrator'
import type { Session } from '../src/shared/types'

const session = { id:'ctx-session', nativeSessionId:'native-1', config:{agentId:'codex',workdir:'/work',requirementId:'req-1'}, status:'idle' } as Session
let value = { revision:'one', core:{content:'必须保留登录态'}, state:{content:'实现待验证'}, navigation:[], unresolved:[], sync:{status:'synced'}, migration:{required:false} }
try {
  setRequirementsEnabled(true)
  configureRequirementRuntime(id=>id===session.id?session:undefined, async ()=>value)
  const first=prepareRequirementTurn(session,'继续登录功能')
  const text=await first.ready;first.complete()
  assert.ok(text.includes('必须保留登录态') && text.includes('实现待验证'))
  assert.equal(stripAssistantContext(text),'继续登录功能')
  const second=prepareRequirementTurn(session,'继续');assert.equal(await second.ready,'继续');second.complete()
  value={...value,revision:'two',core:{content:'保留登录态，支持重试'}}
  const changed=prepareRequirementTurn(session,'继续');assert.ok((await changed.ready).includes('支持重试'));changed.complete()
  const eventHost=Object.assign(Object.create(Orchestrator.prototype),{logSession:()=>{}}) as any
  eventHost.logEvent({sessionId:session.id,type:'context_compaction',state:'success',payload:{}})
  const compacted=prepareRequirementTurn(session,'恢复');assert.ok((await compacted.ready).includes('保留登录态'));compacted.complete()
  eventHost.logEvent({sessionId:session.id,type:'context_compaction',state:'success',payload:{}},'side')
  const sideCompacted=prepareRequirementTurn(session,'继续');assert.equal(await sideCompacted.ready,'继续');sideCompacted.complete()
  session.config.agentId='traex'
  const switched=prepareRequirementTurn(session,'继续');assert.ok((await switched.ready).includes('需求资料数据'));switched.complete()

  let release!: (v:any)=>void
  configureRequirementRuntime(()=>session, ()=>new Promise(resolve=>{release=resolve}))
  const pending=prepareRequirementTurn(session,'旧任务')
  assert.equal(cancelRequirementPreparation(session.id),true)
  release(value);await pending.ready
  assert.equal(pending.current(),false,'a cancelled preparation cannot dispatch a stale prompt')
  assert.equal(cancelRequirementPreparation(session.id),false)

  const sent:string[]=[]
  const host=Object.assign(Object.create(Orchestrator.prototype),{
    sessions:new Map([[session.id,session]]),activeQueueItems:new Map(),queues:new Map(),
    setStatus:(s:Session,status:any)=>{s.status=status},runStreaming:(_s:any,_a:any,prompt:string)=>{sent.push(prompt)}
  }) as any
  const prepared={agent:{id:'codex',adapter:'codex'},config:session.config,route:'app-server',input:{}}
  configureRequirementRuntime(()=>session, async()=>value)
  assert.equal(host.run(session,'执行',undefined,undefined,prepared),true)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(sent.length,1);assert.ok(sent[0].includes('保留登录态'));assert.equal(stripAssistantContext(sent[0]),'执行')
  configureRequirementRuntime(()=>session, ()=>new Promise(resolve=>{release=resolve}))
  host.run(session,'已取消',undefined,undefined,prepared)
  cancelRequirementPreparation(session.id);release(value);await new Promise(resolve=>setImmediate(resolve))
  assert.equal(sent.length,1)
  let restored=false
  host.activeQueueItems.set(session.id,'queued-input')
  host.discardPreparedRun=()=>{}
  host.record=()=>{}
  host.restoreQueueItemsToPending=(_s:any,_filter:any,_message:any,options:any)=>{restored=options.releaseActiveItemId==='queued-input';host.activeQueueItems.delete(session.id)}
  configureRequirementRuntime(()=>session,async()=>{throw new Error('unreadable snapshot')})
  host.run(session,'读取失败',undefined,undefined,prepared)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(restored,true,'failed preparation restores the durable queue before any provider send')
  assert.equal(sent.length,1)
  setRequirementsEnabled(false)
  const disabled=prepareRequirementTurn(session,'普通任务');assert.equal(await disabled.ready,'普通任务');disabled.complete()
  console.log('PASS requirement automatic injection, deduplication, compaction, switching and cancelled dispatch')
} finally {configureRequirementRuntime(()=>undefined);setRequirementsEnabled(false)}
