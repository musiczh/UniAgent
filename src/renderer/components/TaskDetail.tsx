import { useRef, useState, type ReactNode } from 'react'
import type { Session, UAEvent } from '@shared/types'
import { TASK_EXECUTION_LABELS } from '@shared/task'
import { taskHasEndedRound } from '@shared/taskLifecycle'
import { isTaskTitleEligible } from '@shared/taskTitle'
import { isSessionBusy, type SessionActivityStatus } from '@shared/sessionStatus'
import { isNativeTaskDecision } from '@shared/taskDecisions'
import { TurnStatusActionsContext, TurnStatusBar } from './EventStream'
import { SessionConversation } from './SessionConversation'
import { TaskDecisions, useTaskDecisions } from './TaskDecisions'
import { useTaskLifecycle } from './TaskDelivery'
import { QuickReplyComposerContext } from './QuickReplyComposerContext'
import './taskDetail.css'
import './workspaceBrowser.css'

/** Keep task actions and quick replies around the original conversation/composer. */
export function SessionTaskContent({ session, status, events, loading, children, composer, onArchived, onOpenFile }: {
  session: Session; status?: SessionActivityStatus; events: UAEvent[]; loading?: boolean; children?: ReactNode; composer?: ReactNode
  onArchived?: () => void; onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const host = useRef<HTMLElement>(null)
  const [replySelection, setReplySelection] = useState<{ sessionId: string; text: string; nonce: number }>()
  const replyNonce = useRef(0)
  const active = isTaskTitleEligible(session)
  const decisions = useTaskDecisions(session.id, active, session.status)
  const lifecycle = useTaskLifecycle(session, active)
  const snapshot = active && lifecycle.snapshot?.record.taskId === session.id ? lifecycle.snapshot : null
  const executionStatus = status || session.status
  const native = decisions.items.filter(isNativeTaskDecision)
  const sideRequests = native.filter(item => item.requestId?.startsWith('side:'))
  const busy = isSessionBusy(executionStatus) || snapshot?.busy || !!session.recovery && session.recovery.phase !== 'stopped'
  const record = snapshot?.record
  const archived = session.archived || record?.phase === 'archived'
  const standby = record?.phase === 'standby'
  const failed = executionStatus === 'error' || executionStatus === 'interrupted' || executionStatus === 'cancelled'
  const canDecide = !session.readOnly && active && !archived && !busy && !native.length && !!snapshot && !snapshot.pendingDecisions && !record?.decisionHint?.count && !session.taskState?.error && session.taskRegistration?.delivery !== 'unknown' && !loading && (taskHasEndedRound(session) || standby)
  const error = decisions.items.find(item => item.type === 'exception')?.detail || events.findLast(event => event.sessionId === session.id && event.type === 'error' && !event.payload.recoveryIntermediate)?.payload.message
  async function decide(disposition: 'standby' | 'archive'): Promise<void> {
    try { await lifecycle.decide(disposition); if (disposition === 'archive') onArchived?.() } catch { /* The controller keeps the actionable error in place. */ }
  }
  function selectReply(text: string): void { setReplySelection({ sessionId: session.id, text, nonce: ++replyNonce.current }) }
  const decisionActions = active && !archived && !busy && !native.length && (taskHasEndedRound(session) || standby)
    ? <div className="task-decision-actions">{!failed && canDecide && !lifecycle.pending && !standby && <button className="scope-button" onClick={() => { void decide('standby') }}>暂存</button>}<button className="scope-button primary" disabled={!canDecide || lifecycle.pending} onClick={() => { void decide('archive') }}>{failed ? '关闭任务' : '完成'}</button>{!failed && !!composer && session.quickReplies?.map((reply, index) => <button type="button" key={reply.text} className="scope-button quick-reply" disabled={!!session.readOnly || lifecycle.pending} aria-label={reply.text} aria-describedby={`quick-reply-${session.id}-${index}`} onClick={() => selectReply(reply.text)}><span>{reply.label}</span><span className="quick-reply-tooltip" id={`quick-reply-${session.id}-${index}`} role="tooltip">{reply.text}</span></button>)}</div>
    : null
  return <section className="session-task-content" aria-label="任务对话" data-task-id={session.id} ref={host}>
    {active && <div className="task-decision-notices">
      {(lifecycle.error || session.taskState?.error || decisions.error) && <p className="scope-error" role="alert">{lifecycle.error || session.taskState?.error || decisions.error}<button onClick={() => { lifecycle.refresh(); decisions.refresh() }}>刷新状态</button></p>}
      {session.taskRegistration?.delivery === 'unknown' && <p className="task-attention" role="status">首条输入的交付结果待确认，请先核对原对话，系统不会自动重发。</p>}
      {archived && <div className="task-standby"><p className="task-detail-muted">任务已归档，历史保留。恢复后可继续原任务。</p><button className="scope-button" disabled={lifecycle.pending || !!session.readOnly} onClick={() => { void lifecycle.archive(false) }}>恢复任务</button></div>}
      {standby && !archived && <p className="task-detail-muted task-standby">已暂定，任务保留在待推进。可在下方继续输入。</p>}
      {failed && !archived && <p className="task-current-error" role="alert">{error || TASK_EXECUTION_LABELS[executionStatus]}</p>}
    </div>}
    <div className="task-shared-conversation">{children || <SessionConversation events={events} status={executionStatus} sessionId={session.id} readOnly={session.readOnly} onOpenFile={onOpenFile}/>}</div>
    {!!sideRequests.length && <div className="task-decision-extra"><p className="task-detail-muted">侧边对话待处理</p><TaskDecisions session={session} items={sideRequests} error={decisions.error} onRefresh={decisions.refresh} onOpenConversation={() => host.current?.querySelector<HTMLElement>('.composer-input')?.focus()}/></div>}
    <div className="task-shared-composer" hidden={!!archived}><QuickReplyComposerContext.Provider value={{ sessionId: session.id, selection: replySelection?.sessionId === session.id ? replySelection : undefined, onConsumed: nonce => setReplySelection(current => current?.nonce === nonce ? undefined : current) }}><TurnStatusActionsContext.Provider value={decisionActions}>{composer || (decisionActions && <TurnStatusBar events={events} status={executionStatus}/>)}</TurnStatusActionsContext.Provider></QuickReplyComposerContext.Provider></div>
  </section>
}
