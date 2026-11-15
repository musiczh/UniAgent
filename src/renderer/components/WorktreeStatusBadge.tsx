import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionWorktreeStatus, WorktreeStatusBinding } from '@shared/sessionWorktreeStatus'
import { AnchoredPopover } from './AnchoredPopover'
import { UiIcon } from './Icons'
import './worktreeStatus.css'

type Snapshot = { status?: SessionWorktreeStatus; loading: boolean; error: string }
type Cached = { snapshot: Snapshot; listeners: Set<() => void>; pending?: Promise<void> }
const cache = new Map<string, Cached>()

function cachedStatus(key: string): Cached {
  let value = cache.get(key)
  if (!value) { value = { snapshot: { loading: true, error: '' }, listeners: new Set() }; cache.set(key, value) }
  return value
}
function publish(value: Cached, snapshot: Snapshot): void { value.snapshot = snapshot; value.listeners.forEach(listener => listener()) }
function refresh(value: Cached, sessionId: string, treeId: string, force = true): Promise<void> {
  if (value.pending) return value.pending
  if (!force && !value.snapshot.error && value.snapshot.status && Date.now() - value.snapshot.status.checkedAt < 5000) return Promise.resolve()
  publish(value, { ...value.snapshot, loading: true })
  const request = window.uniagent.getSessionWorktreeStatus(sessionId, force).then(status => {
    if (!status || status.treeId !== treeId) throw new Error('工作树状态暂不可用')
    publish(value, { status, loading: false, error: '' })
  }).catch(error => publish(value, { ...value.snapshot, loading: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { value.pending = undefined })
  value.pending = request
  return request
}

export function WorktreeStatusBadge({ sessionId, worktree, compact = false, onMerge }: { sessionId: string; worktree: WorktreeStatusBinding; compact?: boolean; onMerge?: () => void }): JSX.Element {
  const key = JSON.stringify([worktree.id, worktree.workdir, worktree.baseRef, worktree.branch, worktree.state, worktree.removedAt])
  const value = cachedStatus(key)
  const subscribe = useCallback((listener: () => void) => { value.listeners.add(listener); return () => { value.listeners.delete(listener) } }, [value])
  const snapshot = useSyncExternalStore(subscribe, () => value.snapshot)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null), dialogId = useId()
  const close = useCallback((restoreFocus = false) => { setOpen(false); if (restoreFocus) anchor.current?.focus({ preventScroll: true }) }, [])
  const ready = worktree.state === 'ready' && !worktree.removedAt
  useEffect(() => {
    setOpen(false)
    if (!ready) return
    const read = () => { if (document.visibilityState !== 'hidden') void refresh(value, sessionId, worktree.id) }
    if (document.visibilityState !== 'hidden') void refresh(value, sessionId, worktree.id, false)
    const timer = setInterval(read, 15000)
    window.addEventListener('focus', read)
    const off = window.uniagent.onStatusChange(event => { if (event.sessionId === sessionId) read() })
    return () => { clearInterval(timer); window.removeEventListener('focus', read); off() }
  }, [value, ready, sessionId, worktree.id])
  const { status, error, loading } = snapshot
  const pending = !!status && (status.unmergedCommits > 0 || status.changedFiles > 0)
  const label = worktree.removedAt ? '工作树已移除' : worktree.state === 'creating' ? '工作树创建中' : !ready ? '工作树不可用' : error ? '状态待确认' : !status ? '检测中' : pending ? '待合入' : '无待合入'
  const problem = worktree.removedAt ? '工作树已移除' : !ready ? worktree.lastError || label : error
  const title = [label, `执行目录：${worktree.workdir}`, `源分支：${worktree.baseRef?.replace(/^refs\/heads\//, '') || '尚未确定'}`, worktree.branch && `当前分支：${worktree.branch}`, status && `领先 ${status.unmergedCommits} 个提交 · ${status.changedFiles} 个本地改动`, problem].filter(Boolean).join('\n')
  return <>
    <button ref={anchor} type="button" className={`session-worktree-badge task-worktree-badge worktree-status-badge${compact ? ' is-compact' : ''}${problem ? ' needs-attention' : status && pending ? ' is-pending' : status ? ' is-clean' : ' is-inactive'}`} title={title} aria-label={`查看工作树状态：${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} onClick={() => { setOpen(current => !current); if (ready) void refresh(value, sessionId, worktree.id) }}><UiIcon name="fork" size={11}/>{label}</button>
    {open && <AnchoredPopover anchor={anchor} id={dialogId} labelledBy={`${dialogId}-title`} onClose={close} className="worktree-status-popover">
      <div className="session-info-head"><div><h2 id={`${dialogId}-title`}>工作树状态</h2><p>{label} · 自动检测本机源分支</p></div><button type="button" className="session-info-close" aria-label="关闭工作树状态" onClick={() => close(true)}><UiIcon name="close" size={16}/></button></div>
      <div className="session-info-content" aria-busy={loading && ready}>
        <dl className="worktree-status-fields"><dt>目录</dt><dd>{status?.directory || worktree.workdir}</dd><dt>源分支</dt><dd>{status?.sourceBranch || worktree.baseRef?.replace(/^refs\/heads\//, '') || '尚未确定'}</dd><dt>当前分支</dt><dd>{status?.branch || worktree.branch || '尚未确定'}</dd><dt>本地改动</dt><dd>{status ? status.changedFiles ? `有 ${status.changedFiles} 个文件未提交（含未跟踪文件）` : '没有未提交的改动' : '等待检测'}</dd></dl>
        {problem && <p className="scope-error" role="alert">{problem}</p>}
        <section className="worktree-status-commits"><h3>领先源分支的提交{status && ` · ${status.unmergedCommits}`}</h3>{status ? status.commits.length ? <><ol>{status.commits.map(commit => <li key={commit.hash}><code title={commit.hash}>{commit.hash.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ol>{status.unmergedCommits > status.commits.length && <p>显示最近 {status.commits.length} 条，共 {status.unmergedCommits} 条。</p>}</> : <p>没有待合入的提交。</p> : <p>{loading && ready ? '正在检测…' : '暂无检测结果。'}</p>}</section>
      </div>
      <div className="session-info-footer"><span>{status ? `最近检测：${new Date(status.checkedAt).toLocaleTimeString()}` : '检测仅查询本地 Git 状态'}</span><button type="button" className="session-info-copy-all" disabled={!ready || loading} onClick={() => { void refresh(value, sessionId, worktree.id) }}><UiIcon name="refresh" size={13}/>刷新</button>{onMerge && <button type="button" className="session-info-copy-all worktree-status-merge" aria-label="填入工作树合并指令" title="填入合并指令，发送后执行" disabled={!ready || loading || !!error || !status} onClick={() => { close(); onMerge() }}>合并</button>}</div>
    </AnchoredPopover>}
  </>
}
