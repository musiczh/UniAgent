import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { KimiWebTransport, KimiWebError } from '../src/main/kimiWebTransport.ts'

const seen: { method?: string; url?: string; body: any }[] = []
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-secret')
  let body = ''
  for await (const chunk of req) body += chunk
  seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/v1/conflict') return res.end(JSON.stringify({ code: 40902, msg: 'secret provider key', data: { resolved: false } }))
  if (req.url === '/api/v1/malformed') return res.end('{"data":{"ok":true}}')
  if (req.url?.endsWith('/snapshot')) return res.end(JSON.stringify({ code: 0, data: { as_of_seq: 8, epoch: 'fresh', session: { id: 's' } } }))
  res.end(JSON.stringify({ code: 0, data: { ok: true } }))
})
const wss = new WebSocketServer({ server })
const controls: any[] = []
let hello: string | undefined = JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2 } })
wss.on('connection', (socket, req) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-secret')
  if (hello !== undefined) socket.send(hello)
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()); controls.push(frame)
    socket.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, payload: { accepted: ['s'], not_found: [], resync_required: [] } }))
    if (controls.length === 1) {
      socket.send(JSON.stringify({ type: 'goal.updated', session_id: 's', seq: 1, epoch: 'old', payload: { snapshot: null } }))
      socket.send(JSON.stringify({ type: 'goal.updated', session_id: 'other', seq: 99, epoch: 'old', payload: {} }))
      socket.send(JSON.stringify({ type: 'resync_required', payload: { session_id: 's', reason: 'epoch_changed' } }))
    }
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const transport = new KimiWebTransport({ origin: `http://127.0.0.1:${address.port}`, token: 'fixture-secret', timeoutMs: 500 })
try {
  await transport.verifyProtocol()
  assert.equal(controls.length, 0, 'protocol checks must not subscribe to or create sessions')
  const validHello = hello
  for (const [frame, error] of [[undefined, /hello_timeout/], ['{broken', /stream_protocol/], [JSON.stringify({ type: 'server_hello', payload: { protocol_version: 3 } }), /protocol_version/]] as const) {
    hello = frame
    await assert.rejects(transport.verifyProtocol(), error)
  }
  hello = validHello
  assert.deepEqual(await transport.request('POST', '/api/v1/example', { value: 'literal $HOME' }), { ok: true })
  assert.deepEqual(seen[0].body, { value: 'literal $HOME' })
  await assert.rejects(transport.request('GET', '/api/v1/conflict'), (error: any) => error instanceof KimiWebError && error.code === 40902 && !error.message.includes('secret'))
  await assert.rejects(transport.request('GET', '/api/v1/malformed'), /kimi_web_protocol/)
  assert.throws(() => new KimiWebTransport({ origin: 'http://example.com:1', token: 'x' }), /loopback/)
  const events: any[] = []
  const snapshots: any[] = []
  const stream = await transport.subscribe('s', { onEvent: (frame) => { events.push(frame) }, onSnapshot: async (value) => { snapshots.push(value); await new Promise(resolve => setTimeout(resolve, 100)) } }, { seq: 0, epoch: 'old' })
  assert.deepEqual(controls[0].payload.cursors, { s: { seq: 0, epoch: 'old' } })
  const until = Date.now() + 2000
  while ((!snapshots.length || controls.length < 2) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(events.length, 1, 'other native sessions cannot leak into this stream')
  assert.equal(snapshots[0].epoch, 'fresh')
  assert.equal(controls.length, 2, 'snapshot recovery must finish its asynchronous observer before the server receives the renewed subscription')
  assert.deepEqual(controls[1].payload.cursors, { s: { seq: 8, epoch: 'fresh' } })
  await stream.closeAndWait()
  const closeDeadline = Date.now() + 500
  while (wss.clients.size && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(wss.clients.size, 0)
} finally {
  await transport.closeAndWait()
  for (const client of wss.clients) client.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
console.log('Kimi web transport: envelope, auth, session filter and snapshot recovery passed')

const modernControls: string[] = [], modernSnapshots: any[] = [], modernEvents: any[] = []
let nativeText = 'abc', nativeSeq = 3, modernSocket: any
let task = { task_id: 'owned', kind: 'subagent', status: 'running', child_agent_id: 'child' }
let wrongTaskResponse = false
const nativeTurn = () => ({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: 'hello', steps: [
  { kind: 'step', stepId: 't1.0', ordinal: 0, state: 'running', frames: [{ kind: 'text', frameId: 'reply', role: 'assistant', text: nativeText }] }
] })
const modernServer = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-secret')
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url === '/openapi.json' ? { paths: { '/api/v1/sessions/{session_id}/transcript/ops': { get: {} } } }
    : { code: 0, data: { id: 'modern' } }))
})
const modernWss = new WebSocketServer({ server: modernServer })
modernWss.on('connection', socket => {
  modernSocket = socket
  socket.send(JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2, ws_connection_id: 'modern-connection' } }))
  socket.on('message', raw => {
    const control = JSON.parse(raw.toString()); modernControls.push(control.type)
    if (control.type.startsWith('task.')) {
      assert.equal(control.id, undefined)
      assert.equal(control.payload, undefined)
      assert.equal(control.session_id, 'modern')
      assert.equal(control.agent_id, 'main', 'task commands address the parent, never the child')
      assert.equal(control.task_id, 'owned')
      if (control.type === 'task.stop') {
        task = { ...task, status: 'ended', outcome: 'killed' } as any
        socket.send(JSON.stringify({ type: 'task', session_id: 'modern', agent_id: 'main', ...task }))
      }
      socket.send(JSON.stringify({ type: 'response', request_id: control.request_id, code: 0,
        task: control.type === 'task.unwatch' ? undefined : { ...task, child_agent_id: wrongTaskResponse ? 'foreign' : 'child' } }))
      if (control.type === 'task.watch') {
        socket.send(JSON.stringify({ type: 'task.output', session_id: 'other', agent_id: 'main', task_id: 'owned', offset: 0, text: 'foreign text' }))
        socket.send(JSON.stringify({ type: 'task.output', session_id: 'modern', agent_id: 'main', task_id: 'owned', offset: 0, text: 'child output 中文' }))
      }
      return
    }
    if (control.type === 'subscribe_v2') {
      assert.deepEqual(control.payload, { session_id: 'modern', transcript: { '*': 'delta' } })
      socket.send(JSON.stringify({ type: 'agent', session_id: 'modern', agent_id: 'main', status: 'running', model: 'local', thinking: 'low', permission_mode: 'manual' }))
      socket.send(JSON.stringify({ type: 'task.list', session_id: 'modern', agent_id: 'main', tasks: [task] }))
      socket.send(JSON.stringify({ type: 'task', session_id: 'modern', agent_id: 'other-owner', ...task, task_id: 'foreign-owner' }))
      socket.send(JSON.stringify({ type: 'transcript.reset', session_id: 'modern', payload: { agent_id: 'main', seq: nativeSeq, snapshot: { items: [nativeTurn()], interactions: [], attachments: [], prompts: [] } } }))
    }
    socket.send(JSON.stringify({ type: 'ack', id: control.id, code: 0, payload: { accepted: ['modern'], not_found: [] } }))
  })
})
await new Promise<void>(resolve => modernServer.listen(0, '127.0.0.1', resolve))
const modern = new KimiWebTransport({ origin: `http://127.0.0.1:${(modernServer.address() as any).port}`, token: 'fixture-secret', timeoutMs: 1000 })
const waitUntil = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('modern protocol fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
try {
  await modern.specification('/openapi.json')
  const observer = await modern.subscribe('modern', { onEvent: value => { modernEvents.push(value) }, onSnapshot: value => { modernSnapshots.push(value) } })
  assert.equal((await modern.request<any>('GET', '/api/v1/sessions/modern/status')).permission, 'manual')
  assert.ok(modernControls.includes('client_hello') && modernControls.includes('subscribe_v2'))
  const tasks = await modern.tasks('modern')
  assert.equal(tasks.items.length, 1, 'tasks owned by another agent are excluded')
  assert.equal(tasks.items[0].agent_id, 'child')
  const detail = await modern.subagentTask('modern', tasks.items[0])
  assert.equal(detail.output_preview, 'child output 中文')
  wrongTaskResponse = true
  await assert.rejects(modern.subagentTask('modern', tasks.items[0]), /subagent_identity_invalid/)
  wrongTaskResponse = false
  await assert.rejects(modern.subagentTask('modern', { ...tasks.items[0], agent_id: 'foreign' }), /subagent_not_owned/)
  assert.equal((await modern.subagentTask('modern', tasks.items[0], true)).status, 'cancelled')
  assert.equal((await modern.tasks('modern')).items[0].status, 'cancelled')
  assert.equal(modernControls.filter(type => type === 'task.watch').length, modernControls.filter(type => type === 'task.unwatch').length, 'every output read releases its native watch, including invalid responses')
  const sendOps = (seq: number, offset: number, text: string) => modernSocket.send(JSON.stringify({ type: 'transcript.ops', session_id: 'modern', payload: {
    agent_id: 'main', seq, ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.0', frameId: 'reply' }, offset, text }]
  } }))
  nativeText = 'abcdef'; nativeSeq = 4
  sendOps(4, 3, 'def')
  const lastText = () => modernSnapshots.at(-1)?.transcript[0]?.steps[0].frames[0].text
  await waitUntil(() => lastText() === 'abcdef')
  sendOps(4, 3, 'def')
  modernSocket.send(JSON.stringify({ type: 'agent', session_id: 'other', agent_id: 'main', status: 'idle' }))
  nativeText = 'authoritative baseline'; nativeSeq = 6
  sendOps(5, 99, 'lost delta')
  await waitUntil(() => lastText() === nativeText)
  assert.ok(modernControls.includes('unsubscribe_v2'), 'a delta gap requests a fresh native baseline')
  assert.ok(modernEvents.every(frame => frame.session_id === 'modern'))
  await observer.closeAndWait()
} finally {
  await modern.closeAndWait()
  await waitUntil(() => modernWss.clients.size === 0)
  await new Promise<void>(resolve => modernWss.close(() => resolve()))
  await new Promise<void>(resolve => modernServer.close(() => resolve()))
}
console.log('Kimi subscribe_v2: native handshake, state, streaming, gaps, session isolation and close passed')

const turnsRequests: string[] = [], turnsControls: any[] = [], turnsSnapshots: any[] = []
const turnsServer = createServer((req, res) => {
  turnsRequests.push(req.url!)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url === '/openapi.json' ? { paths: { '/api/v1/sessions/{session_id}/agents/{agent_id}/turns': { get: {} } } }
    : { code: 0, data: { id: 'turns-session' } }))
})
const turnsWss = new WebSocketServer({ server: turnsServer })
let turnsSocket: any, silent = false, connections = 0
turnsWss.on('connection', socket => {
  turnsSocket = socket; connections++
  let subscribed = false
  socket.on('message', raw => {
    const control = JSON.parse(raw.toString()); turnsControls.push(control)
    assert.equal(control.type, 'subscribe'); assert.equal(control.session_id, 'turns-session')
    assert.equal(typeof control.request_id, 'string'); assert.equal(control.payload, undefined)
    if (silent) return
    socket.send(JSON.stringify({ type: 'response', request_id: control.request_id, code: 0 }))
    if (subscribed) return
    subscribed = true
    const frame = (type: string, fields: any) => socket.send(JSON.stringify({ type, session_id: 'turns-session', agent_id: 'main', ...fields }))
    setTimeout(() => {
      frame('agent', { status: 'idle', permission_mode: 'manual', model: 'local' })
      frame('usage', { context_tokens: 20, max_context_tokens: 256000 })
      frame('turns', { turns: [], has_more: false })
    }, 10)
  })
})
await new Promise<void>(resolve => turnsServer.listen(0, '127.0.0.1', resolve))
const turnsTransport = new KimiWebTransport({ origin: `http://127.0.0.1:${(turnsServer.address() as any).port}`, token: 'fixture-secret', timeoutMs: 200 })
try {
  await turnsTransport.specification('/openapi.json')
  await turnsTransport.verifyProtocol()
  assert.equal(turnsControls.length, 0, 'native WebSocket control probing does not create or subscribe a session')
  const observer = await turnsTransport.subscribe('turns-session', { onEvent() {}, onSnapshot: async value => {
    const current = await turnsTransport.request<any>('GET', '/api/v1/sessions/turns-session/status')
    assert.equal(current.model, 'local', 'snapshot handlers can read native state without waiting on themselves')
    turnsSnapshots.push(value)
  } })
  const status = await turnsTransport.request<any>('GET', '/api/v1/sessions/turns-session/status')
  assert.equal(status.model, 'local'); assert.equal(status.context_tokens, 20)
  assert.ok(turnsSnapshots.length > 0, 'a response before the turns baseline must still await readable state')
  assert.ok(turnsRequests.every(path => !path.endsWith('/status')), 'removed REST status endpoints are never requested')
  const before = connections; turnsSocket.terminate()
  await waitUntil(() => connections > before && turnsSnapshots.length > 1)
  assert.equal((await turnsTransport.request<any>('GET', '/api/v1/sessions/turns-session/status')).model, 'local')
  silent = true
  let recovered = 0
  turnsTransport.onFailure = async () => { recovered++; return true }
  await assert.rejects(turnsTransport.request('GET', '/api/v1/sessions/turns-session/snapshot'), (error: any) => error instanceof KimiWebError && error.kind === 'stream_timeout' && error.recovered)
  assert.equal(recovered, 1, 'cached state cannot hide an unresponsive native service')
  await observer.closeAndWait()
} finally {
  await turnsTransport.closeAndWait()
  await new Promise<void>(resolve => turnsWss.close(() => resolve()))
  await new Promise<void>(resolve => turnsServer.close(() => resolve()))
}
console.log('Kimi turns transport: native controls, baseline ordering, state, reconnect and service recovery passed')
