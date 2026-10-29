import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, UAEvent } from '../src/shared/types'

// Exercise the production push/read boundary without starting an App, engine or model.
const root = await mkdtemp('/tmp/uzs-')
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = join(root, 'user-data')
const { Orchestrator } = await import('../src/main/orchestrator')
const { SessionStore } = await import('../src/main/sessionStore')
const orchestrator = new Orchestrator(() => undefined, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'))
const internals = orchestrator as any
const session: Session = { id: 'snapshot-session', title: 'Snapshot fixture', status: 'idle', createdAt: 1,
  config: { agentId: 'zcode', workdir: root, permissionMode: 'ask' } }
const native = (text: string, seq: number): UAEvent => ({ sessionId: session.id, seq, ts: 10, type: 'agent_message',
  state: 'running', payload: { id: 'native-row', text, zcodeProjection: true, projectionGeneration: 1 } })
const snapshots: any[] = []
const live: UAEvent[] = []
const runner = new EventEmitter()
function bind(value: EventEmitter): void {
  internals.zcodeRunners.set(session.id, value)
  internals.bindZCodeRunner(session, value)
}
try {
  internals.sessions.set(session.id, session)
  internals.seqRefs.set(session.id, { n: 5 })
  internals.events.set(session.id, [{ sessionId: session.id, seq: 0, ts: 1, type: 'system_notice', payload: { text: 'local audit' } }])
  orchestrator.on('eventsReset', snapshot => snapshots.push(snapshot))
  orchestrator.on('event', event => live.push(event))
  bind(runner)
  runner.emit('eventsReset', [native('first snapshot', 4)])
  assert.equal(snapshots[0].generation, 1, 'reset must expose a display generation')
  assert.equal(snapshots[0].upToEventSeq, 4, 'reset must include the allocated event watermark')
  assert.equal(snapshots[0].events[0].payload.text, 'local audit')

  const replacement = new EventEmitter()
  bind(replacement)
  internals.seqRefs.get(session.id).n = 8
  replacement.emit('eventsReset', [native('reopened snapshot', 7)])
  assert.equal(snapshots[1].generation, 2, 'reopening a runner must not restart the session display generation')
  assert.equal(snapshots[1].events[1].payload.projectionGeneration, 2)
  internals.seqRefs.get(session.id).n = 9
  replacement.emit('event', native('live update', 8))
  assert.equal(live.at(-1)!.payload.projectionGeneration, 2, 'live rows must use the same session generation as their reset')
  const beforeStale = snapshots.length
  runner.emit('eventsReset', [native('stale owner', 100)])
  assert.equal(snapshots.length, beforeStale, 'a replaced runner must not publish snapshots')

  let releaseOccupancy!: () => void
  let occupancyEntered!: () => void
  const entered = new Promise<void>(resolve => { occupancyEntered = resolve })
  internals.getEvents = async () => internals.events.get(session.id)
  internals.inspectSessionOccupancy = () => { occupancyEntered(); return new Promise(resolve => {
    releaseOccupancy = () => resolve({ state: 'unsupported', checkedAt: 1 })
  }) }
  const pendingRead = orchestrator.getSessionRuntimeState(session.id)
  await entered
  internals.seqRefs.get(session.id).n = 11
  replacement.emit('eventsReset', [native('newer recovery', 10)])
  releaseOccupancy()
  const olderRead = await pendingRead
  assert.equal(olderRead.events.find(event => event.type === 'agent_message')?.payload.text, 'live update')
  assert.deepEqual((olderRead as any).zcodeEvents, { generation: 2, upToEventSeq: 8 }, 'an async read must pair its events with the cursor captured before the await')
  assert.equal(snapshots.at(-1).generation, 3)
  assert.equal(snapshots[1].events[1].payload.text, 'reopened snapshot', 'emitted snapshots must not mutate with later live upserts')
  console.log(JSON.stringify({ result: 'zcode-snapshot-check-passed', cases: ['resetCursor', 'reopenGeneration', 'liveGeneration', 'staleOwner', 'asyncReadCursor', 'immutablePush'] }))
} finally {
  runner.removeAllListeners()
  internals.zcodeRunners.clear()
  await orchestrator.closeZCodeRuntime()
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  await rm(root, { recursive: true, force: true })
}
