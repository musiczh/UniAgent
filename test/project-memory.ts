import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import type { RouterStore } from '../src/main/router/store'
import { ProjectMemoryService } from '../src/main/projectMemory'
import { globalMemoryMcpEnv, projectMemoryCli, projectMemoryCliGuide } from '../src/main/router/mcp'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import type { Project, Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-project-memory-')), outside = await mkdtemp(join(tmpdir(), 'ua-project-outside-'))
await writeFile(join(root, 'workspace.ts'), 'export const enabled = true')
await writeFile(join(outside, 'private.ts'), 'private')
await symlink(outside, join(root, 'escape'))
const db = new RouterDatabase(join(root, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
const projects: Project[] = [{ id:'a',name:'项目 A',primaryDirectory:root,additionalDirectories:[],createdAt:1,updatedAt:1 },{ id:'b',name:'项目 B',primaryDirectory:outside,additionalDirectories:[],createdAt:1,updatedAt:1 }]
const session: Session = { id:'session-a',title:'项目任务',createdAt:1,status:'running',config:{agentId:'codex',projectId:'a',workdir:root} }
const events: UAEvent[] = [
  {sessionId:session.id,seq:0,ts:1,type:'user_message',payload:{text:'项目优先复用已有能力',source:'app'}},
  {sessionId:session.id,seq:1,ts:2,type:'command_exec',payload:{output:'工作目录接口位于 workspace.ts'}},
  {sessionId:session.id,seq:2,ts:3,type:'agent_message',payload:{text:'建议增加目录排查记忆'}}
]
let changed=0
const service=new ProjectMemoryService(store,{project:id=>projects.find(p=>p.id===id),session:id=>id===session.id?session:undefined,events:async()=>events,changed:()=>changed++})
let config={...DEFAULT_ROUTER_CONFIG,enabled:false}
const controller=new RouterController(store,{agents:()=>[],config:()=>config,saveConfig:value=>{config=value},orchestrator:{getSessionById:id=>id===session.id?session:undefined,getEvents:async()=>events,managedSessions:()=>[session]} as any,
  projectMemory:(id,args)=>service.forSession(id,args as any),currentProjectMemory:row=>service.isCurrent(row),objects:async()=>[],changed:()=>{},error:()=>{},newTask:async()=>session,recoverTask:async()=>undefined},root)
try {
  const commit={action:'commit' as const,title:'工作目录接口',content:'目录通过 workspace.ts 处理。',type:'architecture' as const,modules:[{path:'workspace.ts'}],source:{seq:1,kind:'tool' as const,quote:'工作目录接口位于 workspace.ts'}}
  await service.forSession(session.id,commit)
  const row=(await service.request('a',{action:'read'})).items[0]
  assert.equal(row.freshness,'verified')
  assert.equal(row.project?.title,'工作目录接口')
  assert.equal('content' in row,false,'directory reads do not load memory bodies')
  await service.forSession(session.id,commit)
  assert.equal(db.memoryHistory(row.id).length,1,'repeating the same source and content is idempotent')
  assert.equal((await service.request('b',{action:'read'})).total,0,'another project does not receive project A memories')
  await assert.rejects(service.forSession(session.id,{action:'read',projectId:'b'}),/scope_conflict/)
  await assert.rejects(service.request('b',{action:'read',id:row.id}),/not_found/)
  await assert.rejects(service.forSession(session.id,{...commit,source:{seq:2,kind:'tool',quote:'建议'}}),/kind_mismatch/)
  await assert.rejects(service.forSession(session.id,{...commit,type:'rule'}),/verified_source/)
  await assert.rejects(service.forSession(session.id,{...commit,source:{seq:1,kind:'tool',quote:'不存在的输出'}}),/source_unavailable/)
  await assert.rejects(service.forSession(session.id,{...commit,modules:[{path:'../private.ts'}]}),/invalid_project_memory_modules/)
  await assert.rejects(service.forSession(session.id,{...commit,modules:[{path:'escape/private.ts'}]}),/code_scope/)
  await assert.rejects(service.forSession(session.id,{...commit,modules:[{path:'workspace.ts',directory:outside}]}),/code_scope/)
  await assert.rejects(service.forSession(session.id,{...commit,content:'password=verySecretValue'}),/credentials/)
  await assert.rejects(service.forSession(session.id,{...commit,source:{seq:0,kind:'unknown' as any,quote:'项目'}}),/invalid_project_memory_source/)
  await assert.rejects(service.request('a',{action:'read',limit:0}),/invalid_project_memory_query/)
  await assert.rejects(service.forSession(session.id,null as any),/invalid_project_memory_request/)
  const detail=await service.forSession(session.id,{action:'read',id:row.id,includeHistory:true})
  assert.equal(detail.document?.content,commit.content)
  assert.equal(detail.history?.length,1)
  assert.equal((await service.request('a',{action:'read',query:'  工作目录  '})).total,1)
  assert.equal((await service.request('a',{action:'read',query:'没有匹配'})).total,0)
  await service.forSession(session.id,{action:'propose',title:'候选',content:'增加目录诊断。',type:'experience'})
  assert.equal((await service.request('a',{action:'read'})).total,1,'candidates are excluded from default reading')
  const candidate=(await service.request('a',{action:'read',category:'pending'})).items[0]
  assert.equal(candidate.status,'candidate')
  await assert.rejects(service.request('a',{action:'confirm',id:candidate.id,expectedRevision:99}),/revision_conflict/)
  await service.request('a',{action:'confirm',id:candidate.id,expectedRevision:candidate.revision})
  assert.equal((await service.request('a',{action:'read'})).total,2)
  await service.request('a',{action:'revoke',id:candidate.id,expectedRevision:candidate.revision+1})
  assert.equal((await service.request('a',{action:'read'})).total,1)
  assert.equal((await service.request('a',{action:'read',id:candidate.id,includeHistory:true})).history?.length,3)
  const firstHistory = await service.request('a',{action:'read',id:candidate.id,includeHistory:true,limit:1})
  assert.equal(firstHistory.historyNextOffset,1)
  const nextHistory = await service.request('a',{action:'read',id:candidate.id,includeHistory:true,offset:1,limit:1})
  assert.equal(firstHistory.history![0].revision,nextHistory.history![0].revision+1)
  await assert.rejects(service.request('a',{action:'confirm',id:candidate.id,expectedRevision:candidate.revision+2}),/revoked/)
  await writeFile(join(root,'workspace.ts'),'export const enabled = false')
  assert.equal((await service.request('a',{action:'read',id:row.id})).document?.freshness,'needs-review','code changes invalidate linked knowledge without dropping saved content')
  await assert.rejects(service.request('a',{action:'confirm',id:row.id,expectedRevision:row.revision}),/source_changed/)
  await service.forSession(session.id,{...commit,id:row.id,expectedRevision:row.revision})
  assert.equal((await service.request('a',{action:'read',id:row.id})).document?.freshness,'verified')
  session.readOnly=true
  assert.equal((await service.forSession(session.id,{action:'read'})).total,1)
  await assert.rejects(service.forSession(session.id,commit),/read_only/)
  session.readOnly=false
  session.config.permissionMode='plan'
  assert.equal((await service.forSession(session.id,{action:'read'})).total,1)
  await assert.rejects(service.forSession(session.id,commit),/read_only/)
  delete session.config.permissionMode
  const guided=await controller.memoryContext(session.id,session.config)
  assert.match(guided,/project_memory/)
  assert.doesNotMatch(guided,/目录通过|工作目录接口|workspace\.ts/,'project memory content, titles and code links are not injected')
  const env=globalMemoryMcpEnv(session.id)
  assert.ok(env.UNIAGENT_PROJECT_MEMORY_TOKEN&&env.UNIAGENT_PROJECT_MEMORY_ENDPOINT)
  assert.equal(env.UNIAGENT_GLOBAL_MEMORY_TOKEN,'','disabled Router does not enable global-memory capability')
  const response=await fetch(env.UNIAGENT_PROJECT_MEMORY_ENDPOINT,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env.UNIAGENT_PROJECT_MEMORY_TOKEN},body:JSON.stringify({name:'project_memory',arguments:{action:'read',id:row.id}})})
  const payload=await response.json()
  assert.equal(payload.ok,true)
  assert.equal(payload.value.document.content,commit.content,'on-demand MCP works while Router is off')
  assert.equal((await controller.memory({action:'read',scope:{kind:'space',projectId:'a'}})).length,1,'Router consumes verified project memories from the same source service')
  const cli=projectMemoryCli(session.id)!
  const cliResult=await promisify(execFile)(cli.command,[...cli.args,JSON.stringify({action:'read',id:row.id})],{env:process.env})
  assert.equal(JSON.parse(cliResult.stdout).document.content,commit.content,'Agents without session MCP use the same scoped on-demand service')
  const cliGuide=projectMemoryCliGuide(session.id)
  assert.doesNotMatch(cliGuide,/目录通过|工作目录接口|workspace\.ts/)
  assert.ok(!cliGuide.includes(env.UNIAGENT_PROJECT_MEMORY_TOKEN),'the guide never includes a capability token')
  const fallback=await controller.memoryContext(session.id,{...session.config,agentId:'kimi'})
  assert.ok(fallback.includes('ELECTRON_RUN_AS_NODE=1')&&fallback.includes('project-memory.cjs'))
  assert.doesNotMatch(fallback,/目录通过|工作目录接口|workspace\.ts/)
  config={...config,enabled:true}
  const enabled=await controller.memoryContext(session.id,session.config)
  assert.doesNotMatch(enabled,/目录通过|工作目录接口|workspace\.ts/,'the legacy global-memory path also excludes project memory')
  assert.ok(changed>=5)
  console.log('PASS project memory: scoped on-demand reads, source/code verification, revision history, candidates, read-only and Router-independent MCP without injection')
} finally {await controller.close();db.close();await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
