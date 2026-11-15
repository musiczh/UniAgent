import { isAbsolute, relative, sep } from 'node:path'
import type { Session, SessionWorktree } from '../shared/types'
import { WorktreeService } from './worktreeService'

const busy = (status: string) => ['running', 'queued', 'awaiting-approval', 'cancelling'].includes(status)
function contains(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}

export class WorktreeRuntime {
  private preparations = new Map<string, Set<Promise<void>>>()
  private suspended = new Set<string>()
  private closed = false

  constructor(private readonly options: {
    sessions: () => Session[]
    sideBusy: (id: string) => boolean
    enabled: () => boolean
    save: (session: Session, tree: SessionWorktree) => void
  }, private readonly service = new WorktreeService()) {}

  suspend(ids: string[]): () => void {
    for (const id of ids) this.suspended.add(id)
    return () => { for (const id of ids) this.suspended.delete(id) }
  }

  async settle(sessions: Session[]): Promise<void> {
    await Promise.allSettled(sessions.flatMap(session => [...(this.preparations.get(session.id) || [])]))
  }

  private canWrite(path: string, owner: Session, side = false): boolean {
    return !this.options.sessions().some(session =>
      (contains(path, session.config.workdir) || contains(session.config.worktree?.checkoutRoot || session.config.workdir, path)) &&
      ((session !== owner || side) && busy(session.status) || (session !== owner || !side) && this.options.sideBusy(session.id)))
  }

  prepare(session: Session, current: () => boolean = () => true, side = false): Promise<void> {
    const pending = this.preparations.get(session.id) || new Set<Promise<void>>()
    const operation = this.prepareSession(session, current, side).finally(() => {
      pending.delete(operation)
      if (!pending.size) this.preparations.delete(session.id)
    })
    pending.add(operation); this.preparations.set(session.id, pending)
    return operation
  }

  private async prepareSession(session: Session, current: () => boolean, side: boolean): Promise<void> {
    if (this.closed || this.suspended.has(session.id)) throw new Error('工作树同步服务已暂停')
    const tree = session.config.worktree
    if (!tree) return
    if (!current()) return
    const next = await this.service.prepare(tree, this.options.enabled(), path => current() && !this.suspended.has(session.id) && this.canWrite(path, session, side))
    if (current() && !this.suspended.has(session.id) && session.config.worktree?.id === next.id) this.options.save(session, next)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.settle(this.options.sessions())
  }
}
