import { readFile } from 'node:fs/promises'
import { ALL_EFFORTS, type ModelDef, type PermissionModeDef, type SessionAgentContract, type SessionConfig } from '../../shared/types'
import type { ZCodeModelSelection } from '../../shared/zcode'
import type { ZCodeConnection } from './connection'
import type { ZCodeSnapshot } from './protocol'
import { sanitizeZCodeSelection } from './store'
import { isRecord } from './protocol'
import { ZCODE_MODEL_SERVICES, ZCODE_PERMISSION_VALUES } from '../../shared/zcode'
export { ZCODE_PERMISSION_VALUES } from '../../shared/zcode'

export const ZCODE_PERMISSION_MODES: PermissionModeDef[] = [
  { id: 'ask', label: '修改前询问', hint: 'ZCode build 模式：修改前询问；部分普通命令由原生策略决定。' },
  { id: 'auto-edit', label: '自动编辑', hint: 'ZCode edit 模式：自动批准工作区文件编辑，命令仍按原生规则审批。' },
  { id: 'guarded', label: '防护模式', hint: 'ZCode guarded 模式：普通工具自动执行，危险命令每次由你批准；独立审批仍保留。' },
  { id: 'full-access', label: '完全访问', hint: 'ZCode yolo 模式：自动放行普通工具，保留原生独立审批。' },
]
export const zcodeModelKey = (selection: ZCodeModelSelection): string => `zcode:${JSON.stringify([selection.providerId, selection.modelId])}`
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512))] : []

export function zcodeModel(option: any): ModelDef | undefined {
  const selection = sanitizeZCodeSelection(option?.ref)
  if (!selection || option.disabledReason) return undefined
  const levels = strings(option.reasoning?.levels?.map((level: any) => level?.value))
  const defaultThinking = levels.includes(option.reasoning?.defaultLevel) ? option.reasoning.defaultLevel : levels.at(-1)
  return { id: zcodeModelKey(selection), label: selection.modelId, zcodeProviderLabel: option.providerLabel || selection.providerId,
    zcodeSelection: selection, zcodeThoughtLevels: levels, thinkingOptions: levels, defaultThinking,
    efforts: ALL_EFFORTS.filter(level => levels.includes(level)),
    ...(ALL_EFFORTS.includes(defaultThinking as any) ? { defaultEffort: defaultThinking } : {}),
    imageInput: option.properties?.inputFormat?.supportsImage === true,
    ...(Number.isSafeInteger(option.contextWindow) && option.contextWindow > 0 ? { contextWindow: option.contextWindow } : {}) }
}

function labelZCodeModels(models: ModelDef[]): ModelDef[] {
  const counts = new Map<string, number>()
  for (const model of models) if (model.zcodeSelection) {
    const id = model.zcodeSelection.modelId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return models.map(model => {
    const selection = model.zcodeSelection
    if (!selection) return model
    return { ...model, label: counts.get(selection.modelId)! > 1
      ? `${selection.modelId} · ${model.zcodeProviderLabel || selection.providerId}` : selection.modelId }
  })
}

export function mergeZCodeConfig(base: any, next: any): any {
  if (next === undefined) return base
  if (!isRecord(next)) return next
  const result = isRecord(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(next)) result[key] = isRecord(value) ? mergeZCodeConfig(result[key], value) : value
  return result
}

/** Only model metadata leaves these local files; credentials and request headers stay in the engine. */
export async function readZCodeConfiguredModels(personalPath: string, builtinPath: string | undefined, fallback: ZCodeModelSelection): Promise<ModelDef[]> {
  const personal = JSON.parse(await readFile(personalPath, 'utf8'))?.config
  const builtin = builtinPath ? JSON.parse(await readFile(builtinPath, 'utf8'))?.config : {}
  const templates = builtin?.providerConfigRules?.templateRules ?? []
  const providers = new Map<string, any>()
  for (const rule of [...(builtin?.providerConfigRules?.providerRules ?? []), ...(personal?.providerConfigRules?.providerRules ?? [])]) {
    if (!isRecord(rule) || typeof rule.providerId !== 'string') continue
    const previous = providers.get(rule.providerId)
    providers.set(rule.providerId, { ...previous, ...rule, config: mergeZCodeConfig(previous?.config, rule.config) })
  }
  const models: ModelDef[] = []
  const managed = ZCODE_MODEL_SERVICES.some(service => fallback.providerId === `personal:uniagent-zcode-${service.id}`)
  for (const provider of providers.values()) {
    if (managed && provider.providerId !== fallback.providerId) continue
    const template = templates.find((item: any) => item.templateId === provider.templateId)
    const config = mergeZCodeConfig(template?.config, provider.config)
    if (provider.enabled === false || config?.visibility === 'hidden' || config?.access?.type === 'zhipu-account') continue
    const modelIds = strings([...(config?.builtinModelIds ?? []), ...(config?.personalModelIds ?? [])])
    const ordered = strings([...(config?.modelOrder ?? []).filter((id: string) => modelIds.includes(id)), ...modelIds])
    for (const modelId of ordered) {
      let metadata: any = {}
      const matches = (pattern: unknown, value: string, flags = '') => {
        if (typeof pattern !== 'string') return true
        try { return new RegExp(`^(?:${pattern})$`, flags).test(value) } catch { return false }
      }
      const rules = builtin?.modelConfigRules ?? {}
      let baseUrl = config?.api?.baseUrl ?? ''
      try { baseUrl = new URL(baseUrl).toString().replace(/\/+$/, '') } catch { /* No site rules for an invalid endpoint. */ }
      for (const group of ['modelRules', 'modelApiRules', 'providerSiteRules', 'templateModelRules', 'builtinProviderModelRules']) {
        for (const rule of rules[group] ?? []) {
          if (!isRecord(rule) || !matches(rule.modelMatch, modelId, 'i') || !matches(rule.apiTypeMatch, config?.api?.type ?? '')
            || !matches(rule.baseUrlMatch, baseUrl) || rule.templateId !== undefined && rule.templateId !== provider.templateId
            || rule.providerId !== undefined && rule.providerId !== provider.providerId || rule.modelId !== undefined && rule.modelId !== modelId) continue
          metadata = mergeZCodeConfig(metadata, rule.config)
        }
      }
      for (const rule of [...(personal?.modelConfigRules?.providerModelRules ?? []), ...(personal?.modelConfigRules?.manualProviderModelRules ?? [])]) {
        if (rule.providerId === provider.providerId && rule.modelId === modelId) metadata = mergeZCodeConfig(metadata, rule.config)
      }
      if (metadata.enabled === false) continue
      const levels = strings(metadata.optionSpecs?.reasoningLevel?.values)
      const ref = { providerId: provider.providerId, modelId }
      const isDefault = zcodeModelKey(ref) === zcodeModelKey(fallback)
      const model = zcodeModel({ ref: isDefault ? fallback : ref, providerLabel: provider.providerName,
        contextWindow: metadata.properties?.contextWindow, properties: metadata.properties,
        reasoning: { levels: levels.map(value => ({ value })), defaultLevel: isDefault ? fallback.options?.reasoningLevel ?? levels.at(-1) : levels.at(-1) } })
      if (model) models.push(model)
    }
  }
  if (!models.some(model => model.id === zcodeModelKey(fallback))) models.push(zcodeModel({ ref: fallback })!)
  return labelZCodeModels(models)
}

export function resolveZCodeSelection(config: Pick<SessionConfig, 'model' | 'effort' | 'zcodeModelSelection'>, models: ModelDef[], fallback: ZCodeModelSelection): ZCodeModelSelection {
  const explicit = sanitizeZCodeSelection(config.zcodeModelSelection)
  const matches = models.filter(model => model.id === config.model || model.zcodeSelection?.modelId === config.model)
  const model = config.model ? matches.find(model => explicit && model.id === zcodeModelKey(explicit)) ?? (matches.length === 1 ? matches[0] : undefined)
    : models.find(model => model.id === zcodeModelKey(explicit ?? fallback))
  if (!model?.zcodeSelection) throw new Error('ZCode 模型已不可用或存在同名 Provider，请重新选择')
  const base = explicit && zcodeModelKey(explicit) === model.id ? explicit
    : !config.model && model.id === zcodeModelKey(fallback) ? fallback : model.zcodeSelection
  const levels = model.thinkingOptions ?? []
  const level = config.effort ?? base.options?.reasoningLevel ?? model.defaultThinking
  if (level && levels.length && !levels.includes(level)) throw new Error('ZCode 所选模型不支持该思考深度')
  return { providerId: base.providerId, modelId: base.modelId, ...(level ? { options: { reasoningLevel: level } } : {}) }
}

export async function readZCodeModelCatalog(connection: ZCodeConnection, nativeSessionId: string, fallback: ZCodeModelSelection, configured: ModelDef[] = []): Promise<{models: ModelDef[]; selection: ZCodeModelSelection}> {
  const result = await connection.request<any>('session/read', { sessionId: nativeSessionId, deliveryKind: 'desktop-continuous', messageLimit: 1 })
  const current = sanitizeZCodeSelection(result?.settings?.model?.current)
  if (!current || current.providerId !== fallback.providerId || current.modelId !== fallback.modelId) throw new Error('ZCode 当前模型与配置的 Provider 身份不一致')
  const level = result.settings?.thoughtLevel?.current ?? current.options?.reasoningLevel ?? fallback.options?.reasoningLevel
  const selection = { ...current, ...(level ? { options: { reasoningLevel: level } } : {}) }
  const models = new Map(configured.map(model => [model.id, model]))
  for (const option of result.settings?.model?.available ?? []) {
    const model = zcodeModel(option)
    if (model) {
      if (!option.providerLabel && models.get(model.id)?.zcodeProviderLabel) model.zcodeProviderLabel = models.get(model.id)!.zcodeProviderLabel
      models.set(model.id, model)
    }
  }
  const key = zcodeModelKey(selection)
  const model = models.get(key) ?? zcodeModel({ ref: selection })!
  const levels = strings(result.settings?.thoughtLevel?.available?.map((option: any) => option.value))
  const defaultThinking = result.settings?.thoughtLevel?.defaultLevel ?? model.defaultThinking
  models.set(key, { ...model, zcodeSelection: selection, ...(result.settings?.thoughtLevel ? { thinkingOptions: levels, zcodeThoughtLevels: levels,
    defaultThinking, efforts: ALL_EFFORTS.filter(level => levels.includes(level)), defaultEffort: ALL_EFFORTS.includes(defaultThinking) ? defaultThinking : undefined } : {}) })
  return { models: labelZCodeModels([...models.values()]), selection }
}
export function zcodeSessionContract(state: ZCodeSnapshot, selection: ZCodeModelSelection, models: ModelDef[] = []): SessionAgentContract {
  return { models: models.length ? models : [zcodeModel({ ref: selection, reasoning: { levels: strings(state.config.thoughtLevels).map(value => ({ value })) } })!],
    currentModelId: zcodeModelKey(selection), permissionModes: ZCODE_PERMISSION_MODES,
    currentPermissionMode: (Object.keys(ZCODE_PERMISSION_VALUES) as Array<keyof typeof ZCODE_PERMISSION_VALUES>).find(mode => ZCODE_PERMISSION_VALUES[mode] === state.config.mode),
    imageAttachments: models.find(model => model.id === zcodeModelKey(selection))?.imageInput === true, fileAttachments: true, sessionList: false, sessionLoad: true, sessionResume: true,
    steer: false, followup: true, sessionFork: true, sessionForkAtTurn: true, crossAgentFork: false, sideChat: true,
    structuredSubagents: false, formElicitation: true, freeTextElicitation: true, nativeGoal: false, nativeReview: false,
    structuredUsage: true, capabilityInventory: false, additionalDirectoriesNew: false, additionalDirectoriesResume: false,
    commands: [], collaborationModes: ['default', 'plan'] }
}
