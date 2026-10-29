import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const chunk = (await readdir('out/main')).find(name => /^sessionLogStore-.*\.js$/.test(name))
assert.ok(chunk, 'build the packaged main entries before this test')
const built = await import('../out/main/' + chunk)
const SessionLogStore = Object.values(built).find(value => typeof value === 'function' && value.name === 'SessionLogStore')
assert.ok(SessionLogStore, 'the built writer must expose its shared log store')
const root = await mkdtemp(join(tmpdir(), 'uniagent-log-writer-'))
const logs = new SessionLogStore(root, { background: true, maxFileBytes: 5000 })
try {
  assert.ok(logs.backgroundWrites, 'the production build must actually use a worker')
  assert.doesNotThrow(() => logs.append('s', 'invalid_diagnostic', { callback: () => {} }), 'unsupported diagnostics must not break a turn')
  for (let seq = 0; seq < 10_000; seq++) logs.append('s', 'ua_event', { channel: 'main', event: {
    sessionId: 's', seq, ts: seq + 1, type: 'agent_message', state: 'running',
    payload: { id: 'reply', turnId: 'turn', text: 'reply ' + seq }
  } })
  await logs.flush()
  assert.equal(logs.loadInterruptedReplies('s').at(-1).payload.text, 'reply 9999', 'flush preserves the latest interrupted reply')
  const rows = (await readFile(join(root, 's.jsonl'), 'utf8')).trim().split('\n')
  assert.ok(rows.length < 20, '10,000 snapshots should not create 10,000 log entries')
  logs.append('s', 'ua_event', { channel: 'main', event: { sessionId: 's', seq: 10_000, ts: 10_001,
    type: 'agent_message', state: 'success', payload: { id: 'reply', turnId: 'turn', text: 'final answer' } } })
  await logs.flush()
  assert.equal(logs.loadInterruptedReplies('s').length, 0, 'completed replies remove running checkpoints')
  console.log(`session-log-writer: ok; 10,000 snapshots → ${rows.length} disk records; latest checkpoint and completion preserved`)
} finally {
  await logs.close()
  await rm(root, { recursive: true, force: true })
}
