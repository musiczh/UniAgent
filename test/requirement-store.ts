import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { RequirementStore } from '../src/main/requirementStore'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { RequirementDocumentInput, RequirementContextRequest } from '../src/shared/requirementTypes'
import type { UAEvent } from '../src/shared/types'

const home = mkdtempSync(join(tmpdir(), 'uniagent-requirement-store-'))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let passed = 0
async function check(name: string, operation: () => unknown | Promise<unknown>) { await operation(); passed++; console.log('PASS ' + name) }
const events = new Map<string, UAEvent[]>()
const scopes = new Map<string, string>()
const event = (sid: string, seq: number, text: string, type: UAEvent['type'] = 'user_message'): UAEvent =>
  ({ sessionId: sid, seq, ts: seq, type, payload: type === 'command_exec' ? { output: text } : { text } })
try {
  setRequirementsEnabled(true)
  const store = new RequirementStore(home)
  store.configureContext({ events: async id => events.get(id) || [], requirementId: id => scopes.get(id), isTeam: id => id === 'team' })
  const a = await store.create({ name: '共享需求' }), b = await store.create({ name: '另一个需求' })
  for (const sid of ['a','b','team']) { scopes.set(sid, a.id); events.set(sid, [event(sid, 1, '共享需求，保留登录态。'), event(sid, 2, '测试通过', 'command_exec')]) }
  const proof = [{ kind: 'user' as const, sessionId: 'a', seq: 1, quote: '保留登录态' }]
  const read = (id = a.id) => store.context(id, 'a', { action: 'bootstrap' })
  let operation = 0
  const commit = async (documents: RequirementDocumentInput[], extra: Partial<RequirementContextRequest> = {}) => store.context(a.id, 'a',
    { action: 'commit', expectedRevision: (await read()).revision, operationId: 'op-' + ++operation, documents, ...extra })
  await check('bootstrap only exposes core, state and navigation', async () => {
    const c = await read()
    assert.equal(c.formatVersion, 2)
    assert.equal(c.core.kind, 'core'); assert.equal(c.state.kind, 'state')
    assert.deepEqual(c.navigation, [])
    assert.equal(c.recentSources, undefined)
    assert.ok(existsSync(join(a.dir, 'INDEX.md')))
    assert.equal(existsSync(join(a.dir, 'sources')), false)
    assert.ok(readFileSync(join(home, 'requirement-guide.md'), 'utf8').includes('无变化不写'))
    assert.ok(new RequirementStore(home).get(a.id))
  })
  await check('safe names, duplicate names and forged session paths', async () => {
    assert.equal((await store.create({ name: '共享需求' })).name, '共享需求 2')
    const unsafe = await store.create({ name: '../../危险/目录' })
    assert.ok(unsafe.dir.startsWith(join(home, 'requirements') + '/'))
    const config = store.resolveSessionConfig({ agentId: 'codex', workdir: '/w', requirementId: a.id, requirementDir: '/forged', requirementDocPath: '/forged/context.md' })
    assert.equal(config.requirementDocPath, a.docPath)
    assert.ok(config.additionalDirectories?.includes(a.dir))
    setRequirementsEnabled(false)
    try {
      const disabled = store.resolveSessionConfig(config, true)
      assert.equal(disabled.requirementId, a.id)
      assert.equal(disabled.requirementDocPath, undefined)
    } finally { setRequirementsEnabled(true) }
  })
  await check('user evidence required; AI suggestions remain drafts', async () => {
    await assert.rejects(commit([{ id:'core', kind:'core', title:'目标', content:'猜想' }]), /用户原文/)
    await assert.rejects(commit([{ id:'core', kind:'core', title:'目标', content:'伪造', sources:[{...proof[0],quote:'没有说过'}] }]), /原文与引用不符/)
    const c = await read()
    await store.context(a.id, 'a', { action:'propose', expectedRevision:c.revision, operationId:'proposal-1', documents:[{ id:'idea',kind:'proposal', title:'待确认', content:'建议增加新功能' }] })
    const next = await read()
    assert.ok(next.unresolved.some((d: any) => d.id === 'idea'))
    assert.ok(!next.navigation.some((d: any) => d.id === 'idea'))
    assert.ok(!next.core.content.includes('新功能'))
  })
  await check('verified core, scoped topics, dependencies and metadata', async () => {
    await commit([
      { id:'core',kind:'core',title:'共享需求',content:'必须保留登录态。',sources:proof },
      { id:'auth',kind:'spec',title:'登录规则',summary:'登录状态与错误',content:'有效行为与边界',sources:proof,triggers:['登录'] },
      { id:'client',kind:'knowledge',title:'客户端',summary:'已核实链路',content:'代码入口',projectIds:['client'],dependencies:['auth'],sources:[{kind:'tool',sessionId:'a',seq:2,quote:'测试通过'}] }
    ])
    const c = await read()
    assert.equal(c.core.content, '必须保留登录态。')
    assert.equal(c.core.freshness, 'needs-review', 'user confirmation is not a test')
    assert.equal((await store.context(a.id,'a',{action:'read',documentId:'client'})).document.freshness,'verified')
    const scoped = await store.context(a.id,'a',{action:'bootstrap',query:'登录'},{projectId:'server'})
    assert.ok(scoped.navigation.some((d: any)=>d.id==='auth'))
    assert.ok(!scoped.navigation.some((d: any)=>d.id==='client'))
    await assert.rejects(store.context(a.id,'a',{action:'read',documentId:'client'},{projectId:'server'}),/不适用/)
    await commit([{id:'client',kind:'knowledge',title:'客户端',content:'更新代码入口',sources:[{kind:'tool',sessionId:'a',seq:2,quote:'测试通过'}]}])
    const updated=(await store.context(a.id,'a',{action:'read',documentId:'client'})).document
    assert.deepEqual(updated.projectIds,['client'],'content updates preserve the existing project scope')
    assert.deepEqual(updated.dependencies,['auth'],'content updates preserve existing rule dependencies')
    await assert.rejects(commit([{id:'client',kind:'knowledge',title:'客户端',content:'错误元数据',projectIds:null as any,sources:proof}]),/invalid_metadata/)
    await assert.rejects(commit([{id:'bad',kind:'spec',title:'错误',content:'缺失依赖',sources:proof,dependencies:['missing']}]),/缺失或失效依赖/)
  })
  await check('team dispatches, other requirements and assistant replies cannot confirm user requirements', async () => {
    for (const [sid,quote] of [['team','保留登录态'],['outside','保留登录态'],['a','测试通过']]) {
      await assert.rejects(commit([{id:'forged',kind:'spec',title:'伪造',content:'不能生效',sources:[{kind:'user',sessionId:sid,seq:quote==='测试通过'?2:1,quote}]}]))
    }
    await assert.rejects(store.context(a.id,'a',{action:'pending',sessionId:'b'}),/其他会话原文/)
  })
  await check('empty or repeated content causes no revision or snapshot growth', async () => {
    const old = await read()
    const result = await commit([])
    assert.equal(result.revision,old.revision); assert.equal(result.unchanged,true)
    const {updatedAt:_,...core}=old.core
    assert.equal((await commit([core])).revision,old.revision)
  })
  await check('operation retries are idempotent; a reused id cannot change meaning', async () => {
    const base = await read()
    const request: RequirementContextRequest = {action:'commit',expectedRevision:base.revision,operationId:'retry-1',documents:[{id:'state',kind:'state',title:'当前进展',content:'已实现，待验证',sources:proof}]}
    const first = await store.context(a.id,'a',request)
    const retry = await store.context(a.id,'a',request)
    assert.equal(first.revision,retry.revision); assert.equal(retry.duplicate,true)
    await assert.rejects(store.context(a.id,'a',{...request,documents:[]}),/operation_id_reused/)
  })
  await check('pagination is explicit; catalog and topic pages do not silently truncate', async () => {
    await commit([{id:'large',kind:'knowledge',title:'较长材料',content:'甲'.repeat(35000),sources:[{kind:'tool',sessionId:'a',seq:2,quote:'测试通过'}]}])
    let offset=0,text=''
    do { const page=await store.context(a.id,'a',{action:'read',documentId:'large',offset,limit:10000});text+=page.document.content;offset=page.nextOffset } while(offset!==null)
    assert.equal(text,'甲'.repeat(35000))
    const first=await store.context(a.id,'a',{action:'read',offset:0,limit:2})
    assert.equal(first.documents.length,2);assert.equal(first.nextOffset,2)
    await assert.rejects(store.context(a.id,'a',{action:'read',documentId:'large',offset:-1}),/pagination/)
  })
  await check('superseded rules leave active navigation; dependent rules cannot be broken', async () => {
    await assert.rejects(commit([{id:'new-auth',kind:'spec',title:'新登录',content:'新规则',sources:proof,supersedes:'auth'}]),/失效依赖/)
    await commit([{id:'new-auth',kind:'spec',title:'新登录',content:'新规则',sources:proof,supersedes:'auth'},
      {id:'client',kind:'knowledge',title:'客户端',content:'新链路',projectIds:['client'],dependencies:['new-auth'],sources:[{kind:'tool',sessionId:'a',seq:2,quote:'测试通过'}]}])
    assert.ok(!(await read()).navigation.some((d:any)=>d.id==='auth'))
    assert.equal((await store.context(a.id,'a',{action:'read',documentId:'auth'})).document.status,'superseded')
    await assert.rejects(commit([{id:'attack',kind:'knowledge',title:'不能覆盖核心',content:'x',supersedes:'core',sources:proof}]),/supersedes/)
  })
  await check('read-only and background access cannot promote or acknowledge facts', async () => {
    const c=await read()
    await assert.rejects(store.context(a.id,'a',{action:'commit',expectedRevision:c.revision,operationId:'readonly',documents:[]},{readOnly:true}),/只读/)
    await assert.rejects(store.context(a.id,'a',{action:'commit',expectedRevision:c.revision,operationId:'background',documents:[{id:'core',kind:'core',title:'越权',content:'x',sources:proof}]},{background:true}),/后台/)
  })
  await check('two instances serialize; stale writer must merge after reading', async () => {
    const other=new RequirementStore(home);other.configureContext({events:async id=>events.get(id)||[],requirementId:id=>scopes.get(id)})
    const c=await read()
    const results=await Promise.allSettled([store,other].map((s,i)=>s.context(a.id,'a',{action:'commit',expectedRevision:c.revision,operationId:'writer-'+i,documents:[{id:'state',kind:'state',title:'进展',content:'writer-'+i,sources:proof}]})))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/revision_conflict/)
  })
  await check('live disk locks block only the same requirement', async () => {
    const lock=join(home,'requirement-locks',createHash('sha256').update(a.id).digest('hex')+'.lock')
    mkdirSync(lock);writeFileSync(join(lock,'owner'),String(process.pid))
    let finished=false;const pending=read().then(()=>{finished=true})
    await sleep(150);assert.equal(finished,false)
    assert.equal((await read(b.id)).requirement.id,b.id)
    rmSync(lock,{recursive:true});await pending;assert.equal(finished,true)
  })
  await check('another process keeps its lock; exited owner is recovered', async () => {
    const lock=join(home,'requirement-locks',createHash('sha256').update(a.id).digest('hex')+'.lock')
    const child=spawn(process.execPath,['-e','const f=require("node:fs");const p=process.argv[1];f.mkdirSync(p);f.writeFileSync(p+"/owner",String(process.pid));console.log("locked");setTimeout(()=>{f.rmSync(p,{recursive:true});process.exit(0)},400)',lock])
    try {
      await new Promise(resolve=>child.stdout!.once('data',resolve));const start=Date.now();await read();assert.ok(Date.now()-start>200)
      await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve(undefined))
      mkdirSync(lock);writeFileSync(join(lock,'owner'),String(child.pid));await read();assert.equal(existsSync(lock),false)
    } finally {if(child.exitCode===null)child.kill()}
  })
  await check('raw messages are referenced by cursor, pagination preserves long messages', async () => {
    const long=event('a',10,'甲'.repeat(33000));events.get('a')!.push(long)
    await store.recordInput(a.id,long,'user','client')
    await store.finishTurn(a.id,{...long,seq:11,type:'turn_completed',state:'success'})
    await assert.rejects(store.context(a.id,'a',{action:'acknowledge',expectedRevision:(await read()).revision,throughSeq:11}),/未读取/)
    await assert.rejects(store.context(a.id,'a',{action:'pending',throughSeq:10}),/不能跳过/)
    let page=await store.context(a.id,'a',{action:'pending'});let text=page.events[0].text
    assert.equal(page.throughSeq,1, 'the first short event is complete; later long events use an offset')
    while(page.next){page=await store.context(a.id,'a',{action:'pending',...page.next});text+=page.events[0]?.text||''}
    assert.ok(text.endsWith('甲'.repeat(33000)))
    const c=await read()
    await store.context(a.id,'a',{action:'acknowledge',expectedRevision:c.revision,throughSeq:11})
    assert.equal((await read()).sync.status,'synced')
    assert.equal((await read()).revision,c.revision)
    assert.equal(store.get(a.id)?.projectId,'client')
    await store.clearProjectBindings('client');assert.equal(store.get(a.id)?.projectId,undefined)
  })
  await check('failed turn has a visible sync gap but no transcript or completion claim', async () => {
    await store.recordInput(a.id,event('b',20,'未完成研究'))
    await store.finishTurn(a.id,{...event('b',21,''),type:'turn_completed',state:'failed'})
    const c=await read()
    assert.equal(c.sync.pending.find((p:any)=>p.sessionId==='b').status,'interrupted')
    assert.ok(!c.state.content.includes('未完成回复'))
  })
  await check('changed evidence and workspace edits require review; cycles and credentials are rejected', async () => {
    const reference=join(a.dir,'implementation.ts');writeFileSync(reference,'export const state = 1')
    await commit([{id:'observed',kind:'knowledge',title:'已核对实现',content:'当前 state=1',sources:[{kind:'tool',sessionId:'a',seq:2,quote:'测试通过'},{kind:'reference',uri:reference}]}])
    assert.equal((await store.context(a.id,'a',{action:'read',documentId:'observed'})).document.freshness,'verified')
    writeFileSync(reference,'export const state = 2')
    assert.equal((await store.context(a.id,'a',{action:'read',documentId:'observed'})).document.freshness,'needs-review')
    await store.invalidateKnowledge(a.id,'client')
    assert.equal((await store.context(a.id,'a',{action:'read',documentId:'large'})).document.freshness,'needs-review')
    await assert.rejects(commit([{id:'cycle',kind:'spec',title:'循环',content:'x',dependencies:['cycle'],sources:proof}]),/循环依赖/)
    await assert.rejects(commit([{id:'sensitive',kind:'knowledge',title:'敏感',content:'api_key=fixture-secret-value',sources:proof}]),/凭证/)
  })
  await check('core bootstrap does not load unrelated topic bodies; damaged bodies fail closed', async () => {
    const topic=await store.context(a.id,'a',{action:'read',documentId:'large'})
    const body=join(a.dir,'.uniagent','bodies',topic.document.contentHash+'.md'),original=readFileSync(body,'utf8')
    writeFileSync(body,'damaged')
    assert.equal((await read()).core.content,'必须保留登录态。')
    await assert.rejects(store.context(a.id,'a',{action:'read',documentId:'large'}),/正文校验/)
    writeFileSync(body,original)
    const revision=(await read()).revision
    writeFileSync(join(a.dir,'.uniagent','revisions','a'.repeat(64)+'.json'),'{unfinished')
    assert.equal((await read()).revision,revision,'unpublished snapshots never replace the manifest pointer')
  })
  await check('restart recovery finds durable session input without copying it', async () => {
    const recovered=new RequirementStore(home)
    const last=event('after-crash',200,'持久化会话中的新输入')
    recovered.configureContext({events:async()=>[last,{...last,seq:201,type:'turn_completed',state:'cancelled'}],requirementId:()=>a.id})
    assert.equal(await recovered.recoverSession(a.id,'after-crash'),true)
    const cursor=(await read()).sync.pending.find((p:any)=>p.sessionId==='after-crash')
    assert.equal(cursor.throughSeq,201);assert.equal(cursor.status,'interrupted')
    assert.ok(!readFileSync(a.docPath,'utf8').includes('持久化会话中的新输入'))
  })
  await check('sequence zero is retained; steering cannot acknowledge unfinished streamed replies', async () => {
    const zero=await store.create({name:'从零开始'})
    scopes.set('zero',zero.id)
    const transcript=[event('zero',0,'首次输入'),event('zero',1,'尚未写完','agent_message')]
    events.set('zero',transcript)
    await store.recordInput(zero.id,transcript[0])
    let snapshot=await read(zero.id)
    assert.equal(snapshot.sync.pending[0].processedSeq,-1)
    let page=await store.context(zero.id,'zero',{action:'pending'})
    assert.equal(page.events[0].seq,0)
    await assert.rejects(store.context(zero.id,'zero',{action:'acknowledge',expectedRevision:snapshot.revision,throughSeq:0}),/未结束/)
    transcript.push(event('zero',2,'运行中补充'));await store.recordInput(zero.id,transcript[2])
    transcript[1].payload.text='本轮最终完整结论'
    await store.finishTurn(zero.id,{...transcript[0],seq:3,type:'turn_completed',state:'success'})
    page=await store.context(zero.id,'zero',{action:'pending'})
    let content=page.events[0].text
    while(page.next){page=await store.context(zero.id,'zero',{action:'pending',...page.next});content+=page.events[0]?.text||''}
    assert.ok(content.includes('本轮最终完整结论'))
    snapshot=await read(zero.id)
    await store.context(zero.id,'zero',{action:'acknowledge',expectedRevision:snapshot.revision,throughSeq:3})
    assert.equal((await read(zero.id)).sync.status,'synced')
  })
  await check('display projections recover from incomplete writes; symlinks are rejected', async () => {
    writeFileSync(a.docPath,'incomplete projection')
    await read();assert.ok(readFileSync(a.docPath,'utf8').includes('必须保留登录态'))
    const outside=join(home,'outside.md');writeFileSync(outside,'unchanged')
    const path=join(a.dir,'knowledge','large.md');rmSync(path);symlinkSync(outside,path)
    await assert.rejects(store.context(a.id,'a',{action:'read',documentId:'large/../../outside'}))
    assert.equal((await read()).projectionStatus,'ready')
    assert.equal(readFileSync(outside,'utf8'),'unchanged','projection repair must not follow a symlink')
  })
  await check('archive, restore and rename preserve identity, material and snapshot', async () => {
    writeFileSync(join(a.dir,'参考材料.md'),'reference')
    await store.update(a.id,{status:'archived'});assert.equal(store.get(a.id)?.status,'archived')
    await store.update(a.id,{status:'active'})
    const renamed=await store.update(a.id,{name:'共享需求验收'})
    assert.equal(renamed.id,a.id);assert.equal(existsSync(a.dir),false)
    assert.ok(existsSync(join(renamed.dir,'参考材料.md')))
    assert.match(readFileSync(renamed.docPath,'utf8'),/^# 共享需求验收/)
    await assert.rejects(store.update(a.id,{name:'busy'},()=>{throw new Error('busy')}),/busy/)
    assert.equal(store.get(a.id)?.name,'共享需求验收')
  })
  await check('legacy migration is explicit and keeps original sources and full backup', async () => {
    const legacy=await store.create({name:'旧需求'})
    rmSync(join(legacy.dir,'.uniagent'),{recursive:true})
    const original='# 旧需求\n\n## 需求背景\n\n旧背景\n\n## 日志\n\n每轮历史\n'
    writeFileSync(legacy.docPath,original);mkdirSync(join(legacy.dir,'sources'));writeFileSync(join(legacy.dir,'sources','old.md'),'old turn')
    const preview=await read(legacy.id)
    assert.equal(preview.formatVersion,1);assert.equal(readFileSync(legacy.docPath,'utf8'),original)
    await assert.rejects(store.context(legacy.id,'a',{action:'migrate',migrationRevision:'outdated'}),/revision_conflict/)
    await store.context(legacy.id,'a',{action:'migrate',migrationRevision:preview.migration.migrationRevision})
    const migrated=await read(legacy.id)
    assert.equal(migrated.formatVersion,2);assert.ok(!migrated.core.content.includes('旧背景'))
    assert.ok(migrated.unresolved.some((d:any)=>d.id==='legacy-review'))
    assert.equal(readFileSync(join(legacy.dir,'archive','context-v1.md'),'utf8'),original)
    assert.equal(readFileSync(join(legacy.dir,'sources','old.md'),'utf8'),'old turn')
  })
  await check('corrupt indexes and snapshots are not silently reset', async () => {
    const index=join(home,'requirements.json'),original=readFileSync(index,'utf8')
    writeFileSync(index,'{bad');assert.throws(()=>new RequirementStore(home));assert.equal(readFileSync(index,'utf8'),'{bad');writeFileSync(index,original)
    const manifest=join(b.dir,'.uniagent','manifest.json');writeFileSync(manifest,'{bad')
    await assert.rejects(read(b.id))
  })
  console.log('SUMMARY requirement-store: '+passed+' passed')
} finally {setRequirementsEnabled(false);rmSync(home,{recursive:true,force:true})}
