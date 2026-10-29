import type { ReasoningEffort } from './types.ts'

export type NativeCapabilitySource = 'provider-native'
export type McpStartupStatus = 'starting' | 'ready' | 'failed' | 'cancelled' | 'auth-required'
export type CollaborationModeId = 'default' | 'plan'
export type ComposerCommand = 'goal' | 'plan'

export interface NativeSkillCandidate {
  id: string
  kind: 'skill'
  name: string
  path: string
  description?: string
  enabled: boolean
}

export interface NativeMcpCandidate {
  id: string
  kind: 'mcp'
  name: string
  description?: string
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
  startupStatus: McpStartupStatus
  statusMessage?: string
  toolNames: string[]
}

export interface NativeMcpStatusChange {
  name: string
  status: McpStartupStatus
  statusMessage?: string
}

export interface NativeCapabilityChange {
  agentId: string
  workdir: string
  sessionId?: string
  mcpStatus?: NativeMcpStatusChange
}

export function withMcpStartupStatus(candidate: NativeMcpCandidate, change: NativeMcpStatusChange): NativeMcpCandidate {
  return candidate.authStatus === 'notLoggedIn' ? candidate : {
    ...candidate, startupStatus: change.status, statusMessage: change.statusMessage
  }
}

export interface NativeCommandCandidate {
  id: string
  kind: 'command'
  name: string
  command: string
  description?: string
}

export type NativeCandidate = NativeSkillCandidate | NativeMcpCandidate | NativeCommandCandidate

export interface CollaborationModePreset {
  id: CollaborationModeId
  name: string
  model: string | null
  reasoningEffort: ReasoningEffort | null
}

export interface NativeCapabilitySnapshot {
  agentId: string
  workdir: string
  source: NativeCapabilitySource
  candidates: NativeCandidate[]
  actions: { goal: boolean; review: boolean; plan: CollaborationModePreset | null }
  errors: string[]
}

export interface NativeCapabilityRequest {
  agentId: string
  workdir: string
  sessionId?: string
  force?: boolean
}

export interface NativeTurnSelectionRequest { candidateIds: string[] }

export interface ResolvedNativeTurnContext {
  skills: Array<{ name: string; path: string }>
  mcpServers: Array<{ name: string }>
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export interface GoalState {
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  continuation?: 'native'
  autonomous?: boolean
  nativeActivation?: 'armed' | 'disarmed'
  roundLimit?: { maxRounds: number | null; roundsStarted: number }
  blockedReason?: { code: string; message?: string }
}

export type NativeReviewScope =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom' }

export interface NativeReviewDraft { scope: NativeReviewScope; instructions?: string }

export type NativeGoalAction =
  | { type: 'goal.set'; objective: string; tokenBudget?: number; maxRounds?: number }
  | { type: 'goal.clear' }
  | ({ type: 'goal.update' } & NativeGoalUpdate)

export interface NativeGoalUpdate {
  action: 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear' | 'disarm'
  objective?: string
  tokenBudget?: number
  maxRounds?: number
  reason?: { code: string; message?: string }
}

export function parseNativeGoalAction(value: unknown): NativeGoalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_native_goal_action')
  }
  const dto = value as Record<string, unknown>
  if (dto.type === 'goal.clear') {
    if (Object.keys(dto).some((key) => key !== 'type')) {
      throw new Error('invalid_native_goal_action')
    }
    return { type: 'goal.clear' }
  }
  if (dto.type !== 'goal.set' && dto.type !== 'goal.update') {
    throw new Error('invalid_native_goal_action')
  }
  const fields = dto.type === 'goal.set'
    ? ['type', 'objective', 'tokenBudget', 'maxRounds']
    : ['type', 'action', 'objective', 'tokenBudget', 'maxRounds', 'reason']
  if (Object.keys(dto).some(key => !fields.includes(key)) ||
    (dto.objective !== undefined && (typeof dto.objective !== 'string' || !dto.objective.trim())) ||
    (dto.type === 'goal.set' && typeof dto.objective !== 'string')) {
    throw new Error('invalid_native_goal_action')
  }
  for (const key of ['tokenBudget', 'maxRounds']) {
    if (dto[key] !== undefined && (!Number.isSafeInteger(dto[key]) || (dto[key] as number) <= 0)) {
      throw new Error('invalid_native_goal_action')
    }
  }
  const changes = {
    ...(dto.objective === undefined ? {} : { objective: (dto.objective as string).trim() }),
    ...(dto.tokenBudget === undefined ? {} : { tokenBudget: dto.tokenBudget as number }),
    ...(dto.maxRounds === undefined ? {} : { maxRounds: dto.maxRounds as number })
  }
  if (dto.type === 'goal.set') return { type: 'goal.set', objective: dto.objective as string, ...changes }
  if (!['edit', 'pause', 'resume', 'complete', 'block', 'clear', 'disarm'].includes(dto.action as string) ||
    (dto.action === 'edit' ? Object.keys(changes).length === 0 : Object.keys(changes).length > 0) ||
    (dto.reason !== undefined && dto.action !== 'block')) {
    throw new Error('invalid_native_goal_action')
  }
  let reason: NativeGoalUpdate['reason']
  if (dto.reason !== undefined) {
    const row = dto.reason as Record<string, unknown>
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Object.keys(row).some(key => key !== 'code' && key !== 'message') ||
      typeof row.code !== 'string' || !row.code.trim() ||
      (row.message !== undefined && typeof row.message !== 'string')) {
      throw new Error('invalid_native_goal_action')
    }
    reason = { code: row.code.trim(), ...(row.message === undefined ? {} : { message: row.message as string }) }
  }
  return {
    type: 'goal.update', action: dto.action as NativeGoalUpdate['action'], ...changes,
    ...(reason === undefined ? {} : { reason })
  }
}

export type NativeReviewAction = { type: 'review.start'; draft: NativeReviewDraft }
export type NativeThreadAction = NativeGoalAction | NativeReviewAction

export function parseNativeThreadAction(value: unknown): NativeThreadAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_native_thread_action')
  }
  const dto = value as Record<string, unknown>
  if (dto.type === 'goal.set' || dto.type === 'goal.clear' || dto.type === 'goal.update') {
    try {
      return parseNativeGoalAction(value)
    } catch {
      throw new Error('invalid_native_thread_action')
    }
  }
  if (
    dto.type !== 'review.start' ||
    Object.keys(dto).some((key) => key !== 'type' && key !== 'draft') ||
    !dto.draft || typeof dto.draft !== 'object' || Array.isArray(dto.draft)
  ) {
    throw new Error('invalid_native_thread_action')
  }

  const rawDraft = dto.draft as Record<string, unknown>
  if (
    Object.keys(rawDraft).some((key) => key !== 'scope' && key !== 'instructions') ||
    !rawDraft.scope || typeof rawDraft.scope !== 'object' || Array.isArray(rawDraft.scope) ||
    (rawDraft.instructions !== undefined && typeof rawDraft.instructions !== 'string')
  ) {
    throw new Error('invalid_native_thread_action')
  }
  const rawScope = rawDraft.scope as Record<string, unknown>
  const instructions = typeof rawDraft.instructions === 'string'
    ? rawDraft.instructions.trim()
    : undefined
  let scope: NativeReviewScope
  if (
    rawScope.type === 'uncommittedChanges' &&
    Object.keys(rawScope).every((key) => key === 'type')
  ) {
    scope = { type: 'uncommittedChanges' }
  } else if (
    rawScope.type === 'baseBranch' &&
    Object.keys(rawScope).every((key) => key === 'type' || key === 'branch') &&
    typeof rawScope.branch === 'string' && rawScope.branch.trim()
  ) {
    scope = { type: 'baseBranch', branch: rawScope.branch.trim() }
  } else if (
    rawScope.type === 'commit' &&
    Object.keys(rawScope).every((key) => key === 'type' || key === 'sha' || key === 'title') &&
    typeof rawScope.sha === 'string' && rawScope.sha.trim() &&
    (rawScope.title === undefined || typeof rawScope.title === 'string')
  ) {
    scope = {
      type: 'commit',
      sha: rawScope.sha.trim(),
      ...(rawScope.title === undefined ? {} : { title: rawScope.title.trim() })
    }
  } else if (
    rawScope.type === 'custom' &&
    Object.keys(rawScope).every((key) => key === 'type') &&
    instructions
  ) {
    scope = { type: 'custom' }
  } else {
    throw new Error('invalid_native_thread_action')
  }

  return {
    type: 'review.start',
    draft: {
      scope,
      ...(instructions ? { instructions } : {})
    }
  }
}

export function nativeCandidateKey(candidate: NativeCandidate): string {
  return candidate.id
}

export function emptyNativeCapabilitySnapshot(agentId: string, workdir: string): NativeCapabilitySnapshot {
  return {
    agentId,
    workdir,
    source: 'provider-native',
    candidates: [],
    actions: { goal: false, review: false, plan: null },
    errors: []
  }
}
