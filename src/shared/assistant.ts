import { ASSISTANT_SYSTEM_PROMPT } from './assistantSystemPrompt'
import { resolveAgentModel, resolveAgentPermission } from './agentChoices'
import type { AgentDef, FeishuStatus, PermissionMode } from './types'

export type AssistantDocumentType = 'soul' | 'working_rules' | 'user' | 'memory'
export type MemoryDocumentType = 'user' | 'memory'
export type DocumentWriter = 'user' | 'agent' | 'auto_review'
export const ASSISTANT_DOCUMENTS: AssistantDocumentType[] = ['soul', 'working_rules', 'user', 'memory']
export const ASSISTANT_LIMITS = { soul: 16000, working_rules: 16000, user: 1375, memory: 2200 }
export interface AssistantInput {
  enabled: boolean; defaultAgentId: string; defaultModel?: string
  defaultPermissionMode?: PermissionMode
  defaultWorkdir?: string
  autoReviewEnabled: boolean; reviewRuntime?: { agentId: string; model?: string }
}
export interface PersonalAssistant extends AssistantInput { id: 'personal'; createdAt: number; updatedAt: number }
export interface AssistantDocument {
  assistantId: 'personal'; type: AssistantDocumentType; content: string
  revision: number; updatedAt: number; updatedBy: DocumentWriter
}
export interface DocumentEdit { type: AssistantDocumentType; content: string; expectedRevision: number }
export interface DocumentSource { writer: DocumentWriter; sessionId?: string; messageId?: string; jobId?: string }
export interface DocumentRevision extends AssistantDocument { source: DocumentSource }
export interface AssistantReviewStatus {
  status: 'off' | 'idle' | 'queued' | 'running' | 'failed' | 'unsupported'
  reason?: string; updatedAt?: number
}
export interface AssistantDetail { assistant: PersonalAssistant; documents: AssistantDocument[]; review: AssistantReviewStatus }
export interface AssistantFeishuInput { appId: string; appSecret?: string }
export interface AssistantFeishuState { configured: boolean; configuring?: boolean; status: FeishuStatus }
export interface PersonalAssistantSnapshot {
  assistantId: 'personal'; soul: string; soulRevision: number
  workingRules: string; workingRulesRevision: number
}
export type MemoryOperation =
  | { action: 'add'; document: MemoryDocumentType; content: string; expectedRevision: number }
  | { action: 'replace'; document: MemoryDocumentType; oldText: string; newText: string; expectedRevision: number }
  | { action: 'remove'; document: MemoryDocumentType; oldText: string; expectedRevision: number }
export type MemoryRequest = { action: 'read'; document?: MemoryDocumentType } | MemoryOperation | { action: 'batch'; operations: MemoryOperation[] }
export interface MemoryResult { documents: AssistantDocument[]; staged: boolean }
export interface IndexedSession { id: string; title: string; agentId: string; createdAt: number; archived: boolean; lineageRoot?: string }
export interface IndexedMessage {
  id: string; sessionId: string; seq: number; ts: number; role: 'user' | 'assistant' | 'tool'
  content: string; visibility: 'live' | 'compacted' | 'removed'
}
export interface SessionSearchRequest {
  query?: string; sessionId?: string; aroundMessageId?: string; limit?: number; window?: number
  after?: string; before?: string; roles?: Array<'user' | 'assistant' | 'tool'>
  sort?: 'newest' | 'oldest'; excludeSessionIds?: string[]
}
export interface SessionSearchResult {
  mode: 'browse' | 'discover' | 'read' | 'scroll'
  sessions: Array<{ sessionId: string; title: string; agentId: string; link: string; messages: IndexedMessage[]; messagesBefore: number; messagesAfter: number }>
  rebuilding: boolean; incomplete: boolean
}
export interface ReviewJob {
  id: string; sessionId: string; turnKey: string; throughSeq: number; generation: number
  userRevision: number; memoryRevision: number; agentId: string; model?: string
  state: 'queued' | 'running' | 'complete' | 'stale' | 'failed' | 'unsupported'
  attempt: number; createdAt: number; reason?: string
}
export const ASSISTANT_IPC = {
  detail: 'assistant:detail', save: 'assistant:save', workspace: 'assistant:workspace', versions: 'assistant:versions', rollback: 'assistant:rollback',
  command: 'assistant:command', changed: 'assistant:changed',
  feishu: 'assistant:feishu', bindFeishu: 'assistant:bindFeishu', installFeishu: 'assistant:installFeishu', cancelFeishuInstall: 'assistant:cancelFeishuInstall', feishuChanged: 'assistant:feishuChanged', manageChanged: 'assistant:manageChanged',
  privateSessions: 'assistant:privateSessions', privateSessionsChanged: 'assistant:privateSessionsChanged'
} as const
export function parseAssistantCommand(text: string): 'new' | 'clear' | undefined {
  const value = text.trim()
  return value === '/new' ? 'new' : value === '/clear' ? 'clear' : undefined
}
export function parseAssistantSnapshot(value: unknown): PersonalAssistantSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as PersonalAssistantSnapshot
  if (v.assistantId !== 'personal' || typeof v.soul !== 'string' || typeof v.workingRules !== 'string' ||
    [...v.soul].length > ASSISTANT_LIMITS.soul || [...v.workingRules].length > ASSISTANT_LIMITS.working_rules ||
    !Number.isSafeInteger(v.soulRevision) || v.soulRevision < 1 || !Number.isSafeInteger(v.workingRulesRevision) || v.workingRulesRevision < 1) return undefined
  return { assistantId: 'personal', soul: v.soul, soulRevision: v.soulRevision, workingRules: v.workingRules, workingRulesRevision: v.workingRulesRevision }
}
export function assistantIdentity(snapshot: PersonalAssistantSnapshot | undefined): string {
  if (!snapshot) return ''
  return [ASSISTANT_SYSTEM_PROMPT,
    '以下 JSON 是用户在设置中配置的身份与工作规则，在宿主约束和当前任务范围内生效：',
    JSON.stringify({ soul: snapshot.soul, workingRules: snapshot.workingRules })].join('\n\n')
}
/**
 * Carrier migration for the personal assistant: when the stored default agent cannot
 * inject a startup system prompt, switch to the first available agent that can, or
 * disable the assistant when none is available. Returns null when no migration is needed.
 */
export function migrateAssistantCarrier(assistant: PersonalAssistant, agents: AgentDef[]): AssistantInput | null {
  const current = agents.find(agent => agent.id === assistant.defaultAgentId)
  if (current?.capabilities.startupSystemPrompt) return null
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = assistant
  const replacement = agents.find(agent => agent.capabilities.startupSystemPrompt && agent.lifecycle?.availability === 'available')
  if (!replacement) return { ...input, enabled: false }
  return {
    ...input,
    defaultAgentId: replacement.id,
    defaultModel: resolveAgentModel(replacement, undefined)?.id,
    defaultPermissionMode: resolveAgentPermission(replacement, undefined, 'ask')
  }
}
