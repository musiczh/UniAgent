import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRole, SessionConfig } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'

export const KIMI_PERMISSION_VALUES = { ask: 'manual', 'full-access': 'yolo', unattended: 'auto' } as const

export function kimiRoleUnavailableReason(role: AgentRole): string | undefined {
  if (role.instructions?.trim()) return 'Kimi Web 尚未应用角色系统指令，请使用无角色会话或支持此能力的 Agent。'
  if (role.skills !== undefined) return 'Kimi Web 不支持角色 Skills 强白名单。'
  if (role.toolPolicy && (role.toolPolicy.mode === 'allow-only' || role.toolPolicy.tools.length)) return 'Kimi Web 暂未开放角色工具策略。'
}
export function assertKimiWebConfig(config: SessionConfig): void {
  const reason = config.roleSnapshot && kimiRoleUnavailableReason(config.roleSnapshot)
  if (reason) throw new Error(reason)
  if (config.additionalDirectories?.length) throw new Error('Kimi Web 不支持会话独立的附加目录，请使用项目工作目录。')
  if (config.permissionMode && !Object.hasOwn(KIMI_PERMISSION_VALUES, config.permissionMode)) throw new Error('Kimi Web 请选择“请求批准”“按需询问”或“全部自动”，Plan 使用协作模式切换。')
  if (config.fastMode || config.maxMode) throw new Error('Kimi Web 不支持 Fast / Max 模式。')
}
export function kimiSessionRuntimeEnv(_sessionId: string, config: SessionConfig): NodeJS.ProcessEnv {
  // Reading an old session must remain possible even if its execution policy
  // cannot be represented by the current Web contract.
  return config.kimiDataHome ? { KIMI_CODE_HOME: config.kimiDataHome } : {}
}
/** Cleanup only the previously managed profile when its local session is deleted. */
export function deleteKimiRoleRuntime(sessionId: string): void {
  if (!sessionId) throw new Error('role_runtime_session_id_required')
  rmSync(join(resolveUserDataHome(), 'kimi', 'session-homes', createHash('sha256').update(sessionId).digest('hex')), { recursive:true, force:true })
}
