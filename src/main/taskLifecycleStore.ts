import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteFile, sessionStoreWriteCommitted } from './sessionStore'
import type { Session } from '../shared/types'
import { taskInputRevision, taskStateSummary, validateDelivery, type TaskLifecycleRecord } from '../shared/taskLifecycle'

/** Task business records are authoritative; Session.archived is their runtime mirror. */
export class TaskLifecycleStore {
  private records = new Map<string, TaskLifecycleRecord>()
  private errors = new Map<string, Error>()
  private tails = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string, private readonly write = atomicWriteFile) {}
  private path(id: string): string {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效 Task ID')
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }
  current(session: Session): TaskLifecycleRecord {
    const error = this.errors.get(session.id)
    if (error) throw error
    return structuredClone(this.records.get(session.id) || { formatVersion: 1, taskId: session.id, version: 0, phase: session.archived ? 'archived' : 'active',
      inputRevision: taskInputRevision(session), reports: [], history: [], operations: [] })
  }
  publish(session: Session): void {
    try {
      const record = this.current(session)
      session.taskState = taskStateSummary(record)
      if (this.records.has(session.id)) session.archived = record.phase === 'archived'
    } catch (error) { session.taskState = { phase: session.archived ? 'archived' : 'active', version: 0, updatedAt: 0, awaitingAcceptance: false, error: String(error) } }
  }
  async hydrate(sessions: Session[]): Promise<void> {
    const names = new Set(await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error }))
    for (let start = 0; start < sessions.length; start += 16) await Promise.all(sessions.slice(start, start + 16).map(async session => {
      if (names.has(basename(this.path(session.id)))) {
        try { this.records.set(session.id, this.parse(session.id, JSON.parse(await readFile(this.path(session.id), 'utf8')))) }
        catch (error) { this.errors.set(session.id, new Error('任务业务记录无法读取，请保留数据并重试', { cause: error })) }
      }
      const record = this.records.get(session.id), revision = taskInputRevision(session)
      if (record && (record.phase === 'standby' || record.delivery) && record.phase !== 'archived' && record.inputRevision !== revision) {
        try {
          await this.change(session, 'input:' + revision, JSON.stringify(['input', revision]), value => {
            value.phase = 'active'; value.delivery = undefined; value.userDecision = undefined; value.inputRevision = revision
            value.history.push({ id: 'input:' + revision, ts: Date.now(), title: '核对已接受的新输入，继续推进' })
          })
        } catch (error) { this.errors.set(session.id, new Error('任务输入状态恢复待确认', { cause: error })) }
      }
      this.publish(session)
    }))
  }
  private parse(id: string, value: TaskLifecycleRecord): TaskLifecycleRecord {
    if (!value || value.formatVersion !== 1 || value.taskId !== id || !Number.isSafeInteger(value.version) || value.version < 0 ||
      !['active','standby','archived'].includes(value.phase) || typeof value.inputRevision !== 'string' || !Array.isArray(value.reports) || !Array.isArray(value.history) || !Array.isArray(value.operations) ||
      value.previousPhase !== undefined && !['active','standby'].includes(value.previousPhase) ||
      value.decisionHint !== undefined && (!Number.isSafeInteger(value.decisionHint.count) || value.decisionHint.count < 0 || !['high','medium'].includes(value.decisionHint.priority)) ||
      value.userDecision !== undefined && (!value.userDecision || typeof value.userDecision.actionId !== 'string' || typeof value.userDecision.inputRevision !== 'string' || typeof value.userDecision.turnRevision !== 'string' || !['standby','archive'].includes(value.userDecision.disposition)) ||
      value.history.some(event => !event || typeof event.id !== 'string' || typeof event.title !== 'string' || !Number.isFinite(event.ts)) ||
      value.operations.some(op => !op || typeof op.id !== 'string' || typeof op.fingerprint !== 'string')) throw new Error('任务业务记录格式错误')
    for (const report of [...value.reports, ...(value.delivery ? [value.delivery] : [])]) {
      const { source, createdAt, ...input } = report
      if (!['agent','user'].includes(source) || !Number.isFinite(createdAt)) throw new Error('交付来源记录错误')
      validateDelivery(input)
    }
    return value
  }
  async retry(session: Session): Promise<void> {
    if (!this.errors.has(session.id)) return
    const record = this.parse(session.id, JSON.parse(await readFile(this.path(session.id), 'utf8')))
    this.records.set(session.id, record); this.errors.delete(session.id); this.publish(session)
  }
  change(session: Session, operationId: string, fingerprint: string, mutate: (record: TaskLifecycleRecord) => void | false): Promise<TaskLifecycleRecord> {
    const prior = this.tails.get(session.id) || Promise.resolve()
    const operation = prior.catch(() => {}).then(async () => {
      const record = this.current(session)
      const existing = record.operations.find(op => op.id === operationId)
      if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('操作身份冲突，请核对原提交'); return record }
      if (mutate(record) === false) return record
      record.version++
      record.operations.push({ id: operationId, fingerprint })
      const contents = JSON.stringify(record)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try { await this.write(this.path(session.id), contents) }
      catch (error) {
        if (sessionStoreWriteCommitted(error)) {
          const observed = await readFile(this.path(session.id), 'utf8').catch(() => '')
          if (observed === contents) { this.records.set(session.id, record); this.publish(session) }
          else this.errors.set(session.id, new Error('保存结果待确认，请重新启动后核对任务记录'))
        }
        throw error
      }
      this.records.set(session.id, record); this.publish(session)
      return structuredClone(record)
    })
    this.tails.set(session.id, operation)
    void operation.finally(() => { if (this.tails.get(session.id) === operation) this.tails.delete(session.id) }).catch(() => {})
    return operation
  }
  async flush(): Promise<void> { await Promise.all([...this.tails.values()]) }
  async settled(id: string): Promise<void> { await this.tails.get(id)?.catch(() => {}) }
}
