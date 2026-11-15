import assert from 'node:assert/strict'
import { mergeSessionEvent } from '../src/renderer/App'
import { mergeZCodeEvent } from '../src/renderer/zcodeEvents'
import { buildDurableQueueItem } from '../src/main/orchestrator'
import { hydrateSubmittedUserMessages, submittedTextHash } from '../src/main/submittedUserMessages'
import type { UAEvent } from '../src/shared/types'

const event = (key: string, seq: number, optimistic: boolean): UAEvent => ({
  sessionId: 's', seq, ts: seq + 10, type: 'user_message', payload: { text: '相同文字', clientTurnKey: key, optimistic }
})
for (const merge of [mergeSessionEvent, mergeZCodeEvent]) {
  let rows = [event('first', -2, true), event('second', -1, true)]
  rows = merge(rows, event('second', 2, false))
  assert.equal(rows[0].payload.optimistic, true, 'out-of-order receipt must leave the other identical-text send pending')
  assert.equal(rows[1].payload.clientTurnKey, 'second')
  rows = merge(rows, event('first', 1, false))
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => !row.payload.optimistic))
  rows = merge(rows, event('first', 3, false))
  assert.equal(rows.length, 2, 'refreshed native history replaces the same client message')
  rows = merge(rows, event('first', -5, true))
  assert.equal(rows.length, 2, 'a late optimistic row cannot duplicate a confirmed receipt')
  assert.ok(rows.every(row => !row.payload.optimistic))
}
const queued = buildDurableQueueItem('原文', undefined, undefined, 1, { clientTurnKey: 'first', displayText: '展示原文' })
assert.equal(queued.clientTurnKey, 'first', 'queued delivery retains the same client message identity')
assert.equal(queued.displayText, '展示原文')
const restored = hydrateSubmittedUserMessages([event('native', 1, false)], [{ type: 'user_message', userOrdinal: 0,
  textHash: submittedTextHash('相同文字'), acceptedAt: 1, clientTurnKey: 'first' }])
assert.equal(restored[0].payload.clientTurnKey, 'first', 'native history restores the host-owned identity by ordinal and text hash')
console.log('PASS main/ZCode out-of-order identical-text receipts and durable queue client identity')
