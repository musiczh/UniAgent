import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagementDeps } from '../src/main/assistant/manage'

const root = await mkdtemp(join(tmpdir(),'assistant-settings-mcp-'))
process.env.UNIAGENT_USER_DATA = root
const { bindAssistantScope,setAssistantScopeActive,assistantMcpEnv,watchAssistantInbox } = await import('../src/main/assistant/mcp')
const { UniAgentManagement } = await import('../src/main/assistant/manage')
const { AppSettingsStore } = await import('../src/main/appSettingsStore')
const { validateDefinedAppPatch } = await import('../src/shared/settingsDefinition')
const handoff = await import('../src/main/handoff')
handoff.ensureHandoffServer()
const store = new AppSettingsStore(join(root,'settings'))
const caller = {id:'assistant',config:{assistantSnapshot:{}}}
const manager = new UniAgentManagement({
  orchestrator:{getSessionById:()=>caller,appendSystemNotice:()=>{}},
  assistant:async()=>({assistant:{enabled:true}}),agents:()=>[],
  appSettings:()=>store.get(),patchSettings:patch=>{validateDefinedAppPatch(patch as Record<string,unknown>);return store.set(patch)},changed:()=>{}
} as unknown as ManagementDeps,join(root,'receipts'))
bindAssistantScope(caller.id);setAssistantScopeActive(caller.id,true)
const errors: unknown[] = []
const stop = await watchAssistantInbox((scope,tool,args)=>{
  assert.equal(tool,'uniagent_settings')
  return manager.callSettings(scope,args)
},error=>errors.push(error))
function client(review = false) {
  const child = spawn(process.execPath,[handoff.handoffServerPath()],{
    env:{...process.env,...assistantMcpEnv(caller.id),UNIAGENT_CALLER_SESSION:caller.id,UNIAGENT_ASSISTANT_ONLY:review?'1':'0'},stdio:['pipe','pipe','pipe']
  })
  let serial=0,buffer='',stderr=''
  const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  child.stderr.on('data',chunk=>{stderr+=chunk.toString()})
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString()
    for(let end;(end=buffer.indexOf('\n'))>=0;){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
      if(!line)continue
      const message=JSON.parse(line),request=pending.get(message.id)
      if(request){clearTimeout(request.timer);pending.delete(message.id);request.resolve(message)}
    }
  })
  child.once('exit',()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('MCP exited: '+stderr))}pending.clear()})
  return {child,rpc(method:string,params:unknown):Promise<any>{
    return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request timed out: '+stderr))},5000)
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
  }}
}
const front = client(), review = client(true)
const call = (args:unknown)=>front.rpc('tools/call',{name:'uniagent_settings',arguments:args})
const result = (message:any)=>{assert.ok(message.result&&!message.result.isError,JSON.stringify(message));return JSON.parse(message.result.content[0].text)}
try {
  const tools = (await front.rpc('tools/list',{})).result.tools
  const settings = tools.filter((tool:any)=>tool.name==='uniagent_settings')
  assert.equal(settings.length,1);assert.deepEqual(Object.keys(settings[0].inputSchema.properties),['action','params'])
  assert.ok(result(await call({action:'read',params:{path:'/'}})).children.some((item:any)=>item.path==='/general'))
  const initial = result(await call({action:'read',params:{path:'/general/worktree'}}))
  const operationId=randomUUID(), request={action:'update',params:{path:initial.path,patch:{autoSyncWorktree:true},expectedRevision:initial.revision,operationId}}
  const applied=result(await call(request))
  assert.equal(applied.state,'completed');assert.equal(store.get().autoSyncWorktree,true)
  assert.equal(result(await call(request)).id,operationId)
  const receipt=result(await call({action:'read',params:{operationId}}))
  assert.equal(receipt.result.value.autoSyncWorktree,true)
  assert.equal(result(await call({action:'read',params:{path:initial.path}})).value.defaultTaskWorktree,false)
  assert.equal((await call({action:'read',params:{path:'/'},extra:true})).result.isError,true)
  const reviewTools=(await review.rpc('tools/list',{})).result.tools.map((tool:any)=>tool.name)
  assert.deepEqual(reviewTools,['assistant_memory','session_search'])
  assert.equal((await review.rpc('tools/call',{name:'uniagent_settings',arguments:{action:'read',params:{path:'/'}}})).error.code,-32000)
  setAssistantScopeActive(caller.id,false)
  const expired=await call({action:'read',params:{path:'/'}})
  assert.equal(expired.result.isError,true);assert.match(expired.result.content[0].text,/scope_expired/)
  assert.deepEqual(errors,[])
  console.log('PASS actual stdio MCP: settings discovery, two-argument contract, JSON update, durable receipt/retry, malformed input and background/expired-scope denial')
} finally {
  for(const {child} of [front,review]) {
    if(child.exitCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited}
  }
  stop();await manager.close();handoff.handoffTaskStore.close()
  await rm(root,{recursive:true,force:true})
}
