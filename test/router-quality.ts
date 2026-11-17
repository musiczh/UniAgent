import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { routerFixture } from './fixtures/router-quality'
import { ROUTER_IPC, type RouterObject } from '../src/shared/router'
import { ROUTER_TOOLS } from '../src/main/router/mcp'

const now = Date.now(), owner = { kind: 'requirement' as const, requirementId: 'super' }
const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', version: '1', projectId: 'space', sources: [{ ref: 'space:goal', title: '范围', text: '桌面客户端', at: now }] },
  { id: 'default', kind: 'space', title: '默认空间', summary: '个人资料', version: '1', projectId: 'default' },
  { id: 'super', kind: 'requirement', title: 'DeepSeek superAgent', summary: 'Router、自动归属及反馈', version: '1', projectId: 'space', sources: [{ ref: 'super:goal', title: '功能归属', text: '本需求承载 Router、自动归属入口及路由反馈。', at: now }] },
  { id: 'daily', kind: 'requirement', title: '日常迭代', summary: '独立通用配色问题', version: '1', projectId: 'space', sources: [{ ref: 'daily:goal', title: '范围', text: '独立通用主题问题', at: now }] },
  { id: 'task', kind: 'task', title: 'Router 全链路', summary: '继续已确定的路由方案', version: '1', projectId: 'space', requirementId: 'super', busy: true, lastBusinessUpdatedAt: now, nativeSessionId: 'native-explicit', agentId: 'codex',
    sources: [{ ref: 'task:input', title: '原始目标', text: '完善 Router 路由链路，继续已确认的查询与卡片方案。', at: now }, { ref: 'task:reply', title: '进展', text: '已实现卡片，继续依赖本任务验收基线。', at: now }] },
  { id: 'old', kind: 'task', title: '旧路由任务', summary: '明确引用继续', version: '1', projectId: 'space', requirementId: 'super', lastBusinessUpdatedAt: now - 80 * 3600000, nativeSessionId: 'native-old', agentId: 'codex', sources: [{ ref: 'old:goal', title: '目标', text: '继续旧方案', at: now }] },
  { id: 'archived-task', kind: 'task', title: '已归档任务', summary: '归档资料仍可查阅', version: '1', projectId: 'space', requirementId: 'super', archived: true, lastBusinessUpdatedAt: now, sources: [{ ref: 'archived:goal', title: '目标', text: '已归档任务原文。', at: now }] },
  { id: 'space-task', kind: 'task', title: '项目直属任务', summary: '项目直属', version: '1', projectId: 'space', lastBusinessUpdatedAt: now, sources: [{ ref: 'space-task:goal', title: '目标', text: '项目直属目标。', at: now }] },
  { id: 'daily-task', kind: 'task', title: '日常任务', summary: '日常迭代任务', version: '1', projectId: 'space', requirementId: 'daily', lastBusinessUpdatedAt: now, sources: [{ ref: 'daily-task:goal', title: '目标', text: '日常目标。', at: now }] }
]
const sent: string[] = []
const oldHydrated: RouterObject = { id: 'hydrated-old', kind: 'task', title: '未建索引的旧任务', summary: '按需补读旧任务', version: '1', projectId: 'space', requirementId: 'super',
  lastBusinessUpdatedAt: now - 100 * 3600000, sources: [{ ref: 'hydrated:goal', title: '旧目标', text: '从旧任务会话补读的原始目标。', at: now, role: 'original_goal', kind: 'user_input' },
    { ref: 'hydrated:input', title: '最新输入', text: '旧任务的最新补测要求。', at: now, role: 'current_input', kind: 'user_input' }] }
const f = await routerFixture(objects, { now, send: async (_id, prompt) => { sent.push(prompt) }, taskObject: async id => id === 'hydrated-old' ? oldHydrated : undefined })
const query = (id: string, args: object) => f.call('router_query', { requestId: id, ...args })
const version = (id: string) => f.db.request(id)!.version
const promptContext = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('{')))
try {
  // A complete evidence chain is not a query prerequisite: assignment starts
  // directly from the host-provided request facts.
  const direct = await f.submit({ prompt: '继续 Router 全链路，使用原任务方案', attachments: [{ kind: 'file', path: '/fixture/spec.md', name: 'spec.md' }] })
  await f.waitActive(direct)
  const directDecision = { requestId: direct, version: version(direct), action: 'reuse_task' as const, taskId: 'task', reason: '同一交付目标继续原方案' }
  const assigned = await f.call('router_assign_task', directDecision)
  assert.equal(assigned.value.state, 'bound')
  assert.equal(assigned.value.delivery, 'queued')
  assert.equal(f.journal.length, 1)
  assert.equal(f.deliveries.length, 1)
  assert.equal(f.deliveries[0].requestId, direct)
  assert.equal(f.deliveries[0].prompt, '继续 Router 全链路，使用原任务方案')
  assert.deepEqual(f.deliveries[0].attachments, [{ kind: 'file', path: '/fixture/spec.md', name: 'spec.md' }])
  assert.equal((await f.call('router_assign_task', directDecision)).value.state, 'bound')
  assert.equal(f.journal.length, 1, 'repeated receipt does not redeliver the original input')
  assert.equal(f.deliveries.length, 1)
  const changed = await f.call('router_assign_task', { ...directDecision, action: 'create_task_in_space', projectId: 'space', reason: '改换目标' })
  assert.equal(changed.error, 'router_already_bound')
  assert.equal(f.db.request(direct)!.prompt, '继续 Router 全链路，使用原任务方案', 'host request keeps the original business input')
  await f.end()

  // Removed tools and fields are rejected by the live MCP surface, not merely
  // hidden from a prompt.
  const removed = await f.submit({ prompt: '检查已删除的路由接口' })
  await f.waitActive(removed)
  for (const mode of ['bootstrap', 'resolve_reference', 'memories']) {
    const failed = await query(removed, { mode })
    assert.equal(failed.error, 'invalid_router_arguments', `removed query mode ${mode} must fail`)
    assert.equal(failed.errorDetails.recovery.action, 'retry')
    assert.equal(failed.errorDetails.current.requestId, removed)
    assert.equal(failed.errorDetails.current.version, version(removed))
  }
  assert.equal((await query(removed, { mode: 'catalog', kind: 'space', reference: { sessionId: 'task' } })).error, 'invalid_router_arguments')
  assert.deepEqual(ROUTER_TOOLS.map(tool => tool.name), ['router_query', 'router_assign_task'])
  const queryTool = ROUTER_TOOLS.find(tool => tool.name === 'router_query')!
  assert.deepEqual((queryTool.inputSchema as any).properties.mode.enum, ['catalog', 'object_detail', 'task_briefs', 'task_detail'])
  assert.equal((queryTool.inputSchema as any).properties.reference, undefined)
  assert.equal((queryTool.inputSchema as any).properties.selectedScope.oneOf.length, 2, 'global is no longer a selected routing scope')
  const globalTool = await f.call('global_memory', { action: 'read' })
  assert.equal(globalTool.ok, false)
  assert.match(globalTool.error, /unknown_router_tool/)
  assert.equal(ROUTER_IPC.memory, undefined, 'the removed global-memory IPC channel is absent')
  await f.end()

  // Query scopes have exact membership semantics; a project's direct tasks are
  // not its requirements' tasks, and a requirement scope never leaks siblings.
  const scope = await f.submit({ prompt: '检查范围语义' })
  await f.waitActive(scope)
  const spaces = await query(scope, { mode: 'catalog', kind: 'space' })
  assert.deepEqual(spaces.value.items.map((row: any) => row.id).sort(), ['default', 'space'])
  assert.equal(spaces.value.queryScope.membership, 'projects_only')
  assert.equal(spaces.value.queryScope.includesDescendants, false)
  const requirements = await query(scope, { mode: 'catalog', kind: 'requirement', projectId: 'space' })
  assert.deepEqual(requirements.value.items.map((row: any) => row.id).sort(), ['daily', 'super'])
  assert.equal(requirements.value.queryScope.membership, 'requirements_only')
  const projectTasks = await query(scope, { mode: 'task_briefs', selectedScope: { kind: 'space', projectId: 'space' } })
  assert.deepEqual(projectTasks.value.items.map((row: any) => row.id), ['space-task'], 'space scope contains only project-direct tasks')
  assert.equal(projectTasks.value.queryScope.membership, 'project_direct_tasks_only')
  assert.equal(projectTasks.value.queryScope.includesDescendants, false)
  const requirementTasks = await query(scope, { mode: 'task_briefs', selectedScope: owner })
  assert.deepEqual(requirementTasks.value.items.map((row: any) => row.id), ['task'], 'requirement scope excludes old, archived and sibling tasks')
  assert.equal(requirementTasks.value.queryScope.membership, 'requirement_tasks_only')
  const dailyTasks = await query(scope, { mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'daily' } })
  assert.deepEqual(dailyTasks.value.items.map((row: any) => row.id), ['daily-task'])
  const defaultTasks = await query(scope, { mode: 'task_briefs', selectedScope: { kind: 'space', projectId: 'default' } })
  assert.equal(defaultTasks.value.total, 0, 'an empty direct list does not describe another project or requirement scope')
  await f.end()

  // The 72-hour window limits automatic candidates only. Old and archived
  // material remains readable by explicit taskId, while archived targets stay
  // undeliverable.
  const old = await f.submit({ prompt: '继续旧路由任务' })
  await f.waitActive(old)
  const oldDetail = await query(old, { mode: 'task_detail', taskId: 'old' })
  assert.equal(oldDetail.ok, true)
  assert.equal(oldDetail.value.item.id, 'old')
  assert.equal((await query(old, { mode: 'task_detail', taskId: 'old', sourceRef: 'old:goal' })).value.sources[0].text, '继续旧方案')
  const hydratedDetail = await query(old, { mode: 'task_detail', taskId: 'hydrated-old' })
  assert.equal(hydratedDetail.ok, true, JSON.stringify(hydratedDetail))
  assert.equal(f.db.object('hydrated-old').title, '未建索引的旧任务', 'an unindexed old task is hydrated from its native session before the read')
  assert.equal(hydratedDetail.value.current.find((row: any) => row.role === 'current_input')?.text, '旧任务的最新补测要求。')
  const archivedDetail = await query(old, { mode: 'task_detail', taskId: 'archived-task' })
  assert.equal(archivedDetail.ok, true, 'archived material is readable')
  assert.equal(archivedDetail.value.item.archived, true)
  const count = f.journal.length
  const archivedAssignment = await f.call('router_assign_task', { requestId: old, version: version(old), action: 'reuse_task', taskId: 'archived-task', reason: '尝试继续归档任务' })
  assert.equal(archivedAssignment.errorDetails.code, 'task_not_eligible')
  assert.equal(archivedAssignment.errorDetails.recovery.action, 'query')
  assert.equal(archivedAssignment.errorDetails.recovery.arguments.mode, 'task_detail')
  assert.equal(f.journal.length, count, 'archived task cannot be delivered')
  await f.end()

  // Current materials are surfaced by default and prioritized over the source
  // directory; the latest turn is not limited to the last 200 events.
  const materials: RouterObject = {
    id: 'materials', kind: 'task', title: '当前材料', summary: '原始可行性调研', version: '1', projectId: 'space', requirementId: 'super', lastBusinessUpdatedAt: now,
    sources: [
      { ref: 'goal:old', title: '原始目标', text: '最初的可行性调研与旧方案。', at: 1, kind: 'user_input', role: 'original_goal' },
      { ref: 'input:now', title: '最新输入', text: '最新模型补测以本轮明确要求为准。'.repeat(400), at: now, kind: 'user_input', role: 'current_input' },
      { ref: 'reply:now', title: '近期回答', text: '已补测，但旧可行性描述仍需更新。', at: now, kind: 'agent_output', role: 'recent_output' },
      { ref: 'state:now', title: '当前状态', text: JSON.stringify({ status: 'running', lifecycle: 'active' }), at: now, kind: 'system_state', role: 'status' }
    ]
  }
  objects.push(materials)
  const context = await f.submit({ prompt: '补测当前材料' })
  await f.waitActive(context)
  const detail = await query(context, { mode: 'task_detail', taskId: 'materials' })
  assert.equal(detail.ok, true, JSON.stringify(detail))
  assert.deepEqual(detail.value.current.map((row: any) => row.role), ['current_input', 'recent_output', 'status', 'original_goal'])
  assert.ok(detail.value.current[0].text.startsWith('最新模型补测'), 'current input takes precedence over the old goal')
  assert.equal(detail.value.current[0].kind, 'user_input')
  assert.equal(detail.value.current[0].hasMore, true)
  assert.equal(detail.value.current[0].continueWith.mode, 'task_detail')
  assert.equal(detail.value.current[0].continueWith.sourceRef, 'input:now')
  assert.equal(detail.value.materialAvailability.currentInput, true)
  assert.equal(detail.value.materialAvailability.recentOutput, true)
  assert.equal(detail.value.materialAvailability.status, true)
  assert.equal(detail.value.materialAvailability.originalGoal, true, 'the original-goal material has an explicit availability state')
  let currentText = '', cursor: string | undefined
  do {
    const page = await query(context, { mode: 'task_detail', taskId: 'materials', sourceRef: 'input:now', cursor })
    assert.equal(page.ok, true)
    currentText += page.value.sources[0].text
    cursor = page.value.nextCursor || undefined
  } while (cursor)
  assert.equal(currentText, materials.sources!.find(row => row.ref === 'input:now')!.text, 'current material source can be continued to the full original')
  const missing: RouterObject = { id: 'missing-material', kind: 'task', title: '缺材料任务', summary: '只有状态', version: '1', projectId: 'space', requirementId: 'super', lastBusinessUpdatedAt: now,
    sources: [{ ref: 'state:only', title: '当前状态', text: JSON.stringify({ status: 'idle' }), at: now, kind: 'system_state', role: 'status' }] }
  objects.push(missing)
  const missingDetail = await query(context, { mode: 'task_detail', taskId: 'missing-material' })
  assert.equal(missingDetail.value.materialAvailability.currentInput, false, 'missing current input stays unknown')
  assert.equal(missingDetail.value.materialAvailability.recentOutput, false)
  assert.equal(missingDetail.value.materialAvailability.originalGoal, false, 'an uncaptured original goal is reported missing instead of fabricated')
  assert.equal(missingDetail.value.current.length, 1)
  assert.equal(missingDetail.value.current[0].role, 'status')
  const truncated: RouterObject = { id: 'truncated', kind: 'task', title: '截断来源', summary: '来源截断', version: '1', projectId: 'space', requirementId: 'super', lastBusinessUpdatedAt: now,
    sources: [{ ref: 'doc:truncated', title: '长文档节选', text: '已读取的项目定义节选。'.repeat(10), at: now, kind: 'document', truncated: true }] }
  objects.push(truncated)
  const truncatedDetail = await query(context, { mode: 'task_detail', taskId: 'truncated', sourceRef: 'doc:truncated' })
  assert.equal(truncatedDetail.ok, true)
  assert.equal(truncatedDetail.value.sources[0].truncated, true)
  assert.equal(truncatedDetail.value.sources[0].hasMore, true, 'source-level truncation is exposed even when the excerpt fits')
  assert.equal(truncatedDetail.value.coverage.sourceTruncated, true)
  await f.end()

  // Clarification re-entry uses the same request and restores its original
  // input; stale versions fail with the current request facts, and the next
  // round receives the clarification history directly from the host.
  const clarify = await f.submit({ prompt: '继续修复路由卡片', attachments: [{ kind: 'image', path: '/fixture/card.png', name: 'card.png' }] })
  await f.waitActive(clarify)
  const oldVersion = version(clarify)
  const options = [{ label: '继续 Router 全链路任务' }, { label: '新建独立卡片任务', description: '只处理卡片展示' }]
  const pending = await f.call('router_assign_task', { requestId: clarify, version: oldVersion, action: 'clarify', reason: '两个目标都可能承接', clarification: '这次要处理哪个目标？', clarificationOptions: options })
  assert.equal(pending.value.state, 'needs_input')
  assert.deepEqual(pending.value.decision?.clarificationOptions ?? f.db.request(clarify)!.decision!.clarificationOptions, options)
  await f.end()
  const resolved = await f.controller.resolve({ requestId: clarify, expectedVersion: version(clarify), action: 'answer', answer: options[0].label })
  assert.equal(resolved.state, 'queued')
  for (let i = 0; i < 100 && f.db.request(clarify)?.state !== 'routing'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.db.request(clarify)!.state, 'routing')
  const stale = await f.call('router_assign_task', { requestId: clarify, version: oldVersion, action: 'reuse_task', taskId: 'task', reason: '用旧版本重提' })
  assert.equal(stale.error, 'router_revision_conflict')
  assert.equal(stale.errorDetails.current.version, version(clarify))
  assert.equal(stale.errorDetails.current.state, 'routing')
  assert.deepEqual(stale.errorDetails.current.hardScope, { kind: 'global' })
  const reentry = promptContext(sent.at(-1)!)
  assert.equal(reentry.requestId, clarify)
  assert.equal(reentry.input, '继续修复路由卡片')
  assert.deepEqual(reentry.attachments, [{ kind: 'image', path: '/fixture/card.png', name: 'card.png' }])
  assert.deepEqual(reentry.clarificationHistory.map((row: any) => [row.question, row.text]), [['这次要处理哪个目标？', options[0].label]])
  assert.equal(typeof reentry.version, 'number')
  assert.equal(typeof reentry.catalogRevision, 'string')
  assert.equal(typeof reentry.asOf, 'number')
  assert.deepEqual(reentry.hardScope, { kind: 'global' })
  assert.equal(reentry.inputSource, 'clarification_reply')
  const reentered = await f.call('router_assign_task', { requestId: clarify, version: version(clarify), action: 'reuse_task', taskId: 'task', reason: '用户已明确继续原任务' })
  assert.equal(reentered.value.state, 'bound')
  assert.equal(f.deliveries.at(-1)!.prompt, '继续修复路由卡片', 'clarification answers never replace the original business input')
  assert.deepEqual(f.deliveries.at(-1)!.attachments, [{ kind: 'image', path: '/fixture/card.png', name: 'card.png' }])
  await f.end()

  // Historical memory storage remains readable, but the removed global-memory
  // surface cannot be used as a routing input.
  f.db.writeMemory({ id: 'm', content: '历史记忆仍保留', scope: { kind: 'global' }, status: 'active', revision: 0, source: { version: 'fixture' }, updatedAt: now })
  assert.ok(f.db.memories().some(row => row.id === 'm'), 'historical memory rows remain readable')
  const memoryRequest = await f.submit({ prompt: '历史记忆不应参与本轮路由' })
  await f.waitActive(memoryRequest)
  assert.equal((await f.call('router_assign_task', { requestId: memoryRequest, version: version(memoryRequest), action: 'clarify', reason: '缺归属', clarification: '请补充', clarificationOptions: [{ label: '继续原任务' }], memories: [] })).error, 'invalid_router_fields')
  assert.equal((await f.call('router_assign_task', { requestId: memoryRequest, version: version(memoryRequest), action: 'reuse_task', taskId: 'task', reason: '无记忆也可判断' })).value.state, 'bound')
  console.log('PASS Router quality: direct assignment, removed interfaces, scope membership, old/archived reads, current materials, truncation/continuation, clarification re-entry and original input')
} finally { await f.close() }
