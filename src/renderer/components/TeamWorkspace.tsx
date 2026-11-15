import { agentForSession, type AgentDef, type Session, type UAEvent } from '@shared/types'
import type { TeamProject } from '@shared/teamTypes'
import { teamSessionEvents } from '../teamTimeline'
import { SessionConversation } from './SessionConversation'
import { SessionInfoTitle } from './SessionInfo'
import { isSessionBusy } from '@shared/sessionStatus'
import { UiIcon } from './Icons'
import { currentSessionForkTargets } from './ResumePanel'
import './teams.css'

export function MemberSession({ sessionId, p, agents, sessions, events, loading, onBack, onForkLatest }: { sessionId: string; p: TeamProject; agents: AgentDef[]; sessions: Session[]; events: UAEvent[]; loading: boolean; onBack: () => void; onForkLatest: (sessionId: string) => void }): JSX.Element {
  const session = sessions.find(s => s.id === sessionId)
  const role = p.team.members.find(m => p.memberSessions[m.id] === sessionId)
  const baseAgent = agents.find(agent => agent.id === session?.config.agentId)
  const canFork = !!session && currentSessionForkTargets(baseAgent ? agentForSession(baseAgent, session) : undefined, agents).length > 0
  const leaderName = p.team.members.find(m => m.id === p.team.leaderMemberId)?.role.name || 'Leader'
  const assignmentContext = role ? {
    sender: leaderName,
    recipient: role.role.name,
    statusByAssignmentKey: Object.fromEntries(p.assignments.flatMap(a => [
      [`${a.id}:${a.attempt}`, a.status] as const,
      ...a.history.map(h => [`${a.id}:${h.attempt}`, h.status] as const),
    ])),
  } : undefined
  const conversationEvents = teamSessionEvents(p, sessionId, events)
  const conversation = <SessionConversation loading={loading} workspaceNotice={session?.config.workspaceNotice} readOnly teamAssignmentContext={assignmentContext} events={conversationEvents} status={session?.status || 'draft'} sessionId={sessionId} />
  return <div className="session-view team-session"><div className="readonly-context responsive-toolbar"><button className="team-back-icon" aria-label="返回主会话" title="返回主会话" onClick={onBack}><UiIcon name="chevron-right" size={20} /></button><span className="readonly-project">{p.name}</span><span>/</span>
    {session ? <SessionInfoTitle key={session.id} session={session} agent={baseAgent} className="team-session-title"><strong>{role?.role.name}{role?.id === p.team.leaderMemberId ? ' · Leader' : ''}</strong></SessionInfoTitle> : <strong>{role?.role.name}</strong>}
    <span className="sb-spacer" /><span className="team-muted">会话记录</span>{canFork && <button type="button" className="summary-toggle session-refresh-toggle session-fork-toggle toolbar-action" disabled={loading || !session?.nativeSessionId || isSessionBusy(session.status)} onClick={() => onForkLatest(sessionId)} title={loading || !session?.nativeSessionId || isSessionBusy(session.status) ? '当前回复完成后可分叉' : '从最新内容分叉新会话'} aria-label="从最新内容分叉新会话"><span className="summary-toggle-glyph" aria-hidden><UiIcon name="fork" size={14} /></span><span className="toolbar-action-label">分叉</span></button>}</div>
    {conversation}
  </div>
}
