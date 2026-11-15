import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTaskBoard } from '../src/shared/taskBoard'
import { TaskLifecycleStore } from '../src/main/taskLifecycleStore'
import { TaskLifecycleService } from '../src/main/taskLifecycleService'
import type { Session } from '../src/shared/types'
import type { TaskDecision } from '../src/shared/taskDecisions'

const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: id, createdAt: 1, status: 'idle', config: { agentId: 'codex', workdir: '/fixture' }, ...extra })
const decision = (type: TaskDecision['type'], priority: TaskDecision['priority']): TaskDecision => ({ id: type, version: '1', type, priority, blocking: false, title: type, status: 'open' })
const native = [decision('exception', 'medium'), decision('question', 'high'), decision('approval', 'high')]
const pending = session('pending', { taskState: { phase: 'active', version: 1, updatedAt: 1, awaitingAcceptance: true } })
const standby = session('standby', { taskState: { phase: 'standby', version: 2, updatedAt: 1, awaitingAcceptance: false } })
const stale = session('stale', { taskState: { phase: 'active', version: 3, updatedAt: 1, awaitingAcceptance: false, decisionHint: { count: 1, priority: 'high' } } })
const archives = Array.from({ length: 1000 }, (_, i) => session('archive-' + i, { archived: true }))
const active = Array.from({ length: 201 }, (_, i) => session('active-' + i, { createdAt: i + 1 }))
const leader = session('leader', { teamBinding: {} as Session['teamBinding'] })
const helper = session('helper', { config: { agentId: 'codex', workdir: '/fixture', assistantSnapshot: {} as Session['config']['assistantSnapshot'] } })
const sessions = [...active, ...archives, pending, pending, standby, stale, helper, leader, session('member', { teamBinding: {} as Session['teamBinding'] })]
const projection = projectTaskBoard(sessions, id => id === 'pending' ? native : [], {}, s => s.id === 'leader')
assert.equal(projection.columns.active.total, 202)
assert.equal(projection.columns.active.items.length, 30)
assert.equal(projection.columns.active.pages, 7)
assert.equal(projection.columns.decision.total, 2)
assert.equal(projection.columns.decision.items.find(s => s.id === 'pending')?.decisionCount, 3, 'one card for multiple decisions')
assert.equal(projection.columns.decision.items[0].priority, 'high')
assert.equal(projection.columns.decision.items.find(s => s.id === 'stale')?.status, '需处理 · 待读取核对')
assert.equal(projection.columns.standby.items[0].id, 'standby')
assert.equal(projection.archivedCount, 1000); assert.equal(projection.columns.archived.items.length, 30)
assert.equal(JSON.stringify(projection).includes('approval_request'), false)
const quick = projectTaskBoard([
  session('running', { status: 'running' }), session('queued', { status: 'queued' }),
  session('done', { status: 'completed' }), session('readonly', { status: 'completed', readOnly: true }),
  session('fresh'), session('unknown', { status: 'completed', taskRegistration: { delivery: 'unknown' } as Session['taskRegistration'] }),
  pending, stale, standby, leader, session('old', { archived: true })
], id => id === 'pending' ? native : [], {}, () => true)
const entry = (id: string) => Object.values(quick.columns).flatMap(column => column.items).find(item => item.id === id)!
assert.equal(entry('running').canPause, true); assert.equal(entry('queued').canPause, true)
assert.equal(entry('done').canDecide, true); assert.equal(entry('done').executionStatus, 'completed')
for (const id of ['readonly', 'fresh', 'unknown', 'pending', 'stale', 'leader', 'old']) assert.equal(entry(id).canDecide, false, id + ' cannot bypass task lifecycle checks')
assert.equal(entry('standby').canDecide, true)
for (const id of ['running', 'queued', 'done', 'readonly', 'fresh', 'unknown', 'pending', 'stale', 'standby', 'leader', 'old']) {
  assert.equal(entry(id).canDelete, true, id + ' retains the existing session deletion capability')
}
assert.equal(entry('leader').teamTask, true, 'team deletion must disclose that member sessions are included')
for (const item of Object.values(quick.columns).flatMap(column => column.items)) assert.equal(item.agentId, 'codex', 'every task card projects its execution Agent identity')
const customAgent = projectTaskBoard([session('custom-agent', { config: { agentId: 'company-agent', workdir: '/fixture' } })], () => []).columns.active.items[0]
assert.equal(customAgent.agentId, 'company-agent', 'custom Agent IDs are preserved without guessing their brand')
const oldReportOnly = projectTaskBoard([session('old-report-only', { taskState: { phase: 'active', version: 1, updatedAt: 1, awaitingAcceptance: true } })], () => []).columns.active.items[0]
assert.equal(oldReportOnly.id, 'old-report-only')
assert.equal(oldReportOnly.decisionCount, 0, 'old report summaries create no acceptance reminder')
assert.equal(oldReportOnly.canDecide, false, 'old reports do not replace an ended native round')
const paged = projectTaskBoard(sessions, () => [], { pages: { active: 999, archived: 1 }, includeArchived: true })
assert.equal(paged.columns.active.page, 6); assert.equal(paged.archived?.items.length, 30); assert.equal(paged.archived?.page, 1)
for (const query of [null, [], { pages: { active: -1 } }, { pages: { active: 1.1 } }, { pages: { x: 1 } }, { includeArchived: 'yes' }, { random: 1 }]) assert.throws(() => projectTaskBoard([], () => [], query as any), /无效/)

const root = await mkdtemp(join(tmpdir(), 'task-board-'))
try {
  const s = session('durable'), store = new TaskLifecycleStore(root)
  const service = (target: Session, current: TaskLifecycleStore) => new TaskLifecycleService(current, { session: () => target, busy: () => false, pending: () => 0, reserve: () => () => {}, mirrorArchive: (_id, archived) => { target.archived = archived; return target }, publish: () => {} })
  const first = service(s, store)
  await store.hydrate([s])
  await first.noteDecisions(s.id, []); assert.equal(first.snapshot(s.id).record.version, 0, 'ordinary status creates no journal entry')
  await Promise.all([first.noteDecisions(s.id, native), first.noteDecisions(s.id, native)])
  assert.equal(first.snapshot(s.id).record.version, 1, 'concurrent same hint writes once')
  assert.deepEqual(s.taskState?.decisionHint, { count: 2, priority: 'high' })
  const restored = session(s.id), secondStore = new TaskLifecycleStore(root); await secondStore.hydrate([restored])
  const second = service(restored, secondStore)
  assert.equal(projectTaskBoard([restored], () => []).columns.decision.total, 1, 'restart retains a pending reminder without replaying full logs')
  await assert.rejects(second.archive(s.id, true), /待决策/)
  await second.noteDecisions(s.id, [])
  assert.equal(restored.taskState?.decisionHint, undefined)
  await second.archive(s.id, true)
  assert.equal(projectTaskBoard([restored], () => []).archivedCount, 1)
} finally { await rm(root, { recursive: true, force: true }) }
console.log('PASS four columns, priority/dedup, cached pending reminder, helper/team filtering, 1000 archived paged rows, invalid queries and durable concurrent hint updates')
