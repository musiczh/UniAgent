import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { routerFixture } from './fixtures/router-quality'
import { loadRouterTokenizer } from '../src/main/router/tokenizer'
import type { RouterObject } from '../src/shared/router'

const now = Date.now()
function objects(): RouterObject[] {
  return [
    { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', projectId: 'space', version: '1' },
    { id: 'other-space', kind: 'space', title: '另一个项目', summary: '', projectId: 'other-space', version: '1' },
    { id: 'requirement', kind: 'requirement', title: 'Router', summary: '负责输入的归属与分配', projectId: 'space', version: '1',
      sources: Array.from({ length: 40 }, (_, i) => ({ ref: 'document:' + i, title: '功能资料 ' + i, at: now, text: ('功能 ' + i + ' 的完整原文。').repeat(1000) })) },
    { id: 'other-requirement', kind: 'requirement', title: '其他需求', summary: '', projectId: 'other-space', version: '1' },
    { id: 'task', kind: 'task', title: '原分配链路', summary: '继续路由方案', projectId: 'space', requirementId: 'requirement', version: '1', lastBusinessUpdatedAt: now,
      sources: [{ ref: 'input', title: '原目标', at: now, text: '继续同一分配结果的状态链。' }],
      recentChanges: [{ at: now, text: '路由结果的近期进展。'.repeat(10000), sourceRefs: ['input'] }] },
    { id: 'old-task', kind: 'task', title: '旧目标', summary: '', projectId: 'space', requirementId: 'requirement', version: '1', lastBusinessUpdatedAt: now - 73 * 3600000,
      sources: [{ ref: 'old:input', title: '旧目标', at: now, text: '继续旧目标。' }] }
  ]
}

test('known IDs reach requirements, task briefs and details without directory prerequisites', async () => {
  const f = await routerFixture(objects(), { now })
  try {
    const requestId = await f.submit({ prompt: '继续原分配链路' })
    for (const args of [
      { mode: 'catalog', kind: 'requirement', projectId: 'space' },
      { mode: 'task_detail', taskId: 'task' },
      { mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'requirement' } },
      { mode: 'object_detail', objectId: 'requirement' },
      { mode: 'task_detail', taskId: 'task', sourceRef: 'input' }
    ]) {
      const result = await f.call('router_query', { requestId, ...args })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (args.sourceRef) assert.equal(result.value.sources[0].text, '继续同一分配结果的状态链。')
    }
    assert.equal(f.db.request(requestId)!.error, undefined)
    const decision = { requestId, version: f.db.request(requestId)!.version, action: 'reuse_task', taskId: 'task', reason: '继续同一结果' }
    assert.equal((await f.call('router_assign_task', decision)).value.state, 'bound')
    assert.equal((await f.call('router_assign_task', decision)).value.state, 'bound')
    assert.equal(f.journal.length, 1)
    await f.end()
  } finally { await f.close() }
})

test('a space ID filters the space catalog and preserves target type and hard scope checks', async () => {
  const f = await routerFixture(objects(), { now })
  try {
    const requestId = await f.submit({ prompt: '查询项目' })
    const result = await f.call('router_query', { requestId, mode: 'catalog', kind: 'space', projectId: 'space' })
    assert.deepEqual(result.value.items.map((row: any) => row.id), ['space'])
    assert.equal(result.value.total, 1)
    for (const [projectId, error] of [['missing', 'object_not_found'], ['task', 'router_target_kind_conflict']]) {
      assert.equal((await f.call('router_query', { requestId, mode: 'catalog', kind: 'space', projectId })).error, error)
    }
    await f.end()
    const restricted = await f.submit({ prompt: '查询本项目', scope: { kind: 'space', projectId: 'space' } })
    for (const args of [{ mode: 'catalog', kind: 'requirement', projectId: 'other-space' }, { mode: 'object_detail', objectId: 'other-requirement' }]) {
      assert.equal((await f.call('router_query', { requestId: restricted, ...args })).error, 'hard_scope_conflict')
    }
    assert.equal(f.journal.length, 0)
    await f.end()
  } finally { await f.close() }
})

test('expired scan and source cursors recover by direct reading of the same target', async () => {
  const f = await routerFixture(objects(), { now })
  try {
    const requestId = await f.submit({ prompt: '继续原分配链路' })
    for (const args of [{ mode: 'task_detail', taskId: 'task', scanId: 'expired' }, { mode: 'object_detail', objectId: 'requirement', sourceRef: 'document:0', cursor: 'expired' }]) {
      const failed = await f.call('router_query', { requestId, ...args })
      assert.equal(failed.ok, false)
      const recovery = failed.errorDetails.recovery
      assert.equal(recovery.action, 'query')
      assert.equal(recovery.arguments.mode, args.mode)
      assert.equal(recovery.arguments.taskId || recovery.arguments.objectId, args.taskId || args.objectId)
      assert.equal(recovery.arguments.cursor, undefined)
      assert.equal(recovery.arguments.scanId, undefined)
      assert.equal((await f.call('router_query', recovery.arguments)).ok, true)
    }
    assert.equal(f.journal.length, 0)
    await f.end()
  } finally { await f.close() }
})

test('default detail paginates source metadata within budget and explicit reads reconstruct the original', async () => {
  const rows = objects(), f = await routerFixture(rows, { now }), tokenizer = await loadRouterTokenizer()
  try {
    const requestId = await f.submit({ prompt: '检查需求范围' })
    const refs: string[] = []
    let cursor: string | undefined
    do {
      const response = await f.call('router_query', { requestId, mode: 'object_detail', objectId: 'requirement', cursor })
      assert.equal(response.ok, true)
      assert.ok(tokenizer.count(JSON.stringify(response.value)) <= 3000, 'default detail including its protocol envelope stays bounded')
      for (const row of response.value.sources) {
        assert.equal(row.text, undefined, 'source directory must not load all original documents')
        assert.ok(row.chars > 0)
        refs.push(row.ref)
      }
      cursor = response.value.nextCursor || undefined
    } while (cursor)
    assert.equal(refs.length, 40)
    assert.equal(new Set(refs).size, 40)
    let text = ''
    do {
      const response = await f.call('router_query', { requestId, mode: 'object_detail', objectId: 'requirement', sourceRef: refs[0], cursor })
      assert.equal(response.ok, true)
      assert.ok(tokenizer.count(JSON.stringify(response.value)) <= 4000)
      text += response.value.sources[0].text
      cursor = response.value.nextCursor || undefined
    } while (cursor)
    assert.equal(text, rows.find(row => row.id === 'requirement')!.sources![0].text)
    await f.end()
  } finally { await f.close() }
})

test('source cursors reject another request, object, source and changed revision', async () => {
  const rows = objects(), f = await routerFixture(rows, { now })
  try {
    const requestId = await f.submit({ prompt: '检查来源分页' })
    const first = await f.call('router_query', { requestId, mode: 'object_detail', objectId: 'requirement', sourceRef: 'document:0' })
    assert.ok(first.value.nextCursor)
    for (const args of [{ objectId: 'requirement', sourceRef: 'document:1' }, { objectId: 'other-requirement', sourceRef: 'document:0' }, { objectId: 'requirement' }]) {
      assert.equal((await f.call('router_query', { requestId, mode: 'object_detail', cursor: first.value.nextCursor, ...args })).error, 'invalid_reading_cursor')
    }
    const otherId = f.db.register({ prompt: '其他请求', requestId: randomUUID() }, f.config).requestId
    await assert.rejects(f.db.detail(otherId, 'requirement', 'document:0', first.value.nextCursor), /invalid_reading_cursor/)
    rows.find(row => row.id === 'requirement')!.sources![0].text += '新的原文'
    assert.equal((await f.call('router_query', { requestId, mode: 'object_detail', objectId: 'requirement', sourceRef: 'document:0', cursor: first.value.nextCursor })).error, 'invalid_reading_cursor')
    await f.end()
  } finally { await f.close() }
})

test('the 72-hour window limits automatic candidates, not direct old or archived reads', async () => {
  const rows = objects(), f = await routerFixture(rows, { now })
  try {
    const requestId = await f.submit({ prompt: '继续 old-task 原目标' })
    const old = await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'old-task' })
    assert.equal(old.ok, true, 'an explicitly located old task is readable regardless of the candidate window')
    assert.equal(old.value.item.id, 'old-task')
    assert.equal((await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'requirement' } })).value.items.some((row: any) => row.id === 'old-task'), false)
    rows.find(row => row.id === 'requirement')!.archived = true
    assert.equal((await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'task' })).ok, true, 'material under an archived requirement remains readable')
    assert.equal((await f.call('router_query', { requestId, mode: 'object_detail', objectId: 'requirement' })).ok, true, 'archived requirement metadata remains readable')
    const count = f.journal.length
    const assignment = await f.call('router_assign_task', { requestId, version: f.db.request(requestId)!.version, action: 'reuse_task', taskId: 'task', reason: '继续原任务' })
    assert.equal(assignment.errorDetails.code, 'task_not_eligible', 'an archived parent cannot be delivered')
    assert.equal(f.journal.length, count)
    await f.end()
  } finally { await f.close() }
})

test('large recent updates cannot inflate a candidate beyond the page budget', async () => {
  const f = await routerFixture(objects(), { now }), tokenizer = await loadRouterTokenizer()
  try {
    const requestId = await f.submit({ prompt: '查询近期任务' })
    const result = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'requirement' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.items.map((row: any) => row.id), ['task'])
    assert.ok(tokenizer.count(JSON.stringify(result.value)) <= 4000)
    assert.ok(result.value.items[0].recentChanges[0].text.length < 1000)
    await f.end()
  } finally { await f.close() }
})
