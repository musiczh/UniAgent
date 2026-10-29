import type { AgentRole, ModelDef, PermissionModeDef, ReasoningEffort, SessionAgentContract, SessionConfig } from '../../shared/types.ts'
import type { ACPInitialize } from './acpTypes.ts'
import { mcodeModelLabel, MCODE_PERMISSION_VALUES, parseMCodeModelValue } from '../../shared/mcode.ts'
import type { MCodeCatalog, MCodeModelMeta } from '../mcodeCatalog.ts'

export type ACPProvider = 'grok' | 'kimi' | 'deepseek' | 'mcode'
export const ACP_PERMISSION_MODES: PermissionModeDef[] = [
  { id: 'ask', label: '请求批准', hint: 'Agent 发出标准 ACP 审批请求时，由你确认；工具是否请求审批由 Agent 原生策略决定。' },
  { id: 'full-access', label: '自动批准', hint: '自动批准 Agent 发出的 ACP 审批请求；原生安全策略仍生效。' }
]
export const DEEPSEEK_PERMISSION_MODES = ACP_PERMISSION_MODES
export const KIMI_PERMISSION_MODES = ACP_PERMISSION_MODES
/**
 * MiniMax Code exposes three permission tiers over ACP and rejects anything
 * else — there is no read-only tier, so we must not advertise one.
 */
export const MCODE_PERMISSION_MODES: PermissionModeDef[] = [
  { id: 'ask', label: '请求批准', hint: '需要授权的操作先请求你确认（MiniMax Code Ask）。' },
  { id: 'approve-for-me', label: '帮我批准', hint: '自动处理常规操作，必要时仍会请求确认（MiniMax Code Auto）。' },
  { id: 'full-access', label: '完全放开', hint: '跳过常规确认，适合已信任的任务与工作区（MiniMax Code Full access）。' }
]
// Retained for old callers; Web APIs are outside the stable ACP boundary.
export function supportsKimiWebRuntime(_version: unknown): boolean { return false }
export function stableACPRoleUnavailableReason(role: AgentRole): string | undefined {
  if (role.instructions?.trim()) return '稳定 ACP 不支持角色系统指令；配置已保留，请清空角色描述后保存，或改用支持此角色的 Agent。'
  if (role.skills !== undefined) return '稳定 ACP 不支持角色 Skills 筛选；配置已保留，请改为全部 Skills，或改用支持此策略的 Agent。'
  if (role.toolPolicy && (role.toolPolicy.mode === 'allow-only' || role.toolPolicy.tools.length > 0)) return '稳定 ACP 不支持角色工具限制；配置已保留，请继承 Agent 默认工具，或改用支持此策略的 Agent。'
  return undefined
}
export function assertACPProviderConfig(provider: ACPProvider, config: SessionConfig): void {
  const reason = config.roleSnapshot && stableACPRoleUnavailableReason(config.roleSnapshot)
  if (reason) throw new Error(reason)
  const allowed = provider === 'mcode' ? MCODE_PERMISSION_MODES : ACP_PERMISSION_MODES
  if (config.permissionMode && !allowed.some(mode => mode.id === config.permissionMode)) {
    throw new Error(provider === 'mcode'
      ? 'MiniMax Code 仅支持“请求批准”“帮我批准”“完全放开”三档权限；配置已保留，请重新选择后继续。'
      : '稳定 ACP 无法保证原有权限限制；配置已保留，请重新选择“请求批准”或“自动批准”后继续。')
  }
  if (config.fastMode) throw new Error('稳定 ACP 不支持 Fast 模式')
  if (config.maxMode && provider !== 'mcode') throw new Error('稳定 ACP 不支持 Max 模式')
}
export function acpLaunchArgs(provider: ACPProvider, _config: SessionConfig): string[] {
  if (provider === 'deepseek') return ['--profile', 'acp']
  if (provider === 'kimi') return ['acp']
  // MiniMax Code exposes the ACP server as `mcode acp`; it accepts no
  // workspace/permission flags, so the working directory comes from the
  // spawn cwd and the session parameters.
  if (provider === 'mcode') return ['acp']
  return ['--no-auto-update', 'agent', '--no-leader', 'stdio']
}
export function acpSelectValues(value: unknown): any[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => Array.isArray(entry?.options) ? acpSelectValues(entry.options) : typeof entry?.value === 'string' && entry.value ? [entry] : [])
}

/** Reasoning levels UniAgent can express; the native "default" tier means "provider decides". */
const REASONING_EFFORT_VALUES: ReasoningEffort[] = ['off','low','medium','high','xhigh','max','ultra']
function toReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && (REASONING_EFFORT_VALUES as string[]).includes(value) ? value as ReasoningEffort : undefined
}

/**
 * MiniMax Code advertises one ACP entry per (model, thinking variant). The
 * native catalog decides which of those combinations exist and which model
 * accepts a reasoning level, so the projection mirrors the catalog instead of
 * stamping the current model's levels onto every entry.
 */
function projectMCodeModels(
  entries: any[],
  currentModelId: string | undefined,
  nativeLevels: ReasoningEffort[],
  nativeThinking: string | undefined,
  catalog: MCodeCatalog | undefined,
  imageInput: boolean
): ModelDef[] {
  const projected = entries.map(entry => {
    const value = typeof entry?.value === 'string' ? entry.value : ''
    const parsed = parseMCodeModelValue(value)
    const meta: MCodeModelMeta | undefined = parsed ? catalog?.models.get(parsed.modelId) : undefined
    // The runtime advertises the "no thinking" variant with an empty slot.
    const thinkingOff = parsed?.variant === ''
    const catalogEfforts = (meta?.effortOptions || []).map(toReasoningEffort).filter((item): item is ReasoningEffort => item !== undefined)
    const efforts = thinkingOff
      ? []
      : catalogEfforts.length
        ? catalogEfforts
        : value === currentModelId ? nativeLevels : []
    const nativeDefault = nativeThinking && efforts.includes(nativeThinking as ReasoningEffort) ? nativeThinking as ReasoningEffort : undefined
    const catalogDefault = meta?.defaultEffort ? toReasoningEffort(meta.defaultEffort) : undefined
    const defaultEffort = nativeDefault || (catalogDefault && efforts.includes(catalogDefault) ? catalogDefault : undefined)
    return {
      id: value,
      label: entry?.name || mcodeModelLabel(value) || value,
      efforts,
      imageInput,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
      ...(meta?.maxContextWindow ? { maxContextWindow: meta.maxContextWindow } : {}),
      ...(meta?.supportsMax ? { supportsMax: true } : {}),
      __meta: meta,
      __thinkingOff: thinkingOff
    }
  })
  // A model that forces thinking on has no "no thinking" variant in the native
  // app, so UniAgent must not offer one either. The active entry always stays
  // visible, otherwise the picker would lose its selection.
  return projected
    .filter(entry => !(entry.__thinkingOff && entry.__meta?.thinkingMode === 'forced_on' && entry.id !== currentModelId))
    .map(({ __meta, __thinkingOff, ...rest }) => rest)
}

export function acpOption(response: any, category: 'model' | 'thought_level' | 'mode'): any | undefined {
  const options = Array.isArray(response?.configOptions) ? response.configOptions.filter((x: any) => x?.type === 'select') : []
  const ids = category === 'model' ? ['model'] : category === 'thought_level' ? ['reasoning_effort','thinking'] : ['mode']
  return options.find((x: any) => x.category === category) || options.find((x: any) => ids.includes(x.id))
}
export function advertisedACPCapability(value: unknown): boolean { return !!value && typeof value === 'object' && !Array.isArray(value) }
/**
 * MiniMax Code advertises its private `mcode/*` extension surface through
 * `initialize._meta["minimax-code/extensions"]`. Every extended capability is
 * gated on that advertisement so a CLI build without the extension simply
 * hides the feature instead of failing at call time.
 */
export function mcodeExtensionMethods(initialize: ACPInitialize | undefined): string[] {
  const extensions = (initialize as any)?._meta?.['minimax-code/extensions']
  return Array.isArray(extensions?.methods) ? extensions.methods.filter((x: unknown): x is string => typeof x === 'string') : []
}
export function mcodeSupportsExtension(initialize: ACPInitialize | undefined, method: string): boolean {
  return mcodeExtensionMethods(initialize).includes(method)
}
export function projectACPContract(provider: ACPProvider, initialize: ACPInitialize, response: any, config: SessionConfig, commands: string[] = [], catalog?: MCodeCatalog): SessionAgentContract {
  const caps = initialize.agentCapabilities
  const model = acpOption(response, 'model'), thinking = acpOption(response, 'thought_level')
  const levels = acpSelectValues(thinking?.options).map(entry => entry.value)
  // MiniMax Code advertises a "default" thinking level that is not a reasoning
  // effort; it means "let the provider decide" and must not collapse the list.
  const efforts = levels.filter((x): x is ReasoningEffort => ['off','low','medium','high','xhigh','max','ultra'].includes(x))
  const currentModelId = typeof model?.currentValue === 'string' ? model.currentValue : undefined
  const entries = acpSelectValues(model?.options)
  const models: ModelDef[] = provider === 'mcode'
    ? projectMCodeModels(entries, currentModelId, efforts, thinking?.currentValue, catalog, caps?.promptCapabilities?.image === true)
    : entries.map(entry => ({ id:entry.value,
      label: entry.name || entry.value,
      efforts:provider === 'kimi' ? [] : efforts, defaultEffort:efforts.includes(thinking?.currentValue) ? thinking.currentValue : undefined, imageInput:caps?.promptCapabilities?.image === true,
      ...(provider === 'kimi' && levels.length && entry.value === currentModelId ? { thinkingOptions:levels, defaultThinking:thinking?.currentValue } : {}) }))
  const modeIds = Array.isArray(response?.modes?.availableModes) ? response.modes.availableModes.map((x: any) => x?.id) : acpSelectValues(acpOption(response,'mode')?.options).map(x => x.value)
  if (provider === 'mcode') {
    // MiniMax Code is the first ACP provider that can actually deliver the
    // advanced gates: it advertises fork, and its `mcode/*` extension carries
    // strict steering, native goals and plan review.
    const permissionModes = MCODE_PERMISSION_MODES.map(x => ({ ...x }))
    const allowed = new Set(permissionModes.map(mode => mode.id))
    const currentPermissionMode = config.permissionMode && allowed.has(config.permissionMode as any) ? config.permissionMode : 'ask'
    return {
      models, currentModelId, permissionModes, currentPermissionMode,
      imageAttachments: caps?.promptCapabilities?.image === true,
      fileAttachments: caps?.promptCapabilities?.embeddedContext === true,
      sessionList: advertisedACPCapability(caps?.sessionCapabilities?.list),
      sessionLoad: caps?.loadSession === true,
      sessionResume: advertisedACPCapability(caps?.sessionCapabilities?.resume) || caps?.loadSession === true,
      steer: mcodeSupportsExtension(initialize, 'mcode/session/steer'),
      followup: true,
      sessionFork: advertisedACPCapability(caps?.sessionCapabilities?.fork),
      sessionForkAtTurn: false,
      crossAgentFork: false,
      sideChat: false,
      structuredSubagents: false,
      formElicitation: true,
      freeTextElicitation: true,
      nativeGoal: mcodeSupportsExtension(initialize, 'mcode/session/goal/get'),
      nativeReview: false,
      structuredUsage: false,
      capabilityInventory: false,
      additionalDirectoriesNew: advertisedACPCapability(caps?.sessionCapabilities?.additionalDirectories),
      additionalDirectoriesResume: advertisedACPCapability(caps?.sessionCapabilities?.additionalDirectories),
      commands: [...commands],
      collaborationModes: modeIds.includes('plan') ? ['default','plan'] : ['default']
    }
  }
  return {
    models, currentModelId, permissionModes:ACP_PERMISSION_MODES.map(x => ({...x})), currentPermissionMode:config.permissionMode || 'ask',
    imageAttachments:caps?.promptCapabilities?.image === true, fileAttachments:caps?.promptCapabilities?.embeddedContext === true,
    sessionList:advertisedACPCapability(caps?.sessionCapabilities?.list), sessionLoad:caps?.loadSession === true, sessionResume:advertisedACPCapability(caps?.sessionCapabilities?.resume) || caps?.loadSession === true,
    steer:false, followup:true, sessionFork:false, sessionForkAtTurn:false, crossAgentFork:false, sideChat:false,
    structuredSubagents:false, formElicitation:false, freeTextElicitation:false, nativeGoal:false, nativeReview:false, structuredUsage:false, capabilityInventory:false,
    additionalDirectoriesNew:advertisedACPCapability(caps?.sessionCapabilities?.additionalDirectories), additionalDirectoriesResume:advertisedACPCapability(caps?.sessionCapabilities?.additionalDirectories), commands:[...commands], collaborationModes:modeIds.includes('plan') ? ['default','plan'] : ['default']
  }
}
