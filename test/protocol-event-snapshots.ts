import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-protocol-snapshots-'))
const host = new Orchestrator(() => undefined, new SessionStore(join(root, 'sessions.json')))
try {
  for (const agentId of ['kimi', 'deepseek', 'grok']) {
    const session: Session = { id: agentId, title: agentId, config: { agentId, workdir: root },
      createdAt: 1, updatedAt: 1, status: 'running' }
    const internal = host as any
    internal.sessions.set(session.id, session)
    internal.events.set(session.id, [])
    internal.deepseekEvents.append = () => {}
    const runner = new EventEmitter()
    internal.protocolRunners.set(session.id, runner)
    internal.bindProtocolRunner(session, runner)
    let seq = 0, delivered = 0
    const observe = (event: UAEvent) => { if (event.sessionId === session.id) delivered++ }
    host.on('event', observe)
    const emit = (type: UAEvent['type'], state: UAEvent['state'], payload: Record<string, unknown>) => {
      const event: UAEvent = { sessionId: session.id, seq: seq++, ts: seq, type, state, payload }
      runner.emit('event', event)
    }
    emit('turn_started', undefined, { turnId: 't1' })
    for (let i = 0; i < 20_000; i++) emit('agent_message', 'running', { id: 'reply', turnId: 't1', text: `text-${i}` })
    emit('agent_message', 'success', { id: 'reply', turnId: 't1', text: 'complete' })
    const events = await host.getEvents(session.id)
    assert.equal(events.length, 2, `${agentId}: cumulative reply snapshots must be bounded`)
    assert.equal(events[1].payload.text, 'complete')
    assert.equal(events[1].seq, 1, 'retain the original timeline position')
    assert.equal(delivered, seq, 'business consumers still receive every raw event')
    emit('approval_request', 'pending', { requestId: 'approval', turnId: 't1' })
    emit('approval_request', 'success', { requestId: 'approval', turnId: 't1', resolved: true })
    emit('turn_completed', 'success', { turnId: 't1' })
    emit('turn_started', undefined, { turnId: 't2' })
    emit('agent_message', 'running', { id: 'reply', turnId: 't2', text: 'next' })
    assert.deepEqual(events.filter(e => e.type === 'approval_request').map(e => e.state), ['pending', 'success'])
    assert.deepEqual(events.filter(e => e.type === 'agent_message').map(e => e.payload.text), ['complete', 'next'])
    host.off('event', observe)
    internal.protocolRunners.delete(session.id)
  }
} finally {
  await host.closeSessionLogs()
  await rm(root, { recursive: true, force: true })
}
console.log('protocol-event-snapshots: bounded cache, raw delivery, approval transitions and turn isolation passed')
