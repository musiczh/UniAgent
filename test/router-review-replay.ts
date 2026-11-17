import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { judgeReview, loadReviewCases, reviewExpectation, reviewObjects, chronologicalReviewCases } from './fixtures/router-reviews'
import { routerFixture } from './fixtures/router-quality'
import { DEFAULT_ROUTER_CONFIG, type RouterRequest } from '../src/shared/router'
import type { RouterFeedback } from '../src/shared/routerReview'

const id = randomUUID(), attemptId = randomUUID()
const actual: RouterRequest = { requestId: id, prompt: '检查产品的需求同步错误', scope: { kind: 'global' }, config: DEFAULT_ROUTER_CONFIG,
  state: 'bound', delivery: 'accepted', version: 5, createdAt: 100, updatedAt: 200,
  decision: { action: 'reuse_task', taskId: 'tutorial', reason: '截图是教程任务' } }
const feedback: RouterFeedback = { requestId: id, attemptId, expectedRevision: 0, revision: 1, savedAt: 201, matches: false, actual }
assert.equal(judgeReview(undefined, actual.decision), 'unscored')
assert.equal(judgeReview(feedback, { action: 'create_task_in_space', projectId: 'random', reason: '换个目标' }), 'unscored', 'a changed answer is not correct without an expectation')
assert.equal(reviewExpectation(feedback), undefined)
assert.deepEqual(reviewExpectation({ ...feedback, expected: { kind: 'create_task' } }), [{ action: 'create_task_in_requirement' }, { action: 'create_task_in_space' }], 'missing scope stays unspecified')
assert.equal(judgeReview({ ...feedback, expected: { kind: 'create_requirement', projectId: 'product' } }, { action: 'create_requirement_and_task', projectId: 'product', requirementName: 'new', reason: 'new' }), 'matched')
assert.equal(judgeReview({ ...feedback, matches: true }, actual.decision), 'matched', 'accepted result uses the rated actual, not the latest retry')
assert.equal(judgeReview({ ...feedback, matches: true }, { action: 'create_task_in_requirement', requirementId: 'elsewhere', reason: 'later retry' }), 'mismatched')
const expectation = { ...feedback, expected: { kind: 'reuse_task' as const, taskId: 'tutorial', requirementId: 'server', projectId: 'default' } }
assert.equal(judgeReview(expectation, actual.decision, [{ id: 'tutorial', kind: 'task', title: '教程', summary: '', version: '1', projectId: 'default', requirementId: 'server' }]), 'matched', 'logical parents come from the recorded object, not a guessed project')

const root = await mkdtemp(join(tmpdir(), 'ua-router-review-test-'))
await mkdir(join(root, 'records')); await mkdir(join(root, 'traces'))
await writeFile(join(root, 'README.md'), 'isolated test export')
const entry = { requestId: id, record: 'records/a.json', traces: ['traces/a.json'] }
await writeFile(join(root, 'index.json'), JSON.stringify({ records: [entry] }))
const queryEvent = (ts: number, objectId: string) => ({ ts, type: 'tool_call', state: 'success', payload: { name: 'router_query', input: { mode: 'catalog' },
  result: { content: [{ type: 'text', text: JSON.stringify({ items: [{ id: objectId, kind: 'requirement', title: objectId, description: '真实摘要', version: '1' }] }) }] } } })
await writeFile(join(root, entry.record), JSON.stringify({ request: { ...actual, decision: { action: 'clarify', reason: 'later', clarification: 'later' } },
  feedbacks: [{ ...feedback, revision: 2, expected: { kind: 'create_task', scope: 'requirement', requirementId: 'product' } }, feedback], logAvailability: 'captured' }))
await writeFile(join(root, entry.traces[0]), JSON.stringify({ id: attemptId, startedAt: 100, request: actual,
  history: [queryEvent(99, 'past'), queryEvent(101, 'future')], steps: [{ kind: 'query', data: { arguments: { mode: 'catalog', requestId: id }, result: { items: [{ id: 'current', kind: 'requirement', title: '当前', description: '当前范围', version: '2' }] } } }], events: [] }))
const [loaded] = await loadReviewCases(root)
assert.equal(loaded.feedback?.revision, 2, 'use latest revision even when storage order differs')
assert.equal(loaded.request.decision?.taskId, 'tutorial', 'the latest request result cannot replace the rated actual')
assert.deepEqual(loaded.objects.map(row => row.id), ['past', 'current'], 'future history is never part of the replay')
assert.equal(loaded.objects[0].sources?.length, 0, 'an observed brief is not fabricated source text')
assert.ok(loaded.gaps.length > 0)
const older = { ...loaded, id: 'older-positive', feedback: { ...feedback, matches: true }, request: { ...actual, createdAt: 20 }, trace: { ...loaded.trace!, startedAt: 10 } }
const newer = { ...loaded, id: 'newer-negative', request: { ...actual, createdAt: 1 }, trace: { ...loaded.trace!, startedAt: 30 } }
const order = [newer, older]
assert.deepEqual(chronologicalReviewCases(order).map(row => row.id), ['older-positive','newer-negative'], 'the rated attempt time precedes feedback priority or request creation during retries')
assert.deepEqual(order.map(row => row.id), ['newer-negative','older-positive'], 'sorting replay does not mutate the source inventory')
const changedSources = reviewObjects([
  { arguments: {}, result: { items: [{ id: 'scope', kind: 'requirement', title: '范围', version: '1', sourceRevision: 'before', sources: [{ ref: 'core', title: '旧文档', text: '旧内容', at: 1 }] }] } },
  { arguments: {}, result: { items: [{ id: 'scope', kind: 'requirement', title: '范围', version: '2', sourceRevision: 'after', description: '新摘要' }] } }
])
assert.deepEqual(changedSources[0].sources, [], 'a newer source revision never inherits missing text from the older document')
const priorTasks = { arguments: {}, result: { items: [
  { id: 'old-running', kind: 'task', requirementId: 'feature', title: '旧运行中任务', busy: true, version: '1' },
  { id: 'other-scope', kind: 'task', requirementId: 'other', title: '其他需求任务', version: '1' }
] } }
const taskPage = (cursor: string | undefined, ids: string[], complete: boolean) => ({
  arguments: { mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'feature' }, cursor },
  result: { snapshotId: 'snapshot', items: ids.map(id => ({ id, kind: 'task', requirementId: 'feature', title: id, version: '2' })),
    nextCursor: complete ? null : 'next', coverage: { complete } }
})
const firstPage = taskPage(undefined, ['current-a'], false), lastPage = taskPage('next', ['current-b'], true)
assert.ok(reviewObjects([priorTasks, firstPage]).some(row => row.id === 'old-running'), 'an incomplete list cannot establish that a historical task disappeared')
assert.deepEqual(reviewObjects([priorTasks, firstPage, lastPage]).map(row => row.id), ['other-scope', 'current-a', 'current-b'], 'a complete newer task list replaces older eligibility only within its scope')
assert.ok(reviewObjects([priorTasks, lastPage]).some(row => row.id === 'old-running'), 'a final page without its first page is not a complete observed list')
await writeFile(join(root, entry.record), JSON.stringify({ request: actual, feedbacks: [{ ...feedback, attemptId: randomUUID() }], logAvailability: 'captured' }))
assert.equal((await loadReviewCases(root))[0].trace, undefined, 'a missing rated attempt does not silently use another attempt')
await writeFile(join(root, entry.record), JSON.stringify({ request: actual, feedbacks: [{ ...feedback, attemptId: undefined }], logAvailability: 'legacy-events-only' }))
await writeFile(join(root, entry.traces[0]), JSON.stringify({ requestId: id, events: [{ type: 'tool_call', state: 'success', payload: { name: 'router_query', input: { requestId: id },
  output: JSON.stringify({ objects: [{ id: 'legacy', kind: 'space', title: '旧事件真实目录', summary: '已捕获', version: '1' }] }) } }] }))
assert.deepEqual((await loadReviewCases(root))[0].objects.map(row => row.id), ['legacy'], 'legacy output strings are usable evidence, not silently discarded as missing')
await writeFile(join(root, 'index.json'), JSON.stringify({ records: [{ ...entry, record: '../outside.json' }] }))
await assert.rejects(loadReviewCases(root), /review_path_outside_export/)

// Historical default execution config is not a hard routing scope. Replay only
// records in the production Controller's injected journal and never sends a task.
const objects = reviewObjects([{ arguments: {}, result: { items: [
  { id: 'product', kind: 'space', title: '产品', description: '产品工作', version: '1', projectId: 'product' },
  { id: 'default', kind: 'space', title: '默认', description: '', version: '1', projectId: 'default' },
  { id: 'feature', kind: 'requirement', title: '产品功能', description: '需求上下文与路由', version: '1', projectId: 'product' }
] } }])
const f = await routerFixture(objects)
try {
  for (const hard of [false, true]) {
    const requestId = await f.submit({ prompt: actual.prompt, scope: hard ? { kind: 'space', projectId: 'default' } : { kind: 'global' },
      execution: { agentId: 'codex', projectId: 'default', taskScope: { kind: 'space', projectId: 'default' }, workdir: '/submitted' } })
    const args = { requestId, version: f.db.request(requestId)!.version, action: 'create_task_in_requirement', requirementId: 'feature', reason: '按业务范围归属' }
    const result = await f.call('router_assign_task', args)
    if (hard) { assert.equal(result.ok, false); assert.equal(f.journal.length, 1) }
    else {
      assert.equal(result.value.state, 'bound')
      await f.call('router_assign_task', args)
      assert.equal(f.journal.length, 1, 'repeated receipt has a single isolated assignment')
    }
    await f.end()
  }
} finally { await f.close() }
console.log('PASS Router feedback replay: partial labels, rated attempts, temporal evidence, missing logs, isolated/idempotent assignments and hard scope')
