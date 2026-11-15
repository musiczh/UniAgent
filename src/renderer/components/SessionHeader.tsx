import type { ReactNode } from 'react'
import { agentForSession, type AgentDef, type Project, type Session } from '@shared/types'
import type { Requirement } from '@shared/requirementTypes'
import { isTaskTitleEligible } from '@shared/taskTitle'
import { sessionDisplayTitle } from '@shared/task'
import type { BrowserLocation } from '../scopeBrowser'
import { PageTypeBadge } from './PageTypeBadge'
import { SessionInfoTitle } from './SessionInfo'
import { WorktreeStatusBadge } from './WorktreeStatusBadge'
import { FolderIcon, UiIcon } from './Icons'
import './taskDetail.css'

export function SessionHeader({
  session,
  agents,
  projects,
  requirements,
  onNavigate,
  onOpenGeneration,
  onMergeWorktree,
  onReturn,
  returnLabel = '返回点击前的 Session',
  onOpenSide,
  onOpenComments,
  commentsOpen,
  onOpenFiles,
  onForkLatest,
  forkLatestDisabled,
  onRefreshNativeSession,
  onSettings,
  onViewConversation,
  onNewSession,
  newSessionDisabled,
  newSessionBusy,
  titleConfiguration,
  refreshingNativeSession,
  nativeRefreshDisabled
}: {
  session: Session
  agents: AgentDef[]
  projects?: Project[]
  requirements?: Requirement[]
  onNavigate?: (location: BrowserLocation) => void
  onOpenGeneration?: () => void
  onMergeWorktree?: () => void
  onReturn?: () => void
  returnLabel?: string
  onOpenSide?: () => void
  onOpenComments?: () => void
  commentsOpen?: boolean
  onOpenFiles?: () => void
  onForkLatest?: () => void
  forkLatestDisabled?: boolean
  onRefreshNativeSession?: () => void | Promise<void>
  onSettings?: () => void
  onViewConversation?: () => void
  onNewSession?: () => void
  newSessionDisabled?: boolean
  newSessionBusy?: boolean
  titleConfiguration?: ReactNode
  refreshingNativeSession?: boolean
  nativeRefreshDisabled?: boolean
}): JSX.Element {
  const baseAgent = agents.find((a) => a.id === session.config.agentId)
  const agent = baseAgent ? agentForSession(baseAgent, session) : undefined
  const sideCapable = agent?.capabilities.sideChat === true
  const task = isTaskTitleEligible(session)
  const worktree = session.config.worktree
  // 改动2 — the top status bar is just a TITLE (会话名 + 工作目录) plus action
  // toggles. 计时胶囊重构 removed the 摘要 toggle: the summary card now opens from
  // the timer capsule (hover popover / pinned dock). Branch/changes live in the
  // summary card's 环境信息; the permission tier stays in the composer bottom.
  return (
    <div className="session-header responsive-toolbar">
      {onReturn && (
        <button type="button" className="session-return-btn" onClick={onReturn} title={returnLabel} aria-label={returnLabel}>
          <UiIcon name="back" size={18} />
        </button>
      )}
      {session.config.workdir && onOpenFiles && (
        <button
          type="button"
          className="topbar-files-btn"
          onClick={onOpenFiles}
          title="文件查看器"
          aria-label="打开文件查看器"
        >
          <FolderIcon />
        </button>
      )}
      {titleConfiguration ? <><span className="topbar-title"><span className="topbar-title-main">{sessionDisplayTitle(session)}</span></span>{titleConfiguration}</> : <SessionInfoTitle key={session.id} session={session} agent={agent} task={task} onOpenGeneration={onOpenGeneration} className="topbar-title">
        {task && <PageTypeBadge kind="task"/>}
        <span className="topbar-title-main">{sessionDisplayTitle(session)}</span>
        {!task && <span className="topbar-title-sub topbar-title-path">
          <span> · </span>
          <span className="topbar-title-path-value">{session.config.workdir}</span>
        </span>}
      </SessionInfoTitle>}
      {task && <TaskOwnership session={session} projects={projects} requirements={requirements} onNavigate={onNavigate}/>}
      {worktree && <WorktreeStatusBadge key={`${session.id}:${worktree.id}`} sessionId={session.id} worktree={worktree} onMerge={task ? onMergeWorktree : undefined}/>}
      <span className="topbar-spacer" />
      {onViewConversation && <button type="button" className="summary-toggle toolbar-action" onClick={onViewConversation} aria-label="查看 RouterAgent 会话" title="查看 RouterAgent 完整会话"><UiIcon name="message-square" size={14}/><span className="toolbar-action-label">查看会话</span></button>}
      {onNewSession && <button type="button" className="summary-toggle toolbar-action" onClick={onNewSession} disabled={newSessionDisabled || newSessionBusy} aria-label="新建 RouterAgent 会话" aria-busy={!!newSessionBusy} title={newSessionBusy ? '正在创建新会话' : newSessionDisabled ? '当前正在处理任务或 Router 尚未就绪' : '创建新的 RouterAgent 会话，保留旧记录'}><UiIcon name="plus" size={14}/><span className="toolbar-action-label">{newSessionBusy ? '创建中…' : '新建会话'}</span></button>}
      {onSettings && <button className="summary-toggle toolbar-action" onClick={onSettings} aria-label="配置 RouterAgent"><UiIcon name="settings" size={14} /><span className="toolbar-action-label">配置</span></button>}
      {session.config.agentId === 'codex' && session.importMode === 'direct' && session.nativeSessionId && onRefreshNativeSession && (
        <button
          type="button"
          className="summary-toggle session-refresh-toggle toolbar-action"
          onClick={() => void onRefreshNativeSession()}
          disabled={refreshingNativeSession || nativeRefreshDisabled}
          aria-label="刷新原生会话"
          aria-busy={!!refreshingNativeSession}
          title={refreshingNativeSession ? '正在刷新原生会话' : nativeRefreshDisabled ? '正在处理会话，请稍后刷新' : '刷新原生会话'}
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="refresh" size={14} />
          </span>
          <span className="toolbar-action-label">刷新</span>
        </button>
      )}
      {onForkLatest && (
        <button
          type="button"
          className="summary-toggle session-refresh-toggle session-fork-toggle toolbar-action toolbar-icon-action"
          onClick={onForkLatest}
          disabled={forkLatestDisabled}
          title={forkLatestDisabled ? '当前回复完成后可分叉' : '从最新内容分叉新会话'}
          aria-label="从最新内容分叉新会话"
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="fork" size={14} />
          </span>
        </button>
      )}
      {sideCapable && onOpenSide && (
        <button
          className="summary-toggle session-side-toggle toolbar-action toolbar-icon-action"
          onClick={onOpenSide}
          title="侧边对话（临时支线，不写回主会话）"
          aria-label="侧边对话"
        >
          <span className="summary-toggle-glyph" aria-hidden>
            <UiIcon name="panel-right" size={14} />
          </span>
        </button>
      )}
      {onOpenComments && <button className="summary-toggle session-comments-toggle toolbar-action toolbar-icon-action" onClick={onOpenComments}
        title="打开侧边评论" aria-label="打开侧边评论" aria-expanded={!!commentsOpen}>
        <span className="summary-toggle-glyph" aria-hidden><UiIcon name="annotation" size={14} /></span>
      </button>}
    </div>
  )
}

/** Requirement ownership takes precedence over the execution project. */
function TaskOwnership({ session, projects = [], requirements = [], onNavigate }: { session: Session; projects?: Project[]; requirements?: Requirement[]; onNavigate?: (location: BrowserLocation) => void }): JSX.Element {
  const requirementId = session.config.requirementId
  const requirement = requirements.find(item => item.id === requirementId)
  const projectId = session.config.projectId
  const project = projects.find(item => item.id === projectId)
  const spaceName = projectId ? project?.name || '项目暂不可用' : '未关联项目'
  const requirementName = requirement?.name || session.config.requirementName || '需求暂不可用'
  return <div className="task-detail-ownership" aria-label="任务归属">
    {requirementId
      ? <button type="button" className="task-ownership-item scope-space-link" title={requirementName} aria-label={`打开所属需求 ${requirementName}`} disabled={!requirement || !onNavigate} onClick={() => { if (requirement) onNavigate?.({ kind: 'requirement', id: requirement.id }) }}><UiIcon name="file" size={14}/><span className="task-ownership-name">{requirementName}</span></button>
      : <button type="button" className="task-ownership-item scope-space-link" title={spaceName} aria-label={`打开所属项目 ${spaceName}`} disabled={!project || !onNavigate} onClick={() => { if (project) onNavigate?.({ kind: 'space', id: project.id }) }}><UiIcon name="folder" size={14}/><span className="task-ownership-name">{spaceName}</span></button>}
  </div>
}
