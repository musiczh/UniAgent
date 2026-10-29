import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTokenSpeedTelemetry, TokenSpeedTelemetryDecoder, type NativeTokenSpeed } from '../src/main/tokenSpeedTelemetry'
import { AppServerRpcClient } from '../src/main/appServerTransport'
import { TurnRunner } from '../src/main/adapter'
import type { UAEvent } from '../src/shared/types'

// These are the actual OTLP JSON attribute shapes emitted by the installed CLIs.
const log = (values: Record<string, unknown>) => ({ attributes: Object.entries(values).map(([key, value]) => ({ key,
  value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })) })
const batch = (...logs: ReturnType<typeof log>[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: logs }] }] })
const at = (ms: number) => new Date(ms).toISOString()
const start = (ms: number, extra: Record<string, unknown> = {}) => log({ 'event.name': 'codex.api_request',
  'event.timestamp': at(ms), 'conversation.id': 'main', model: 'model-a', duration_ms: '10', endpoint: '/responses',
  'http.response.status_code': 200, ...extra })
const complete = (ms: number, extra: Record<string, unknown> = {}) => log({ 'event.name': 'codex.sse_event',
  'event.timestamp': at(ms), 'conversation.id': 'main', model: 'model-a', 'event.kind': 'response.completed',
  output_token_count: '100', ...extra })

for (const agent of ['codex', 'traex'] as const) {
  const samples: NativeTokenSpeed[] = []
  const decoder = new TokenSpeedTelemetryDecoder(agent, sample => samples.push(sample))
  decoder.ingest(batch(start(1010), complete(3000)))
  assert.equal(samples.length, 1)
  assert.equal(samples[0].speed.outputTokens, 100)
  assert.equal(samples[0].speed.durationMs, 2000, 'header latency is not full inference duration')
  assert.equal(samples[0].speed.startedAt, 1000)
  assert.equal(samples[0].ts, 3000, 'export delay must not affect completion time')
  assert.equal(samples[0].speed.metric, 'request')
  decoder.ingest(batch(start(1010), complete(3000)))
  assert.equal(samples.length, 1, 'replayed batches are deduplicated')
  decoder.ingest(batch(complete(8000), start(6010)))
  assert.equal(samples.at(-1)!.speed.durationMs, 2000, 'records are ordered by native time')
  decoder.ingest(batch(start(9010, { 'conversation.id': 'child' }), complete(10000, { 'conversation.id': 'child', output_token_count: '500' })))
  assert.equal(samples.at(-1)!.threadId, 'child', 'the adapter can route child samples separately')
  assert.equal(samples.at(-1)!.speed.outputTokens, 500)

  const websocket: NativeTokenSpeed[] = []
  new TokenSpeedTelemetryDecoder(agent, sample => websocket.push(sample)).ingest(batch(
    start(1020, { 'event.name': 'codex.websocket_request', endpoint: undefined, duration_ms: '20', success: true }),
    complete(2000, { 'event.name': 'codex.websocket_event' })))
  assert.equal(websocket[0].speed.durationMs, 1000)

  const retried: NativeTokenSpeed[] = []
  new TokenSpeedTelemetryDecoder(agent, sample => retried.push(sample)).ingest(batch(
    start(1010), log({ 'event.name': 'codex.sse_event', 'conversation.id': 'main', 'event.timestamp': at(1500), 'error.message': 'disconnected' }),
    start(4010), complete(6000)))
  assert.equal(retried.length, 2)
  assert.equal(retried[0].speed.durationMs, undefined)
  assert.equal(retried[1].speed.durationMs, 2000, 'failed attempt and retry backoff cannot lengthen the successful request')
  const unrelated: NativeTokenSpeed[] = []
  new TokenSpeedTelemetryDecoder(agent, sample => unrelated.push(sample)).ingest(batch(start(1010),
    start(1500, { endpoint: '/models', success: false, 'error.message': 'catalog unavailable' }), complete(3000)))
  assert.equal(unrelated.at(-1)!.speed.durationMs, 2000, 'a background model catalog failure cannot cancel the inference timing')
  const interrupted: NativeTokenSpeed[] = []
  const resumed = new TokenSpeedTelemetryDecoder(agent, sample => interrupted.push(sample))
  resumed.endTurn('main', 2000)
  resumed.ingest(batch(start(1010), start(4010), complete(6000)))
  assert.equal(interrupted.at(-1)!.speed.durationMs, 2000, 'a cancelled request cannot poison later turns even when its telemetry arrives after the boundary')

  const ambiguous: NativeTokenSpeed[] = []
  new TokenSpeedTelemetryDecoder(agent, sample => ambiguous.push(sample)).ingest(batch(start(1010), start(1210), complete(2000), complete(3000)))
  assert.equal(ambiguous.length, 2)
  assert.ok(ambiguous.every(sample => sample.speed.durationMs === undefined), 'overlapping requests without IDs must remain missing')
  for (const invalid of [batch(complete(3000)), batch(start(1010, { endpoint: '/responses/compact' }), complete(3000)),
    batch(start(1010, { 'http.response.status_code': 500 }), complete(3000)), batch(start(1010), complete(3000, { output_token_count: '-1' })),
    batch(start(1010, { duration_ms: 'NaN' }), complete(3000)), batch(start(1010, { 'event.timestamp': 'invalid' }), complete(3000))]) {
    const invalidSamples: NativeTokenSpeed[] = []
    new TokenSpeedTelemetryDecoder(agent, sample => invalidSamples.push(sample)).ingest(invalid)
    assert.ok(invalidSamples.every(sample => sample.speed.durationMs === undefined))
  }
  const missing: NativeTokenSpeed[] = []
  new TokenSpeedTelemetryDecoder(agent, sample => missing.push(sample)).ingest(batch(start(1010), complete(3000, { model: 'other-model' })))
  assert.equal(missing[0].speed.durationMs, undefined, 'model mismatches must not be pooled')
}

const claude = (extra: Record<string, unknown> = {}) => log({ 'event.name': 'api_request', 'event.timestamp': at(4000),
  'session.id': 'claude-main', 'query_source': 'sdk', model: 'sonnet', output_tokens: 100, duration_ms: 2000,
  request_id: 'req-one', 'event.sequence': 5, ...extra })
const samples: NativeTokenSpeed[] = []
const decoder = new TokenSpeedTelemetryDecoder('claude', sample => samples.push(sample))
decoder.ingest(batch(claude(), claude({ query_source: 'compact' }), claude({ query_source: 'agent.custom' }),
  claude({ agent_id: 'child' }), claude({ 'event.name': 'api_error' })))
assert.equal(samples.length, 1, 'only successful main-loop calls belong in the main timer')
assert.equal(samples[0].speed.durationMs, 2000)
assert.equal(samples[0].speed.startedAt, 2000)
decoder.ingest(batch(claude()))
assert.equal(samples.length, 1)
decoder.ingest(batch(claude({ request_id: 'req-two', query_source: 'repl_main_thread', duration_ms: 0 })))
assert.equal(samples.length, 2)
assert.equal(samples[1].speed.durationMs, 0, 'the existing summary validator rejects zero-duration data')
decoder.ingest(undefined)
decoder.ingest({ resourceLogs: [{ scopeLogs: [null, { logRecords: [null] }] }] })

for (const agent of ['codex', 'traex', 'claude'] as const) {
  const received: NativeTokenSpeed[] = []
  const receiver = (await startTokenSpeedTelemetry(agent, sample => received.push(sample), { NO_PROXY: '.example.com', no_proxy: '.internal' }))!
  assert.equal(receiver.env.NO_PROXY, '.example.com,.internal,127.0.0.1,localhost')
  assert.equal(receiver.env.no_proxy, receiver.env.NO_PROXY, 'loopback export cannot be routed through a network proxy')
  const endpoint = agent === 'claude' ? receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!
    : /endpoint="([^"]+)"/.exec(receiver.args[1])![1]
  assert.equal(new URL(endpoint).hostname, '127.0.0.1')
  try {
    assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify(agent === 'claude' ? batch(claude()) : batch(start(1010), complete(3000))) })).status, 200)
    assert.equal(received.length, 1, 'the receiver delivers decoded events before acknowledging export')
    assert.equal((await fetch(endpoint)).status, 404)
    assert.equal((await fetch(new URL('/wrong', endpoint), { method: 'POST' })).status, 404)
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{bad' })).status, 400)
    const oversized = await fetch(endpoint, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
      .catch(error => { assert.equal(error.name, 'TypeError'); return undefined })
    if (oversized) assert.equal(oversized.status, 413)
  } finally { await receiver.close() }
  await assert.rejects(fetch(endpoint), 'closed processes must not leave a collector listener behind')
}

const directory = await mkdtemp(join(tmpdir(), 'ua-token-speed-'))
const fixture = join(directory, 'native.cjs')
await writeFile(fixture, `#!${process.execPath}
const readline=require('node:readline');
const exporter=process.argv.find(arg=>arg.startsWith('otel.exporter='));
const endpoint=exporter ? /endpoint="([^"]+)"/.exec(exporter)[1] : process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
const batch=${JSON.stringify(batch(start(1010), complete(3000)))};
const claude=${JSON.stringify(batch(claude(), claude({ query_source: 'agent.custom', request_id: 'child' })))};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const message=JSON.parse(line);
 if(message.method==='emit-speed'){
  const response=await fetch(endpoint,{method:'POST',body:JSON.stringify(batch)});
  send({id:message.id,result:{status:response.status}});
 }else if(message.type==='control_request'){
  send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[]}}});
 }else if(message.type==='user'){
  send({type:'system',subtype:'init',session_id:'claude-main'});
  const response=await fetch(endpoint,{method:'POST',body:JSON.stringify(claude)});
  send({type:'result',subtype:'success',result:'ok',usage:{output_tokens:100},is_error:response.status!==200,user_message_uuid:message.uuid});
 }else if(message.id!==undefined)send({id:message.id,result:{ok:true}});
});
`, { mode: 0o700 })
try {
  for (const agent of ['codex', 'traex'] as const) {
    const transport = new AppServerRpcClient({ bin: process.execPath, args: [fixture], cwd: directory, tokenSpeed: agent })
    const received: NativeTokenSpeed[] = []
    transport.on('notification', (method, params) => { if (method === 'uniagent/tokenSpeed') received.push(params) })
    try {
      await Promise.all([transport.start(), transport.start()])
      assert.deepEqual(await transport.request('emit-speed', {}), { status: 200 })
      assert.equal(received.length, 1, `${agent} subprocess must receive telemetry overrides`)
      assert.equal(received[0].speed.durationMs, 2000)
    } finally { await transport.dispose() }
  }
  const runner = new TurnRunner('test-claude', { n: 0 })
  const events: UAEvent[] = []
  runner.on('event', event => events.push(event))
  const done = once(runner, 'done')
  runner.start({ id: 'claude', adapter: 'claude', name: 'Claude Code', bin: fixture, builtin: true, installed: true, icon: '', models: [],
    capabilities: { modelSelect: true, reasoningEffort: false, streaming: true, permissionModes: [{ id: 'read-only', label: '只读', hint: '' }] } },
    { agentId: 'claude', workdir: directory, permissionMode: 'read-only' }, 'Run')
  await done
  await runner.disposeClaudeSdk()
  const speeds = events.filter(event => event.payload.kind === 'token_speed')
  assert.equal(speeds.length, 1, `Claude startup wires the local receiver and excludes child calls: ${JSON.stringify(events.filter(event => event.type === 'error'))}`)
  assert.equal(speeds[0].payload.speed.outputTokens, 100)
  assert.equal(speeds[0].payload.speed.durationMs, 2000)
  assert.ok(events.some(event => event.type === 'turn_completed' && event.state === 'success'))
  assert.doesNotMatch(events.find(event => event.payload.kind === 'launch')!.payload.text, /otel\.exporter|\/v1\/logs/)
} finally { await rm(directory, { recursive: true, force: true }) }

console.log('Token speed telemetry: native request timing, isolation, retries, replay, invalid inputs and loopback lifecycle passed')
