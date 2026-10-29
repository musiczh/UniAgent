import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  AgentDef,
  AgentRole,
  AgentRoleCatalogEntry,
  SessionConfig
} from '../shared/types.ts'
import { usesAppServer } from './appServerAdapter.ts'
import { copyAgentRole } from './roleStore.ts'
import { stableACPRoleUnavailableReason } from './acp/acpProvider.ts'
import { isACPAdapter } from './acp/acpAdapters.ts'
import { kimiRoleUnavailableReason } from './kimiRoleConfig.ts'
import { claudeRoleUnavailableReason } from './claudeRoleConfig.ts'

function roleModel(role: AgentRole, agent: AgentDef) {
  const id = role.model || agent.defaultModel || agent.models[0]?.id
  const exact = agent.models.find(model => model.id === id)
  if (exact || agent.adapter !== 'zcode') return exact
  const legacy = agent.models.filter(model => model.zcodeSelection?.modelId === id)
  return legacy.length === 1 ? legacy[0] : undefined
}

export function zcodeRoleSelection(role: AgentRole, agent: AgentDef) {
  const model = roleModel(role, agent)
  if (!model?.zcodeSelection) return undefined
  return { ...model.zcodeSelection, ...(role.zcodeThinking ? { options: { reasoningLevel: role.zcodeThinking } } : {}) }
}

export interface ResolveAgentRoleInvocationInput {
  roleId: string
  roles: readonly AgentRole[]
  agents: readonly AgentDef[]
  callerSessionWorkdir?: string
  callerWorkdir?: string
  callerSessionProjectId?: string
  callerProjectId?: string
}

export function buildAgentRoleCatalog(
  roles: readonly AgentRole[],
  agents: readonly AgentDef[]
): AgentRoleCatalogEntry[] {
  return roles.map((role) => {
    const unavailableReason = agentRoleUnavailableReason(role, agents)
    return {
      role: copyAgentRole(role),
      executable: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {})
    }
  })
}

export function resolveAgentRoleInvocation(input: ResolveAgentRoleInvocationInput): {
  agent: AgentDef
  config: SessionConfig
} {
  const role = input.roles.find((candidate) => candidate.id === input.roleId)
  if (!role) throw new Error(`unknown_role: ${input.roleId}`)
  const unavailableReason = agentRoleUnavailableReason(role, input.agents)
  if (unavailableReason) throw new Error(unavailableReason)
  const agent = input.agents.find((candidate) => candidate.id === role.agentId)!
  const projectId = role.projectId || input.callerSessionProjectId || input.callerProjectId
  const workdir = firstExistingDirectory(
    role.workdir,
    input.callerSessionWorkdir,
    input.callerWorkdir
  )
  if (!projectId && !workdir) throw new Error('role_project_unavailable')
  return {
    agent,
    config: {
      agentId: role.agentId,
      ...(role.model ? { model: role.model } : {}),
      ...(role.effort ? { effort: role.effort } : {}),
      ...(role.kimiThinking ? { kimiThinking: role.kimiThinking } : {}),
      ...(agent.adapter === 'zcode' ? { zcodeModelSelection: zcodeRoleSelection(role, agent) } : {}),
      permissionMode: role.permissionMode,
      ...(projectId ? { projectId } : {}),
      workdir: workdir || '',
      roleSnapshot: copyAgentRole(role)
    }
  }
}

export function agentRoleUnavailableReason(
  role: AgentRole,
  agents: readonly AgentDef[]
): string | undefined {
  const agent = agents.find((candidate) => candidate.id === role.agentId)
  if (
    !agent ||
    agent.installed === false ||
    agent.incompatible ||
    (agent.lifecycle && agent.lifecycle.availability !== 'available') ||
    agent.adapter === 'generic'
  ) return `role_agent_unavailable: ${role.agentId}`

  const model = roleModel(role, agent)
  if (role.model && !model) return `role_model_unavailable: ${role.model}`
  if (role.effort) {
    if (!agent.capabilities.reasoningEffort || !model || !model.efforts.includes(role.effort)) {
      return `role_effort_unsupported: ${role.effort}`
    }
  }
  if (role.kimiThinking && (agent.adapter !== 'kimi' || !model?.thinkingOptions?.includes(role.kimiThinking))) return `role_thinking_unsupported: ${role.kimiThinking}`
  if (role.zcodeThinking && (agent.adapter !== 'zcode' || !model?.thinkingOptions?.includes(role.zcodeThinking))) return `role_thinking_unsupported: ${role.zcodeThinking}`
  if (!agent.capabilities.permissionModes.some((mode) => mode.id === role.permissionMode)) {
    return `role_permission_unsupported: ${role.permissionMode}`
  }
  if (role.workdir && (!isAbsolute(role.workdir) || !isDirectory(role.workdir))) {
    return `role_workdir_invalid: ${role.workdir}`
  }
  if (agent.adapter === 'kimi') return kimiRoleUnavailableReason(role)
  if (isACPAdapter(agent.adapter)) return stableACPRoleUnavailableReason(role)
  if (agent.adapter === 'zcode') {
    if (role.instructions?.trim()) return 'role_instructions_unsupported'
    if (role.skills !== undefined) return 'role_skills_unsupported'
    if (role.toolPolicy) return 'role_tool_policy_unsupported'
    return undefined
  }
  if (agent.adapter === 'claude') return claudeRoleUnavailableReason(agent, role)
  if (role.instructions?.trim() && agent.adapter !== 'codex' && agent.adapter !== 'traex') {
    return 'role_instructions_unsupported'
  }
  if (role.skills !== undefined) return 'role_skills_unsupported'
  if (role.toolPolicy) {
    if (role.toolPolicy.tools.length === 0) {
      return role.toolPolicy.mode === 'deny-only'
        ? undefined
        : 'role_tool_policy_empty_allow_unsupported'
    }
    if (agent.adapter === 'traex' && !usesAppServer(agent)) return undefined
    return 'role_tool_policy_unsupported'
  }
  return undefined
}

function firstExistingDirectory(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && isAbsolute(candidate) && isDirectory(candidate)) return candidate
  }
  return undefined
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}
