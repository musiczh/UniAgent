import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { SettingsService, type SettingsServiceDeps } from '../src/main/settingsService'
import { SETTINGS_SECTIONS, SETTINGS_TOOL, settingSection, validateDefinedAppPatch, type SettingsSection } from '../src/shared/settingsDefinition'
import { WorktreeSettings } from '../src/renderer/components/WorktreeSettings'
import type { AgentDef } from '../src/shared/types'
import type { PersonalAssistant } from '../src/shared/assistant'
import { manageRevision } from '../src/main/assistant/manageValue'
import { DISTRIBUTION_SETTINGS_CATEGORIES } from '../src/shared/settingsNavigation'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'

const root = mkdtempSync(join(tmpdir(),'settings-definition-'))
const store = new AppSettingsStore(root)
let assistant = {id:'personal',enabled:true,defaultAgentId:'codex',autoReviewEnabled:false,createdAt:1,updatedAt:1} as PersonalAssistant
let agents = [{id:'codex',name:'Codex',adapter:'codex',installed:true,defaultModel:'small',models:[{id:'small',label:'Small',efforts:['low','high'],imageInput:true}],capabilities:{modelSelect:true,startupSystemPrompt:true,permissionModes:[{id:'ask',label:'询问'}],attachments:true,streaming:true},lifecycle:{availability:'available'}}] as AgentDef[]
let writes = 0, routerWrites = 0
const deps: SettingsServiceDeps = {
  appSettings:()=>store.get(),patchSettings:patch=>{writes++;validateDefinedAppPatch(patch as Record<string,unknown>);return store.set(patch)},
  assistant:async()=>({assistant,documents:[],review:{status:'idle'}}),
  saveAssistant:async(input,_edits,expected)=>{assert.equal(manageRevision(assistant),manageRevision(expected));assistant={id:'personal',createdAt:1,updatedAt:1,...input};return {assistant,documents:[],review:{status:'idle'}}},
  agents:()=>agents,
  saveRouter:async(config,version)=>{routerWrites++;assert.equal(version,store.get().router!.version);store.set({router:{...config,version:version+1}})},
  recoveryErrors:async()=>{await Promise.resolve();return [{value:'network',label:'网络中断'}]}
}
const service = new SettingsService(deps)
const read = (path: string) => service.read(path) as Promise<any>
const update = async(path: string,patch: unknown) => service.update(path,patch,(await read(path)).revision) as Promise<any>
const worktree = settingSection('/general/worktree')
const future: SettingsSection = {path:'/general/future',title:'新增分组',store:'app',key:'fixtureConfig',fields:{
  fixtureLimit:{type:'integer',label:'测试上限',description:'未来配置项',minimum:1,maximum:5,default:2},
  choices:{type:'array',label:'测试列表',description:'整体替换',default:[1],maxItems:3,uniqueItems:true,items:{type:'integer',minimum:1,maximum:9}},
  detail:{type:'object',label:'测试对象',description:'局部合并',default:{name:'initial',enabled:true},properties:{name:{type:'string'},enabled:{type:'boolean'}}}
}}
try {
  assert.deepEqual(Object.keys(SETTINGS_TOOL.inputSchema.properties),['action','params'])
  assert.deepEqual(SETTINGS_TOOL.inputSchema.required,['action','params'])
  const directory = await read('/')
  assert.equal(directory.kind,'directory');assert.ok(directory.children.some((item:any)=>item.path==='/general'))
  assert.deepEqual(directory.children.map((item:any)=>item.path),DISTRIBUTION_SETTINGS_CATEGORIES.map(category=>'/'+category.id),'root directory follows the settings navigation')
  assert.equal((await read('/history')).readOnly,true,'workflow pages disclose their dedicated entry rather than pretending to be JSON settings')
  assert.equal(JSON.stringify(directory).includes('defaultTaskWorktree'),false,'root discovery must not dump every setting')
  const general = await read('/general')
  assert.ok(general.children.some((item:any)=>item.path==='/general/worktree'))
  const updates = await read('/general/updates/autoCheckUpdate')
  assert.equal(updates.schema.description, INTERNAL_DISTRIBUTION ? '启动时后台检查 Bits 版本目录' : '启动时后台检查 GitHub 公开版本', 'update discovery describes the current distribution source')
  assert.equal(updates.schema.default, true)
  const initial = await read(worktree.path)
  assert.deepEqual(initial.value,{defaultTaskWorktree:false,autoSyncWorktree:false})
  assert.equal(initial.schema.properties.defaultTaskWorktree.default,false)
  assert.equal(initial.schema.properties.autoSyncWorktree.default,false)
  for (const path of ['/requirement-tasks/title/enabled','/requirement-tasks/replies/quickRepliesEnabled']) {
    const setting = await read(path)
    assert.equal(setting.value,false)
    assert.equal(setting.schema.default,false,'MCP defaults agree with persisted settings')
  }
  assert.equal(initial.schema.properties.defaultTaskWorktree.type,'boolean')
  assert.equal(initial.schema.properties.defaultTaskWorktree.description,worktree.fields.defaultTaskWorktree.description)
  await service.update(worktree.path,{autoSyncWorktree:true},initial.revision)
  assert.equal(new AppSettingsStore(root).get().autoSyncWorktree,true)
  assert.equal(store.get().defaultTaskWorktree,false,'partial changes preserve other fields')
  await assert.rejects(service.update(worktree.path,{autoSyncWorktree:false},initial.revision),/revision_conflict/)
  await update('/general/power/preventSleep',true)
  assert.equal(store.get().preventSleep,true,'leaf paths accept typed JSON values')
  assert.notEqual((await read(worktree.path)).revision,initial.revision)
  const groupRevision = (await read(worktree.path)).revision
  await update('/general/power',{preventSleep:false})
  assert.equal((await read(worktree.path)).revision,groupRevision,'unrelated changes do not invalidate a group')
  const beforeInvalid = writes
  for (const patch of [{autoSyncWorktree:'false'},{unknown:true},{autoSyncWorktree:null},[]]) await assert.rejects(update(worktree.path,patch),/invalid_|not_writable/)
  for (const path of ['/general/missing','/general/worktree/__proto__','../general','/general/']) await assert.rejects(read(path),/invalid_|not_found/)
  await assert.rejects(service.update('/general',{},'x'),/directory_not_writable/)
  assert.equal(writes,beforeInvalid)

  await update('/general/recovery',{maxRetries:1,initialDelaySeconds:5,rules:[{id:'deny',effect:'no-retry',description:'保持不重试规则',enabled:true}]})
  await update('/general/recovery',{initialDelaySeconds:120})
  assert.equal(store.get().sessionRecovery!.maxRetries,1)
  assert.equal(store.get().sessionRecovery!.rules[0].effect,'no-retry')
  assert.deepEqual((await read('/general/recovery/selectedErrors')).schema.items.choices,[{value:'network',label:'网络中断'}])
  for (const patch of [{maxRetries:0},{maxRetries:11},{initialDelaySeconds:4},{rules:[{id:'deny',enabled:true}]},{rules:[{id:'a',effect:'retry',description:'a',enabled:true},{id:'a',effect:'retry',description:'b',enabled:true}]}]) await assert.rejects(update('/general/recovery',patch),/invalid_|重复/)
  await update('/general/recovery',{agentId:'codex',model:'small',enabled:true})
  assert.equal(store.get().sessionRecovery!.enabled,true)
  await assert.rejects(update('/general/recovery',{model:'missing'}),/invalid_model/)
  await update('/general/recovery',{enabled:false})

  const title = '/requirement-tasks/title'
  await update(title,{agentId:'codex',model:'small',effort:'high'})
  await update(title,{effort:null})
  assert.equal(store.get().taskTitleGeneration!.effort,undefined,'null explicitly clears optional fields')
  assert.equal(store.get().taskTitleGeneration!.model,'small')
  await assert.rejects(update(title,{effort:'unsupported'}),/invalid_/)
  const choices = await read('/general/recovery/model')
  assert.deepEqual(choices.schema.choices.map((item:any)=>item.value),['small'])
  agents=[...agents,{...agents[0],id:'new-agent',name:'New Agent'}]
  assert.ok((await read('/general/recovery/agentId')).schema.choices.some((item:any)=>item.value==='new-agent'),'dynamic choices reflect the current catalog')

  await update('/requirement-tasks/router',{agentId:'codex',model:'small',effort:'low'})
  assert.equal(routerWrites,1);assert.equal(store.get().router!.version,2)
  await assert.rejects(update('/requirement-tasks/router',{version:100}),/not_writable/)
  const existingAgent=agents[0]
  agents=[{...existingAgent,models:[]},...agents.slice(1)]
  await update(title,{enabled:false})
  await update('/general/recovery',{enabled:false})
  await update('/requirement-tasks/router',{enabled:false})
  assert.equal(store.get().taskTitleGeneration!.enabled,false,'unavailable saved models must not prevent disabling a feature')
  assert.equal(store.get().taskTitleGeneration!.model,'small','disabling preserves the saved selection')
  await assert.rejects(update(title,{enabled:true}),/invalid_model/)
  agents=[existingAgent,...agents.slice(1)]
  await update('/assistants/preferences',{defaultModel:'small',defaultWorkdir:'/fixture'})
  await update('/assistants/preferences',{defaultModel:null})
  assert.equal(assistant.defaultModel,undefined);assert.equal(assistant.defaultWorkdir,'/fixture')
  await service.updateLegacy('assistant',{defaultAgentId:'new-agent',defaultModel:'small'},manageRevision(assistant))
  assert.equal(assistant.defaultAgentId,'new-agent','related legacy fields are validated together')
  await assert.rejects(service.updateLegacy('assistant',{},manageRevision(assistant)),/invalid_settings_patch/)

  store.set({feishu:{enabled:false,appId:'fixture-app',appSecret:'fixture-secret',notifyOnlyWhenLocked:true}})
  assert.equal(JSON.stringify(await read('/assistants/feishu')).includes('fixture-secret'),false)
  assert.deepEqual((await read('/assistants/feishu/appSecret')).value,{configured:true})
  await assert.rejects(update('/assistants/feishu',{appSecret:'replacement'}),/not_writable/)
  await update('/assistants/feishu',{notifyOnlyWhenLocked:false})
  assert.equal(store.get().feishu!.appSecret,'fixture-secret','ordinary patches preserve credentials')
  for (const idleThresholdSec of [1,9,3601]) await assert.rejects(update('/assistants/feishu',{idleThresholdSec}),/invalid_/)

  worktree.fields.fixturePreference={type:'boolean',label:'新增测试设置',description:'统一定义新增字段',default:false}
  SETTINGS_SECTIONS.push(future)
  assert.ok((await read('/general')).children.some((item:any)=>item.path===future.path))
  assert.equal((await read(worktree.path)).schema.properties.fixturePreference.label,'新增测试设置')
  const markup = renderToStaticMarkup(React.createElement(WorktreeSettings,{settings:store.get(),onSaved:()=>{}}))
  assert.ok(markup.includes('新增测试设置'),'the existing page renders a newly defined field without a new JSX row')
  await update(worktree.path,{fixturePreference:true})
  await update(future.path,{fixtureLimit:5})
  await update(future.path,{choices:[2,3],detail:{name:'changed'}})
  const fresh = new AppSettingsStore(root).get() as unknown as Record<string,unknown>
  assert.equal(fresh.fixturePreference,true)
  assert.deepEqual(fresh.fixtureConfig,{fixtureLimit:5,choices:[2,3],detail:{name:'changed',enabled:true}},'new object and array definitions persist without a store or MCP whitelist')
  await update(future.path,{choices:[]})
  assert.deepEqual((new AppSettingsStore(root).get() as any).fixtureConfig.choices,[],'arrays replace instead of appending or merging indexes')
  await assert.rejects(update(future.path,{fixtureLimit:6}),/invalid_fixtureLimit/)
  assert.throws(()=>validateDefinedAppPatch({sessionRecovery:{maxRetries:20}}),/invalid_maxRetries/,'UI writes share the same constraints')
  const blocked=join(root,'blocked');writeFileSync(blocked,'not a directory')
  assert.throws(()=>new AppSettingsStore(blocked).set({preventSleep:true}),/设置保存失败/,'a simple setting write failure must not be reported as applied')
  console.log('PASS settings contract: layered discovery, typed patches, persistence, revisions, nested rules, dynamic choices, native Router routing, credential protection, and new-field UI/MCP discovery')
} finally {
  delete worktree.fields.fixturePreference
  SETTINGS_SECTIONS.splice(SETTINGS_SECTIONS.indexOf(future),1)
  rmSync(root,{recursive:true,force:true})
}
