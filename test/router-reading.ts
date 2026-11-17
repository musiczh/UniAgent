import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { DEFAULT_ROUTER_CONFIG, type RouterObject } from '../src/shared/router'
import { loadRouterTokenizer } from '../src/main/router/tokenizer'

const directory = await mkdtemp(join(tmpdir(), 'ua-router-reading-')), now = Date.now()
let clock = now
const db = new RouterDatabase(join(directory, 'router.sqlite'), undefined, () => clock)
const scope = { kind: 'requirement' as const, requirementId: 'req' }
let rows: RouterObject[] = [
  { id: 'space', kind: 'space', title: '空间', summary: '工作空间', projectId: 'space', version: '1' },
  { id: 'req', kind: 'requirement', title: '需求', summary: '任务持续推进', projectId: 'space', version: '1' },
  { id: 'archived-req', kind: 'requirement', title: 'qoder接入', summary: '已归档接入方案', projectId: 'space', version: '1', archived: true,
    sources: [{ ref: 'archived:scope', title: '原文', at: now, text: '本需求承载 Qoder 接入；当前已归档。' }] },
  { id: 'readonly-req', kind: 'requirement', title: '只读需求', summary: '只读资料', projectId: 'space', version: '1', readOnly: true,
    sources: [{ ref: 'readonly:scope', title: '原文', at: now, text: '只读需求的归属原文。' }] },
  ...Array.from({ length: 48 }, (_, index): RouterObject => ({ id: 'task-' + index, kind: 'task', title: '任务' + index, summary: '任务目标描述'.repeat(50),
    projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now,
    sources: [{ ref: 'input:' + index, title: '原输入', at: now, text: '必须继续此前的方案。'.repeat(2000) }] })),
  { id: 'boundary', kind: 'task', title: '三天边界', summary: '边界任务', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now - 72 * 3600000 },
  { id: 'old', kind: 'task', title: '旧任务', summary: '旧任务', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now - 72 * 3600000 - 1 },
  { id: 'archived', kind: 'task', title: '归档', summary: '归档', projectId: 'space', requirementId: 'req', archived: true, version: '1', lastBusinessUpdatedAt: now },
  { id: 'other', kind: 'task', title: '其他需求', summary: '其他需求', projectId: 'space', requirementId: 'other', version: '1', lastBusinessUpdatedAt: now }
]
try {
  await db.index(rows)
  const descriptionRows: RouterObject[] = [
    { id: 'description-project', kind: 'space', title: '项目描述', summary: '项目范围与业务对象 '.repeat(3000), projectId: 'space', version: '1' },
    { id: 'description-requirement', kind: 'requirement', title: '需求描述', summary: '需求目标、功能责任与边界 '.repeat(3000), projectId: 'space', version: '1' },
    { id: 'description-task', kind: 'task', title: '任务描述', summary: '任务演进目标与具体交付物 '.repeat(3000), projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now }
  ]
  await db.index([...rows, ...descriptionRows])
  for (const [id, limit] of [['description-project', 200], ['description-requirement', 500], ['description-task', 300]] as const) {
    const description = db.object(id).description!
    assert.ok(description.tokens <= limit, `${id} description respects the ${limit}-token limit`)
    assert.ok((await loadRouterTokenizer()).count(description.text) <= limit)
  }
  await db.index(rows)
  const request = db.register({ requestId: randomUUID(), prompt: '继续需求', scope }, DEFAULT_ROUTER_CONFIG)
  let current = db.update(request.requestId, request.version, { state: 'routing', context: { objects: [{ id: 'req', version: '1' }] } })
  let page = await db.taskBriefs(current.requestId, scope)
  const catalogRevision = page.catalogRevision
  assert.equal(catalogRevision, db.catalogRevision())
  await db.index([...rows, { id: 'new-space', kind: 'space', title: '新增空间', summary: '独立项目', projectId: 'new-space', version: '1' }])
  assert.notEqual(db.catalogRevision(), catalogRevision, 'a new object changes the current catalog')
  assert.equal(page.total, 49)
  assert.equal(page.coverage.complete, false)
  const ids: string[] = []
  do {
    assert.equal(page.catalogRevision, catalogRevision, 'pagination retains the original catalog version after live objects change')
    ids.push(...page.items.map(row => row.id))
    const versions = new Map([...current.context!.objects, ...page.objects].map(row => [row.id, row]))
    current = db.update(current.requestId, current.version, { context: { objects: [...versions.values()],
      reading: { selectedScope: scope, scanId: page.snapshotId, scanComplete: page.coverage.complete, scannedTaskIds: page.readTaskIds, details: [] } } })
    for (const row of page.items) assert.ok(row.descriptionTokens! <= 300)
    if (!page.nextCursor) break
    page = await db.taskBriefs(current.requestId, scope, page.nextCursor)
  } while (true)
  await db.index(rows)
  assert.equal(new Set(ids).size, 49)
  assert.ok(ids.includes('boundary')); assert.ok(!ids.includes('old')); assert.ok(!ids.includes('archived')); assert.ok(!ids.includes('other'))
  await assert.rejects(db.taskBriefs(current.requestId, scope, 'invented.cursor'), /snapshot_expired|invalid_reading_cursor/)
  const foreign = db.register({ requestId: randomUUID(), prompt: '另一个请求' }, DEFAULT_ROUTER_CONFIG)
  const first = await db.taskBriefs(current.requestId, scope)
  await assert.rejects(db.catalog(foreign.requestId, 'requirement', undefined, first.nextCursor!), /invalid_reading_cursor/)
  const detail = await db.detail(current.requestId, 'task-0')
  assert.ok(detail.sources[0].hasMore)
  assert.equal(detail.sources[0].text, undefined, 'default detail lists source metadata without loading originals')
  assert.deepEqual(detail.current, [], 'legacy sources without roles keep current materials unknown instead of guessing')
  assert.deepEqual(detail.materialAvailability, { currentInput: false, recentOutput: false, status: false, originalGoal: false })
  let source = await db.detail(current.requestId, 'task-0', 'input:0'), text = source.sources[0].text, cursor = source.nextCursor
  while (cursor) { source = await db.detail(current.requestId, 'task-0', 'input:0', cursor); text += source.sources[0].text; cursor = source.nextCursor }
  assert.equal(text, rows.find(row => row.id === 'task-0')!.sources![0].text)
  const sourceRequest = db.register({ requestId: randomUUID(), prompt: '查阅归档与只读资料' }, DEFAULT_ROUTER_CONFIG)
  const archivedDetail=await db.detail(sourceRequest.requestId,'archived-req','archived:scope')
  assert.equal(archivedDetail.item.archived,true)
  assert.equal(archivedDetail.sources[0].text,'本需求承载 Qoder 接入；当前已归档。','archived scope remains readable for routing evidence')
  const readonlyDetail=await db.detail(sourceRequest.requestId,'readonly-req','readonly:scope')
  assert.equal(readonlyDetail.item.readOnly,true)
  assert.equal(readonlyDetail.sources[0].text,'只读需求的归属原文。')
  await assert.rejects(db.taskBriefs(sourceRequest.requestId,{kind:'requirement',requirementId:'archived-req'}),/task_not_eligible/,'read access must not enable archived execution')
  await assert.rejects(db.taskBriefs(sourceRequest.requestId,{kind:'requirement',requirementId:'readonly-req'}),/task_not_eligible/)
  const archivedTask=await db.detail(current.requestId,'archived')
  assert.equal(archivedTask.item.archived,true,'archived task material remains readable by explicit taskId')
  assert.deepEqual(archivedTask.current,[])
  await assert.rejects(db.detail(current.requestId, 'task-0', 'input:0', 'invented'), /invalid_reading_cursor/)
  rows = [...rows, { id: 'new-task', kind: 'task', title: '新到达任务', summary: '新目标', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now }]
  await db.index(rows)
  const refreshed = await db.taskBriefs(current.requestId, scope, undefined, true)
  assert.equal(refreshed.total, 50); assert.notEqual(refreshed.snapshotId, current.context!.reading!.scanId)
  const job = (await db.descriptionJobs()).find(row => row.id === 'new-task')
  assert.ok(job || (await db.descriptionJobs()).length)
  const currentRevision = db.catalogRevision()
  clock++
  assert.notEqual(db.catalogRevision(), currentRevision, 'crossing the 72-hour boundary invalidates the old candidate catalog without object writes')
  clock = now
  const legacySnapshot = randomUUID()
  db.manifest('reading:' + legacySnapshot, { id: legacySnapshot, requestId: current.requestId, key: 'tasks:requirement:req', asOf: now,
    items: [], readThrough: 0, cursors: {} })
  current = db.update(current.requestId, current.version, { context: { ...current.context!, reading: { selectedScope: scope, scanId: legacySnapshot, scannedTaskIds: [], details: [] } } })
  assert.equal((await db.taskBriefs(current.requestId, scope)).catalogRevision, 'unknown', 'legacy snapshots without a version are never stamped as the current catalog')

const provenanceDirectory = await mkdtemp(join(tmpdir(), 'ua-router-provenance-'))
const provenanceDb = new RouterDatabase(join(provenanceDirectory, 'router.sqlite'), undefined, () => now)
try {
  const origin = { kind: 'task' as const, objectId: 'provenance-task' }
  const provenanceObjects: any[] = [
    { id: 'provenance-space', kind: 'space', title: '来源空间', summary: '', projectId: 'provenance-space', version: '1' },
    { id: 'provenance-req', kind: 'requirement', title: '来源需求', summary: '', projectId: 'provenance-space', version: '1',
      recentChanges: [{ at: now, text: '需求聚合任务活动', sourceRefs: ['task:r'], origin, sourceKind: 'user_input' }] },
    { id: 'provenance-task', kind: 'task', title: '来源任务', summary: '', projectId: 'provenance-space', requirementId: 'provenance-req', version: '1', lastBusinessUpdatedAt: now,
      recentChanges: [
        { at: now, text: '用户输入活动', sourceRefs: ['task:r'], origin, sourceKind: 'user_input' },
        { at: now - 1, text: 'Agent 回答活动', sourceRefs: ['task:a'], origin, sourceKind: 'agent_output' },
        { at: now - 2, text: '状态活动', sourceRefs: ['task:s'], origin, sourceKind: 'system_state' }
      ] },
    { id: 'legacy-provenance', kind: 'task', title: '旧来源任务', summary: '', projectId: 'provenance-space', requirementId: 'provenance-req', version: '1', lastBusinessUpdatedAt: now,
      recentChanges: [{ at: now, text: '旧记录活动', sourceRefs: ['old:r'] }] }
  ]
  await provenanceDb.index(provenanceObjects)
  const provenanceRequest = provenanceDb.register({ requestId: randomUUID(), prompt: '检查来源字段' }, DEFAULT_ROUTER_CONFIG)
  const catalog = await provenanceDb.catalog(provenanceRequest.requestId, 'requirement', 'provenance-space')
  const requirementBrief = catalog.items.find(row => row.id === 'provenance-req') as any
  assert.deepEqual(requirementBrief.recentChanges[0].origin, { kind: 'task', objectId: 'provenance-task' })
  assert.equal(requirementBrief.recentChanges[0].sourceKind, 'user_input')
  const briefs = await provenanceDb.taskBriefs(provenanceRequest.requestId, { kind: 'requirement', requirementId: 'provenance-req' })
  const taskBrief = briefs.items.find(row => row.id === 'provenance-task') as any
  assert.deepEqual(taskBrief.recentChanges.map((row: any) => [row.origin.kind, row.origin.objectId, row.sourceKind]), [
    ['task', 'provenance-task', 'user_input'], ['task', 'provenance-task', 'agent_output'], ['task', 'provenance-task', 'system_state']
  ], 'task_briefs keeps the origin and source kind for each activity, not only text/sourceRefs')
  const legacyBrief = briefs.items.find(row => row.id === 'legacy-provenance') as any
  assert.equal(legacyBrief.recentChanges[0].origin, undefined, 'old records without origin are not given a fabricated owner')
  assert.equal(legacyBrief.recentChanges[0].sourceKind, 'unknown', 'old records without a captured source kind remain unknown')
} finally { provenanceDb.close(); await rm(provenanceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }

console.log('PASS Router reading: scoped window, pagination coverage, token limits, owned cursors, full source reads and refreshed scans')
} finally { db.close() }
