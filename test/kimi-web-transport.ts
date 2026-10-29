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
  const stream = await transport.subscribe('s', { onEvent: (frame) => { events.push(frame) }, onSnapshot: (value) => { snapshots.push(value) } }, { seq: 0, epoch: 'old' })
  assert.deepEqual(controls[0].payload.cursors, { s: { seq: 0, epoch: 'old' } })
  const until = Date.now() + 2000
  while (!snapshots.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(events.length, 1, 'other native sessions cannot leak into this stream')
  assert.equal(snapshots[0].epoch, 'fresh')
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
