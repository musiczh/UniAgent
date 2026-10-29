import { Worker } from 'node:worker_threads'
import type { UAEvent } from '../shared/types.ts'
import { appendEventSnapshot } from '../shared/eventSnapshots'
import { deepseekEventWorker } from './deepseekEventWorker'

type Job = { id: number; kind: string; sessionId?: string; events?: UAEvent[]; bytes: number;
  eventSizes?: number[];
  resolve: (result?: UAEvent[]) => void; reject: (error: Error) => void }

/** Conservative retained-payload estimate; never stringify the full transcript on main. */
function eventBytes(event: UAEvent): number {
  const seen = new Set<object>()
  const size = (value: unknown): number => {
    if (typeof value === 'string') return value.length * 2 + 16
    if (!value || typeof value !== 'object') return 16
    if (seen.has(value)) return 0
    seen.add(value)
    return 64 + Object.entries(value).reduce((total, [key, item]) => total + key.length * 2 + size(item), 0)
  }
  return size(event)
}

/** ACP resume restores the provider context but does not replay the transcript. */
export class DeepSeekEventStore {
  private readonly reported = new Set<string>()
  private worker?: Worker
  private active?: Job
  private jobs: Job[] = []
  private nextId = 0
  private failure?: Error
  private closed = false
  private closing = false
  private closeFlight?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private queuedBytes = 0
  constructor(private readonly directory: string, private readonly onError?: (sessionId: string, error: unknown) => void,
    private readonly maxQueuedBytes = 8 * 1024 * 1024) {}
  private report(sessionId: string, error: unknown): void {
    if (this.reported.has(sessionId)) return
    this.reported.add(sessionId)
    try { this.onError?.(sessionId, error) } catch { /* persistence must not break live turns */ }
  }
  private validate(sessionId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('invalid_session_id')
  }
  append(sessionId: string, event: UAEvent): void {
    this.validate(sessionId)
    if (this.closing || this.closed) { this.report(sessionId, new Error('history_store_closed')); return }
    try {
      if (this.failure || this.closed) throw this.failure || new Error('history_store_closed')
      let job = this.jobs.at(-1)
      if (!job || job.kind !== 'append' || job.sessionId !== sessionId) {
        job = { id: ++this.nextId, kind: 'append', sessionId, events: [], eventSizes: [], bytes: 0, resolve() {}, reject: error => this.report(sessionId, error) }
        this.jobs.push(job)
      }
      // Pending running text is replaceable; semantic boundaries and approvals remain ordered.
      const index = appendEventSnapshot(job.events!, event, false)
      const bytes = eventBytes(job.events![index])
      const delta = bytes - (job.eventSizes![index] || 0)
      job.eventSizes![index] = bytes
      job.bytes += delta
      this.queuedBytes += delta
      if (this.queuedBytes > this.maxQueuedBytes || this.jobs.length > 4096) throw new Error('history_write_queue_full')
      if (event.state !== 'running' || job.bytes >= 256 * 1024) this.pump()
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.pump() }, 50)
    } catch (error) {
      this.report(sessionId, error)
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  replace(sessionId: string, events: UAEvent[]): Promise<void> {
    return this.request('replace', sessionId, events).then(() => {})
  }
  async load(sessionId: string): Promise<UAEvent[]> { return (await this.request('load', sessionId)) || [] }
  delete(sessionId: string): Promise<void> { return this.request('delete', sessionId).then(() => {}) }
  flush(): Promise<void> { return this.request('flush').then(() => {}) }
  stats(): { historyQueuedBytes: number; historyPendingJobs: number } {
    return { historyQueuedBytes: this.queuedBytes, historyPendingJobs: this.jobs.length + Number(!!this.active) }
  }
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight
    this.closing = true
    this.closeFlight = (async () => {
      try { await this.flush() } finally {
        this.closed = true
        if (this.timer) clearTimeout(this.timer)
        const worker = this.worker
        this.worker = undefined
        await worker?.terminate()
      }
    })()
    return this.closeFlight
  }
  private request(kind: string, sessionId?: string, events?: UAEvent[]): Promise<UAEvent[] | undefined> {
    if (sessionId !== undefined) this.validate(sessionId)
    if (this.failure || this.closed || this.closing && kind !== 'flush') return Promise.reject(this.failure || new Error('history_store_closed'))
    if (kind === 'flush' && !this.jobs.length && !this.active) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      const bytes = events?.reduce((total, item) => total + eventBytes(item), 0) || 0
      this.queuedBytes += bytes
      this.jobs.push({ id: ++this.nextId, kind, sessionId, events, bytes, resolve, reject })
      this.pump()
    })
  }
  private fail(error: Error): void {
    this.failure = error
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const pending = [...(this.active ? [this.active] : []), ...this.jobs]
    this.active = undefined; this.jobs = []; this.queuedBytes = 0
    for (const job of pending) {
      if (job.sessionId) this.report(job.sessionId, error)
      job.reject(error)
    }
    this.worker?.unref()
  }
  private pump(): void {
    if (this.active || !this.jobs.length || this.failure || this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try {
      if (!this.worker) {
        const worker = new Worker(`(${deepseekEventWorker.toString()})()`, { eval: true, workerData: { directory: this.directory } })
        this.worker = worker
        worker.on('message', (message: { id: number; result?: UAEvent[]; error?: string }) => {
          const job = this.active
          if (!job || message.id !== job.id) return
          this.active = undefined; this.queuedBytes -= job.bytes
          if (message.error) {
            const error = new Error(message.error)
            if (job.sessionId) this.report(job.sessionId, error)
            job.reject(error)
            if (job.kind === 'append') this.fail(error)
          } else job.resolve(message.result)
          this.pump()
          if (!this.active) worker.unref()
        })
        worker.on('error', error => this.fail(error))
        worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.fail(new Error('history_worker_exited')) } })
      }
      this.active = this.jobs.shift()!
      this.worker.ref()
      const { id, kind, sessionId, events } = this.active
      this.worker.postMessage({ id, kind, sessionId, events })
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
}
