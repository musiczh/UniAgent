import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveUserDataHome } from './userData.ts'
import { evaluateQueueWait, QueueWaitQualityStore } from './queueWaitQuality.ts'
import type { QueueStatus, QueueWaitEvaluation, QueueWaitPrediction } from '../shared/types.ts'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const TIME_WINDOW_MS = 2 * 60 * 60 * 1000

export interface QueueWaitObservation {
  at: number
  position: number
  waitedMs: number
}

export interface QueueWaitSample {
  id: string
  model: string
  startedAt: number
  completedAt: number
  waitedMs: number
  observations: QueueWaitObservation[]
}

export interface QueueWaitEstimateInput {
  model: string
  position: number
  at: number
}

interface ActiveQueueWait {
  phaseId: string
  model: string
  startedAt: number
  priorWaitedMs: number
  observations: QueueWaitObservation[]
  estimate?: { estimatedRemainingMs: number; estimatedAt: number }
  firstPrediction?: QueueWaitPrediction
  predictionCount: number
}

/** Estimate from actual nearby trajectory points; queue position is not treated as linear. */
export function estimateQueueWait(
  samples: QueueWaitSample[],
  input: QueueWaitEstimateInput
): number | undefined {
  if (!Number.isInteger(input.position) || input.position < 0 || !Number.isFinite(input.at)) return undefined
  const remaining = samples
    .filter((sample) =>
      isQueueWaitSample(sample) &&
      sample.model === input.model &&
      sample.completedAt >= input.at - RETENTION_MS &&
      sample.completedAt <= input.at
    )
    .map((sample) => {
      const points = sample.observations.filter((item) => timeOfDayDistance(item.at, input.at) <= TIME_WINDOW_MS)
      const index = points.findIndex((item) => item.position <= input.position)
      if (index < 0) return undefined
      const next = points[index]
      if (next.position === input.position) return sample.waitedMs - next.waitedMs
      const previous = points[index - 1]
      if (!previous) return undefined
      // Interpolate only a measured segment; never project a local speed to the queue head.
      const fraction = (previous.position - input.position) / (previous.position - next.position)
      return Math.round(sample.waitedMs - previous.waitedMs - fraction * (next.waitedMs - previous.waitedMs))
    })
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)

  if (remaining.length < 3) return undefined
  const middle = Math.floor(remaining.length / 2)
  return remaining.length % 2 ? remaining[middle] : Math.round((remaining[middle - 1] + remaining[middle]) / 2)
}

export class QueueWaitHistoryStore {
  private samples?: QueueWaitSample[]
  private readonly active = new Map<string, ActiveQueueWait>()

  readonly quality: QueueWaitQualityStore

  constructor(private readonly file = join(resolveUserDataHome(), 'queue-wait-history.json')) {
    this.quality = new QueueWaitQualityStore(join(dirname(file), 'queue-wait-evaluations.jsonl'))
  }

  estimate(input: QueueWaitEstimateInput): number | undefined {
    return estimateQueueWait(this.load(), input)
  }

  observe(
    id: string,
    model: string,
    status: QueueStatus,
    at = Date.now()
  ): { estimatedRemainingMs: number; estimatedAt: number } | undefined {
    if (!Number.isFinite(at)) return undefined
    if (status.state === 'ready') {
      if (status.acquired === true && this.active.get(id)?.model === model) this.complete(id, status.waitedMs ?? 0, at)
      else this.finish(id, status.endReason ?? 'unknown', at)
      return undefined
    }
    let current = this.active.get(id)
    if (current && (current.model !== model || (status.startedAt !== undefined && status.startedAt !== current.startedAt))) {
      this.finish(id, 'replaced', at)
      current = undefined
    }
    if (!current) {
      current = {
        phaseId: randomUUID(), model,
        startedAt: Number.isFinite(status.startedAt) ? status.startedAt! : at,
        priorWaitedMs: status.waitedMs ?? 0,
        observations: [], predictionCount: 0
      }
      this.quality.record({ event: 'started', at, id, phaseId: current.phaseId, model, startedAt: current.startedAt })
    }
    this.active.set(id, current)
    const estimate = current.estimate
    const remainingMs = estimate ? estimate.estimatedRemainingMs - Math.max(0, at - estimate.estimatedAt) : undefined
    // A missed deadline is no longer a useful prediction. Keep it as a tombstone
    // until the next phase so heartbeats cannot restart the same countdown.
    const visibleEstimate = remainingMs !== undefined && remainingMs > 0 ? estimate : undefined
    if (typeof status.position !== 'number' || !Number.isInteger(status.position) || status.position < 0) {
      return visibleEstimate
    }
    const previous = current.observations.at(-1)
    if (previous && at < previous.at) return visibleEstimate
    if (!previous || previous.position !== status.position || at - previous.at >= 30_000) {
      current.observations.push({ at, position: status.position, waitedMs: Math.max(0, at - current.startedAt) })
    }
    if (remainingMs !== undefined && remainingMs <= 0) return undefined
    if (estimate && previous?.position === status.position) return visibleEstimate
    const estimatedRemainingMs = estimateQueueWait(
      this.load().filter((sample) => sample.id !== id),
      { model, position: status.position, at }
    )
    if (estimatedRemainingMs === undefined || estimatedRemainingMs <= 0) return visibleEstimate
    // ponytail: a phase may shorten its forecast, but never extend it; if load
    // invalidates it, hide at expiry until calibrated uncertainty is available.
    if (remainingMs === undefined || estimatedRemainingMs < remainingMs) {
      current.estimate = { estimatedRemainingMs, estimatedAt: at }
      const prediction = { ...current.estimate, position: status.position }
      current.firstPrediction ??= prediction
      current.predictionCount += 1
      this.quality.record({
        event: 'prediction', at, id, phaseId: current.phaseId, model, startedAt: current.startedAt, prediction
      })
    }
    return current.estimate
  }

  private complete(id: string, waitedMs: number, completedAt: number): void {
    const active = this.active.get(id)
    if (!active) return
    this.finish(id, 'acquired', completedAt)
    const { model, startedAt, observations } = active
    this.record({ id, model, startedAt, observations, completedAt, waitedMs: waitedMs - active.priorWaitedMs }, completedAt)
  }

  /** Session teardown removes listeners before the runner can emit its final status. */
  abandonSession(sessionId: string, at = Date.now()): void {
    for (const id of this.active.keys()) {
      if (id.startsWith(sessionId + ':')) this.finish(id, 'unknown', at)
    }
  }

  private finish(id: string, outcome: QueueWaitEvaluation['outcome'], endedAt: number): void {
    const active = this.active.get(id)
    if (!active) return
    this.active.delete(id)
    const { phaseId, model, startedAt, firstPrediction, predictionCount } = active
    const evaluation = evaluateQueueWait({ id, phaseId, model, startedAt, endedAt, outcome, firstPrediction, predictionCount })
    this.quality.record({ event: 'finished', at: endedAt, id, phaseId, model, startedAt, evaluation })
  }

  record(sample: QueueWaitSample, now = Date.now()): void {
    if (!isQueueWaitSample(sample)) return
    const samples = [
      ...this.load().filter((item) => item.id !== sample.id || item.startedAt !== sample.startedAt),
      sample
    ].filter((item) => item.completedAt >= now - RETENTION_MS && item.completedAt <= now)
      .sort((a, b) => a.completedAt - b.completedAt)
    this.samples = samples
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(this.file, JSON.stringify({ version: 2, samples }), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Estimation history is best-effort and must never disturb a conversation.
    }
  }

  private load(): QueueWaitSample[] {
    if (this.samples) return this.samples
    try {
      const parsed = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []
      // Legacy samples merged phases and included cancellations; they cannot be repaired reliably.
      this.samples = parsed?.version === 2 && Array.isArray(parsed.samples) ? parsed.samples.filter(isQueueWaitSample) : []
    } catch {
      this.samples = []
    }
    return this.samples || []
  }
}

function timeOfDayDistance(a: number, b: number): number {
  const day = 24 * 60 * 60 * 1000
  const diff = Math.abs((a % day) - (b % day))
  return Math.min(diff, day - diff)
}

function isQueueWaitSample(value: unknown): value is QueueWaitSample {
  if (!value || typeof value !== 'object') return false
  const sample = value as QueueWaitSample
  return (
    typeof sample.id === 'string' &&
    typeof sample.model === 'string' &&
    Number.isFinite(sample.startedAt) &&
    Number.isFinite(sample.completedAt) &&
    sample.completedAt >= sample.startedAt &&
    Number.isFinite(sample.waitedMs) && sample.waitedMs > 0 &&
    sample.waitedMs <= sample.completedAt - sample.startedAt &&
    Array.isArray(sample.observations) &&
    sample.observations.length > 0 &&
    sample.observations.every((item, index) =>
      Number.isFinite(item?.at) && item.at >= sample.startedAt && item.at <= sample.completedAt &&
      Number.isInteger(item?.position) && item.position >= 0 &&
      Number.isFinite(item?.waitedMs) && item.waitedMs >= 0 && item.waitedMs <= sample.waitedMs &&
      (index === 0 || (item.at >= sample.observations[index - 1].at &&
        item.waitedMs >= sample.observations[index - 1].waitedMs &&
        item.position <= sample.observations[index - 1].position))
    )
  )
}
