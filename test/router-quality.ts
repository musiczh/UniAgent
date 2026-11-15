import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'

const now = Date.now(), owner = { kind: 'requirement' as const, requirementId: 'super' }
const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', version: '1', projectId: 'space', sources: [{ ref: 'space:goal', title: '范围', text: '桌面客户端', at: now }] },
  { id: 'default', kind: 'space', title: '默认空间', summary: '个人资料', version: '1', projectId: 'default' },
  { id: 'super', kind: 'requirement', title: 'DeepSeek superAgent', summary: 'Router、自动归属及反馈；计划阶段仍承载功能', version: '1', projectId: 'space', sources: [{ ref: 'super:goal', title: '功能归属', text: '本需求承载 Router、自动归属入口及路由反馈。功能归属与实施阶段分开。', at: now }] },
  { id: 'daily', kind: 'requirement', title: '日常迭代', summary: '独立通用配色问题', version: '1', projectId: 'space', sources: [{ ref: 'daily:goal', title: '范围', text: '独立通用主题问题', at: now }] },
  { id: 'task', kind: 'task', title: 'Router 全链路', summary: '继续已确定的路由方案', version: '1', projectId: 'space', requirementId: 'super', busy: true, lastBusinessUpdatedAt: now, nativeSessionId: 'native-explicit', agentId: 'codex',
    sources: [{ ref: 'task:input', title: '原始目标', text: '完善 Router 路由链路，继续已确认的查询与卡片方案。', at: now }, { ref: 'task:reply', title: '进展', text: '已实现卡片，继续依赖本任务验收基线。', at: now }] },
  { id: 'old', kind: 'task', title: '旧路由任务', summary: '明确引用继续', version: '1', projectId: 'space', requirementId: 'super', lastBusinessUpdatedAt: now - 80 * 3600000, nativeSessionId: 'native-old', agentId: 'codex', sources: [{ ref: 'old:goal', title: '目标', text: '继续旧方案', at: now }] }
]
const f = await routerFixture(objects, { now })
const query = (id: string, args: object) => f.call('router_query', { requestId: id, ...args })
async function directory(id: string) {
  await query(id, { mode: 'catalog', kind: 'space' })
  return query(id, { mode: 'catalog', kind: 'requirement', projectId: 'space' })
}
try {
  f.db.writeMemory({ id: 'm', content: '已确认的路由偏好', scope: { kind: 'global' }, status: 'active', revision: 0, source: { version: 'fixture' }, updatedAt: now })
  f.db.writeMemory({ id: 'candidate', content: '未确认的偏好', scope: { kind: 'global' }, status: 'candidate', revision: 0, source: { version: 'fixture' }, updatedAt: now })
  const id = await f.submit({ prompt: '继续 Router 卡片时序排查；参考 native-old' })
  const bootstrap = await query(id, { mode: 'bootstrap' })
  assert.deepEqual(bootstrap.value.hardScope, { kind: 'global' }); assert.equal(bootstrap.value.execution, undefined)
  assert.deepEqual(bootstrap.value.memories.map((row: any) => row.id), ['m'])
  const catalog = await directory(id), ref = catalog.value.items.find((row: any) => row.id === 'super').evidenceRef
  const malformedScope = await query(id, { mode: 'task_briefs', selectedScope: { ...owner, projectId: 'space' } })
  assert.equal(malformedScope.error, 'invalid_router_scope')
  assert.deepEqual(malformedScope.errorDetails.recovery.arguments.selectedScope, owner, 'recover using the same requirement and exact field shape without falling back to the space')
  const a = await query(id, { mode: 'task_briefs', selectedScope: owner })
  assert.deepEqual(a.value.items.map((row: any) => row.id), ['task'])
  await query(id, { mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'daily' } })
  const detail = await query(id, { mode: 'task_detail', taskId: 'task', scanId: a.value.snapshotId })
  assert.equal(detail.ok, true)
  const request = f.db.request(id)!
  assert.deepEqual(request.context!.memories, [{ id: 'm', revision: 1 }], 'subsequent queries retain actual memory versions')
  const decision = { requestId: id, version: request.version, action: 'reuse_task', taskId: 'task', reason: '继续原方案', scanId: a.value.snapshotId,
    scopeAssessment: { selectedScope: owner, evidenceRefs: [ref], comparedRequirements: [] },
    reuseAssessment: { taskId: 'task', continuous: true, stronglyRelated: true, contextRequired: true, evidenceRefs: ['task:input','task:reply'], reason: '依赖原有方案与验收基线' } }
  const { taskId: _taskId, ...missingTarget } = decision
  const missing = await f.call('router_assign_task', missingTarget)
  assert.equal(missing.error, 'router_target_required')
  assert.equal(missing.errorDetails.recovery.arguments.taskId, 'task')
  assert.equal(f.db.request(id)!.state, 'routing', 'missing a tool field does not turn a known business target into an ambiguity')
  const malformedAssessment = await f.call('router_assign_task', { ...decision, scopeAssessment: { ...decision.scopeAssessment, selectedScope: { ...owner, projectId: 'space' } } })
  assert.equal(malformedAssessment.error, 'invalid_scope_assessment')
  assert.equal(malformedAssessment.errorDetails.recovery.arguments.mode, 'bootstrap')
  const requirement = objects.find(row => row.id === 'super')!, task = objects.find(row => row.id === 'task')!
  requirement.recentChanges = [{ at: now + 1, text: '目标任务继续运行', sourceRefs: ['task:progress'] }]
  task.sources!.push({ ref: 'task:progress', title: '新进展', text: '正在继续处理原任务', at: now + 1 })
  const result = await f.call('router_assign_task', decision)
  assert.equal(result.ok, true, 'task progress and requirement evidence revisions must not block assignment to a busy target')
  assert.equal(result.value.delivery, 'queued'); assert.equal(f.journal.length, 1)
  await f.call('router_assign_task', decision); assert.equal(f.journal.length, 1)
  assert.equal(f.sessions.get('task')!.config.workdir, '/original')
  await f.end()

  const second = await f.submit({ prompt: '新建独立 Router 入口改动，归属仍为同一需求' })
  await query(second, { mode: 'bootstrap' })
  const foreign = await f.call('router_assign_task', { requestId: second, version: f.db.request(second)!.version, action: 'create_task_in_requirement', requirementId: 'super', reason: '新目标',
    scopeAssessment: { selectedScope: owner, evidenceRefs: [ref], comparedRequirements: [] } })
  assert.equal(foreign.value.state, 'bound', 'optional evidence from another request does not gate assignment')
  assert.equal(f.journal.length, 2)
  await f.end()

  for (const action of ['reuse_task', 'create_task_in_space', 'create_requirement_and_task'] as const) {
    const direct = await f.submit({ prompt: '已明确目标，直接分配' })
    const bootstrap = await query(direct, { mode: 'bootstrap' })
    const args = { requestId: direct, version: bootstrap.value.version, action, reason: '已有上下文足以判断',
      ...(action === 'reuse_task' ? { taskId: 'task' } : { projectId: 'space' }),
      ...(action === 'create_requirement_and_task' ? { requirementName: '新需求' } : {}) }
    assert.equal((await f.call('router_assign_task', { ...args, version: args.version - 1 })).error, 'router_revision_conflict')
    const count = f.journal.length
    const assigned = await f.call('router_assign_task', args)
    assert.equal(assigned.value.state, 'bound', 'assignment does not require a catalog, scan, detail or assessment')
    if (action === 'reuse_task') assert.equal(assigned.value.delivery, 'queued')
    await f.call('router_assign_task', args)
    assert.equal(f.journal.length, count + 1, 'direct assignment remains idempotent')
    await f.end()
  }

  const empty = await f.submit({ prompt: '可选判断记录不要求引用' })
  const emptyBootstrap = await query(empty, { mode: 'bootstrap' })
  const emptyDecision = { requestId: empty, version: emptyBootstrap.value.version, action: 'reuse_task', taskId: 'task', reason: '继续原任务',
    scanId: 'old-scan', scopeAssessment: { selectedScope: owner, evidenceRefs: [], comparedRequirements: [] },
    reuseAssessment: { taskId: 'task', continuous: true, stronglyRelated: true, contextRequired: true, evidenceRefs: [], reason: '同一未完目标' } }
  assert.equal((await f.call('router_assign_task', emptyDecision)).value.delivery, 'queued')
  await f.end()

  for (const [objectId, flag] of [['task','readOnly'],['super','archived'],['space','readOnly']] as const) {
    const object = objects.find(row => row.id === objectId)!, previous = object[flag]
    object[flag] = true
    const protectedId = await f.submit({ prompt: '检查实际目标可写性' })
    const bootstrap = await query(protectedId, { mode: 'bootstrap' }), count = f.journal.length
    const result = await f.call('router_assign_task', { requestId: protectedId, version: bootstrap.value.version, action: 'reuse_task', taskId: 'task', reason: '继续原目标' })
    assert.equal(result.value.state, 'needs_input')
    assert.match(result.value.question, /归档或只读/)
    assert.equal(f.journal.length, count, 'direct assignment cannot bypass live target or parent writability')
    await f.controller.cancel(protectedId, f.db.request(protectedId)!.version)
    await f.end()
    object[flag] = previous
  }

  const explicit = await f.submit({ prompt: '继续 native-old 原方案' })
  await query(explicit, { mode: 'bootstrap' }); await directory(explicit)
  const originalRevision = f.db.object('old').sourceRevision
  const resolved = await query(explicit, { mode: 'resolve_reference', reference: { nativeSessionId: 'native-old', agentId: 'codex' } })
  assert.equal(resolved.value.target.requirementId, 'super')
  assert.equal(f.db.object('old').sourceRevision, originalRevision, 'resolving indexed metadata does not rewrite the source and invalidate already issued evidence')
  const included = await query(explicit, { mode: 'task_briefs', selectedScope: owner })
  assert.ok(included.value.items.some((row: any) => row.id === 'old'))
  assert.equal((await query(explicit, { mode: 'task_detail', taskId: 'old', scanId: included.value.snapshotId })).ok, true)
  assert.equal((await query(explicit, { mode: 'resolve_reference', reference: { sessionId: 'not-in-user-input' } })).error, 'invalid_router_reference')
  await f.end()

  const supplemented = await f.submit({ prompt: '继续之前的任务' })
  f.db.update(supplemented,f.db.request(supplemented)!.version,{supplements:[{question:'继续哪个任务？',text:'继续 native-old 原方案'}]})
  await query(supplemented,{mode:'bootstrap'})
  const supplementedReference=await query(supplemented,{mode:'resolve_reference',reference:{nativeSessionId:'native-old',agentId:'codex'}})
  assert.equal(supplementedReference.ok,true,'references explicitly supplied in this request clarification are valid Router input')
  assert.equal(supplementedReference.value.target.requirementId,'super')
  await f.end()

  const restricted = await f.submit({ prompt: 'Router 修改', scope: { kind: 'space', projectId: 'default' } })
  const countBeforeRestricted = f.journal.length
  await query(restricted, { mode: 'bootstrap' })
  const conflict = await query(restricted, { mode: 'memories', selectedScope: owner })
  assert.equal(conflict.error, 'hard_scope_conflict')
  const badArgs = { requestId: restricted, mode: 'catalog' }
  assert.equal((await f.call('router_query', badArgs)).error, 'invalid_router_arguments')
  await f.call('router_query', badArgs)
  assert.equal(f.db.request(restricted)!.state, 'routing', 'protocol errors remain the Router responsibility without asking the user to fix them')
  assert.equal(f.db.request(restricted)!.failure?.code, 'router-tool-recovery')
  assert.equal(f.journal.length, countBeforeRestricted)
  await f.end()

  const revoked = await f.submit({ prompt: 'superAgent 独立新任务' })
  await query(revoked, { mode: 'bootstrap' })
  const revokedDirectory = await directory(revoked), revokedRef = revokedDirectory.value.items.find((row: any) => row.id === 'super').evidenceRef
  const revokedScan = await query(revoked, { mode: 'task_briefs', selectedScope: owner })
  f.db.writeMemory({ ...f.db.memoryItem('m')!, status: 'revoked' }, 1)
  const countBeforeRevoked = f.journal.length
  const assignedAfterRevocation = await f.call('router_assign_task', { requestId: revoked, version: f.db.request(revoked)!.version, action: 'create_task_in_requirement', requirementId: 'super', reason: '独立新目标', scanId: revokedScan.value.snapshotId,
    scopeAssessment: { selectedScope: owner, evidenceRefs: [revokedRef], comparedRequirements: [] } })
  assert.equal(assignedAfterRevocation.value.state, 'bound', 'memory changes do not invalidate an assignment')
  assert.equal(f.journal.length, countBeforeRevoked + 1)
  await f.end()

  const hard = await f.submit({ prompt: '只继续 native-old 原任务', scope: { kind: 'space', projectId: 'default' } })
  const countBeforeHard = f.journal.length
  await query(hard, { mode: 'bootstrap' })
  await query(hard, { mode: 'resolve_reference', reference: { nativeSessionId: 'native-old', agentId: 'codex' } })
  const outside = await f.call('router_assign_task', { requestId: hard, version: f.db.request(hard)!.version, action: 'reuse_task', taskId: 'old', reason: '明确引用' })
  assert.equal(outside.errorDetails.code, 'hard_scope_conflict'); assert.equal(outside.errorDetails.recovery.action, 'clarify'); assert.equal(f.journal.length, countBeforeHard)
  await f.end()

  f.db.writeMemory({ id: 'scoped', content: '需求记忆', scope: owner, status: 'active', revision: 0, source: { version: 'fixture' }, updatedAt: now })
  assert.ok(f.db.memories({ requirementId: 'super', kind: 'requirement' }).some(row => row.id === 'scoped'), 'scope field ordering does not alter memory membership')
  objects.find(row => row.id === 'super')!.routing = { status: 'stale', sourceRevision: 'changed-routing-source' }
  const staleContext = await f.submit({ prompt: 'superAgent 的独立新任务' })
  await query(staleContext, { mode: 'bootstrap' })
  const staleDirectory = await directory(staleContext), staleRef = staleDirectory.value.items.find((row: any) => row.id === 'super').evidenceRef
  const staleScan = await query(staleContext, { mode: 'task_briefs', selectedScope: owner })
  const create = { requestId: staleContext, action: 'create_task_in_requirement', requirementId: 'super', reason: '独立新目标', scanId: staleScan.value.snapshotId,
    scopeAssessment: { selectedScope: owner, evidenceRefs: [staleRef], comparedRequirements: [] } }
  const countBeforeStale = f.journal.length
  const assignedWithoutOriginal = await f.call('router_assign_task', { ...create, version: f.db.request(staleContext)!.version })
  assert.equal(assignedWithoutOriginal.value.state, 'bound', 'stale routing summaries do not force original-source reads before assignment')
  assert.equal(f.journal.length, countBeforeStale + 1)
  await f.end()

  objects.find(row => row.id === 'super')!.routing = undefined
  for (const status of ['missing', 'failed', 'ready'] as const) {
    objects.find(row => row.id === 'daily')!.routing = { status, sourceRevision: 'daily-routing', ...(status === 'failed' ? { error: '模型输出格式无效' } : {}),
      ...(status === 'ready' ? { view: { schemaVersion: 1, generatorVersion: 1, requirementId: 'daily', sourceRevision: 'daily-routing', generatedAt: now,
        features: [], exclusions: [], conflicts: [{ text: '归属冲突', refs: [] }], coverage: { complete: true, pendingDocumentIds: [] }, fragments: [] } } : {}) }
    const comparisonId = await f.submit({ prompt: 'superAgent 独立目标，补读其它需求后比较' })
    await query(comparisonId, { mode: 'bootstrap' })
    const catalog = await directory(comparisonId), scan = await query(comparisonId, { mode: 'task_briefs', selectedScope: owner })
    const comparison = { requirementId: 'daily', conclusion: 'unrelated', evidenceRefs: [catalog.value.items.find((row: any) => row.id === 'daily').evidenceRef], reason: '独立目标' }
    const assignment = { requestId: comparisonId, action: 'create_task_in_requirement', requirementId: 'super', reason: '独立新目标', scanId: scan.value.snapshotId,
      scopeAssessment: { selectedScope: owner, evidenceRefs: [catalog.value.items.find((row: any) => row.id === 'super').evidenceRef], comparedRequirements: [comparison] } }
    const count = f.journal.length
    const args = { ...assignment, version: f.db.request(comparisonId)!.version }
    assert.equal((await f.call('router_assign_task', args)).value.state, 'bound', 'optional comparisons do not force evidence recovery')
    await f.call('router_assign_task', args)
    assert.equal(f.journal.length, count + 1)
    await f.end()
  }

  const memoryRequest = f.db.register({ requestId: randomUUID(), prompt: 'memory fixture' }, f.config)
  const memories = Array.from({ length: 12 }, (_, index) => ({ ...f.db.memoryItem('m')!, id: 'paged-' + index }))
  const first = await f.db.memoryPage(memoryRequest.requestId, { kind: 'global' }, memories)
  assert.ok(first.nextCursor)
  assert.equal((await f.db.memoryPage(memoryRequest.requestId, { kind: 'global' }, memories, first.nextCursor!)).items.length, 4)
  await assert.rejects(f.db.memoryPage(second, { kind: 'global' }, memories, first.nextCursor!), /memory_revision_changed/)
  await assert.rejects(f.db.memoryPage(memoryRequest.requestId, { kind: 'global' }, memories.slice(1), first.nextCursor!), /memory_revision_changed/)
  console.log('PASS Router quality: optional evidence, stale progress, direct assignment, valid queries, explicit old Session, hard scope, original config, busy queue and idempotency')
} finally { await f.close() }
