import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import { routerMcpServers } from '../src/main/router/mcp'
import { routerTargetVersion } from '../src/main/router/target'
import { DEFAULT_ROUTER_CONFIG, type RouterObject } from '../src/shared/router'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-semantic-')), db = new RouterDatabase(join(root, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }, now = Date.now()
const target: Session = { id: 'task', title: '完善路由工作台', createdAt: now, status: 'idle', config: { agentId: 'codex', workdir: root, projectId: 'space', requirementId: 'requirement' } }
const sessions = new Map([[target.id, target]]), inputRef = 'input:task:1'
let delivered = 0, created = 0
let owner='space'
const objects = (): Promise<RouterObject[]> => Promise.resolve([
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '多 Agent 桌面工作台', projectId: 'space', version: '1' },
  { id: 'relocated', kind: 'space', title: '新主空间', summary: '需求的新主空间', projectId: 'relocated', version: '1' },
  { id: 'requirement', kind: 'requirement', title: 'DeepSeek superAgent', summary: '持续推进任务归属和路由体验', projectId: owner, version: '1' },
  { id: target.id, kind: 'task', title: target.title, summary: '继续已确定的任务路由方案', projectId: owner, requirementId: 'requirement', version: routerTargetVersion(target), lastBusinessUpdatedAt: now,
    sources: [{ ref: inputRef, title: '最近输入', text: '继续上轮方案，保留四列看板与原任务上下文。', at: now }] },
  { id: 'archived', kind: 'task', title: '输入框内容', summary: '输入框自动归属', projectId: 'space', requirementId: 'requirement', archived: true, version: '1', lastBusinessUpdatedAt: now },
  { id: 'old', kind: 'task', title: '路由', summary: '旧任务', projectId: 'space', requirementId: 'requirement', version: '1', lastBusinessUpdatedAt: now - 73 * 3600000 }
])
const orchestrator = {
  getSessionById: (id: string) => sessions.get(id), managedSessions: () => [...sessions.values()], getEvents: async () => [],
  createRouterDraft: (value: Session['config'], id: string) => { if (!sessions.has(id)) sessions.set(id, { id, title: 'Router', config: value, status: 'draft', createdAt: now }); return sessions.get(id)! },
  updateSessionConfig: (id: string, value: Partial<Session['config']>) => Object.assign(sessions.get(id)!.config, value),
  sendMessage: async (id: string) => { sessions.get(id)!.status = 'running' }, acceptRoutedInput: async () => { delivered++; return { status: 'accepted' as const } }, appendSystemNotice: () => {}, interrupt: () => {}
}
const controller = new RouterController(store, { config: () => config, saveConfig: () => {}, agents: () => [{ id: 'deepseek', installed: true, adapter: 'deepseek', models: [{ id: config.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef],
  orchestrator: orchestrator as any, objects, changed: () => {}, error: () => {}, newTask: async () => { created++; return target }, recoverTask: async () => undefined }, root)
async function call(name: string, args: unknown) {
  const server = routerMcpServers(db.sessionId())![0], env = Object.fromEntries(server.env.map(row => [row.name, row.value]))
  return (await fetch(env.UNIAGENT_ROUTER_ENDPOINT, { method: 'POST', headers: { authorization: 'Bearer ' + env.UNIAGENT_ROUTER_TOKEN }, body: JSON.stringify({ name, arguments: args }) })).json()
}
try {
  await controller.recover()
  const requestId = randomUUID()
  await controller.submit({ requestId, prompt: '继续上轮路由方案的未完工作' })
  for (let i = 0; i < 100 && db.request(requestId)?.state !== 'routing'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const catalog = await call('router_query', { requestId, mode: 'catalog', kind: 'space' })
  assert.equal(catalog.ok, true, 'Router must expose a readable global directory')
  assert.equal(catalog.value.items[0].title, 'UniAgent')
  const requirementCatalog = await call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space' })
  const briefs = await call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'requirement' } })
  assert.equal(briefs.ok, true)
  assert.deepEqual(briefs.value.items.map((row: RouterObject) => row.id), ['task'], 'semantic coarse reading excludes archived and older-than-72h tasks')
  assert.equal(briefs.value.coverage.complete, true)
  const decision = { requestId, version: briefs.value.version, action: 'reuse_task', taskId: target.id, reason: '继续已确定方案', scanId: briefs.value.snapshotId,
    scopeAssessment: { selectedScope: { kind: 'requirement', requirementId: 'requirement' }, evidenceRefs: [requirementCatalog.value.items.find((row: any) => row.id === 'requirement').evidenceRef], comparedRequirements: [] } }
  await call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'space', projectId: 'space' } })
  const detail = await call('router_query', { requestId, mode: 'task_detail', taskId: target.id })
  assert.equal(detail.ok, true, 'reading another scope must retain the first scope task eligibility')
  const assessment = { taskId: target.id, continuous: true, stronglyRelated: true, contextRequired: true, evidenceRefs: [inputRef], reason: '必须沿用原任务已经确定的四列方案。' }
  const advisory = { ...decision, version: detail.value.version, reuseAssessment: { ...assessment, contextRequired: false } }
  const result = await call('router_assign_task', advisory)
  assert.equal(result.value.state, 'bound'); assert.equal(delivered, 1); assert.equal(created, 0)
  assert.equal((await call('router_assign_task', advisory)).ok, true, 'optional assessments are recorded without blocking the Router decision')
  assert.equal(delivered, 1)
  const routerId=db.sessionId();sessions.get(routerId)!.status='idle'
  await controller.event({sessionId:routerId,seq:10,ts:now,type:'turn_completed',state:'success',payload:{}})
  owner='relocated'
  const conflictId=randomUUID()
  await controller.submit({requestId:conflictId,prompt:'继续上轮路由方案',scope:{kind:'requirement',requirementId:'requirement'},execution:{agentId:'deepseek',workdir:root}})
  for(let i=0;i<100&&db.request(conflictId)?.state!=='routing';i++)await new Promise(resolve=>setTimeout(resolve,10))
  const movedCatalog=await call('router_query',{requestId:conflictId,mode:'catalog',kind:'requirement'})
  const movedScan=await call('router_query',{requestId:conflictId,mode:'task_briefs',selectedScope:{kind:'requirement',requirementId:'requirement'}})
  const movedDetail=await call('router_query',{requestId:conflictId,mode:'task_detail',taskId:target.id})
  const conflict=await call('router_assign_task',{...decision,requestId:conflictId,version:movedDetail.value.version,scanId:movedScan.value.snapshotId,scopeAssessment:{...decision.scopeAssessment,evidenceRefs:[movedCatalog.value.items.find((row:any)=>row.id==='requirement').evidenceRef]},reuseAssessment:assessment})
  assert.equal(conflict.value.state,'bound');assert.equal(conflict.value.question,undefined)
  assert.equal(conflict.value.project,'新主空间','reuse follows logical ownership after requirement rebinding')
  assert.equal(delivered,2);assert.equal(created,0)
  sessions.get(routerId)!.status='idle';await controller.event({sessionId:routerId,seq:11,ts:now,type:'turn_completed',state:'success',payload:{}})
  assert.equal(target.config.projectId,'space');assert.equal(target.config.workdir,root,'the original execution directory is retained')
  console.log('PASS semantic Router: directory, scoped 72h scan, optional detail and assessments, logical ownership and idempotent delivery')
} finally { await controller.close() }
