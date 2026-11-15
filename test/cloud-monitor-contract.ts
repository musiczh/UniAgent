import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { monitorPerformancePayload, redactMonitorText, validateMonitorRecord, type MonitorRecord } from '../src/shared/cloudMonitor'

const row: MonitorRecord = { schemaVersion: 1, eventId: randomUUID(), category: 'diagnostic', occurredAt: Date.now(), distribution: 'public', appVersion: '1.1.0', agentId: 'codex', code: 'connection_failed', level: 'error', payload: { message: 'Connection closed', source: 'transport', count: 1 } }
assert.equal(validateMonitorRecord(row), true)
for (const patch of [{ owner_id: randomUUID() }, { schemaVersion: 2 }, { category: 'unknown' }, { occurredAt: Date.now() + 600_000 }, { appVersion: '../private' }, { payload: { ...row.payload, prompt: 'private input' } }, { payload: { ...row.payload, count: NaN } }, { payload: { ...row.payload, count: 1.5 } }, { payload: { ...row.payload, message: 'x'.repeat(2001) } }]) assert.equal(validateMonitorRecord({ ...row, ...patch }), false, JSON.stringify(patch).slice(0, 100))
const raw = 'Bearer abcdef token=secret api_key="private-key" sk-123456789abcdef ghp_fakecredential sb_secret_fakecredential https://internal.example/a?key=private /Users/person/private/code.ts C:\\Users\\person\\secret.ts mail@example.com'
const clean = redactMonitorText(raw)
assert.doesNotMatch(clean, /abcdef|private-key|fakecredential|internal\.example|person|mail@example/)
assert.equal(redactMonitorText(clean), clean, 'redaction must remain stable under server validation')
assert.equal(validateMonitorRecord({ ...row, payload: { ...row.payload, message: raw } }), false)
assert.equal(validateMonitorRecord({ ...row, code: 'sb_secret_fakecredential' }), false, 'metadata must not carry credential-shaped identifiers')
const metrics = monitorPerformancePayload({ tree: { cpuPercent: 10, rssSumBytes: 100, processes: [{ name: 'private.exe', commandLine: 'secret' }] }, main: { heapBytes: 50 }, heapBytes: Infinity, longestMs: -1, token: 'secret', prompt: 'private' })
assert.deepEqual(metrics, { cpuPercent: 10, rssBytes: 100, heapBytes: 50 })
assert.equal(validateMonitorRecord({ ...row, category: 'performance', payload: metrics }), true)
assert.equal(validateMonitorRecord({ ...row, category: 'performance', payload: {} }), false)
assert.equal(validateMonitorRecord({ ...row, category: 'performance', payload: { rssBytes: '100' } }), false)
const feedback = { ...row, category: 'router_feedback', payload: { requestKey: 'a'.repeat(64), attemptKey: 'b'.repeat(64), matches: false, revision: 2, reason: '应复用原任务', actualAction: 'create_task_in_space', expectedKind: 'reuse_task' } }
assert.equal(validateMonitorRecord(feedback), true)
assert.equal(validateMonitorRecord({ ...feedback, payload: { ...feedback.payload, prompt: 'private' } }), false)
assert.equal(validateMonitorRecord({ ...feedback, payload: { ...feedback.payload, matches: 'false' } }), false)
assert.equal(validateMonitorRecord({ ...feedback, payload: { ...feedback.payload, actualAction: 'arbitrary' } }), false)
assert.equal(validateMonitorRecord({ ...feedback, payload: { ...feedback.payload, requestKey: '/Users/private' } }), false)
console.log('cloud monitor contract: passed')
