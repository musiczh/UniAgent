import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MonitorRecordFactory } from '../src/main/cloudMonitorRecords'
import { MonitorHttpError, MonitorQueue } from '../src/main/cloudMonitorQueue'
import { MonitorTransport } from '../src/main/cloudMonitorTransport'
import { monitorBytes } from '../src/shared/cloudMonitor'

const root = await mkdtemp(join(tmpdir(), 'uniagent-cloud-monitor-'))
let now = Date.now()
const factory = new MonitorRecordFactory('1.1.0', 'public', 'a'.repeat(64))
const diagnostic = () => factory.diagnostic({ ts: now, code: 'failed', level: 'error', agentId: 'codex', source: 'transport', message: 'failed /Users/private/path token=secret', count: 1 })!
const feedback = (revision = 1) => factory.feedback({ requestId: 'private-request-id', attemptId: 'private-attempt-id', revision, savedAt: now, matches: false, reason: '应复用 /Users/private/path', actualAction: 'create_task_in_space', expectedKind: 'reuse_task' })!
try {
  const queue = new MonitorQueue(join(root, 'queue'), () => now)
  await queue.init(now)
  const first = diagnostic()
  assert.doesNotMatch(JSON.stringify(first), /secret|private/)
  assert.equal(await queue.enqueue(first), true)
  assert.equal(await queue.enqueue(first), true)
  assert.equal(queue.snapshot().records.length, 1)
  let calls = 0
  await queue.flush(async () => { calls++; throw new Error('offline with private details') })
  assert.equal(queue.snapshot().records.length, 1)
  assert.equal(queue.snapshot().lastError, 'upload_unavailable')
  const reloaded = new MonitorQueue(join(root, 'queue'), () => now)
  await reloaded.init()
  assert.equal(reloaded.snapshot().records[0].eventId, first.eventId)
  await reloaded.flush(async () => { calls++; throw new Error('should not run before retry') })
  assert.equal(calls, 1)
  now = reloaded.snapshot().nextAttemptAt
  await reloaded.flush(async rows => ({ accepted: [], duplicates: rows.map(row => row.eventId), rejected: [], limited: [] }))
  assert.equal(reloaded.snapshot().records.length, 0)
  assert.equal(await reloaded.enqueue(first), true)
  assert.equal(reloaded.snapshot().records.length, 0, 'acknowledged events are not requeued by crash recovery')
  const limited = feedback()
  assert.equal(limited.eventId, feedback().eventId)
  assert.notEqual(limited.eventId, feedback(2).eventId)
  assert.doesNotMatch(JSON.stringify(limited), /private-request|private-attempt|Users/)
  const otherFactory = new MonitorRecordFactory('1.1.0', 'public', 'b'.repeat(64))
  assert.notEqual(limited.eventId, otherFactory.feedback({ requestId: 'private-request-id', attemptId: 'private-attempt-id', revision: 1, savedAt: now, matches: false, actualAction: 'create_task_in_space', expectedKind: 'reuse_task' })!.eventId)
  await reloaded.enqueue(limited)
  await reloaded.flush(async rows => ({ accepted: [], duplicates: [], rejected: [], limited: rows.map(row => row.eventId), retryAfter: 123 }))
  assert.equal(reloaded.snapshot().records.length, 1)
  assert.equal(reloaded.snapshot().nextAttemptAt, now + 123_000)
  now += 123_000
  await reloaded.flush(async () => ({ accepted: ['unknown-id'], duplicates: [], rejected: [], limited: [] }))
  assert.equal(reloaded.snapshot().records.length, 1, 'invalid acknowledgements must not erase pending feedback')
  now = reloaded.snapshot().nextAttemptAt
  await reloaded.flush(async () => { throw new MonitorHttpError(400) })
  assert.equal(reloaded.snapshot().records.length, 1, 'authentication configuration errors must not discard valid records')
  now = reloaded.snapshot().nextAttemptAt
  await reloaded.flush(async () => { throw new MonitorHttpError(400, undefined, true) })
  assert.equal(reloaded.snapshot().records.length, 0)
  assert.equal(reloaded.snapshot().dropped, 1)
  const row = feedback(3), performance = factory.performance('resource_sample', { rssBytes: 123 }, now)!
  const bounded = new MonitorQueue(join(root, 'bounded'), () => now, monitorBytes([row]) + 10)
  await bounded.init()
  await bounded.enqueue(performance)
  assert.equal(await bounded.enqueue(row), true)
  assert.deepEqual(bounded.snapshot().records.map(item => item.eventId), [row.eventId], 'overflow evicts performance before feedback')
  assert.equal(await bounded.enqueue(performance), false)
  assert.deepEqual(bounded.snapshot().records.map(item => item.eventId), [row.eventId])

  const transportQueue = new MonitorQueue(join(root, 'transport'), () => now)
  await transportQueue.init()
  let signups = 0, refreshes = 0, uploads = 0, authDown = false
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/signup')) {
      signups++
      return new Response(JSON.stringify({ access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_in: 3600, user: { id: 'fixture-user', is_anonymous: true } }))
    }
    if (String(url).includes('/token?')) {
      refreshes++
      if (authDown) return new Response('', { status: 503 })
      assert.equal(JSON.parse(String(init?.body)).refresh_token, 'refresh-fixture')
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Math.floor(now / 1000) + 3600, user: { id: 'fixture-user', is_anonymous: true } }))
    }
    uploads++
    return new Response(JSON.stringify({ accepted: [row.eventId], duplicates: [], rejected: [], limited: [] }))
  }) as typeof fetch
  const encrypt = async (value: string) => Buffer.from(value).toString('base64')
  const decrypt = async (value: string) => Buffer.from(value, 'base64').toString()
  const transport = new MonitorTransport({ url: 'https://fixture.supabase.co', publishableKey: 'public-fixture' }, transportQueue, send, () => now, encrypt, decrypt)
  await transport.upload([row]); await transport.upload([row])
  assert.equal(signups, 1); assert.equal(uploads, 2)
  assert.doesNotMatch(await readFile(join(root, 'transport', 'state.json'), 'utf8'), /access-fixture|refresh-fixture/)
  const restored = new MonitorQueue(join(root, 'transport'), () => now)
  await restored.init()
  const again = new MonitorTransport({ url: 'https://fixture.supabase.co', publishableKey: 'public-fixture' }, restored, send, () => now, encrypt, decrypt)
  await again.upload([row]); assert.equal(signups, 1, 'restart reuses the stored anonymous identity')
  now += 3600_000; authDown = true
  await assert.rejects(again.upload([row]))
  assert.equal(signups, 1, 'transient refresh failure must not create a new anonymous account')
  authDown = false
  await again.upload([row]); assert.equal(refreshes, 2); assert.equal(signups, 1)
  await writeFile(join(root, 'transport', 'state.json'), '{broken')
  await assert.rejects(new MonitorQueue(join(root, 'transport')).init())
  assert.equal(await readFile(join(root, 'transport', 'state.json'), 'utf8'), '{broken', 'corrupt identity state is preserved, not silently reset')
  console.log('cloud monitor queue, recovery, identity refresh: passed')
} finally { await rm(root, { recursive: true, force: true }) }
