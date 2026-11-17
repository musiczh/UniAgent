import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startModelGateway, type GatewayRoute } from '../src/main/model-source-gateway/gateway'

const received: any[] = []
let release: (() => void) | undefined
const upstream = createServer((req, res) => { void (async () => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const bytes = Buffer.concat(chunks), body = req.url?.includes('/files') ? { file: bytes.toString() } : JSON.parse(bytes.toString()); received.push({ url: req.url, authorization: req.headers.authorization, key: req.headers['x-api-key'], body })
  if (body.contextError) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } })); return }
  if (body.wait) await new Promise<void>(resolve => { release = resolve })
  res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json')
  res.end(body.stream ? 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\nevent: response.completed\ndata: {"response":{"status":"completed"}}\n\n' : JSON.stringify({ content: [{ text: 'ok' }], extra: 'kept' }))
})().catch(() => res.destroy()) })
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const port = (upstream.address() as any).port
const routes: GatewayRoute[] = ['anthropic-messages', 'openai-responses', 'openai-chat'].map(protocol => ({ id: 'fixture/' + protocol, endpoint: { id: protocol, protocol: protocol as any, baseUrl: `http://127.0.0.1:${port}/api`, auth: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer' }, token: 'local-fixture', apiKey: 'upstream-fixture', models: ['alias'], modelMap: { alias: 'actual-model' } }))
const gateway = await startModelGateway(0, { routes }), origin = `http://127.0.0.1:${(gateway.server.address() as any).port}`
const url = (protocol: string, resource: string) => `${origin}/s/fixture/e/${protocol}${resource}`
try {
  for (const [protocol, resource] of [['anthropic-messages', '/v1/messages'], ['openai-responses', '/responses'], ['openai-chat', '/chat/completions']]) {
    const body = { model: 'alias', messages: [{ role: 'user', content: 'hello' }], tools: [{ custom: { untouched: true } }], extension: { keep: [1, 2] } }
    const response = await fetch(url(protocol, resource), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200); assert.equal((await response.json() as any).extra, 'kept')
    const request = received.at(-1); assert.equal(request.body.model, 'actual-model'); assert.deepEqual(request.body.tools, body.tools); assert.deepEqual(request.body.extension, body.extension)
    assert.equal(request.url, protocol === 'anthropic-messages' ? '/api/v1/messages' : '/api' + resource)
    assert.ok(request.authorization === 'Bearer upstream-fixture' || request.key === 'upstream-fixture')
  }
  assert.equal((await fetch(url('openai-chat', '/chat/completions'), { method: 'POST', body: '{}' })).status, 401)
  const beta = await fetch(url('anthropic-messages', '/v1/messages?beta=true'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'SDK beta query' }] }) })
  assert.equal(beta.status, 200, 'Anthropic SDK beta query must reach the upstream')
  assert.equal(received.at(-1).url, '/api/v1/messages?beta=true')
  for (const resource of ['/v1/messages?beta=true&redirect=other', '/v1/messages?beta=true&beta=false', '/v1/messages?beta=invalid']) assert.equal((await fetch(url('anthropic-messages', resource), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify({ model: 'alias' }) })).status, 404)
  assert.equal((await fetch(url('openai-chat', '/messages'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: '{}' })).status, 404)
  const stream = await fetch(url('openai-responses', '/responses'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify({ model: 'alias', stream: true }) })
  assert.match(await stream.text(), /response.completed/)
  const context = await fetch(url('openai-responses', '/responses'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify({ model: 'alias', stream: true, contextError: true }) })
  assert.equal(context.status, 200); assert.match(await context.text(), /context_length_exceeded/)
  gateway.update({ routes: [...routes, { ...routes[0], id: 'fixture/anthropic-messages/deepseek/1', token: 'deepseek-only', files: true }, { ...routes[1], id: 'fixture/openai-responses/codex/1', token: 'codex-only', kimi: true }] })
  const scoped = `${origin}/s/fixture/e/anthropic-messages/a/deepseek/r/1`
  const file = await fetch(scoped + '/v1/files', { method: 'POST', headers: { Authorization: 'Bearer deepseek-only', 'content-type': 'multipart/form-data; boundary=fixture' }, body: '--fixture\r\nfile contents\r\n--fixture--' })
  assert.equal(file.status, 200); assert.match(received.at(-1).body.file, /file contents/)
  assert.equal((await fetch(scoped + '/v1/files/file_fixture', { method: 'DELETE', headers: { Authorization: 'Bearer codex-only' } })).status, 401, 'Agent tokens cannot access another route')
  const kimi = await fetch(`${origin}/s/fixture/e/openai-responses/a/codex/r/1/responses`, { method: 'POST', headers: { Authorization: 'Bearer codex-only' }, body: JSON.stringify({ model: 'alias', tools: [{ type: 'function', name: 'fixture', parameters: { $defs: { Args: { type: 'object', properties: { text: { type: 'string' } } } }, $ref: '#/$defs/Args' } }], input: [{ type: 'message', role: 'user', id: 'foreign-provider-id', content: 'hello' }] }) })
  assert.equal(kimi.status, 200); assert.equal(received.at(-1).body.input[0].id, undefined); assert.equal(received.at(-1).body.tools[0].parameters.type, 'object')
  const pending = fetch(url('openai-chat', '/chat/completions'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: JSON.stringify({ model: 'alias', wait: true }) })
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  gateway.update({ routes: [] }); release()
  assert.equal((await pending).status, 200, 'in-flight request retains original route')
  assert.equal((await fetch(url('openai-chat', '/chat/completions'), { method: 'POST', headers: { Authorization: 'Bearer local-fixture' }, body: '{}' })).status, 404)
  console.log('✓ model gateway: three protocols, credentials, model mapping, extensions, streams and immutable active routes')
} finally { gateway.server.closeAllConnections(); gateway.server.close(); upstream.closeAllConnections(); upstream.close() }
