import { useEffect, useId, useRef } from 'react'
import type { SessionDeletionPreview } from '@shared/types'
import type { sessionDeletionDetails } from '../sessionDeletion'

export type SessionDeletionDialogState =
  | { phase: 'checking'; title: string }
  | { phase: 'error'; error: string }
  | { phase: 'confirm'; preview: SessionDeletionPreview; details: ReturnType<typeof sessionDeletionDetails> }

export function SessionDeletionDialog({ state, onCancel, onRetry, onConfirm }: {
  state: SessionDeletionDialogState; onCancel: () => void; onRetry: () => void; onConfirm: (id: string) => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  useEffect(() => {
    dialog.current?.showModal()
    return () => { dialog.current?.close() }
  }, [])
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('[data-cancel-delete]')?.focus() }, [state.phase])
  const details = state.phase === 'confirm' ? state.details : undefined
  return <dialog ref={dialog} className="modal-overlay history-confirm-overlay session-delete-overlay" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onCancel() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }}
    onClick={event => { if (event.target === event.currentTarget) onCancel() }}>
    <div className="loading-modal history-confirm-modal session-delete-dialog">
      <div className="loading-modal-title session-delete-heading" id={titleId}>{state.phase === 'checking' ? <><span className="loading-spinner" aria-hidden/>正在检查工作树</> : state.phase === 'error' ? '工作树检查失败' : details!.title}</div>
      {state.phase === 'checking' ? <>
        <div className="loading-modal-note" role="status">正在检查「{state.title}」关联的工作树及未提交改动。<br/>检查完成后，再确认是否删除。</div>
        <div className="loading-modal-note">中断本次检查将取消删除，保留任务和文件。</div>
      </> : state.phase === 'error' ? <div className="loading-modal-note" role="alert">{state.error}</div> : <>
        <div className="loading-modal-note">{details!.scope}</div>
        {details!.warning && <div className="session-delete-warning">{details!.warning}</div>}
        {details!.clean && <div className="loading-modal-note">检查完成，工作树没有未提交改动。</div>}
        {details!.removing.map(tree => <div className="history-confirm-summary" key={tree.path}>
          <div><span>工作树</span><strong>{tree.path}</strong></div>
          {tree.branch && <div><span>保留分支</span><strong>{tree.branch}</strong></div>}
        </div>)}
        {details!.notes.map(note => <div className="loading-modal-note" key={note}>{note}</div>)}
        <div className="loading-modal-note">此操作不可撤销。</div>
      </>}
      <div className="session-delete-actions">
        <button type="button" className="loading-modal-cancel" data-cancel-delete onClick={onCancel}>{state.phase === 'checking' ? '中断检查' : '取消'}</button>
        {state.phase === 'error' && <button type="button" className="loading-modal-cancel" onClick={onRetry}>重试检查</button>}
        {state.phase === 'confirm' && <button type="button" className="loading-modal-cancel session-delete-confirm" data-confirm-delete onClick={() => onConfirm(state.preview.confirmationId)}>{details!.action}</button>}
      </div>
    </div>
  </dialog>
}
