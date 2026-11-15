import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { AgentDef, Project, Session } from '@shared/types'
import type { Requirement } from '@shared/requirementTypes'
import { isToolSession } from '@shared/types'
import type { SessionActivityStatus } from '@shared/sessionStatus'
import { isSessionBusy } from '@shared/sessionStatus'
import { sessionDisplayTitle } from '@shared/task'
import { taskHasEndedRound } from '@shared/taskLifecycle'
import { browserTaskStatus, readBrowserValue, saveBrowserValue } from '../scopeBrowser'
import { StatusIndicator, type ReplyUnreadKind } from './SessionList'
import { UiIcon } from './Icons'
import { AgentIcon } from './AgentIcon'

const PAGE_SIZE = 50
const KEY = 'ua.scopeBrowser.tasks'
const readPage = (key: string) => { const value = readBrowserValue<unknown>(key, 0); return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0 }

export function SidebarTaskList({ sessions, agents = [], projects, requirements, requirementsEnabled, activeTaskId, status, pending, unread, onOpenTask, loading, error, onRetry, onRequirementMenu }: {
  agents?: AgentDef[]
  projects: Project[]; requirements: Requirement[]; requirementsEnabled: boolean
  sessions: Session[]; activeTaskId?: string | null; status: Record<string, SessionActivityStatus>; pending: Record<string, boolean>; unread: Record<string, unknown>
  onOpenTask?: (id: string) => void | Promise<void>; loading?: boolean; error?: string | null; onRetry?: () => void | Promise<void>
  onRequirementMenu?: (requirement: Requirement, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void
}): JSX.Element {
  const [page, setPage] = useState(() => readPage(KEY + '.page'))
  const [archivePage, setArchivePage] = useState(() => readPage(KEY + '.archivePage'))
  const [archiveOpen, setArchiveOpen] = useState(() => readBrowserValue<boolean>(KEY + '.archiveOpen', false) === true)
  const [collapsed, setCollapsed] = useState<string[]>(() => { const saved = readBrowserValue<unknown>(KEY + '.collapsed', []); return Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [] })
  const [opening, setOpening] = useState(false)
  const openLock = useRef(false)
  const [openError, setOpenError] = useState('')
  const owners = useMemo(() => ({ spaces: new Map(projects.map(project => [project.id, project])), requirements: new Map(requirements.map(requirement => [requirement.id, requirement])) }), [projects, requirements])
  const rows = useMemo(() => {
    const unique = new Map<string, Session>()
    for (const session of sessions) {
      if (isToolSession(session) || session.config.managedPurpose || session.config.assistantSnapshot || session.config.initializationTargetAgentId) continue
      const previous = unique.get(session.id)
      if (!previous || (session.updatedAt || session.createdAt) > (previous.updatedAt || previous.createdAt)) unique.set(session.id, session)
    }
    const sorted = [...unique.values()].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt) || a.id.localeCompare(b.id))
    const archived = (session: Session) => !!session.archived || session.status === 'archived' || session.taskState?.phase === 'archived'
    return { active: sorted.filter(session => !archived(session)), archived: sorted.filter(archived) }
  }, [sessions])
  const pages = Math.max(1, Math.ceil(rows.active.length / PAGE_SIZE)), archivePages = Math.max(1, Math.ceil(rows.archived.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1), currentArchivePage = Math.min(archivePage, archivePages - 1)
  useEffect(() => { saveBrowserValue(KEY + '.page', currentPage) }, [currentPage])
  useEffect(() => { saveBrowserValue(KEY + '.archivePage', currentArchivePage) }, [currentArchivePage])
  useEffect(() => { saveBrowserValue(KEY + '.archiveOpen', archiveOpen) }, [archiveOpen])
  useEffect(() => { saveBrowserValue(KEY + '.collapsed', collapsed) }, [collapsed])
  useEffect(() => { setPage(currentPage); setArchivePage(currentArchivePage) }, [currentPage, currentArchivePage])
  async function openTask(id: string): Promise<void> {
    if (openLock.current || !onOpenTask) return
    openLock.current = true; setOpening(true); setOpenError('')
    try { await onOpenTask(id) } catch (reason) { setOpenError(String(reason)) }
    finally { openLock.current = false; setOpening(false) }
  }
  const row = (session: Session, archived = false) => {
    const agent = agents.find(agent => agent.id === session.config.agentId)
    const title = sessionDisplayTitle(session), activity = status[session.id] || session.status
    const waiting = !!pending[session.id] || !!session.taskState?.decisionHint?.count || activity === 'awaiting-approval'
    const busy = isSessionBusy(activity) || !!session.recovery && session.recovery.phase !== 'stopped' || !!session.pendingQueue?.some(item => item.state === 'pending')
    const phase = archived ? 'archived' : waiting || session.taskState?.error ? 'decision' : busy ? 'active' : session.taskState?.phase === 'standby' ? 'standby' : taskHasEndedRound(session) || session.taskState?.awaitingAcceptance ? 'decision' : 'active'
    const label = { archived: '已归档', decision: '待决策', standby: '待推进', active: '进行中' }[phase]
    const unreadKind = unread[session.id] === 'main' || unread[session.id] === 'side' ? unread[session.id] as ReplyUnreadKind : undefined
    const detail = archived ? label : label + ' · ' + browserTaskStatus(session, activity, waiting)
    return <div key={session.id} className={`scope-nav-row task${activeTaskId === session.id ? ' selected' : ''}`} data-task-id={session.id}>
      <button className="scope-nav-name" aria-current={activeTaskId === session.id ? 'page' : undefined} title={title + ' · ' + detail} disabled={opening || !onOpenTask} onClick={() => { void openTask(session.id) }}><span className="si-icon">{session.teamBinding ? <UiIcon name="users" size={15}/> : <AgentIcon agentId={session.config.agentId} adapter={agent?.adapter}/>}</span><span>{title}</span></button>
      <span className="scope-task-status" title={detail} aria-label={detail}>{!archived && <StatusIndicator status={busy && !isSessionBusy(activity) ? 'running' : activity} hasPendingInteraction={waiting} unread={unreadKind}/>}</span>
    </div>
  }
  const pagination = (value: number, total: number, name: string, change: (value: number) => void) => total > 1 && <div className="scope-task-pagination" aria-label={name + '分页'}>
    <button aria-label={name + '上一页'} disabled={value === 0} onClick={() => change(value - 1)}><UiIcon name="chevron-left" size={13}/></button><span>{value + 1} / {total}</span><button aria-label={name + '下一页'} disabled={value >= total - 1} onClick={() => change(value + 1)}><UiIcon name="chevron-right" size={13}/></button>
  </div>
  const groupedRows = (sessions: Session[], archived = false) => {
    const groups = new Map<string, { key: string; kind: 'requirement' | 'space'; title: string; sessions: Session[] }>()
    for (const session of sessions) {
      const requirementId = requirementsEnabled && session.config.requirementId
      const kind = requirementId ? 'requirement' : 'space'
      const owner = requirementId ? owners.requirements.get(requirementId) : owners.spaces.get(session.config.projectId || '')
      const key = kind + ':' + (owner?.id || '')
      let group = groups.get(key)
      if (!group) { group = { key, kind, title: owner?.name || (kind === 'requirement' ? '未关联需求' : '未关联项目'), sessions: [] }; groups.set(key, group) }
      group.sessions.push(session)
    }
    return [...groups.values()].sort((a, b) => Number(b.kind === 'requirement') - Number(a.kind === 'requirement')).map(group => {
      const key = (archived ? 'archived:' : 'active:') + group.key, open = !collapsed.includes(key)
      const requirement = group.kind === 'requirement' ? owners.requirements.get(group.key.slice('requirement:'.length)) : undefined
      return <div key={key} className="scope-task-group" data-task-group={key} data-group-kind={group.kind}>
        <button className={`scope-nav-row scope-task-group-toggle ${group.kind}`} aria-label={`${open ? '收起' : '展开'}${group.title}任务`} aria-expanded={open} onClick={() => setCollapsed(ids => open ? [...ids, key] : ids.filter(id => id !== key))} onContextMenu={event => { if (requirement) onRequirementMenu?.(requirement, event) }} onKeyDown={event => { if (requirement) onRequirementMenu?.(requirement, event) }}><UiIcon name={open ? 'chevron-down' : 'chevron-right'} size={12}/><UiIcon name={group.kind === 'requirement' ? 'file' : 'folder'} size={15}/><span>{group.title}</span></button>
        {open && group.sessions.map(session => row(session, archived))}
      </div>
    })
  }
  return <div className="scope-task-list">
    {loading && !sessions.length && <p className="scope-muted" role="status">正在读取任务…</p>}
    {error && <div className="scope-error" role="alert">任务读取失败{onRetry && <button onClick={() => { setOpenError(''); void Promise.resolve().then(() => onRetry()).catch(reason => setOpenError(String(reason))) }}>重试</button>}</div>}
    {openError && <div className="scope-error" role="alert">{openError}</div>}
    {!loading && !error && !rows.active.length && <p className="scope-muted">暂无未归档任务</p>}
    {groupedRows(rows.active.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE))}
    {pagination(currentPage, pages, '任务', setPage)}
    {!!rows.archived.length && <div className="scope-task-archive">
      <button className="scope-task-archive-toggle" aria-label={(archiveOpen ? '收起' : '展开') + '已归档任务'} aria-expanded={archiveOpen} onClick={() => setArchiveOpen(value => !value)}><UiIcon name={archiveOpen ? 'chevron-down' : 'chevron-right'} size={12}/><span>已归档</span><small>{rows.archived.length}</small></button>
      {archiveOpen && <>{groupedRows(rows.archived.slice(currentArchivePage * PAGE_SIZE, (currentArchivePage + 1) * PAGE_SIZE), true)}{pagination(currentArchivePage, archivePages, '已归档任务', setArchivePage)}</>}
    </div>}
  </div>
}
