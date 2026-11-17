import assert from 'node:assert/strict'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'
import { ROUTER_TOOLS } from '../src/main/router/mcp'

const now = Date.now(), owner = { kind: 'requirement' as const, requirementId: 'requirement' }
const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', projectId: 'space', version: '1' },
  { id: 'requirement', kind: 'requirement', title: 'Router', summary: '路由证据链', projectId: 'space', version: '1' },
  { id: 'task', kind: 'task', title: '原任务', summary: '继续原方案', projectId: 'space', requirementId: 'requirement', version: '1', lastBusinessUpdatedAt: now,
    sources: [{ ref: 'input', title: '原目标', text: '继续原任务。', at: now }] }
]
const f = await routerFixture(objects, { now })
try {
  const id = await f.submit({ prompt: '检查协议错误恢复' })
  for (let i = 0; i < 100 && (await f.controller.snapshot()).activeRequestId !== id; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const badArgs = { requestId: id, mode: 'catalog' }
  const first = await f.call('router_query', badArgs)
  assert.equal(first.error, 'invalid_router_arguments')
  const firstVersion = first.errorDetails.current.version
  assert.equal(first.errorDetails.current.state, 'routing')
  const second = await f.call('router_query', badArgs)
  assert.equal(second.errorDetails.current.version, firstVersion + 1, 'repeated protocol errors return the incremented request version')

  const missingSource = await f.call('router_query', { requestId: id, mode: 'task_detail', taskId: 'task', sourceRef: 'missing:source' })
  assert.equal(missingSource.error, 'context_unavailable')
  assert.deepEqual(missingSource.errorDetails.recovery, { action: 'query', arguments: { requestId: id, mode: 'task_detail', taskId: 'task' } })
  const kindConflict = await f.call('router_query', { requestId: id, mode: 'object_detail', objectId: 'task' })
  assert.equal(kindConflict.error, 'router_target_kind_conflict')
  assert.deepEqual(kindConflict.errorDetails.recovery, { action: 'query', arguments: { requestId: id, mode: 'task_detail', taskId: 'task' } })

  const expiredSnapshot = 'expired-snapshot'
  f.db.manifest('reading:' + expiredSnapshot, { id: expiredSnapshot, requestId: id, key: 'tasks:requirement:requirement', asOf: now,
    catalogRevision: 'old', items: [], readThrough: 0, cursors: {} })
  ;(f.db as any).db.prepare('DELETE FROM router_meta WHERE id=?').run('context:reading:' + expiredSnapshot)
  const expired = await f.call('router_query', { requestId: id, mode: 'task_briefs', selectedScope: owner, cursor: expiredSnapshot + '.token' })
  assert.equal(expired.error, 'reading_snapshot_expired')
  assert.deepEqual(expired.errorDetails.recovery, { action: 'query', arguments: { requestId: id, mode: 'task_briefs', selectedScope: owner, refresh: true } })
  const recovered = await f.call('router_query', expired.errorDetails.recovery.arguments)
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errorDetails ?? recovered.error))
  assert.notEqual(recovered.value.snapshotId, expiredSnapshot, 'recovery builds a new snapshot instead of reusing the deleted one')
  assert.equal(recovered.value.reading.scanId, recovered.value.snapshotId)
  assert.deepEqual(recovered.value.items.map((row: any) => row.id), ['task'])

  const direct = await f.call('router_assign_task', { requestId: id, version: f.db.request(id)!.version, action: 'reuse_task', taskId: 'task', reason: '继续原任务' })
  assert.equal(direct.value.state, 'bound')
  await f.end()
  const ended = await f.call('router_query', { requestId: id, mode: 'catalog', kind: 'space' })
  assert.equal(ended.error, 'router_scope_expired')
  assert.equal(ended.errorDetails.current, undefined, 'an inactive request does not receive current status fields')

  const missingTarget = await f.submit({ prompt: '检查缺顶层目标时的恢复参数' })
  await f.waitActive(missingTarget)
  const scan = await f.call('router_query', { requestId: missingTarget, mode: 'task_briefs', selectedScope: owner })
  assert.equal(scan.ok, true, JSON.stringify(scan))
  assert.equal(typeof scan.value.snapshotId, 'string')
  const recovery = await f.call('router_assign_task', { requestId: missingTarget, version: f.db.request(missingTarget)!.version,
    action: 'reuse_task', reason: '模型只补了可选评估记录', reuseAssessment: { taskId: 'task', continuous: true, stronglyRelated: true,
      contextRequired: true, evidenceRefs: ['input'], reason: '同一交付物继续' } })
  assert.equal(recovery.error, 'router_target_required')
  const recoveryArgs = recovery.errorDetails.recovery.arguments
  const queryTool = ROUTER_TOOLS.find(tool => tool.name === 'router_query')!
  const publishedFields = new Set(Object.keys((queryTool.inputSchema as any).properties))
  assert.deepEqual(Object.keys(recoveryArgs).filter(key => !publishedFields.has(key)), [],
    'recovery.arguments must only use fields declared by the published router_query schema')
  assert.equal(recoveryArgs.scanId, undefined, 'the published router_query schema no longer accepts scanId')
  await f.call('router_query', recoveryArgs)
  await f.end()
  console.log('PASS Router error recovery: latest version, same-target recovery, published query fields and no status for inactive calls')
} finally { await f.close() }
