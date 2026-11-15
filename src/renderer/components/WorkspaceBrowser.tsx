import { sessionDisplayTitle } from '@shared/task'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentDef, Project, Session, SessionConfig } from '@shared/types'
import type { Requirement } from '@shared/requirementTypes'
import type { SessionActivityStatus } from '@shared/sessionStatus'
import { isSessionBusy } from '@shared/sessionStatus'
import { useRequirements } from '../useRequirements'
import { BROWSER_EXPANDED_KEY, browserAttention, browserRequirementTaskCounts, browserTaskStatus, readBrowserValue, saveBrowserValue, scopeSessions, type BrowserLocation } from '../scopeBrowser'
import { UiIcon } from './Icons'
import { PageTypeBadge } from './PageTypeBadge'
import { RequirementReader } from './RequirementReader'
import { RequirementCurationConversation } from './RequirementCurationConversation'
import { ProjectMemoryReader } from './ProjectMemoryReader'
import { TaskBoardWorkspace } from './TaskBoard'
import { RequirementEditor, confirmArchiveRequirement } from './RequirementPicker'
import { RequirementTaskBadges } from './RequirementTaskBadges'
import { SidebarViewPicker, SIDEBAR_VIEWS, type SidebarView } from './SidebarViewPicker'
import { SidebarTaskList } from './SidebarTaskList'
import { StatusIndicator } from './SessionList'
import './taskDetail.css'
import './workspaceBrowser.css'

export function useWorkspaceData(requirementsEnabled: boolean) {
  const requirements = useRequirements()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const previousEnabled = useRef(requirementsEnabled)
  useEffect(() => {
    if (previousEnabled.current !== requirementsEnabled) { previousEnabled.current = requirementsEnabled; requirements.retry() }
  }, [requirementsEnabled])
  useEffect(() => {
    let live = true, generation = 0
    const refresh = () => {
      const ticket = ++generation
      void window.uniagent.listProjects().then(rows => {
        if (live && ticket === generation) { setProjects(rows); setError(''); setLoading(false) }
      }, reason => { if (live && ticket === generation) { setError(String(reason)); setLoading(false) } })
    }
    refresh(); window.addEventListener('uniagent-projects-changed', refresh)
    return () => { live = false; window.removeEventListener('uniagent-projects-changed', refresh) }
  }, [retryKey])
  return { requirementsEnabled, projects, projectsLoading: loading, projectsError: error, retryProjects: () => { setLoading(true); setRetryKey(key => key + 1) },
    requirements: requirementsEnabled ? requirements.requirements : [], requirementsLoading: requirements.loading, requirementsError: requirements.error, retryRequirements: requirements.retry }
}
type WorkspaceData = ReturnType<typeof useWorkspaceData>
type TaskSeed = Partial<Pick<SessionConfig, 'projectId' | 'requirementId'>>
type AttentionProps = { sessions: Session[]; pending: Record<string, boolean>; unread: Record<string, unknown>; status: Record<string, SessionActivityStatus> }

function AttentionBadge({ count }: { count?: { waiting: number; unread: number; running?: number; acceptance?: number } }): JSX.Element | null {
  if (!count) return null
  return <>{!!(count.waiting || count.unread) && <span className={`scope-badge ${count.waiting ? 'waiting' : 'unread'}`} title={count.waiting ? `${count.waiting} 项任务需要处理` : `${count.unread} 项任务有新进展`} aria-label={count.waiting ? `${count.waiting} 项任务需要处理` : `${count.unread} 项任务有新进展`}>{count.waiting || <b>{count.unread}</b>}</span>}<RequirementTaskBadges count={count}/></>
}

export function SpaceRequirementNavigation({ data, location, sessions, agents, pending, unread, status, onNavigate, onCreate, activeTaskId, onOpenTask, sessionsLoading, sessionsError, onRetrySessions, onRouter, routerSelected }: AttentionProps & {
  agents?: AgentDef[]
  data: WorkspaceData; location?: BrowserLocation; onNavigate: (location: BrowserLocation) => void; onCreate: (seed: TaskSeed) => void
  activeTaskId?: string | null; onOpenTask?: (id: string) => void | Promise<void>; sessionsLoading?: boolean; sessionsError?: string | null; onRetrySessions?: () => void | Promise<void>
  onRouter?:()=>void;routerSelected?:boolean
}): JSX.Element {
  const [view, setView] = useState<SidebarView>(() => { const value = readBrowserValue<unknown>('ua.scopeBrowser.view', 'space'); return typeof value === 'string' && Object.hasOwn(SIDEBAR_VIEWS, value) ? value as SidebarView : 'space' })
  const initial = useRef(readBrowserValue<unknown>(BROWSER_EXPANDED_KEY, null))
  const [expanded, setExpanded] = useState<string[]>(() => Array.isArray(initial.current) ? initial.current.filter(id => typeof id === 'string') : [])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const actionLock = useRef(false)
  const [requirementError, setRequirementError] = useState('')
  const menuRequirement = data.requirementsEnabled && !data.requirementsError ? data.requirements.find(requirement => requirement.id === menu?.id) : undefined
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!menu || !element) return
    const { width, height } = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus()
  }, [menu, menuRequirement?.status])
  useEffect(() => {
    if (!menu) return
    if (!menuRequirement) { setMenu(null); return }
    const dismiss = () => setMenu(null)
    const outside = (event: globalThis.MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) dismiss() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu, menuRequirement])
  function openRequirementMenu(requirement: Requirement, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void {
    const keyboard = 'key' in event
    if (keyboard && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault(); event.stopPropagation()
    if (actionLock.current || !data.requirementsEnabled || data.requirementsError) return
    const trigger = event.currentTarget.querySelector<HTMLButtonElement>('button') || event.currentTarget
    const bounds = trigger.getBoundingClientRect()
    setMenu({ id: requirement.id, trigger, x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY })
  }
  async function changeRequirementStatus(requirement: Requirement): Promise<void> {
    if (actionLock.current) return
    setMenu(null)
    const status = requirement.status === 'archived' ? 'active' : 'archived'
    if (status === 'archived' && !confirmArchiveRequirement(requirement)) return
    actionLock.current = true; setRequirementError('')
    try { await window.uniagent.updateRequirement(requirement.id, { status }) }
    catch (reason) { setRequirementError(`${requirement.name}：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { actionLock.current = false }
  }
  const selectedRequirement = location?.kind === 'requirement' ? data.requirements.find(r => r.id === location.id) : undefined
  const owner = selectedRequirement?.projectId
  useEffect(() => {
    if (initial.current === null && data.projects.length) {
      initial.current = []
      setExpanded([data.projects.find(p => p.isDefault)?.id || data.projects[0].id])
    }
  }, [data.projects])
  useEffect(() => { if (owner) setExpanded(ids => ids.includes(owner) ? ids : [...ids, owner]) }, [owner])
  useEffect(() => { if (data.projects.length) saveBrowserValue(BROWSER_EXPANDED_KEY, expanded) }, [expanded, data.projects.length])
  const counts = useMemo(() => {
    const result: Map<string, { waiting: number; unread: number; running?: number; acceptance?: number }> = browserAttention(sessions.map(s => status[s.id] === 'awaiting-approval' ? { ...s, status: 'awaiting-approval' } : s), data.requirements, pending, unread, data.requirementsEnabled)
    for (const requirement of data.requirements) result.delete('requirement:' + requirement.id)
    if (data.requirementsEnabled) for (const [id, count] of browserRequirementTaskCounts(sessions, status, pending, unread)) result.set('requirement:' + id, count)
    return result
  }, [sessions, data.requirements, pending, unread, status, data.requirementsEnabled])
  const assistantActivity = useMemo(() => {
    let running = false, waiting = false, unreadCount = 0
    for (const session of scopeSessions(sessions, { kind: 'assistant' })) {
      if (session.archived || session.status === 'archived' || session.taskState?.phase === 'archived') continue
      const activity = status[session.id] || session.status
      waiting ||= !!pending[session.id] || activity === 'awaiting-approval'
      running ||= isSessionBusy(activity) || !!session.recovery && session.recovery.phase !== 'stopped' || !!session.pendingQueue?.some(item => item.state === 'pending')
      if (unread[session.id]) unreadCount++
    }
    const activity: SessionActivityStatus = waiting ? 'awaiting-approval' : running ? 'running' : 'idle'
    return { status: activity, unread: unreadCount }
  }, [sessions, pending, unread, status])
  const bySpace = useMemo(() => {
    const result = new Map<string, Requirement[]>()
    for (const requirement of data.requirements) {
      if (!requirement.projectId || requirement.status === 'archived') continue
      const rows = result.get(requirement.projectId) || []; rows.push(requirement); result.set(requirement.projectId, rows)
    }
    return result
  }, [data.requirements])
  return <nav className="scope-navigation" aria-label="项目与需求导航">
    <button className={`scope-assistant${location?.kind === 'assistant' ? ' selected' : ''}`} onClick={() => onNavigate({ kind: 'assistant' })}><UiIcon name="user-circle" size={15} /><span>个人助手</span><span className="scope-task-status">{isSessionBusy(assistantActivity.status) && <StatusIndicator status={assistantActivity.status}/>} {!!assistantActivity.unread && <span className="si-unread" role="img" aria-label="个人助手有未读消息"/>}</span></button>
    {onRouter&&<button className={`scope-assistant${routerSelected?' selected':''}`} onClick={onRouter}><UiIcon name="router" size={15}/><span>RouterAgent</span></button>}
    <SidebarViewPicker value={view} onChange={next => { saveBrowserValue('ua.scopeBrowser.view', next); setView(next) }}/>
    {requirementError && <div className="scope-error" role="alert">{requirementError}</div>}
    {menu && menuRequirement && createPortal(<div ref={menuRef} className="ctx-menu" role="menu" aria-label="需求操作" style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menu.trigger.focus() }
      else if (event.key === 'Tab') setMenu(null)
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
    }}><button type="button" role="menuitem" className="ctx-item" onClick={() => void changeRequirementStatus(menuRequirement)}><UiIcon name={menuRequirement.status === 'archived' ? 'refresh' : 'archive'} size={15}/>{menuRequirement.status === 'archived' ? '恢复' : '归档'}</button></div>, document.body)}
    {view === 'task' ? <SidebarTaskList sessions={sessions} agents={agents} projects={data.projects} requirements={data.requirements} requirementsEnabled={data.requirementsEnabled} activeTaskId={activeTaskId} status={status} pending={pending} unread={unread} onOpenTask={onOpenTask} loading={sessionsLoading} error={sessionsError} onRetry={onRetrySessions} onRequirementMenu={openRequirementMenu}/> : <>
    {view === 'space' && data.projectsLoading && !data.projects.length && <p className="scope-muted" role="status">正在读取项目…</p>}
    {view === 'space' && data.projectsError && <div className="scope-error" role="alert">项目读取失败<button onClick={data.retryProjects}>重试</button></div>}
    {data.requirementsError && <div className="scope-error" role="alert">需求读取失败<button onClick={data.retryRequirements}>重试</button></div>}
    {view === 'requirement' ? <>
      {data.requirementsLoading && !data.requirements.length && <p className="scope-muted" role="status">正在读取需求…</p>}
      {!data.requirementsLoading && !data.requirementsError && !data.requirements.some(requirement => requirement.status !== 'archived') && <p className="scope-muted">{data.requirementsEnabled ? '暂无需求' : '需求功能已停用，可在设置中开启'}</p>}
      {data.requirements.filter(requirement => requirement.status !== 'archived').map(requirement => <div key={requirement.id} className={`scope-nav-row requirement flat${location?.kind === 'requirement' && location.id === requirement.id ? ' selected' : ''}`} onContextMenu={event => openRequirementMenu(requirement, event)} onKeyDown={event => openRequirementMenu(requirement, event)}>
        <button className="scope-nav-name" aria-current={location?.kind === 'requirement' && location.id === requirement.id ? 'page' : undefined} title={requirement.name} onClick={() => onNavigate({ kind: 'requirement', id: requirement.id })}><UiIcon name="file" size={15}/><span>{requirement.name}</span></button>
        <AttentionBadge count={counts.get('requirement:' + requirement.id)}/>
        <button className="scope-quick-create" disabled={requirement.status === 'archived' || !!data.requirementsError || !data.projects.some(project => project.id === requirement.projectId)} aria-label={`在${requirement.name}下新建任务`} onClick={() => onCreate({ projectId: requirement.projectId, requirementId: requirement.id })}><UiIcon name="plus" size={13}/></button>
      </div>)}
    </> : data.projects.map(project => <div key={project.id}>
      <div className={`scope-nav-row${location?.kind === 'space' && location.id === project.id ? ' selected' : ''}`}>
        <button className="scope-expand" aria-label={`${expanded.includes(project.id) ? '收起' : '展开'}${project.name}`} aria-expanded={expanded.includes(project.id)} onClick={() => setExpanded(ids => ids.includes(project.id) ? ids.filter(id => id !== project.id) : [...ids, project.id])}><UiIcon name={expanded.includes(project.id) ? 'chevron-down' : 'chevron-right'} size={12} /></button>
        <button className="scope-nav-name" aria-current={location?.kind === 'space' && location.id === project.id ? 'page' : undefined} title={project.name} onClick={() => onNavigate({ kind: 'space', id: project.id })}><UiIcon name="folder" size={15} /><span>{project.name}</span></button>
        <AttentionBadge count={counts.get('space:' + project.id)} />
        <button className="scope-quick-create" aria-label={`在${project.name}中新建任务`} onClick={() => onCreate({ projectId: project.id })}><UiIcon name="plus" size={13} /></button>
      </div>
      {expanded.includes(project.id) && (bySpace.get(project.id) || []).map(requirement => <div key={requirement.id} className={`scope-nav-row requirement${location?.kind === 'requirement' && location.id === requirement.id ? ' selected' : ''}`} onContextMenu={event => openRequirementMenu(requirement, event)} onKeyDown={event => openRequirementMenu(requirement, event)}>
        <button className="scope-nav-name" aria-current={location?.kind === 'requirement' && location.id === requirement.id ? 'page' : undefined} title={requirement.name} onClick={() => onNavigate({ kind: 'requirement', id: requirement.id })}><UiIcon name="file" size={15} /><span>{requirement.name}</span></button>
        <AttentionBadge count={counts.get('requirement:' + requirement.id)} />
        <button className="scope-quick-create" disabled={requirement.status === 'archived' || !!data.requirementsError} aria-label={`在${requirement.name}下新建任务`} onClick={() => onCreate({ projectId: project.id, requirementId: requirement.id })}><UiIcon name="plus" size={13} /></button>
      </div>)}
    </div>)}
    </>}
  </nav>
}

export function WorkspaceDetail({ location, data, requirementsEnabled, sessions, agents, pending, unread, status, sessionsLoading, sessionsError, onRetrySessions, onNavigate, onCreate, onOpenTask, onOpenRouter, onDeleteTask, onOpenDirectory, onOpenFile, onManage, notice }: AttentionProps & {
  agents?: AgentDef[]
  location: BrowserLocation; data: WorkspaceData; requirementsEnabled: boolean; sessionsLoading: boolean; sessionsError?: string | null; onRetrySessions: () => Promise<void>
  onNavigate: (location: BrowserLocation) => void; onCreate: (seed: TaskSeed) => void; onOpenTask: (id: string, seq?: number) => void | Promise<void>; onOpenRouter?: (requestId: string) => void | Promise<void>; onDeleteTask: (id: string) => Promise<void>; onOpenDirectory?: (root: string) => void; onOpenFile?: (path: string, root: string, line?: number) => void; onManage: (category: 'projects' | 'requirements' | 'assistants') => void; notice?: string
}): JSX.Element {
  const key = 'ua.scopeBrowser.' + (location.kind === 'assistant' ? 'assistant' : location.kind + ':' + location.id)
  const tabs = location.kind === 'space' ? [...(requirementsEnabled ? [['requirements','需求'],['tasks','直属任务']] : [['tasks','任务']]),['memory','项目记忆']] : location.kind === 'requirement' ? [['tasks','任务'],['context','概览'],['decisions','变更与决策'],['resources','资料']] : [['tasks','会话']]
  const [tab, setTab] = useState(() => { const saved = readBrowserValue(key + '.tab', ''); return tabs.some(([id]) => id === saved) ? saved : tabs[0][0] })
  const readPage = (name: string): number => { const value = readBrowserValue(key + '.' + name + '.page', 0); return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
  const [page, setPage] = useState(() => readPage(tab))
  const [archived, setArchived] = useState(() => readBrowserValue<boolean>(key + '.archived', false) === true)
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const more = useRef<HTMLDivElement>(null)
  const archiveLock = useRef(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [taskError, setTaskError] = useState('')
  const [retryingTasks, setRetryingTasks] = useState(false)
  const [curationRequirementId, setCurationRequirementId] = useState<string | null>(null)
  useEffect(() => setCurationRequirementId(null), [key])
  const scroll = useRef<HTMLDivElement>(null)
  const requirement = location.kind === 'requirement' ? data.requirements.find(r => r.id === location.id) : undefined
  const project = data.projects.find(p => p.id === (location.kind === 'space' ? location.id : requirement?.projectId))
  const title = location.kind === 'assistant' ? '个人助手' : location.kind === 'space' ? project?.name : requirement?.name
  const loading = location.kind === 'space' ? data.projectsLoading : location.kind === 'requirement' ? data.requirementsLoading : false
  const scopeError = location.kind === 'space' ? data.projectsError : location.kind === 'requirement' ? data.requirementsError : ''
  useEffect(() => { setMoreOpen(false) }, [key, requirement?.status, !!requirement, scopeError, loading, requirementsEnabled])
  useEffect(() => {
    if (!moreOpen) return
    more.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const outside = (event: globalThis.MouseEvent) => { if (!more.current?.contains(event.target as Node)) setMoreOpen(false) }
    const dismiss = () => setMoreOpen(false)
    document.addEventListener('mousedown', outside)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [moreOpen])
  async function archiveRequirement(): Promise<void> {
    if (archiveLock.current || !requirement || requirement.status === 'archived' || !requirementsEnabled || loading || scopeError) return
    setMoreOpen(false)
    if (!confirmArchiveRequirement(requirement)) return
    archiveLock.current = true; setArchiving(true); setArchiveError('')
    try { await window.uniagent.updateRequirement(requirement.id, { status: 'archived' }) }
    catch (reason) { setArchiveError(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { archiveLock.current = false; setArchiving(false) }
  }
  const taskRows = useMemo(() => scopeSessions(sessions, location, requirementsEnabled).filter(s => !!s.archived === archived).sort((a,b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) || a.id.localeCompare(b.id)), [sessions, location.kind, 'id' in location ? location.id : '', archived, requirementsEnabled])
  const requirementRows = data.requirements.filter(r => r.projectId === project?.id && r.status !== 'archived')
  const count = tab === 'requirements' ? requirementRows.length : taskRows.length
  const last = Math.max(0, Math.ceil(count / 50) - 1), currentPage = Math.min(page, last)
  const contentLoading = loading || (tab === 'tasks' ? sessionsLoading : tab === 'requirements' ? data.requirementsLoading : false)
  useEffect(() => {
    if (!contentLoading && page > last) { setPage(last); saveBrowserValue(key + '.' + tab + '.page', last) }
  }, [contentLoading, page, last, key, tab])
  useLayoutEffect(() => {
    if (!contentLoading && scroll.current) { const value = readBrowserValue(key + '.' + tab + '.scroll', 0); scroll.current.scrollTop = Number.isFinite(value) ? value : 0 }
  }, [key, tab, currentPage, contentLoading])
  function changeTab(value: string): void { saveBrowserValue(key + '.tab', value); setTab(value); setPage(readPage(value)) }
  useEffect(() => { if (location.kind === 'space' && !requirementsEnabled && tab === 'requirements') changeTab('tasks') }, [requirementsEnabled, tab])
  function changePage(value: number): void { saveBrowserValue(key + '.' + tab + '.page', value); saveBrowserValue(key + '.' + tab + '.scroll', 0); setPage(value) }
  async function retryTasks(): Promise<void> {
    if (retryingTasks) return
    setRetryingTasks(true); setTaskError('')
    try { await onRetrySessions() } catch (reason) { setTaskError(String(reason)) } finally { setRetryingTasks(false) }
  }
  const create = () => onCreate(location.kind === 'assistant' ? {} : { projectId: project?.id, ...(requirement ? { requirementId: requirement.id } : {}) })
  const canCreate = location.kind !== 'assistant' && !!project && !scopeError && requirement?.status !== 'archived' && !loading
  const attention = useMemo(() => browserAttention(sessions, data.requirements, pending, unread, requirementsEnabled), [sessions, data.requirements, pending, unread, requirementsEnabled])
  if (requirementsEnabled && requirement && curationRequirementId === requirement.id) return <RequirementCurationConversation key={requirement.id} id={requirement.id} name={requirement.name} onBack={() => setCurationRequirementId(null)}/>
  return <section className={`workspace-detail${location.kind === 'requirement' ? ' requirement-detail' : ''}`} aria-label="工作详情">
    {location.kind !== 'requirement' && <header className="main-panel-head settings-head"><button className="settings-back" aria-label="返回项目" onClick={() => project ? onNavigate({ kind: 'space', id: project.id }) : onManage('projects')}><UiIcon name="back" size={15} /></button><span className="main-panel-title">{title || '工作详情'}</span></header>}
    {notice && <p className="scope-notice" role="status">{notice}</p>}
    <div className="workspace-detail-scroll" ref={scroll} onScroll={event => { if (!contentLoading) saveBrowserValue(key + '.' + tab + '.scroll', event.currentTarget.scrollTop) }}>
      <div className="scope-heading"><div className="scope-heading-title">{location.kind === 'assistant' ? <h1>{title}</h1> : <div className="page-type-title"><PageTypeBadge kind={location.kind}/><h1>{title || (loading ? '正在读取…' : '对象不可用')}</h1>
        {location.kind === 'requirement' && <><button type="button" className="scope-space-link" disabled={!project} title={project ? `打开主项目 ${project.name}` : '主项目暂不可用'} aria-label={project ? `打开主项目 ${project.name}` : '主项目暂不可用'} onClick={() => project && onNavigate({ kind: 'space', id: project.id })}><UiIcon name="folder" size={14}/><span>{project?.name || (data.projectsLoading ? '正在读取…' : data.projectsError ? '读取失败' : '尚未绑定')}</span></button>{requirement?.status === 'archived' && <span className="task-execution-status">已归档</span>}</>}
      </div>}{location.kind !== 'requirement' && <p aria-hidden={location.kind === 'space' || undefined}>{location.kind === 'assistant' ? '沿用原助手会话与能力' : '\u00a0'}</p>}</div><div className="scope-actions">
        {location.kind === 'assistant' ? <button className="scope-button" onClick={() => onManage('assistants')}>助手设置</button> : location.kind === 'space' && tab === 'requirements' ? <button className="scope-button primary" disabled={!requirementsEnabled || !project || !!data.requirementsError} onClick={() => setEditing('new')}><UiIcon name="plus" size={13} />新建需求</button> : <button className="scope-button primary" disabled={!canCreate || location.kind === 'requirement' && !requirementsEnabled} onClick={create}>{location.kind !== 'requirement' && <UiIcon name="plus" size={13} />}新建任务</button>}
        <div className="scope-more" ref={more} onKeyDown={event => {
          if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); more.current?.querySelector<HTMLButtonElement>('.scope-button')?.focus() }
          else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            if (!moreOpen) { setMoreOpen(true); return }
            const buttons = [...(more.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])]
            const index = buttons.findIndex(button => button === document.activeElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }
        }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setMoreOpen(false) }}>
          <button type="button" className="scope-button" aria-label="工作详情更多操作" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>更多<UiIcon name="chevron-down" size={12}/></button>
          {moreOpen && <div className="scope-more-menu" role="menu" aria-label="工作详情操作">
            <button type="button" role="menuitem" className="ctx-item" disabled={location.kind === 'requirement' && (!requirement || !requirementsEnabled || loading || !!scopeError)} onClick={() => { setMoreOpen(false); if (requirement) setEditing('edit'); else onManage(location.kind === 'assistant' ? 'assistants' : 'projects') }}><UiIcon name="settings" size={15}/>{location.kind === 'requirement' ? '需求设置' : location.kind === 'assistant' ? '助手设置' : '项目设置与工作树'}</button>
            {requirement && requirement.status !== 'archived' && <><div className="ctx-sep" role="separator"/><button type="button" role="menuitem" className="ctx-item" disabled={archiving || !requirementsEnabled || loading || !!scopeError} onClick={() => void archiveRequirement()}><UiIcon name="archive" size={15}/>{archiving ? '归档中…' : '归档'}</button></>}
          </div>}
        </div>
      </div></div>
      <div className="task-detail-tabs" role="tablist" aria-label="详情内容">{tabs.map(([id,label]) => <button type="button" key={id} role="tab" aria-selected={tab === id} onClick={() => changeTab(id)}>{label}</button>)}{requirement && tab !== 'tasks' && <button className="scope-directory-button" disabled={!onOpenDirectory} onClick={() => onOpenDirectory?.(requirement.dir)}><UiIcon name="folder" size={14}/>打开上下文目录</button>}</div>
      {scopeError && <div className="scope-error" role="alert">{scopeError}<button onClick={location.kind === 'space' ? data.retryProjects : data.retryRequirements}>重试</button></div>}
      {archiveError && <div className="scope-error" role="alert">{archiveError}</div>}
      {contentLoading ? <p className="scope-muted" role="status">正在读取列表…</p> : location.kind !== 'assistant' && !title ? <p className="scope-muted">对象已移除或当前不可用，可返回项目或从设置重新选择。</p> : project && tab === 'memory' ? <ProjectMemoryReader key={project.id} project={project} onOpenTask={onOpenTask} onOpenFile={onOpenFile} onManage={() => onManage('projects')}/> : requirement && ['context','decisions','resources'].includes(tab) ? <RequirementReader key={requirement.id + ':' + tab} id={requirement.id} tab={tab as 'context' | 'decisions' | 'resources'} onOpenCuration={() => setCurationRequirementId(requirement.id)} sessions={sessions} onOpenTask={onOpenTask} onOpenFile={onOpenFile ? (path, line) => onOpenFile(path, requirement.dir, line) : undefined} onOpenCode={onOpenFile ? (path, projectId, directory) => { const owner = data.projects.find(item => item.id === projectId); if (owner) onOpenFile(path,directory || owner.primaryDirectory) } : undefined}/> : requirement && tab === 'tasks' ? <TaskBoardWorkspace key={requirement.id} requirementId={requirement.id} projects={data.projects} requirements={data.requirements} agents={agents} unreadBySession={unread} onOpenTask={onOpenTask} onOpenRouter={onOpenRouter} onDeleteTask={onDeleteTask}/> : <>
        {tab === 'tasks' && <div className="scope-filter"><button aria-pressed={!archived} onClick={() => { setArchived(false); saveBrowserValue(key + '.archived',false); changePage(0) }}>未归档</button><button aria-pressed={archived} onClick={() => { setArchived(true); saveBrowserValue(key + '.archived',true); changePage(0) }}>已归档</button><span>最近活动</span></div>}
        {tab === 'tasks' && (sessionsError || taskError) && <div className="scope-error" role="alert">{taskError || sessionsError}<button disabled={retryingTasks} onClick={() => { void retryTasks() }}>重试任务</button></div>}
        {tab === 'requirements' && data.requirementsError && <div className="scope-error" role="alert">{data.requirementsError}<button onClick={data.retryRequirements}>重试需求</button></div>}
        <div className="scope-list">{tab === 'requirements' ? requirementRows.slice(currentPage*50,(currentPage+1)*50).map(r => <button className="scope-list-row" key={r.id} onClick={() => onNavigate({ kind:'requirement',id:r.id })}><UiIcon name="file" size={16} /><span>{r.name}</span><AttentionBadge count={attention.get('requirement:'+r.id)} /><UiIcon name="chevron-right" size={13} /></button>) : taskRows.slice(currentPage*50,(currentPage+1)*50).map(session => <button className="scope-list-row" key={session.id} data-task-id={session.id} onClick={() => { void Promise.resolve(onOpenTask(session.id)).catch(reason => setTaskError(String(reason))) }}><UiIcon name={location.kind === 'assistant' ? 'user-circle' : 'bot'} size={16} /><span>{sessionDisplayTitle(session)}</span><small className={pending[session.id] || status[session.id] === 'awaiting-approval' ? 'needs-attention' : ''}>{browserTaskStatus(session, status[session.id], !!pending[session.id])} · {new Date(session.updatedAt ?? session.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small><UiIcon name="chevron-right" size={13} /></button>)}</div>
        {!count && !sessionsError && !(tab === 'requirements' && data.requirementsError) && <div className="scope-empty"><p>{tab === 'requirements' ? requirementsEnabled ? '这个项目还没有需求。' : '需求功能已停用，可在设置中开启；也可以切换到直属任务。' : archived ? '暂无已归档任务。' : location.kind === 'assistant' ? '暂无个人助手会话，可继续使用原飞书助手入口。' : '这里还没有任务。'}</p>{tab === 'tasks' && !archived && canCreate && <button className="scope-button" onClick={create}>新建任务</button>}</div>}
        {last > 0 && <div className="scope-pagination"><button className="scope-button" disabled={currentPage === 0} onClick={() => changePage(currentPage-1)}>上一页</button><span>{currentPage+1} / {last+1}</span><button className="scope-button" disabled={currentPage === last} onClick={() => changePage(currentPage+1)}>下一页</button></div>}
      </>}
    </div>
    {editing && <RequirementEditor requirement={editing === 'edit' ? requirement : undefined} initialProjectId={project?.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); data.retryRequirements() }} />}
  </section>
}
