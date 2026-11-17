import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexModelSources } from '../src/main/codexModelSources'
import { CodexSourceService } from '../src/main/codexSourceService'
import { CodexFerrySource } from '../src/main/codexFerrySource'
import { BUILTIN_AGENTS, configureCodexModelsProvider, loadCodexModels } from '../src/main/agents'
import { codexProviderChanged, codexSessionProvider, codexWireModel } from '../src/shared/codexModelIdentity'
import { AppServerRunner, configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import type { AppServerRpc } from '../src/main/appServerTransport'
import type { AgentDef, ModelDef, SessionConfig } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'ua-codex-ferry-'))
const previous = { data: process.env.UNIAGENT_USER_DATA, ferry: process.env.FERRY_HOME, codex: process.env.CODEX_HOME }
process.env.UNIAGENT_USER_DATA = join(directory, 'data')
process.env.FERRY_HOME = join(directory, 'ferry')
process.env.CODEX_HOME = join(directory, 'codex')
const ferryKey = 'uniagent-model:third-party:ferry:ferry-gpt-6-1-sol'
const ferryMaxKey = 'uniagent-model:third-party:ferry:ferry-gpt-6-1-sol-max'
const sourceRef = { kind: 'third-party' as const, sourceId: 'ferry' }
const config: SessionConfig = { agentId: 'codex', model: ferryKey, workdir: directory, permissionMode: 'approve-for-me', effort: 'high' }
const native: ModelDef = { id: 'gpt-native', label: 'Native', efforts: ['medium'], supportsFast: true }
const third: ModelDef = { id: 'uniagent-model:third-party:mimo:mimo-v2.6-pro', label: 'MiMo', efforts: [], modelSource: { kind: 'third-party', sourceId: 'mimo' } }
const entry = { slug: 'ferry-gpt-6-1-sol', display_name: 'Ferry GPT-6.1-Sol', visibility: 'list', context_window: 475000,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high', input_modalities: ['text', 'image'] }
let catalog: unknown = { models: [entry, { ...entry, slug: 'ferry-gpt-6-1-sol-max', display_name: 'Ferry GPT-6.1-Sol Max 1M', context_window: 922000, supported_reasoning_levels: [] },
  { ...entry, slug: 'ferry-hidden', visibility: 'hide' }, { ...entry, slug: 'gpt-foreign' }] }
let status = 200
const requests: { path?: string; auth?: string; ua?: string }[] = []
const server = createServer((request, response) => {
  requests.push({ path: request.url, auth: request.headers.authorization, ua: request.headers['user-agent'] })
  // Ferry serves Claude's `data` shape unless this is explicitly a Codex client.
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(request.headers['user-agent']?.toLowerCase().includes('codex') ? catalog : { data: [{ id: 'claude-gpt-6-1-sol' }] }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = (server.address() as { port: number }).port
const service = new CodexSourceService()
service.supplementalModels = () => [third]
service.sourceRefsFor = id => id === 'mimo-v2.6-pro' ? [{ kind: 'third-party', sourceId: 'mimo' }] : []
service.assertModelReady = () => {}
service.runtimeArgs = () => ['-c', 'model_provider="uniagent-mimo"']
const sources = new CodexModelSources(service)
const refresh = (models: ModelDef[]) => sources.refreshModels(models)
const runtime = (selection: SessionConfig) => Object.fromEntries(sources.runtimeArgs(selection).filter(arg => arg !== '-c').map(arg => {
  const separator = arg.indexOf('=')
  return [arg.slice(0, separator), JSON.parse(arg.slice(separator + 1))]
}))
try {
  await mkdir(process.env.FERRY_HOME!, { recursive: true })
  await mkdir(process.env.CODEX_HOME!, { recursive: true })
  const nativeFile = join(process.env.CODEX_HOME!, 'config.toml')
  const nativeText = '# preserve native provider and choices\nmodel="gpt-native"\n'
  await writeFile(nativeFile, nativeText)
  assert.deepEqual((await refresh([native])).map(model => model.id), [native.id, third.id])
  assert.deepEqual(requests, [], 'Ferry 未运行时不能探测固定端口或启动网关')
  assert.throws(() => sources.runtimeArgs({ ...config, model: 'ferry-gpt-6-1-sol', modelSource: { kind: 'native' } }), /Ferry/, '首次发现失败也不能将旧选择发到原生连接')

  await writeFile(join(process.env.FERRY_HOME!, 'runtime.json'), JSON.stringify({ port, token: 'control-secret-must-not-be-forwarded' }))
  const models = await refresh([native])
  assert.deepEqual(models.map(model => model.id), [native.id, third.id, ferryKey, ferryMaxKey], '原生目录没有 Ferry 时，仍应发现其运行目录')
  assert.ok(requests.every(request => request.path === '/v1/models' && request.auth === 'Bearer ferry' && request.ua?.toLowerCase().includes('codex')))
  assert.deepEqual(models[2].modelSource, sourceRef)
  assert.equal(models[2].label, 'Ferry GPT-6.1-Sol')
  assert.deepEqual(models[2].efforts, ['low', 'high'])
  assert.equal(models[2].defaultEffort, 'high')
  assert.equal(models[2].contextWindow, 475000)
  assert.equal(models[2].imageInput, true)
  assert.deepEqual(models[3].efforts, [])
  assert.equal(models[3].contextWindow, 922000)
  assert.equal(models[3].supportsMax, false, 'Max 是独立模型，不能制造第二次 Max 切换')
  const cli = join(directory, 'fake-codex')
  await writeFile(cli, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.method==='initialize') process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
  if(message.method==='model/list') process.stdout.write(JSON.stringify({id:message.id,result:{data:[{id:'gpt-native',model:'gpt-native',displayName:'Native',supportedReasoningEfforts:[]}],nextCursor:null}})+'\\n');
});
`)
  await chmod(cli, 0o755)
  configureCodexModelsProvider(refresh)
  assert.deepEqual((await loadCodexModels(cli)).map(model => model.id), [native.id, third.id, ferryKey, ferryMaxKey], '实际目录加载入口必须等待 Ferry 补充目录')
  assert.deepEqual(sources.normalize(config).modelSource, sourceRef)
  assert.equal(codexWireModel(config), 'ferry-gpt-6-1-sol')
  assert.equal(codexSessionProvider(sourceRef), 'uniagent-ferry')
  assert.equal(codexProviderChanged({ ...config, model: native.id, modelSource: { kind: 'native' } }, config), true)
  assert.throws(() => sources.normalize({ ...config, modelSource: { kind: 'native' } }), /不匹配/)

  const args = runtime(config)
  assert.equal(args.model_provider, 'uniagent-ferry')
  assert.equal(args.model, 'ferry-gpt-6-1-sol')
  assert.equal(args.review_model, 'ferry-gpt-6-1-sol', 'Ferry 保留自动审批模型能力')
  assert.equal(args['model_providers.uniagent-ferry.base_url'], `http://127.0.0.1:${port}/v1`)
  assert.equal(args['model_providers.uniagent-ferry.wire_api'], 'responses')
  assert.equal(args['model_providers.uniagent-ferry.requires_openai_auth'], false)
  assert.equal(args['model_providers.uniagent-ferry.experimental_bearer_token'], 'ferry')
  assert.equal(args['model_providers.uniagent-ferry.supports_websockets'], false)
  assert.equal(args['model_providers.uniagent-ferry.http_headers.x-openai-actor-authorization'], 'ferry')
  assert.deepEqual(runtime({ ...config, model: native.id, modelSource: undefined }), {})
  assert.deepEqual(runtime({ ...config, model: third.id, permissionMode: 'ask' }), { model_provider: 'uniagent-mimo' })
  assert.equal(await readFile(nativeFile, 'utf8'), nativeText, '不能改写用户的全局原生配置')
  const saved = JSON.parse(await readFile(args.model_catalog_json, 'utf8'))
  assert.deepEqual(saved.models.map((model: any) => model.slug), ['ferry-gpt-6-1-sol', 'ferry-gpt-6-1-sol-max'])
  assert.ok(!JSON.stringify(args).includes('control-secret'))
  const concurrent = Array.from({ length: 8 }, () => new CodexFerrySource())
  await Promise.all(concurrent.map(source => source.refresh()))
  assert.ok(concurrent.every(source => source.models.length === 2), '共享应用目录的并发发现不能竞争同一个临时目录文件')

  class FixtureRpc extends EventEmitter implements AppServerRpc {
    requests: { method: string; params: any }[] = []
    async start() {}
    notify() {}
    respond() {}
    interrupt() {}
    async dispose() {}
    async request<T>(method: string, params: any): Promise<T> {
      this.requests.push({ method, params })
      if (method === 'config/read') return { config: { model_provider: 'user-native-provider' } } as T
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'ferry-thread' }, model: params.model, modelProvider: params.modelProvider } as T
      if (method === 'thread/goal/get') return { goal: null } as T
      return {} as T
    }
  }
  configureCodexAppServerArgsProvider(value => sources.runtimeArgs(value))
  const agent = { ...BUILTIN_AGENTS.find(agent => agent.id === 'codex')!, bin: cli, models } as AgentDef
  for (const nativeThread of [undefined, 'saved-ferry-thread']) {
    const rpc = new FixtureRpc()
    const runner = new AppServerRunner('ferry-routing', { n: 0 }, agent, config, nativeThread, undefined, () => rpc)
    try {
      await runner.ensureThreadReady()
      const operation = rpc.requests.find(request => request.method === (nativeThread ? 'thread/resume' : 'thread/start'))!
      assert.equal(operation.params.model, 'ferry-gpt-6-1-sol')
      assert.equal(operation.params.modelProvider, 'uniagent-ferry', '线程创建和恢复不能继承另一个原生 Provider')
      assert.equal(operation.params.config['model_providers.uniagent-ferry.base_url'], `http://127.0.0.1:${port}/v1`)
    } finally { await runner.dispose() }
  }

  const legacy = sources.normalize({ ...config, model: 'ferry-gpt-6-1-sol', modelSource: { kind: 'native' } })
  assert.equal(legacy.model, ferryKey, '历史 native Ferry 选择迁移到明确的会话来源')
  assert.equal(runtime(legacy).model_provider, 'uniagent-ferry')
  assert.equal((await refresh([native, { ...native, id: 'ferry-gpt-6-1-sol' }])).filter(model => codexWireModel({ model: model.id }) === 'ferry-gpt-6-1-sol').length, 1)

  status = 503
  await refresh([native])
  assert.throws(() => sources.runtimeArgs(config), /Ferry/, 'Ferry 失败不能回退到原生或其它第三方')
  assert.deepEqual(runtime({ ...config, model: native.id, modelSource: undefined }), {})
  status = 200
  catalog = { models: [{ ...entry, supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }, entry] }
  const recovered = await refresh([native])
  assert.equal(recovered.filter(model => model.modelSource?.sourceId === 'ferry').length, 1, '重复目录项不能造成重复菜单')
  assert.notEqual(runtime(config).model_catalog_json, args.model_catalog_json, '刷新后的目录不能覆盖运行中会话使用的快照')
  assert.deepEqual(JSON.parse(await readFile(args.model_catalog_json, 'utf8')).models.map((model: any) => model.slug), ['ferry-gpt-6-1-sol', 'ferry-gpt-6-1-sol-max'])
  assert.throws(() => sources.runtimeArgs({ ...config, model: ferryMaxKey }), /Ferry/, '目录已移除的模型不能继续发送')
  assert.throws(() => sources.runtimeArgs({ ...config, model: 'ferry-gpt-6-1-sol-max', modelSource: { kind: 'native' } }), /Ferry/, '已移除的旧 native Ferry 选择不能继续发送')
  catalog = { data: [] }
  await refresh([native])
  assert.throws(() => sources.runtimeArgs(config), /Ferry/, '错误的 Claude 目录不能用于 Codex')
  for (const invalid of [0, 65536, '8790']) {
    await writeFile(join(process.env.FERRY_HOME!, 'runtime.json'), JSON.stringify({ port: invalid }))
    await refresh([native])
    assert.throws(() => sources.runtimeArgs(config), /Ferry/)
  }
  assert.equal(await readFile(nativeFile, 'utf8'), nativeText)
  console.log('PASS Codex Ferry discovery, capabilities, session routing, legacy migration, failure isolation and refresh')
} finally {
  configureCodexModelsProvider(undefined)
  configureCodexAppServerArgsProvider(undefined)
  await service.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const [name, value] of Object.entries({ UNIAGENT_USER_DATA: previous.data, FERRY_HOME: previous.ferry, CODEX_HOME: previous.codex })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  await rm(directory, { recursive: true, force: true })
}
