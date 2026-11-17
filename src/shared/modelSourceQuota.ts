import type { CodexSourcePreset, CodexSourceQuota } from './codexSources'
import { modelSourcePlanId, type ModelSourceInput } from './modelSources'

export interface ModelSourceQuota extends CodexSourceQuota {
  refreshing?: boolean; checkedAt?: number; needsCredentials?: boolean
  amount?: { remaining?: number; total?: number; used?: number; unit: string; unlimited?: boolean }
  accounts?: { id: string; label: string; endpointIds: string[]; quota: ModelSourceQuota }[]
}
export const QUOTA_QUERY_TEMPLATES = [
  { id: 'auto', label: '自动识别' }, { id: 'minimax', label: 'MiniMax 套餐' },
  { id: 'siliconflow', label: '硅基流动余额' }, { id: 'openrouter', label: 'OpenRouter 余额' },
  { id: 'stepfun', label: 'StepFun 余额' }, { id: 'novita', label: 'Novita AI 余额' },
  { id: 'sub2api', label: 'Sub2API' }, { id: 'new-api', label: 'New API' }, { id: 'console', label: '仅控制台' }
] as const
export interface ModelSourceQuotaQuery { template: typeof QUOTA_QUERY_TEMPLATES[number]['id']; userId?: string; unit?: 'quota' | 'USD' | 'CNY'; quotaPerUnit?: number }
export interface ModelSourceQuotaCredentials { accessKeyId?: string; secretAccessKey?: string; accessToken?: string }
export interface ModelSourceQuotaSave { sourceId: string; expectedRevision: string; operationId: string; query?: ModelSourceQuotaQuery; credentials?: ModelSourceQuotaCredentials; clearCredentials?: boolean }
export type QuotaProviderId = CodexSourcePreset | 'kimi-code-global' | 'ark-coding-plan' | 'ark-agent-plan' | 'minimax' | 'minimax-cn' | 'siliconflow' | 'siliconflow-cn' | 'openrouter' | 'stepfun' | 'novita' | 'new-api' | 'sub2api'
export interface QuotaQueryContext { query?: ModelSourceQuotaQuery; credentials?: ModelSourceQuotaCredentials }
type Source = Pick<ModelSourceInput, 'preset' | 'plan' | 'endpoints' | 'consoleUrl' | 'quotaQuery'>
export interface QuotaProvider { preset: QuotaProviderId; baseUrl: string; bases: string[]; consoleUrl?: string }
const providers: Record<string, QuotaProvider> = {
  deepseek: { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', bases: ['https://api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/anthropic'], consoleUrl: 'https://platform.deepseek.com/usage' },
  glm: { preset: 'glm', baseUrl: 'https://open.bigmodel.cn/api/v1', bases: ['https://open.bigmodel.cn/api/v1', 'https://open.bigmodel.cn/api/anthropic', 'https://open.bigmodel.cn/api/coding/paas/v4'], consoleUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage' },
  mimo: { preset: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', bases: ['https://api.xiaomimimo.com/v1', 'https://api.xiaomimimo.com/anthropic'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance' },
  'mimo-token-plan': { preset: 'mimo-token-plan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', bases: ['https://token-plan-cn.xiaomimimo.com/v1', 'https://token-plan-cn.xiaomimimo.com/anthropic'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance' },
  'kimi-code': { preset: 'kimi-code', baseUrl: 'https://api.kimi.com/coding/v1', bases: ['https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding'], consoleUrl: 'https://www.kimi.com/code/console' },
  'kimi-api': { preset: 'kimi-api', baseUrl: 'https://api.moonshot.cn/v1', bases: ['https://api.moonshot.cn/v1', 'https://api.moonshot.cn/anthropic'], consoleUrl: 'https://platform.kimi.com/console/account' },
  'kimi-code-global': { preset: 'kimi-code-global', baseUrl: 'https://api.kimi.ai/coding/v1', bases: ['https://api.kimi.ai/coding/v1', 'https://api.kimi.ai/coding'], consoleUrl: 'https://www.kimi.com/code/console' },
  'ark-coding-plan': { preset: 'ark-coding-plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', bases: ['https://ark.cn-beijing.volces.com/api/coding', 'https://ark.cn-beijing.volces.com/api/coding/v3'], consoleUrl: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan' },
  'ark-agent-plan': { preset: 'ark-agent-plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan', bases: ['https://ark.cn-beijing.volces.com/api/plan', 'https://ark.cn-beijing.volces.com/api/plan/v3'], consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/subscription/agent-plan' },
  minimax: { preset: 'minimax', baseUrl: 'https://api.minimax.io/v1', bases: ['https://api.minimax.io/v1', 'https://api.minimax.io/anthropic', 'https://api.minimax.io/anthropic/v1'], consoleUrl: 'https://platform.minimax.io/user-center/payment/coding-plan' },
  'minimax-cn': { preset: 'minimax-cn', baseUrl: 'https://api.minimaxi.com/v1', bases: ['https://api.minimaxi.com/v1', 'https://api.minimaxi.com/anthropic', 'https://api.minimaxi.com/anthropic/v1', 'https://api.minimax.cn/v1', 'https://api.minimax.cn/anthropic', 'https://api.minimax.cn/anthropic/v1'], consoleUrl: 'https://platform.minimaxi.com/user-center/payment/coding-plan' },
  siliconflow: { preset: 'siliconflow', baseUrl: 'https://api.siliconflow.com/v1', bases: ['https://api.siliconflow.com/v1'], consoleUrl: 'https://cloud.siliconflow.com' },
  'siliconflow-cn': { preset: 'siliconflow-cn', baseUrl: 'https://api.siliconflow.cn/v1', bases: ['https://api.siliconflow.cn/v1'], consoleUrl: 'https://cloud.siliconflow.cn' },
  openrouter: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', bases: ['https://openrouter.ai/api/v1'], consoleUrl: 'https://openrouter.ai/settings/credits' },
  stepfun: { preset: 'stepfun', baseUrl: 'https://api.stepfun.com/v1', bases: ['https://api.stepfun.com/v1', 'https://api.stepfun.ai/v1'], consoleUrl: 'https://platform.stepfun.com' },
  novita: { preset: 'novita', baseUrl: 'https://api.novita.ai/v3/openai', bases: ['https://api.novita.ai/v3/openai'], consoleUrl: 'https://novita.ai/billing' }
}
export function validateQuotaQuery(value: unknown): ModelSourceQuotaQuery | undefined {
  if (value === undefined) return undefined
  const query = value as ModelSourceQuotaQuery
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['template', 'userId', 'unit', 'quotaPerUnit'].includes(key)) || !QUOTA_QUERY_TEMPLATES.some(item => item.id === query.template)) throw new Error('额度查询方式无效')
  if (query.userId !== undefined && (typeof query.userId !== 'string' || !/^\d{1,30}$/.test(query.userId))) throw new Error('额度查询用户 ID 无效')
  if (query.unit !== undefined && !['quota', 'USD', 'CNY'].includes(query.unit)) throw new Error('额度单位无效')
  if (query.quotaPerUnit !== undefined && (!Number.isSafeInteger(query.quotaPerUnit) || query.quotaPerUnit <= 0 || query.quotaPerUnit > 1e15)) throw new Error('额度换算比例无效')
  if (query.template === 'new-api' && query.unit && query.unit !== 'quota' && !query.quotaPerUnit) throw new Error('请填写每单位对应额度，或选择原始额度')
  return { template: query.template, ...(query.template === 'new-api' ? { ...(query.userId ? { userId: query.userId } : {}), ...(query.unit ? { unit: query.unit } : {}), ...(query.quotaPerUnit ? { quotaPerUnit: query.quotaPerUnit } : {}) } : {}) }
}
const base = (value: string): string => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return ''
    return url.toString().replace(/\/+$/, '')
  } catch { return '' }
}
export function modelSourceQuotaProvider(source: Source): QuotaProvider | undefined {
  if (source.preset === 'trae' || source.quotaQuery?.template === 'console') return undefined
  const selected = source.quotaQuery?.template ?? 'auto'
  const bases = source.endpoints.map(endpoint => endpoint.auth === 'none' ? '' : base(endpoint.baseUrl))
  if (!bases.length || bases.some(value => !value)) return undefined
  if (source.preset === 'custom' && (selected === 'new-api' || selected === 'sub2api')) {
    const root = (value: string) => value.replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '')
    if (new Set(bases.map(root)).size !== 1) return undefined
    return { preset: selected, baseUrl: bases[0], bases }
  }
  const id = source.preset === 'mimo' ? modelSourcePlanId(source) === 'token-plan' ? 'mimo-token-plan' : 'mimo'
    : source.preset === 'kimi' ? source.plan === 'kimi-api' || source.endpoints.some(endpoint => endpoint.baseUrl.startsWith('https://api.moonshot.cn/')) ? 'kimi-api' : 'kimi-code'
      : source.preset === 'ark-coding-plan' && source.plan === 'agent' ? 'ark-agent-plan'
      : source.preset
  const matches = (provider: QuotaProvider) => bases.every(value => provider.bases.includes(value)) && (selected === 'auto' || provider.preset.replace(/-cn$/, '') === selected)
  const provider = source.preset === 'custom' ? Object.values(providers).find(matches) : providers[id]
  // A preset label alone never authorizes sending a key to that vendor.
  return provider && matches(provider) ? provider : undefined
}
export function quotaCredentialIdentity(source: Source): string { const provider = modelSourceQuotaProvider(source); return JSON.stringify([provider?.preset, provider?.baseUrl, source.quotaQuery?.userId, source.endpoints]) }
export function validateSourceConsoleUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 2000 || /[\r\n\u0000]/.test(value)) throw new Error('控制台地址无效')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入有效的 HTTPS 控制台地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /^(?:api[-_]?key|key|token|access[-_]?token|auth|authorization|secret|password|credential)$/i.test(key))) throw new Error('控制台地址须使用 HTTPS，且不能包含凭据')
  return url.toString()
}
export function modelSourceConsoleUrl(source: Source): string | undefined {
  if (source.consoleUrl) return validateSourceConsoleUrl(source.consoleUrl)
  if (source.preset === 'ark-coding-plan') {
    const plan = source.plan === 'agent' ? 'plan' : 'coding'
    if (source.endpoints.length && source.endpoints.every(endpoint => [`https://ark.cn-beijing.volces.com/api/${plan}`, `https://ark.cn-beijing.volces.com/api/${plan}/v3`].includes(endpoint.baseUrl.replace(/\/+$/, '')))) {
      return source.plan === 'agent' ? 'https://ark.volcengine.com/region:cn-beijing/subscription/agent-plan' : 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan'
    }
  }
  return modelSourceQuotaProvider(source)?.consoleUrl
}
