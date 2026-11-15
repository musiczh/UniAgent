import type { Session, UAEvent } from './types'

export type TaskPhase = 'active' | 'standby' | 'archived'
export interface TaskDecisionHint { count: number; priority: 'high' | 'medium' }
export interface TaskStateSummary { phase: TaskPhase; version: number; updatedAt: number; awaitingAcceptance: boolean; decisionHint?: TaskDecisionHint; error?: string }
/** Historical report shape retained for reading existing task records. */
export interface DeliveryInput {
  operationId: string
  resultVersion: number
  inputRevision: string
  summary: string
  deliverables: string[]
  verification: { passed: string[]; failed: string[]; unverified: string[] }
}
export interface DeliveryReport extends DeliveryInput { source: 'agent' | 'user'; createdAt: number }
export interface TaskLifecycleEvent { id: string; ts: number; title: string; text?: string; resultVersion?: number }
export interface TaskLifecycleRecord {
  formatVersion: 1
  taskId: string
  version: number
  phase: TaskPhase
  previousPhase?: 'active' | 'standby'
  inputRevision: string
  delivery?: DeliveryReport
  decisionHint?: TaskDecisionHint
  userDecision?: TaskUserDecision
  reports: DeliveryReport[]
  history: TaskLifecycleEvent[]
  operations: Array<{ id: string; fingerprint: string }>
}
export interface TaskLifecycleSnapshot { record: TaskLifecycleRecord; inputRevision: string; turnRevision: string; busy: boolean; pendingDecisions: number }
export interface TaskDecisionInput { actionId: string; expectedVersion: number; inputRevision: string; turnRevision: string; disposition: 'standby' | 'archive' }
export interface TaskUserDecision { actionId: string; inputRevision: string; turnRevision: string; disposition: 'standby' | 'archive' }

/** Persisted decoration identity survives native transcript re-numbering. */
export function taskInputRevision(session: Session): string {
  const latest = session.submittedUserMessages?.findLast(message => !message.automaticRecovery)
  return JSON.stringify([latest ? [latest.userOrdinal, latest.textHash, latest.acceptedAt] : null,
    (session.pendingQueue || []).filter(item => item.state === 'pending').map(item => item.id)])
}

export function taskTurnRevision(session: Session, events: readonly UAEvent[] = []): string {
  const latest = events.findLast(event => event.sessionId === session.id && ['user_message', 'goal_message', 'turn_started', 'turn_completed', 'agent_message', 'error'].includes(event.type))
  return JSON.stringify([taskInputRevision(session), session.status, session.recovery?.chainId, session.recovery?.phase,
    latest ? [latest.seq, latest.type, latest.state, latest.payload.turnId, latest.payload.text, latest.payload.message] : null])
}

/** A native reply ends a round, but only the user decides to defer or finish work. */
export function taskHasEndedRound(session: Session): boolean {
  if (session.recovery && session.recovery.phase !== 'stopped') return false
  return ['completed', 'error', 'interrupted', 'cancelled'].includes(session.status) || session.status === 'idle' &&
    !!(session.nativeSessionId || session.submittedUserMessages?.some(message => !message.automaticRecovery) || session.taskRegistration?.delivery === 'dispatched')
}

export function taskStateSummary(record: TaskLifecycleRecord): TaskStateSummary {
  return { phase: record.phase, version: record.version, updatedAt: record.history.at(-1)?.ts || 0, awaitingAcceptance: false, decisionHint: record.decisionHint }
}

export function validateDelivery(value: unknown): DeliveryInput {
  const input = value as DeliveryInput
  const text = (s: unknown, max: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= max
  const lines = (s: unknown): s is string[] => Array.isArray(s) && s.length <= 30 && s.every(line => text(line, 4000))
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operationId','resultVersion','inputRevision','summary','deliverables','verification'].includes(key)) ||
    !text(input.operationId, 128) || !Number.isSafeInteger(input.resultVersion) || input.resultVersion < 1 || !text(input.inputRevision, 32000) ||
    !text(input.summary, 4000) || !lines(input.deliverables) || !input.deliverables.length || !input.verification ||
    Object.keys(input.verification).some(key => !['passed','failed','unverified'].includes(key)) ||
    !lines(input.verification.passed) || !lines(input.verification.failed) || !lines(input.verification.unverified) ||
    ![...input.verification.passed, ...input.verification.failed, ...input.verification.unverified].length) throw new Error('交付材料无效：请填写摘要、交付项与通过/失败/未验证记录')
  return structuredClone(input)
}
