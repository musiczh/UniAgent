import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject, RouterQuery, RouterScope } from '../src/shared/router'

// Focused reproduction for router snapshot recovery loops.
//
// Every scenario uses the isolated router-quality fixture (temporary SQLite
// directory, real RouterController + Database + HTTP bridge). It never touches
// the installed app, real router DBs, model calls or task delivery; the fixture
// journal stays empty because these cases only issue router_query calls.
//
// The assertions verify the observable contract of a failed query: the error
// receipt's recovery arguments, and the result of actually executing those
// arguments. No production source strings are inspected.

type Fixture = Awaited<ReturnType<typeof routerFixture>>
type CallResult = {
  ok?: boolean
  value?: any
  error?: string
  errorDetails?: {
    code?: string
    message?: string
    recovery?: { action?: string; arguments?: Partial<RouterQuery> }
  }
}

async function executeRecovery(fixture: Fixture, requestId: string, args: Partial<RouterQuery>): Promise<CallResult> {
  return await fixture.call('router_query', { requestId, ...args }) as CallResult
}

function expectFailure(result: CallResult, code: string) {
  assert.equal(result.ok, false, `expected ${code}, got result: ${JSON.stringify(result.value ?? null).slice(0, 400)}`)
  assert.equal(result.error, code, `error receipt code: ${result.error}`)
  assert.equal(result.errorDetails?.code, code)
  const recovery = result.errorDetails?.recovery
  assert.ok(recovery, 'a router query failure must carry a recovery receipt')
  assert.equal(recovery.action, 'query', 'snapshot conflicts are recovered by re-reading, not by retrying the same call')
  assert.ok(recovery.arguments, 'recovery must be executable without another lookup')
  return { recovery, args: recovery.arguments! }
}

function expectNoKeys(args: Partial<RouterQuery>, keys: Array<keyof RouterQuery>) {
  for (const key of keys) assert.equal(args[key], undefined, `recovery.arguments must not keep ${String(key)}`)
}

async function runScenario(name: string, run: (log: (message: string) => void) => Promise<void>): Promise<boolean> {
  try {
    await run(message => console.log(`[${name}] ${message}`))
    console.log(`PASS ${name}`)
    return true
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function caseTaskBriefsStaleScan(): Promise<boolean> {
  return runScenario('case 1: task_briefs stale scan after task version change', async log => {
    const now = Date.now(), scope: RouterScope = { kind: 'requirement', requirementId: 'req' }
    const objects: RouterObject[] = [
      { id: 'space', kind: 'space', title: '空间', summary: '工作空间', projectId: 'space', version: '1' },
      { id: 'req', kind: 'requirement', title: '需求', summary: '承载任务', projectId: 'space', version: '1' },
      { id: 'task', kind: 'task', title: '任务 A', summary: '继续原方案', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now,
        sources: [{ ref: 'task:input', title: '原输入', text: '继续原方案。', at: now }] },
      { id: 'sibling', kind: 'task', title: '任务 B', summary: '同需求任务', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now - 1000,
        sources: [{ ref: 'sibling:input', title: '原输入', text: '另一项任务。', at: now }] }
    ]
    const f = await routerFixture(objects, { now })
    try {
      const requestId = await f.submit({ prompt: '复现 task_briefs 旧快照版本冲突' })
      await f.waitActive(requestId)

      const first = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      assert.equal(first.ok, true, `initial task_briefs failed: ${JSON.stringify(first.errorDetails ?? first.error)}`)
      const oldSnapshotId = first.value.snapshotId as string
      assert.deepEqual(first.value.items.map((row: any) => row.id).sort(), ['sibling', 'task'])

      // The object returned by the scan changes; the next query is expected to
      // reuse the old scan unless it explicitly refreshes.
      objects.find(row => row.id === 'task')!.version = '2'
      await f.db.index(objects)
      assert.equal(f.db.object('task').version, '2', 'the new task version is indexed before the reuse is checked')

      const conflict = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      log(`actual recovery: ${JSON.stringify(conflict.errorDetails?.recovery)}`)
      const { args } = expectFailure(conflict, 'object_revision_changed')

      // What the current receipt asks the model to do, followed by the natural
      // next query. This reproduces the loop without asserting its presence.
      const followed = await executeRecovery(f, requestId, args)
      const replay = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      log(`executing receipt arguments -> ${followed.ok ? 'ok' : String(followed.error)}; task_briefs again -> ${replay.ok ? 'ok' : String(replay.error)}`)

      assert.equal(args.requestId, requestId)
      assert.equal(args.mode, 'task_briefs', 'recovery must re-read the same query mode')
      assert.deepEqual(args.selectedScope, scope, 'recovery must keep the same selected scope')
      assert.equal(args.refresh, true, 'recovery must force a fresh scan instead of reusing the stale snapshot')
      expectNoKeys(args, ['cursor', 'scanId'])

      const recovered = await executeRecovery(f, requestId, args)
      log(`executing expected same-scope refresh -> ${recovered.ok ? 'ok' : String(recovered.error)}`)
      assert.equal(recovered.ok, true, `recovery arguments still loop: ${JSON.stringify(recovered.errorDetails ?? recovered.error)}`)
      assert.notEqual(recovered.value.snapshotId, oldSnapshotId, 'recovery must produce a new snapshot')
      assert.deepEqual(recovered.value.items.map((row: any) => row.id).sort(), ['sibling', 'task'])
      assert.equal(recovered.value.reading.scanId, recovered.value.snapshotId)
      assert.equal(f.db.request(requestId)!.context!.reading!.scans!['requirement:req'].scanId, recovered.value.snapshotId)
      assert.equal(f.db.request(requestId)!.context!.objects!.find(row => row.id === 'task')!.version, '2')
      assert.equal(f.journal.length, 0, 'query recovery must not allocate a task')
    } finally { await f.close() }
  })
}

async function caseExpiredManifest(): Promise<boolean> {
  return runScenario('case 2: reading_snapshot_expired leaves the old scanId readable', async log => {
    const now = Date.now(), scope: RouterScope = { kind: 'requirement', requirementId: 'req' }
    const objects: RouterObject[] = [
      { id: 'space', kind: 'space', title: '空间', summary: '工作空间', projectId: 'space', version: '1' },
      { id: 'req', kind: 'requirement', title: '需求', summary: '承载任务', projectId: 'space', version: '1' },
      { id: 'task', kind: 'task', title: '任务', summary: '继续原方案', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now,
        sources: [{ ref: 'task:input', title: '原输入', text: '继续原方案。', at: now }] }
    ]
    const f = await routerFixture(objects, { now })
    try {
      const requestId = await f.submit({ prompt: '复现阅读快照失效后的恢复循环' })
      await f.waitActive(requestId)

      const first = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      assert.equal(first.ok, true)
      const oldSnapshotId = first.value.snapshotId as string
      assert.equal(f.db.request(requestId)!.context!.reading!.scans!['requirement:req'].scanId, oldSnapshotId)

      // Delete the persisted reading manifest from the isolated SQLite file, as
      // an app restart or cleanup would. The request still carries the old scanId.
      const sqlite = new Database(join(f.directory, 'router.sqlite'))
      try {
        const deleted = sqlite.prepare('DELETE FROM router_meta WHERE id=?').run('context:reading:' + oldSnapshotId)
        assert.equal(deleted.changes, 1, 'the isolated reading manifest existed before deletion')
        assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM router_meta WHERE id=?').get('context:reading:' + oldSnapshotId) as { n: number }).n, 0)
      } finally { sqlite.close() }

      const conflict = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      log(`actual recovery: ${JSON.stringify(conflict.errorDetails?.recovery)}`)
      const { args } = expectFailure(conflict, 'reading_snapshot_expired')

      const followed = await executeRecovery(f, requestId, args)
      const replay = await f.call('router_query', { requestId, mode: 'task_briefs', selectedScope: scope }) as CallResult
      log(`executing receipt arguments -> ${followed.ok ? 'ok' : String(followed.error)}; task_briefs again -> ${replay.ok ? 'ok' : String(replay.error)}`)

      assert.equal(args.requestId, requestId)
      assert.equal(args.mode, 'task_briefs', 'recovery must re-read the same query mode')
      assert.deepEqual(args.selectedScope, scope, 'recovery must keep the same selected scope')
      assert.equal(args.refresh, true, 'dropping the cursor alone reuses the expired reading.scanId and loops')
      expectNoKeys(args, ['cursor', 'scanId'])

      const recovered = await executeRecovery(f, requestId, args)
      log(`executing expected same-scope refresh -> ${recovered.ok ? 'ok' : String(recovered.error)}`)
      assert.equal(recovered.ok, true, `recovery arguments still loop: ${JSON.stringify(recovered.errorDetails ?? recovered.error)}`)
      assert.notEqual(recovered.value.snapshotId, oldSnapshotId, 'recovery must create a new snapshot instead of reusing the deleted one')
      assert.equal(recovered.value.reading.scanId, recovered.value.snapshotId)
      assert.equal(f.db.request(requestId)!.context!.reading!.scans!['requirement:req'].scanId, recovered.value.snapshotId)
      assert.equal(f.journal.length, 0, 'query recovery must not allocate a task')
    } finally { await f.close() }
  })
}

async function caseCatalogPageRevision(): Promise<boolean> {
  return runScenario('case 3: catalog cursor page conflict must refresh the same catalog first page', async log => {
    const now = Date.now()
    const requirements: RouterObject[] = Array.from({ length: 25 }, (_, index) => ({
      id: 'req-' + String(index).padStart(2, '0'), kind: 'requirement' as const,
      title: '需求' + String(index).padStart(2, '0'), summary: '需求描述', projectId: 'space', version: '1'
    }))
    const objects: RouterObject[] = [
      { id: 'space', kind: 'space', title: '空间', summary: '工作空间', projectId: 'space', version: '1' },
      ...requirements
    ]
    const f = await routerFixture(objects, { now })
    try {
      const requestId = await f.submit({ prompt: '复现 catalog 分页版本冲突' })
      await f.waitActive(requestId)

      const first = await f.call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space' }) as CallResult
      assert.equal(first.ok, true, `initial catalog failed: ${JSON.stringify(first.errorDetails ?? first.error)}`)
      assert.ok(first.value.nextCursor, 'the fixture catalog must paginate')
      const firstPageIds = first.value.items.map((row: any) => row.id)
      const oldSnapshotId = first.value.snapshotId as string
      const sorted = [...requirements].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      const changed = sorted[firstPageIds.length]
      assert.ok(changed, 'there must be an object on the returned cursor page')

      // Version changes after the cursor snapshot was taken. The cursor page
      // still carries the old version and must not be handed to the model.
      changed.version = '2'
      await f.db.index(objects)
      assert.equal(f.db.object(changed.id).version, '2')
      const conflict = await f.call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space', cursor: first.value.nextCursor }) as CallResult
      log(`actual recovery: ${JSON.stringify(conflict.errorDetails?.recovery)}`)
      const { args } = expectFailure(conflict, 'object_revision_changed')

      const followed = await executeRecovery(f, requestId, args)
      log(`executing receipt arguments -> ${followed.ok ? `ok (${followed.value?.queryScope?.objectKind ?? 'object_detail'})` : String(followed.error)}`)

      assert.equal(args.requestId, requestId)
      assert.equal(args.mode, 'catalog', 'recovery must stay on the catalog query, not switch to an object read')
      assert.equal(args.kind, 'requirement')
      assert.equal(args.projectId, 'space')
      expectNoKeys(args, ['cursor', 'scanId', 'objectId', 'taskId', 'selectedScope', 'sourceRef'])

      const recovered = await executeRecovery(f, requestId, args)
      log(`executing expected catalog first page -> ${recovered.ok ? 'ok' : String(recovered.error)}`)
      assert.equal(recovered.ok, true, `recovery arguments still loop: ${JSON.stringify(recovered.errorDetails ?? recovered.error)}`)
      assert.notEqual(recovered.value.snapshotId, oldSnapshotId, 'recovery must start a new catalog snapshot')
      assert.equal(recovered.value.item, undefined, 'catalog recovery must not return a single unrelated object')
      assert.equal(recovered.value.queryScope.objectKind, 'requirement')
      assert.equal(recovered.value.queryScope.projectId, 'space')
      assert.deepEqual(recovered.value.items.map((row: any) => row.id), firstPageIds, 'recovery re-reads the same catalog first page')
      assert.ok(recovered.value.nextCursor, 'the refreshed catalog still paginates')
      assert.equal(f.journal.length, 0, 'query recovery must not allocate a task')
    } finally { await f.close() }
  })
}

async function caseSameTargetRecovery(): Promise<boolean> {
  return runScenario('case 4: missing source and task_detail kind error keep same-target recovery', async log => {
    const now = Date.now()
    const objects: RouterObject[] = [
      { id: 'space', kind: 'space', title: '空间', summary: '工作空间', projectId: 'space', version: '1' },
      { id: 'req', kind: 'requirement', title: '需求', summary: '需求资料', projectId: 'space', version: '1',
        sources: [{ ref: 'req:goal', title: '范围', text: '需求范围。', at: now }] },
      { id: 'task', kind: 'task', title: '任务', summary: '继续原方案', projectId: 'space', requirementId: 'req', version: '1', lastBusinessUpdatedAt: now,
        sources: [{ ref: 'task:input', title: '原输入', text: '继续原方案。', at: now }] }
    ]
    const f = await routerFixture(objects, { now })
    try {
      const requestId = await f.submit({ prompt: '复现普通读取错误的同目标恢复' })
      await f.waitActive(requestId)

      const missing = await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'task', sourceRef: 'missing:source' }) as CallResult
      log(`missing source recovery: ${JSON.stringify(missing.errorDetails?.recovery)}`)
      const missingRecovery = expectFailure(missing, 'context_unavailable')
      assert.equal(missingRecovery.args.mode, 'task_detail')
      assert.equal(missingRecovery.args.taskId, 'task')
      expectNoKeys(missingRecovery.args, ['sourceRef', 'cursor', 'scanId'])
      const missingRead = await executeRecovery(f, requestId, missingRecovery.args)
      assert.equal(missingRead.ok, true, `missing-source recovery failed: ${JSON.stringify(missingRead.errorDetails ?? missingRead.error)}`)
      assert.equal(missingRead.value.item.id, 'task')

      const kindError = await f.call('router_query', { requestId, mode: 'task_detail', taskId: 'req' }) as CallResult
      log(`task_detail kind recovery: ${JSON.stringify(kindError.errorDetails?.recovery)}`)
      const kindRecovery = expectFailure(kindError, 'router_target_kind_conflict')
      assert.equal(kindRecovery.args.mode, 'object_detail', 'a non-task target is read as an object, not as a task')
      assert.equal(kindRecovery.args.objectId, 'req')
      expectNoKeys(kindRecovery.args, ['taskId', 'cursor', 'scanId', 'sourceRef'])
      const kindRead = await executeRecovery(f, requestId, kindRecovery.args)
      assert.equal(kindRead.ok, true, `kind-conflict recovery failed: ${JSON.stringify(kindRead.errorDetails ?? kindRead.error)}`)
      assert.equal(kindRead.value.item.id, 'req')
      assert.equal(kindRead.value.item.kind, 'requirement')
      assert.equal(f.journal.length, 0, 'query recovery must not allocate a task')
    } finally { await f.close() }
  })
}

const results = [
  await caseTaskBriefsStaleScan(),
  await caseExpiredManifest(),
  await caseCatalogPageRevision(),
  await caseSameTargetRecovery()
]
const failed = results.filter(ok => !ok).length
if (failed) {
  console.error(`FAIL Router snapshot recovery: ${failed}/${results.length} scenarios failed`)
  process.exitCode = 1
} else {
  console.log('PASS Router snapshot recovery: same-scope task_briefs refresh, expired-manifest refresh, same catalog first page, and same-target source/kind recovery')
}
