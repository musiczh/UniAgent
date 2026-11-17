import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSourceService } from '../src/main/model-sources/service'
import { sourceDraft, modelSourceConnectionIdentity, preferredSourceEndpoint, modelSourceSupportsAgent, validateModelSource } from '../src/shared/modelSources'
import { manageRevision } from '../src/main/assistant/manageValue'

const directory = await mkdtemp(join(tmpdir(), 'ua-source-connection-'))
process.env.UNIAGENT_USER_DATA = directory
let httpStatus = 200, emptyOutput = false, calls = 0, last: any
const server = createServer(async (req, res) => {
  calls++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
  last = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }
  res.writeHead(httpStatus, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.url?.endsWith('/responses') ? { output: [{ type: 'message', content: emptyOutput ? [] : [{ type: 'output_text', text: 'OK' }] }] } : { content: emptyOutput ? [{ type: 'thinking', thinking: 'reasoning only' }] : [{ type: 'text', text: 'OK' }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as any).port
const service = new ModelSourceService({ directory, agents: () => [] as any[], adapters: {}, gateway: { port, update: async () => port, close: async () => {} } })
try {
  const ark = sourceDraft('ark-coding-plan')
  assert.equal(preferredSourceEndpoint(ark, 'codex')?.protocol, 'openai-responses')
  assert.equal(preferredSourceEndpoint(ark, 'kimi')?.protocol, 'openai-chat')
  assert.ok(ark.endpoints.every(endpoint => endpoint.auth === 'bearer'))
  for (const id of ['codex', 'claude', 'deepseek', 'kimi', 'zcode']) assert.equal(modelSourceSupportsAgent(ark, id), true)
  for (const id of ['qoder', 'mcode']) assert.equal(modelSourceSupportsAgent(ark, id), false)
  assert.equal(modelSourceSupportsAgent(sourceDraft('deepseek'), 'deepseek'), false)
  assert.throws(() => validateModelSource({ ...ark, models: [{ ...ark.models[0], capabilities: { contextWindow: 256001 } }] }), /官方上限 256000/)
  const custom = { ...sourceDraft('custom'), endpoints: [{ id: 'openai-chat', protocol: 'openai-chat' as const, baseUrl: 'https://fixture.example', auth: 'none' as const }], models: [{ id: 'fixture', label: 'Fixture', routes: [{ endpointId: 'openai-chat', upstreamModel: 'fixture' }], maxContextWindow: 1000, capabilities: { contextWindow: 1000 } }] }
  assert.equal(validateModelSource(custom).models[0].maxContextWindow, 1000)
  assert.throws(() => validateModelSource({ ...custom, models: [{ ...custom.models[0], capabilities: { contextWindow: 1001 } }] }), /官方上限 1000/)
  for (const limit of [0, -1, 1.5, 10000001]) assert.throws(() => validateModelSource({ ...custom, models: [{ ...custom.models[0], maxContextWindow: limit }] }), /上限无效/)
  const input = { ...ark, apiKey: 'fixture-credential', endpoints: ark.endpoints.map(endpoint => ({ ...endpoint, baseUrl: `http://127.0.0.1:${port}` })) }
  const catalog = await service.query(input, 'openai-responses')
  assert.equal(calls, 0, 'Coding Plan catalog must not import platform video or dated IDs')
  assert.ok(catalog.some(model => model.id === 'deepseek-v4-pro'))
  const tested = await service.test(input, 'openai-responses', 'ark-code-latest')
  assert.equal(tested.state, 'connected'); assert.equal(last.path, '/responses')
  assert.equal(last.authorization, 'Bearer fixture-credential')
  assert.ok(last.body.max_output_tokens >= 1024)
  assert.ok(!JSON.stringify(tested).includes(input.apiKey))
  const saved = await service.save({ source: input, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'save-tested' })
  let source = saved.sources[0]
  assert.equal(source.connectionTest?.state, 'connected', 'saving a tested draft preserves the actual validation')
  assert.equal(await service.revealCredential(source.id, 'openai-responses', modelSourceConnectionIdentity(source)), input.apiKey)
  await assert.rejects(service.revealCredential(source.id, 'missing', modelSourceConnectionIdentity(source)), /不存在/)
  assert.ok(!JSON.stringify(service.configuration()).includes('connectionTest'))
  assert.ok(!JSON.stringify(saved).includes('signature'))
  assert.ok(!(await readFile(join(directory, 'settings.json'), 'utf8')).includes(input.apiKey))
  const metadata = structuredClone(service.configuration()) as any
  metadata.sources[0].models[0].capabilities.contextWindow = 200000
  await service.updateConfiguration({ sources: metadata.sources }, manageRevision(service.configuration()))
  assert.equal(service.snapshot().sources[0].models[0].capabilities?.contextWindow, 200000)
  assert.equal(service.snapshot().sources[0].connectionTest?.state, 'connected', 'context edits preserve a valid connection proof')
  metadata.sources[0].models[0].routes[0].upstreamModel = 'different-model'
  await service.updateConfiguration({ sources: metadata.sources }, manageRevision(service.configuration()))
  assert.equal(service.snapshot().sources[0].connectionTest, undefined, 'settings route edits invalidate the tested connection')
  source = service.snapshot().sources[0]
  emptyOutput = true
  assert.equal((await service.test(source, 'anthropic-messages', 'ark-code-latest')).state, 'failed', 'thinking-only output cannot prove a successful connection')
  assert.equal(service.snapshot().sources[0].connectionTest?.state, 'failed')
  emptyOutput = false; httpStatus = 401
  assert.match((await service.test(source, 'openai-responses', 'ark-code-latest')).message, /HTTP 401/)
  const changed = await service.save({ source: { ...source, apiKey: 'replacement-key' }, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'rotate-key' })
  assert.equal(changed.sources[0].connectionTest, undefined, 'changing credentials invalidates the prior connection proof')
  const enterpriseDeps = { directory: join(directory, 'enterprise'), agents: () => [] as any[], adapters: {}, gateway: { port, update: async () => port, close: async () => {} }, enterprise: { discover: async () => enterpriseInput, test: async () => '企业模型连接验证通过' } }
  const enterpriseInput = { ...custom, name: 'Trae 企业模型', preset: 'trae' as const, endpoints: [{ id: 'openai-responses', protocol: 'openai-responses' as const, baseUrl: 'https://fixture.example', auth: 'none' as const }], models: [{ ...custom.models[0], routes: [{ endpointId: 'openai-responses', upstreamModel: 'config:model' }] }] }
  const enterpriseService = new ModelSourceService(enterpriseDeps)
  try {
    await enterpriseService.test(enterpriseInput, 'openai-responses', 'fixture')
    const savedEnterprise = await enterpriseService.save({ source: enterpriseInput, bindings: [], expectedRevision: enterpriseService.snapshot().revision, operationId: 'enterprise-save' })
    assert.equal(savedEnterprise.sources[0].connectionTest?.state, 'connected')
    assert.equal(savedEnterprise.sources[0].hasCredential, false, 'enterprise auth uses the native account instead of a copied key')
    const reopened = new ModelSourceService(enterpriseDeps)
    try { await reopened.start(); assert.equal(reopened.snapshot().sources[0].connectionTest?.state, 'connected') } finally { await reopened.close() }
  } finally { await enterpriseService.close() }
  console.log('✓ source connection: actual text output, visible structured result, encrypted reveal, proof invalidation and Ark subscription catalog')
} finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
