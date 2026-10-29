import type { AgentDef, AgentRole } from '../shared/types.ts'

/** The first installed CLI whose public skills/hooks protocol we verified. */
export function supportsClaudeRoleProtocol(version: string | undefined): boolean {
  const parsed = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/)
  const parts = parsed?.slice(1).map(Number)
  return !!parts && (parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 296))))
}

export function claudeRoleUnavailableReason(agent: AgentDef, role: AgentRole): string | undefined {
  if (agent.adapter !== 'claude' || (role.skills === undefined && !role.toolPolicy)) return undefined
  if (!supportsClaudeRoleProtocol(agent.version)) {
    return 'Claude 角色技能和工具限制需要已验证的 CLI 2.1.296 或更高版本'
  }
  if (role.skills?.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name))) {
    return 'Claude 角色技能白名单需要原生技能名称'
  }
  if (role.toolPolicy?.mode === 'allow-only' && role.toolPolicy.tools.some((name) => !/^(?:[A-Za-z][A-Za-z0-9]*|mcp__[A-Za-z0-9_.:-]+)$/.test(name))) {
    return 'Claude 工具白名单需要精确工具名称，不能使用权限规则或通配符'
  }
  return undefined
}
