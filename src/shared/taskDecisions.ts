import type { Session, UAEvent } from './types'
import { asInteractionRequest, isPendingInteraction, withPlanText } from './interactionRequests'
import { isMcpToolApproval } from './questions'

export const TASK_IPC = { decisions: 'task:decisions', resolve: 'task:resolve', state: 'task:state', decide: 'task:decide', board: 'task:board', changed: 'task:changed' } as const
export interface TaskDecision {
  id: string
  version: string
  type: 'question' | 'approval' | 'plan' | 'exception'
  priority: 'high' | 'medium'
  blocking: boolean
  requestId?: string
  event?: UAEvent
  title: string
  detail?: string
  status: 'open' | 'submitting' | 'unknown'
}
export interface TaskDecisionAnswer { id: string; version: string; actionId: string; answer: unknown }

export function isNativeTaskDecision(decision: TaskDecision): boolean {
  return decision.type === 'question' || decision.type === 'approval' || decision.type === 'plan'
}

export function decisionIdentity(event: UAEvent, source: 'main' | 'side' = 'main'): string {
  const request = asInteractionRequest(event)
  return JSON.stringify([event.sessionId, source, request.payload.requestId, event.seq, event.payload.turnId ?? event.payload.teamRevision ?? null])
}

/** Exact source revision, including native choices; never trust renderer-supplied actions. */
export function decisionVersion(event: UAEvent): string {
  return JSON.stringify([event.seq, event.state, event.payload])
}

export function projectTaskDecisions(session: Session, main: readonly UAEvent[], side: readonly UAEvent[] = []): TaskDecision[] {
  if (session.archived) return []
  const result: TaskDecision[] = []
  for (const [source, events] of [['main', main], ['side', side]] as const) {
    const requests = new Map<string, UAEvent>()
    for (const event of events) {
      if (event.sessionId !== session.id) continue
      const request = asInteractionRequest(event)
      if (request.type === 'approval_request' && typeof request.payload.requestId === 'string') requests.set(request.payload.requestId, request)
    }
    for (const request of requests.values()) {
      if (!isPendingInteraction(request)) continue
      const event = withPlanText(request, [...events])
      const question = event.payload.kind === 'question' || event.payload.kind === 'elicitation' && !isMcpToolApproval(event.payload.params)
      const plan = event.payload.kind === 'planMode'
      const state = event.payload.taskResponseState
      result.push({ id: decisionIdentity(event, source), version: decisionVersion(event), type: question ? 'question' : plan ? 'plan' : 'approval',
        priority: 'high', blocking: event.payload.delivery !== 'async',
        requestId: (source === 'side' ? 'side:' : '') + event.payload.requestId,
        event, title: question ? '需要回答' : plan ? '方案待确认' : '需要审批', status: state === 'submitting' || state === 'unknown' ? state : 'open' })
    }
  }
  const recovery = session.recovery
  const lastInput = main.findLast(event => event.sessionId === session.id && (event.type === 'user_message' || event.type === 'turn_started'))?.seq ?? -1
  const failure = main.findLast(event => event.sessionId === session.id && event.seq > lastInput && event.type === 'error' && event.state === 'failed' && !event.payload.recoveryIntermediate)
  if (session.status === 'error' || session.status === 'interrupted') {
    if (!recovery || recovery.phase === 'stopped') {
      const identity = recovery?.chainId || failure?.seq || session.updatedAt || session.createdAt
      result.push({ id: JSON.stringify([session.id, 'exception', identity]), version: JSON.stringify([identity, recovery?.attempts, recovery?.reason, session.status]),
        type: 'exception', priority: 'medium', blocking: true, title: '异常需要处理', status: 'open',
        detail: recovery?.reason || failure?.payload.message || '执行已中断。请查看原对话，确认原因后继续任务。', event: failure })
    }
  }
  return result.sort((a, b) => Number(a.priority !== 'high') - Number(b.priority !== 'high') || (a.event?.ts ?? Number.MAX_SAFE_INTEGER) - (b.event?.ts ?? Number.MAX_SAFE_INTEGER))
}
