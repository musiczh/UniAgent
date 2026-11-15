import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { atomicWriteFile } from './sessionStore'
import { MONITOR_MAX_BATCH_BYTES, MONITOR_MAX_BATCH_RECORDS, MONITOR_MAX_QUEUE_BYTES, monitorBytes, validateMonitorRecord, type MonitorRecord } from '../shared/cloudMonitor'

export interface MonitorReceipt { accepted: string[]; duplicates: string[]; rejected: string[]; limited: string[]; retryAfter?: number }
export interface MonitorQueueState {
  version: 1; enabledAt: number; salt: string; session?: string; records: MonitorRecord[]; completed: string[]
  feedbackScannedAt: number; nextAttemptAt: number; failures: number; dropped: number; lastError?: string
}
export class MonitorHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number, readonly permanent = false) { super('monitor_http_' + status) }
}

export class MonitorQueue {
  private state!: MonitorQueueState
  private serial: Promise<unknown> = Promise.resolve()
  private flushing?: Promise<void>
  constructor(private root: string, private now = Date.now, private maxBytes = MONITOR_MAX_QUEUE_BYTES) {}
  async init(enabledAt = this.now()): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      if ((await stat(join(this.root, 'state.json'))).size > MONITOR_MAX_QUEUE_BYTES + 512 * 1024) throw new Error('monitor_state_too_large')
      const state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'))
      if (state.version !== 1 || !Number.isSafeInteger(state.enabledAt) || typeof state.salt !== 'string' || !/^[a-f0-9]{64}$/.test(state.salt) ||
        !Array.isArray(state.records) || !state.records.every((row: unknown) => validateMonitorRecord(row, this.now())) || !Array.isArray(state.completed) ||
        state.completed.length > 1000 || state.completed.some((value: unknown) => typeof value !== 'string') ||
        !['feedbackScannedAt', 'nextAttemptAt', 'failures', 'dropped'].every(name => Number.isSafeInteger(state[name]) && state[name] >= 0) ||
        state.session !== undefined && typeof state.session !== 'string') throw new Error('invalid_monitor_state')
      this.state = state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { version: 1, enabledAt, salt: randomBytes(32).toString('hex'), records: [], completed: [], feedbackScannedAt: enabledAt, nextAttemptAt: 0, failures: 0, dropped: 0 }
      await this.persist()
    }
  }
  snapshot(): MonitorQueueState { return structuredClone(this.state) }
  private persist(): Promise<void> { return atomicWriteFile(join(this.root, 'state.json'), JSON.stringify(this.state)) }
  private mutate<T>(run: () => T | Promise<T>): Promise<T> {
    const operation = this.serial.then(async () => {
      const previous = structuredClone(this.state)
      try { const result = await run(); await this.persist(); return result }
      catch (error) { this.state = previous; throw error }
    })
    this.serial = operation.catch(() => {})
    return operation
  }
  saveSession(session: string): Promise<void> { return this.mutate(() => { this.state.session = session }) }
  scanned(at: number): Promise<void> { return this.mutate(() => { this.state.feedbackScannedAt = Math.max(this.state.feedbackScannedAt, at) }) }
  enqueue(record: MonitorRecord): Promise<boolean> {
    return this.mutate(() => {
      if (!validateMonitorRecord(record, this.now())) throw new Error('invalid_monitor_record')
      if (this.state.completed.includes(record.eventId) || this.state.records.some(row => row.eventId === record.eventId)) return true
      while (monitorBytes(this.state.records) + monitorBytes(record) + 1 > this.maxBytes) {
        const performance = this.state.records.findIndex(row => row.category === 'performance')
        const index = performance >= 0 ? performance : this.state.records.findIndex(row => row.category !== 'router_feedback')
        if (index < 0 || record.category === 'performance' && performance < 0) { this.state.dropped++; return false }
        this.state.records.splice(index, 1); this.state.dropped++
      }
      this.state.records.push(record)
      return true
    })
  }
  flush(send: (records: MonitorRecord[]) => Promise<MonitorReceipt>): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.doFlush(send).finally(() => { this.flushing = undefined })
    return this.flushing
  }
  private async doFlush(send: (records: MonitorRecord[]) => Promise<MonitorReceipt>): Promise<void> {
    await this.serial
    if (this.state.nextAttemptAt > this.now()) return
    const batch: MonitorRecord[] = []
    for (const row of this.state.records) {
      if (batch.length === MONITOR_MAX_BATCH_RECORDS || monitorBytes([...batch, row]) > MONITOR_MAX_BATCH_BYTES) break
      batch.push(row)
    }
    if (!batch.length) return
    try {
      const receipt = await send(batch)
      const requested = new Set(batch.map(row => row.eventId)), reported = new Set<string>()
      for (const name of ['accepted', 'duplicates', 'rejected', 'limited'] as const) {
        if (!Array.isArray(receipt[name])) throw new Error('invalid_monitor_receipt')
        for (const value of receipt[name]) {
          if (!requested.has(value) || reported.has(value)) throw new Error('invalid_monitor_receipt')
          reported.add(value)
        }
      }
      if (reported.size !== batch.length || receipt.limited.length && (!Number.isFinite(receipt.retryAfter) || Number(receipt.retryAfter) < 1)) throw new Error('incomplete_monitor_receipt')
      const acknowledged = [...receipt.accepted, ...receipt.duplicates], removed = new Set([...acknowledged, ...receipt.rejected])
      await this.mutate(() => {
        this.state.records = this.state.records.filter(row => !removed.has(row.eventId))
        this.state.completed = [...new Set([...this.state.completed, ...acknowledged])].slice(-1000)
        this.state.dropped += receipt.rejected.length
        this.state.failures = 0
        this.state.lastError = receipt.rejected.length ? 'server_rejected' : receipt.limited.length ? 'rate_limited' : undefined
        this.state.nextAttemptAt = receipt.limited.length ? this.now() + Math.min(Number(receipt.retryAfter), 86400) * 1000 : 0
      })
    } catch (error) {
      await this.mutate(() => {
        if (error instanceof MonitorHttpError && error.permanent) {
          const rejected = new Set(batch.map(row => row.eventId))
          this.state.records = this.state.records.filter(row => !rejected.has(row.eventId)); this.state.dropped += batch.length
          this.state.lastError = 'server_rejected'; this.state.nextAttemptAt = this.now() + 60_000
        } else {
          this.state.failures = Math.min(this.state.failures + 1, 16)
          const seconds = error instanceof MonitorHttpError && error.retryAfter ? Math.min(Math.max(error.retryAfter, 1), 86400) : Math.min(30 * 2 ** (this.state.failures - 1), 3600)
          this.state.nextAttemptAt = this.now() + seconds * 1000
          this.state.lastError = error instanceof MonitorHttpError ? 'http_' + error.status : 'upload_unavailable'
        }
      })
    }
  }
  async drain(): Promise<void> { await this.serial }
}
