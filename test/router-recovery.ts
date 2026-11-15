import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import { routerMcpServers } from '../src/main/router/mcp'
import { routerTargetVersion } from '../src/main/router/target'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef, Session } from '../src/shared/types'
import { readRouterTarget } from './fixtures/router-reading'

const root=await mkdtemp(join(tmpdir(),'ua-router-recovery-')),db=new RouterDatabase(join(root,'router.sqlite'))
const store=new Proxy({} as RouterStore,{get(_,key:string){return async(...args:unknown[])=>(db[key as keyof RouterDatabase] as Function).apply(db,args)}})
let config={...DEFAULT_ROUTER_CONFIG,enabled:true},sends=0,delivered=0,created=0
const target:Session={id:'target',title:'原任务',status:'idle',createdAt:1,config:{agentId:'deepseek',workdir:root,projectId:'space'}}
const sessions=new Map([[target.id,target]])
const agent={id:'deepseek',installed:true,adapter:'deepseek',models:[{id:config.model,efforts:['max']}],capabilities:{auxiliarySystemPrompt:true,protocol:'web'}} as AgentDef
const interrupted=db.register({requestId:randomUUID(),prompt:'中断的分配'},config);db.update(interrupted.requestId,1,{state:'routing'})
const uncertain=db.register({requestId:randomUUID(),prompt:'不确定的投递'},config);db.update(uncertain.requestId,1,{state:'committing',targetId:target.id})
const legacy=db.register({requestId:randomUUID(),prompt:'继续原任务的未完事项',execution:{agentId:'codex',workdir:join(root,'other')}},config)
db.update(legacy.requestId,legacy.version,{state:'needs_input',decision:{action:'reuse_task',taskId:target.id,reason:'持续推进'},targetId:target.id,targetTitle:target.title,question:'本次执行配置与原任务不同。按原任务配置继续，还是按本次配置新建？'})
const clarification=db.register({requestId:randomUUID(),prompt:'需要补充归属'},config)
db.update(clarification.requestId,clarification.version,{state:'needs_input',decision:{action:'clarify',reason:'归属不明确',clarification:'请选择空间'},question:'请选择空间'})
const controller=new RouterController(store,{agents:()=>[agent],config:()=>config,saveConfig:value=>{config=value},changed:()=>{},error:()=>{},
  objects:async()=>[{id:'space',kind:'space',title:'空间',summary:'空间',projectId:'space',version:'1'},{id:target.id,kind:'task',title:target.title,summary:'原任务',projectId:'space',version:routerTargetVersion(target),lastBusinessUpdatedAt:Date.now(),
    sources:[{ref:'input:target',title:'原任务目标',text:'继续原任务已经确定的方案和未完事项。',at:1}]}],
  newTask:async()=>{created++;return target},recoverTask:async()=>target,
  orchestrator:{getSessionById:(id:string)=>sessions.get(id),getEvents:async()=>[],managedSessions:()=>[...sessions.values()],
    createRouterDraft:(value:Session['config'],id:string)=>{if(!sessions.has(id))sessions.set(id,{id,title:'Router',config:value,status:'idle',createdAt:1});return sessions.get(id)!},
    updateSessionConfig:(id:string,patch:Partial<Session['config']>)=>Object.assign(sessions.get(id)!.config,patch),
    sendMessage:async(id:string)=>{sends++;sessions.get(id)!.status='running'},acceptRoutedInput:async()=>{delivered++;return {status:'accepted'}},interrupt:()=>{},appendSystemNotice:()=>{}} as any},root)
async function wait(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('router recovery timeout')}
async function call(name:string,args:unknown,authorized=true){const server=routerMcpServers(db.sessionId())![0],env=Object.fromEntries(server.env.map(row=>[row.name,row.value]));const response=await fetch(env.UNIAGENT_ROUTER_ENDPOINT,{method:'POST',headers:{authorization:authorized?'Bearer '+env.UNIAGENT_ROUTER_TOKEN:'Bearer invalid'},body:JSON.stringify({name,arguments:args})});return {status:response.status,body:await response.json()}}
try{
  await controller.recover()
  assert.equal(db.request(interrupted.requestId)?.state,'queued')
  assert.equal(db.request(interrupted.requestId)?.autoRecovery?.attempts,1)
  await controller.cancel(interrupted.requestId,db.request(interrupted.requestId)!.version)
  assert.equal(db.request(uncertain.requestId)?.delivery,'unknown')
  assert.equal(delivered+created,0,'recovery never replays an uncertain business input')
  await wait(()=>db.request(legacy.requestId)?.state==='routing')
  assert.equal(db.request(legacy.requestId)!.question,undefined)
  assert.equal(db.request(legacy.requestId)!.context,undefined)
  assert.equal(db.request(legacy.requestId)!.targetId,undefined)
  assert.match(db.request(legacy.requestId)!.resolution!,/默认按原任务配置继续/)
  assert.equal(db.request(clarification.requestId)!.state,'needs_input','ownership clarification still waits for user input')
  assert.equal(delivered,0,'legacy configuration choices require a fresh candidate reading before delivery')
  const legacyQuery=await readRouterTarget(async(name,args)=>(await call(name,args)).body,legacy.requestId,{kind:'space',projectId:'space'},target.id)
  const legacyDecision={requestId:legacy.requestId,version:legacyQuery.value.version,action:'reuse_task',taskId:target.id,reason:'重新读取后仍需原上下文',...legacyQuery.assignment, reuseAssessment:legacyQuery.assessment}
  assert.equal((await call('router_assign_task',legacyDecision)).body.value.state,'bound')
  assert.equal(delivered,1);assert.equal(created,0)
  assert.equal(target.config.agentId,'deepseek');assert.equal(target.config.workdir,root)
  assert.equal((await call('router_assign_task',legacyDecision)).body.ok,true)
  assert.equal(delivered,1,'recovered configuration choices are delivered once')
  const routerId=db.sessionId();sessions.get(routerId)!.status='idle'
  await controller.event({sessionId:routerId,seq:1,ts:1,type:'turn_completed',state:'success',payload:{}})
  const input={requestId:randomUUID(),prompt:'继续原任务',scope:{kind:'space' as const,projectId:'space'}}
  await controller.submit(input);await wait(()=>db.request(input.requestId)?.state==='routing')
  assert.equal((await call('router_query',{requestId:input.requestId},false)).status,403)
  assert.equal((await call('shell',{requestId:input.requestId})).body.ok,false)
  const query=await readRouterTarget(async(name,args)=>(await call(name,args)).body,input.requestId,{kind:'space',projectId:'space'},target.id)
  target.archived=true
  const stale=await call('router_assign_task',{requestId:input.requestId,version:query.value.version,action:'reuse_task',taskId:target.id,reason:'同目标',...query.assignment, reuseAssessment:query.assessment})
  assert.equal(stale.body.error,'router_target_not_writable');assert.equal(delivered,1,'live target writability is still enforced when indexed metadata omits the archive flag')
  const queued=await controller.submit({requestId:randomUUID(),prompt:'排队输入'})
  await controller.cancel(queued.requestId,queued.version)
  assert.equal(db.request(queued.requestId)?.state,'cancelled')
  assert.equal(sends,2)
  await controller.interrupt()
  assert.equal(db.request(input.requestId)?.state,'cancelled')
  console.log('PASS Router recovery: interrupted routing, unknown delivery without replay, authenticated tools, stale target and queued/active cancellation')
}finally{await controller.close()}
