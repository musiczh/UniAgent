import { randomUUID } from 'node:crypto'
import type { Session, SessionDeletionPreview, SessionWorktree } from '../shared/types'
import { sessionUsesWorktree, WorktreeService } from './worktreeService'

type Plan = { preview: SessionDeletionPreview; signature: string; trees: SessionWorktree[] }

/** Confirmation belongs to a checked task group, never to a renderer-supplied path. */
export class TaskWorktreeDeletion {
  private confirmations = new Map<string, { id: string; signature: string; expiresAt: number }>()

  constructor(private readonly options: {
    sessions: () => Session[]
    protectedDirectories: () => string[]
    save: (tree: SessionWorktree) => void
  }, private readonly service = new WorktreeService()) {}

  private key(sessions: Session[]): string { return sessions.map(session => session.id).sort().join('\0') }

  private owners(path: string, targets: Session[]): string[] {
    const ids = new Set(targets.map(session => session.id))
    return this.options.sessions().filter(session => !ids.has(session.id) &&
      (sessionUsesWorktree(path, session.config) || [...(session.config.additionalDirectories || []), ...(session.config.worktree ? [session.config.worktree.repositoryRoot, session.config.worktree.sourcePrimaryDirectory] : [])].some(workdir => sessionUsesWorktree(path, { workdir })))).map(session => session.id).sort()
  }

  private async plan(sessions: Session[], title: string, team: boolean, signal?: AbortSignal): Promise<Plan> {
    signal?.throwIfAborted()
    if (sessions.some(session => !this.options.sessions().includes(session))) throw new Error('任务记录已变化，请重新确认删除')
    const trees = [...new Map(sessions.filter(session => session.config.worktree).map(session => [session.config.worktree!.checkoutRoot, session.config.worktree!])).values()]
    const worktrees: SessionDeletionPreview['worktrees'] = [], references: string[][] = []
    for (const tree of trees) {
      const owners = this.owners(tree.checkoutRoot, sessions)
      references.push(owners)
      if (owners.length) {
        const sharedCount = new Set(this.options.sessions().filter(session => owners.includes(session.id)).map(session => session.teamBinding ? 'team:' + session.teamBinding.teamProjectId : session.id)).size
        worktrees.push({ path: tree.checkoutRoot, branch: tree.branch, dirty: false, sharedCount, removed: false }); continue
      }
      if (this.options.protectedDirectories().some(workdir => sessionUsesWorktree(tree.checkoutRoot, { workdir }))) throw new Error('工作树仍被空间目录使用，不能随任务删除')
      const state = await this.service.inspectTaskRemoval(tree, signal)
      worktrees.push({ path: tree.checkoutRoot, ...state, sharedCount: 0 })
    }
    const preview = { confirmationId: '', title, team, worktrees }
    const signature = JSON.stringify({ targets: sessions.map(session => [session.id, session.config.workdir, session.config.worktree?.id, session.config.worktree?.checkoutRoot, session.config.worktree?.repositoryRoot, session.config.worktree?.gitCommonDirectory]).sort(), worktrees, references })
    return { preview, signature, trees }
  }

  async preview(sessions: Session[], title: string, team = false, signal?: AbortSignal): Promise<SessionDeletionPreview> {
    const plan = await this.plan(sessions, title, team, signal)
    signal?.throwIfAborted()
    for (const [key, ticket] of this.confirmations) if (ticket.expiresAt < Date.now()) this.confirmations.delete(key)
    const confirmationId = randomUUID()
    this.confirmations.set(this.key(sessions), { id: confirmationId, signature: plan.signature, expiresAt: Date.now() + 5 * 60_000 })
    return { ...plan.preview, confirmationId }
  }

  async execute(sessions: Session[], confirmationId: string | undefined, stop: () => Promise<void>, removeRecords: () => Promise<void>): Promise<void> {
    const releases: Array<() => void> = []
    const key = this.key(sessions)
    try {
      for (const path of [...new Set(sessions.flatMap(session => session.config.worktree ? [session.config.worktree.checkoutRoot] : []))].sort()) releases.push(this.service.lockRemoval(path))
      const plan = await this.plan(sessions, '', false)
      const ticket = this.confirmations.get(key)
      if (confirmationId && (!ticket || ticket.id !== confirmationId || ticket.expiresAt < Date.now() || ticket.signature !== plan.signature)) throw new Error('任务或工作树状态已变化，请重新确认删除')
      if (!confirmationId && plan.preview.worktrees.some(tree => tree.dirty)) throw new Error('工作树有未提交或未跟踪文件，请先确认删除')
      this.confirmations.delete(key)
      await stop()
      const latest = await this.plan(sessions, '', false)
      if (latest.signature !== plan.signature) throw new Error('任务或工作树状态已变化，请重新确认删除')
      for (let index = 0; index < latest.trees.length; index++) {
        if (latest.preview.worktrees[index].sharedCount) continue
        const tree = latest.trees[index]
        const removed = await this.service.removeTaskWorktree(tree, !!confirmationId && latest.preview.worktrees[index].dirty,
          () => !this.owners(tree.checkoutRoot, sessions).length && !this.options.protectedDirectories().some(workdir => sessionUsesWorktree(tree.checkoutRoot, { workdir })))
        this.options.save(removed)
        await this.service.removeTaskMetadata(removed)
      }
      await removeRecords()
    } finally { for (const release of releases.reverse()) release() }
  }
}
