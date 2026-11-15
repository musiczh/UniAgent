import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskLifecycleStore } from '../src/main/taskLifecycleStore'
import { TaskLifecycleService } from '../src/main/taskLifecycleService'
import { taskTurnRevision } from '../src/shared/taskLifecycle'
import { projectTaskBoard } from '../src/shared/taskBoard'
import type { Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-user-decision-'))
const session: Session = { id: 'task', title: '普通任务', status: 'idle', nativeSessionId: 'native', createdAt: 1, config: { agentId: 'codex', workdir: '/original', requirementId: 'r' }, submittedUserMessages: [{ type: 'user_message', userOrdinal: 1, acceptedAt: 1, textHash: 'first' }] }
const events: UAEvent[] = [{ sessionId: session.id, seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: '普通回答，无交付工具' } }]
let busy = false, pending = 0
const serviceFor = (target: Session, store: TaskLifecycleStore) => new TaskLifecycleService(store, {
  session: () => target, busy: () => busy, pending: () => pending, reserve: () => () => {},
  turnRevision: () => taskTurnRevision(target, events), mirrorArchive: (_id, value) => { target.archived = value; return target }, publish: () => {}
})
try {
  const store = new TaskLifecycleStore(root), service = serviceFor(session, store)
  await store.hydrate([session])
  assert.equal(projectTaskBoard([session], () => []).columns.decision.total, 1)
  const first = service.snapshot(session.id)
  const input = { actionId: 'defer', expectedVersion: first.record.version, inputRevision: first.inputRevision, turnRevision: first.turnRevision, disposition: 'standby' as const }
  busy = true; await assert.rejects(service.decide(session.id, input), /仍在执行/); busy = false
  pending = 1; await assert.rejects(service.decide(session.id, input), /等待回答/); pending = 0
  events.push({ ...events[0], seq: 3, payload: { text: '更新的回答' } })
  await assert.rejects(service.decide(session.id, input), /状态已变化/)
  const updated = { ...input, turnRevision: service.snapshot(session.id).turnRevision }
  const deferred = await service.decide(session.id, updated)
  await service.decide(session.id, updated)
  assert.equal(service.snapshot(session.id).record.version, deferred.record.version, 'repeat action is idempotent')
  assert.equal(projectTaskBoard([session], () => []).columns.standby.total, 1)
  const restored = structuredClone(session), fresh = new TaskLifecycleStore(root)
  await fresh.hydrate([restored]); assert.equal(fresh.current(restored).phase, 'standby')
  assert.equal(session.config.workdir, '/original')
  session.submittedUserMessages!.push({ type: 'user_message', userOrdinal: 2, acceptedAt: 5, textHash: 'next' })
  await service.inputAccepted(session.id); session.status = 'running'
  await service.decide(session.id, updated)
  assert.equal(service.snapshot(session.id).record.phase, 'active', 'old idempotent defer cannot defer a new round')
  assert.equal(projectTaskBoard([session], () => []).columns.active.total, 1)
  await assert.rejects(service.decide(session.id, { ...updated, actionId: 'stale', disposition: 'archive' }), /状态已变化/)
  session.status = 'error'
  await service.noteDecisions(session.id, [{ id: 'failure', version: '1', type: 'exception', priority: 'medium', blocking: true, title: '异常', status: 'open' }])
  const failure = service.snapshot(session.id)
  assert.equal(failure.pendingDecisions, 0)
  await service.decide(session.id, { actionId: 'close', expectedVersion: failure.record.version, inputRevision: failure.inputRevision, turnRevision: failure.turnRevision, disposition: 'archive' })
  assert.equal(session.archived, true, 'current error can be closed rather than permanently blocking itself')
  assert.equal(projectTaskBoard([session], () => []).columns.archived.total, 1)
  await service.archive(session.id, false)
  assert.equal(session.archived, false)
  const asyncQuestion = { id: 'q', version: '1', type: 'question' as const, priority: 'high' as const, blocking: false, title: '需回答', status: 'open' as const }
  session.status = 'running'
  assert.equal(projectTaskBoard([session], () => [asyncQuestion]).columns.active.total, 1, 'async question does not stop execution')
  assert.equal(projectTaskBoard([session], () => [{ ...asyncQuestion, blocking: true }]).columns.decision.total, 1)
  assert.equal(projectTaskBoard([session], () => [], { requirementId: 'another' }).columns.active.total, 0)
  const broken = { ...session, id: 'disk-failure', status: 'completed' as const, taskState: undefined }
  const brokenService = serviceFor(broken, new TaskLifecycleStore(join(root, 'broken'), async () => { throw Error('disk full') }))
  const before = brokenService.snapshot(broken.id)
  await assert.rejects(brokenService.decide(broken.id, { actionId: 'disk', expectedVersion: before.record.version, inputRevision: before.inputRevision, turnRevision: before.turnRevision, disposition: 'archive' }), /disk full/)
  assert.equal(broken.archived, false); assert.equal(brokenService.snapshot(broken.id).record.phase, 'active')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('PASS ordinary reply decisions, current-turn guards, busy/native waits, durable defer, same task continuation, error close, four columns and scoped projection')
