import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionDeletionPreview } from '../shared/types'
import { SessionDeletionDialog, type SessionDeletionDialogState } from './components/SessionDeletionDialog'

export function sessionDeletionDetails(preview: SessionDeletionPreview) {
  const removing = preview.worktrees.filter(tree => !tree.sharedCount && !tree.removed)
  const dirty = removing.some(tree => tree.dirty)
  const label = preview.team ? '团队任务' : '任务'
  const notes: string[] = []
  if (removing.length) notes.push('源目录不受影响；Git 分支与标签保留。')
  if (!preview.worktrees.length) notes.push('工作目录中的项目文件保留。')
  for (const tree of preview.worktrees) {
    if (tree.sharedCount) notes.push(`工作树仍被其他 ${tree.sharedCount} 个任务使用，本次保留工作树及其中的文件。最后一个关联任务删除时再清理工作树。`)
    else if (tree.removed) notes.push('对应工作树已清理，本次继续删除任务记录。')
  }
  return {
    title: dirty ? `删除${label}并丢弃改动？` : `删除${label}${removing.length ? '及其工作树' : ''}？`,
    scope: `将停止${label}「${preview.title}」，${preview.team ? '删除该团队任务及其成员会话记录' : '删除任务及会话记录'}${removing.length ? '，清理工作树目录中的全部文件（含 Git 忽略文件）' : ''}。`,
    warning: dirty ? '工作树中有未提交或未跟踪文件，删除会永久丢弃这些改动。请先提交或备份需要保留的代码。' : '',
    clean: removing.length > 0 && !dirty,
    action: dirty ? '删除并丢弃改动' : removing.length ? '删除任务及工作树' : '删除任务',
    removing, notes
  }
}

const confirmations = new Map<string, Promise<string | undefined>>()

export function confirmSessionDeletion(sessionId: string): Promise<string | undefined> {
  const existing = confirmations.get(sessionId)
  if (existing) return existing
  const promise = new Promise<string | undefined>(resolve => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host), previousFocus = document.activeElement
    let closed = false, requestId = '', checking = false, off = () => {}
    const finish = (confirmationId?: string) => {
      if (closed) return
      closed = true; off()
      if (checking) void window.uniagent.cancelSessionDeletionPreview(requestId).catch(() => {})
      root.unmount(); host.remove()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
      resolve(confirmationId)
    }
    const render = (state: SessionDeletionDialogState) => root.render(createElement(SessionDeletionDialog, {
      state, onCancel: () => finish(), onRetry: () => { void check() }, onConfirm: id => finish(id)
    }))
    const check = async () => {
      if (checking || closed) return
      off(); requestId = crypto.randomUUID(); checking = true
      const current = requestId
      off = window.uniagent.onSessionDeletionChecking(value => {
        if (!closed && checking && current === requestId && value.requestId === current) render({ phase: 'checking', title: value.title })
      })
      try {
        const preview = await window.uniagent.previewSessionDeletion(sessionId, current)
        if (!closed && current === requestId) { checking = false; off(); render({ phase: 'confirm', preview, details: sessionDeletionDetails(preview) }) }
      } catch (error) {
        if (!closed && current === requestId) { checking = false; off(); render({ phase: 'error', error: error instanceof Error ? error.message : String(error) }) }
      }
    }
    void check()
  }).finally(() => { confirmations.delete(sessionId) })
  confirmations.set(sessionId, promise)
  return promise
}

let deletionSnapshot = { hiddenIds: new Set<string>(), error: '' }
const deletionListeners = new Set<() => void>(), deleting = new Set<string>()
export const getSessionDeletionSnapshot = () => deletionSnapshot
const subscribe = (listener: () => void) => { deletionListeners.add(listener); return () => { deletionListeners.delete(listener) } }
export const useSessionDeletions = () => useSyncExternalStore(subscribe, getSessionDeletionSnapshot, getSessionDeletionSnapshot)
function publish(hiddenIds: Set<string>, error = ''): void {
  deletionSnapshot = { hiddenIds, error }
  for (const listener of deletionListeners) listener()
}
export function clearSessionDeletionError(): void { publish(deletionSnapshot.hiddenIds) }

export async function deleteConfirmedSession(sessionId: string, confirmationId: string, ids = [sessionId]): Promise<void> {
  if (ids.some(id => deleting.has(id))) throw new Error('任务正在删除，请稍后再操作')
  for (const id of ids) deleting.add(id)
  publish(new Set([...deletionSnapshot.hiddenIds, ...ids]))
  try {
    await window.uniagent.deleteSession(sessionId, confirmationId)
    // Keep successful deletions hidden for this renderer's lifetime so an old
    // in-flight board or sidebar snapshot cannot briefly recreate their rows.
  } catch (error) {
    publish(new Set([...deletionSnapshot.hiddenIds].filter(id => !ids.includes(id))), error instanceof Error ? error.message : String(error))
    throw error
  } finally { for (const id of ids) deleting.delete(id) }
}

export async function deleteSessionWithConfirmation(sessionId: string, ids = [sessionId]): Promise<boolean> {
  const confirmationId = await confirmSessionDeletion(sessionId)
  if (!confirmationId) return false
  await deleteConfirmedSession(sessionId, confirmationId, ids)
  return true
}
