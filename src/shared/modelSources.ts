import type { ModelDef } from './types'
import { ALL_EFFORTS } from './types'
import { validateSourceConsoleUrl, validateQuotaQuery, type ModelSourceQuota, type ModelSourceQuotaQuery } from './modelSourceQuota'

export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export type ModelSourcePreset = 'deepseek' | 'glm' | 'mimo' | 'ark-coding-plan' | 'trae' | 'custom' | 'kimi'
export interface SourceEndpoint { id: string; protocol: ModelProtocol; baseUrl: string; auth: 'bearer' | 'x-api-key' | 'none' }
export interface SourceModelRoute { endpointId: string; upstreamModel: string }
export interface SourceModel { id: string; label: string; routes: SourceModelRoute[]; maxContextWindow?: number; capabilities?: Partial<Pick<ModelDef, 'efforts' | 'defaultEffort' | 'contextWindow' | 'imageInput' | 'thinkingOptions'>> }
export interface SourceConnectionTest { state: 'connected' | 'failed'; endpointId: string; modelId: string; checkedAt: number; elapsedMs: number; message: string }
export interface ModelSource { id: string; name: string; preset: ModelSourcePreset; plan?: string; consoleUrl?: string; quotaQuery?: ModelSourceQuotaQuery; hasQuotaCredentials?: boolean; enabled: boolean; revision: number; endpoints: SourceEndpoint[]; models: SourceModel[]; hasCredential: boolean; connectionTest?: SourceConnectionTest }
export interface AgentSourceBinding { sourceId: string; agentId: string; enabled: boolean; endpointId: string; modelIds: string[]; appliedRevision?: number; appliedRuntimeRevision?: number; nativeModels?: Record<string, string>; retiredNativeModels?: string[]; managedHash?: string }
export interface BindingStatus { sourceId: string; agentId: string; state: 'pending' | 'applying' | 'applied' | 'failed' | 'unsupported' | 'conflict'; message?: string }
export interface ModelSourcesSnapshot { revision: string; sources: ModelSource[]; bindings: AgentSourceBinding[]; statuses: BindingStatus[]; gateway: 'stopped' | 'starting' | 'running' | 'error'; error?: string; quotas?: Record<string, ModelSourceQuota> }
export interface ModelSourceInput extends Omit<ModelSource, 'id' | 'revision' | 'hasCredential' | 'hasQuotaCredentials' | 'connectionTest'> { id?: string; apiKey?: string; importId?: string }
export interface ModelSourceImport { id: string; agentId: string; source: ModelSourceInput; hasCredential: boolean }
export type ModelSourceBindingInput = Pick<AgentSourceBinding, 'agentId' | 'enabled' | 'endpointId' | 'modelIds'>
export interface ModelSourceSave { source: ModelSourceInput; bindings: ModelSourceBindingInput[]; expectedRevision: string; operationId: string }
export interface ModelSourceTemplate { id: ModelSourcePreset; name: string; plans: { id: string; label: string; endpoints: SourceEndpoint[]; models: string[] }[] }
export const MODEL_SOURCE_IPC = { get: 'modelSources:get', save: 'modelSources:save', apply: 'modelSources:apply', query: 'modelSources:query', test: 'modelSources:test', reveal: 'modelSources:reveal', changed: 'modelSources:changed', import: 'modelSources:import', login: 'modelSources:login', quota: 'modelSources:quota', saveQuota: 'modelSources:saveQuota' } as const
export const MODEL_PROTOCOL_NAMES: Record<ModelProtocol, string> = { 'openai-chat': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }
export function modelEndpointUrl(endpoint: SourceEndpoint, resource: string): string {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  return base + (endpoint.protocol === 'anthropic-messages' && !base.endsWith('/v1') ? '/v1' : '') + resource
}

const endpoint = (protocol: ModelProtocol, baseUrl: string, auth: SourceEndpoint['auth'] = 'bearer'): SourceEndpoint => ({ id: protocol, protocol, baseUrl, auth })
// Coding Plan aliases and limits from the official ZCode integration guide.
export const ARK_CODING_MODELS: Record<string, { contextWindow: number; imageInput: boolean } & SourceModel['capabilities']> = {
  'ark-code-latest': { contextWindow: 256000, imageInput: true },
  'doubao-seed-evolving': { contextWindow: 1024000, imageInput: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  'doubao-seed-2.1-pro': { contextWindow: 1024000, imageInput: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  'doubao-seed-2.1-lite': { contextWindow: 1024000, imageInput: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  'doubao-seed-2.0-mini': { contextWindow: 256000, imageInput: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  'glm-5.3': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  'glm-5.3-flash': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  'glm-latest': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  'deepseek-v4.1-flash': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4.1-flash-economy': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4-flash': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4-pro': { contextWindow: 1024000, imageInput: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'kimi-k2.8-preview': { contextWindow: 1024000, imageInput: true },
  'kimi-k3.1-pro': { contextWindow: 1024000, imageInput: true, efforts: ['low', 'high', 'max'], defaultEffort: 'max', thinkingOptions: ['low', 'high', 'max'] }
}
export function officialSourceContextWindow(source: Pick<ModelSourceInput, 'preset'>, modelId: string): number | undefined {
  if (source.preset === 'ark-coding-plan') return ARK_CODING_MODELS[modelId]?.contextWindow
  // DeepSeek /models and Xiaomi's official public model metadata report exact token counts.
  if (source.preset === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(modelId) || source.preset === 'mimo' && ['mimo-v2.6-pro', 'mimo-v2.6-flash'].includes(modelId)) return 1048576
  return undefined
}
export const MODEL_SOURCE_TEMPLATES: ModelSourceTemplate[] = [
  { id: 'deepseek', name: 'DeepSeek', plans: [{ id: 'api', label: '按量付费', endpoints: [endpoint('anthropic-messages', 'https://api.deepseek.com/anthropic'), endpoint('openai-chat', 'https://api.deepseek.com'), endpoint('openai-responses', 'https://api.deepseek.com')], models: ['deepseek-flash', 'deepseek-v4-pro'] }] },
  { id: 'glm', name: 'GLM', plans: [{ id: 'coding', label: 'Coding Plan', endpoints: [endpoint('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'x-api-key'), endpoint('openai-chat', 'https://open.bigmodel.cn/api/coding/paas/v4'), endpoint('openai-responses', 'https://open.bigmodel.cn/api/v1')], models: ['glm-5.3', 'glm-5.3-flash', 'glm-5-turbo'] }] },
  { id: 'mimo', name: '小米 MiMo', plans: ['api', 'token-plan'].map(plan => ({ id: plan, label: plan === 'api' ? '按量付费' : 'Token Plan', endpoints: [endpoint('anthropic-messages', `https://${plan === 'api' ? 'api' : 'token-plan-cn'}.xiaomimimo.com/anthropic`), endpoint('openai-chat', `https://${plan === 'api' ? 'api' : 'token-plan-cn'}.xiaomimimo.com/v1`), endpoint('openai-responses', `https://${plan === 'api' ? 'api' : 'token-plan-cn'}.xiaomimimo.com/v1`)], models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'] })) },
  { id: 'ark-coding-plan', name: '火山方舟', plans: ['coding', 'agent'].map(plan => ({ id: plan, label: plan === 'coding' ? 'Coding Plan' : 'Agent Plan', endpoints: [endpoint('anthropic-messages', `https://ark.cn-beijing.volces.com/api/${plan === 'coding' ? 'coding' : 'plan'}`), endpoint('openai-chat', `https://ark.cn-beijing.volces.com/api/${plan === 'coding' ? 'coding' : 'plan'}/v3`), endpoint('openai-responses', `https://ark.cn-beijing.volces.com/api/${plan === 'coding' ? 'coding' : 'plan'}/v3`)], models: Object.keys(ARK_CODING_MODELS) })) },
  
  { id: 'custom', name: '自定义', plans: [{ id: 'custom', label: '自定义', endpoints: [endpoint('openai-chat', '')], models: [] }] }
]
export const MODEL_AGENT_PROTOCOLS: Record<string, ModelProtocol[]> = { codex: ['openai-responses'], claude: ['anthropic-messages'], qoder: ['anthropic-messages', 'openai-responses', 'openai-chat'], deepseek: ['openai-responses', 'anthropic-messages', 'openai-chat'], kimi: ['openai-chat', 'anthropic-messages'], mcode: ['anthropic-messages', 'openai-responses', 'openai-chat'], zcode: ['anthropic-messages', 'openai-chat'] }
export function modelSourceSupportsAgent(source: Pick<ModelSourceInput, 'preset' | 'endpoints'>, agentId: string): boolean {
  return (['codex', 'claude'].includes(agentId) || ['ark-coding-plan', 'trae'].includes(source.preset) && ['deepseek', 'kimi', 'zcode'].includes(agentId)) && !!preferredSourceEndpoint(source, agentId)
}
export function preferredSourceEndpoint(source: Pick<ModelSource, 'endpoints'>, agentId: string): SourceEndpoint | undefined {
  return MODEL_AGENT_PROTOCOLS[agentId]?.map(protocol => source.endpoints.find(endpoint => endpoint.protocol === protocol)).find(Boolean)
}
export function sourceModelsForEndpoint(source: Pick<ModelSource, 'models'>, endpointId: string): SourceModel[] { return source.models.filter(model => model.routes.some(route => route.endpointId === endpointId)) }
export function modelSourcePlanId(source: Pick<ModelSourceInput, 'preset' | 'plan'>): string | undefined {
  if (source.preset === 'mimo' && source.plan === 'mimo-token-plan') return 'token-plan'
  if (source.preset === 'mimo' && source.plan === 'mimo') return 'api'
  return source.plan ?? (source.preset === 'ark-coding-plan' ? 'coding' : undefined)
}
export function sourceDraft(preset: ModelSourcePreset, planId?: string): ModelSourceInput {
  const template = MODEL_SOURCE_TEMPLATES.find(template => template.id === preset)
  if (!template) throw new Error('数据源预设不可用')
  planId = modelSourcePlanId({ preset, plan: planId })
  const plan = template.plans.find(plan => plan.id === planId) ?? (planId === undefined || preset !== 'ark-coding-plan' ? template.plans[0] : undefined)
  if (!plan) throw new Error('方舟套餐不可用')
  return { name: preset === 'ark-coding-plan' ? `${template.name} ${plan.label}` : template.name, preset, plan: plan.id, enabled: true, endpoints: structuredClone(plan.endpoints), models: plan.models.map(id => ({ id, label: id, ...(preset === 'ark-coding-plan' ? { capabilities: { ...ARK_CODING_MODELS[id] } } : officialSourceContextWindow({ preset }, id) ? { capabilities: { contextWindow: officialSourceContextWindow({ preset }, id) } } : {}), routes: plan.endpoints.map(endpoint => ({ endpointId: endpoint.id, upstreamModel: id })) })) }
}
export function modelSourceConnectionIdentity(source: Pick<ModelSourceInput, 'preset' | 'plan' | 'endpoints'>): string {
  return JSON.stringify({ preset: source.preset, plan: source.plan ?? (source.preset === 'ark-coding-plan' ? 'coding' : ''), endpoints: source.endpoints })
}
export function validateModelSource(value: ModelSourceInput): ModelSourceInput {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || typeof value.enabled !== 'boolean' || !['deepseek', 'glm', 'mimo', 'ark-coding-plan', 'trae', 'custom', 'kimi'].includes(value.preset)) throw new Error('数据源参数无效')
  if (value.id !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) throw new Error('数据源 ID 无效')
  if (value.plan !== undefined && (typeof value.plan !== 'string' || value.plan.length > 100)) throw new Error('套餐参数无效')
  const plan = value.plan ?? (value.preset === 'ark-coding-plan' ? 'coding' : undefined)
  if (value.preset === 'ark-coding-plan' && !['coding', 'agent'].includes(plan!)) throw new Error('方舟套餐不可用')
  if (!Array.isArray(value.endpoints) || value.endpoints.length > 10 || value.preset !== 'trae' && !value.endpoints.length) throw new Error('请配置协议端点')
  const endpoints = value.endpoints.map(endpoint => {
    if (!endpoint || !/^[\w-]{1,100}$/.test(endpoint.id) || !Object.hasOwn(MODEL_PROTOCOL_NAMES, endpoint.protocol) || !['bearer', 'x-api-key', 'none'].includes(endpoint.auth)) throw new Error('协议端点无效')
    let url: URL
    try { url = new URL(endpoint.baseUrl.trim()) } catch { throw new Error('请输入有效的 Base URL') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\r\n\u0000]/.test(endpoint.baseUrl) || endpoint.baseUrl.length > 2000 || /\/(?:messages|responses|chat\/completions)$/.test(url.pathname)) throw new Error('Base URL 应为不含凭据或请求资源的协议根地址')
    if (value.preset === 'ark-coding-plan' && url.hostname === 'ark.cn-beijing.volces.com') {
      const expected = `/api/${plan === 'agent' ? 'plan' : 'coding'}${endpoint.protocol === 'anthropic-messages' ? '' : '/v3'}`
      if (url.protocol !== 'https:' || url.port || url.pathname.replace(/\/+$/, '') !== expected) throw new Error('方舟套餐与连接地址不匹配，请使用对应套餐的 Base URL')
    }
    return { id: endpoint.id, protocol: endpoint.protocol, baseUrl: url.toString().replace(/\/+$/, ''), auth: endpoint.auth }
  })
  if (new Set(endpoints.map(endpoint => endpoint.id)).size !== endpoints.length) throw new Error('协议端点 ID 重复')
  if (!Array.isArray(value.models) || value.models.length > 100) throw new Error('最多添加 100 个模型')
  const models = value.models.map(model => {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || /[\x00-\x20\x7f]/.test(model.id) || typeof model.label !== 'string' || model.label.length > 200 || !Array.isArray(model.routes) || !model.routes.length) throw new Error('模型参数无效')
    for (const route of model.routes) if (!endpoints.some(endpoint => endpoint.id === route.endpointId) || typeof route.upstreamModel !== 'string' || !route.upstreamModel || route.upstreamModel.length > 200 || /[\x00-\x20\x7f]/.test(route.upstreamModel)) throw new Error('模型与协议端点不匹配')
    if (new Set(model.routes.map(route => route.endpointId)).size !== model.routes.length) throw new Error('模型端点重复')
    const capabilities = model.capabilities
    if (model.maxContextWindow !== undefined && (!Number.isSafeInteger(model.maxContextWindow) || model.maxContextWindow < 1 || model.maxContextWindow > 10_000_000)) throw new Error('模型上下文上限无效')
    const officialLimit = officialSourceContextWindow(value, model.id) ?? model.maxContextWindow
    if (officialLimit && capabilities?.contextWindow && capabilities.contextWindow > officialLimit) throw new Error(`${model.id} 上下文窗口不能超过官方上限 ${officialLimit}`)
    if (capabilities?.thinkingOptions !== undefined && (!Array.isArray(capabilities.thinkingOptions) || capabilities.thinkingOptions.length > 20 || capabilities.thinkingOptions.some(option => typeof option !== 'string' || !option || option.length > 100))) throw new Error('模型思考能力无效')
    if (capabilities && (typeof capabilities !== 'object' || Object.keys(capabilities).some(key => !['efforts', 'defaultEffort', 'contextWindow', 'imageInput', 'thinkingOptions'].includes(key)) || capabilities.contextWindow !== undefined && (!Number.isSafeInteger(capabilities.contextWindow) || capabilities.contextWindow < 1 || capabilities.contextWindow > 10_000_000) || capabilities.imageInput !== undefined && typeof capabilities.imageInput !== 'boolean' || capabilities.efforts !== undefined && (!Array.isArray(capabilities.efforts) || capabilities.efforts.some(effort => !ALL_EFFORTS.includes(effort))) || capabilities.defaultEffort !== undefined && !capabilities.efforts?.includes(capabilities.defaultEffort))) throw new Error('模型能力参数无效')
    return { id: model.id, label: model.label.trim() || model.id, routes: model.routes.map(route => ({ endpointId: route.endpointId, upstreamModel: route.upstreamModel })), ...(model.maxContextWindow ? { maxContextWindow: model.maxContextWindow } : {}), ...(capabilities ? { capabilities: structuredClone(capabilities) } : {}) }
  })
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('模型 ID 重复')
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(value.apiKey.trim()))) throw new Error('API Key 格式无效')
  const consoleUrl = validateSourceConsoleUrl(value.consoleUrl)
  const quotaQuery = validateQuotaQuery(value.quotaQuery)
  return { ...(value.id ? { id: value.id } : {}), name: value.name.trim(), preset: value.preset, ...(plan ? { plan } : {}), ...(consoleUrl ? { consoleUrl } : {}), ...(quotaQuery ? { quotaQuery } : {}), enabled: value.enabled, endpoints, models, ...(value.apiKey?.trim() ? { apiKey: value.apiKey.trim() } : {}) }
}
