import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseRecoveryDecision, recoveryCandidate, recoveryDelayMs,
  type RecoveryErrorType, type RecoveryProgress, type RecoverySettings } from '../shared/sessionRecovery'
import { recoveryBlocked, recoveryError, recoveryPrompt, recoveryText, type RecoveryFailure } from './recoveryContext'

export interface RecoveryRecord extends RecoveryProgress {
  sessionId: string
  updatedAt: number
  failureIds: string[]
  history: Array<{ message: string; reason: string }>
}

export interface RecoverySnapshot {
  version: 1
  errors: RecoveryErrorType[]
  records: RecoveryRecord[]
}

export type RecoveryOutcome =
  | { state: 'retry-started' | 'cancelled' | 'ignored' }
  | { state: 'stopped'; reason: string }

export interface RecoveryDependencies {
  settings: () => RecoverySettings
  judge: (settings: RecoverySettings, prompt: string, signal: AbortSignal) => Promise<string>
  /** Recheck ownership, configuration, native activity and user intent. */
  current: (failure: RecoveryFailure) => boolean
  retry: (failure: RecoveryFailure, attemptId: string, signal: AbortSignal) => Promise<void>
  save: (snapshot: RecoverySnapshot) => Promise<void>
  progress: (sessionId: string, progress: RecoveryProgress | undefined) => void
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  random?: () => number
}

/** Each failure is judged once; only the host can dispatch another native turn. */
export class SessionRecovery {
  private records = new Map<string, RecoveryRecord>()
  private errors = new Map<string, RecoveryErrorType>()
  private jobs = new Map<string, AbortController>()
  private activeJudges = 0
  private judgeWaiters = new Set<() => void>()
  private closed = false
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly deps: RecoveryDependencies, snapshot?: RecoverySnapshot) {
    for (const error of snapshot?.errors || []) this.errors.set(error.key, structuredClone(error))
    for (const record of snapshot?.records || []) {
      this.records.set(record.sessionId, { ...structuredClone(record), phase: 'stopped', nextRetryAt: undefined,
        reason: record.phase === 'stopped' ? record.reason : '自动恢复已因应用重启中断，请手动继续。' })
    }
  }

  snapshot(): RecoverySnapshot {
    return structuredClone({ version: 1, errors: [...this.errors.values()], records: [...this.records.values()] })
  }

  getProgress(sessionId: string): RecoveryProgress | undefined {
    const record = this.records.get(sessionId)
    if (!record) return undefined
    const { chainId, phase, attempts, maxRetries, reason, nextRetryAt, matchedRuleIds } = record
    return { chainId, phase, attempts, maxRetries, reason, nextRetryAt, matchedRuleIds: [...matchedRuleIds] }
  }

  isPending(sessionId: string, failureId: string): boolean {
    return this.jobs.has(sessionId) && this.records.get(sessionId)?.failureIds.at(-1) === failureId
  }

  cancel(sessionId: string, reason = '自动恢复已取消'): void {
    const job = this.jobs.get(sessionId)
    this.jobs.delete(sessionId)
    job?.abort()
    const record = this.records.get(sessionId)
    if (record && record.phase !== 'stopped') {
      this.update(record, { phase: 'stopped', nextRetryAt: undefined, reason })
    }
  }

  /** Called on a real new user request or successful logical completion. */
  reset(sessionId: string): void {
    this.cancel(sessionId)
    this.records.delete(sessionId)
    this.deps.progress(sessionId, undefined)
  }

  settingsChanged(): void {
    for (const id of this.jobs.keys()) this.cancel(id, '恢复设置已变更，已取消待执行的自动恢复')
  }

  async close(): Promise<void> {
    this.closed = true
    for (const id of this.jobs.keys()) this.cancel(id, '应用退出，自动恢复已中断')
    await this.persist()
  }

  /** Serial snapshots prevent concurrent failures from overwriting one another. */
  persist(): Promise<void> {
    const snapshot = this.snapshot()
    const operation = this.writes.catch(() => {}).then(() => this.deps.save(snapshot))
    this.writes = operation
    return operation
  }

  observeError(failure: Pick<RecoveryFailure, 'agentId' | 'message'>): void {
    const error = recoveryError(failure)
    const previous = this.errors.get(error.key), now = this.now()
    this.errors.set(error.key, { ...error, count: (previous?.count || 0) + 1, firstSeenAt: previous?.firstSeenAt ?? now, lastSeenAt: now })
    const selected = this.deps.settings().selectedErrors
    for (const row of [...this.errors.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)) {
      if (this.errors.size <= 100) break
      if (!selected.includes(row.key)) this.errors.delete(row.key)
    }
  }

  async recover(failure: RecoveryFailure): Promise<RecoveryOutcome> {
    if (this.closed) return { state: 'ignored' }
    const prior = this.records.get(failure.sessionId)
    if (prior?.failureIds.includes(failure.failureId)) return { state: 'ignored' }
    if (this.jobs.has(failure.sessionId)) {
      if (prior?.phase !== 'retrying') return { state: 'ignored' }
      // A newly dispatched turn can fail synchronously before retry() resolves.
      this.jobs.delete(failure.sessionId)
    }
    const settings = structuredClone(this.deps.settings())
    const error = recoveryError(failure)
    const now = this.now()
    if (failure.terminal && !failure.interrupted && !failure.nativeRetrying) {
      this.observeError(failure)
    }
    if (!settings.enabled) {
      if (prior) this.update(prior, { phase: 'stopped', reason: '自动恢复已关闭', nextRetryAt: undefined })
      try { await this.persist() } catch { /* Catalog collection cannot authorize a retry. */ }
      return { state: 'stopped', reason: '自动恢复已关闭' }
    }
    const record: RecoveryRecord = prior || { sessionId: failure.sessionId, chainId: randomUUID(), phase: 'stopped', attempts: 0,
      maxRetries: settings.maxRetries, reason: '', matchedRuleIds: [], failureIds: [], history: [], updatedAt: now }
    record.failureIds = [...record.failureIds, failure.failureId].slice(-12)
    this.records.set(failure.sessionId, record)
    const blocked = recoveryBlocked(failure)
    const reason = record.attempts >= settings.maxRetries ? `已达到 ${settings.maxRetries} 次自动重试上限`
      : blocked || (!recoveryCandidate(settings, error.key, record.attempts) ? '当前错误未进入自动恢复判断' : undefined)
    if (reason || !this.deps.current(failure)) {
      this.update(record, { phase: 'stopped', reason: reason || '会话已变化，自动恢复已取消', nextRetryAt: undefined })
      try { await this.persist() } catch { /* No dispatch is possible on this path. */ }
      return { state: 'stopped', reason: record.reason }
    }

    const controller = new AbortController()
    const signal = controller.signal
    this.jobs.set(failure.sessionId, controller)
    const current = () => !signal.aborted && this.jobs.get(failure.sessionId) === controller && this.deps.current(failure)
    this.update(record, { phase: 'judging', maxRetries: settings.maxRetries, reason: '正在判断是否值得重试', nextRetryAt: undefined })
    try {
      await this.persist()
      if (!current()) throw new Error('会话已变化，自动恢复已取消')
      const release = await this.acquireJudge(signal)
      let output: string
      try {
        const judgeController = new AbortController()
        const abortJudge = () => judgeController.abort()
        signal.addEventListener('abort', abortJudge, { once: true })
        let rejectAborted!: (error: Error) => void
        const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
        const onAbort = () => rejectAborted(new Error('恢复判断已取消或超时'))
        judgeController.signal.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => judgeController.abort(), 30000)
        try {
          if (signal.aborted) judgeController.abort()
          output = await Promise.race([aborted, this.deps.judge(settings, recoveryPrompt(failure, settings, record.attempts, record.history), judgeController.signal)])
        } finally { clearTimeout(timer); signal.removeEventListener('abort', abortJudge); judgeController.signal.removeEventListener('abort', onAbort) }
      } finally { release() }
      if (!current()) throw new Error('会话已变化，自动恢复已取消')
      const decision = parseRecoveryDecision(output, settings, error.key)
      record.history = [...record.history, { message: error.message, reason: recoveryText(decision.reason, 500) }].slice(-10)
      record.matchedRuleIds = decision.matchedRuleIds
      if (!decision.retry) {
        this.update(record, { phase: 'stopped', reason: recoveryText(decision.reason, 500) })
        await this.persist()
        return { state: 'stopped', reason: record.reason }
      }
      const wait = recoveryDelayMs(settings, record.attempts + 1, this.deps.random?.())
      this.update(record, { phase: 'waiting', reason: recoveryText(decision.reason, 500), nextRetryAt: this.now() + wait })
      await this.persist()
      await (this.deps.wait || ((ms, s) => delay(ms, undefined, { signal: s })))(wait, signal)
      if (!current()) throw new Error('会话已变化，自动恢复已取消')
      // Reserve durably before dispatch. An uncertain save never authorizes a send.
      this.update(record, { phase: 'retrying', attempts: record.attempts + 1, nextRetryAt: undefined })
      await this.persist()
      if (!current()) throw new Error('会话已变化，自动恢复已取消')
      await this.deps.retry(failure, `${record.chainId}:${record.attempts}`, signal)
      return { state: 'retry-started' }
    } catch (error) {
      if (signal.aborted || this.jobs.get(failure.sessionId) !== controller) return { state: 'cancelled' }
      this.update(record, { phase: 'stopped', reason: '自动恢复未完成：' + recoveryText(String(error), 300), nextRetryAt: undefined })
      try { await this.persist() } catch { /* Preserve the conservative in-memory attempt reservation. */ }
      return { state: 'stopped', reason: record.reason }
    } finally {
      if (this.jobs.get(failure.sessionId) === controller) this.jobs.delete(failure.sessionId)
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private update(record: RecoveryRecord, patch: Partial<RecoveryProgress>): void {
    Object.assign(record, patch, { updatedAt: this.now() })
    this.deps.progress(record.sessionId, this.getProgress(record.sessionId))
  }

  private async acquireJudge(signal: AbortSignal): Promise<() => void> {
    while (this.activeJudges >= 2) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(new Error('恢复判断已取消')) }
        const cleanup = () => { this.judgeWaiters.delete(wake); signal.removeEventListener('abort', abort) }
        this.judgeWaiters.add(wake)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    if (signal.aborted) throw new Error('恢复判断已取消')
    this.activeJudges++
    return () => { this.activeJudges--; this.judgeWaiters.values().next().value?.() }
  }
}
