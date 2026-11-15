import { Worker } from 'node:worker_threads'
import type { DiagnosticEntry } from '../shared/types'
import type { RouterFeedback } from '../shared/routerReview'
import type { MonitorFeedback } from './cloudMonitorRecords'

interface Options {
  root: string; config: { url: string; publishableKey: string }; appVersion: string; distribution: 'internal' | 'public'; enabledAt: number
}
type Message = { kind: 'diagnostic' | 'performance' | 'feedback'; data: unknown; code?: string; at?: number }

/** The foreground only passes selected fields; identity, redaction and disk/network work stay in the worker. */
export class CloudMonitor {
  private worker?: Worker
  private pending = new Map<number, { message: Message; resolve: (stored: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private closed = false
  private unavailable = false
  private status: { queued?: number; dropped?: number; lastError?: string } = {}
  constructor(private options: Options) {}
  start(): void {
    if (this.closed || this.worker || !this.options.config.publishableKey) return
    try {
      const worker = new Worker(new URL('./cloudMonitorWorker.js', import.meta.url), { workerData: this.options })
      this.worker = worker; worker.unref()
      worker.on('message', message => {
        if (message.kind === 'ack') { const value = this.pending.get(message.id); if (value) { clearTimeout(value.timer); value.resolve(message.stored === true); this.pending.delete(message.id) } }
        else if (message.kind === 'status') this.status = { queued: message.queued, dropped: message.dropped, lastError: message.lastError }
        else if (message.kind === 'unavailable') this.fail()
      })
      worker.on('error', () => this.fail())
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.fail() } })
      for (const [id, value] of this.pending) worker.postMessage({ ...value.message, id })
    } catch { this.fail() }
  }
  private fail(): void {
    this.unavailable = true
    this.status = { lastError: 'monitor_unavailable' }
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.resolve(false) }
    this.pending.clear()
  }
  private enqueue(message: Message): Promise<boolean> {
    if (this.closed || this.unavailable || !this.options.config.publishableKey || this.pending.size >= 64) return Promise.resolve(false)
    const id = ++this.nextId
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false) }, 3000)
      timer.unref()
      this.pending.set(id, { message, resolve, timer })
      try { this.worker?.postMessage({ ...message, id }) } catch { clearTimeout(timer); this.pending.delete(id); resolve(false) }
    })
  }
  diagnostic(entry: DiagnosticEntry): void {
    void this.enqueue({ kind: 'diagnostic', data: { ts: entry.ts, code: entry.code, level: entry.level, agentId: entry.agentId,
      source: entry.source, message: entry.message, count: entry.count } })
  }
  performance(code: string, data: Record<string, unknown>, at: number): void { void this.enqueue({ kind: 'performance', code, data, at }) }
  feedback(row: RouterFeedback): Promise<boolean> {
    const data: MonitorFeedback = { requestId: row.requestId, attemptId: row.attemptId, revision: row.revision, savedAt: row.savedAt,
      matches: row.matches, reason: row.reason, actualAction: row.actual.decision?.action, expectedKind: row.expected?.kind }
    return this.enqueue({ kind: 'feedback', data })
  }
  snapshot() { return { ...this.status } }
  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    if (!worker) { this.fail(); return }
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { void worker.terminate().finally(resolve) }, 3000)
      worker.once('exit', () => { clearTimeout(timeout); resolve() })
      worker.postMessage({ kind: 'close' })
    })
    this.fail()
  }
}
