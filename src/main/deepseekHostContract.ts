import { ALL_EFFORTS, type PermissionModeDef, type SessionAgentContract, type SessionConfig } from '../shared/types.ts'
import { stableACPRoleUnavailableReason } from './acp/acpProvider.ts'

export const DEEPSEEK_HOST_PERMISSION_VALUES = {
  ask: 'workspace-write', 'full-access': 'danger-full-access', 'approve-for-me': 'auto', 'read-only': 'read-only'
} as const
const permissionDefinitions: PermissionModeDef[] = [
  { id: 'ask', label: '请求批准', hint: '使用 Harness workspace-write 沙箱，越界操作由原生策略请求批准。' },
  { id: 'full-access', label: '完全访问', hint: '使用 Harness danger-full-access 与 never 策略，工具无需逐次批准。' },
  { id: 'approve-for-me', label: '帮我批准', hint: '由 Harness Auto review 审查操作；仅在当前 Host 启用此集成时可用。' },
  { id: 'read-only', label: '只读', hint: '使用当前 Host 提供的只读权限预设。' }
]
export function deepseekHostPermissionModes(catalog: any): PermissionModeDef[] {
  if (!Array.isArray(catalog?.options) || !catalog.options.length) throw new Error('DeepSeek Host 权限目录无效')
  return catalog.options.map((option: any) => {
    const definition = permissionDefinitions.find(mode => DEEPSEEK_HOST_PERMISSION_VALUES[mode.id as keyof typeof DEEPSEEK_HOST_PERMISSION_VALUES] === option?.value)
    if (!definition) throw new Error('当前 UniAgent 尚不支持 Host 提供的权限预设，无法确认权限范围。')
    return { ...definition, hint: typeof option.description === 'string' && option.description ? option.description : definition.hint }
  })
}

export function assertDeepSeekHostConfig(config: SessionConfig): void {
  // Role system/tool restrictions need a Host composition, not prompt injection.
  const reason = config.roleSnapshot && stableACPRoleUnavailableReason(config.roleSnapshot)
  if (reason) throw new Error(reason)
  if (config.permissionMode && !Object.hasOwn(DEEPSEEK_HOST_PERMISSION_VALUES, config.permissionMode)) throw new Error('DeepSeek Host 不支持所选权限模式')
  if (config.fastMode || config.maxMode) throw new Error('DeepSeek Host 不支持 Fast / Max 模式')
}
export function deepseekHostContract(catalog: any, config: SessionConfig, permissions: unknown, commands: string[] = []): SessionAgentContract {
  if (!Array.isArray(catalog?.groups)) throw new Error('DeepSeek Host 模型目录无效')
  const models = catalog.groups.flatMap((group: any) => (group.models || []).map((model: any) => {
    const efforts = (model.reasoning?.efforts || []).map((row: any) => row.id).filter((id: any) => ALL_EFFORTS.includes(id))
    return { id: JSON.stringify([group.id, model.id]), label: model.name || model.id, efforts,
      defaultEffort: efforts.includes(model.reasoning?.defaultEffort) ? model.reasoning.defaultEffort : undefined }
  }))
  return {
    models, currentModelId: config.model || (catalog.default ? JSON.stringify([catalog.default.provider, catalog.default.model]) : undefined),
    permissionModes: deepseekHostPermissionModes(permissions), currentPermissionMode: config.permissionMode || 'ask',
    imageAttachments: true, fileAttachments: true, sessionList: true, sessionLoad: true, sessionResume: true,
    steer: true, followup: true, sessionFork: true, sessionForkAtTurn: false, crossAgentFork: false, sideChat: false,
    structuredSubagents: false, formElicitation: true, freeTextElicitation: true, nativeGoal: false,
    nativeReview: false, structuredUsage: true, capabilityInventory: false,
    additionalDirectoriesNew: false, additionalDirectoriesResume: false, commands,
    collaborationModes: commands.includes('plan') ? ['default', 'plan'] : ['default']
  }
}
