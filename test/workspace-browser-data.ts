import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { RequirementStore } from '../src/main/requirementStore'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import { scopeSessions, browserAttention, browserRequirementTaskCounts, browserTaskStatus, sessionBrowserLocation } from '../src/renderer/scopeBrowser'
import type { Session, Project } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'workspace-browser-'))
try {
  const prefs = new AppSettingsStore(root)
  assert.equal(prefs.get().spaceRequirementSidebar, true)
  writeFileSync(join(root,'app-settings.json'), JSON.stringify({schemaVersion:1,autoUpdateAgentsOnLaunch:false,requirementsEnabled:false}))
  assert.equal(prefs.get().spaceRequirementSidebar,true,'old settings default on')
  prefs.set({spaceRequirementSidebar:false})
  assert.equal(new AppSettingsStore(root).get().spaceRequirementSidebar,false)
  assert.equal(prefs.set({notificationMode:'off'}).spaceRequirementSidebar,false)
  assert.equal(prefs.get().requirementsEnabled,false,'style never enables the requirement runtime')
  assert.equal(prefs.set({spaceRequirementSidebar:true}).spaceRequirementSidebar,true)
  const failedDir=join(root,'failed');mkdirSync(failedDir);mkdirSync(join(failedDir,'app-settings.json'))
  assert.throws(()=>new AppSettingsStore(failedDir).set({spaceRequirementSidebar:false}),/侧栏样式保存失败/)
  assert.throws(()=>new AppSettingsStore(failedDir).set({spaceRequirementSidebar:true}),/侧栏样式保存失败/,'an unreadable old file cannot masquerade as a successful default-on save')

  setRequirementsEnabled(true)
  const store = new RequirementStore(join(root,'requirements'))
  const req = await store.create({name:'跨空间需求',projectId:'b'})
  const bootstrap = await store.context(req.id,'fixture',{action:'bootstrap'})
  await store.context(req.id,'fixture',{action:'propose',expectedRevision:bootstrap.revision,operationId:'sample-proposal',documents:[{id:'draft',kind:'proposal',title:'待评审资料',content:'仅为建议，不能当作确认。'}]})
  const tree = (path:string):Record<string,string> => Object.fromEntries(readdirSync(path).flatMap(name=>{const file=join(path,name);return statSync(file).isDirectory()?Object.entries(tree(file)).map(([key,text])=>[name+'/'+key,text]):[[name,readFileSync(file,'utf8')]]}))
  const before=tree(req.dir), overview=await store.readOverview(req.id)
  assert.equal(overview.core,undefined);assert.equal(overview.readingStatus,'missing')
  assert.ok((await store.readOverview(req.id,'core')).document?.content)
  assert.equal(overview.documents.find(doc=>doc.id==='draft')?.status,'draft')
  assert.equal(overview.documents.find(doc=>doc.id==='draft') && 'content' in overview.documents.find(doc=>doc.id==='draft')!,false,'detail bodies are loaded on demand')
  assert.match((await store.readOverview(req.id,'draft')).document!.content,/仅为建议/)
  await assert.rejects(()=>store.readOverview(req.id,'../../outside'),/不存在/)
  assert.deepEqual(tree(req.dir),before,'overview and detail reads never modify managed documents or cursors')
  const legacy=await store.create({name:'旧需求'})
  renameSync(join(legacy.dir,'.uniagent'),join(legacy.dir,'.saved-format'))
  const legacyBefore=tree(legacy.dir)
  assert.equal((await store.readOverview(legacy.id)).revision,'legacy')
  assert.deepEqual(tree(legacy.dir),legacyBefore,'a legacy read must not migrate or initialize metadata')

  const task=(id:string,projectId:string,requirementId?:string):Session=>({id,title:id,status:'completed',createdAt:1,config:{agentId:'codex',workdir:'/unchanged/'+projectId,projectId,requirementId}})
  const cross=task('cross','a',req.id), direct=task('direct','b'), other=task('other','a'), archived={...task('archived','b',req.id),archived:true}
  const assistant={...task('assistant','b'),config:{...direct.config,assistantSnapshot:{} as any}}
  const member={...task('tool','b',req.id),handoffId:'internal'}
  const sessions=[cross,direct,other,archived,assistant,member]
  assert.deepEqual(scopeSessions(sessions,{kind:'requirement',id:req.id}).map(s=>s.id),['cross','archived'])
  assert.deepEqual(scopeSessions(sessions,{kind:'space',id:'b'}).map(s=>s.id),['direct'])
  assert.deepEqual(scopeSessions(sessions,{kind:'space',id:'a'},false).map(s=>s.id),['cross','other'],'disabling requirements keeps their tasks accessible by execution space')
  assert.deepEqual(scopeSessions(sessions,{kind:'assistant'}).map(s=>s.id),['assistant'])
  const counts=browserAttention(sessions,[req],{cross:true},{direct:'main',archived:'main',assistant:'main'})
  assert.deepEqual(counts.get('space:b'),{waiting:1,unread:1});assert.equal(counts.has('space:a'),false)
  assert.deepEqual(counts.get('assistant'),{waiting:0,unread:1})
  assert.equal(browserAttention(sessions,[],{cross:true},{},false).get('space:a')?.waiting,1)
  assert.equal(cross.config.workdir,'/unchanged/a')
  const projects=[{id:'a'},{id:'b'}] as Project[]
  assert.deepEqual(sessionBrowserLocation(cross,[req],projects,true),{kind:'requirement',id:req.id})
  assert.deepEqual(sessionBrowserLocation(cross,[req],projects,false),{kind:'space',id:'a'})
  assert.equal(browserTaskStatus(cross),'本轮已结束')
  assert.equal(browserTaskStatus(cross,'running'),'正在执行')
  assert.equal(browserTaskStatus(cross,'completed',true),'需处理')
  const summary = (items: Session[], status = {}, pending = {}, unread = {}) => browserRequirementTaskCounts(items, status, pending, unread).get(req.id)
  assert.equal(summary(sessions), undefined, 'viewed normal results do not retain acceptance reminders')
  assert.deepEqual(summary(sessions, {}, {}, { cross: 'main', assistant: 'main', tool: 'main', archived: 'main', direct: 'main' }), { running: 0, acceptance: 1, waiting: 0, unread: 0 }, 'unviewed normal completion counts once; assistant, tool, archived and direct tasks are excluded')
  assert.deepEqual(summary([cross, { ...cross, updatedAt: 2, archived: true }]), undefined, 'latest duplicate snapshot controls archived membership')
  assert.deepEqual(summary([{ ...cross, updatedAt: 2 }, { ...cross, updatedAt: 1, status: 'running' }], {}, {}, { cross: 'main' }), { running: 0, acceptance: 1, waiting: 0, unread: 0 }, 'older duplicate snapshots cannot add a second task')
  assert.deepEqual(summary([cross], {}, {}, { cross: 'side' }), { running: 0, acceptance: 0, waiting: 0, unread: 1 }, 'unread side conversation progress is not a main result awaiting review')
  assert.deepEqual(summary([cross], { cross: 'running' }, {}, { cross: 'main' }), { running: 1, acceptance: 0, waiting: 0, unread: 1 }, 'live status overrides the persisted reply while existing progress remains visible')
  for (const status of ['queued', 'cancelling', 'waiting_members']) {
    assert.deepEqual(summary([cross], { cross: status }), { running: 1, acceptance: 0, waiting: 0, unread: 0 }, status + ' remains active')
  }
  assert.deepEqual(summary([cross], { cross: 'awaiting-approval' }), { running: 0, acceptance: 0, waiting: 1, unread: 0 }, 'approval is waiting for the user')
  assert.deepEqual(summary([cross], { cross: 'running' }, { cross: true }), { running: 1, acceptance: 0, waiting: 1, unread: 0 }, 'an async question can coexist with execution')
  for (const status of ['error', 'interrupted', 'cancelled'] as const) {
    assert.deepEqual(summary([{ ...cross, status }], {}, {}, { cross: 'main' }), { running: 0, acceptance: 0, waiting: 1, unread: 0 }, status + ' unread errors are not normal result reminders')
  }
  const recovered = { ...cross, status: 'error' as const, recovery: { phase: 'backoff' } as Session['recovery'] }
  assert.deepEqual(summary([recovered]), { running: 1, acceptance: 0, waiting: 0, unread: 0 }, 'automatic recovery still has active work')
  const queued = { ...cross, pendingQueue: [{ id: 'queued', state: 'pending' }] as Session['pendingQueue'] }
  assert.deepEqual(summary([queued]), { running: 1, acceptance: 0, waiting: 0, unread: 0 }, 'pending inputs suppress premature acceptance')
  assert.deepEqual(summary([{ ...cross, taskState: { phase: 'standby', version: 1, updatedAt: 1, awaitingAcceptance: true } }]), undefined, 'user deferral wins over a stale delivery flag')
  assert.deepEqual(summary([{ ...cross, taskState: { phase: 'archived', version: 1, updatedAt: 1, awaitingAcceptance: true } }]), undefined, 'persisted task archive excludes the result')
  assert.deepEqual(summary([{ ...cross, taskState: { phase: 'active', version: 1, updatedAt: 1, awaitingAcceptance: true } }], {}, {}, { cross: 'main' }), { running: 0, acceptance: 1, waiting: 0, unread: 0 }, 'delivery, normal completion and unread progress represent one result task')
  assert.equal(summary([{ ...cross, taskState: { phase: 'active', version: 1, updatedAt: 1, awaitingAcceptance: true } }]), undefined, 'a viewed explicit delivery does not retain an acceptance reminder')
  const empty = { ...cross, status: 'idle' as const }
  assert.equal(summary([empty]), undefined, 'an unused session is not awaiting acceptance')
  assert.equal(summary([{ ...empty, nativeSessionId: 'native' }]), undefined, 'viewed native history does not become unread after restoration')
  assert.deepEqual(summary([{ ...empty, nativeSessionId: 'native' }], {}, {}, { cross: 'main' }), { running: 0, acceptance: 1, waiting: 0, unread: 0 }, 'unviewed restored native replies retain their reminder')
  assert.deepEqual(summary([{ ...empty, taskRegistration: { delivery: 'dispatched' } as Session['taskRegistration'] }], {}, {}, { cross: 'main' }), { running: 0, acceptance: 1, waiting: 0, unread: 0 }, 'an unviewed finished dispatched input counts without a delivery report')
  assert.deepEqual(summary([{ ...cross, taskState: { phase: 'active', version: 1, updatedAt: 1, awaitingAcceptance: false, decisionHint: { count: 3, priority: 'high' } } }]), { running: 0, acceptance: 0, waiting: 1, unread: 0 }, 'multiple pending decisions contribute one task reminder')
  console.log('PASS R03/R04 settings defaults, persistence/failure, read-only managed/legacy context, task scope and attention ownership')
} finally { setRequirementsEnabled(false);rmSync(root,{recursive:true,force:true}) }
