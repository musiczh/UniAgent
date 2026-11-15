import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMonitorHandler } from '../supabase/functions/monitor-ingest/handler'

const owner = randomUUID(), other = randomUUID(), eventId = randomUUID()
const record = { schemaVersion: 1, eventId, category: 'diagnostic', occurredAt: Date.now(), distribution: 'public', appVersion: '1.1.0', agentId: 'codex', code: 'failed', level: 'error', payload: { message: 'Connection closed', source: 'transport', count: 1 } }
let calls = 0, saved: any, fail = false
const handler = createMonitorHandler({ url: 'https://fixture.supabase.co', secretKey: 'server-only-fixture', fetch: (async (url, init) => {
  calls++
  if (String(url).endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: owner }))
  saved = JSON.parse(String(init?.body))
  return fail ? new Response('private SQL error and secret', { status: 500 }) : new Response(JSON.stringify({ accepted: [eventId], duplicates: [], rejected: [], limited: [], retryAfter: 100 }))
}) as typeof fetch })
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://fixture.supabase.co/functions/v1/monitor-ingest', { method: 'POST', headers: { Authorization: 'Bearer valid-user-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
assert.equal((await handler(request([record]))).status, 200)
assert.equal(saved.p_owner, owner)
assert.equal(saved.p_records[0].eventId, eventId)
assert.equal((await handler(request([{ ...record, owner_id: other }]))).status, 400)
assert.equal(calls, 2, 'invalid payload never reaches authentication or the database')
assert.equal((await handler(request([record], { Authorization: '' }))).status, 401)
assert.equal((await handler(request([record], { 'Content-Type': 'text/plain' }))).status, 415)
assert.equal((await handler(request([record], { 'Content-Length': String(256 * 1024 + 1) }))).status, 413)
assert.equal((await handler(request(Array(51).fill(record)))).status, 400)
assert.equal((await handler(request([{ ...record, payload: { ...record.payload, message: 'token=actual-secret' } }]))).status, 400)
const streamed = new Request('https://fixture/ingest', { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close() } }), duplex: 'half' } as RequestInit)
assert.equal((await handler(streamed)).status, 413, 'streamed bodies are bounded without trusting Content-Length')
fail = true
const failure = await handler(request([record]))
assert.equal(failure.status, 503)
assert.doesNotMatch(await failure.text(), /private|SQL|secret/)
const unauthenticated = createMonitorHandler({ url: 'https://fixture.supabase.co', secretKey: 'fixture', fetch: (async () => new Response('', { status: 401 })) as typeof fetch })
assert.equal((await unauthenticated(request([record]))).status, 401)
const throttled = createMonitorHandler({ url: 'https://fixture.supabase.co', secretKey: 'fixture', fetch: (async () => new Response('', { status: 429, headers: { 'Retry-After': '123' } })) as typeof fetch })
const throttledResponse = await throttled(request([record]))
assert.equal(throttledResponse.status, 429); assert.equal(throttledResponse.headers.get('retry-after'), '123')
console.log('cloud monitor ingest HTTP: passed')
