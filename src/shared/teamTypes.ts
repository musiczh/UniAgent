import type { AgentRole, Attachment, PermissionMode, SessionWorktree, UAEvent, WorkspaceSelection } from './types'

export interface TeamMember { id: string; sourceRoleId?: string; role: AgentRole }
export interface TeamLimits { concurrency: number; maxAssignments: number; taskMinutes: number; runMinutes: number }
export interface TeamDefinition {
  id: string
  revision: number
  name: string
  description: string
  rules: string
  leaderMemberId: string
  members: TeamMember[]
  limits: TeamLimits
  status: 'draft' | 'active' | 'archived'
  createdAt: number
  updatedAt: number
}
export type TeamDefinitionInput = Omit<TeamDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string; revision?: number }
export interface TeamBinding { teamProjectId: string; memberId: string }
export type TeamProjectStatus = 'initializing' | 'ready' | 'running' | 'waiting_members' | 'waiting_user' | 'stopping' | 'interrupted' | 'failed' | 'completed'
export type TeamAssignmentStatus = 'queued' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted'
export interface TeamArtifact { id: string; title: string; path?: string; text?: string; assignmentId?: string; createdAt: number; snapshot?: boolean; sha256?: string; sourcePath?: string }
export interface TeamReview { decision: 'accept' | 'rework'; reason: string; reviewedAt: number }
export interface TeamAttempt { attempt: number; status: TeamAssignmentStatus; title?: string; dispatchedAt?: number; permissionMode?: PermissionMode; result?: string; error?: string; turnId?: string; requestId?: string; requestFingerprint?: string; artifactRefs?: string[]; review?: TeamReview; endedAt?: number }
export interface TeamAssignment {
  id: string; runId: number; memberId: string; requestId: string; requestFingerprint: string
  title: string; prompt: string; contextRefs: string[]; expectedOutput: string; permissionMode?: PermissionMode
  status: TeamAssignmentStatus; attempt: number; history: TeamAttempt[]
  turnId?: string; startSeq?: number; result?: string; candidateResult?: string; question?: string
  summary: string; error?: string; artifactRefs: string[]
  createdAt: number; dispatchedAt?: number; startedAt?: number; endedAt?: number; activeMs: number; lastTick?: number
  review?: TeamReview
}
export interface TeamInboxItem {
  eventId: string; seq: number; runId: number; assignmentId?: string; attempt?: number
  kind: 'result' | 'blocked' | 'interaction' | 'user' | 'recovery' | 'progress'
  summary: string; resultRef?: string; state: 'pending' | 'delivered' | 'consumed'
  attachments?: Attachment[]
}
export interface TeamQuestion { id: string; prompt: string; answer?: string; resolved?: boolean }
export interface TeamDecisionQuestion {
  id: string; question: string; type: 'single' | 'multi' | 'text'
  options?: Array<{ label: string; description?: string }>
  required?: boolean; minItems?: number; maxItems?: number
}
export interface TeamDecisionMaterial { artifactId: string; questionId?: string; optionLabel?: string }
export interface TeamInteraction {
  id: string; revision: number; kind: 'native_question' | 'native_approval' | 'leader_question'
  runId: number; memberId: string; sessionId: string; assignmentId?: string; attempt?: number
  requestId?: string; event?: UAEvent; questions?: TeamQuestion[]
  state: 'pending' | 'answered' | 'cancelled' | 'expired'; answer?: unknown; createdAt: number
  decision?: { title: string; purpose: 'information' | 'decision' | 'design'; questions: TeamDecisionQuestion[]; materials: TeamDecisionMaterial[] }
  requestFingerprint?: string
}
export interface TeamFinalResult { deliveredAt?: number; summary: string; artifactRefs: string[]; acceptedFindings: string[]; unresolvedDisagreements: string[]; validationGaps: string[] }
export interface TeamCommunication {
  id: string; requestId: string; requestFingerprint: string; runId: number
  memberId: string; sessionId: string; assignmentId: string; attempt: number; turnId?: string
  message: string; state: 'sending' | 'sent' | 'failed' | 'unknown'; error?: string
  createdAt: number; settledAt?: number
}
export interface TeamProject {
  id: string; revision: number; name: string; goal: string; spaceId: string; requirementId?: string
  spaceRoots: string[]; teamId: string; team: TeamDefinition
  worktree?: SessionWorktree
  memberSessions: Record<string, string>; runId: number; status: TeamProjectStatus
  phase: string; summary: string; sharedContext: { brief: string; decisions: string[]; openQuestions: string[] }
  assignments: TeamAssignment[]; inbox: TeamInboxItem[]; inboxSeq: number; handledInboxSeq: number
  interactions: TeamInteraction[]; artifacts: TeamArtifact[]
  communications?: TeamCommunication[]
  messages: Array<{ id: string; memberId?: string; text: string; createdAt: number; runId?: number; interactionId?: string; kind: 'user' | 'leader'; attachments?: Attachment[] }>
  finalResult?: TeamFinalResult; previousResults: Array<{ runId: number; result: TeamFinalResult }>
  createdAt: number; updatedAt: number; archivedAt?: number; error?: string; activeMs: number
  leaderStartSeq?: number; lastTerminalSeq?: Record<string, number>
  activeSince?: number
  sessionMode?: 'leader'
  legacyMessagesArchived?: boolean
}
export interface TeamCatalog { teams: TeamDefinition[]; projects: TeamProject[]; errors: string[]; unavailableReasons?: Record<string, string> }
export interface TeamCreateProjectInput { teamId: string; spaceId: string; requirementId?: string; prompt: string; attachments?: Attachment[]; workspaceSelection?: WorkspaceSelection }
export const DEFAULT_TEAM_RULES = '用户只与 Leader 对话。Leader 负责组织、派发、回答成员业务问题与验收交付；成员是工具，不直接要求用户管理。需要用户决策时先提供可查看材料，再合并提问。真实权限授权由用户处理。最终通过普通回复交付结论和文件，并登记团队完成状态。'
export const DEFAULT_TEAM_LIMITS: TeamLimits = { concurrency: 0, maxAssignments: 0, taskMinutes: 0, runMinutes: 0 }
export const TEAM_IPC = { catalog: 'team:catalog', save: 'team:save', delete: 'team:delete', createRole: 'team:createRole', createProject: 'team:createProject', send: 'team:send', stop: 'team:stop', resume: 'team:resume', archive: 'team:archive', rename: 'team:rename', session: 'team:session', respond: 'team:respond', changed: 'team:changed', artifact: 'team:artifact' } as const
