import type { Session } from '../shared/types'
import { randomUUID } from 'node:crypto'
import { taskHasEndedRound, taskInputRevision, taskTurnRevision, type TaskDecisionInput, type TaskLifecycleRecord, type TaskLifecycleSnapshot } from '../shared/taskLifecycle'
import { TaskLifecycleStore } from './taskLifecycleStore'
import { isNativeTaskDecision, type TaskDecision } from '../shared/taskDecisions'
import type { ArchivePermit } from './worktreeArchive'

export interface TaskLifecycleDependencies {
  session: (id: string) => Session | undefined
  busy: (id: string) => boolean
  pending: (id: string) => number
  reserve: (id: string) => () => void
  mirrorArchive: (id: string, archived: boolean) => Session | undefined
  publish: (session: Session) => void
  turnRevision?: (id: string) => string
  beforeArchive?: (session: Session) => Promise<ArchivePermit | undefined>
}

export class TaskLifecycleService {
  constructor(readonly store: TaskLifecycleStore, private readonly deps: TaskLifecycleDependencies) {}
  private session(id: string): Session {
    const session = this.deps.session(id)
    if (!session) throw new Error('任务不存在')
    return session
  }
  private writable(session: Session): void {
    if (session.readOnly || session.config.assistantSnapshot || session.teamBinding) throw new Error('该会话请使用原有只读、个人助手或专家团管理入口')
  }
  snapshot(id: string): TaskLifecycleSnapshot {
    const session = this.session(id)
    return { record: this.store.current(session), inputRevision: taskInputRevision(session), turnRevision: this.deps.turnRevision?.(id) || taskTurnRevision(session), busy: this.deps.busy(id), pendingDecisions: this.deps.pending(id) }
  }
  private publish(session: Session): void { if (this.deps.session(session.id) === session) { this.store.publish(session); this.deps.publish(session) } }
  private event(record: TaskLifecycleRecord, id: string, title: string): void {
    record.history.push({ id, ts: Date.now(), title })
  }
  private assertDecision(session: Session, input: TaskDecisionInput, value: TaskLifecycleRecord): void {
    const current = this.snapshot(session.id)
    if (session.archived || value.phase === 'archived' || value.version !== input.expectedVersion || current.inputRevision !== input.inputRevision || current.turnRevision !== input.turnRevision) throw new Error('任务输入或本轮状态已变化，请刷新后决定')
    if (current.busy || current.pendingDecisions || value.decisionHint?.count || session.recovery && session.recovery.phase !== 'stopped') throw new Error('任务仍在执行、排队或等待回答/授权，请先处理')
    if (session.taskRegistration?.delivery === 'unknown') throw new Error('首条输入结果待确认，请先核对对话')
    if (!taskHasEndedRound(session) && value.phase !== 'standby') throw new Error('本轮尚未形成可处理的结果')
  }
  async archive(id: string, archived: boolean): Promise<Session | undefined> {
    const session = this.session(id); this.writable(session)
    if (archived && (this.deps.busy(id) || this.deps.pending(id) || this.store.current(session).decisionHint?.count)) throw new Error('任务仍在执行、排队或有待决策事项，请先处理后归档')
    const permit = archived && !session.archived ? await this.deps.beforeArchive?.(session) : undefined
    const release = this.deps.reserve(id)
    try {
      const operationId = randomUUID()
      await this.store.change(session, operationId, JSON.stringify(['archive', archived]), record => {
        permit?.assertCurrent()
        if (archived && (this.deps.busy(id) || this.deps.pending(id) || record.decisionHint?.count)) throw new Error('任务仍在执行、排队或有待决策事项，请先处理后归档')
        if (archived) { if (record.phase !== 'archived') record.previousPhase = record.phase; record.phase = 'archived' }
        else record.phase = record.previousPhase || 'active'
        this.event(record, operationId, archived ? '任务已归档' : '任务已恢复可见')
      })
      return this.deps.mirrorArchive(id, archived)
    } finally { this.publish(session); release() }
  }
  async decide(id: string, input: TaskDecisionInput): Promise<TaskLifecycleSnapshot> {
    if (!input || typeof input.actionId !== 'string' || !input.actionId || input.actionId.length > 128 || !Number.isSafeInteger(input.expectedVersion) ||
      typeof input.inputRevision !== 'string' || typeof input.turnRevision !== 'string' || !['standby','archive'].includes(input.disposition)) throw new Error('无效任务决定')
    const session = this.session(id); this.writable(session)
    const fingerprint = JSON.stringify(['decide', input])
    const record = this.store.current(session)
    const previous = record.operations.find(operation => operation.id === input.actionId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('操作身份冲突，请核对原提交')
      if (record.phase === 'archived' && record.userDecision?.actionId === input.actionId) this.deps.mirrorArchive(id, true)
      return this.snapshot(id)
    }
    this.assertDecision(session, input, record)
    const permit = input.disposition === 'archive' ? await this.deps.beforeArchive?.(session) : undefined
    const decision = permit ? { ...input, expectedVersion: this.store.current(session).version, inputRevision: permit.inputRevision, turnRevision: permit.turnRevision } : input
    const release = this.deps.reserve(id)
    try {
      const record = await this.store.change(session, input.actionId, fingerprint, value => {
        permit?.assertCurrent()
        this.assertDecision(session, decision, value)
        if (value.phase !== 'archived') value.previousPhase = value.phase
        value.phase = input.disposition === 'archive' ? 'archived' : 'standby'
        value.userDecision = { actionId: input.actionId, inputRevision: decision.inputRevision, turnRevision: decision.turnRevision, disposition: input.disposition }
        value.inputRevision = decision.inputRevision; value.delivery = undefined
        this.event(value, input.actionId, input.disposition === 'archive' ? '用户结束任务，已归档' : '用户暂定，进入待推进')
      })
      if (record.phase === 'archived' && record.userDecision?.actionId === input.actionId) this.deps.mirrorArchive(id, true)
    } finally { this.publish(session); release() }
    return this.snapshot(id)
  }
  async inputAccepted(id: string): Promise<void> {
    const session = this.session(id)
    if (session.teamBinding || session.config.assistantSnapshot) return
    await this.store.settled(id)
    const revision = taskInputRevision(session)
    const current = this.store.current(session)
    if (current.inputRevision === revision) return
    if (current.phase !== 'standby' && !current.delivery) return
    try {
      await this.store.change(session, 'input:' + revision, JSON.stringify(['input', revision]), record => {
        if (record.phase === 'archived') throw new Error('归档任务不能接受输入')
        record.phase = 'active'; record.delivery = undefined; record.userDecision = undefined; record.inputRevision = revision
        this.event(record, 'input:' + revision, '新输入已接受，继续推进')
      })
    } finally { this.publish(session) }
  }
  async noteDecisions(id: string, decisions: TaskDecision[]): Promise<void> {
    const session = this.session(id)
    if (session.teamBinding || session.config.assistantSnapshot || session.archived) return
    const native = decisions.filter(isNativeTaskDecision)
    const hint = native.length ? { count: native.length, priority: native.some(d => d.priority === 'high') ? 'high' as const : 'medium' as const } : undefined
    const same = (record: TaskLifecycleRecord) => JSON.stringify(record.decisionHint) === JSON.stringify(hint)
    await this.store.settled(id)
    if (same(this.store.current(session))) return
    const previous = session.taskState?.version
    await this.store.change(session, randomUUID(), JSON.stringify(['decisions', hint]), record => {
      if (same(record)) return false
      record.decisionHint = hint
    })
    if (session.taskState?.version !== previous) this.publish(session)
  }
}
