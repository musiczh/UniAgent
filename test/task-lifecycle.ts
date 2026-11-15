import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { TaskLifecycleStore } from '../src/main/taskLifecycleStore'
import { TaskLifecycleService } from '../src/main/taskLifecycleService'
import { taskInputRevision, validateDelivery, type DeliveryReport } from '../src/shared/taskLifecycle'
import { projectTaskDecisions } from '../src/shared/taskDecisions'
import { atomicWriteFile, SessionStoreWriteError } from '../src/main/sessionStore'
import type { Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-lifecycle-'))
const directory = join(root, 'tasks')
const session: Session = { id: 's', title: '任务', createdAt: 1, status: 'completed', config: { agentId: 'codex', workdir: '/original' } }
let busy = false, pending = 0, reserved = false
const store = new TaskLifecycleStore(directory)
function serviceFor(target: Session, stateStore: TaskLifecycleStore) {
  return new TaskLifecycleService(stateStore, { session: id => id === target.id ? target : undefined, busy: () => busy, pending: () => pending,
    reserve: () => { if (reserved) throw Error('reserved'); reserved = true; return () => { reserved = false } },
    mirrorArchive: (_id, archived) => { target.archived = archived; return target }, publish: () => {} })
}
const service = serviceFor(session, store)
const report: DeliveryReport = { operationId: 'historical-report', resultVersion: 1, inputRevision: taskInputRevision(session), summary: '旧交付内容',
  deliverables: ['实现提交、说明'], verification: { passed: ['相关回归通过'], failed: [], unverified: ['完整发布回归'] }, source: 'agent', createdAt: 1 }
const pathFor = (id: string, dir = directory) => join(dir, createHash('sha256').update(id).digest('hex') + '.json')
const decision = (current: TaskLifecycleService, target = session, actionId = 'defer', disposition: 'standby' | 'archive' = 'standby') => {
  const snapshot = current.snapshot(target.id)
  return { actionId, expectedVersion: snapshot.record.version, inputRevision: snapshot.inputRevision, turnRevision: snapshot.turnRevision, disposition }
}
try {
  await store.hydrate([session])
  assert.equal(service.snapshot('s').record.phase, 'active', 'completed native turn is not business completion')
  assert.equal(service.snapshot('s').record.delivery, undefined)
  const historical = { ...store.current(session), version: 1, delivery: report, reports: [report],
    history: [{ id: report.operationId, ts: 1, title: '提交交付待验收', text: report.summary, resultVersion: 1 }] }
  await mkdir(directory, { recursive: true })
  await atomicWriteFile(pathFor(session.id), JSON.stringify(historical))
  await store.hydrate([session])
  assert.deepEqual(service.snapshot('s').record.delivery, report)
  assert.equal(session.taskState?.awaitingAcceptance, false, 'historical reports do not request acceptance')
  assert.deepEqual(projectTaskDecisions(session, []), [], 'historical reports create no invisible delivery decision')
  const { source: _source, createdAt: _createdAt, ...legacyInput } = report
  assert.throws(() => validateDelivery({ ...legacyInput, taskId: 'other' }), /材料无效/)
  assert.throws(() => validateDelivery({ ...legacyInput, deliverables: ['x'.repeat(4001)] }), /材料无效/)

  const input = decision(service)
  busy = true; await assert.rejects(service.decide('s', input), /仍在执行/); busy = false
  pending = 1; await assert.rejects(service.decide('s', input), /等待回答/); pending = 0
  await assert.rejects(service.decide('s', { ...input, expectedVersion: 0 }), /已变化/)
  const deferred = await service.decide('s', input)
  const duplicate = await service.decide('s', input)
  assert.equal(duplicate.record.version, deferred.record.version)
  await assert.rejects(service.decide('s', { ...input, disposition: 'archive' }), /身份冲突/)
  assert.equal(service.snapshot('s').record.phase, 'standby'); assert.equal(reserved, false)
  assert.equal(session.id, 's'); assert.equal(session.config.workdir, '/original')
  assert.equal(service.snapshot('s').record.delivery, undefined)
  assert.deepEqual(service.snapshot('s').record.reports, [report], 'user decisions retain historical report data')

  const restored = { ...session, taskState: undefined, archived: false }
  const freshStore = new TaskLifecycleStore(directory); await freshStore.hydrate([restored])
  const fresh = serviceFor(restored, freshStore)
  assert.equal(fresh.snapshot('s').record.phase, 'standby', 'standby survives a new store instance')
  assert.deepEqual(fresh.snapshot('s').record.reports, [report])
  assert.equal(fresh.snapshot('s').record.history.length, 2)
  session.submittedUserMessages = [{ type: 'user_message', userOrdinal: 1, acceptedAt: 20, textHash: 'new-input' }]
  await service.inputAccepted('s')
  assert.equal(service.snapshot('s').record.phase, 'active')
  await service.decide('s', input)
  assert.equal(service.snapshot('s').record.phase, 'active', 'old idempotent decision cannot defer new work')
  await assert.rejects(service.decide('s', { ...input, actionId: 'stale' }), /已变化/)
  const archive = decision(service, session, 'finish', 'archive')
  await service.decide('s', archive); assert.equal(session.archived, true)
  await service.archive('s', false)
  await service.decide('s', archive)
  assert.equal(session.archived, false, 'old decision cannot rearchive a restored task')
  busy = true; await assert.rejects(service.archive('s', true), /仍在执行/); busy = false
  assert.equal(session.archived, false); assert.equal(reserved, false)

  const legacy = { ...session, id: 'legacy', taskState: undefined }
  const legacyRecord = { ...historical, taskId: legacy.id, inputRevision: taskInputRevision(legacy) }
  await atomicWriteFile(pathFor(legacy.id), JSON.stringify(legacyRecord))
  const legacyStore = new TaskLifecycleStore(directory); await legacyStore.hydrate([legacy])
  const legacyService = serviceFor(legacy, legacyStore)
  await legacyService.archive(legacy.id, true)
  assert.equal(legacy.archived, true, 'hidden reports cannot block normal archive')
  assert.deepEqual(legacyService.snapshot(legacy.id).record.reports, [report])

  const brokenSession = { ...session, id: 'broken', taskState: undefined }
  const broken = serviceFor(brokenSession, new TaskLifecycleStore(join(root, 'broken'), async () => { throw Error('disk full') }))
  await assert.rejects(broken.decide('broken', decision(broken, brokenSession)), /disk full/)
  assert.equal(broken.snapshot('broken').record.version, 0); assert.equal(broken.snapshot('broken').record.phase, 'active')
  const uncertainSession = { ...session, id: 'uncertain', taskState: undefined }
  const uncertainStore = new TaskLifecycleStore(join(root, 'uncertain'), async (file, data) => {
    await atomicWriteFile(file, data)
    throw new SessionStoreWriteError('fsync uncertain', 'committed-durability-uncertain', new Error('fsync'))
  })
  const uncertain = serviceFor(uncertainSession, uncertainStore)
  const uncertainInput = decision(uncertain, uncertainSession)
  await assert.rejects(uncertain.decide('uncertain', uncertainInput), /fsync/)
  assert.equal(uncertain.snapshot('uncertain').record.phase, 'standby', 'rename commit reconciles the saved decision')
  await uncertain.decide('uncertain', uncertainInput)
  assert.equal(uncertain.snapshot('uncertain').record.version, 1)
  const bytes = await readFile(pathFor('uncertain', join(root, 'uncertain')), 'utf8')
  assert.equal(JSON.parse(bytes).taskId, 'uncertain')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('PASS historical reports remain readable without acceptance reminders or archive blocks; durable/idempotent user decisions, restart, continuation, busy guards and write reconciliation')
