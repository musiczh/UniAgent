import { sessionDisplayTitle } from '@shared/task'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Project, ProjectWorktree, Session } from '@shared/types'
import { UiIcon } from './Icons'

const STATE_LABEL: Record<ProjectWorktree['state'], string> = {
  ready: '可清理', dirty: '有改动', locked: '已锁定', missing: '不可用', creating: '创建中', failed: '创建失败', busy: '使用中'
}

type WorktreeSnapshot = { rows?: ProjectWorktree[]; loading: boolean; error: string }
type WorktreeCache = {
  snapshot: WorktreeSnapshot
  listeners: Set<() => void>
  request?: Promise<void>
}

// Tabs unmount their contents. Keep successful results and pending reads across visits.
const worktreeCache = new Map<string, WorktreeCache>()

function cachedWorktrees(project: Project): WorktreeCache {
  const key = JSON.stringify([project.id, project.primaryDirectory])
  let cached = worktreeCache.get(key)
  if (!cached) {
    cached = { snapshot: { loading: true, error: '' }, listeners: new Set() }
    worktreeCache.set(key, cached)
  }
  return cached
}

function publish(cached: WorktreeCache, next: WorktreeSnapshot): void {
  const previous = cached.snapshot
  if (next.rows !== previous.rows && JSON.stringify(next.rows) === JSON.stringify(previous.rows)) next.rows = previous.rows
  if (next.rows === previous.rows && next.loading === previous.loading && next.error === previous.error) return
  cached.snapshot = next
  cached.listeners.forEach(listener => listener())
}

function refresh(cached: WorktreeCache, projectId: string): Promise<void> {
  if (cached.request) return cached.request
  const request = window.uniagent.listProjectWorktrees(projectId).then(rows => {
    if (cached.request === request) publish(cached, { rows, loading: false, error: '' })
  }).catch(reason => {
    if (cached.request === request) publish(cached, {
      ...cached.snapshot, loading: false, error: reason instanceof Error ? reason.message : String(reason)
    })
  }).finally(() => { if (cached.request === request) cached.request = undefined })
  cached.request = request
  publish(cached, { ...cached.snapshot, loading: true, error: '' })
  return request
}

export function ProjectWorktrees({ project, sessions = [], onOpenSession }: { project: Project; sessions?: Session[]; onOpenSession?: (id: string) => void }): JSX.Element {
  const taskTitles = useMemo(() => new Map(sessions.map(session => [session.id, sessionDisplayTitle(session)])), [sessions])
  const sessionTitle = (session: ProjectWorktree['sessions'][number]) => taskTitles.get(session.id) || session.title
  const cached = cachedWorktrees(project)
  const subscribe = useCallback((listener: () => void) => {
    cached.listeners.add(listener)
    return () => { cached.listeners.delete(listener) }
  }, [cached])
  const getSnapshot = useCallback(() => cached.snapshot, [cached])
  const { rows, loading, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [removing, setRemoving] = useState('')
  const [sessionsPath, setSessionsPath] = useState('')

  useEffect(() => {
    void refresh(cached, project.id)
  }, [cached, project.id])

  async function remove(row: ProjectWorktree): Promise<void> {
    const latest = await window.uniagent.listProjectWorktrees(project.id)
    const current = latest.find(tree => tree.path === row.path)
    if (!current || current.removalBlockedReason) throw new Error(current?.removalBlockedReason || '工作树已不存在，请刷新')
    if (!window.confirm(`确定删除工作树吗？\n\n${row.path}\n\n${current.sessions.length ? `${current.sessions.length} 个关联会话将自动切回各自原项目主目录，历史消息保留，下次打开时会显示提示。` : '该工作树没有关联会话。'}\n\n工作树目录将被删除，Git 分支不会删除。`)) return
    setRemoving(row.path)
    publish(cached, { ...cached.snapshot, error: '' })
    try {
      const rows = await window.uniagent.removeProjectWorktree(project.id, row.path)
      // A read started before removal must not overwrite the authoritative mutation result.
      cached.request = undefined
      publish(cached, { rows, loading: false, error: '' })
    } finally { setRemoving('') }
  }
  function run(action: () => Promise<unknown>): void {
    void action().catch(reason => publish(cached, {
      ...cached.snapshot, error: reason instanceof Error ? reason.message : String(reason)
    }))
  }

  return <div className="project-worktrees">
    <div className="project-worktrees-head"><span>所属仓库的全部工作树{rows && ` · ${rows.length}`}</span><button type="button" disabled={loading || !!removing} onClick={() => void refresh(cached, project.id)}><UiIcon name="refresh" size={13} />刷新</button></div>
    {loading && !rows && <div className="project-worktrees-empty" role="status">正在读取工作树…</div>}
    {rows && !rows.length && !error && <div className="project-worktrees-empty">主目录不是 Git 仓库，或暂无可用工作树。</div>}
    {rows?.map(row => <div className="project-worktree-row" key={row.path}>
      <UiIcon name="fork" size={14} />
      <div className="project-worktree-main">
        <div className="project-worktree-title"><strong>{row.path.split('/').pop()}</strong><span className="project-worktree-source">{row.source === 'primary' ? '主工作区' : row.source === 'managed' ? 'UniAgent' : '手动创建'}</span><span className={`project-worktree-state is-${row.state}`} title={row.removalBlockedReason}>{row.state === 'ready' ? row.source === 'primary' ? '当前目录' : row.removalBlockedReason ? '需处理' : '可清理' : STATE_LABEL[row.state]}</span></div>
        <div className="project-worktree-sub">{row.branch || (row.commit ? `detached · ${row.commit.slice(0, 7)}` : '尚未创建')} · {row.sessions.length ? <button type="button" className="project-worktree-session" onClick={() => row.sessions.length === 1 ? onOpenSession?.(row.sessions[0].id) : setSessionsPath(sessionsPath === row.path ? '' : row.path)}>{row.sessions.length === 1 ? sessionTitle(row.sessions[0]) : `${row.sessions.length} 个会话`}</button> : '无关联会话'}</div>
        <div className="project-worktree-path" title={row.path}>{row.path}</div>
        {sessionsPath === row.path && <div className="project-worktree-sessions">{row.sessions.map(session => <button type="button" key={session.id} onClick={() => onOpenSession?.(session.id)}>{sessionTitle(session)}</button>)}</div>}
      </div>
      <div className="project-worktree-actions">
        <button type="button" title="打开目录" aria-label="打开工作树目录" disabled={['missing', 'creating', 'failed'].includes(row.state)} onClick={() => run(() => window.uniagent.openProjectWorktree(project.id, row.path))}><UiIcon name="folder" size={13} /></button>
        <button type="button" title="复制路径" aria-label="复制工作树路径" onClick={() => run(() => navigator.clipboard.writeText(row.path))}><UiIcon name="copy" size={13} /></button>
        <button type="button" title={row.removalBlockedReason || '删除工作树'} aria-label="删除工作树" disabled={!!removing || loading || !!row.removalBlockedReason} onClick={() => run(() => remove(row))}><UiIcon name="trash" size={13} /></button>
      </div>
    </div>)}
    {error && <p className="project-worktrees-error" role="alert">{error}</p>}
    <p className="project-worktrees-foot">主工作区、使用中或含未提交改动的工作树不可删除。删除后关联会话自动切回原项目。</p>
  </div>
}
