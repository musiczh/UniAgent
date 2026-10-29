import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UniAgentManagement, manageRevision, publicManagementValue, type ManagementDeps } from '../src/main/assistant/manage'
import { ManagementDocuments } from '../src/main/assistant/manageDocuments'
import { ASSISTANT_TOOLS, ASSISTANT_REVIEW_TOOLS, type AssistantScope } from '../src/main/assistant/mcp'
import { MANAGE_CONFIRMATION_PREFIX, type ManageOperation } from '../src/shared/uniagentManage'
import type { AppSettings, Session, SessionConfig, UAEvent } from '../src/shared/types'
import type { Requirement } from '../src/shared/requirementTypes'

const directory = await mkdtemp(join(tmpdir(),'uniagent-management-'))
const caller = { id:'assistant', title:'助手', status:'running', createdAt:1, config:{ agentId:'codex',workdir:directory,assistantSnapshot:{} } } as Session
const target = { id:'target', title:'工作任务', status:'awaiting-approval', createdAt:1, config:{ agentId:'codex',workdir:directory } } as Session
let pending: UAEvent[] = [{ sessionId:target.id,seq:1,ts:1,type:'approval_request',state:'pending',payload:{ requestId:'question',kind:'question',params:{ questions:[{ id:'language',question:'使用哪种语言？',options:[{label:'Kotlin'}] }] } } }]
let settings = { schemaVersion:1,autoUpdateAgentsOnLaunch:false,autoCheckUpdate:true,enabledAgentIds:['codex'] } as AppSettings
let creates = 0, answers = 0, deletes = 0, writes = 0
let configUpdates = 0, ignoreConfigUpdates = false
let queued = false
let approve: ((allowed: boolean) => Promise<void>) | undefined
let release: () => void = () => {}
const gate = new Promise<void>(resolve => { release = resolve })
const role = { id:'role',name:'开发者',agentId:'codex',permissionMode:'ask' as const }
const deps = {
  orchestrator: {
    getSessionById:(id: string) => [caller,target].find(s => s.id === id), managedSessions:() => [caller,target],
    pendingSessionRequests:() => pending, loadedSessionEvents:() => [], getEvents:async () => [], getQueue:() => queued ? [{}] : [],
    updateSessionConfig:async (_id: string,patch: Partial<SessionConfig>) => {
      configUpdates++
      if (!ignoreConfigUpdates) target.config = {...target.config,...patch}
      return target
    },
    requestManagementConfirmation:(_id: string,operationId: string,_summary: string,callback: typeof approve) => {
      approve = callback
      pending.push({ sessionId:caller.id,seq:2,ts:2,type:'approval_request',state:'pending',payload:{ requestId:MANAGE_CONFIRMATION_PREFIX+operationId,kind:'question',params:{questions:[{id:'confirm',question:'确认？',options:[{label:'确认执行'}]}]} } })
    }, appendSystemNotice:() => {}
  },
  teams:{ catalog:() => ({projects:[],teams:[]}) }, agents:() => [{id:'codex',name:'Codex',adapter:'codex',
    defaultModel:'gpt-6-astra',models:[{id:'gpt-6-astra',efforts:['low','high'],supportsFast:true},{id:'gpt-6-sol',efforts:['medium']}],
    capabilities:{permissionModes:[{id:'ask'},{id:'read-only'},{id:'full-access'}]}}],
  roles:() => [{role,executable:true}], deleteRole:() => { deletes++; return [] },
  appSettings:() => settings, patchSettings:(patch: Partial<AppSettings>) => { writes++; settings = {...settings,...patch}; return settings },
  assistant:async () => ({assistant:{enabled:true}}),
  createTask:async () => { creates++; await gate; return target }, answerTask:async () => { answers++; pending=[] },
  prepareTaskUpdate:async () => {},
  changed:() => {}
} as unknown as ManagementDeps
const scope = {sessionId:caller.id,active:true,token:'test'} as AssistantScope
const manager = new UniAgentManagement(deps,join(directory,'receipts'))
async function settled(service: UniAgentManagement, id: string): Promise<ManageOperation> {
  for (let i=0;i<200;i++) {
    const receipt = await service.call(scope,{action:'query',resource:'operations',params:{id}}) as ManageOperation
    if (receipt && !['running','awaiting_confirmation'].includes(receipt.state)) return receipt
    await new Promise(resolve => setTimeout(resolve,5))
  }
  throw new Error('operation did not settle')
}
async function execute(operation: string, params: Record<string,unknown>, resource = 'tasks') {
  const operationId = randomUUID()
  await manager.call(scope,{action:'execute',resource,operation,params,operationId})
  return settled(manager,operationId)
}
try {
  assert.equal(ASSISTANT_TOOLS.filter(tool => tool.name === 'uniagent_manage').length,1)
  assert.deepEqual(ASSISTANT_REVIEW_TOOLS.map(tool => tool.name),['assistant_memory','session_search'])
  await assert.rejects(manager.call({...scope,jobId:'review'},{action:'describe'}),/unavailable/)
  await assert.rejects(manager.call({...scope,active:false},{action:'describe'}),/unavailable/)
  assert.deepEqual(publicManagementValue({apiKey:'secret',headers:{Authorization:'secret'},session_context:{session_id:'private'},nested:{password:'secret'}}),{apiKeyConfigured:true,nested:{passwordConfigured:true}})
  assert.equal(manageRevision({a:1,b:2}),manageRevision({b:2,a:1}))

  const operationId = randomUUID(), request = {action:'execute',resource:'tasks',operation:'create',params:{prompt:'创建任务'},operationId}
  await Promise.all([manager.call(scope,request),manager.call(scope,request)])
  release()
  assert.equal((await settled(manager,operationId)).state,'completed')
  assert.equal(creates,1,'concurrent retries must create only one task')
  await assert.rejects(manager.call(scope,{...request,params:{prompt:'其他任务'}}),/operation_id_conflict/)
  const recovered = new UniAgentManagement(deps,join(directory,'receipts'))
  assert.equal((await recovered.call(scope,request) as ManageOperation).state,'completed')
  assert.equal(creates,1,'restart retries must retain the same receipt')
  await recovered.close()

  const question = (await manager.call(scope,{action:'query',resource:'tasks',operation:'pending',params:{sessionId:target.id}}) as any).items[0]
  assert.equal(question.answerable,true)
  assert.equal((await execute('answer',{sessionId:target.id,requestId:'question',answers:{language:'Kotlin'},expectedRevision:'stale'})).state,'failed')
  assert.equal(answers,0)
  assert.equal((await execute('answer',{sessionId:target.id,requestId:'question',answers:{language:'Kotlin'},expectedRevision:question.revision})).state,'completed')
  assert.equal(answers,1)
  assert.equal((await execute('answer',{sessionId:target.id,requestId:'question',answers:{language:'Kotlin'},expectedRevision:question.revision})).state,'failed')

  const deletionId = randomUUID()
  assert.equal((await manager.call(scope,{action:'execute',resource:'roles',operation:'delete',params:{id:role.id,expectedRevision:manageRevision(role)},operationId:deletionId}) as ManageOperation).state,'awaiting_confirmation')
  assert.equal(deletes,0)
  const card = (await manager.call(scope,{action:'query',resource:'tasks',operation:'pending',params:{sessionId:caller.id}}) as any).items[0]
  assert.equal(card.answerable,false,'assistant cannot approve its own host card')
  assert.equal((await execute('answer',{sessionId:caller.id,requestId:card.requestId,answers:{confirm:'确认执行'},expectedRevision:card.revision})).state,'failed')
  assert.equal(deletes,0)
  await approve!(false)
  assert.equal((await settled(manager,deletionId)).state,'cancelled')
  const approvedId = randomUUID()
  await manager.call(scope,{action:'execute',resource:'roles',operation:'delete',params:{id:role.id,expectedRevision:manageRevision(role)},operationId:approvedId})
  await approve!(true)
  assert.equal((await settled(manager,approvedId)).state,'completed')
  assert.equal(deletes,1,'only the host user confirmation may release deletion')

  assert.equal((await execute('update',{section:'app',patch:{autoCheckUpdate:'false'},expectedRevision:manageRevision(settings)},'settings')).state,'failed')
  assert.equal(writes,0,'invalid types must never reach the settings store')
  const list = await manager.call(scope,{action:'query',resource:'tasks',operation:'list'}) as any
  assert.equal(list.items.length,1)
  assert.equal(list.excludedCurrentSessionId,caller.id)

  const description = await manager.call(scope,{action:'describe',resource:'tasks'}) as any
  assert.deepEqual(description.resources.tasks.execute.update.required,['sessionId','patch','expectedRevision'])
  target.status = 'idle'
  target.config = {...target.config,model:'gpt-6-astra',effort:'low',permissionMode:'ask'}
  const configDetail = () => manager.call(scope,{action:'query',resource:'tasks',operation:'detail',params:{sessionId:target.id}}) as Promise<any>
  const updateRequest = (patch: unknown,extra: Record<string,unknown> = {}) => ({action:'execute',resource:'tasks',operation:'update',operationId:randomUUID(),
    params:{sessionId:target.id,patch,expectedRevision:manageRevision(target.config),...extra}})
  const initial = await configDetail()
  assert.equal(initial.config.permissionMode,'ask')
  assert.equal(initial.configRevision,manageRevision(target.config))
  const update = updateRequest({effort:'high',fastMode:true})
  await Promise.all([manager.call(scope,update),manager.call(scope,update)])
  const updated = await settled(manager,update.operationId)
  assert.equal(updated.state,'completed')
  assert.equal(configUpdates,1,'MCP retries must update the existing session only once')
  assert.equal(target.config.effort,'high')
  assert.equal(target.config.fastMode,true)
  assert.equal((updated.result as any).session.configRevision,manageRevision(target.config))
  assert.notEqual((updated.result as any).session.configRevision,initial.configRevision)
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'},{expectedRevision:initial.configRevision})),/revision_conflict/)
  for (const patch of [{},{agentId:'claude'},{workdir:'/other'},{projectId:'other'},{roleSnapshot:{}},{env:{API_KEY:'fake'}},null,[]]) {
    await assert.rejects(manager.call(scope,updateRequest(patch)),/invalid_task_config_patch/)
  }
  for (const patch of [{model:4},{model:'unknown'},{effort:'invalid'},{effort:'medium'},{permissionMode:'invalid'},{fastMode:'true'},{maxMode:true},{kimiThinking:'high'}]) {
    await assert.rejects(manager.call(scope,updateRequest(patch)),/invalid_|不支持/)
  }
  for (const status of ['running','queued','awaiting-approval','cancelling'] as const) {
    target.status=status
    await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/会话.*忙碌/)
  }
  target.status='idle'
  queued=true
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/会话.*忙碌/)
  queued=false
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'},{sessionId:caller.id})),/不能通过管理动作修改/)
  target.readOnly=true
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/不能通过管理动作修改/)
  target.readOnly=false
  target.archived=true
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/归档/)
  target.archived=false
  target.config.roleSnapshot={...role} as SessionConfig['roleSnapshot']
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/角色/)
  delete target.config.roleSnapshot
  target.teamBinding={teamProjectId:'team'} as Session['teamBinding']
  await assert.rejects(manager.call(scope,updateRequest({effort:'low'})),/专家团/)
  delete target.teamBinding
  assert.equal(configUpdates,1,'invalid updates must not reach the orchestrator')

  const declined = updateRequest({permissionMode:'full-access'})
  assert.equal((await manager.call(scope,declined) as ManageOperation).state,'awaiting_confirmation')
  assert.equal(target.config.permissionMode,'ask')
  const permissionCard = (await manager.call(scope,{action:'query',resource:'tasks',operation:'pending',params:{sessionId:caller.id}}) as any).items
    .find((item: any) => item.requestId===MANAGE_CONFIRMATION_PREFIX+declined.operationId)
  assert.equal(permissionCard.answerable,false)
  await approve!(false)
  assert.equal((await settled(manager,declined.operationId)).state,'cancelled')
  assert.equal(configUpdates,1)

  const stalePermission = updateRequest({permissionMode:'full-access'})
  await manager.call(scope,stalePermission)
  target.config={...target.config,effort:'low'}
  await approve!(true)
  assert.match((await settled(manager,stalePermission.operationId)).error!,/revision_conflict/)
  assert.equal(target.config.permissionMode,'ask','user confirmation must not bypass a concurrent configuration change')
  const busyPermission = updateRequest({permissionMode:'full-access'})
  await manager.call(scope,busyPermission)
  target.status='running'
  await approve!(true)
  assert.match((await settled(manager,busyPermission.operationId)).error!,/会话.*忙碌/)
  target.status='idle'

  const approvedPermission = updateRequest({permissionMode:'full-access'})
  await manager.call(scope,approvedPermission)
  assert.equal(configUpdates,1)
  await approve!(true)
  assert.equal((await settled(manager,approvedPermission.operationId)).state,'completed')
  assert.equal(target.config.permissionMode,'full-access')
  assert.equal(configUpdates,2)
  await manager.call(scope,approvedPermission)
  assert.equal(configUpdates,2)
  deps.prepareTaskUpdate=async () => { target.config={...target.config,effort:'high'} }
  const changedDuringPreparation = updateRequest({effort:'high'})
  await manager.call(scope,changedDuringPreparation)
  assert.match((await settled(manager,changedDuringPreparation.operationId)).error!,/revision_conflict/)
  assert.equal(configUpdates,2,'startup readiness must finish before the final revision check')
  deps.prepareTaskUpdate=async () => {}
  ignoreConfigUpdates=true
  const ignoredUpdate = updateRequest({effort:'low'})
  await manager.call(scope,ignoredUpdate)
  assert.equal((await settled(manager,ignoredUpdate.operationId)).state,'failed','an ignored or normalized update must not be reported as applied')
  ignoreConfigUpdates=false
  const modelUpdate = updateRequest({model:'gpt-6-sol',effort:'medium',fastMode:false})
  await manager.call(scope,modelUpdate)
  assert.equal((await settled(manager,modelUpdate.operationId)).state,'completed')
  assert.equal(target.config.model,'gpt-6-sol')
  assert.equal(target.config.effort,'medium')
  assert.equal(target.config.permissionMode,'full-access','a partial patch must preserve unselected configuration')
  assert.equal(target.config.workdir,directory)

  const root = join(directory,'documents'), file = join(root,'context.md'), outside = join(directory,'outside.txt')
  await mkdir(root); await writeFile(file,'中文😀内容'); await writeFile(outside,'private')
  await symlink(outside,join(root,'escape.txt'))
  let attachments = [{...target,submittedUserMessages:[{attachments:[{kind:'file',name:'outside.txt',path:outside}]}]}] as unknown as Session[]
  const documents = new ManagementDocuments({requirements:() => [{id:'requirement',name:'需求',dir:root,docPath:file}] as Requirement[],sessions:() => attachments,teams:() => [],capabilities:async () => ({inventories:[]} as any)})
  const found = await documents.call('search',{source:'requirements'}) as any
  assert.ok(!found.items.some((item: any) => item.path.endsWith('escape.txt')))
  const ref = found.items.find((item: any) => item.path === file)
  let content = '', offset = 0
  for (;;) {
    const chunk = await documents.call('read',{id:ref.id,offset,limit:1}) as any
    content += chunk.content
    if (chunk.nextOffset === undefined) break
    assert.ok(chunk.nextOffset > offset,'UTF-8 pagination must make progress')
    offset=chunk.nextOffset
  }
  assert.equal(content,'中文😀内容')
  const attachment = (await documents.call('search',{source:'session_attachments'}) as any).items[0]
  attachments=[]
  await assert.rejects(documents.call('read',{id:attachment.id}),/owner_changed/)
} finally {
  await manager.close()
  await rm(directory,{recursive:true,force:true})
}
