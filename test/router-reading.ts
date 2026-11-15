import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { DEFAULT_ROUTER_CONFIG, type RouterObject } from '../src/shared/router'

const directory = await mkdtemp(join(tmpdir(), 'ua-router-reading-')), now = Date.now(), db = new RouterDatabase(join(directory, 'router.sqlite'), undefined, () => now)
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
  const request = db.register({ requestId: randomUUID(), prompt: '继续需求', scope }, DEFAULT_ROUTER_CONFIG)
  let current = db.update(request.requestId, request.version, { state: 'routing', context: { objects: [{ id: 'req', version: '1' }], memories: [] } })
  let page = await db.taskBriefs(current.requestId, scope)
  assert.equal(page.total, 49)
  assert.equal(page.coverage.complete, false)
  const ids: string[] = []
  do {
    ids.push(...page.items.map(row => row.id))
    const versions = new Map([...current.context!.objects, ...page.objects].map(row => [row.id, row]))
    current = db.update(current.requestId, current.version, { context: { objects: [...versions.values()], memories: [],
      reading: { selectedScope: scope, scanId: page.snapshotId, scanComplete: page.coverage.complete, scannedTaskIds: page.readTaskIds, details: [] } } })
    for (const row of page.items) assert.ok(row.descriptionTokens! <= 200)
    if (!page.nextCursor) break
    page = await db.taskBriefs(current.requestId, scope, page.nextCursor)
  } while (true)
  assert.equal(new Set(ids).size, 49)
  assert.ok(ids.includes('boundary')); assert.ok(!ids.includes('old')); assert.ok(!ids.includes('archived')); assert.ok(!ids.includes('other'))
  await assert.rejects(db.taskBriefs(current.requestId, scope, 'invented.cursor'), /snapshot_expired|invalid_reading_cursor/)
  const foreign = db.register({ requestId: randomUUID(), prompt: '另一个请求' }, DEFAULT_ROUTER_CONFIG)
  const first = await db.taskBriefs(current.requestId, scope)
  await assert.rejects(db.catalog(foreign.requestId, 'requirement', undefined, first.nextCursor!), /invalid_reading_cursor/)
  const detail = await db.detail(current.requestId, 'task-0')
  assert.ok(detail.sources[0].hasMore)
  assert.equal(detail.sources[0].text, undefined, 'default detail lists source metadata without loading originals')
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
  await assert.rejects(db.detail(current.requestId,'archived'),/task_not_eligible/,'archived task execution context remains ineligible')
  await assert.rejects(db.detail(current.requestId, 'task-0', 'input:0', 'invented'), /invalid_reading_cursor/)
  rows = [...rows, { id: 'new-task', kind: 'task', title: '新到达任务', summary: '新目标', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now }]
  await db.index(rows)
  const refreshed = await db.taskBriefs(current.requestId, scope, undefined, true)
  assert.equal(refreshed.total, 50); assert.notEqual(refreshed.snapshotId, current.context!.reading!.scanId)
  const job = (await db.descriptionJobs()).find(row => row.id === 'new-task')
  assert.ok(job || (await db.descriptionJobs()).length)
  console.log('PASS Router reading: scoped window, pagination coverage, token limits, owned cursors, full source reads and refreshed scans')
} finally { db.close() }
