import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Session, SessionWorktree } from '../shared/types'
import { SESSION_WORKTREE_STATUS_IPC, type SessionWorktreeStatus } from '../shared/sessionWorktreeStatus'

/** Share reads for the same checkout and cap Git inspection across visible board cards. */
export function sessionWorktreeStatusReader(deps: {
  session: (id: string) => Session | undefined
  inspect: (tree: SessionWorktree) => Promise<SessionWorktreeStatus>
}) {
  const cache = new Map<string, { at: number; loading: boolean; pending: Promise<SessionWorktreeStatus> }>()
  const running = new Set<Promise<SessionWorktreeStatus>>()
  return async (id: string, refresh = false): Promise<SessionWorktreeStatus | null> => {
    if (typeof id !== 'string' || !id || id.length > 200 || typeof refresh !== 'boolean') throw new Error('无效的任务查询')
    const session = deps.session(id)
    if (!session) throw new Error('任务已不存在')
    const tree = session.config.worktree
    if (!tree) return null
    const key = JSON.stringify(tree)
    const previous = cache.get(key)
    if (previous && (previous.loading || !refresh && Date.now() - previous.at < 5000)) return previous.pending
    const pending = (async () => {
      while (running.size >= 4) await Promise.race(running).catch(() => {})
      const request = deps.inspect(tree)
      running.add(request)
      try { return await request } finally { running.delete(request) }
    })()
    const entry = { at: Date.now(), loading: true, pending }
    cache.set(key, entry)
    try { return await pending }
    catch (error) { if (cache.get(key)?.pending === pending) cache.delete(key); throw error }
    finally { entry.loading = false }
  }
}

export function registerSessionWorktreeStatusIpc(ipc: Pick<IpcMain, 'handle'>, deps: {
  trusted: (event: IpcMainInvokeEvent) => void
  hydrate: () => Promise<unknown>
  session: (id: string) => Session | undefined
  inspect: (tree: SessionWorktree) => Promise<SessionWorktreeStatus>
}): void {
  const read = sessionWorktreeStatusReader(deps)
  ipc.handle(SESSION_WORKTREE_STATUS_IPC, async (event, id: string, refresh?: boolean) => {
    deps.trusted(event)
    await deps.hydrate()
    return read(id, refresh)
  })
}
