import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import type { TaskLifecycleSnapshot } from '@shared/taskLifecycle'
import { isArchiveCancelled } from '@shared/worktreeArchive'

export function useTaskLifecycle(session: Session, active: boolean) {
  const [snapshot, setSnapshot] = useState<TaskLifecycleSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [pending, setPending] = useState(false)
  const action = useRef<{ fingerprint: string; id: string }>()
  useEffect(() => { setSnapshot(null); setError(''); setLoadError(''); action.current = undefined }, [session.id])
  const refresh = useCallback(() => setRetry(value => value + 1), [])
  useEffect(() => {
    if (!active || session.config.assistantSnapshot || session.teamBinding) return
    let live = true
    void window.uniagent.getTaskState(session.id).then(value => { if (live) { setSnapshot(value?.record ? value : null); setLoadError('') } }, reason => { if (live) setLoadError(String(reason)) })
    return () => { live = false }
  }, [session.id, active, session.taskState?.version, session.status, retry])
  async function archive(archived = true): Promise<void> {
    if (pending) return
    setPending(true); setError('')
    try {
      if (archived) await window.uniagent.archiveSession(session.id)
      else await window.uniagent.unarchiveSession(session.id)
    } catch (reason) { if (!isArchiveCancelled(reason)) setError(String(reason)) }
    finally { setPending(false); refresh() }
  }
  async function decide(disposition: 'standby' | 'archive'): Promise<void> {
    if (!snapshot || pending) return
    const input = { expectedVersion: snapshot.record.version, inputRevision: snapshot.inputRevision, turnRevision: snapshot.turnRevision, disposition }
    const fingerprint = JSON.stringify(input)
    if (action.current?.fingerprint !== fingerprint) action.current = { fingerprint, id: crypto.randomUUID() }
    setPending(true); setError('')
    try {
      const value = await window.uniagent.decideTask(session.id, { ...input, actionId: action.current.id })
      setSnapshot(value)
      if (value.record.phase !== (disposition === 'archive' ? 'archived' : 'standby')) throw new Error('原操作已处理，任务已继续推进，请核对最新状态')
    }
    catch (reason) { if (!isArchiveCancelled(reason)) setError(String(reason)); throw reason }
    finally { setPending(false); refresh() }
  }
  return { snapshot, error: error || loadError, pending, refresh, archive, decide }
}
