import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { join } from 'node:path'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'

const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '', projectId: 'space', version: '1' },
  { id: 'requirement', kind: 'requirement', title: 'Router', summary: '', projectId: 'space', version: '1' },
  { id: 'task', kind: 'task', title: '原任务', summary: '', projectId: 'space', requirementId: 'requirement', version: '1', busy: true,
    lastBusinessUpdatedAt: Date.now(), sources: [{ ref: 'input', title: '原目标', text: '继续原任务的路由方案。', at: 1 }] }
]

async function repeatedFailure(f: Awaited<ReturnType<typeof routerFixture>>, requestId: string) {
  let message = ''
  for (let i = 0; i < 2; i++) {
    const failed = await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'task', scanId: 'expired-scan' })
    assert.equal(failed.error, 'scan_scope_mismatch')
    message = failed.errorDetails.message
  }
  assert.equal(f.db.request(requestId)!.error, message, 'persist the actual recovery explanation returned to the model')
  assert.equal(f.db.request(requestId)!.failure?.code, 'router-tool-recovery')
}

test('a successful query clears recovered tool errors while retaining native turn failures', async () => {
  const f = await routerFixture(objects)
  try {
    const requestId = await f.submit({ prompt: '继续原任务' })
    await f.call('router_query', { requestId, mode: 'bootstrap' })
    await repeatedFailure(f, requestId)
    const recovered = await f.call('router_query', { requestId, mode: 'catalog', kind: 'space' })
    assert.equal(recovered.ok, true)
    assert.equal(f.db.request(requestId)!.error, undefined, 'successful reading must retire the previous tool error')
    assert.equal(f.db.request(requestId)!.failure, undefined)
    await f.controller.event({ sessionId: f.db.sessionId(), seq: 1, ts: Date.now(), type: 'error', state: 'failed',
      payload: { code: 'ECONNRESET', message: 'native connection reset', routedInputId: requestId } })
    await f.call('router_query', { requestId, mode: 'bootstrap' })
    assert.equal(f.db.request(requestId)!.error, 'native connection reset', 'a read cannot resolve an unrelated native failure')
    await f.end()
  } finally { await f.close() }
})

for (const action of ['reuse_task', 'create_task_in_requirement', 'create_task_in_space', 'create_requirement_and_task', 'clarify'] as const) {
  test(`${action} returns a clean receipt after repeated tool errors and lets the queue continue`, async () => {
    const f = await routerFixture(objects)
    try {
      const requestId = await f.submit({ prompt: '继续原任务' })
      await f.call('router_query', { requestId, mode: 'bootstrap' })
      await repeatedFailure(f, requestId)
      const args = { requestId, version: f.db.request(requestId)!.version, action, reason: '本轮信息足以确定结果',
        ...(action === 'reuse_task' ? { taskId: 'task' } : action === 'create_task_in_requirement' ? { requirementId: 'requirement' } :
          action === 'clarify' ? { clarification: '要继续哪个目标？', clarificationOptions: [] } : { projectId: 'space' }),
        ...(action === 'create_requirement_and_task' ? { requirementName: '新需求' } : {}) }
      const result = await f.call('router_assign_task', args)
      assert.equal(result.ok, true)
      assert.equal(result.value.state, action === 'clarify' ? 'needs_input' : 'bound')
      assert.equal(result.value.error, undefined, 'a successful receipt must not tell the model to investigate a past error')
      assert.equal(f.db.request(requestId)!.error, undefined)
      assert.equal(f.db.request(requestId)!.failure, undefined)
      assert.equal((await f.call('router_assign_task', args)).ok, true)
      assert.equal(f.journal.length, action === 'clarify' ? 0 : 1, 're-reading the receipt must not redeliver the input')
      const nextId = randomUUID()
      await f.controller.submit({ requestId: nextId, prompt: '下一项分配' })
      await f.end()
      for (let i = 0; i < 100 && f.db.request(nextId)?.state !== 'routing'; i++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal((await f.controller.snapshot()).activeRequestId, nextId, 'the next input starts after the native turn settles')
      assert.equal(f.journal.length, action === 'clarify' ? 0 : 1)
      await f.end()
    } finally { await f.close() }
  })
}

test('a known task can be read directly without prerequisite recovery queries', async () => {
  const f = await routerFixture(objects)
  try {
    const requestId = await f.submit({ prompt: '继续原任务' })
    await f.call('router_query', { requestId, mode: 'bootstrap' })
    const detail = await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'task', sourceRef: 'input' })
    assert.equal(detail.ok, true)
    assert.equal(detail.value.sources[0].text, '继续原任务的路由方案。')
    assert.equal(f.db.request(requestId)!.error, undefined)
    await f.end()
  } finally { await f.close() }
})

test('a requirement catalog accepts a known project without first reading its space catalog', async () => {
  const f = await routerFixture(objects)
  try {
    const requestId = await f.submit({ prompt: '查询需求' })
    await f.call('router_query', { requestId, mode: 'bootstrap' })
    const args = { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space' }
    const catalog = await f.call('router_query', args)
    assert.equal(catalog.ok, true)
    assert.deepEqual(catalog.value.items.map((row: any) => row.id), ['requirement'])
    await f.end()
  } finally { await f.close() }
})

test('restart clears stale errors from confirmed receipts without changing uncertain or failed deliveries', async () => {
  const f = await routerFixture(objects)
  try {
    const confirmed = ['accepted', 'queued', 'running', 'finished'] as const
    const deliveries = [...confirmed, 'unknown', 'failed', 'pending'] as const
    const rows = deliveries.map(delivery => {
      const row = f.db.register({ requestId: randomUUID(), prompt: '旧版分配记录' }, f.config)
      f.db.update(row.requestId, row.version, { state: 'bound', delivery, targetId: 'task',
        error: 'object_not_read', failure: { code: 'router-tool-recovery', sessionId: f.db.sessionId() } })
      return f.db.request(row.requestId)!
    })
    const native = f.db.register({ requestId: randomUUID(), prompt: '真实原生错误' }, f.config)
    f.db.update(native.requestId, native.version, { state: 'bound', delivery: 'queued',
      error: 'native connection reset', failure: { code: 'ECONNRESET', sessionId: f.db.sessionId() } })
    const nativeFailure = f.db.request(native.requestId)!
    await f.db.reviewRecover()
    await f.db.reviewRecover()
    const reopened = new RouterDatabase(join(f.directory, 'router.sqlite'))
    try {
      for (const row of rows) {
        const restored = reopened.request(row.requestId)!
        if ((confirmed as readonly string[]).includes(row.delivery)) {
          assert.equal(restored.error, undefined)
          assert.equal(restored.failure, undefined)
          assert.equal(restored.version, row.version + 1, 'cleanup runs only once')
          assert.equal(restored.delivery, row.delivery)
          assert.equal(restored.targetId, row.targetId)
        } else assert.deepEqual(restored, row, 'unknown and failed deliveries must retain their diagnostics')
      }
      assert.deepEqual(reopened.request(native.requestId), nativeFailure)
    } finally { reopened.close() }
    assert.equal(f.journal.length, 0, 'restart cleanup must never send business input')
  } finally { await f.close() }
})
