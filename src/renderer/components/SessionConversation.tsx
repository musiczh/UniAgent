import type { ComponentProps, ReactNode } from 'react'
import { EventStream, ReadOnlyConversationContext } from './EventStream'
import { TeamAssignmentDisplayContext, type TeamAssignmentDisplayContextValue } from './TeamAssignmentCard'

/** The same transcript body is used by ordinary sessions and team role sessions. */
export function SessionConversation({ loading, readOnly = false, teamAssignmentContext, children, workspaceNotice, ...stream }: ComponentProps<typeof EventStream> & { loading?: boolean; readOnly?: boolean; teamAssignmentContext?: TeamAssignmentDisplayContextValue; children?: ReactNode; workspaceNotice?: string }): JSX.Element {
  return <div className="session-body">
    {workspaceNotice && <div className="session-workspace-notice" role="status">{workspaceNotice}</div>}
    {loading && <div className="panel-loading session-loading"><div className="loading-spinner" /><span>正在加载对话…</span></div>}
    <ReadOnlyConversationContext.Provider value={readOnly}><TeamAssignmentDisplayContext.Provider value={teamAssignmentContext}><EventStream {...stream} /></TeamAssignmentDisplayContext.Provider></ReadOnlyConversationContext.Provider>
    {children}
  </div>
}
