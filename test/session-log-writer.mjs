import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'uniagent-log-writer-'))
let logs
try {
  await build({ entryPoints: ['src/main/sessionLogStore.ts', 'src/main/sessionLogWriter.ts'],
    outdir: join(root, 'build'), bundle: true, splitting: true, platform: 'node', format: 'esm', packages: 'external' })
  await writeFile(join(root, 'build/package.json'), '{"type":"module"}')
  const { SessionLogStore } = await import(pathToFileURL(join(root, 'build/sessionLogStore.js')).href)
  logs = new SessionLogStore(root, { background: true, maxFileBytes: 5000 })
  assert.ok(logs.backgroundWrites, 'the bundled log store must actually use a worker')
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
  await logs?.close()
  await rm(root, { recursive: true, force: true })
}
