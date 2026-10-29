import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentRole, PermissionMode, ReasoningEffort } from '../shared/types.ts'
import { PERMISSION_MODE_IDS } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'

const PERMISSION_MODES = new Set<PermissionMode>(PERMISSION_MODE_IDS)
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ROLE_FIELDS = new Set([
  'id',
  'name',
  'agentId',
  'model',
  'effort',
  'kimiThinking',
  'zcodeThinking',
  'permissionMode',
  'projectId',
  'workdir',
  'instructions',
  'skills',
  'toolPolicy'
])

/** Independent persisted store for MCP-callable Agent roles. */
export class RoleStore {
  private readonly file: string

  constructor(fileOverride?: string) {
    this.file = fileOverride || join(resolveUserDataHome(), 'roles.json')
  }

  list(): AgentRole[] {
    try {
      if (!existsSync(this.file)) return []
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.flatMap((value) => {
        const role = parseAgentRole(value)
        return role ? [role] : []
      })
    } catch {
      return []
    }
  }

  /** Upsert by stable id; a new system id is minted only when id is blank. */
  save(input: AgentRole): AgentRole[] {
    const next = prepareAgentRoleInput(input)
    const roles = this.list()
    const index = roles.findIndex((candidate) => candidate.id === next.id)
    if (index >= 0) roles[index] = next
    else roles.push(next)
    this.writeAll(roles)
    return roles.map(copyAgentRole)
  }

  remove(id: string): AgentRole[] {
    if (typeof id !== 'string' || !ROLE_ID.test(id)) throw new TypeError('invalid_role_id')
    const roles = this.list().filter((role) => role.id !== id)
    this.writeAll(roles)
    return roles.map(copyAgentRole)
  }

  private writeAll(roles: AgentRole[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(roles, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* absent or already renamed */ }
      throw error
    }
  }
}

export function prepareAgentRoleInput(input: AgentRole): AgentRole {
  if (!input || typeof input !== 'object') throw new TypeError('invalid_role')
  const suppliedId = typeof input.id === 'string' ? input.id.trim() : ''
  if (suppliedId && !ROLE_ID.test(suppliedId)) throw new TypeError('invalid_role_id')
  const role = { ...input, id: suppliedId || `role_${randomUUID()}` }
  const parsed = parseAgentRole(role)
  if (!parsed) throw new TypeError('invalid_role')
  return parsed
}

function isAgentRole(value: unknown): value is AgentRole {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const role = value as Record<string, unknown>
  if (Object.keys(role).some((key) => !ROLE_FIELDS.has(key))) return false
  if (typeof role.id !== 'string' || !ROLE_ID.test(role.id)) return false
  if (typeof role.name !== 'string' || !role.name.trim()) return false
  if (typeof role.agentId !== 'string' || !role.agentId.trim()) return false
  if (typeof role.permissionMode !== 'string' || !PERMISSION_MODES.has(role.permissionMode as PermissionMode)) return false
  if (role.model !== undefined && (typeof role.model !== 'string' || !role.model.trim())) return false
  if (role.kimiThinking !== undefined && (typeof role.kimiThinking !== 'string' || !role.kimiThinking.trim() || role.kimiThinking.length > 100)) return false
  if (role.zcodeThinking !== undefined && (typeof role.zcodeThinking !== 'string' || !role.zcodeThinking.trim() || role.zcodeThinking.length > 100)) return false
  if (role.effort !== undefined &&
      (typeof role.effort !== 'string' || !REASONING_EFFORTS.has(role.effort as ReasoningEffort))) return false
  if (role.projectId !== undefined && (typeof role.projectId !== 'string' || !role.projectId.trim())) return false
  if (role.workdir !== undefined && (typeof role.workdir !== 'string' || !role.workdir.trim())) return false
  if (role.instructions !== undefined && typeof role.instructions !== 'string') return false
  if (role.skills !== undefined &&
      (!Array.isArray(role.skills) || role.skills.some((skill) => typeof skill !== 'string' || !skill.trim()))) return false
  if (role.toolPolicy !== undefined) {
    if (!role.toolPolicy || typeof role.toolPolicy !== 'object' || Array.isArray(role.toolPolicy)) return false
    const policy = role.toolPolicy as Record<string, unknown>
    if (policy.mode !== 'allow-only' && policy.mode !== 'deny-only') return false
    if (!Array.isArray(policy.tools) || policy.tools.some((tool) => typeof tool !== 'string' || !tool.trim())) return false
  }
  return true
}

export function parseAgentRole(value: unknown): AgentRole | undefined {
  return isAgentRole(value) ? copyAgentRole(value) : undefined
}

export function copyAgentRole(role: AgentRole): AgentRole {
  return {
    id: role.id,
    name: role.name,
    agentId: role.agentId,
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.effort !== undefined ? { effort: role.effort } : {}),
    ...(role.kimiThinking !== undefined ? { kimiThinking: role.kimiThinking } : {}),
    ...(role.zcodeThinking !== undefined ? { zcodeThinking: role.zcodeThinking } : {}),
    permissionMode: role.permissionMode,
    ...(role.projectId !== undefined ? { projectId: role.projectId } : {}),
    ...(role.workdir !== undefined ? { workdir: role.workdir } : {}),
    ...(role.instructions !== undefined ? { instructions: role.instructions } : {}),
    ...(role.skills !== undefined ? { skills: [...role.skills] } : {}),
    ...(role.toolPolicy !== undefined
      ? { toolPolicy: { mode: role.toolPolicy.mode, tools: [...role.toolPolicy.tools] } }
      : {})
  }
}
