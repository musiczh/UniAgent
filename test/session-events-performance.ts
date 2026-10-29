import assert from 'node:assert/strict'
import { mergeHydratedSessionEvents, mergeSessionEvent } from '../src/renderer/App'
import type { UAEvent } from '../src/shared/types'

const rows: UAEvent[] = Array.from({ length: 10_000 }, (_, seq) => ({
  sessionId: 's', seq, ts: seq + 1, type: 'system_notice', payload: { text: 'event ' + seq }
}))
const started = performance.now()
const hydrated = mergeHydratedSessionEvents(rows, [])
assert.equal(hydrated.length, 10_000)
assert.deepEqual(hydrated.map(event => event.seq), rows.map(event => event.seq))
const updated = mergeSessionEvent(hydrated, { ...rows[0], seq: 10_000 })
assert.equal(hydrated.length, 10_000, 'live merge must preserve the previous React state')
assert.equal(updated.length, 10_001)
const snapshots: UAEvent[] = Array.from({ length: 10_000 }, (_, seq) => ({
  sessionId: 's', seq, ts: seq + 1, type: 'agent_message', state: 'running', payload: { id: 'reply', text: String(seq) }
}))
const reply = mergeHydratedSessionEvents(snapshots, [])
assert.equal(reply.length, 1)
assert.equal(reply[0].payload.text, '9999')
assert.equal(reply[0].ts, 1)
console.log(`session-events-performance: ok; 10,000 historical events and 10,000 snapshots merged in ${Math.round(performance.now() - started)} ms`)
