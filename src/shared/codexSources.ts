export type CodexSourceId = 'kimi' | 'deepseek' | 'glm' | 'mimo'
export type CodexSourcePreset = 'kimi-code' | 'kimi-api' | 'deepseek' | 'glm' | 'mimo' | 'mimo-token-plan'

export interface CodexSourceRuntimeIssue {
  sourceId: CodexSourceId
  model: string
  code: string
  message: string
  occurredAt: number
  stage: 'upstream_response' | 'upstream_request'
  statusCode?: number
  error?: { name: string; message: string; code?: string }
}
export type CodexSourceModelIssue = Omit<CodexSourceRuntimeIssue, 'sourceId'>
export interface CodexSourceServiceRuntimeIssue {
  code: string
  message: string
  occurredAt: number
  stage: 'request_validation'
  error?: { name: string; message: string; code?: string }
}
export type CodexSourceRuntimeEvent =
  | { type: 'issue'; issue: CodexSourceRuntimeIssue }
  | { type: 'service-issue'; issue: CodexSourceServiceRuntimeIssue }
  | { type: 'recovered'; sourceId: CodexSourceId; model: string }

export function updateCodexSourceRuntimeIssues(
  issues: CodexSourceRuntimeIssue[],
  event: CodexSourceRuntimeEvent
): CodexSourceRuntimeIssue[] {
  if (event.type === 'service-issue') return issues
  if (event.type === 'recovered') {
    const next = issues.filter(issue => issue.sourceId !== event.sourceId || issue.model !== event.model)
    return next.length === issues.length ? issues : next
  }
  return [event.issue, ...issues.filter(issue => issue.sourceId !== event.issue.sourceId || issue.model !== event.issue.model)]
}

export function codexSourceModelIssues(
  issues: CodexSourceRuntimeIssue[],
  sourceId: CodexSourceId
): CodexSourceModelIssue[] {
  return issues.filter(issue => issue.sourceId === sourceId).map(({ sourceId: _sourceId, ...issue }) => issue)
}

export function isCodexSourceModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value)
}

export function appendCodexSourceModel(models: string[], value: string): string[] {
  const model = value.trim()
  if (!isCodexSourceModelId(model)) throw new Error('请输入有效的模型 ID')
  if (models.includes(model)) throw new Error('模型 ID 已存在')
  if (models.length >= 100) throw new Error('最多配置 100 个模型')
  return [...models, model]
}

export interface CodexSourceBalance {
  currency: string
  total: string
  granted?: string
  toppedUp?: string
}
export interface CodexSourceQuotaWindow {
  label: string
  usedPercent: number
  resetsAt?: number
}
export interface CodexSourceQuota {
  status: 'ready' | 'unsupported' | 'error'
  planType?: string
  kind?: 'balance' | 'windows'
  capturedAt?: number
  balances?: CodexSourceBalance[]
  windows?: CodexSourceQuotaWindow[]
  message?: string
  stale?: boolean
}
export interface CodexSource {
  id: CodexSourceId
  preset: CodexSourcePreset
  enabled: boolean
  baseUrl: string
  models: string[]
  hasKey: boolean
  quota?: CodexSourceQuota
  issues?: CodexSourceModelIssue[]
}
export type CodexSourceInput = Omit<CodexSource, 'hasKey' | 'quota' | 'issues'> & { apiKey?: string; credential?: { id: string; revision: string } }
export type CodexSourceModelQueryInput = Pick<CodexSourceInput, 'id' | 'preset' | 'baseUrl' | 'apiKey' | 'credential'>
export interface CodexSourcesSnapshot {
  enabled: boolean
  phase: 'stopped' | 'starting' | 'running' | 'error'
  message?: string
  endpoint?: string
  sources: CodexSource[]
  legacyAvailable: boolean
  quotaRefreshing: boolean
}
export const CODEX_SOURCE_IPC = {
  get: 'codexSources:get', save: 'codexSources:save', enabled: 'codexSources:enabled',
  restart: 'codexSources:restart', migrate: 'codexSources:migrate', refreshQuota: 'codexSources:refreshQuota', queryModels: 'codexSources:queryModels',
  changed: 'codexSources:changed'
} as const
export const CODEX_SOURCE_NAMES: Record<CodexSourceId, string> = { kimi: 'Kimi', deepseek: 'DeepSeek', glm: 'GLM', mimo: '小米 MiMo' }
export const CODEX_SOURCE_PRESETS: Record<CodexSourcePreset, { id: CodexSourceId; label: string; baseUrl: string; models: string[]; consoleUrl?: string }> = {
  'kimi-code': { id: 'kimi', label: 'Kimi Code（订阅套餐）', baseUrl: 'https://api.kimi.com/coding/v1', models: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'] },
  'kimi-api': { id: 'kimi', label: 'Kimi API（按量付费）', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k2.7-code'] },
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  glm: { id: 'glm', label: 'GLM Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/v1', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5-turbo'] },
  mimo: { id: 'mimo', label: '小米 MiMo API（按量付费）', baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance' },
  'mimo-token-plan': { id: 'mimo', label: '小米 MiMo Token Plan（订阅套餐）', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance' }
}
/** Codex 来源配置页按此顺序展示每个接入商的默认配置。 */
export const CODEX_SOURCE_PRESET_ORDER: CodexSourcePreset[] = ['kimi-code', 'deepseek', 'glm', 'mimo']

/** 已知模型的多模态能力；未知模型按纯文本处理，避免误发图片。 */
export function codexSourceModelImageInput(preset: CodexSourcePreset, model: string): boolean {
  if (!CODEX_SOURCE_PRESETS[preset].models.includes(model)) return false
  // MiMo V2.6 系列为全模态模型；Kimi 官方模型与 DeepSeek Flash 支持图片。
  return preset.startsWith('mimo') || preset.startsWith('kimi') || model === 'deepseek-flash'
}

/** MiMo 的 /models 同时列出 ASR/TTS 模型；它们不能承接对话，自动查询时必须排除。 */
export function codexSourceChatModels(preset: CodexSourcePreset, models: string[]): string[] {
  return preset.startsWith('mimo') ? models.filter(model => !/-(?:asr|tts)(?:-|$)/.test(model)) : models
}
