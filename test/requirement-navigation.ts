import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { configureRequirementNavigation } from '../src/main/requirementNavigation'
import { RouterDatabase } from '../src/main/router/database'
import { configureRequirementRuntime, prepareRequirementTurn, setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { Project, Session, UAEvent } from '../src/shared/types'
import type { RequirementDocumentInput } from '../src/shared/requirementTypes'

const root = await mkdtemp(join(tmpdir(),'ua-requirement-navigation-'))
const db = new RouterDatabase(join(root,'router.sqlite'))
try {
  const repo = join(root,'repo'), skill = join(root,'SKILL.md')
  await mkdir(repo); await writeFile(join(repo,'entry.ts'),'export const value = 1'); await writeFile(skill,'# Test Skill')
  const project: Project = { id:'a',name:'项目 A',primaryDirectory:repo,additionalDirectories:[],createdAt:1,updatedAt:1 }
  configureRequirementNavigation({ project: id => id === 'a' ? project : undefined, code: (project,links) => db.memoryReferences(project,links) })
  const store = new RequirementStore(join(root,'data')), requirement = await store.create({name:'代码导航',projectId:'a'})
  const event: UAEvent = { sessionId:'session',seq:1,ts:1,type:'user_message',payload:{text:'需求使用 entry.ts 和 Test Skill。'} }
  const events = [event]
  store.configureContext({ events: async () => events,requirementId: id => id === event.sessionId ? requirement.id : undefined })
  const input: RequirementDocumentInput = { id:'navigation',kind:'spec',title:'代码与能力入口',content:'保留需求关联和真实来源。',sources:[{kind:'user',sessionId:event.sessionId,seq:1,quote:'需求使用 entry.ts 和 Test Skill。'}],
    codeLinks:[{path:'entry.ts',title:'需求入口',reason:'用户指定入口'},{path:'missing.ts',reason:'待核对入口'},{projectId:'removed',path:'foreign.ts',reason:'另一项目关联'}],
    skillLinks:[{name:'test',path:skill,reason:'用于分析需求'},{name:'unknown',reason:'未提供读取入口'},{name:'missing',path:join(root,'missing','SKILL.md'),reason:'已失效入口'}] }
  let revision = (await store.context(requirement.id,event.sessionId,{action:'check'})).revision
  await store.context(requirement.id,event.sessionId,{action:'commit',expectedRevision:revision,operationId:'navigation',documents:[input]})
  const boot = await store.context(requirement.id,event.sessionId,{action:'bootstrap'},{projectId:'a'})
  assert.deepEqual(boot.associations.code.map((row: any) => row.availability),['available','unavailable','unavailable'])
  assert.deepEqual(boot.associations.skills.map((row: any) => row.availability),['available','unknown','unavailable'])
  assert.equal(boot.associations.code[0].documentId,'navigation')
  assert.equal(boot.associations.code[0].basis,'user')
  assert.equal(boot.associations.code[0].projectId,'a')
  assert.deepEqual((await store.readOverview(requirement.id)).associations,boot.associations,'the reader and Agent share navigation without a second material copy')
  assert.equal((await store.context(requirement.id,event.sessionId,{action:'read',documentId:'navigation'})).document.codeLinks[0].path,'entry.ts')
  await assert.rejects(store.context(requirement.id,event.sessionId,{action:'commit',expectedRevision:boot.revision,operationId:'unconfirmed-change',documents:[{...input,codeLinks:[{path:'another.ts',reason:'Agent 分析'}]}]}),/新的用户确认/)
  for (const invalid of [
    {...input,id:'invalid',codeLinks:[{path:'../outside.ts',reason:'路径越界'}]},
    {...input,id:'invalid',codeLinks:[{path:'/private.ts',reason:'绝对路径'}]},
    {...input,id:'invalid',skillLinks:[{name:'bad',reason:'错误格式',path:repo}]}
  ]) await assert.rejects(store.context(requirement.id,event.sessionId,{action:'commit',expectedRevision:boot.revision,operationId:'invalid',documents:[invalid]}),/关联无效/)
  await store.context(requirement.id,event.sessionId,{action:'propose',expectedRevision:boot.revision,operationId:'candidate',documents:[{...input,id:'candidate',codeLinks:[{path:'candidate.ts',reason:'AI 建议'}],skillLinks:[]}]})
  const after = await store.context(requirement.id,event.sessionId,{action:'bootstrap'},{projectId:'a'})
  assert.equal(after.associations.code.some((link: any) => link.path === 'candidate.ts'),false,'candidates cannot become default code navigation')
  const session: Session = {id:event.sessionId,title:'测试',createdAt:1,status:'idle',config:{agentId:'codex',projectId:'a',requirementId:requirement.id,workdir:repo}}
  setRequirementsEnabled(true)
  configureRequirementRuntime(() => session,async () => after)
  const first = prepareRequirementTurn(session,'分析');const text = await first.ready;first.complete()
  assert.ok(!text.includes('entry.ts') && !text.includes('"name":"test"'),'detailed navigation is available on demand, not injected in every turn')
  const repeat = prepareRequirementTurn(session,'继续');assert.equal(await repeat.ready,'继续');repeat.complete()
  await rm(join(repo,'entry.ts'))
  const stale = await store.context(requirement.id,event.sessionId,{action:'bootstrap'},{projectId:'a'})
  assert.equal(stale.associations.code[0].availability,'unavailable')
  assert.equal(stale.revision,after.revision,'availability is read from the current filesystem without rewriting evidence')
  configureRequirementRuntime(() => session,async () => stale)
  const refresh = prepareRequirementTurn(session,'重新检查');assert.ok(!(await refresh.ready).includes('"availability":"unavailable"'));refresh.complete()
  revision = stale.revision
  await store.context(requirement.id,event.sessionId,{action:'commit',expectedRevision:revision,operationId:'withdraw',documents:[{...input,status:'superseded'}]})
  assert.equal((await store.readOverview(requirement.id)).associations?.code.length,0,'withdrawn navigation is not revived from history')
  console.log('PASS requirement code/Skill navigation: real sources, paths, current readability, candidates, withdrawal and Session injection')
} finally { db.close();configureRequirementNavigation();configureRequirementRuntime(() => undefined);setRequirementsEnabled(false);await rm(root,{recursive:true,force:true}) }
