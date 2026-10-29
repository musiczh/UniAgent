import type { HistoryLoadProgress } from '../shared/types'

type Phase = HistoryLoadProgress['phase']
const measuredPhases = ['locating', 'reading', 'rollbacks', 'scanning', 'parsing', 'subagents', 'fork-points'] as const
type Sample = { bytes: number; ms: number[] }

// Median packaged-app measurements, three sizes × three runs per agent.
// See docs/history-loading-baseline.json; first-load CLI probing is kept separate.
const samples: Record<string, Sample[]> = {
  codex: [
    { bytes: 271291, ms: [1.25, 0.65, 0.55, 0.4, 0.75, 0, 93.5] },
    { bytes: 2969996, ms: [0.9, 4.8, 3.7, 2, 2.3, 0.1, 190.1] },
    { bytes: 39051535, ms: [1.8, 60.2, 49.2, 27.8, 30.8, 0, 11623.4] }
  ],
  traex: [
    { bytes: 1713534, ms: [2.05, 5.2, 8.55, 2.25, 2, 0.05, 291.65] },
    { bytes: 3537634, ms: [2.3, 9.9, 7.5, 4.8, 4.9, 93.5, 298] },
    { bytes: 15033586, ms: [2.1, 31.4, 34, 29.5, 33.6, 6672.8, 368.2] }
  ],
  claude: [
    { bytes: 24780, ms: [0.35, 0.1, 0, 0, 0.1, 0, 0.05] },
    { bytes: 672629, ms: [0.4, 1.3, 0, 0, 49.8, 0, 1.1] },
    { bytes: 3461159, ms: [0.5, 6.6, 0, 0, 55, 0, 3.3] }
  ]
}
const coldForkMs: Record<string, number> = { codex: 105.2, traex: 4481.5, claude: 380.6 }
const phaseOrder: Phase[] = ['preparing', ...measuredPhases.slice(0, 2), 'reading-parent',
  ...measuredPhases.slice(2, 6), 'replaying', 'fork-points', 'rendering', 'complete']

function estimateDurations(agentId: string, bytes: number, cold: boolean): Partial<Record<Phase, number>> {
  const rows = samples[agentId]
  if (!rows) {
    // Unmeasured providers retain a conservative estimate, never an invented work count.
    return agentId === 'grok'
      ? { locating: 50, replaying: 3000, 'fork-points': 1 }
      : { locating: 50, reading: 50, parsing: 100, 'fork-points': 1 }
  }
  const upperIndex = rows.findIndex((row) => row.bytes >= bytes)
  const upper = rows[upperIndex < 0 ? rows.length - 1 : upperIndex]
  const lower = rows[Math.max(0, upperIndex < 0 ? rows.length - 2 : upperIndex - 1)]
  const ratio = upper.bytes === lower.bytes ? 0 : Math.max(0, (bytes - lower.bytes) / (upper.bytes - lower.bytes))
  const durations = Object.fromEntries(measuredPhases.map((phase, index) => [
    phase, Math.max(0, lower.ms[index] + (upper.ms[index] - lower.ms[index]) * ratio)
  ])) as Partial<Record<Phase, number>>
  if (cold) durations['fork-points'] = (durations['fork-points'] || 0) + (coldForkMs[agentId] || 0)
  return durations
}

/** Weighted estimate of the whole preview. Only the renderer may finish the final 2%. */
export function createHistoryPreviewProgress(agentId: string, cold: boolean) {
  let durations = estimateDurations(agentId, 0, cold)
  let measuredFile = false
  let current: HistoryLoadProgress = { phase: 'preparing' }
  let startedAt = performance.now()
  let percent = 0

  function value(now = performance.now()): HistoryLoadProgress & { percent: number } {
    const totalMs = Object.values(durations).reduce((sum, ms) => sum + ms, 0) || 1
    const weights: Partial<Record<Phase, number>> = { preparing: 1, 'reading-parent': 1, rendering: 2 }
    for (const phase of measuredPhases) weights[phase] = (durations[phase] || 0) / totalMs * 96
    weights.replaying = (durations.replaying || 0) / totalMs * 96
    const position = phaseOrder.indexOf(current.phase)
    const before = phaseOrder.slice(0, position).reduce((sum, phase) => sum + (weights[phase] || 0), 0)
    const hasCount = Number.isFinite(current.total) && current.total! > 0 &&
      Number.isFinite(current.completed) && current.completed! >= 0
    const fraction = hasCount
      ? Math.min(1, current.completed! / current.total!)
      : Math.min(0.95, 1 - Math.exp(-2 * Math.max(0, now - startedAt) / Math.max(1, durations[current.phase] || 1000)))
    percent = current.phase === 'rendering' ? 98
      : Math.max(percent, Math.min(98, before + (weights[current.phase] || 0) * fraction))
    return { ...current, percent }
  }

  return {
    update(progress: HistoryLoadProgress, now = performance.now()) {
      if (!measuredFile && progress.phase === 'reading' && Number.isFinite(progress.total) && progress.total! > 0) {
        durations = estimateDurations(agentId, progress.total!, cold)
        measuredFile = true
      }
      if (progress.phase !== current.phase) startedAt = now
      current = progress
      return value(now)
    },
    value
  }
}
