import type { ComponentProps, ReactNode } from 'react'
import type { RecoveryProgress } from '@shared/sessionRecovery'
import { SessionRecoveryStatus } from './SessionRecoveryStatus'
import { EventStream, ReadOnlyConversationContext } from './EventStream'
import { TeamAssignmentDisplayContext, type TeamAssignmentDisplayContextValue } from './TeamAssignmentCard'

/** The same transcript body is used by ordinary sessions and team role sessions. */
export function SessionConversation({ loading, loadError, onRetryLoad, readOnly = false, teamAssignmentContext, children, workspaceNotice, recovery, ...stream }: ComponentProps<typeof EventStream> & { loading?: boolean; loadError?: string; onRetryLoad?: () => void; readOnly?: boolean; teamAssignmentContext?: TeamAssignmentDisplayContextValue; children?: ReactNode; workspaceNotice?: string; recovery?: RecoveryProgress }): JSX.Element {
  return <div className="session-body" aria-busy={!!loading}>
    {loading ? <div className="panel-loading session-loading" role="status"><div className="loading-spinner" aria-hidden="true" /><span>正在恢复对话…</span></div>
      : loadError ? <div className="panel-loading session-loading" role="alert"><span>对话恢复失败</span><p className="scope-error">{loadError}</p>{onRetryLoad && <button className="scope-button" onClick={onRetryLoad}>重试</button>}</div>
      : <>
        {workspaceNotice && <div className="session-workspace-notice" role="status">{workspaceNotice}</div>}
        {recovery && stream.sessionId && <SessionRecoveryStatus key={stream.sessionId} sessionId={stream.sessionId} recovery={recovery} />}
        <ReadOnlyConversationContext.Provider value={readOnly}><TeamAssignmentDisplayContext.Provider value={teamAssignmentContext}><EventStream {...stream} /></TeamAssignmentDisplayContext.Provider></ReadOnlyConversationContext.Provider>
        {children}
      </>}
  </div>
}
