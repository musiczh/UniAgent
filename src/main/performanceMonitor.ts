import { app, powerMonitor } from 'electron'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PERFORMANCE_SAMPLE_MS } from './performanceResources'

/** Local, bounded performance records. No prompts, paths, answers or credentials. */
export class PerformanceMonitor {
  private readonly worker?: Worker
  private readonly delay = monitorEventLoopDelay({ resolution: 50 })
  private previous = performance.eventLoopUtilization()
  private timer: ReturnType<typeof setInterval>
  private events = 0
  private startedAt = performance.now()
  private stopped = false
  private exited = false
  private skipDelay = false
  private readonly suspend = (): void => { this.delay.reset(); this.record('suspend', {}) }
  private readonly resume = (): void => {
    this.skipDelay = true
    this.delay.reset()
    this.previous = performance.eventLoopUtilization()
    this.startedAt = performance.now()
    this.events = 0
    this.record('resume', {})
  }

  constructor(root: string, private readonly runtime: () => Record<string, number>) {
    try {
      this.worker = new Worker(new URL('./performanceWorker.js', import.meta.url), {
        workerData: { root: join(root, 'performance-logs'), pid: process.pid, appVersion: app.getVersion() }
      })
      this.worker.unref()
      this.worker.on('error', () => { console.warn('[performance-monitor] 后台监测不可用') })
      this.worker.on('exit', code => {
        this.exited = true
        if (!this.stopped) console.warn('[performance-monitor] 后台监测已退出', code)
      })
    } catch { console.warn('[performance-monitor] 无法启动后台监测') }
    this.delay.enable()
    this.timer = setInterval(() => this.sample(), PERFORMANCE_SAMPLE_MS)
    this.timer.unref()
    powerMonitor.on('suspend', this.suspend)
    powerMonitor.on('resume', this.resume)
  }

  event(): void { this.events++ }
  record(kind: string, data: Record<string, unknown>): void {
    if (!this.stopped && !this.exited) { try { this.worker?.postMessage({ kind, data }) } catch { /* Best-effort diagnostics. */ } }
  }

  rendererSample(input: unknown, stalled: boolean): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return
    const sample = input as Record<string, unknown>
    const metrics = Object.fromEntries(['count', 'totalMs', 'longestMs', 'domNodes', 'frames', 'heapBytes'].flatMap(key => {
      const limit = key === 'heapBytes' ? 64 * 1024 ** 3 : key === 'domNodes' || key === 'frames' ? 10_000_000 : 600_000
      return typeof sample[key] === 'number' && Number.isFinite(sample[key])
        ? [[key, Math.max(0, Math.min(limit, sample[key]))]] : []
    }))
    this.record(stalled ? 'renderer_stall' : 'renderer_snapshot', { ...metrics, visible: sample.visible === true })
  }

  private sample(): void {
    const now = performance.now()
    const current = performance.eventLoopUtilization()
    const utilization = performance.eventLoopUtilization(current, this.previous).utilization
    this.previous = current
    const ignoreDelay = this.skipDelay || now - this.startedAt > PERFORMANCE_SAMPLE_MS * 4
    const maxDelayMs = !ignoreDelay && Number.isFinite(this.delay.max) ? Math.round(this.delay.max / 1e6) : 0
    this.skipDelay = false
    const processes = app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type,
      memoryKiB: metric.memory.workingSetSize }))
    const memory = process.memoryUsage()
    const data = {
      uptimeSec: Math.round(process.uptime()), maxDelayMs,
      p99DelayMs: ignoreDelay ? 0 : Math.round(this.delay.percentile(99) / 1e6), utilization,
      eventsPerSecond: Math.round(this.events * 1000 / (now - this.startedAt)),
      rssBytes: memory.rss, heapBytes: memory.heapUsed, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers,
      ...this.runtime(), processes
    }
    this.record('main_sample', data)
    if (maxDelayMs >= 200) this.record('main_stall', data)
    this.events = 0
    this.startedAt = now
    this.delay.reset()
  }

  async close(): Promise<void> {
    if (this.stopped) return
    clearInterval(this.timer)
    this.delay.disable()
    powerMonitor.removeListener('suspend', this.suspend)
    powerMonitor.removeListener('resume', this.resume)
    this.record('close', {})
    this.stopped = true
    if (!this.worker || this.exited) return
    const worker = this.worker
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { void worker.terminate().finally(resolve) }, 3_000)
      worker.once('exit', () => { clearTimeout(timeout); resolve() })
    })
  }
}
