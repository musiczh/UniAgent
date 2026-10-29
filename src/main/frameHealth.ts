import type { FrameHealthReply } from '../shared/frameHealth'

export const FRAME_PROBE_INTERVAL_MS = 2_000
const RESPONSIVE_WITHIN_MS = 1_000
const STALLED_PROBES = 3
const RECOVERY_COOLDOWN_MS = 30_000
const RECOVERY_WINDOW_MS = 10 * 60_000
const MAX_RECOVERIES = 2

type PendingProbe = { id: number; sentAt: number; responsive: boolean; painted: boolean }

/** Main-process clock owns detection; a renderer timer alone cannot detect a frozen renderer. */
export class FrameHealthMonitor {
  private sequence = 0
  private pending?: PendingProbe
  private lastTick?: number
  private stalled = 0
  private awaitingRecovery = false
  private reportedLimit = false

  constructor(private readonly options: {
    send: (id: number) => void
    recover: () => boolean
    record: (kind: string, data: Record<string, unknown>) => void
    // Shared across windows: reopening a window must not reset the recovery limit.
    recoveries: number[]
  }) {}

  reset(): void {
    this.pending = undefined
    this.lastTick = undefined
    this.stalled = 0
  }

  reply(message: unknown, now: number): void {
    if (!message || typeof message !== 'object') return
    const { id, kind } = message as FrameHealthReply
    const pending = this.pending
    if (!pending || id !== pending.id) return
    if (kind === 'hidden') { this.reset(); return }
    if (kind === 'responsive' && now >= pending.sentAt && now - pending.sentAt <= RESPONSIVE_WITHIN_MS) pending.responsive = true
    if (kind === 'painted') pending.painted = true
  }

  tick(now: number, visible: boolean): void {
    // Sleep, a blocked main loop, navigation and background throttling are not GPU stalls.
    if (!visible || (this.lastTick !== undefined && (now - this.lastTick > FRAME_PROBE_INTERVAL_MS * 2 || now < this.lastTick))) {
      this.reset()
      return
    }
    this.lastTick = now
    const pending = this.pending
    if (pending?.painted) {
      this.stalled = 0
      if (this.awaitingRecovery) {
        this.options.record('frame_recovered', {})
        this.awaitingRecovery = false
      }
    } else if (pending?.responsive) {
      this.stalled++
    } else {
      this.stalled = 0
    }

    if (this.stalled >= STALLED_PROBES) {
      const recoveries = this.options.recoveries
      while (recoveries.length && now - recoveries[0] >= RECOVERY_WINDOW_MS) recoveries.shift()
      const coolingDown = recoveries.length > 0 && now - recoveries[recoveries.length - 1] < RECOVERY_COOLDOWN_MS
      if (recoveries.length >= MAX_RECOVERIES) {
        if (!this.reportedLimit) this.options.record('frame_recovery_limited', { attempts: recoveries.length })
        this.reportedLimit = true
      } else if (!coolingDown) {
        this.reportedLimit = false
        recoveries.push(now)
        this.options.record('frame_stalled', { consecutiveProbes: this.stalled, attempts: recoveries.length })
        try {
          this.awaitingRecovery = this.options.recover()
          if (!this.awaitingRecovery) this.options.record('frame_recovery_unavailable', {})
        } catch (error) {
          this.options.record('frame_recovery_failed', { code: (error as NodeJS.ErrnoException)?.code || 'unknown' })
        }
        this.stalled = 0
      }
    }
    this.pending = { id: ++this.sequence, sentAt: now, responsive: false, painted: false }
    this.options.send(this.pending.id)
  }
}
