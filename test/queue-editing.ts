import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { dequeueComposerQueueItem } from '../src/renderer/components/Composer'
import type { AgentDef, Session } from '../src/shared/types'

const agent: AgentDef = {
  id: 'queue-test',
  name: 'Queue test',
  bin: '/usr/bin/true',
  adapter: 'generic',
  icon: '',
  builtin: false,
  installed: true,
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] },
  models: []
}

async function fixture(): Promise<{ orchestrator: Orchestrator; session: Session; path: string }> {
  const path = join(tmpdir(), `uniagent-queue-editing-${process.pid}-${Math.random()}.json`)
  const session: Session = {
    id: 'queue-session',
    title: 'Queue editing',
    config: { agentId: agent.id, workdir: tmpdir() },
    status: 'idle',
    createdAt: Date.now(),
    pendingQueue: [
      { id: 'q1', prompt: 'first', acceptedAt: 1, state: 'pending', attempts: 0 },
      { id: 'q2', prompt: 'second', acceptedAt: 2, state: 'pending', attempts: 0 }
    ]
  }
  const store = new SessionStore(path)
  store.save([session])
  const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store)
  orchestrator.loadPersisted()
  return { orchestrator, session: orchestrator.getSessionById(session.id)!, path }
}

async function mainQueueSaveWaitsForTheRunningTurn(): Promise<void> {
  const { orchestrator, session, path } = await fixture()
  let dispatches = 0
  ;(orchestrator as any).dispatchPendingQueue = (): void => { dispatches += 1 }
  try {
    session.status = 'queued'
    orchestrator.setQueueEditing(session.id, 'q1')
    assert.equal(session.status, 'queued', 'editing a queue behind a live turn must keep the session busy')

    orchestrator.editQueueItem(session.id, 'q1', 'edited')
    orchestrator.setQueueEditing(session.id, null)
    await new Promise(setImmediate)

    assert.equal(dispatches, 0, 'saving an edit must not start a second turn immediately')
    assert.equal(orchestrator.getQueue(session.id)[0]?.prompt, 'edited')
  } finally {
    await rm(path, { force: true })
  }
}

async function sideQueueSaveWaitsForTheRunningTurn(): Promise<void> {
  const { orchestrator, session, path } = await fixture()
  let dispatches = 0
  ;(orchestrator as any).sideQueues.set(session.id, orchestrator.getQueue(session.id))
  ;(orchestrator as any).sideStatus.set(session.id, 'queued')
  ;(orchestrator as any).sideStreamers.set(session.id, {})
  ;(orchestrator as any).dispatchSideQueue = (): void => { dispatches += 1 }
  try {
    orchestrator.setSideQueueEditing(session.id, 'q1')
    assert.equal(orchestrator.getSideStatus(session.id), 'queued')

    orchestrator.setSideQueueEditing(session.id, null)
    assert.equal(dispatches, 0, 'saving a side-queue edit must wait for the live side turn')
  } finally {
    await rm(path, { force: true })
  }
}

async function deletingTheEditedItemReleasesItsQueue(): Promise<void> {
  const { orchestrator, session, path } = await fixture()
  let dispatches = 0
  ;(orchestrator as any).dispatchPendingQueue = (): void => { dispatches += 1 }
  try {
    orchestrator.setQueueEditing(session.id, 'q1')
    orchestrator.dequeue(session.id, 'q1')
    await new Promise(setImmediate)

    assert.deepEqual(orchestrator.getQueue(session.id).map((item) => item.id), ['q2'])
    assert.equal(dispatches, 1, 'deleting the edited item must release the remaining queue')
  } finally {
    await rm(path, { force: true })
  }
}

async function deletionClearsOnlyTheMatchingComposerEdit(): Promise<void> {
  const deleted: string[] = []
  let cancellations = 0
  let editing: string | null = 'q1'
  const dequeue = async (id: string): Promise<void> => { deleted.push(id) }
  const cancel = (): void => { cancellations += 1 }

  await dequeueComposerQueueItem('q2', () => editing, dequeue, cancel)
  assert.deepEqual(deleted, ['q2'])
  assert.equal(cancellations, 0, 'deleting another task must preserve the current editor')

  await dequeueComposerQueueItem('q1', () => editing, dequeue, cancel)
  assert.deepEqual(deleted, ['q2', 'q1'])
  assert.equal(cancellations, 1, 'deleting the edited task must clear its composer editor')

  let finishDelete!: () => void
  editing = 'q1'
  const pendingDelete = dequeueComposerQueueItem(
    'q1',
    () => editing,
    () => new Promise<void>((resolve) => { finishDelete = resolve }),
    cancel
  )
  editing = 'q2'
  finishDelete()
  await pendingDelete
  assert.equal(cancellations, 1, 'a newly selected editor must survive an older delete request')
}

await mainQueueSaveWaitsForTheRunningTurn()
await sideQueueSaveWaitsForTheRunningTurn()
await deletingTheEditedItemReleasesItsQueue()
await deletionClearsOnlyTheMatchingComposerEdit()
console.log('PASS queue editing saves in place and deletion releases only the edited item')
