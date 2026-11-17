import assert from 'node:assert/strict'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'

// Focused reproduction for Router source navigation.
//
// A model is only told that `sources[].ref` addresses a source. It can read the
// source body only when the query result carries an executable continuation.
// These scenarios use the isolated router-quality fixture (temporary SQLite,
// real RouterController + Database + HTTP MCP bridge) and execute exactly the
// continuation parameters the tool returned. No model, installed app, real
// router database, or business task delivery is involved.
//
// Contract under test:
// 1. object_detail/task_detail default source directories give every source a
//    continueWith carrying requestId + mode + objectId/taskId + sourceRef and
//    no cursor/scanId. Executing it reads that source body, not the directory.
//    task_detail current entries reuse the same navigation.
// 2. catalog and task_briefs reject sourceRef with invalid_router_arguments
//    instead of returning a directory that can be mistaken for the body.
// 3. ordinary catalog/task_briefs listing, per-source pagination and direct
//    assignment without material reads keep working (no mandatory read gate).

type Fixture = Awaited<ReturnType<typeof routerFixture>>
type CallResult = { ok?: boolean; value?: any; error?: string; errorDetails?: { code?: string; message?: string } }
type CheckRecord = { name: string; ok: boolean; error?: string }

const checks: CheckRecord[] = []
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const actual = (value: unknown) => {
  const text = JSON.stringify(value ?? null) ?? 'undefined'
  return text.length > 700 ? text.slice(0, 700) + '…' : text
}

async function check(name: string, run: () => Promise<void> | void): Promise<boolean> {
  try {
    await run()
    checks.push({ name, ok: true })
    console.log('PASS ' + name)
    return true
  } catch (error) {
    const message = errorText(error)
    checks.push({ name, ok: false, error: message })
    console.error('FAIL ' + name + ': ' + message)
    return false
  }
}

const LONG_REQUIREMENT_DOC = '需求文档：资料导航返回的续读参数必须能直接执行并读到正文，而不是再次返回目录。'.repeat(160)
const LONG_REQUIREMENT_INPUT = '需求来源：免费模型反复用 catalog 携带 sourceRef 读取正文，接口应明确拒绝而不是返回目录。'.repeat(140)
const LONG_TASK_DOC = '任务文档：对象详情与任务详情的来源目录都要给出完整的续读参数。'.repeat(160)
const LONG_TASK_INPUT = '任务当前输入：默认详情只给节选，必须能沿同一请求续读到完整原文。'.repeat(150)

function routerObjects(now: number): RouterObject[] {
  return [
    { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', version: '1', projectId: 'space' },
    {
      id: 'req-a', kind: 'requirement', title: '资料导航', summary: 'Router 来源导航协议', version: '1', projectId: 'space',
      sources: [
        { ref: 'req:doc', title: '需求文档', kind: 'document', text: LONG_REQUIREMENT_DOC, at: now },
        { ref: 'req:input', title: '需求来源', kind: 'user_input', role: 'current_input', text: LONG_REQUIREMENT_INPUT, at: now }
      ]
    },
    {
      id: 'req-b', kind: 'requirement', title: '另一需求', summary: '独立资料', version: '1', projectId: 'space',
      sources: [{ ref: 'req-b:doc', title: '另一需求文档', kind: 'document', text: '另一需求的独立资料。', at: now }]
    },
    {
      id: 'task-a', kind: 'task', title: '导航协议回归', summary: '直接复用来源导航', version: '1', projectId: 'space', requirementId: 'req-a',
      lastBusinessUpdatedAt: now, nativeSessionId: 'native-task-a', agentId: 'codex',
      sources: [
        { ref: 'task:doc', title: '任务文档', kind: 'document', text: LONG_TASK_DOC, at: now },
        { ref: 'task:input', title: '最新输入', kind: 'user_input', role: 'current_input', text: LONG_TASK_INPUT, at: now },
        { ref: 'task:reply', title: '近期回答', kind: 'agent_output', role: 'recent_output', text: '已完成目录返回，等待来源正文导航。', at: now },
        { ref: 'task:status', title: '当前状态', kind: 'system_state', role: 'status', text: JSON.stringify({ status: 'running', lifecycle: 'active' }), at: now },
        { ref: 'task:goal', title: '原始目标', kind: 'user_input', role: 'original_goal', text: '原始目标：建立资料导航协议回归。', at: now }
      ]
    },
    {
      id: 'task-b', kind: 'task', title: '另一任务', summary: '独立资料', version: '1', projectId: 'space', requirementId: 'req-b',
      lastBusinessUpdatedAt: now - 1000, nativeSessionId: 'native-task-b', agentId: 'codex',
      sources: [{ ref: 'task-b:doc', title: '另一任务文档', kind: 'document', text: '另一任务的独立资料。', at: now }]
    },
    {
      id: 'space-task', kind: 'task', title: '项目直属任务', summary: '项目直属', version: '1', projectId: 'space',
      lastBusinessUpdatedAt: now - 2000, nativeSessionId: 'native-space-task', agentId: 'codex',
      sources: [{ ref: 'space-task:doc', title: '直属任务资料', kind: 'document', text: '项目直属任务的资料。', at: now }]
    }
  ]
}

function sourceText(objects: RouterObject[], objectId: string, ref: string): string {
  const text = objects.find(row => row.id === objectId)?.sources?.find(row => row.ref === ref)?.text
  assert.equal(typeof text, 'string', `fixture source ${objectId}/${ref} must exist`)
  return text!
}

// Each scenario gets its own isolated fixture. A failure records the check and
// continues with the remaining scenarios; the first failure never aborts the
// rest of the protocol matrix.
async function scenario(name: string, run: (fixture: Fixture, objects: RouterObject[]) => Promise<void>): Promise<void> {
  const now = Date.now(), objects = routerObjects(now)
  let fixture: Fixture | undefined
  try {
    fixture = await routerFixture(objects, { now })
    await run(fixture, objects)
  } catch (error) {
    const message = errorText(error)
    checks.push({ name: name + ' (scenario aborted)', ok: false, error: message })
    console.error(`FAIL ${name} (scenario aborted): ${message}`)
  } finally {
    await fixture?.close()
  }
}

// Verify the returned continuation verbatim. The scenario never rebuilds or
// repairs missing fields, so a partial navigation is reported as a real failure
// instead of being silently completed by the test.
async function verifySourceNavigation(
  fixture: Fixture,
  requestId: string,
  label: string,
  item: any,
  expected: { mode: 'object_detail' | 'task_detail'; objectId?: string; taskId?: string },
  fullText: string
): Promise<void> {
  await check(label, async () => {
    const navigation = item?.continueWith
    assert.ok(item && typeof item.ref === 'string', `default read returned an entry without a source ref: ${actual(item)}`)
    assert.ok(navigation && typeof navigation === 'object',
      `no continueWith for ${item.ref}; the model only receives ref ${actual(item.ref)} and cannot read the body: ${actual(item)}`)
    assert.equal(navigation.requestId, requestId,
      `continueWith must carry the current requestId; actual ${actual(navigation)}`)
    assert.equal(navigation.mode, expected.mode,
      `continueWith mode must be ${expected.mode}; actual ${actual(navigation)}`)
    if (expected.mode === 'object_detail') {
      assert.equal(navigation.objectId, expected.objectId,
        `continueWith must target objectId ${expected.objectId}; actual ${actual(navigation)}`)
      assert.equal(navigation.taskId, undefined,
        `object_detail navigation must not carry taskId; actual ${actual(navigation)}`)
    } else {
      assert.equal(navigation.taskId, expected.taskId,
        `continueWith must target taskId ${expected.taskId}; actual ${actual(navigation)}`)
      assert.equal(navigation.objectId, undefined,
        `task_detail navigation must not carry objectId; actual ${actual(navigation)}`)
    }
    assert.equal(navigation.sourceRef, item.ref,
      `continueWith must keep sourceRef ${item.ref}; actual ${actual(navigation)}`)
    assert.equal(navigation.cursor, undefined,
      `continueWith must not carry cursor; actual ${actual(navigation)}`)
    assert.equal(navigation.scanId, undefined,
      `continueWith must not carry scanId; actual ${actual(navigation)}`)

    // Execute the object the tool returned, without adding requestId or fixing
    // any field, so "returns a ref but not navigation" is observable.
    const page = await fixture.call('router_query', navigation) as CallResult
    assert.equal(page.ok, true,
      `executing continueWith failed with ${actual(page.error ?? page.errorDetails)}`)
    assert.equal(page.value?.item?.id, expected.objectId ?? expected.taskId,
      `continueWith returned another object: ${actual(page.value?.item)}`)
    assert.equal(page.value?.coverage?.basis, 'source_text',
      `continueWith returned a directory instead of the source body (coverage ${actual(page.value?.coverage)})`)
    assert.equal(page.value?.items, undefined, 'continueWith must not return a catalog page')
    assert.equal(page.value?.sources?.length, 1,
      `a source read returns exactly the requested source; actual ${actual(page.value?.sources)}`)
    assert.equal(page.value.sources[0].ref, item.ref,
      `source read returned another source: ${actual(page.value.sources[0])}`)
    const text = page.value.sources[0].text
    assert.equal(typeof text, 'string', `source body must be text; actual ${actual(text)}`)
    assert.ok(text.length > 0, 'source body is empty')
    assert.ok(fullText.startsWith(text), `source body is not the original excerpt/body: ${actual(text)}`)
  })
}

await scenario('object_detail default source directory', async (fixture, objects) => {
  const requestId = await fixture.submit({ prompt: '核对需求详情的来源导航' })
  try {
    await fixture.waitActive(requestId)
    const detail = await fixture.call('router_query', { requestId, mode: 'object_detail', objectId: 'req-a' }) as CallResult
    const readable = await check('object_detail(req-a) returns the source directory', () => {
      assert.equal(detail.ok, true, `object_detail failed: ${actual(detail.error ?? detail.errorDetails)}`)
      assert.equal(detail.value?.item?.id, 'req-a')
      assert.equal(detail.value?.item?.kind, 'requirement')
      assert.equal(detail.value?.coverage?.basis, 'source_directory', `expected a directory first; actual ${actual(detail.value?.coverage)}`)
      assert.deepEqual(detail.value?.sources?.map((row: any) => row.ref).sort(), ['req:doc', 'req:input'])
    })
    if (!readable) return
    for (const item of detail.value.sources as any[]) {
      await verifySourceNavigation(fixture, requestId, `object_detail source ${item.ref} is directly readable`,
        item, { mode: 'object_detail', objectId: 'req-a' }, sourceText(objects, 'req-a', item.ref))
    }
  } finally { await fixture.end() }
})

await scenario('task_detail default sources and current', async (fixture, objects) => {
  const requestId = await fixture.submit({ prompt: '核对任务详情与当前材料的来源导航' })
  try {
    await fixture.waitActive(requestId)
    const detail = await fixture.call('router_query', { requestId, mode: 'task_detail', taskId: 'task-a' }) as CallResult
    const readable = await check('task_detail(task-a) returns sources and current materials', () => {
      assert.equal(detail.ok, true, `task_detail failed: ${actual(detail.error ?? detail.errorDetails)}`)
      assert.equal(detail.value?.item?.id, 'task-a')
      assert.equal(detail.value?.coverage?.basis, 'source_directory')
      assert.deepEqual(detail.value?.sources?.map((row: any) => row.ref).sort(), ['task:doc', 'task:goal', 'task:input', 'task:reply', 'task:status'])
      assert.deepEqual(detail.value?.current?.map((row: any) => row.role), ['current_input', 'recent_output', 'status', 'original_goal'])
    })
    if (!readable) return
    for (const item of detail.value.sources as any[]) {
      await verifySourceNavigation(fixture, requestId, `task_detail source ${item.ref} is directly readable`,
        item, { mode: 'task_detail', taskId: 'task-a' }, sourceText(objects, 'task-a', item.ref))
    }
    for (const item of detail.value.current as any[]) {
      await verifySourceNavigation(fixture, requestId, `task_detail current ${item.role} (${item.ref}) is directly readable`,
        item, { mode: 'task_detail', taskId: 'task-a' }, sourceText(objects, 'task-a', item.ref))
    }
    const sources = new Map((detail.value.sources as any[]).map(row => [row.ref, row]))
    for (const item of detail.value.current as any[]) {
      // A missing source navigation is already reported by the per-item check
      // above; only compare when both sides expose one.
      if (!sources.get(item.ref)?.continueWith) continue
      await check(`task_detail current ${item.ref} reuses the source navigation`, () => {
        assert.ok(item.continueWith, `current ${item.ref} has no continueWith to reuse`)
        assert.deepEqual(item.continueWith, sources.get(item.ref)!.continueWith,
          `current navigation must equal the source directory navigation for ${item.ref}`)
      })
    }
  } finally { await fixture.end() }
})

await scenario('catalog and task_briefs sourceRef misuse', async fixture => {
  const requestId = await fixture.submit({ prompt: '核对目录查询不接受来源续读参数' })
  try {
    await fixture.waitActive(requestId)

    const catalog = await fixture.call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space', sourceRef: 'req:doc' }) as CallResult
    await check('catalog with sourceRef is rejected instead of returning a directory', () => {
      assert.equal(catalog.ok, false, `catalog accepted sourceRef and returned ${actual(catalog.value ?? catalog)}`)
      assert.equal(catalog.error, 'invalid_router_arguments', `actual error: ${actual(catalog.error ?? catalog.errorDetails)}`)
      assert.equal(catalog.errorDetails?.code, 'invalid_router_arguments')
    })

    const briefs = await fixture.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'req-a' }, sourceRef: 'task:doc' }) as CallResult
    await check('task_briefs with sourceRef is rejected instead of returning a directory', () => {
      assert.equal(briefs.ok, false, `task_briefs accepted sourceRef and returned ${actual(briefs.value ?? briefs)}`)
      assert.equal(briefs.error, 'invalid_router_arguments', `actual error: ${actual(briefs.error ?? briefs.errorDetails)}`)
      assert.equal(briefs.errorDetails?.code, 'invalid_router_arguments')
    })

    // A rejected misuse must not poison the same request.
    const catalogAfter = await fixture.call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space' }) as CallResult
    await check('normal catalog still works after a rejected sourceRef', () => {
      assert.equal(catalogAfter.ok, true, `normal catalog failed: ${actual(catalogAfter.error ?? catalogAfter.errorDetails)}`)
      assert.deepEqual(catalogAfter.value?.items?.map((row: any) => row.id).sort(), ['req-a', 'req-b'])
    })
    const briefsAfter = await fixture.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'req-a' } }) as CallResult
    await check('normal task_briefs still works after a rejected sourceRef', () => {
      assert.equal(briefsAfter.ok, true, `normal task_briefs failed: ${actual(briefsAfter.error ?? briefsAfter.errorDetails)}`)
      assert.deepEqual(briefsAfter.value?.items?.map((row: any) => row.id), ['task-a'])
    })
  } finally { await fixture.end() }
})

await scenario('ordinary listing, pagination and direct assignment', async (fixture, objects) => {
  const requestId = await fixture.submit({ prompt: '正常目录读取后直接分配' })
  try {
    await fixture.waitActive(requestId)

    const catalog = await fixture.call('router_query', { requestId, mode: 'catalog', kind: 'requirement', projectId: 'space' }) as CallResult
    await check('catalog(kind=requirement, projectId=space) lists requirements', () => {
      assert.equal(catalog.ok, true, `catalog failed: ${actual(catalog.error ?? catalog.errorDetails)}`)
      assert.deepEqual(catalog.value?.items?.map((row: any) => row.id).sort(), ['req-a', 'req-b'])
    })
    const briefs = await fixture.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'req-a' } }) as CallResult
    await check('task_briefs(requirement req-a) lists its task', () => {
      assert.equal(briefs.ok, true, `task_briefs failed: ${actual(briefs.error ?? briefs.errorDetails)}`)
      assert.deepEqual(briefs.value?.items?.map((row: any) => row.id), ['task-a'])
    })
    const spaceBriefs = await fixture.call('router_query', { requestId, mode: 'task_briefs', selectedScope: { kind: 'space', projectId: 'space' } }) as CallResult
    await check('task_briefs(space space) lists only project-direct tasks', () => {
      assert.equal(spaceBriefs.ok, true, `task_briefs failed: ${actual(spaceBriefs.error ?? spaceBriefs.errorDetails)}`)
      assert.deepEqual(spaceBriefs.value?.items?.map((row: any) => row.id), ['space-task'])
    })

    const requirementDoc = sourceText(objects, 'req-a', 'req:doc')
    await check('object_detail source reads keep paginating the full document', async () => {
      let cursor: string | undefined, text = '', pages = 0
      do {
        const page = await fixture.call('router_query', { requestId, mode: 'object_detail', objectId: 'req-a', sourceRef: 'req:doc', ...(cursor ? { cursor } : {}) }) as CallResult
        assert.equal(page.ok, true, `object source page ${pages + 1} failed: ${actual(page.error ?? page.errorDetails)}`)
        assert.equal(page.value?.coverage?.basis, 'source_text')
        assert.equal(page.value?.sources?.[0]?.ref, 'req:doc')
        text += page.value.sources[0].text
        cursor = page.value.nextCursor || undefined
        pages++
        assert.ok(pages < 20, 'object source pagination did not terminate')
      } while (cursor)
      assert.ok(pages > 1, `expected the long requirement document to paginate, got ${pages} page(s)`)
      assert.equal(text, requirementDoc)
    })

    const taskDoc = sourceText(objects, 'task-a', 'task:doc')
    await check('task_detail source reads keep paginating the full document', async () => {
      let cursor: string | undefined, text = '', pages = 0
      do {
        const page = await fixture.call('router_query', { requestId, mode: 'task_detail', taskId: 'task-a', sourceRef: 'task:doc', ...(cursor ? { cursor } : {}) }) as CallResult
        assert.equal(page.ok, true, `task source page ${pages + 1} failed: ${actual(page.error ?? page.errorDetails)}`)
        assert.equal(page.value?.coverage?.basis, 'source_text')
        assert.equal(page.value?.sources?.[0]?.ref, 'task:doc')
        text += page.value.sources[0].text
        cursor = page.value.nextCursor || undefined
        pages++
        assert.ok(pages < 20, 'task source pagination did not terminate')
      } while (cursor)
      assert.ok(pages > 1, `expected the long task document to paginate, got ${pages} page(s)`)
      assert.equal(text, taskDoc)
    })

    // No mandatory read gate: a task located from the listing can be assigned
    // directly without first reading its detail or any source body.
    const assignment = await fixture.call('router_assign_task', {
      requestId, version: fixture.db.request(requestId)!.version, action: 'reuse_task', taskId: 'task-a', reason: '直接复用已定位任务'
    }) as CallResult
    await check('direct assignment works without reading material first', () => {
      assert.equal(assignment.ok, true, `assignment failed: ${actual(assignment.error ?? assignment.errorDetails)}`)
      assert.equal(assignment.value?.state, 'bound')
      assert.equal(assignment.value?.delivery, 'accepted')
      assert.deepEqual(fixture.journal, [{ action: 'reuse_task', target: 'task-a', requestId }])
      assert.deepEqual(fixture.deliveries.map(row => row.requestId), [requestId])
    })
  } finally { await fixture.end() }
})

const failed = checks.filter(row => !row.ok)
if (failed.length) {
  console.error(`FAIL Router source navigation: ${failed.length}/${checks.length} checks failed`)
  for (const row of failed) console.error(`  - ${row.name}: ${row.error?.replaceAll('\n', ' ')}`)
  process.exitCode = 1
} else {
  console.log(`PASS Router source navigation: ${checks.length} checks for object_detail/task_detail source continuations, current navigation reuse, catalog/task_briefs sourceRef rejection, ordinary listing, pagination and direct assignment`)
}
