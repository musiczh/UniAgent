import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, readFile, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { requirementSnapshot } from '../src/main/requirementSpace'
import { requirementCodec } from '../src/main/requirementCodec'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { SettingsService } from '../src/main/settingsService'
import { SETTINGS_SECTIONS } from '../src/shared/settingsDefinition'

const home=await mkdtemp(join(tmpdir(),'requirement-curation-')),store=new RequirementStore(home)
const r=await store.create({name:'聚合需求'})
store.configureContext({requirementId:id=>id==='foreign'?'another':r.id,events:async id=>[{sessionId:id,seq:0,ts:1,type:'user_message',payload:{text:'目标明确，保留条件。'}},{sessionId:id,seq:1,ts:2,type:'agent_message',payload:{text:'已完成修改但尚未验收。'}}]})
const task={title:'任务简介',summary:'保留条件',work:['完成修改'],results:['已报告修改'],verification:['尚未验收'],remaining:['用户验收'],sources:[{kind:'agent' as const,sessionId:'a',seq:1,quote:'已完成修改但尚未验收。'}]}
try{
 const before=(await requirementSnapshot(r))!.revision
 await store.context(r.id,'a',{action:'sync_task',task})
 assert.equal((await store.context(r.id,'a',{action:'sync_task',task:{sources:task.sources,...task}})).unchanged,true)
 await store.context(r.id,'a',{action:'sync_task',task:{...task,remaining:['补充验证','用户验收']}})
 const tasks=await store.context(r.id,'b',{action:'read',documentId:'tasks'})
 assert.equal(tasks.tasks.length,1);assert.equal(tasks.tasks[0].sessionId,'a')
 assert.equal((await requirementSnapshot(r))!.revision,before,'task progress does not invalidate global requirement revision')
 assert.deepEqual((await store.context(r.id,'b',{action:'read',documentId:'task:a'})).task.remaining,['补充验证','用户验收'])
 await assert.rejects(store.context(r.id,'foreign',{action:'sync_task',task}),/不属于/)
 await assert.rejects(store.context(r.id,'a',{action:'sync_task',task},{readOnly:true}),/不能/)
 await assert.rejects(store.context(r.id,'a',{action:'sync_task',task:{...task,sources:[{...task.sources[0],quote:'假的引用'}]}}),/引用/)
 const raw=await store.context(r.id,'b',{action:'read',sessionId:'a',throughSeq:0,limit:5})
 assert.equal(raw.events[0].text,'已完成修改');assert.ok(raw.next)
 await assert.rejects(store.context(r.id,'b',{action:'read',sessionId:'foreign'}),/不属于/)
 await assert.rejects(store.context(r.id,'b',{action:'read',sessionId:'a',throughSeq:-2}),/分页/)
 await assert.rejects(store.context(r.id,'b',{action:'read',sessionId:'a',offset:100000}),/分页/)
 let revision=before
 const initialFiles=await readdir(join(r.dir,'.uniagent'))
 for(let i=0;i<25;i++)revision=(await store.context(r.id,'a',{action:'propose',expectedRevision:revision,operationId:'change-'+i,documents:[{id:'one',kind:'proposal',title:'一个主题',content:'候选版本 '+i}]})).revision
 assert.equal((await readdir(join(r.dir,'proposals'))).length,1,'one aggregate index regardless of update count')
 assert.ok((await readdir(join(r.dir,'.uniagent','checkpoints'))).length<=21)
 assert.equal((await readdir(join(r.dir,'.uniagent'))).includes('bodies'),false)
 assert.equal((await store.context(r.id,'a',{action:'check',expectedRevision:before})).changes.complete,false,'evicted checkpoints explicitly require rereading')
 const current=await requirementSnapshot(r)
 assert.equal(current?.documents.one.content,'候选版本 24')
 // Legacy metadata/body storage remains readable and is packed on the next commit.
 const legacy=await store.create({name:'旧格式兼容'}),snap=(await requirementSnapshot(legacy))!
 await mkdir(join(legacy.dir,'.uniagent','bodies'));await mkdir(join(legacy.dir,'.uniagent','revisions'))
 const metadata:any={}
 for(const [id,doc] of Object.entries(snap.documents)){const {content,...rest}=doc;metadata[id]=rest;await writeFile(join(legacy.dir,'.uniagent','bodies',doc.contentHash+'.md'),content!)}
 const encoded=await requirementCodec('encode',{documents:metadata,operations:{}})
 await writeFile(join(legacy.dir,'.uniagent','revisions',encoded.revision+'.json'),encoded.text)
 await writeFile(join(legacy.dir,'.uniagent','manifest.json'),JSON.stringify({formatVersion:2,revision:encoded.revision}))
 await mkdir(join(legacy.dir,'sources'),{recursive:true})
 await writeFile(join(legacy.dir,'sources','1'.repeat(20)+'.md'),'# 用户原始输入\n\n必须保留的原文。')
 await writeFile(join(legacy.dir,'sources','2'.repeat(20)+'.md'),'# 用户原始输入\n\n必须保留的原文。')
 assert.equal((await requirementSnapshot(legacy))?.revision,encoded.revision)
 const preview=await store.maintainStorage(legacy.id)
 assert.equal(preview.files,4)
 await assert.rejects(store.maintainStorage(legacy.id,'0'.repeat(64)),/变化/)
 await store.maintainStorage(legacy.id,preview.token)
 assert.equal((await store.maintainStorage(legacy.id)).files,0)
 assert.equal((await requirementSnapshot(legacy))?.documents.core.content,snap.documents.core.content)
 assert.ok((await readFile(join(legacy.dir,preview.archive!))).length>0)
 assert.equal((await readdir(join(legacy.dir,'sources'))).length,1,'one original survives duplicate cleanup')
 const beforeImport=(await store.context(r.id,'a',{action:'check'})).revision
 await store.context(r.id,'a',{action:'propose',expectedRevision:beforeImport,operationId:'legacy-important',documents:[{id:'old-important',kind:'proposal',title:'历史重要信息',summary:'目标明确，保留条件。',content:'目标明确，保留条件。',memory:{type:'intent',basis:'user',topic:'登录条件'},sources:[{kind:'user',sessionId:'historical',seq:0,quote:'目标明确，保留条件。'}]}]})
 const revisionBeforeImport=(await store.context(r.id,'a',{action:'check'})).revision
 assert.equal((await store.organizeExisting(r.id)).imported,1)
 assert.equal((await store.organizeExisting(r.id)).imported,0)
 const imported=(await store.taskDigests(r.id)).historical
 assert.equal(imported.coverage,'partial');assert.deepEqual(imported.documentIds,['old-important'])
 assert.equal(imported.results[0],'用户陈述：目标明确，保留条件。')
 assert.equal((await store.context(r.id,'a',{action:'check'})).revision,revisionBeforeImport)
 const config=new AppSettingsStore(home)
 config.set({requirementCuration:{enabled:false,agentId:'codex',model:'cheap'}})
 assert.equal(new AppSettingsStore(home).get().requirementCuration?.model,'cheap')
 config.set({requirementCuration:null});assert.equal(config.get().requirementCuration?.enabled,false)
 config.set({requirementCuration:{enabled:false,agentId:'codex',model:'cheap'}})
 assert.ok(SETTINGS_SECTIONS.some(section=>section.path==='/requirement-tasks/curation'))
 const settings=new SettingsService({appSettings:()=>config.get(),patchSettings:patch=>config.set(patch),agents:()=>[],assistant:async()=>{throw Error('unused')},saveAssistant:async()=>{throw Error('unused')}})
 const section:any=await settings.read('/requirement-tasks/curation')
 assert.equal(section.value.model,'cheap');assert.ok(section.revision)
 await settings.update('/requirement-tasks/curation',{enabled:false},section.revision)
 await assert.rejects(settings.update('/requirement-tasks/curation',{enabled:true},section.revision),/Agent|invalid/)
 const curationAgents = ['codex','claude','traex','qoder','deepseek'].map(adapter=>({id:adapter,name:adapter,adapter,installed:true,
   models:[{id:'cheap',label:'Cheap',efforts:['low'],imageInput:true}],capabilities:{modelSelect:true,startupSystemPrompt:true,imageAttachments:true,streaming:true,protocol:adapter==='deepseek'?'web':'sdk'}}))
 const connectedSettings = new SettingsService({appSettings:()=>config.get(),patchSettings:patch=>config.set(patch),agents:()=>curationAgents as any,assistant:async()=>{throw Error('unused')},saveAssistant:async()=>{throw Error('unused')}})
 for(const agent of curationAgents){
   const current:any=await connectedSettings.read('/requirement-tasks/curation')
   const next:any=await connectedSettings.update('/requirement-tasks/curation',{enabled:true,agentId:agent.id,model:'cheap',effort:'low'},current.revision)
   assert.equal(next.value.agentId,agent.id,'all Agents with system prompt and image support can curate')
 }
 assert.ok(initialFiles.includes('task-digests.json'))
 const emptyConversation=await store.readCurationConversation(r.id)
 assert.equal(emptyConversation.sessionId,'curation-'+r.id);assert.deepEqual(emptyConversation.events,[])
 const nativeId='curation-native-thread', nativeHome=join(r.dir,'.uniagent','curation-runtime','codex'), nativeDir=join(nativeHome,'sessions','2026','11','13')
 await mkdir(nativeDir,{recursive:true})
 const nativeFile=join(nativeDir,'rollout-test-'+nativeId+'.jsonl')
 const line=(type:string,payload:object)=>JSON.stringify({timestamp:'2026-11-13T00:00:00Z',type,payload})+'\n'
 const nativeText=line('session_meta',{id:nativeId,cwd:home})+line('event_msg',{type:'task_started',turn_id:'curation-turn'})+
   line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'只整理已有结论'}]})+
   line('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'已保留来源和未验证状态'}]})+
   line('event_msg',{type:'task_complete',turn_id:'curation-turn'})
 await writeFile(nativeFile,nativeText)
 await store.editCuration(r.id,state=>{state.nativeThreadId=nativeId;state.model='small';state.status='idle'})
 const savedCuration=await readFile(join(r.dir,'.uniagent','curation.json'),'utf8')
 const conversation=await store.readCurationConversation(r.id)
 assert.ok(conversation.events.some(event=>event.type==='user_message'&&event.payload.text==='只整理已有结论'))
 assert.ok(conversation.events.some(event=>event.type==='agent_message'&&event.payload.text==='已保留来源和未验证状态'))
 assert.ok(conversation.events.every(event=>event.sessionId===emptyConversation.sessionId))
 assert.equal(conversation.nativeThreadId,nativeId);assert.equal(conversation.model,'small')
 assert.equal(await readFile(nativeFile,'utf8'),nativeText,'reading never changes the native conversation')
 assert.equal(await readFile(join(r.dir,'.uniagent','curation.json'),'utf8'),savedCuration,'opening does not enqueue or start work')
 await appendFile(nativeFile,line('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'后续整理消息'}]}))
 assert.ok((await new RequirementStore(home).readCurationConversation(r.id)).events.some(event=>event.payload.text==='后续整理消息'),'reopening after restart reads new native messages')
 await store.editCuration(legacy.id,state=>{state.nativeThreadId=nativeId})
 await assert.rejects(store.readCurationConversation(legacy.id),/未找到/,'same thread ID cannot read another requirement home')
 await assert.rejects(store.readCurationConversation('missing'))
 console.log('PASS task summaries, evidence/permissions, scoped raw retrieval, bounded packed checkpoints, legacy reads and shared settings')
}finally{await rm(home,{recursive:true,force:true})}
