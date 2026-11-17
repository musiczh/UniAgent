import assert from 'node:assert/strict'
import { RouterContextService } from '../src/main/router/context'
import type { Project, Session, UAEvent } from '../src/shared/types'
import type { Requirement, RequirementOverview } from '../src/shared/requirementTypes'
import { titleMetadata } from '../src/shared/taskTitle'
import { RouterDatabase } from '../src/main/router/database'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'

const now = Date.now(), old = now - 80 * 3600000
const task: Session = { id: 'task', title: '最初标题', createdAt: old, updatedAt: now, status: 'idle', config: { agentId: 'codex', projectId: 'execution-space', requirementId: 'req', workdir: '/work' } }
let reads = 0
const events: UAEvent[] = [
  { sessionId: task.id, seq: 1, ts: old, type: 'user_message', payload: { text: '原始方案讨论' } },
  { sessionId: task.id, seq: 2, ts: now - 1000, type: 'user_message', payload: { text: '继续已确定的四列看板方案，补齐任务复用' } },
  { sessionId: task.id, seq: 3, ts: now, type: 'agent_message', payload: { text: '已接入粗读和细读，尚需验证配置冲突。' } },
  { sessionId: task.id, seq: 4, ts: now, type: 'turn_completed', state: 'success', payload: {} }
]
const context = new RouterContextService({ projects: () => [{ id: 'owner', name: 'UniAgent', primaryDirectory: '/repo', updatedAt: old, additionalDirectories: [], createdAt: old } as Project],
  requirements: async () => [{ id: 'req', name: 'Router', projectId: 'owner', createdAt: old, updatedAt: old, status: 'active' } as Requirement],
  overview: async (_id, document) => ({ revision: 'v1', documents: [], document: { id: document, content: document === 'core' ? '目标：持续任务路由。' : '最近完成粗读；下一步验证复用。', summary: '', updatedAt: now } } as RequirementOverview),
  sessions: () => [task], events: async () => { reads++; return events }, seed: () => ({ primaryIntent: '从原始元数据读取的目标，Session 投影没有 seed' }) }, () => now)
const first = await context.objects(), row = first.find(row => row.id === task.id)!
assert.match(row.summary, /四列看板/)
assert.equal(row.projectId, 'owner', 'logical requirement ownership differs from execution directory')
assert.equal(row.lastBusinessUpdatedAt, now)
assert.ok(row.sources?.some(row => row.text.includes('原始方案讨论')), 'the first real business input is the original goal; seed metadata is only a fallback')
assert.ok(row.recentChanges?.some(row => row.text.includes('尚需验证')))
assert.ok(first.find(row => row.id === 'req')?.recentChanges?.length)
await context.objects(); assert.equal(reads, 1, 'unchanged history is not rehydrated for each query')
const input: UAEvent = { sessionId: task.id, seq: 5, ts: now + 10, type: 'user_message', payload: { text: '继续验证原任务的配置冲突' } }
events.push(input); context.observe(input)
assert.match((await context.objects()).find(row => row.id === task.id)!.summary, /配置冲突/)
const historic: Session = { ...task, id: 'old', config: { agentId: 'codex', workdir: '/old' }, createdAt: old, updatedAt: now }
const oldContext = new RouterContextService({ projects: () => [], requirements: async () => [], overview: async () => { throw Error('unused') }, sessions: () => [historic], seed: () => ({ primaryIntent: '旧目标' }),
  events: async () => [{ sessionId: 'old', seq: 0, ts: old, type: 'user_message', payload: { text: '旧输入' } }] }, () => now)
assert.equal((await oldContext.objects())[0].lastBusinessUpdatedAt, old, 'metadata refresh is not business activity')
oldContext.observe({ sessionId: 'old', seq: 1, ts: now, type: 'user_message', payload: { text: '后台恢复', automaticRecovery: true } })
assert.equal((await oldContext.objects())[0].lastBusinessUpdatedAt, old, 'automatic recovery does not extend the window')
const longContext = new RouterContextService({projects:()=>[],requirements:async()=>[{id:'long',name:'长资料',projectId:'owner',createdAt:old,updatedAt:now,status:'active'} as Requirement],sessions:()=>[],events:async()=>[],seed:()=>undefined,
  overview:async(_id,document,offset=0)=>({revision:'v1',documents:[],document:{id:document,content:offset===0?'前半段':'后半段关键约束',summary:'',updatedAt:now},nextOffset:offset===0?3:null} as RequirementOverview)})
assert.equal((await longContext.objects())[0].sources![0].text,'前半段后半段关键约束','long requirement source follows the provider cursor')
const changingContext = new RouterContextService({projects:()=>[],requirements:async()=>[{id:'long',name:'长资料',createdAt:old,updatedAt:now,status:'active'} as Requirement],sessions:()=>[],events:async()=>[],seed:()=>undefined,
  overview:async(_id,document,offset=0)=>({revision:offset===0?'v1':'v2',documents:[],document:{id:document,content:'变化中的内容',updatedAt:now},nextOffset:offset===0?3:null} as RequirementOverview)})
await assert.rejects(changingContext.objects(),/object_revision_changed/,'different revisions are never joined into a fabricated document')
const legacyContext = new RouterContextService({projects:()=>[],requirements:async()=>[{id:'legacy',name:'旧需求',createdAt:old,updatedAt:old,status:'active'} as Requirement],sessions:()=>[],events:async()=>[],seed:()=>undefined,
  overview:async(_id,document)=>{if(document==='state')throw new Error('需求文档不存在');return {revision:'legacy',documents:[],document:{id:'core',content:'真实的旧需求目标',updatedAt:old}} as RequirementOverview}})
assert.equal((await legacyContext.objects())[0].sources![0].text,'真实的旧需求目标','a legacy requirement without a state document still routes from its real core source')

const descriptionTask: Session = { ...task, id: 'described', taskMetadata: { ...titleMetadata({ id: 'described', title: '任务' }, false),
  description: '完成模型接入及能力验收，沿用已确认的模型映射规则，继续处理未通过项。', generatedInputId: 'turn-1', generatedAt: now, generationState: 'ready' } }
let latestInputId = 'turn-1'
const descriptionContext = new RouterContextService({ projects: () => [], requirements: async () => [], sessions: () => [descriptionTask],
  overview: async () => { throw Error('unused') }, events: async () => events.map(event => ({ ...event, sessionId: descriptionTask.id })),
  seed: () => ({ primaryIntent: '早期可行性调研', inputId: latestInputId }) }, () => now)
let described = (await descriptionContext.objects())[0]
assert.ok(described.sources?.some(source => source.text === descriptionTask.taskMetadata!.description), 'whole-task description is a real Router source')
const descriptionDirectory = await mkdtemp(join(tmpdir(), 'router-description-context-'))
const tempRoots = [descriptionDirectory]
const db = new RouterDatabase(join(descriptionDirectory, 'router.sqlite'), undefined, () => now)
try {
  await db.index([described])
  assert.equal(db.object(described.id).description?.text, descriptionTask.taskMetadata!.description, 'Router uses the task description without another model summary')
  assert.equal(db.object(described.id).description?.freshness, 'ready')
  assert.equal((await db.descriptionJobs()).some(job => job.id === described.id), false, 'a supplied description does not start a second summary')
  const request = db.register({ requestId: randomUUID(), prompt: '继续能力验收' }, DEFAULT_ROUTER_CONFIG)
  let detail = await db.detail(request.requestId, described.id)
  assert.deepEqual(detail.item.descriptionCoverage, { inputId: 'turn-1', currentInputId: 'turn-1' })
  const businessAt = described.lastBusinessUpdatedAt
  latestInputId = 'turn-2'; descriptionTask.taskMetadata!.version++
  described = (await descriptionContext.objects())[0]; await db.index([described])
  detail = await db.detail(request.requestId, described.id)
  assert.equal(detail.item.freshness, 'stale', 'description that predates the latest input is not current even if title state is ready')
  assert.equal(detail.item.description, descriptionTask.taskMetadata!.description, 'retain the last description together with recent inputs')
  assert.deepEqual(detail.item.descriptionCoverage, { inputId: 'turn-1', currentInputId: 'turn-2' })
  assert.equal(described.lastBusinessUpdatedAt, businessAt, 'description metadata is not business activity')
} finally { db.close() }

const coreText = '需求总体目标：按业务对象组织项目、需求和任务，持续管理路由、上下文与决策。'
const routingContext = new RouterContextService({ projects: () => [], sessions: () => [], seed: () => undefined, events: async () => [],
  requirements: async () => [{ id: 'missing-cache', name: '需求', createdAt: old, updatedAt: old, status: 'active' } as Requirement],
  overview: async () => { throw Error('routing sources are authoritative') },
  routing: async () => ({ snapshot: { status: 'missing', sourceRevision: 'revision' }, sources: { revision: 'revision', documents: [
    { id: 'a-local-spec', title: '局部规格', kind: 'spec', content: '移除列折叠按钮。'.repeat(500), updatedAt: now },
    { id: 'core', title: '需求总览', kind: 'core', content: coreText, updatedAt: old }
  ] } }) as any }, () => now)
const missingCache = (await routingContext.objects())[0]
assert.ok(missingCache.summary.startsWith(coreText), 'core goal precedes local specs regardless of document id order')
assert.equal(missingCache.sources![0].text, coreText, 'the summary job receives core before local specs')

try {
const projectRoot = await mkdtemp(join(tmpdir(), 'ua-router-project-'))
tempRoots.push(projectRoot)
await writeFile(join(projectRoot, 'README.md'), '项目用途：统一多 Agent 桌面工作台。\n业务对象：会话、任务、项目与需求。')
const localRequirement = '局部需求：只描述本次列表按钮调整，不代表整个项目范围。'
const projectContext = new RouterContextService({ projects: () => [{ id: 'owner', name: 'UniAgent', primaryDirectory: projectRoot, additionalDirectories: [], createdAt: old, updatedAt: old } as Project],
  requirements: async () => [{ id: 'local', name: '局部需求', projectId: 'owner', createdAt: old, updatedAt: old, status: 'active' } as Requirement],
  overview: async (_id, document) => ({ revision: 'r1', documents: [], document: { id: document, content: localRequirement, summary: localRequirement, updatedAt: now } } as RequirementOverview),
  sessions: () => [], events: async () => [], seed: () => undefined }, () => now)
const projectObjects = await projectContext.objects(), project = projectObjects.find(row => row.id === 'owner')!
assert.ok(project.sources?.some(source => source.kind === 'document' && source.uri === join(projectRoot, 'README.md') && source.text.includes('项目用途')), 'the project README is read as bounded project evidence')
assert.equal(project.sources?.some(source => source.kind === 'document' && source.uri === join(projectRoot, 'README.md') && source.truncated), false)
assert.ok(project.summary.includes('项目用途'), 'project summary is the project definition, not a local requirement opening')
assert.ok(!project.summary.startsWith(localRequirement), 'a local requirement is not promoted to the whole project scope')
const missingRoot = await mkdtemp(join(tmpdir(), 'ua-router-project-missing-'))
tempRoots.push(missingRoot)
const missingProjectContext = new RouterContextService({ projects: () => [{ id: 'owner', name: 'UniAgent', primaryDirectory: missingRoot, additionalDirectories: [], createdAt: old, updatedAt: old } as Project],
  requirements: async () => [{ id: 'local', name: '局部需求', projectId: 'owner', createdAt: old, updatedAt: old, status: 'active' } as Requirement],
  overview: async (_id, document) => ({ revision: 'r1', documents: [], document: { id: document, content: localRequirement, summary: localRequirement, updatedAt: now } } as RequirementOverview),
  sessions: () => [], events: async () => [], seed: () => undefined }, () => now)
const missingProject = (await missingProjectContext.objects()).find(row => row.id === 'owner')!
const unknownEntry = missingProject.sources?.find(source => source.kind === 'reference')
assert.ok(unknownEntry, 'missing project definition remains an explicit unread entry')
assert.match(unknownEntry!.text, /未读取/)
assert.ok(!missingProject.summary.startsWith(localRequirement), 'missing project definition is not filled with a local requirement excerpt')

const longEvents: UAEvent[] = [
  { sessionId: 'long-history', seq: 0, ts: now - 300, type: 'user_message', payload: { text: '最初的可行性调研目标' } },
  { sessionId: 'long-history', seq: 1, ts: now - 299, type: 'user_message', payload: { text: '第 2 条记录中的最新模型补测要求' } }
]
for (let index = 2; index < 262; index++) longEvents.push({ sessionId: 'long-history', seq: index, ts: now - 300 + index, type: 'turn_completed', payload: {} })
assert.equal(longEvents.slice(-200).findLast(event => event.type === 'user_message'), undefined, 'the old 200-event tail would lose both the original and latest user input')
const longSession: Session = { id: 'long-history', title: '长历史任务', createdAt: now - 300, updatedAt: now, status: 'idle', config: { agentId: 'codex', projectId: 'owner', workdir: '/long' } }
const longHistoryContext = new RouterContextService({ projects: () => [], requirements: async () => [], sessions: () => [longSession], events: async () => longEvents,
  seed: () => undefined, overview: async () => { throw Error('unused') } }, () => now)
const hydrated = await longHistoryContext.detail('long-history')
assert.equal(hydrated?.sources?.find(source => source.role === 'current_input')?.text, '第 2 条记录中的最新模型补测要求', 'the latest business input is found beyond the first 200 events')
const longHistoryDirectory = await mkdtemp(join(tmpdir(), 'ua-router-long-history-'))
tempRoots.push(longHistoryDirectory)
const longDb = new RouterDatabase(join(longHistoryDirectory, 'router.sqlite'), undefined, () => now)
try {
  await longDb.index([hydrated!])
  const request = longDb.register({ requestId: randomUUID(), prompt: '继续长历史任务' }, DEFAULT_ROUTER_CONFIG)
  const longDetail = await longDb.detail(request.requestId, 'long-history')
  assert.equal(longDetail.current.find(row => row.role === 'current_input')?.text, '第 2 条记录中的最新模型补测要求', 'current material remains the newest user input even outside the legacy 200-event tail')
  assert.equal(longDetail.current.find(row => row.role === 'original_goal')?.text, '最初的可行性调研目标')
  assert.deepEqual(longDetail.current.map(row => row.role), ['current_input', 'status', 'original_goal'])
} finally { longDb.close() }

const activityEvents: UAEvent[] = [
  { sessionId: 'activity-task', seq: 0, ts: now - 20, type: 'user_message', payload: { text: '原始目标' } },
  { sessionId: 'activity-task', seq: 1, ts: now - 10, type: 'agent_message', payload: { text: '早期回答' } },
  { sessionId: 'activity-task', seq: 2, ts: now - 3, type: 'user_message', payload: { text: '当前用户输入' } },
  { sessionId: 'activity-task', seq: 3, ts: now - 2, type: 'agent_message', payload: { text: '当前 Agent 回答' } },
  { sessionId: 'activity-task', seq: 4, ts: now - 1, type: 'turn_completed', payload: {} }
]
const activitySession: Session = { id: 'activity-task', title: '活动任务', createdAt: now - 20, updatedAt: now, status: 'idle',
  config: { agentId: 'codex', projectId: 'activity-space', requirementId: 'activity-req', workdir: '/activity' } }
const activityContext = new RouterContextService({
  projects: () => [{ id: 'activity-space', name: '活动项目', primaryDirectory: projectRoot, additionalDirectories: [], createdAt: old, updatedAt: old } as Project],
  requirements: async () => [{ id: 'activity-req', name: '活动需求', projectId: 'activity-space', createdAt: old, updatedAt: old, status: 'active' } as Requirement],
  overview: async (_id, document) => ({ revision: 'r1', documents: [], document: { id: document,
    content: document === 'core' ? '需求目标：活动来源测试' : '需求 state 当前进展', summary: '', updatedAt: document === 'state' ? now + 1 : old } } as RequirementOverview),
  sessions: () => [activitySession], events: async () => activityEvents, seed: () => undefined }, () => now)
const activityObjects: any[] = await activityContext.objects()
const activityTask = activityObjects.find(row => row.id === 'activity-task')!
const activityRequirement = activityObjects.find(row => row.id === 'activity-req')!
const activityProject = activityObjects.find(row => row.id === 'activity-space')!
const taskChanges = activityTask.recentChanges as any[]
assert.deepEqual(taskChanges.map(row => [row.origin?.kind, row.origin?.objectId, row.sourceKind]).sort(), [
  ['task', 'activity-task', 'agent_output'], ['task', 'activity-task', 'system_state'], ['task', 'activity-task', 'user_input']
].sort(), 'task recent activity keeps its own origin and the user/agent/system source type')
for (const change of taskChanges) assert.equal(change.origin.objectId, 'activity-task')
const requirementChanges = activityRequirement.recentChanges as any[]
assert.ok(requirementChanges.some(row => row.origin?.kind === 'task' && row.origin?.objectId === 'activity-task'),
  'requirement activity aggregation preserves a task origin instead of flattening it into requirement text')
assert.ok(requirementChanges.some(row => row.origin?.kind === 'requirement' && row.origin?.objectId === 'activity-req' && row.sourceKind === 'document'),
  'requirement state document activity keeps its requirement origin and document type')
const projectChanges = activityProject.recentChanges as any[]
assert.ok(projectChanges.some(row => row.origin?.kind === 'task' && row.origin?.objectId === 'activity-task'),
  'project aggregation preserves nested task origin')
assert.ok(projectChanges.some(row => row.origin?.kind === 'requirement' && row.origin?.objectId === 'activity-req'),
  'project aggregation preserves nested requirement origin')

const activityDirectory = await mkdtemp(join(tmpdir(), 'ua-router-activity-'))
tempRoots.push(activityDirectory)
const activityDb = new RouterDatabase(join(activityDirectory, 'router.sqlite'), undefined, () => now)
try {
  const legacyActivity = { id: 'legacy-activity', kind: 'task', title: '旧活动任务', summary: '旧记录', projectId: 'activity-space', requirementId: 'activity-req',
    version: '1', lastBusinessUpdatedAt: now, recentChanges: [{ at: now, text: '旧活动', sourceRefs: ['old'] }] } as any
  await activityDb.index([...activityObjects, legacyActivity])
  const activityRequest = activityDb.register({ requestId: randomUUID(), prompt: '检查活动来源' }, DEFAULT_ROUTER_CONFIG)
  const requirementPage = await activityDb.catalog(activityRequest.requestId, 'requirement', 'activity-space')
  const requirementBrief = requirementPage.items.find(row => row.id === 'activity-req') as any
  assert.ok(requirementBrief.recentChanges.some((row: any) => row.origin?.kind === 'task' && row.sourceKind === 'user_input'),
    'catalog requirement brief carries task origin and source kind')
  const taskPage = await activityDb.taskBriefs(activityRequest.requestId, { kind: 'requirement', requirementId: 'activity-req' })
  const taskBrief = taskPage.items.find(row => row.id === 'activity-task') as any
  assert.ok(taskBrief.recentChanges.every((row: any) => row.origin?.objectId === 'activity-task' && ['user_input', 'agent_output', 'system_state'].includes(row.sourceKind)),
    'task_briefs preserves all task activity origins and source kinds')
  const legacyBrief = taskPage.items.find(row => row.id === 'legacy-activity') as any
  assert.equal(legacyBrief.recentChanges[0].origin, undefined, 'old records without origin are not assigned a fabricated source object')
  assert.equal(legacyBrief.recentChanges[0].sourceKind, 'unknown', 'old records without a known source kind are marked unknown')
} finally { activityDb.close() }

console.log('PASS Router context: original metadata, current goal/recent work, logical ownership, bounded history cache, true business timestamps, project README scope and latest input beyond 200 events')
} finally {
  await Promise.all(tempRoots.map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}
