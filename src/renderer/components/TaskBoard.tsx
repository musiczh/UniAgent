import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentDef, Project } from '@shared/types'
import type { Requirement } from '@shared/requirementTypes'
import { TASK_BOARD_COLUMNS, type TaskBoardColumn, type TaskBoardEntry, type TaskBoardPage, type TaskBoardQuery, type TaskBoardSnapshot } from '@shared/taskBoard'
import { readBrowserValue, saveBrowserValue } from '../scopeBrowser'
import { clearSessionDeletionError, useSessionDeletions } from '../sessionDeletion'
import { ClockIcon, UiIcon } from './Icons'
import { isArchiveCancelled } from '@shared/worktreeArchive'
import { TaskFocusQueue } from './TaskFocusQueue'
import { WorktreeStatusBadge } from './WorktreeStatusBadge'
import { AgentIcon } from './AgentIcon'
import './workspaceBrowser.css'
import './taskBoard.css'
import { useLayoutMotion } from '../conversationMotion'

export function TaskBoard({ projects, requirements, agents, attentionBySession, unreadBySession, onOpenTask, onOpenRouter, onOpenRequirement, onDeleteTask, onCreate }: {
  projects: Project[]; requirements: Requirement[]; agents?: AgentDef[]; attentionBySession?: Record<string, string>; unreadBySession?: Record<string, unknown>; onOpenTask: (id: string) => void | Promise<void>; onOpenRouter?: (requestId: string) => void | Promise<void>; onOpenRequirement?: (id: string) => void; onDeleteTask: (id: string) => Promise<void>; onCreate: () => void
}): JSX.Element {
  return <section className="task-board" aria-label="任务看板">
    <div className="main-panel-head settings-head"><span className="main-panel-title">任务看板</span></div>
    <div className="task-board-content"><div className="scope-heading"><div><h1>任务看板</h1><p>先处理问题，再决定任务如何推进</p></div><button className="scope-button primary" onClick={onCreate}><UiIcon name="plus" size={14}/>新建任务</button></div>
      <TaskBoardWorkspace projects={projects} requirements={requirements} agents={agents} attentionBySession={attentionBySession} unreadBySession={unreadBySession} onOpenTask={onOpenTask} onOpenRouter={onOpenRouter} onOpenRequirement={onOpenRequirement} onDeleteTask={onDeleteTask}/>
    </div>
  </section>
}

type BoardScope = { key: string; kind: 'space' | 'requirement' | 'router'; name: string; id?: string }

export function TaskBoardWorkspace({ projects, requirements, agents = [], attentionBySession = {}, unreadBySession = {}, onOpenTask, onOpenRouter, onOpenRequirement, onDeleteTask, requirementId }: {
  projects: Project[]; requirements: Requirement[]; agents?: AgentDef[]; attentionBySession?: Record<string, string>; unreadBySession?: Record<string, unknown>; onOpenTask: (id: string) => void | Promise<void>; onOpenRouter?: (requestId: string) => void | Promise<void>; onOpenRequirement?: (id: string) => void; onDeleteTask: (id: string) => Promise<void>; requirementId?: string
}): JSX.Element {
  const key = 'ua.taskBoard.' + (requirementId || 'all')
  const deletion = useSessionDeletions()
  const [pages, setPages] = useState<TaskBoardQuery['pages']>(() => {
    const value = readBrowserValue<TaskBoardQuery['pages']>(key + '.pages', {})
    return Object.fromEntries(Object.entries(value || {}).filter(([name, page]) => name in TASK_BOARD_COLUMNS && Number.isSafeInteger(page) && page! >= 0))
  })
  const [data, setData] = useState<TaskBoardSnapshot | null>(null)
  const motionRef = useRef<HTMLDivElement>(null)
  useLayoutMotion(motionRef, !!data, '.task-board-columns [data-motion-key]')
  const [error, setError] = useState('')
  const [openError, setOpenError] = useState('')
  const [opening, setOpening] = useState(false)
  const [archiveWidth, setArchiveWidth] = useState(() => readBrowserValue<boolean>(key + '.archiveWidth', false) === true)
  const actionLocks = useRef(new Set<string>())
  const actionIds = useRef(new Map<string, { fingerprint: string; id: string }>())
  const [pendingActions, setPendingActions] = useState(new Set<string>())
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const refresh = useCallback(() => setRetry(value => value + 1), [])
  useEffect(() => {
    let live = true, ticket = 0, timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      const request = ++ticket
      setLoading(true)
      void window.uniagent.getTaskBoard({ pages, includeArchived: archiveWidth, ...(requirementId ? { requirementId } : {}) }).then(value => {
        if (!value?.columns) throw new Error('看板数据暂不可用')
        if (live && request === ticket) { setData(value); setError(''); setLoading(false) }
      }).catch(reason => { if (live && request === ticket) { setError(String(reason)); setLoading(false) } })
    }
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; load() }, 100) }
    load()
    const off = window.uniagent.onTaskBoardChanged(schedule)
    return () => { live = false; if (timer) clearTimeout(timer); off() }
  }, [pages, requirementId, retry, archiveWidth])
  function changePage(column: TaskBoardColumn, page: number): void {
    const next = { ...pages, [column]: page }
    saveBrowserValue(key + '.pages', next); saveBrowserValue(key + '.scroll.' + column, 0); setPages(next)
  }
  async function openTask(id: string, routing = false): Promise<void> {
    if (opening) return
    setOpening(true); setOpenError('')
    try {
      if (routing) {
        if (!onOpenRouter) throw new Error('RouterAgent 入口暂不可用')
        await onOpenRouter(id)
      } else await onOpenTask(id)
    } catch (reason) { setOpenError(String(reason)) } finally { setOpening(false) }
  }
  async function act(entry: TaskBoardEntry, action: 'pause' | 'standby' | 'archive'): Promise<void> {
    if (actionLocks.current.has(entry.id) || entry.readOnly || !(action === 'pause' ? entry.canPause : entry.canDecide)) return
    actionLocks.current.add(entry.id); setPendingActions(new Set(actionLocks.current)); setOpenError('')
    try {
      if (action === 'pause') await window.uniagent.interrupt(entry.id)
      else {
        const snapshot = await window.uniagent.getTaskState(entry.id)
        if (!snapshot?.record) throw new Error('任务状态暂不可用，请刷新后重试')
        if (snapshot.busy || snapshot.pendingDecisions || snapshot.record.decisionHint?.count) throw new Error('任务仍在执行或等待回答/授权，请先处理')
        const input = { expectedVersion: snapshot.record.version, inputRevision: snapshot.inputRevision, turnRevision: snapshot.turnRevision, disposition: action }
        const fingerprint = JSON.stringify(input)
        if (actionIds.current.get(entry.id)?.fingerprint !== fingerprint) actionIds.current.set(entry.id, { fingerprint, id: crypto.randomUUID() })
        const result = await window.uniagent.decideTask(entry.id, { ...input, actionId: actionIds.current.get(entry.id)!.id })
        if (result?.record.phase !== (action === 'archive' ? 'archived' : 'standby')) throw new Error('任务状态已变化，请核对最新结果')
      }
    } catch (reason) { if (!isArchiveCancelled(reason)) setOpenError(String(reason)) }
    finally { actionLocks.current.delete(entry.id); setPendingActions(new Set(actionLocks.current)); refresh() }
  }
  async function remove(entry: TaskBoardEntry): Promise<void> {
    if (actionLocks.current.has(entry.id) || !entry.canDelete) return
    if (entry.routerRequestId && !window.confirm('删除这条路由失败记录？\n\n确认后将从任务看板移除这条失败记录。Router 对话和诊断历史仍会保留。')) return
    actionLocks.current.add(entry.id); setPendingActions(new Set(actionLocks.current)); setOpenError('')
    try {
      if (entry.routerRequestId) {
        if (entry.routerRequestVersion === undefined) throw new Error('路由记录版本暂不可用，请刷新后重试')
        const result = await window.uniagent.cancelRouterInput(entry.routerRequestId, entry.routerRequestVersion)
        if (result?.state !== 'cancelled') throw new Error('路由记录已变化，请核对最新结果')
      } else await onDeleteTask(entry.id)
    } catch (reason) { setOpenError(String(reason)) }
    finally { actionLocks.current.delete(entry.id); setPendingActions(new Set(actionLocks.current)); refresh() }
  }
  const scopeFor = (entry: TaskBoardEntry): BoardScope => {
    if (entry.requirementId) {
      const requirement = requirements.find(item => item.id === entry.requirementId)
      return { key: 'requirement:' + entry.requirementId, kind: 'requirement', name: requirement?.name || '原需求', id: requirement?.id }
    }
    return entry.routerRequestId && !entry.projectId ? { key: 'router', kind: 'router', name: '自动归属' }
      : { key: 'space:' + (entry.projectId || 'default'), kind: 'space', name: projects.find(item => item.id === entry.projectId || !entry.projectId && item.isDefault)?.name || '原项目' }
  }
  const card = (entry: TaskBoardEntry) => {
    const agent = agents.find(agent => agent.id === entry.agentId)
    const deciding = entry.column === 'decision', pending = pendingActions.has(entry.id)
    const routing = !!entry.routerRequestId
    const running = routing ? entry.status === '路由中' : entry.canPause || ['running', 'queued', 'cancelling'].includes(entry.executionStatus || '')
    const unreadKind = unreadBySession[entry.id]
    const unread = entry.column !== 'archived' && (unreadKind === 'main' || unreadKind === 'side') ? unreadKind : undefined
    const unreadLabel = unread === 'side' ? '侧边对话有新回复' : '有新回复'
    const attention = entry.column !== 'archived' && attentionBySession[entry.id]
    const attentionLabel = attention ? `${attention}\n${entry.attentionDetail || entry.status}` : ''
    const actions: Array<'pause' | 'standby' | 'archive' | 'delete'> = entry.readOnly ? [] : entry.column === 'active' ? entry.canPause ? ['pause'] : [] : deciding ? ['standby', 'archive'] : entry.column === 'standby' ? ['archive'] : []
    if (entry.canDelete) actions.push('delete')
    return <article key={entry.id} className={`task-board-card ${entry.priority}`} data-task-id={entry.id} data-card-column={entry.column} data-motion-key={`task:${entry.id}`}>
      <button type="button" className="task-board-card-open" disabled={opening} title={routing ? '打开 RouterAgent' : undefined} onClick={() => { void openTask(entry.routerRequestId || entry.id, routing) }}>
        <div className="task-board-card-heading"><span className="task-board-agent">{routing ? <UiIcon name="router" size={15}/> : entry.teamTask ? <UiIcon name="users" size={15}/> : <AgentIcon agentId={entry.agentId} adapter={agent?.adapter}/>}</span><strong>{entry.title}</strong><span className="task-board-card-status">{(running || routing) && <span className={`task-board-indicator${deciding || routing && !running ? ' decision' : ''}`} title={entry.status + (entry.decisionCount > 1 ? ` · ${entry.decisionCount} 项` : '')} role="img" aria-label={entry.status}>{running ? <span className="si-spinner"/> : <UiIcon name={entry.status === '待确认' ? 'question' : 'alert-circle'} size={13}/>}</span>}{routing && <span className="task-board-routing-label">{entry.status}</span>}{attention && <span className="task-board-attention" role="img" aria-label={attentionLabel} title={attentionLabel}><UiIcon name="alert-circle" size={13}/></span>}{unread && <span className="task-board-unread" role="img" aria-label={unreadLabel} title={unreadLabel}/>}</span></div>
        {entry.description && <p className="task-board-card-description" title={entry.description}>{entry.description}</p>}
      </button>
      {entry.worktree && <WorktreeStatusBadge key={`${entry.id}:${entry.worktree.id}`} sessionId={entry.id} worktree={entry.worktree} compact/>}
      {!!actions.length && <div className="task-board-card-actions" role="group" aria-label="任务快捷操作">{actions.map(action => {
        const label = action === 'delete' ? routing ? '删除失败记录' : '删除任务' : action === 'pause' ? '暂停任务' : action === 'standby' ? '待定' : '归档'
        const allowed = action === 'delete' ? entry.canDelete : action === 'pause' ? entry.canPause : entry.canDecide
        return <button key={action} type="button" className={`task-board-card-action ${action}`} data-action={action} aria-label={label + '：' + entry.title} title={!allowed ? '请先处理回答/授权或核对任务状态' : action === 'pause' ? '暂停任务：停止本轮并清空待发送队列，保留记录' : label} disabled={pending || !allowed} onClick={() => { void (action === 'delete' ? remove(entry) : act(entry, action)) }}>{action === 'pause' ? <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M8 5v14M16 5v14"/></svg> : action === 'standby' ? <ClockIcon size={13}/> : <UiIcon name={action === 'delete' ? 'trash' : 'archive'} size={13}/>}</button>
      })}</div>}
    </article>
  }
  const visiblePage = (id: TaskBoardColumn) => {
    const page = data?.columns[id]
    if (!page) return undefined
    const items = page.items.filter(entry => !deletion.hiddenIds.has(entry.id))
    return { ...page, items, total: Math.max(0, page.total - (page.items.length - items.length)) }
  }
  return <div className="task-board-workspace" ref={motionRef}>
    {(error || openError || deletion.error) && <div className="task-board-error" role="alert">{openError || deletion.error || '更新暂时中断，保留最近已知状态。'}{data && <span>最近更新 {new Date(data.updatedAt).toLocaleTimeString()}</span>}<button className="scope-link" onClick={() => { setOpenError(''); clearSessionDeletionError(); refresh() }}>重试</button></div>}
    {!data && !error && <p className="scope-muted" role="status">正在读取任务状态…</p>}
    <TaskFocusQueue entries={(data?.focus || []).filter(entry => !deletion.hiddenIds.has(entry.id))} onRefresh={refresh} onOpenTask={openTask}/>
    <div className={`task-board-columns${archiveWidth ? ' archive-expanded' : ''}`}>{(Object.entries(TASK_BOARD_COLUMNS) as Array<[TaskBoardColumn, string]>).map(([id, title]) => <BoardColumn key={id} id={id} scrollKey={key + '.scroll.' + id} title={title} page={visiblePage(id)} loading={loading} render={card} scopeFor={requirementId ? undefined : scopeFor} onOpenRequirement={onOpenRequirement} onPage={page => changePage(id, page)} collapsed={id === 'archived' && !archiveWidth} onToggleWidth={() => { const next = !archiveWidth; saveBrowserValue(key + '.archiveWidth', next); setArchiveWidth(next) }}/>)}</div>
  </div>
}

function BoardColumn({ id, scrollKey, title, page, loading, render, scopeFor, onOpenRequirement, onPage, collapsed, onToggleWidth }: { id: TaskBoardColumn; scrollKey: string; title: string; page?: TaskBoardPage; loading: boolean; render: (entry: TaskBoardEntry) => JSX.Element; scopeFor?: (entry: TaskBoardEntry) => BoardScope; onOpenRequirement?: (id: string) => void; onPage: (page: number) => void; collapsed: boolean; onToggleWidth: () => void }): JSX.Element {
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!scroll.current || !page) return
    const value = readBrowserValue(scrollKey, 0)
    scroll.current.scrollTop = Number.isFinite(value) ? value : 0
  }, [scrollKey, page?.page, !!page, collapsed])
  const groups = new Map<string, { scope: BoardScope; items: TaskBoardEntry[] }>()
  if (scopeFor) for (const item of page?.items || []) {
    const scope = scopeFor(item)
    if (!groups.has(scope.key)) groups.set(scope.key, { scope, items: [] })
    groups.get(scope.key)!.items.push(item)
  }
  return <section className="task-board-column" aria-label={title} data-column={id}>
    {collapsed ? <button type="button" className="archive-rail" data-motion-key={`column:${id}`} aria-label="展开已归档列" aria-expanded={false} onClick={onToggleWidth}><UiIcon name="chevron-left" size={15}/><UiIcon name="archive" size={15}/><strong>{title}</strong><span>{page?.total ?? 0}</span></button> : <>
      <header data-motion-key={`column:${id}`}><h2>{title}</h2><span>{page?.total ?? 0}</span>{id === 'archived' && <button type="button" className="archive-width-toggle" aria-label="横向收起归档列" onClick={onToggleWidth}><UiIcon name="chevron-right" size={15}/></button>}</header>
      <div ref={scroll} className="task-board-column-scroll" onScroll={event => saveBrowserValue(scrollKey, event.currentTarget.scrollTop)}>
        {scopeFor ? [...groups.values()].map(({ scope, items }) => {
          const head = <><UiIcon name={scope.kind === 'requirement' ? 'file' : scope.kind === 'router' ? 'router' : 'folder'} size={12}/><span title={scope.name}>{scope.name}</span></>
          const headProps = { className: `task-board-group-head ${scope.kind}`, 'data-scope-kind': scope.kind, 'data-motion-key': `group:${id}:${scope.key}` }
          return <section key={scope.key} className="task-board-group">{scope.id && onOpenRequirement
            ? <button type="button" {...headProps} title={'打开需求 ' + scope.name} aria-label={'打开需求 ' + scope.name} onClick={() => onOpenRequirement(scope.id!)}>{head}</button>
            : <div {...headProps}>{head}</div>}{items.map(render)}</section>
        }) : page?.items.map(render)}{page && !page.total && <p className="task-board-empty" data-motion-key={`empty:${id}`}>{id === 'decision' ? '暂无待决策事项' : id === 'standby' ? '暂定的任务会保留在这里' : id === 'archived' ? '暂无已归档任务' : '暂无进行中的任务'}</p>}
      </div>{page && <Pagination title={title} page={page} loading={loading} onPage={onPage}/>}
    </>}
  </section>
}
function Pagination({ title, page, loading, onPage }: { title: string; page: TaskBoardPage; loading: boolean; onPage: (page: number) => void }): JSX.Element | null {
  if (page.pages <= 1) return null
  return <div className="task-board-pagination"><button aria-label={title + '上一页'} disabled={loading || page.page === 0} onClick={() => onPage(page.page - 1)}><UiIcon name="chevron-left" size={14}/></button><span>{page.page + 1} / {page.pages}</span><button aria-label={title + '下一页'} disabled={loading || page.page + 1 >= page.pages} onClick={() => onPage(page.page + 1)}><UiIcon name="chevron-right" size={14}/></button></div>
}
