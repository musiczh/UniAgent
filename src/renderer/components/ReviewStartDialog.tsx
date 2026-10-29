import { useState } from 'react'
import type { NativeReviewDraft, NativeReviewScope } from '@shared/nativeCapabilities'
import { UiIcon } from './Icons'

export type ReviewScopeType = NativeReviewScope['type']

export function buildReviewDraft(
  scopeType: ReviewScopeType,
  branch: string,
  sha: string,
  instructions: string
): NativeReviewDraft {
  const extra = instructions.trim() || undefined
  if (scopeType === 'baseBranch') {
    return { scope: { type: 'baseBranch', branch: branch.trim() }, ...(extra ? { instructions: extra } : {}) }
  }
  if (scopeType === 'commit') {
    return { scope: { type: 'commit', sha: sha.trim() }, ...(extra ? { instructions: extra } : {}) }
  }
  if (scopeType === 'custom') {
    return { scope: { type: 'custom' }, ...(extra ? { instructions: extra } : {}) }
  }
  return { scope: { type: 'uncommittedChanges' }, ...(extra ? { instructions: extra } : {}) }
}

export function isReviewDraftValid(draft: NativeReviewDraft): boolean {
  if (draft.scope.type === 'baseBranch') return draft.scope.branch.trim().length > 0
  if (draft.scope.type === 'commit') return draft.scope.sha.trim().length > 0
  if (draft.scope.type === 'custom') return !!draft.instructions?.trim()
  return true
}

export function ReviewStartDialog({
  open,
  submitting,
  onClose,
  onSubmit
}: {
  open: boolean
  submitting: boolean
  onClose: () => void
  onSubmit: (draft: NativeReviewDraft) => void | Promise<void>
}): JSX.Element | null {
  const [scopeType, setScopeType] = useState<ReviewScopeType>('uncommittedChanges')
  const [branch, setBranch] = useState('')
  const [sha, setSha] = useState('')
  const [instructions, setInstructions] = useState('')
  if (!open) return null
  const draft = buildReviewDraft(scopeType, branch, sha, instructions)
  const valid = isReviewDraftValid(draft)
  return (
    <div className="review-start-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose()
    }}>
      <div className="review-start-dialog" role="dialog" aria-modal="true" aria-label="开始 Review">
        <div className="review-start-head">
          <span className="review-start-icon"><UiIcon name="file-diff" size={14} /></span>
          <div><strong>开始 Review</strong><small>调用 Agent 原生 review/start</small></div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="关闭 Review">
            <UiIcon name="close" size={13} />
          </button>
        </div>
        <label className="review-start-field">
          <span>审查范围</span>
          <select aria-label="Review 范围" value={scopeType} disabled={submitting} onChange={(event) => setScopeType(event.target.value as ReviewScopeType)}>
            <option value="uncommittedChanges">未提交的修改</option>
            <option value="baseBranch">相对基础分支</option>
            <option value="commit">指定 Commit</option>
            <option value="custom">自定义审查</option>
          </select>
        </label>
        {scopeType === 'baseBranch' && (
          <label className="review-start-field">
            <span>基础分支</span>
            <input aria-label="基础分支" placeholder="例如：master" value={branch} disabled={submitting} onChange={(event) => setBranch(event.target.value)} />
          </label>
        )}
        {scopeType === 'commit' && (
          <label className="review-start-field">
            <span>Commit SHA</span>
            <input aria-label="Commit SHA" placeholder="输入 Commit SHA" value={sha} disabled={submitting} onChange={(event) => setSha(event.target.value)} />
          </label>
        )}
        <label className="review-start-field">
          <span>{scopeType === 'custom' ? '审查要求' : '补充要求（可选）'}</span>
          <textarea
            aria-label="Review 补充要求"
            placeholder={scopeType === 'custom' ? '描述需要审查的内容' : '例如：重点检查并发安全与状态同步'}
            value={instructions}
            disabled={submitting}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <div className="review-start-actions">
          <span>{valid ? '结果将回到当前会话' : '请补全当前范围的必填内容'}</span>
          <button type="button" disabled={!valid || submitting} onClick={() => void onSubmit(draft)}>
            {submitting ? '正在启动…' : '开始 Review'}
          </button>
        </div>
      </div>
    </div>
  )
}
