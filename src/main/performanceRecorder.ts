import { randomUUID } from 'node:crypto'
import { SessionLogStore } from './sessionLogStore'
import { PERFORMANCE_SAMPLE_MS, type ResourceSample } from './performanceResources'

const MiB = 1024 ** 2
export const PERFORMANCE_THRESHOLDS = {
  systemCpuPercent: 90, processCpuPercent: 90, treeCpuPercent: 150, cpuSamples: 3,
  processRssBytes: 1536 * MiB, treeRssBytes: 4096 * MiB, heapBytes: 1024 * MiB, memorySamples: 2,
  growthBytes: 512 * MiB, growthWindowMs: 60_000, swapOutBytesPerSecond: MiB,
  mainHeartbeatMs: 12_000
}
const stallKinds = new Set(['main_stall', 'renderer_stall', 'renderer_unresponsive', 'renderer_gone', 'frame_stalled'])

type Snapshot = ResourceSample & { mainHeartbeatAgeMs: number; main?: Record<string, unknown>;
  renderer?: { at: number; data: Record<string, unknown> }; treeRssGrowthBytes?: number; swapOutBytesPerSecond?: number }
type Incident = { id: string; startedAt: number; lastWrittenAt: number; reasons: Set<string>; healthy: number;
  peak: { systemCpuPercent: number; treeCpuPercent: number; treeRssBytes: number; processRssBytes: number; heapBytes: number } }

/** Owns bounded history and incident state; all disk work stays in the monitoring worker. */
export class PerformanceRecorder {
  private readonly logs: SessionLogStore
  private history: Snapshot[] = []
  private counts = new Map<string, number>()
  private since = new Map<string, number>()
  private activeReasons = new Set<string>()
  private incident?: Incident
  private lastSnapshotAt = 0
  private lastExternalStallAt = -Infinity
  private lastErrors = ''
  private renderer?: Snapshot['renderer']
  private readonly environment: Record<string, unknown>

  constructor(root: string, metadata: Record<string, unknown>) {
    this.environment = { ...metadata, runId: randomUUID() }
    // app + incidents, each with current file and one rotated file: at most 32 MiB.
    this.logs = new SessionLogStore(root, { maxFileBytes: 8 * MiB, maxEntryBytes: 64 * 1024 })
    this.event('monitor_started', { ...this.environment, sampleMs: PERFORMANCE_SAMPLE_MS, trendMs: 30_000,
      maxLogBytes: 32 * MiB, thresholds: PERFORMANCE_THRESHOLDS,
      processCpuUnit: '100% = one CPU core', systemCpuUnit: '100% = all CPU cores',
      memoryUnit: 'bytes; tree RSS sum includes shared pages', schemaVersion: 1 })
  }

  event(kind: string, data: Record<string, unknown>, at = Date.now()): void {
    this.logs.append('app', kind, data)
    if (kind === 'renderer_snapshot' || kind === 'renderer_stall') this.renderer = { at, data }
    if (!stallKinds.has(kind)) return
    this.lastExternalStallAt = at
    this.updateIncident([kind], at, this.history.at(-1))
    this.logs.append('incidents', 'incident_event', { ...data, id: this.incident!.id, kind, at })
  }

  sample(input: Snapshot): void {
    const sample: Snapshot = { ...input, renderer: this.renderer }
    const t = PERFORMANCE_THRESHOLDS
    const heap = this.heap(sample)
    const conditions: [string, boolean | undefined, number][] = [
      ['system_cpu_high', sample.systemCpuPercent === null ? undefined : sample.systemCpuPercent >= t.systemCpuPercent, t.cpuSamples],
      ['app_cpu_high', sample.tree?.cpuPercent == null ? undefined : sample.tree.cpuPercent >= t.treeCpuPercent || sample.tree.maxProcessCpuPercent >= t.processCpuPercent, t.cpuSamples],
      ['app_memory_high', sample.tree ? sample.tree.rssSumBytes >= t.treeRssBytes || sample.tree.maxProcessRssBytes >= t.processRssBytes : undefined, t.memorySamples],
      ['js_heap_high', heap === undefined ? undefined : heap >= t.heapBytes, t.memorySamples],
      ['system_memory_pressure', sample.memory.pressureLevel === undefined ? undefined : sample.memory.pressureLevel >= 2, t.memorySamples],
      ['main_unresponsive', sample.mainHeartbeatAgeMs >= t.mainHeartbeatMs, 1]
    ]
    const anchor = this.history.find(row => sample.at - row.at >= t.growthWindowMs && sample.at - row.at <= t.growthWindowMs + PERFORMANCE_SAMPLE_MS * 2)
    conditions.push(['app_memory_growth', sample.tree && anchor?.tree
      ? sample.tree.rssSumBytes - anchor.tree.rssSumBytes >= t.growthBytes : undefined, 1])
    if (sample.tree && anchor?.tree) sample.treeRssGrowthBytes = sample.tree.rssSumBytes - anchor.tree.rssSumBytes
    const anchorHeap = anchor ? this.heap(anchor) : undefined
    conditions.push(['js_heap_growth', anchorHeap !== undefined && heap !== undefined ? heap - anchorHeap >= t.growthBytes : undefined, 1])
    const previous = this.history.at(-1)
    const swapNow = sample.memory.swapOutBytes, swapBefore = previous?.memory.swapOutBytes
    conditions.push(['system_swap_thrashing', swapNow === undefined || swapBefore === undefined || !sample.intervalMs
      ? undefined : (swapNow - swapBefore) * 1000 / sample.intervalMs >= t.swapOutBytesPerSecond, t.memorySamples])
    if (swapNow !== undefined && swapBefore !== undefined && sample.intervalMs > 0 && swapNow >= swapBefore) {
      sample.swapOutBytesPerSecond = Math.round((swapNow - swapBefore) * 1000 / sample.intervalMs)
    }
    for (const [reason, value, required] of conditions) {
      if (value === undefined) { this.counts.delete(reason); if (!this.activeReasons.has(reason)) this.since.delete(reason); continue }
      const count = value ? (this.counts.get(reason) || 0) + 1 : 0
      this.counts.set(reason, count)
      if (!value) { this.activeReasons.delete(reason); this.since.delete(reason) }
      else if (!this.since.has(reason)) this.since.set(reason, sample.at)
      if (count >= required) this.activeReasons.add(reason)
    }
    const reasons = [...this.activeReasons]
    if (sample.at - this.lastExternalStallAt < 15_000) reasons.push('recent_stall')
    this.updateIncident(reasons, sample.at, sample)
    const errors = sample.errors.join(',')
    if (errors !== this.lastErrors) {
      this.event(errors ? 'collection_failed' : 'collection_recovered', { errors: sample.errors, at: sample.at })
      this.lastErrors = errors
    }
    if (!this.lastSnapshotAt || sample.at - this.lastSnapshotAt >= 30_000) {
      this.logs.append('app', 'snapshot', { ...sample, environment: this.environment })
      this.lastSnapshotAt = sample.at
    }
    this.history.push(sample)
    this.history = this.history.filter(row => sample.at - row.at <= 120_000).slice(-25)
  }

  reset(reason: string): void {
    if (this.incident) this.logs.append('incidents', 'incident_interrupted', { id: this.incident.id, reason,
      durationMs: Date.now() - this.incident.startedAt, peak: this.incident.peak, environment: this.environment })
    this.incident = undefined
    this.history = []
    this.renderer = undefined
    this.counts.clear()
    this.since.clear()
    this.activeReasons.clear()
    this.lastExternalStallAt = -Infinity
    this.lastSnapshotAt = 0
    this.event('monitor_reset', { reason })
  }

  async close(): Promise<void> { this.reset('shutdown'); await this.logs.close() }

  private heap(sample: Snapshot): number | undefined {
    const values = [sample.mainHeartbeatAgeMs <= 15_000 ? sample.main?.heapBytes : undefined,
      sample.renderer && sample.at - sample.renderer.at <= 45_000 ? sample.renderer.data.heapBytes : undefined]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.length ? Math.max(...values) : undefined
  }

  private updateIncident(reasons: string[], at: number, sample?: Snapshot): void {
    if (!this.incident && !reasons.length) return
    const fresh = !this.incident
    if (!this.incident) this.incident = { id: randomUUID(), startedAt: Math.min(at, ...reasons.map(reason => this.since.get(reason) ?? at)), lastWrittenAt: at, reasons: new Set(), healthy: 0,
      peak: { systemCpuPercent: 0, treeCpuPercent: 0, treeRssBytes: 0, processRssBytes: 0, heapBytes: 0 } }
    const incident = this.incident
    let added = false
    for (const reason of reasons) { if (!incident.reasons.has(reason)) added = true; incident.reasons.add(reason) }
    if (sample) {
      incident.peak.systemCpuPercent = Math.max(incident.peak.systemCpuPercent, sample.systemCpuPercent ?? 0)
      incident.peak.treeCpuPercent = Math.max(incident.peak.treeCpuPercent, sample.tree?.cpuPercent ?? 0)
      incident.peak.treeRssBytes = Math.max(incident.peak.treeRssBytes, sample.tree?.rssSumBytes ?? 0)
      incident.peak.processRssBytes = Math.max(incident.peak.processRssBytes, sample.tree?.maxProcessRssBytes ?? 0)
      incident.peak.heapBytes = Math.max(incident.peak.heapBytes, this.heap(sample) ?? 0)
    }
    incident.healthy = reasons.length ? 0 : incident.healthy + 1
    const recovered = incident.healthy >= 2
    if (fresh || added || recovered || at - incident.lastWrittenAt >= 30_000) {
      this.logs.append('incidents', fresh ? 'incident_started' : recovered ? 'incident_recovered' : 'incident_update', {
        id: incident.id, startedAt: incident.startedAt, at, durationMs: at - incident.startedAt,
        reasons: [...incident.reasons], activeReasons: reasons, peak: incident.peak, sample, environment: this.environment
      })
      incident.lastWrittenAt = at
      if (fresh) for (const context of this.history) this.logs.append('incidents', 'incident_context', { id: incident.id, sample: context })
    }
    if (recovered) this.incident = undefined
  }
}
