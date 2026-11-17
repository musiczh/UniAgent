import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceDraft, modelSourceConnectionIdentity, validateModelSource } from '../src/shared/modelSources'
import { ModelSourceService } from '../src/main/model-sources/service'
import { manageRevision } from '../src/main/assistant/manageValue'

const directory = await mkdtemp(join(tmpdir(), 'ua-source-plans-'))
process.env.UNIAGENT_USER_DATA = directory
const calls: any[] = [], routes: any[] = []
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
  calls.push({ path: req.url, authorization: req.headers.authorization })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], content: [{ type: 'text', text: 'OK' }], choices: [{ message: { content: 'OK' } }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as any).port
const agents = ['codex','claude','deepseek','kimi','zcode'].map(id => ({ id, installed: true })) as any
const adapters = Object.fromEntries(agents.map(agent => [agent.id, { apply: async (source: any, binding: any) => ({ nativeModels: Object.fromEntries(binding.modelIds.map(id => [id, `native-${source.id}-${id}`])) }) }]))
const service = new ModelSourceService({ directory, agents: () => agents, adapters, gateway: { port, update: async state => { routes.splice(0, routes.length, ...state.routes); return port }, close: async () => {} } })
try {
  await service.start()
  const coding = sourceDraft('ark-coding-plan'), agent = sourceDraft('ark-coding-plan', 'agent')
  assert.equal(agent.plan, 'agent', 'Agent Plan must not silently fall back to Coding Plan')
  assert.equal(coding.plan, 'coding')
  for (const [draft, path] of [[coding, 'coding'], [agent, 'plan']] as const) {
    for (const endpoint of draft.endpoints) assert.equal(endpoint.baseUrl, `https://ark.cn-beijing.volces.com/api/${path}${endpoint.protocol === 'anthropic-messages' ? '' : '/v3'}`)
  }
  assert.throws(() => sourceDraft('ark-coding-plan', 'missing'), /套餐/)
  assert.throws(() => validateModelSource({ ...coding, plan: 'missing' }), /套餐/)
  assert.equal(validateModelSource({ ...coding, plan: undefined }).plan, 'coding', 'older sources default to Coding Plan')
  assert.throws(() => validateModelSource({ ...coding, plan: 'agent' }), /套餐.*地址|地址.*套餐/)
  assert.throws(() => validateModelSource({ ...agent, endpoints: [coding.endpoints[0], ...agent.endpoints.slice(1)] }), /套餐.*地址|地址.*套餐/)
  const fixture = (draft: typeof coding, key: string) => ({ ...draft, apiKey: key, models: draft.models.slice(0, 1), endpoints: draft.endpoints.map(endpoint => ({ ...endpoint, baseUrl: `http://127.0.0.1:${port}/${draft.plan}${endpoint.protocol === 'anthropic-messages' ? '' : '/v3'}` })) })
  const bindingInputs = draft => agents.map(agent => ({ agentId: agent.id, enabled: true, endpointId: agent.id === 'codex' || agent.id === 'deepseek' ? 'openai-responses' : agent.id === 'kimi' ? 'openai-chat' : 'anthropic-messages', modelIds: [draft.models[0].id] }))
  const cp = fixture(coding, 'fixture-coding-key'), ap = fixture(agent, 'fixture-agent-key')
  await service.test(cp, 'openai-responses', 'ark-code-latest')
  let savedCP = (await service.save({ source: cp, bindings: bindingInputs(cp), expectedRevision: service.snapshot().revision, operationId: 'save-coding' })).sources[0]
  const codingStore = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  savedCP = (await service.save({ source: { ...savedCP, plan: undefined }, bindings: bindingInputs(cp), expectedRevision: service.snapshot().revision, operationId: 'save-legacy-coding' })).sources[0]
  const legacyStore = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  assert.equal(legacyStore.sources[0].encryptedKey, codingStore.sources[0].encryptedKey)
  assert.equal(legacyStore.sources[0].runtimeRevision, codingStore.sources[0].runtimeRevision)
  assert.equal(legacyStore.sources[0].verification.signature, codingStore.sources[0].verification.signature, 'Coding Plan validation is retained for legacy defaults')
  assert.equal(await service.revealCredential(savedCP.id, 'openai-responses', modelSourceConnectionIdentity(savedCP)), cp.apiKey)
  const before = service.snapshot(), switched = { ...savedCP, plan: 'agent' }
  await assert.rejects(service.revealCredential(savedCP.id, 'openai-responses', modelSourceConnectionIdentity(switched)), /连接信息已变化/)
  await assert.rejects(service.test(switched, 'openai-responses', 'ark-code-latest'), /API Key/)
  await assert.rejects(service.save({ source: switched, bindings: bindingInputs(cp), expectedRevision: before.revision, operationId: 'switch-no-key' }), /API Key/)
  const changes = structuredClone(service.configuration()) as any; changes.sources[0].plan = 'agent'
  await assert.rejects(service.updateConfiguration(changes, manageRevision(service.configuration())), /凭据/)
  assert.equal(service.snapshot().revision, before.revision, 'a rejected plan switch preserves the saved source')
  assert.equal(service.snapshot().sources[0].connectionTest?.state, 'connected')
  await service.test(ap, 'openai-responses', 'ark-code-latest')
  const savedAP = (await service.save({ source: ap, bindings: bindingInputs(ap), expectedRevision: service.snapshot().revision, operationId: 'save-agent' })).sources.find(source => source.plan === 'agent')!
  assert.notEqual(savedAP.id, savedCP.id)
  const codingRoutes = routes.filter(route => route.id.startsWith(savedCP.id + '/')), agentRoutes = routes.filter(route => route.id.startsWith(savedAP.id + '/'))
  assert.equal(codingRoutes.length, 5)
  assert.equal(agentRoutes.length, 5)
  assert.ok(codingRoutes.every(route => route.apiKey === cp.apiKey && route.endpoint.baseUrl.includes('/coding')))
  assert.ok(agentRoutes.every(route => route.apiKey === ap.apiKey && route.endpoint.baseUrl.includes('/agent')))
  assert.equal(new Set(routes.map(route => route.token)).size, 10, 'local credentials are scoped to each source and Agent')
  assert.equal(service.mergeModels('codex', []).find(model => model.modelSource?.sourceId === savedCP.id)?.label, '方舟 CP · ark-code-latest')
  assert.equal(service.mergeModels('codex', []).find(model => model.modelSource?.sourceId === savedAP.id)?.label, '方舟 AP · ark-code-latest')
  assert.equal(calls[0].authorization, 'Bearer fixture-coding-key')
  assert.equal(calls[1].authorization, 'Bearer fixture-agent-key')
  assert.ok(!JSON.stringify(service.snapshot()).includes(cp.apiKey) && !JSON.stringify(service.snapshot()).includes(ap.apiKey))
  assert.ok(!(await readFile(join(directory, 'settings.json'), 'utf8')).includes(cp.apiKey))
  const changedWithKey = (await service.save({ source: { ...savedCP, plan: 'agent', apiKey: cp.apiKey }, bindings: bindingInputs(cp), expectedRevision: service.snapshot().revision, operationId: 'switch-with-key' })).sources.find(source => source.id === savedCP.id)!
  assert.equal(changedWithKey.connectionTest, undefined, 'validation from the previous plan must not transfer even if an entered fixture key and URL happen to match')
  console.log('✓ Ark plans: dedicated endpoints, legacy defaults, independent keys/routes, plan-switch rejection and scoped validation')
} finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
