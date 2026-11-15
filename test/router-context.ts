import assert from 'node:assert/strict'
import { RouterContextService } from '../src/main/router/context'
import type { Project, Session, UAEvent } from '../src/shared/types'
import type { Requirement, RequirementOverview } from '../src/shared/requirementTypes'

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
assert.ok(row.sources?.some(row => row.text.includes('原始元数据')))
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
console.log('PASS Router context: original metadata, current goal/recent work, logical ownership, bounded history cache, true business timestamps and full requirement sources')
