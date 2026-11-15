/** Ignore transport identities when deciding whether a draft is the same intent. */
export function taskRequestFingerprint(value: unknown): string {
  const normalize = (item: unknown, parent = ''): unknown => {
    if (Array.isArray(item)) return item.map(value => normalize(value))
    if (item && typeof item === 'object') {
      const config = item as { projectId?: string; workspaceSelection?: { mode?: string } }
      // The project determines this directory; preparation can replace it on retry.
      const derivedWorkdir = config.projectId && config.workspaceSelection?.mode === 'worktree'
      return Object.fromEntries(Object.entries(item)
        .filter(([key, value]) => value !== undefined && key !== 'taskRequestId' && !(parent === 'workspaceSelection' && key === 'requestId') && key !== 'previewDataUrl' && !(derivedWorkdir && key === 'workdir'))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value, key)]))
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

/** Persist only pending intent identities; successful intents may be submitted anew. */
export async function pendingTaskRequest(storage: Pick<Storage, 'getItem' | 'setItem'>, payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskRequestFingerprint(payload)))
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  let pending: Array<{ id: string; fingerprint: string }> = []
  try {
    const value = JSON.parse(storage.getItem('uniagent.pending-task-requests') || '[]')
    if (!Array.isArray(value) || value.some(item => typeof item?.id !== 'string' || typeof item.fingerprint !== 'string')) throw new Error('invalid_pending_task_requests')
    pending = value
  } catch { throw new Error('待提交任务记录无法读取，已停止创建以避免重复任务') }
  const previous = pending.find(item => item.fingerprint === fingerprint)
  if (previous) return previous.id
  const id = crypto.randomUUID()
  // Failure is visible: without a durable client identity, do not submit a new intent.
  storage.setItem('uniagent.pending-task-requests', JSON.stringify([...pending, { id, fingerprint }]))
  return id
}

export function finishTaskRequest(storage: Pick<Storage, 'getItem' | 'setItem'>, id: string): void {
  try {
    const pending = JSON.parse(storage.getItem('uniagent.pending-task-requests') || '[]')
    if (Array.isArray(pending)) storage.setItem('uniagent.pending-task-requests', JSON.stringify(pending.filter(item => item.id !== id)))
  } catch { /* A stale entry remains safe: the host returns the original receipt. */ }
}
