import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from '../userData'
import { codexSourceCatalogModel } from '../codexSourceService'
import { CODEX_SOURCE_PRESETS, type CodexSourcePreset } from '../../shared/codexSources'
import { claudeSourceEffort, type ClaudeSourcePreset } from '../../shared/claudeSources'
import { parseCodexModelKey } from '../../shared/codexModelIdentity'
import type { SessionConfig } from '../../shared/types'
import { qoderOperation } from '../qoderSdk'
import { acquireKimiWebService } from '../kimiWebService'
import { kimiWebContract } from '../kimiWebContract'
import { deepseekHostModels } from '../deepseekHostContract'
import { getDeepSeekHost, enableDeepSeekModelSources } from '../deepseekService'
import { zcodeRuntimeConfigPath } from '../zcode/runtime'
import { readZCodeConfiguredModels, zcodeModelKey } from '../zcode/catalog'
import { zcodePayloadHash } from '../zcode/store'
import type { ModelSource, ModelSourceInput, AgentSourceBinding } from '../../shared/modelSources'
import type { SourceAdapter, SourceConnection } from './service'
import { ModelSourceApplyError } from './service'
import { parseMCodeModelValue } from '../../shared/mcode'
import { ClaudeFerrySource } from '../claudeFerrySource'
import type { AgentDef } from '../../shared/types'

const execFileP = promisify(execFile)
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const providerId = (source: ModelSource) => 'uniagent-' + source.id
const protocol = (connection: SourceConnection) => connection.endpoint.protocol === 'openai-chat' ? 'openai-completions' : connection.endpoint.protocol
function conflict(previous: unknown, binding: AgentSourceBinding): void {
  if (previous && (!binding.managedHash || fingerprint(previous) !== binding.managedHash)) throw new Error('conflict: 原生 Provider 已在外部修改，请导入当前配置后再应用')
}
const runtimeAdapter: SourceAdapter = { apply: async () => ({}), async discover() {
  const ferry = new ClaudeFerrySource(); await ferry.refresh()
  if (!ferry.models.length) return []
  const connection = await ferry.connection(parseCodexModelKey(ferry.models[0].id)!.model)
  return [{ name: 'Ferry', preset: 'custom', plan: 'native', enabled: true, apiKey: connection.apiKey, endpoints: [{ id: 'anthropic-messages', protocol: 'anthropic-messages', baseUrl: connection.baseUrl, auth: 'bearer' }], models: ferry.models.map(model => ({ id: parseCodexModelKey(model.id)!.model, label: model.label, capabilities: { efforts: model.efforts, defaultEffort: model.defaultEffort, contextWindow: model.contextWindow, imageInput: model.imageInput }, routes: [{ endpointId: 'anthropic-messages', upstreamModel: parseCodexModelKey(model.id)!.model }] })) }]
} }
export const sourceCatalogPath = (sourceId: string) => join(resolveUserDataHome(), 'model-sources', `catalog-${sourceId}.json`)
export const codexSourceAdapter: SourceAdapter = {
  async apply(source, binding) {
    const models = binding.modelIds.map(id => {
      const model = source.models.find(model => model.id === id)!
      const preset = (Object.hasOwn(CODEX_SOURCE_PRESETS, source.plan || '') ? source.plan : Object.hasOwn(CODEX_SOURCE_PRESETS, source.preset) ? source.preset : 'deepseek') as CodexSourcePreset
      const base = codexSourceCatalogModel(id, preset)
      return { ...base, slug: id, display_name: model.label, ...(model.capabilities?.contextWindow ? { context_window: model.capabilities.contextWindow, max_context_window: model.capabilities.contextWindow } : {}),
        ...(model.capabilities?.efforts ? { supported_reasoning_levels: model.capabilities.efforts.map(effort => ({ effort, description: effort })), default_reasoning_level: model.capabilities.defaultEffort ?? model.capabilities.efforts[0] ?? 'none' } : {}),
        ...(model.capabilities?.imageInput !== undefined ? { input_modalities: model.capabilities.imageInput ? ['text', 'image'] : ['text'] } : {}) }
    })
    const path = sourceCatalogPath(source.id), temporary = path + '.tmp'
    await mkdir(join(resolveUserDataHome(), 'model-sources'), { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify({ models }), { mode: 0o600 }); await rename(temporary, path)
    return {}
  }
}
export function modelSourceCodexArgs(connection: SourceConnection, config: SessionConfig): string[] {
  const provider = providerId(connection.source), envKey = 'UNIAGENT_SOURCE_' + connection.source.id.replace(/-/g, '_').toUpperCase()
  process.env[envKey] = connection.apiKey
  return ['-c', `model_provider=${JSON.stringify(provider)}`, '-c', `model_providers.${provider}.name=${JSON.stringify(connection.source.name)}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(connection.baseUrl)}`, '-c', `model_providers.${provider}.wire_api="responses"`,
    '-c', `model_providers.${provider}.env_key=${JSON.stringify(envKey)}`, '-c', `model_providers.${provider}.requires_openai_auth=false`,
    '-c', `model_providers.${provider}.supports_websockets=false`, '-c', `model_catalog_json=${JSON.stringify(sourceCatalogPath(connection.source.id))}`,
    '-c', 'features.enable_request_compression=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
    ...(['mimo', 'trae'].includes(connection.source.preset) ? ['-c', 'web_search="disabled"', '-c', 'features.standalone_web_search=false'] : [])]
}
export function modelSourceClaudeConnection(connection: SourceConnection, config: SessionConfig): import('../claudeSourceRuntime').ClaudeConnection {
  const selected = parseCodexModelKey(config.model!)?.model ?? config.model!
  const model = connection.source.models.find(model => model.id === selected)!
  const preset = (connection.source.preset === 'custom' || connection.source.preset === 'ark-coding-plan' || connection.source.preset === 'glm' ? 'custom' : connection.source.preset === 'trae' ? 'ferry' : connection.source.preset === 'kimi' ? 'kimi-code' : connection.source.plan === 'token-plan' ? 'mimo-token-plan' : connection.source.preset) as ClaudeSourcePreset | 'custom' | 'ferry'
  const support = ['deepseek', 'mimo', 'mimo-token-plan', 'kimi-code'].includes(preset) ? claudeSourceEffort(model.id, preset as ClaudeSourcePreset) : { efforts: model.capabilities?.efforts ?? [], defaultEffort: model.capabilities?.defaultEffort }
  return { preset, baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: model.id, ...support, authToken: true,
    ...(connection.source.preset === 'ark-coding-plan' && /^glm-/.test(model.id) ? { thinkingBudget: 10000 } : {}) }
}

export function createQoderSourceAdapter(operation = qoderOperation): SourceAdapter { return {
  async discover(agent) {
    const entries = await operation(agent.bin, 'byok.list')
    return entries.filter((entry: any) => entry.providerId && !entry.providerId.startsWith('uniagent-') && entry.baseUrl && entry.models?.length).map((entry: any): ModelSourceInput => {
      const protocol = entry.protocol === 'anthropic' ? 'anthropic-messages' : entry.protocol === 'openai-responses' ? 'openai-responses' : 'openai-chat'
      return { name: entry.displayName || entry.providerId, preset: 'custom', plan: 'native', enabled: true, endpoints: [{ id: protocol, protocol, baseUrl: entry.baseUrl, auth: 'bearer' }], models: entry.models.map((model: any) => ({ id: model.id, label: model.displayName || model.id, routes: [{ endpointId: protocol, upstreamModel: model.id }], ...(model.contextWindow ? { capabilities: { contextWindow: model.contextWindow } } : {}) })) }
    })
  },
  async apply(source, binding, connection, agent) {
    const id = providerId(source)
    const entries = await operation(agent.bin, 'byok.list')
    const previous = entries.find((entry: any) => entry.providerId === id)
    const view = (value: any) => ({ providerId: value.providerId, displayName: value.displayName, baseUrl: value.baseUrl, protocol: value.protocol, models: value.models.map((model: any) => ({ id: model.id, displayName: model.displayName, capabilities: model.capabilities, contextWindow: model.contextWindow })) })
    conflict(previous && view(previous), binding)
    const value = { providerId: id, displayName: source.name, baseUrl: connection.baseUrl, apiKey: connection.apiKey,
      protocol: connection.endpoint.protocol === 'openai-chat' ? 'openai' : connection.endpoint.protocol === 'openai-responses' ? 'openai-responses' : 'anthropic',
      models: binding.modelIds.map(modelId => { const model = source.models.find(model => model.id === modelId)!, efforts = model.capabilities?.efforts?.filter(effort => ['low','medium','high','xhigh','max'].includes(effort)); return { model: modelId, displayName: model.label, ...(model.capabilities?.contextWindow ? { contextWindow: model.capabilities.contextWindow } : {}), capabilities: { tools: true, ...(model.capabilities?.imageInput ? { vision: true } : {}), ...(efforts?.length ? { thinking: { modes: ['enabled'], preferredMode: 'enabled', supportsEffort: true, supportedEffortLevels: efforts } } : {}) } } }) }
    await operation(agent.bin, previous ? 'byok.update' : 'byok.create', value)
    const saved = (await operation(agent.bin, 'byok.list')).find((entry: any) => entry.providerId === id)
    if (!saved) throw new Error('Qoder 未返回已保存的 Provider')
    const nativeModels: Record<string, string> = {}
    let liveModels: any[]
    try { liveModels = await operation(agent.bin, 'models') } catch { throw new ModelSourceApplyError('Qoder Provider 已保存，模型目录刷新失败，请重试', { managedHash: fingerprint(view(saved)) }) }
    for (const modelId of binding.modelIds) {
      const model = liveModels.find((model: any) => (model.provider === id || model.url === connection.baseUrl) && (model.model === modelId || model.modelId === modelId))
      if (!model?.value) throw new ModelSourceApplyError('Qoder Provider 已保存，尚未返回模型选择 ID，请重试', { managedHash: fingerprint(view(saved)) })
      nativeModels[modelId] = model.value
    }
    return { nativeModels, managedHash: fingerprint(view(saved)) }
  }
} }

export function createKimiSourceAdapter(acquire = acquireKimiWebService): SourceAdapter { return {
  async apply(source, binding, connection, agent) {
    const lease = await acquire({ bin: agent.bin, cwd: process.cwd() })
    try {
      const id = providerId(source), listed = await lease.transport.request<any>('GET', '/api/v1/providers')
      const previous = listed.items?.find((provider: any) => provider.id === id)
      const view = (value: any) => ({ id: value.id, type: value.type, base_url: value.base_url, models: value.models })
      conflict(previous && view(previous), binding)
      const models = binding.modelIds.map(modelId => {
        const model = source.models.find(model => model.id === modelId)!
        if (!model.capabilities?.contextWindow) throw new Error('请先填写模型上下文窗口，再应用到 Kimi Code')
        const thinkingOptions = model.capabilities.thinkingOptions ?? (['trae', 'ark-coding-plan'].includes(source.preset) && model.capabilities.efforts?.length ? model.capabilities.efforts : undefined)
        return { model: modelId, display_name: model.label, max_context_size: model.capabilities.contextWindow,
          capabilities: ['tool_use', ...(model.capabilities.imageInput ? ['image_in'] : []), ...(thinkingOptions?.some(level => level !== 'off') ? ['thinking'] : []), ...(source.preset === 'ark-coding-plan' && modelId === 'kimi-k3.1-pro' ? ['always_thinking'] : [])],
          ...(thinkingOptions ? { support_efforts: thinkingOptions, ...(source.preset === 'trae' && thinkingOptions.length && connection.endpoint.protocol === 'anthropic-messages' ? { adaptive_thinking: true } : {}) } : {}) }
      })
      const value = { ...(previous ? {} : { id }), type: connection.endpoint.protocol === 'anthropic-messages' ? 'anthropic' : 'openai', api_key: connection.apiKey, base_url: connection.baseUrl + (connection.endpoint.protocol === 'anthropic-messages' ? '/v1' : ''), models }
      await lease.transport.request(previous ? 'PUT' : 'POST', previous ? `/api/v1/providers/${encodeURIComponent(id)}` : '/api/v1/providers', value)
      const saved = (await lease.transport.request<any>('GET', '/api/v1/providers')).items?.find((provider: any) => provider.id === id)
      if (!saved) throw new Error('Kimi 未返回已保存的 Provider')
      const defaults = Object.fromEntries(models.flatMap(model => {
        const effort = source.models.find(item => item.id === model.model)!.capabilities?.defaultEffort
        return effort && model.support_efforts?.includes(effort) ? [[`${id}/${model.model}`, { default_effort: effort }]] : []
      }))
      // Kimi's Provider API accepts support_efforts but drops default_effort; model config uses merge semantics.
      if (Object.keys(defaults).length) {
        try { await lease.transport.request('POST', '/api/v1/config', { models: defaults }) }
        catch (error) { throw new ModelSourceApplyError((error as Error).message, { managedHash: fingerprint(view(saved)) }) }
      }
      try {
        const catalog = await lease.transport.request<any>('GET', '/api/v1/models')
        return { nativeModels: Object.fromEntries(binding.modelIds.map(modelId => [modelId, `${id}/${modelId}`])), models: kimiWebContract(catalog.items).models, managedHash: fingerprint(view(saved)) }
      } catch (error) { throw new ModelSourceApplyError((error as Error).message, { managedHash: fingerprint(view(saved)) }) }
    } finally { await lease.release() }
  }
} }
export const kimiSourceAdapter = createKimiSourceAdapter()

export function createDeepSeekSourceAdapter(host = getDeepSeekHost): SourceAdapter { return {
  async apply(source, binding, connection) {
    enableDeepSeekModelSources()
    const client = await host(), description = await client.call<any>('settings/describe')
    const native = source.preset === 'deepseek' && connection.endpoint.protocol === 'anthropic-messages'
    const namespace = description.namespaces.find((item: any) => item.ns === (native ? 'uniagent-deepseek-model-sources' : 'uniagent-model-sources')) ?? (!native ? description.namespaces.find((item: any) => item.ns === 'llm-pi-ai') : undefined)
    if (!namespace || !description.writable) throw new Error('DeepSeek Host 暂未加载模型来源扩展，请新建会话或重新检测')
    const id = providerId(source), previous = namespace.value.providers?.[id]
    conflict(previous, binding)
    const reference = 'UNIAGENT_SOURCE_' + source.id.replace(/-/g, '_').toUpperCase()
    await client.call('credentials/set', { ref: reference, value: connection.apiKey })
    const profile = { displayName: source.name, ...(native ? { baseURL: connection.baseUrl } : { api: protocol(connection), baseURL: connection.baseUrl }), apiKeyEnv: reference,
      models: binding.modelIds.map(modelId => { const model = source.models.find(model => model.id === modelId)!; return { id: modelId, name: model.label,
        ...(['trae', 'ark-coding-plan'].includes(source.preset) && model.capabilities?.efforts?.length ? { reasoningEfforts: Object.fromEntries(model.capabilities.efforts.map(effort => [effort, effort])), ...(connection.endpoint.protocol === 'anthropic-messages' ? { compat: { forceAdaptiveThinking: true } } : {}) } : {}),
        ...(model.capabilities?.contextWindow ? { contextWindow: model.capabilities.contextWindow } : {}), ...(model.capabilities?.imageInput ? native ? { inputModalities: ['text', 'image'] } : { input: ['text', 'image'] } : {}) } }) }
    const saved = await client.call<any>('settings/mutate', { ns: namespace.ns, ops: [{ op: 'set', path: ['providers', id], value: profile }], expectedRevision: namespace.revision })
    const catalog = await client.call<any>('session/modelCatalog')
    if (!catalog.groups?.some((group: any) => group.id === id && binding.modelIds.every(modelId => group.models?.some((model: any) => model.id === modelId)))) throw new ModelSourceApplyError('DeepSeek 尚未注册所选模型，请检查当前 Host 的 Provider 能力', { managedHash: fingerprint(saved.value.providers[id]) })
    return { nativeModels: Object.fromEntries(binding.modelIds.map(modelId => [modelId, JSON.stringify([id, modelId])])), models: deepseekHostModels(catalog), managedHash: fingerprint(saved.value.providers[id]) }
  }
} }
export const deepseekSourceAdapter = createDeepSeekSourceAdapter()

export function createMCodeSourceAdapter(execute = execFileP): SourceAdapter { return {
  async apply(source, binding, connection, agent) {
    // Official CLI lacks an update operation. Revisioned owned entries keep active native sessions on their original connection.
    const list = async () => { const { stdout } = await execute(agent.bin, ['provider', 'list', '--json'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }); return JSON.parse(String(stdout)).providers }
    let entries = await list()
    const view = (entry: any) => ({ providerId: entry.providerId, name: entry.name || entry.displayName, baseUrl: entry.baseUrl, apiFormat: entry.apiFormat, enabled: entry.enabled, models: entry.models })
    const owned = Object.values(binding.nativeModels || {}).map(value => parseMCodeModelValue(value)?.providerId)
    if (binding.managedHash && owned.length && fingerprint(entries.filter((entry: any) => owned.includes(entry.providerId)).map(view)) !== binding.managedHash) throw new Error('conflict: MiniMax Provider 已在外部修改，请重新导入')
    const nativeModels: Record<string, string> = {}, applied: any[] = []
    for (const id of binding.modelIds) {
      const name = `${source.name} · ${providerId(source)} · r${source.revision} · ${id}`, model = source.models.find(model => model.id === id)!
      let previous = entries.find((provider: any) => provider.name === name || provider.displayName === name)
      if (!previous) {
        const args = ['provider', 'add', '--name', name, '--base-url', connection.baseUrl, '--api-format', protocol(connection), '--api-key-env', 'UNIAGENT_MODEL_SOURCE_KEY', '--model', id, ...(model.capabilities?.imageInput ? ['--support-image'] : []), ...(model.capabilities?.contextWindow ? ['--context-limit', String(model.capabilities.contextWindow)] : [])]
        await execute(agent.bin, args, { env: { ...process.env, UNIAGENT_MODEL_SOURCE_KEY: connection.apiKey }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
        entries = await list(); previous = entries.find((provider: any) => provider.name === name || provider.displayName === name)
      }
      if (!previous?.providerId) throw new Error('MiniMax Code 未返回 Provider 身份，请刷新配置')
      nativeModels[id] = `m:${encodeURIComponent(previous.providerId)}:${encodeURIComponent(id)}:u`; applied.push(previous)
    }
    return { nativeModels, managedHash: fingerprint(entries.filter((entry: any) => applied.some(provider => provider.providerId === entry.providerId)).map(view)) }
  }
} }

export const zcodeSourceAdapter: SourceAdapter = {
  async discover() {
    let runtime: any
    try { runtime = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (!runtime.personalProviderConfigPath) return []
    const document = JSON.parse(await readFile(runtime.personalProviderConfigPath, 'utf8'))
    return (document.config?.providerConfigRules?.providerRules || []).filter((rule: any) => rule.providerId?.startsWith('personal:') && !rule.providerId.startsWith('personal:uniagent-') && rule.config?.api?.baseUrl && rule.config?.access?.apiKey && rule.config?.personalModelIds?.length).map((rule: any): ModelSourceInput => {
      const protocol = rule.config.api.type === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat'
      return { name: rule.providerName || rule.providerId, preset: 'custom', plan: 'native', enabled: rule.enabled !== false, apiKey: rule.config.access.apiKey, endpoints: [{ id: protocol, protocol, baseUrl: rule.config.api.baseUrl, auth: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer' }], models: rule.config.personalModelIds.map((id: string) => ({ id, label: id, routes: [{ endpointId: protocol, upstreamModel: id }] })) }
    })
  },
  async apply(source, binding, connection) {
    const runtime = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))
    if (!runtime.personalProviderConfigPath) throw new Error('请先完成 ZCode 运行时配置')
    const path = runtime.personalProviderConfigPath, text = await readFile(path, 'utf8'), document = JSON.parse(text)
    const rules = document.config?.providerConfigRules?.providerRules
    if (!Array.isArray(rules)) throw new Error('ZCode Provider 配置格式不兼容')
    const id = 'personal:' + providerId(source), previous = rules.find((provider: any) => provider.providerId === id)
    const modelRules = document.config.modelConfigRules ??= { providerModelRules: [], manualProviderModelRules: [] }
    const previousModels = (modelRules.providerModelRules || []).filter((rule: any) => rule.providerId === id)
    if (modelRules.manualProviderModelRules?.some((rule: any) => rule.providerId === id)) throw new Error('conflict: ZCode 模型已在外部修改，请重新导入')
    const previousValue = previousModels.length ? { provider: previous, models: previousModels } : previous
    if (previous && zcodePayloadHash(previousValue) !== binding.managedHash) {
      // Accept the old writer's fingerprint after ZCode reorders ModelRule keys.
      const legacyModels = previousModels.map(({ providerId, modelId, config, ...extra }: any) => ({ providerId, modelId, config, ...extra }))
      conflict(legacyModels.length ? { provider: previous, models: legacyModels } : previous, binding)
    }
    const models = [...binding.modelIds]
    const rule = { providerId: id, providerName: source.name, enabled: true, config: { group: 'standard-personal', access: { type: source.preset === 'glm' ? 'zhipu-coding-plan-api-key' : 'api-key', apiKey: connection.apiKey }, api: { type: connection.endpoint.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat-completions', baseUrl: connection.baseUrl }, personalModelIds: models, modelOrder: models } }
    document.config.providerConfigRules.providerRules = [...rules.filter((provider: any) => provider.providerId !== id), rule]
    const configuredModels = models.map(modelId => {
      const model = source.models.find(model => model.id === modelId)!
      return { providerId: id, modelId, config: { enabled: true, ...(model.capabilities?.contextWindow ? { properties: { contextWindow: model.capabilities.contextWindow } } : {}),
        ...(['trae', 'ark-coding-plan'].includes(source.preset) && model.capabilities?.efforts?.length ? { optionSpecs: { reasoningLevel: { values: model.capabilities.efforts,
          map: connection.endpoint.protocol === 'anthropic-messages' ? source.preset === 'ark-coding-plan' ? '{"thinking":{"type":"enabled","budget_tokens":10000},"output_config":{"effort":reasoningLevel}}' : '{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}' : '{"reasoning_effort":reasoningLevel}' } } } : {}) } }
    })
    modelRules.providerModelRules = [...(modelRules.providerModelRules || []).filter((rule: any) => rule.providerId !== id), ...configuredModels]
    const fresh = await readFile(path, 'utf8'); if (fresh !== text) throw new Error('conflict: ZCode 配置已变化，请重试')
    const temporary = path + '.uniagent-source.tmp'; await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 }); await rename(temporary, path)
    try {
      const catalog = await readZCodeConfiguredModels(path, runtime.resourceRoot ? join(runtime.resourceRoot, 'provider/zcode-builtin.json') : undefined, { providerId: id, modelId: models[0] })
      return { nativeModels: Object.fromEntries(binding.modelIds.map(modelId => [modelId, zcodeModelKey({ providerId: id, modelId })])), models: catalog, managedHash: zcodePayloadHash({ provider: rule, models: configuredModels }) }
    } catch (error) { throw new ModelSourceApplyError((error as Error).message, { managedHash: zcodePayloadHash({ provider: rule, models: configuredModels }) }) }
  }
}

export const modelSourceAdapters: Record<string, SourceAdapter> = { codex: codexSourceAdapter, claude: runtimeAdapter, kimi: kimiSourceAdapter, deepseek: deepseekSourceAdapter, zcode: zcodeSourceAdapter }
