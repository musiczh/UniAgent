import { useMemo, useState, type MutableRefObject } from 'react'
import { saveBrowserValue } from '../scopeBrowser'
import './projectMemoryReader.css'
import type { AgentDef, Project, Session, SessionStatus } from '@shared/types'
import { isToolSession } from '@shared/types'
import { sessionDisplayTitle } from '@shared/task'
import { AgentIcon } from './AgentIcon'
import { UiIcon } from './Icons'
import { ProjectEditorDialog, ProjectEditorForm } from './ProjectEditorDialog'
import { ProjectWorktrees } from './ProjectWorktrees'
import { groupSessionsByProject } from './SessionList'
import { SetGroup } from './SettingsPrimitives'

const STATUS_LABEL: Record<SessionStatus, string> = {
  draft: '草稿', running: '进行中', queued: '排队中', 'awaiting-approval': '等待确认',
  cancelling: '停止中', cancelled: '已取消', interrupted: '已中断', error: '出错',
  completed: '已完成', idle: '空闲', archived: '已归档'
}

type ProjectTab = 'sessions' | 'worktrees' | 'info'
const TABS = [
  { id: 'sessions', label: '会话', icon: 'message-square' },
  { id: 'worktrees', label: '工作树', icon: 'fork' },
  { id: 'info', label: '项目信息', icon: 'sliders' }
] as const

export function ProjectSettings({ projects, sessions, agents, onProjectsChange, onOpenSession, navigationGuard, onBrowse }: {
  projects: Project[]
  sessions: Session[]
  agents: AgentDef[]
  onProjectsChange: (projects: Project[]) => void
  onOpenSession?: (id: string) => void
  onBrowse?: (id: string) => void
  navigationGuard: MutableRefObject<(() => boolean) | null>
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<ProjectTab>('sessions')
  const [archived, setArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const groups = useMemo(() => new Map(groupSessionsByProject(sessions, projects).map(group => [
    group.project.id,
    group.sessions.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
  ])), [sessions, projects])
  const project = projects.find(item => item.id === selectedId)
  const projectSessions = project ? groups.get(project.id) || [] : []
  const activeSessions = projectSessions.filter(session => !session.archived)
  const archivedSessions = projectSessions.filter(session => session.archived)

  function navigate(action: () => void): void {
    if (removing || navigationGuard.current?.() === false) return
    setError('')
    action()
  }

  function changed(next: Project[]): void {
    onProjectsChange(next)
    window.dispatchEvent(new Event('uniagent-projects-changed'))
  }

  async function remove(): Promise<void> {
    if (!project || project.isDefault || removing) return
    if (!window.confirm(`确定删除项目「${project.name}」吗？\n\n该项目下的所有会话会移动到默认项目，磁盘文件不会被删除。`)) return
    setRemoving(true); setError('')
    try {
      changed(await window.uniagent.deleteProject(project.id))
      setSelectedId(null)
    } catch (reason) {
      setError(String(reason).includes('project_has_active_sessions')
        ? '项目仍有运行中的会话，请等待会话结束后再删除。'
        : reason instanceof Error ? reason.message : String(reason))
    } finally { setRemoving(false) }
  }

  return <>
    {project ? <div className="project-detail">
      <div className="set-detail-top">
        {onBrowse && <button className="set-mini-btn" onClick={() => navigate(() => onBrowse(project.id))}>浏览项目详情</button>}
        <button type="button" className="set-back" onClick={() => navigate(() => setSelectedId(null))}>
          <span className="set-caret"><UiIcon name="chevron-right" size={13} /></span>全部项目
        </button>
        <div className="set-detail-title">
          <span className="project-settings-icon"><UiIcon name="folder" size={23} /></span>
          <div className="sdt-main">
            <h2>{project.name}{project.isDefault && <span className="auto-badge kind">默认</span>}</h2>
            <div className="set-detail-sub" title={[project.primaryDirectory, ...project.additionalDirectories].join('\n')}>{project.primaryDirectory}{project.additionalDirectories.length ? ` · 另有 ${project.additionalDirectories.length} 个目录` : ''}</div>
          </div>
        </div>
      </div>
      <nav className="project-detail-tabs" aria-label="项目详情">
        {TABS.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined}
          onClick={() => { if (item.id !== tab) navigate(() => setTab(item.id)) }}>
          <UiIcon name={item.icon} size={15} />{item.label}{item.id === 'sessions' && <span className="project-detail-count">{projectSessions.length}</span>}
        </button>)}
      </nav>
      {tab === 'sessions' ? <>
        <div className="project-sessions-toolbar">
          <div className="project-archive-segments" role="group" aria-label="会话归档状态">
            <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>未归档<span className="project-detail-count">{activeSessions.length}</span></button>
            <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>已归档<span className="project-detail-count">{archivedSessions.length}</span></button>
          </div>
          <span>按最近活动排序</span>
        </div>
        <div className="set-card project-session-list" aria-label={archived ? '已归档会话' : '未归档会话'}>
          {(archived ? archivedSessions : activeSessions).map(session => {
            const agent = agents.find(item => item.id === session.config.agentId)
            const worktree = session.config.worktree
            return <button type="button" className="project-session-row" key={session.id} data-session-id={session.id} onClick={() => onOpenSession?.(session.id)}>
              <span className="project-session-icon">{isToolSession(session) ? <UiIcon name="plug" size={20} /> : <AgentIcon agentId={session.config.agentId} adapter={agent?.adapter} size={21} />}</span>
              <span className="project-session-main">
                <span className="project-session-title"><strong title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</strong>
                  {isToolSession(session) && <span className="project-session-badge">工具会话</span>}
                  {session.origin === 'imported' && <span className="project-session-badge">导入</span>}
                  {session.readOnly && <span className="project-session-badge">只读</span>}
                  {session.teamBinding && <span className="project-session-badge">专家团</span>}
                </span>
                <span className="project-session-meta"><span>{agent?.name || session.config.agentId}</span><span>·</span>
                  {worktree && <UiIcon name="fork" size={11} />}<span title={session.config.workdir}>{worktree ? `工作树 · ${worktree.checkoutRoot.split('/').pop()}` : '主目录'}</span>
                </span>
              </span>
              <span className="project-session-end">
                {!archived && <span className={`project-session-status is-${session.status}`}>{STATUS_LABEL[session.status]}</span>}
                <time dateTime={new Date(session.updatedAt ?? session.createdAt).toISOString()}>{new Date(session.updatedAt ?? session.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                <UiIcon name="chevron-right" size={13} />
              </span>
            </button>
          })}
          {!(archived ? archivedSessions : activeSessions).length && <p className="project-sessions-empty">该项目暂无{archived ? '已归档' : '未归档'}会话</p>}
        </div>
        <p className="project-detail-foot">{archived ? '点击会话查看历史，保持归档状态。' : '包含当前项目主目录和工作树下的全部未归档会话。'}</p>
      </> : tab === 'worktrees' ? <div className="set-card project-detail-worktrees"><ProjectWorktrees project={project} sessions={sessions} onOpenSession={onOpenSession} /></div> :
        <><SetGroup title="项目信息"><ProjectEditorForm project={project} inline busy={removing} navigationGuard={navigationGuard}
          onRemove={() => void remove()} onSaved={saved => changed(projects.map(item => item.id === saved.id ? saved : item))} /></SetGroup>{onBrowse && <div className="project-memory-setting"><UiIcon name="file" size={20}/><div><strong>项目记忆</strong><p>由 UniAgent 统一管理，供项目内各 Agent 按需读取。</p></div><button className="scope-button" onClick={() => navigate(() => { saveBrowserValue('ua.scopeBrowser.space:'+project.id+'.tab','memory'); onBrowse(project.id) })}>查看记忆</button></div>}</>}
    </div> : <>
      <SetGroup title={`项目 · 共 ${projects.length} 个`} action={<button className="set-add-btn" onClick={() => setCreating(true)}><UiIcon name="plus" size={13} />新建项目</button>}>
        {projects.map(item => <button type="button" className="project-settings-row project-settings-link" key={item.id} aria-label={`进入项目 ${item.name}`}
          onClick={() => { setSelectedId(item.id); setTab('sessions'); setArchived(false); setError('') }}>
          <span className="project-settings-icon"><UiIcon name="folder" size={17} /></span>
          <span className="project-settings-main">
            <span className="r-label">{item.name}{item.isDefault && <span className="auto-badge kind">默认</span>}</span>
            <span className="r-sub" title={[item.primaryDirectory, ...item.additionalDirectories].join('\n')}>{item.primaryDirectory}{item.additionalDirectories.length ? ` · 另有 ${item.additionalDirectories.length} 个目录` : ''}</span>
          </span>
          <span className="project-settings-summary">{groups.get(item.id)?.length || 0} 个会话<UiIcon name="chevron-right" size={14} /></span>
        </button>)}
      </SetGroup>
      <div className="set-detail-sub">每个项目包含一个主目录和可选的附加目录。新会话只选择项目，由 Agent 按各自方式加载目录。</div>
    </>}
    {error && <p className="project-editor-error" role="alert">{error}</p>}
    {creating && <ProjectEditorDialog onClose={() => setCreating(false)} onSaved={saved => { changed([...projects, saved]); setCreating(false) }} />}
  </>
}
