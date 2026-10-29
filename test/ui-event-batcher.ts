import assert from 'node:assert/strict'
import { UIEventBatcher } from '../src/main/uiEventBatcher'
import type { UAEvent } from '../src/shared/types'

const batches: UAEvent[][] = []
const batcher = new UIEventBatcher(events => batches.push(events), 5)
const event = (seq: number, sessionId = 's', type: UAEvent['type'] = 'agent_message', state: UAEvent['state'] = 'running'): UAEvent =>
  ({ sessionId, seq, ts: seq, type, state, payload: { id: 'same-id', turnId: 'same-turn', text: String(seq) } })
for (let i = 0; i < 20_000; i++) batcher.push(event(i))
assert.equal(batches.length, 0)
assert.equal(batcher.stats().uiPendingSnapshots, 1)
batcher.push(event(20_000, 'other'))
batcher.push(event(20_001, 's', 'approval_request', 'pending'))
assert.deepEqual(batches.map(items => items.map(e => [e.sessionId, e.seq])), [[['s', 19_999], ['other', 20_000]], [['s', 20_001]]])
batcher.push(event(20_002))
batcher.push(event(20_003, 's', 'agent_message', 'success'))
assert.equal(batches.at(-2)![0].seq, 20_002)
assert.equal(batches.at(-1)![0].state, 'success', 'flush pending text before its terminal event')
batcher.push(event(20_004))
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(batches.at(-1)![0].seq, 20_004, 'a running reply is delivered without waiting for a terminal event')
batcher.push({ ...event(20_005), payload: { id: 'large', text: 'x'.repeat(150_000) } })
assert.equal(batcher.stats().uiPendingSnapshots, 0, 'large snapshots are flushed immediately')
batcher.flush()
assert.equal(batcher.stats().uiPendingBytes, 0)
console.log('ui-event-batcher: bounded snapshots, session isolation, immediate approvals and terminal ordering passed')
