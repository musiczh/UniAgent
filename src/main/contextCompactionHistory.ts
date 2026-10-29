export type HistoricalCompaction = { id: string; timestamp: unknown; source: 'top' | 'event' }

/** Deduplicates the paired `compacted` + `context_compacted` rollout records. */
export class ContextCompactionHistory {
  private emittedIds = new Set<string>()
  private pendingTopLevel: { id: string; ts: number } | null = null

  accept(nativeId: unknown, timestamp: unknown, source: 'top' | 'event', fallbackOrdinal: number): string | null {
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number(timestamp)
    const time = Number.isFinite(parsed) ? parsed : 0
    const explicit = typeof nativeId === 'string' && nativeId ? nativeId : undefined
    if (explicit && this.emittedIds.has(explicit)) return null
    if (source === 'event' && !explicit && this.pendingTopLevel && time && Math.abs(time - this.pendingTopLevel.ts) < 5000) {
      this.pendingTopLevel = null
      return null
    }
    const id = explicit || `context-compaction-history-${time || fallbackOrdinal}`
    this.emittedIds.add(id)
    this.pendingTopLevel = source === 'top' ? { id, ts: time } : null
    return id
  }
}
