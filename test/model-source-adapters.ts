import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQoderSourceAdapter, createKimiSourceAdapter, createDeepSeekSourceAdapter, createMCodeSourceAdapter, zcodeSourceAdapter, codexSourceAdapter, modelSourceCodexArgs, modelSourceClaudeConnection } from '../src/main/model-sources/adapters'
import { sourceDraft } from '../src/shared/modelSources'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import { zcodeRuntimeConfigPath } from '../src/main/zcode/runtime'
import { readZCodeConfiguredModels, resolveZCodeSelection } from '../src/main/zcode/catalog'
import { createClaudeSourceRuntime } from '../src/main/claudeSourceRuntime'
import { kimiWebContract } from '../src/main/kimiWebContract'

const directory = await mkdtemp(join(tmpdir(), 'ua-source-adapters-')); process.env.UNIAGENT_USER_DATA = directory
const source: any = { ...sourceDraft('deepseek'), id: 'fixture-source', revision: 1, hasCredential: true }
source.models[0].capabilities = { contextWindow: 1000000, imageInput: true, efforts: ['low','high'], defaultEffort: 'high' }
source.models[0].routes[0].upstreamModel = 'upstream-config:deepseek-flash'
const binding: any = { sourceId: source.id, agentId: 'qoder', enabled: true, endpointId: 'anthropic-messages', modelIds: ['deepseek-flash'] }
const connection: any = { source, binding, baseUrl: 'http://127.0.0.1:1234/s/fixture-source/e/anthropic-messages', apiKey: 'fixture-local-token', endpoint: source.endpoints[0] }
const agent: any = { id: 'qoder', bin: '/fixture/qoder', installed: true }
try {
  let saved: any, qoderInput: any
  const qoder = createQoderSourceAdapter(async (_bin, operation, value: any) => {
    if (operation === 'byok.list') return saved ? [saved] : []
    if (operation === 'models') return [{ source: 'custom', provider: 'uniagent-fixture-source', model: 'deepseek-flash', value: 'native-qoder-selection' }]
    qoderInput = value; saved = { ...value, apiKey: undefined, models: value.models.map((model: any) => ({ id: model.model, displayName: model.displayName })) }; return {}
  })
  const first = await qoder.apply(source, binding, connection, agent)
  assert.equal(first.nativeModels?.['deepseek-flash'], 'native-qoder-selection')
  assert.equal(qoderInput.models[0].capabilities.vision, true)
  assert.deepEqual(qoderInput.models[0].capabilities.thinking.supportedEffortLevels, ['low','high'])
  assert.equal(qoderInput.models[0].model, 'deepseek-flash', 'native model IDs never contain upstream routing syntax')
  await qoder.apply(source, { ...binding, ...first }, connection, agent)
  saved.baseUrl = 'https://external-edit.example'
  await assert.rejects(qoder.apply(source, { ...binding, ...first }, connection, agent), /conflict/)

  const kimiCalls: any[] = []; let kimiProvider: any
  const kimiModels: any = { external: { model: 'external-model', default_effort: 'low' } }
  let failKimiDefaults = false
  const kimi = createKimiSourceAdapter((async () => ({ transport: { request: async (method: string, path: string, value: any) => {
    if (path === '/api/v1/models') return { items: kimiProvider.models.map((model: any) => ({ ...model, model: `${kimiProvider.id}/${model.model}`, ...kimiModels[`${kimiProvider.id}/${model.model}`] })) }
    if (path === '/api/v1/config') {
      if (failKimiDefaults) throw new Error('fixture defaults failure')
      Object.assign(kimiModels, value.models); return {}
    }
    kimiCalls.push([method, path, value]); if (method === 'GET') return { items: kimiProvider ? [kimiProvider] : [] }
    kimiProvider = { ...value, id: value.id || 'uniagent-fixture-source', models: value.models.map(({ default_effort: _unsupported, ...model }: any) => model) }; return {}
  } }, release: async () => {} })) as any)
  const kimiResult = await kimi.apply(source, { ...binding, agentId: 'kimi' }, connection, agent)
  assert.equal(kimiResult.nativeModels?.['deepseek-flash'], 'uniagent-fixture-source/deepseek-flash')
  assert.ok(!kimiCalls.some(call => call[1].includes('set_default')))
  assert.equal(kimiCalls.find(call => call[0] === 'POST')[2].models[0].max_context_size, 1000000)
  assert.equal(kimiCalls.find(call => call[0] === 'POST')[2].type, 'anthropic')

  let profile: any; const deepseekCalls: any[] = []
  const deepseek = createDeepSeekSourceAdapter((async () => ({ call: async (method: string, params: any) => {
    deepseekCalls.push([method, params])
    if (method === 'settings/describe') return { writable: true, namespaces: [{ ns: 'uniagent-deepseek-model-sources', revision: 3, value: { providers: profile ? { 'uniagent-fixture-source': profile } : {} } }] }
    if (method === 'settings/mutate') { profile = params.ops[0].value; return { value: { providers: { 'uniagent-fixture-source': profile } } } }
    if (method === 'session/modelCatalog') return { groups: [{ id: 'uniagent-fixture-source', models: [{ id: 'deepseek-flash' }] }] }
  } })) as any)
  const deepseekResult = await deepseek.apply(source, { ...binding, agentId: 'deepseek' }, connection, agent)
  assert.deepEqual(JSON.parse(deepseekResult.nativeModels!['deepseek-flash']), ['uniagent-fixture-source','deepseek-flash'])
  assert.equal(profile.baseURL, connection.baseUrl)
  assert.deepEqual(profile.models[0].inputModalities, ['text', 'image'])
  assert.equal(deepseekCalls.find(call => call[0] === 'settings/mutate')[1].expectedRevision, 3)
  assert.equal(deepseekCalls.find(call => call[0] === 'credentials/set')[1].value, connection.apiKey)
  const ark: any = { ...sourceDraft('ark-coding-plan'), id: source.id, revision: 1, hasCredential: true }
  const thinkingBinding = { ...binding, ...kimiResult, agentId: 'kimi', endpointId: 'openai-chat', modelIds: ['kimi-k3.1-pro'] }
  let thinkingResult = await kimi.apply(ark, thinkingBinding, { ...connection, endpoint: ark.endpoints.find((endpoint: any) => endpoint.id === 'openai-chat') }, agent)
  const thinking = { ...kimiProvider.models[0], ...kimiModels['uniagent-fixture-source/kimi-k3.1-pro'] }
  assert.deepEqual(thinking.support_efforts, ['low', 'high', 'max'])
  assert.equal(thinking.default_effort, 'max')
  assert.ok(thinking.capabilities.includes('thinking') && thinking.capabilities.includes('always_thinking'))
  const thinkingContract = kimiWebContract([{ ...thinking, model: 'native-k3' }], { model: 'native-k3' })
  assert.deepEqual(thinkingContract.models[0].thinkingOptions, ['low', 'high', 'max'])
  assert.equal(thinkingContract.models[0].defaultThinking, 'max')
  assert.ok(!thinkingContract.models[0].thinkingOptions?.includes('off'), 'always-thinking models cannot expose an off option')
  for (const [efforts, defaultEffort] of [
    [['low', 'medium', 'high', 'xhigh'], 'medium'],
    [['low', 'medium', 'high', 'max'], 'max'],
    [['low', 'medium', 'high'], 'high']
  ] as const) {
    const trae = { ...source, preset: 'trae', models: [{ ...source.models[0], capabilities: { contextWindow: 475000, efforts: [...efforts], defaultEffort } }] }
    thinkingResult = await kimi.apply(trae, { ...binding, ...thinkingResult, agentId: 'kimi' }, connection, agent)
    const model = { ...kimiProvider.models[0], ...kimiModels['uniagent-fixture-source/deepseek-flash'] }
    assert.deepEqual(model.support_efforts, efforts, 'saved Trae sources with only efforts expose the exact native Kimi levels')
    assert.equal(model.adaptive_thinking, true, 'Anthropic requests must carry an effort rather than only a token budget')
    assert.equal(model.default_effort, defaultEffort, 'Provider creation strips default_effort; the config API must persist it')
    const contract = kimiWebContract([{ ...model, model: 'native-trae' }], { model: 'native-trae' })
    assert.deepEqual(contract.models[0].thinkingOptions, efforts)
    assert.equal(contract.models[0].defaultThinking, defaultEffort)
    assert.deepEqual(thinkingResult.models?.[0].thinkingOptions, efforts, 'adapter returns the read-back model catalog to the application')
    assert.equal(thinkingResult.models?.[0].defaultThinking, defaultEffort)
  }
  assert.deepEqual(kimiModels.external, { model: 'external-model', default_effort: 'low' }, 'per-model defaults preserve external models')
  const traeWithoutThinking = { ...source, preset: 'trae', models: [{ ...source.models[0], capabilities: { contextWindow: 475000, efforts: [] } }] }
  thinkingResult = await kimi.apply(traeWithoutThinking, { ...binding, ...thinkingResult, agentId: 'kimi' }, connection, agent)
  assert.ok(!kimiProvider.models[0].capabilities.includes('thinking'))
  assert.equal(kimiProvider.models[0].support_efforts, undefined, 'models without effort metadata get no invented levels')
  const traeOverride = { ...source, preset: 'trae', models: [{ ...source.models[0], capabilities: { contextWindow: 475000, efforts: ['low', 'high'], thinkingOptions: ['high'], defaultEffort: 'low' } }] }
  thinkingResult = await kimi.apply(traeOverride, { ...binding, ...thinkingResult, agentId: 'kimi' }, connection, agent)
  assert.deepEqual(kimiProvider.models[0].support_efforts, ['high'], 'explicit thinking options take priority')
  assert.equal(kimiProvider.models[0].default_effort, undefined, 'defaults outside the exposed levels are not sent')
  failKimiDefaults = true
  let partial: any
  await assert.rejects(kimi.apply({ ...traeOverride, models: source.models }, { ...binding, ...thinkingResult, agentId: 'kimi' }, connection, agent), error => {
    partial = (error as any).evidence
    return /defaults failure/.test(String(error)) && !!partial?.managedHash
  })
  failKimiDefaults = false
  await kimi.apply({ ...traeOverride, models: source.models }, { ...binding, ...partial, agentId: 'kimi' }, connection, agent)
  const profiles: any[] = []
  const multiProvider = createDeepSeekSourceAdapter((async () => ({ call: async (method: string, params: any) => {
    if (method === 'settings/describe') return { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }] }
    if (method === 'settings/mutate') { profiles.push(params.ops[0].value); return { value: { providers: { 'uniagent-fixture-source': params.ops[0].value } } } }
    if (method === 'session/modelCatalog') return { groups: [{ id: 'uniagent-fixture-source', models: profiles.at(-1).models }] }
  } })) as any)
  for (const protocol of ['openai-responses', 'anthropic-messages']) {
    const endpoint = ark.endpoints.find((endpoint: any) => endpoint.protocol === protocol)
    await multiProvider.apply(ark, { ...binding, agentId: 'deepseek', endpointId: endpoint.id, modelIds: ['ark-code-latest'] }, { ...connection, source: ark, endpoint }, agent)
    assert.equal(profiles.at(-1).baseURL, connection.baseUrl, 'the native Anthropic SDK appends /v1; the adapter must not duplicate it')
    assert.equal(profiles.at(-1).api, protocol)
  }
  for (const protocol of ['openai-responses', 'anthropic-messages']) {
    const trae = { ...source, preset: 'trae' }
    const endpoint = { ...connection.endpoint, protocol }
    await multiProvider.apply(trae, { ...binding, agentId: 'deepseek', modelIds: ['deepseek-flash'] }, { ...connection, source: trae, endpoint }, agent)
    assert.deepEqual(profiles.at(-1).models[0].reasoningEfforts, { low: 'low', high: 'high' }, 'Harness native profiles must offer the source levels and their exact wire values')
    assert.equal(profiles.at(-1).reasoning, undefined, 'models must not share a Provider-level default')
    assert.equal(profiles.at(-1).models[0].compat?.forceAdaptiveThinking, protocol === 'anthropic-messages' ? true : undefined)
  }
  await multiProvider.apply(ark, { ...binding, agentId: 'deepseek', modelIds: ['deepseek-v4.1-flash', 'glm-5.3'] }, { ...connection, source: ark, endpoint: ark.endpoints.find((endpoint: any) => endpoint.protocol === 'openai-responses') }, agent)
  for (const model of profiles.at(-1).models) assert.deepEqual(model.reasoningEfforts, { low: 'low', high: 'high', max: 'max' }, 'Ark models advertise their effective levels to Harness')
  const glmConnection = { ...connection, source: ark, endpoint: ark.endpoints[0] }
  const glmConfig = { agentId: 'claude', workdir: directory, model: codexModelKey('glm-5.3', { kind: 'third-party', sourceId: ark.id }) }
  const glmRuntime = await createClaudeSourceRuntime(modelSourceClaudeConnection(glmConnection, glmConfig))
  assert.deepEqual(JSON.parse(glmRuntime.env.CLAUDE_CODE_EXTRA_BODY!), { thinking: { type: 'enabled', budget_tokens: 10000 } }, 'Ark GLM requires enabled thinking, not adaptive or disabled')
  await glmRuntime.dispose()

  let minimaxProvider: any; let minimaxArgs: string[] = []
  const mcode = createMCodeSourceAdapter((async (_bin: string, args: string[]) => {
    if (args[1] === 'list') return { stdout: JSON.stringify({ providers: minimaxProvider ? [minimaxProvider] : [] }) }
    minimaxArgs = args; minimaxProvider = { providerId: 'custom_provider:provider-fixture', name: args[args.indexOf('--name') + 1] }; return { stdout: '' }
  }) as any)
  const minimax = await mcode.apply(source, { ...binding, agentId: 'mcode' }, connection, agent)
  assert.equal(minimax.nativeModels?.['deepseek-flash'], 'm:custom_provider%3Aprovider-fixture:deepseek-flash:u')
  await mcode.apply(source, { ...binding, agentId: 'mcode', ...minimax }, connection, agent)
  assert.equal(minimaxArgs[minimaxArgs.indexOf('--model') + 1], 'deepseek-flash')
  assert.ok(minimaxArgs.includes('--support-image')); assert.equal(minimaxArgs[minimaxArgs.indexOf('--context-limit') + 1], '1000000')
  assert.ok(!minimaxArgs.includes('--use') && !minimaxArgs.includes(connection.apiKey))

  const providerFile = join(directory, 'zcode-provider.json'); await writeFile(providerFile, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'external', config: { preserved: true } }] }, defaultModelSelection: { providerId: 'external', modelId: 'original' } } }))
  const runtimeFile = zcodeRuntimeConfigPath(); await mkdir(join(runtimeFile, '..'), { recursive: true }); await writeFile(runtimeFile, JSON.stringify({ personalProviderConfigPath: providerFile }))
  const zcode = await zcodeSourceAdapter.apply(source, { ...binding, agentId: 'zcode' }, connection, agent)
  assert.match(zcode.nativeModels!['deepseek-flash'], /^zcode:/)
  const document = JSON.parse(await readFile(providerFile, 'utf8'))
  assert.equal(document.config.providerConfigRules.providerRules[0].providerId, 'external')
  assert.equal(document.config.providerConfigRules.providerRules[1].config.api.type, 'anthropic-messages')
  assert.equal(document.config.defaultModelSelection.modelId, 'original')
  assert.equal(document.config.modelConfigRules?.providerModelRules[0].config.properties.contextWindow, 1000000, 'ZCode must use the configured context limit in its native per-model rules')
  const nativeCatalog = await readZCodeConfiguredModels(providerFile, undefined, { providerId: 'external', modelId: 'original' })
  assert.equal(nativeCatalog.find(model => model.id === zcode.nativeModels!['deepseek-flash'])?.contextWindow, 1000000)
  await zcodeSourceAdapter.apply(source, { ...binding, agentId: 'zcode', ...zcode }, connection, agent)
  const legacyHash = createHash('sha256').update(JSON.stringify({ provider: document.config.providerConfigRules.providerRules[1], models: document.config.modelConfigRules.providerModelRules })).digest('hex')
  // The native engine serializes ModelRule fields before the provider selector.
  document.config.modelConfigRules.providerModelRules = document.config.modelConfigRules.providerModelRules.map(({ providerId, modelId, config }: any) => ({ modelId, config, providerId }))
  await writeFile(providerFile, JSON.stringify(document))
  let zcodeMapped = await zcodeSourceAdapter.apply(source, { ...binding, agentId: 'zcode', ...zcode, managedHash: legacyHash }, connection, agent)
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value
  await writeFile(providerFile, JSON.stringify(reorder(JSON.parse(await readFile(providerFile, 'utf8')))))
  zcodeMapped = await zcodeSourceAdapter.apply(source, { ...binding, agentId: 'zcode', ...zcodeMapped }, connection, agent)
  for (const [efforts, defaultEffort] of [ [['low','medium','high','xhigh'], 'medium'], [['low','medium','high','max'], 'max'] ] as const) {
    const trae = { ...source, preset: 'trae', models: [{ ...source.models[0], capabilities: { ...source.models[0].capabilities, efforts: [...efforts], defaultEffort } }] }
    zcodeMapped = await zcodeSourceAdapter.apply(trae, { ...binding, agentId: 'zcode', ...zcodeMapped }, connection, agent)
    const saved = JSON.parse(await readFile(providerFile, 'utf8'))
    const options = saved.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel
    assert.deepEqual(options.values, efforts)
    const native = (await readZCodeConfiguredModels(providerFile, undefined, { providerId: 'external', modelId: 'original' })).find(model => model.id === zcodeMapped.nativeModels!['deepseek-flash'])!
    assert.deepEqual(native.thinkingOptions, efforts)
    assert.deepEqual(zcodeMapped.models?.find(model => model.id === native.id)?.thinkingOptions, efforts)
    for (const level of efforts) assert.equal(resolveZCodeSelection({ model: native.id, effort: level }, [native], native.zcodeSelection!).options?.reasoningLevel, level)
    const dispatch = Function('reasoningLevel', 'return (' + options.map + ')')
    assert.deepEqual(dispatch(defaultEffort), { thinking: { type: 'adaptive' }, output_config: { effort: defaultEffort } }, 'ZCode uses the native map expression to encode Anthropic effort')
    assert.equal(saved.config.defaultModelSelection.modelId, 'original', 'source mapping must preserve the global model')
  }
  const arkZCode = await zcodeSourceAdapter.apply(ark, { ...binding, ...zcodeMapped, agentId: 'zcode', modelIds: ['glm-5.3', 'deepseek-v4.1-flash'] }, glmConnection, agent)
  for (const model of arkZCode.models!.filter(model => Object.values(arkZCode.nativeModels!).includes(model.id))) assert.deepEqual(model.thinkingOptions, ['low', 'high', 'max'])
  const arkRules = JSON.parse(await readFile(providerFile, 'utf8')).config.modelConfigRules.providerModelRules
  for (const rule of arkRules) {
    const options = rule.config.optionSpecs.reasoningLevel
    assert.deepEqual(Function('reasoningLevel', 'return (' + options.map + ')')('low'), { thinking: { type: 'enabled', budget_tokens: 10000 }, output_config: { effort: 'low' } }, 'Ark requires enabled thinking with the selected effort')
  }
  zcodeMapped = arkZCode
  const currentDocument = JSON.parse(await readFile(providerFile, 'utf8'))
  const changedCredential = structuredClone(currentDocument)
  changedCredential.config.providerConfigRules.providerRules.find((rule: any) => rule.providerId === 'personal:uniagent-' + source.id).config.access.apiKey = 'external-test-key'
  await writeFile(providerFile, JSON.stringify(changedCredential))
  await assert.rejects(zcodeSourceAdapter.apply(ark, { ...binding, agentId: 'zcode', ...zcodeMapped }, glmConnection, agent), /conflict/)
  assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), changedCredential, 'an external credential edit must remain untouched')
  currentDocument.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = ['high']
  await writeFile(providerFile, JSON.stringify(currentDocument))
  await assert.rejects(zcodeSourceAdapter.apply({ ...source, preset: 'trae' }, { ...binding, agentId: 'zcode', ...zcodeMapped }, connection, agent), /conflict/)

  await codexSourceAdapter.apply(source, { ...binding, agentId: 'codex', endpointId: 'openai-responses' }, connection, agent)
  const config = { agentId: 'codex', workdir: directory, model: codexModelKey('deepseek-flash', { kind: 'third-party', sourceId: source.id }) }
  const args = modelSourceCodexArgs(connection, config)
  assert.ok(!JSON.stringify(args).includes(connection.apiKey), 'local access token must not be an argv value')
  assert.ok(modelSourceCodexArgs({ ...connection, source: { ...source, preset: 'trae' } }, config).includes('web_search="disabled"'), 'Trae uses function tools and cannot receive Codex native web_search')
  const claude = modelSourceClaudeConnection(connection, { ...config, agentId: 'claude' })
  assert.equal(claude.authToken, true); assert.deepEqual(claude.efforts, ['low','high','max'])
  console.log('✓ source adapters: native payloads and identities, capability fields, conflict checks and preserved defaults')
} finally { await rm(directory, { recursive: true, force: true }) }
