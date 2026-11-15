import { useEffect, useState } from 'react'
import type { WorktreeArchiveAction, WorktreeArchiveReview as Review } from '@shared/worktreeArchive'
import { UiIcon } from './Icons'

export function WorktreeArchiveDialog({ review, onAction }: { review: Review; onAction: (action: WorktreeArchiveAction['action']) => Promise<void> }): JSX.Element | null {
  const [error, setError] = useState('')
  useEffect(() => setError(''), [review.id, review.version])
  if (review.phase === 'waiting') return null
  const sending = review.phase === 'sending', checking = review.phase === 'checking', failed = review.phase === 'failed'
  const title = checking ? '正在检查工作树…' : failed ? '暂时无法核验工作树' : '归档前还有改动未处理'
  const act = (action: WorktreeArchiveAction['action']) => { void onAction(action).catch(reason => setError(String(reason))) }
  return <div className="review-start-backdrop archive-backdrop" onMouseDown={event => { if (event.currentTarget === event.target && !sending) act('cancel') }}>
    <div className="review-start-dialog archive-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="review-start-head">
        <span className="review-start-icon">{checking ? <span className="loading-spinner"/> : <UiIcon name="archive" size={15}/>}</span>
        <div><strong>{title}</strong><small>{review.title}</small></div>
        <button type="button" aria-label="取消归档" disabled={sending} onClick={() => act('cancel')}><UiIcon name="close" size={13}/></button>
      </div>
      <div className="archive-body">
        {checking ? <p>正在读取未提交改动与未合并提交…</p> : failed ? <><p className="archive-error">{review.error}</p><p>任务仍保留，归档尚未完成</p></> : <>
          {review.checks.map(check => <div key={check.treeId} className="archive-checks">
            <div><span>未提交改动</span><strong>{check.changedFiles} 个文件</strong></div>
            <div><span>未合回 {check.sourceBranch}</span><strong>{check.unmergedCommits} 个提交</strong></div>
            {check.gitOperation && <p className="archive-error">尚有未完成的 Git 操作：{check.gitOperation}</p>}
          </div>)}
          <p>点击合并，将向当前任务发送消息，由 Agent 提交改动、合并回源分支并处理冲突。</p>
          <small>任务暂不归档；处理完成后重新核验，再继续归档。</small>
        </>}
        {error && <p role="alert" className="archive-error">{error}</p>}
      </div>
      <div className="review-start-actions"><span/><button type="button" disabled={sending} onClick={() => act('cancel')}>取消归档</button>
        {!checking && <button type="button" className="primary" disabled={sending} onClick={() => act(failed ? 'retry' : 'merge')}>{sending ? '正在发送…' : failed ? '重试检查' : '合并'}</button>}
      </div>
    </div>
  </div>
}

export function WorktreeArchiveReview(): JSX.Element | null {
  const [reviews, setReviews] = useState<Review[]>([])
  useEffect(() => {
    let live = true, received = false
    const off = window.uniagent.onWorktreeArchiveReviews(value => { received = true; if (live) setReviews(value) })
    void window.uniagent.getWorktreeArchiveReviews().then(value => { if (live && !received) setReviews(value) }).catch(() => {})
    return () => { live = false; off() }
  }, [])
  const review = reviews.find(value => value.phase !== 'waiting')
  return review ? <WorktreeArchiveDialog key={review.id} review={review} onAction={action => window.uniagent.actWorktreeArchive({ id: review.id, version: review.version, action })}/> : null
}
