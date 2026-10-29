import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QueueWaitEvaluation, QueueWaitPrediction, QueueWaitQualityQuery, QueueWaitQualityReport } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'

export const QUEUE_WAIT_ALGORITHM_VERSION = 'history-v1'
const DAY = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 90

export function parseQueueWaitQualityQuery(value: unknown): QueueWaitQualityQuery {
  if (value === undefined) return { algorithmVersion: QUEUE_WAIT_ALGORITHM_VERSION }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_queue_quality_query')
  const query = value as QueueWaitQualityQuery
  if ([query.model, query.algorithmVersion].some((v) => v !== undefined && (typeof v !== 'string' || v.length > 200))) {
    throw new Error('invalid_queue_quality_query')
  }
  return { model: query.model, algorithmVersion: query.algorithmVersion ?? QUEUE_WAIT_ALGORITHM_VERSION }
}

interface QueueWaitLogEntry {
  version: 1
  event: 'started' | 'prediction' | 'finished'
  at: number
  phaseId: string
  id: string
  model: string
  algorithmVersion: string
  startedAt: number
  prediction?: QueueWaitPrediction
  evaluation?: QueueWaitEvaluation
}

/** One local journal for the evidence behind the metric, independent of error logs. */
export class QueueWaitQualityStore {
  // ponytail: a 90-day local journal is scanned on demand; shard by date if its size becomes material.
  private entries?: QueueWaitLogEntry[]
  private lastPrunedAt = 0
  private storageError?: string

  constructor(readonly file = join(resolveUserDataHome(), 'queue-wait-evaluations.jsonl')) {}

  record(entry: Omit<QueueWaitLogEntry, 'version' | 'algorithmVersion'>): void {
    const entries = this.load(entry.at)
    const row: QueueWaitLogEntry = { ...entry, version: 1, algorithmVersion: QUEUE_WAIT_ALGORITHM_VERSION }
    entries.push(row)
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      appendFileSync(this.file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch {
      this.storageError = '核验日志写入失败；当前指标可能包含尚未持久化的数据。'
    }
  }

  report(query: QueueWaitQualityQuery = {}, now = Date.now()): QueueWaitQualityReport {
    const since = now - 30 * DAY
    const entries = this.load(now).filter((entry) => entry.at <= now)
    const matches = (entry: { model: string; algorithmVersion: string }): boolean =>
      (!query.model || entry.model === query.model) &&
      (!query.algorithmVersion || entry.algorithmVersion === query.algorithmVersion)
    const finished = new Map<string, QueueWaitEvaluation>()
    const started = new Map<string, QueueWaitLogEntry>()
    for (const entry of entries) {
      if (entry.event === 'started') started.set(entry.phaseId, entry)
      if (entry.event === 'finished' && entry.evaluation) finished.set(entry.phaseId, entry.evaluation)
    }
    const recent = [...finished.values()].filter((entry) => entry.endedAt >= since && matches(entry))
      .sort((a, b) => b.endedAt - a.endedAt)
    const successful = recent.filter((entry) => entry.outcome === 'acquired')
    const evaluated = successful.filter((entry) => entry.errorMs !== null)
    const errors = evaluated.map((entry) => entry.errorMs!)
    const absoluteErrors = errors.map(Math.abs).sort((a, b) => a - b)
    const average = (values: number[]): number | null =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
    const inWindow = entries.filter((entry) => entry.at >= since)
    return {
      generatedAt: now, since, currentAlgorithmVersion: QUEUE_WAIT_ALGORITHM_VERSION, query,
      models: [...new Set(inWindow.map((entry) => entry.model))].sort(),
      algorithmVersions: [...new Set([QUEUE_WAIT_ALGORITHM_VERSION, ...inWindow.map((entry) => entry.algorithmVersion)])].sort(),
      successfulCount: successful.length,
      evaluatedCount: evaluated.length,
      interruptedCount: recent.length - successful.length,
      invalidCount: successful.filter((entry) => entry.actualWaitMs === null || (entry.firstPrediction && entry.errorMs === null)).length,
      unfinishedCount: [...started.values()].filter((entry) => entry.at >= since && !finished.has(entry.phaseId) && matches(entry)).length,
      meanAbsoluteErrorMs: average(absoluteErrors),
      p90AbsoluteErrorMs: absoluteErrors.length ? absoluteErrors[Math.ceil(absoluteErrors.length * 0.9) - 1] : null,
      meanErrorMs: average(errors),
      coverage: successful.length ? evaluated.length / successful.length : null,
      recent: recent.slice(0, 20),
      logPath: this.file, logRetentionDays: RETENTION_DAYS, storageError: this.storageError
    }
  }

  private load(now: number): QueueWaitLogEntry[] {
    let needsRewrite = false
    if (!this.entries) {
      this.entries = []
      try {
        if (existsSync(this.file)) {
          const contents = readFileSync(this.file, 'utf8')
          // Repair an incomplete final line before appending another event.
          needsRewrite = contents.length > 0 && !contents.endsWith('\n')
          for (const line of contents.split('\n')) {
            if (!line.trim()) continue
            try {
              const entry: unknown = JSON.parse(line)
              if (isLogEntry(entry)) this.entries.push(entry)
              else needsRewrite = true
            } catch { needsRewrite = true }
          }
        }
      } catch {
        this.storageError = '核验日志读取失败；当前指标可能不完整。'
      }
    }
    if (now - this.lastPrunedAt >= DAY || needsRewrite) {
      const retained = this.entries.filter((entry) => entry.at >= now - RETENTION_DAYS * DAY)
      needsRewrite ||= retained.length !== this.entries.length
      this.entries = retained
      this.lastPrunedAt = now
      if (needsRewrite) {
        try {
          const temporary = this.file + '.tmp'
          mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
          writeFileSync(temporary, retained.map((entry) => JSON.stringify(entry) + '\n').join(''), { encoding: 'utf8', mode: 0o600 })
          renameSync(temporary, this.file)
        } catch {
          this.storageError = '核验日志整理失败；历史记录可能未完成保留期清理。'
        }
      }
    }
    return this.entries
  }
}

export function evaluateQueueWait(
  input: Omit<QueueWaitEvaluation, 'algorithmVersion' | 'actualWaitMs' | 'actualRemainingMs' | 'errorMs'>
): QueueWaitEvaluation {
  const actualWaitMs = input.endedAt >= input.startedAt ? input.endedAt - input.startedAt : null
  const { firstPrediction: prediction, ...phase } = input
  const actualRemainingMs = input.outcome === 'acquired' && actualWaitMs !== null && prediction &&
    prediction.estimatedAt >= input.startedAt && prediction.estimatedAt <= input.endedAt
    ? input.endedAt - prediction.estimatedAt : null
  return {
    ...phase, ...(prediction ? { firstPrediction: prediction } : {}),
    algorithmVersion: QUEUE_WAIT_ALGORITHM_VERSION, actualWaitMs, actualRemainingMs,
    errorMs: actualRemainingMs !== null && prediction ? prediction.estimatedRemainingMs - actualRemainingMs : null
  }
}

function isPrediction(value: unknown): value is QueueWaitPrediction {
  if (!value || typeof value !== 'object') return false
  const p = value as QueueWaitPrediction
  return Number.isFinite(p.estimatedAt) && Number.isFinite(p.estimatedRemainingMs) && p.estimatedRemainingMs > 0 &&
    Number.isInteger(p.position) && p.position >= 0
}

function isLogEntry(value: unknown): value is QueueWaitLogEntry {
  if (!value || typeof value !== 'object') return false
  const row = value as QueueWaitLogEntry
  if (row.version !== 1 || !['started', 'prediction', 'finished'].includes(row.event) ||
    !Number.isFinite(row.at) || !Number.isFinite(row.startedAt) ||
    ![row.phaseId, row.id, row.model, row.algorithmVersion].every((v) => typeof v === 'string' && v.length > 0)) return false
  if (row.event === 'prediction') return isPrediction(row.prediction)
  if (row.event !== 'finished') return true
  const e = row.evaluation
  if (!e || e.phaseId !== row.phaseId || e.id !== row.id || e.model !== row.model ||
    e.algorithmVersion !== row.algorithmVersion || e.startedAt !== row.startedAt || e.endedAt !== row.at ||
    !['acquired', 'cancelled', 'failed', 'disconnected', 'unknown', 'replaced'].includes(e.outcome) ||
    !Number.isInteger(e.predictionCount) || e.predictionCount < 0 ||
    (e.firstPrediction !== undefined && !isPrediction(e.firstPrediction))) return false
  const expected = evaluateQueueWait(e)
  return e.actualWaitMs === expected.actualWaitMs && e.actualRemainingMs === expected.actualRemainingMs && e.errorMs === expected.errorMs
}
