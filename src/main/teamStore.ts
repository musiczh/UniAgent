import { existsSync, statSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { atomicWriteFile, atomicWriteFileSync } from './sessionStore'
import { mkdir } from 'node:fs/promises'
import { resolveUserDataHome } from './userData'
import { parseAgentRole, prepareAgentRoleInput } from './roleStore'
import { parseSessionWorktree } from './worktreeService'
import type { TeamArtifact, TeamCatalog, TeamDefinition, TeamDefinitionInput, TeamProject } from '../shared/teamTypes'

export const teamId = (prefix: string): string => `${prefix}_${randomUUID()}`
export function teamText(value: unknown, label: string, limit = 32000, required = true): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`invalid_${label}`)
  return value.trim()
}
export function teamRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_team_input')
  return value as Record<string, any>
}
export function teamKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('unexpected_team_field')
}
export function prepareTeam(input: TeamDefinitionInput, prior?: TeamDefinition): TeamDefinition {
  const value = teamRecord(input)
  teamKeys(value, ['id', 'revision', 'name', 'description', 'rules', 'leaderMemberId', 'members', 'limits', 'status'])
  if (prior && input.revision !== prior.revision) throw new Error('revision_conflict')
  if (!Array.isArray(value.members) || value.members.length > 16) throw new Error('invalid_team_members')
  const members = value.members.map((raw: unknown) => {
    const m = teamRecord(raw)
    teamKeys(m, ['id', 'sourceRoleId', 'role'])
    return { id: teamText(m.id, 'member_id', 128), ...(m.sourceRoleId ? { sourceRoleId: teamText(m.sourceRoleId, 'role_id', 128) } : {}), role: prepareAgentRoleInput(m.role) }
  })
  if (new Set(members.map(m => m.id)).size !== members.length || new Set(members.map(m => m.role.name)).size !== members.length) throw new Error('duplicate_team_member')
  const status = value.status
  if (!['draft', 'active', 'archived'].includes(status)) throw new Error('invalid_team_status')
  const leaderMemberId = teamText(value.leaderMemberId, 'leader_member_id', 128, false)
  if (status === 'active' && (members.length < 2 || !members.some(m => m.id === leaderMemberId))) throw new Error('team_requires_one_leader_and_member')
  const limits = teamRecord(value.limits)
  teamKeys(limits, ['concurrency', 'maxAssignments', 'taskMinutes', 'runMinutes'])
  for (const [key, max] of Object.entries({ concurrency: 16, maxAssignments: 100, taskMinutes: 180, runMinutes: 720 })) {
    if (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > max) throw new Error(`invalid_team_limit_${key}`)
  }
  return { id: prior?.id || teamId('team'), revision: (prior?.revision || 0) + 1, name: teamText(value.name, 'team_name', 100), description: teamText(value.description, 'team_description', 4000, false), rules: teamText(value.rules, 'team_rules'), leaderMemberId, members, limits: { concurrency: limits.concurrency, maxAssignments: limits.maxAssignments, taskMinutes: limits.taskMinutes, runMinutes: limits.runMinutes }, status, createdAt: prior?.createdAt || Date.now(), updatedAt: Date.now() }
}

function validateSavedTeam(t: TeamDefinition): void {
  if (!/^team_[a-z0-9-]+$/i.test(t.id) || !Number.isInteger(t.revision) || t.revision < 1) throw new Error('invalid_saved_team')
  const { createdAt, updatedAt, ...input } = t
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error('invalid_team_timestamp')
  prepareTeam(input, t)
}

export class TeamStore {
  private root: string
  private teams = new Map<string, TeamDefinition>()
  private projects = new Map<string, TeamProject>()
  private errors: string[] = []
  constructor(root = resolveUserDataHome()) {
    this.root = root
    this.load()
  }
  private load(): void {
    const file = join(this.root, 'teams.json')
    if (existsSync(file)) {
      try {
        const list = JSON.parse(readFileSync(file, 'utf8'))
        if (!Array.isArray(list)) throw new Error('invalid_teams_file')
        const loaded = new Map<string, TeamDefinition>()
        for (const t of list) {
          if (!t || typeof t.id !== 'string' || !Number.isInteger(t.revision) || !Array.isArray(t.members) || t.members.some((m: any) => !parseAgentRole(m.role))) throw new Error('invalid_saved_team')
          validateSavedTeam(t)
          if (loaded.has(t.id)) throw new Error('duplicate_saved_team')
          loaded.set(t.id, t)
        }
        this.teams = loaded
      } catch (e) { this.errors.push(`teams.json: ${String(e)}`) }
    }
    const dir = join(this.root, 'team-projects')
    if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => /^tp_[a-z0-9-]+.json$/i.test(n))) {
      try {
        const p = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (!p || name !== p.id + '.json' || !Array.isArray(p.assignments) || !p.memberSessions || !Array.isArray(p.inbox) || !Array.isArray(p.interactions) || !p.team?.members?.every((m: any) => parseAgentRole(m.role))) throw new Error('invalid_team_project')
        validateSavedTeam(p.team)
        for (const key of ['revision', 'runId', 'inboxSeq', 'handledInboxSeq', 'activeMs', 'createdAt', 'updatedAt']) if (!Number.isFinite(p[key]) || p[key] < 0) throw new Error('invalid_project_number')
        for (const key of ['artifacts', 'messages', 'previousResults', 'spaceRoots']) if (!Array.isArray(p[key])) throw new Error('invalid_project_collection')
        if (!p.sharedContext || !Array.isArray(p.sharedContext.decisions) || !Array.isArray(p.sharedContext.openQuestions) || typeof p.sharedContext.brief !== 'string') throw new Error('invalid_shared_context')
        if (!['initializing', 'ready', 'running', 'waiting_members', 'waiting_user', 'stopping', 'interrupted', 'failed', 'completed'].includes(p.status)) throw new Error('invalid_project_status')
        if (p.assignments.some((a: any) => !a || typeof a.id !== 'string' || !Array.isArray(a.history) || !Array.isArray(a.contextRefs) || !Array.isArray(a.artifactRefs) || !Number.isInteger(a.attempt))) throw new Error('invalid_assignment')
        if (Object.entries(p.memberSessions).some(([id, sid]) => !p.team.members.some((m: any) => m.id === id) || typeof sid !== 'string')) throw new Error('invalid_session_binding')
        p.communications ??= []
        if (!Array.isArray(p.communications) || p.communications.some((c: any) => !c || typeof c.id !== 'string' || typeof c.requestId !== 'string' || typeof c.message !== 'string' || !['sending', 'sent', 'failed', 'unknown'].includes(c.state) || !Number.isInteger(c.attempt) || !Number.isInteger(c.runId) || !Number.isFinite(c.createdAt))) throw new Error('invalid_communications')
        if (p.requirementId !== undefined && typeof p.requirementId !== 'string') throw new Error('invalid_requirement_id')
        if (p.worktree !== undefined) {
          const worktree = parseSessionWorktree(p.worktree)
          if (!worktree || worktree.projectId !== p.spaceId) throw new Error('invalid_project_worktree')
          p.worktree = worktree
        }
        this.projects.set(p.id, p)
      } catch (e) { this.errors.push(`${name}: ${String(e)}`) }
    }
  }
  catalog(): TeamCatalog { return structuredClone({ teams: [...this.teams.values()], projects: [...this.projects.values()], errors: this.errors }) }
  /** Shallow, read-only project view for cheap indexing; callers must not mutate it. */
  projectList(): readonly TeamProject[] { return [...this.projects.values()] }
  team(id: string): TeamDefinition { const t = this.teams.get(id); if (!t) throw new Error('team_not_found'); return structuredClone(t) }
  project(id: string): TeamProject { const p = this.projects.get(id); if (!p) throw new Error('team_project_not_found'); return structuredClone(p) }
  snapshotArtifact(projectId: string, source: { title: string; path?: string; text?: string }): TeamArtifact {
    this.project(projectId)
    const id = teamId('artifact')
    if (source.path && statSync(source.path).size > 32 * 1024 * 1024) throw new Error('invalid_material_size')
    const data = source.path ? readFileSync(source.path) : Buffer.from(source.text || '')
    if (!data.length || data.length > 32 * 1024 * 1024) throw new Error('invalid_material_size')
    const artifact: TeamArtifact = { id, title: source.title, snapshot: true, sha256: createHash('sha256').update(data).digest('hex'), createdAt: Date.now() }
    if (source.path) {
      const dir = join(this.root, 'team-materials', projectId, id)
      mkdirSync(dir, { recursive: true })
      artifact.path = join(dir, basename(source.path))
      artifact.sourcePath = source.path
      writeFileSync(artifact.path, data, { flag: 'wx', mode: 0o600 })
    } else artifact.text = source.text
    return artifact
  }
  verifySnapshot(projectId: string, artifact: TeamArtifact): void {
    if (!artifact.snapshot) throw new Error('not_material_snapshot')
    if (artifact.path && artifact.path !== join(this.root, 'team-materials', projectId, artifact.id, basename(artifact.path))) throw new Error('invalid_material_path')
    const data = artifact.path ? readFileSync(artifact.path) : Buffer.from(artifact.text || '')
    if (createHash('sha256').update(data).digest('hex') !== artifact.sha256) throw new Error('material_changed')
  }
  saveTeam(input: TeamDefinitionInput): TeamDefinition {
    if (this.errors.some(e => e.startsWith('teams.json:'))) throw new Error('teams_file_damaged')
    const prior = input.id ? this.team(input.id) : undefined
    const next = prepareTeam(input, prior)
    const list = [...this.teams.values()].filter(t => t.id !== next.id).concat(next)
    mkdirSync(this.root, { recursive: true })
    atomicWriteFileSync(join(this.root, 'teams.json'), JSON.stringify(list, null, 2))
    this.teams.set(next.id, next)
    return structuredClone(next)
  }
  saveProject(project: TeamProject, semantic = true): TeamProject {
    if (!/^tp_[a-z0-9-]+$/i.test(project.id)) throw new Error('invalid_team_project_id')
    const dir = join(this.root, 'team-projects')
    mkdirSync(dir, { recursive: true })
    const next = structuredClone(project)
    if (semantic) { next.revision += 1; next.updatedAt = Date.now() }
    atomicWriteFileSync(join(dir, next.id + '.json'), JSON.stringify(next, null, 2))
    this.projects.set(next.id, next)
    return structuredClone(next)
  }
  async saveRecoveredProject(project: TeamProject): Promise<TeamProject> {
    if (!/^tp_[a-z0-9-]+$/i.test(project.id)) throw new Error('invalid_team_project_id')
    const dir = join(this.root, 'team-projects')
    await mkdir(dir, { recursive: true })
    const next = structuredClone(project)
    next.revision += 1; next.updatedAt = Date.now()
    await atomicWriteFile(join(dir, next.id + '.json'), JSON.stringify(next, null, 2))
    this.projects.set(next.id, next)
    return structuredClone(next)
  }
  deleteProject(id: string): void {
    this.project(id)
    rmSync(join(this.root, 'team-materials', id), { recursive: true, force: true })
    unlinkSync(join(this.root, 'team-projects', id + '.json'))
    this.projects.delete(id)
  }
  deleteTeam(id: string, revision: number): void {
    if (this.errors.some(e => e.startsWith('teams.json:'))) throw new Error('teams_file_damaged')
    if (this.team(id).revision !== revision) throw new Error('revision_conflict')
    atomicWriteFileSync(join(this.root, 'teams.json'), JSON.stringify([...this.teams.values()].filter(t => t.id !== id), null, 2))
    this.teams.delete(id)
  }
  change(id: string, edit: (p: TeamProject) => void): TeamProject { const p = this.project(id); edit(p); return this.saveProject(p) }
}
