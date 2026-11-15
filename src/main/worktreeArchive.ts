import { randomUUID } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Session, UAEvent } from '../shared/types'
import { taskInputRevision, taskTurnRevision } from '../shared/taskLifecycle'
import { ARCHIVE_CANCELLED, WORKTREE_ARCHIVE_IPC, type WorktreeArchiveAction, type WorktreeArchiveCheck, type WorktreeArchiveReview } from '../shared/worktreeArchive'
import { WORKTREE_MERGE_GUARD, WorktreeService } from './worktreeService'

export interface ArchivePermit { inputRevision: string; turnRevision: string; assertCurrent: () => void }
export function registerWorktreeArchiveIpc(ipc: Pick<IpcMain, 'handle'>, runtime: WorktreeArchiveRuntime, deps: { trusted: (event: IpcMainInvokeEvent) => void; hydrate: () => Promise<unknown> }): void {
  ipc.handle(WORKTREE_ARCHIVE_IPC.list, async event => { deps.trusted(event); await deps.hydrate(); return runtime.list() })
  ipc.handle(WORKTREE_ARCHIVE_IPC.act, async (event, input: WorktreeArchiveAction) => { deps.trusted(event); await deps.hydrate(); return runtime.act(input) })
}
interface Request {
  view: WorktreeArchiveReview; session: Session; controller: AbortController
  resolve: (permit: ArchivePermit) => void; reject: (error: Error) => void
  inputId?: string; accepted?: boolean; completed?: boolean; pumping?: boolean
}

/** The host reads Git state; the original Agent owns every commit and merge. */
export class WorktreeArchiveRuntime {
  private requests = new Map<string, Request>()
  private closed = false
  constructor(private readonly deps: {
    session: (id: string) => Session | undefined
    related?: (session: Session) => Session[]
    busy: (id: string) => boolean
    turnRevision?: (id: string) => string
    send: (session: Session, prompt: string, inputId: string) => Promise<void>
    publish: (reviews: WorktreeArchiveReview[]) => void
  }, private readonly service = new WorktreeService()) {}

  list(): WorktreeArchiveReview[] { return [...this.requests.values()].map(request => structuredClone(request.view)) }
  private publish(): void { this.deps.publish(this.list()) }
  private related(session: Session): Session[] { return this.deps.related?.(session) || [session] }
  private turn(session: Session): string { return this.deps.turnRevision?.(session.id) || taskTurnRevision(session) }
  private stamp(session: Session): string {
    return JSON.stringify(this.related(session).map(s => [s.id, taskInputRevision(s), this.turn(s), this.deps.busy(s.id), s.config.worktree, s.archived]))
  }
  private current(request: Request): boolean { return this.requests.get(request.session.id) === request && !request.controller.signal.aborted }
  private cancel(request: Request): void {
    if (!this.current(request)) return
    this.requests.delete(request.session.id); request.controller.abort()
    request.reject(new Error(ARCHIVE_CANCELLED)); this.publish()
  }
  remove(id: string): void {
    for (const request of this.requests.values()) if (request.session.id === id || this.related(request.session).some(s => s.id === id)) this.cancel(request)
  }
  close(): void { this.closed = true; for (const request of this.requests.values()) this.cancel(request) }

  async prepare(session: Session): Promise<ArchivePermit | undefined> {
    if (this.closed) throw new Error(ARCHIVE_CANCELLED)
    const trees = this.related(session).filter(s => s.config.worktree)
    if (!trees.length) return
    if (this.requests.has(session.id)) throw new Error('该任务已有归档检查，请先处理当前提醒')
    let resolve!: Request['resolve'], reject!: Request['reject']
    const promise = new Promise<ArchivePermit>((yes, no) => { resolve = yes; reject = no })
    const request: Request = { session, resolve, reject, controller: new AbortController(),
      view: { id: randomUUID(), taskId: session.id, title: session.title, version: 0, phase: 'checking', checks: [] } }
    this.requests.set(session.id, request)
    void this.inspect(request)
    return promise
  }

  private async inspect(request: Request): Promise<void> {
    if (!this.current(request)) return
    request.view.phase = 'checking'; request.view.error = undefined; request.view.version++; this.publish()
    try {
      const stamp = this.stamp(request.session)
      if (this.related(request.session).some(s => this.deps.busy(s.id))) throw new Error('任务仍在执行，请处理完成后重新检查')
      const checks: WorktreeArchiveCheck[] = [], seen = new Set<string>()
      for (const session of this.related(request.session)) {
        const tree = session.config.worktree
        if (!tree || seen.has(tree.id)) continue
        seen.add(tree.id); checks.push(await this.service.inspectArchive(tree, request.controller.signal))
      }
      if (!this.current(request)) return
      if (this.deps.session(request.session.id) !== request.session || this.stamp(request.session) !== stamp) { this.cancel(request); return }
      request.view.checks = checks
      if (checks.some(check => check.changedFiles || check.unmergedCommits || check.gitOperation)) {
        request.view.phase = 'pending'; request.view.version++; this.publish(); return
      }
      this.requests.delete(request.session.id); this.publish()
      request.resolve({ inputRevision: taskInputRevision(request.session), turnRevision: this.turn(request.session), assertCurrent: () => {
        if (this.deps.session(request.session.id) !== request.session || this.stamp(request.session) !== stamp) throw new Error('任务状态已变化，请重新核验后归档')
      } })
    } catch (error) {
      if (!this.current(request)) return
      request.view.phase = 'failed'; request.view.error = String(error); request.view.version++; this.publish()
    }
  }

  async act(input: WorktreeArchiveAction): Promise<void> {
    const request = [...this.requests.values()].find(r => r.view.id === input?.id)
    if (!request || input.version !== request.view.version) return
    if (input.action === 'cancel') { this.cancel(request); return }
    if (input.action === 'retry' && request.view.phase === 'failed') { await this.inspect(request); return }
    if (input.action !== 'merge' || request.view.phase !== 'pending') return
    if (this.related(request.session).some(s => this.deps.busy(s.id))) throw new Error('任务仍在执行，请等待完成')
    request.view.phase = 'sending'; request.view.version++; request.inputId = randomUUID(); request.accepted = false; request.completed = false; this.publish()
    const bindings = [...new Map(this.related(request.session).filter(s => s.config.worktree).map(s => [s.config.worktree!.id, s.config.worktree!])).values()]
      .map(tree => ({ workdir: tree.checkoutRoot, branch: tree.branch, sourceDirectory: tree.repositoryRoot, sourceRef: tree.baseRef }))
    const prompt = `请处理归档前的工作树改动：先将本机源分支新提交合入当前工作树，保留其他任务改动，提交本任务应保留的改动，再合并回绑定的本机源分支。${WORKTREE_MERGE_GUARD}允许必要的源仓库 Git 操作；处理冲突，无法安全决定则说明阻塞。最后核验工作树无未提交改动、源分支包含任务提交，说明实际结果。不要 push；UniAgent 会重新核验后归档。\n工作树绑定：` + JSON.stringify(bindings)
    try {
      await this.deps.send(request.session, prompt, request.inputId)
      if (!this.current(request)) return
      if (!request.accepted) throw new Error('原任务尚未确认接受合并消息，请检查任务状态后重试')
      if (request.view.phase === 'sending') request.view.phase = 'waiting'
      request.view.version++; this.publish(); this.wake()
    } catch (error) {
      if (!this.current(request)) return
      request.view.phase = 'failed'; request.view.error = '合并消息发送失败：' + String(error); request.view.version++; this.publish()
    }
  }

  observe(event: UAEvent): void {
    for (const request of this.requests.values()) {
      if (event.sessionId !== request.session.id) continue
      if ((event.type === 'user_message' || event.type === 'goal_message') && !event.payload.automaticRecovery) {
        if (!request.inputId || event.payload.routedInputId !== request.inputId) this.cancel(request)
        else request.accepted = true
      }
      if (event.type === 'turn_completed' && request.inputId && ['sending','waiting'].includes(request.view.phase) && !event.payload.recoveryIntermediate) {
        request.completed = true
        if (event.state === 'failed' || event.state === 'cancelled') {
          request.view.phase = 'failed'; request.view.error = 'Agent 处理未完成，请查看原任务后重试检查'; request.view.version++; this.publish()
        }
      }
    }
    this.wake()
  }
  wake(): void {
    for (const request of this.requests.values()) {
      if (request.view.phase === 'waiting' && !this.deps.busy(request.session.id) && ['error', 'interrupted', 'cancelled'].includes(request.session.status)) {
        request.view.phase = 'failed'; request.view.error = 'Agent 处理未完成，请查看原任务后重试检查'; request.view.version++; this.publish()
      }
      if (request.view.phase !== 'waiting' || !request.completed || request.pumping) continue
      request.pumping = true
      setImmediate(() => {
        request.pumping = false
        if (this.current(request) && request.view.phase === 'waiting' && !this.related(request.session).some(s => this.deps.busy(s.id))) void this.inspect(request)
      })
    }
  }
}
