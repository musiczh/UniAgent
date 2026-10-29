import { useState } from 'react'
import type { Session } from '@shared/types'
import { UiIcon } from './Icons'

export function WorktreeCreation({ session }: { session: Session }): JSX.Element | null {
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const tree = session.config.worktree
  if (!tree) return null
  const pending = !!session.worktreeTask || tree.state !== 'ready'
  const failure = tree.lastError || session.worktreeTaskError || error
  if (!pending && !failure) return null

  async function retry(): Promise<void> {
    setRetrying(true); setError('')
    try { await window.uniagent.retryWorktreeTask(session.id) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setRetrying(false) }
  }

  return <div className="worktree-creation-shell"><div className={`worktree-creation-card${failure ? ' is-failed' : ''}`} role={failure ? 'alert' : 'status'}>
    <div className="worktree-creation-icon"><UiIcon name={failure ? 'warn' : 'fork'} size={17} /></div>
    <div className="worktree-creation-main">
      <div className="worktree-creation-title">{failure ? tree.state === 'ready' ? '工作树已就绪，任务尚未启动' : '工作树创建失败' : tree.state === 'ready' ? '正在准备任务…' : '正在创建工作树…'}{!failure && <span className="loading-spinner" aria-hidden />}</div>
      <p>{failure || '正在准备独立工作目录，完成后自动开始执行任务。'}</p>
      <div className="worktree-creation-meta"><span><UiIcon name="folder" size={12} />{tree.sourcePrimaryDirectory.split('/').pop()}</span><span><UiIcon name="fork" size={12} />基于 {tree.baseRef === 'HEAD' ? tree.baseCommit.slice(0, 7) : tree.baseRef.replace(/^refs\/heads\//, '')}</span></div>
      <div className="worktree-creation-path">{tree.workdir}</div>
      {failure && pending && <button type="button" disabled={retrying} onClick={() => void retry()}><UiIcon name="refresh" size={13} />{retrying ? '正在重试…' : '重试创建'}</button>}
      {failure && tree.state === 'ready' && <p>也可在下方修改任务后发送。</p>}
    </div>
  </div></div>
}
