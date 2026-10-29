export type CompactionTransition = {
  id: string
  state: 'running' | 'success' | 'failed'
  error?: string
}

/**
 * Serializes complete `thread/compact/start` lifecycles. The protocol response
 * is an empty object and native item notifications may precede it, so the next
 * invocation must not enter the lifecycle until the current one has reached a
 * terminal notification (or its RPC has failed).
 */
export class CompactionInvocationQueue {
  private tail: Promise<void> = Promise.resolve()
  private closedError: Error | null = null

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const result = this.tail.then(() => {
      if (this.closedError) throw this.closedError
      return operation()
    })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  close(error = new Error('compaction queue closed')): void {
    this.closedError ||= error
  }

  idle(): Promise<void> {
    return this.tail
  }
}

/** Prevents manual compaction from overlapping a turn's automatic compaction. */
export class CompactionActivityGate {
  private turnTokens = new Set<string>()
  private nativeIds = new Set<string>()

  turnStarted(token: string): void { if (token) this.turnTokens.add(token) }
  turnFinished(token: string): void { if (token) this.turnTokens.delete(token) }
  resetTurns(): void { this.turnTokens.clear() }
  nativeStarted(id: string): void { if (id) this.nativeIds.add(id) }
  nativeFinished(id: string): void { if (id) this.nativeIds.delete(id) }
  resetNative(): void { this.nativeIds.clear() }

  manualUnavailableReason(): string | undefined {
    if (this.turnTokens.size > 0) return '运行中不能手动压缩上下文，请等待当前回合结束。'
    if (this.nativeIds.size) return '上下文正在压缩，请等待完成后再试。'
    return undefined
  }
}

/** Buffers terminal notifications that share a stdout chunk with turn/start. */
export class DeferredTurnCompletions<T> {
  private pending = new Map<string, T>()

  defer(turnId: string, value: T): void {
    if (!turnId) return
    this.pending.set(turnId, value)
    // A start attempt can have at most one legitimate completion. Keep a tiny
    // bound so malformed/stale traffic cannot grow memory while the response is
    // pending. claim() discards every non-matching stale entry.
    while (this.pending.size > 8) this.pending.delete(this.pending.keys().next().value as string)
  }

  claim(turnId: string): T | undefined {
    const value = this.pending.get(turnId)
    this.pending.clear()
    return value
  }

  clear(): void { this.pending.clear() }
}

/** Correlates native compaction item ids with one stable UI id per invocation. */
export class ContextCompactionLifecycle {
  private sequence = 0
  /** Invocations whose native item id has not arrived yet, in request order. */
  private pendingInvocationIds: string[] = []
  /** Completed no-id notifications that may still receive a late native item id. */
  private awaitingNativeAliases: string[] = []
  /** Item completions waiting for the redundant no-id thread/compacted notice. */
  private awaitingCompactedNotices: string[] = []
  private aliases = new Map<string, string>()
  private nativeByStable = new Map<string, string>()
  private completed = new Set<string>()

  constructor(private readonly threadId: () => string | undefined) {}

  beginInvocation(): CompactionTransition {
    const id = this.allocate()
    this.pendingInvocationIds.push(id)
    return { id, state: 'running' }
  }

  alias(nativeId: string | undefined, stableId: string): void {
    if (!nativeId) return

    const previousStable = this.aliases.get(nativeId)
    if (previousStable && previousStable !== stableId) {
      this.nativeByStable.delete(previousStable)
      if (!this.completed.has(previousStable)) this.pendingInvocationIds.unshift(previousStable)
    }
    const previousNative = this.nativeByStable.get(stableId)
    if (previousNative && previousNative !== nativeId) this.aliases.delete(previousNative)

    this.aliases.set(nativeId, stableId)
    this.nativeByStable.set(stableId, nativeId)
    this.remove(this.pendingInvocationIds, stableId)
    this.remove(this.awaitingNativeAliases, stableId)
  }

  started(nativeId?: string): CompactionTransition | null {
    const id = this.resolve(nativeId)
    if (this.completed.has(id)) return null
    return { id, state: 'running' }
  }

  completedItem(nativeId: string | undefined, failed = false, error?: string): CompactionTransition | null {
    const transition = this.finish(this.resolve(nativeId), failed ? 'failed' : 'success', error)
    if (transition && !failed) this.awaitingCompactedNotices.push(transition.id)
    return transition
  }

  compacted(nativeId?: string): CompactionTransition | null {
    if (nativeId) {
      const id = this.resolve(nativeId)
      this.remove(this.awaitingCompactedNotices, id)
      return this.finish(id, 'success')
    }

    // v2 thread/compacted carries only threadId/turnId, so it cannot identify
    // which invocation completed. It is a redundant notice, never an
    // authoritative lifecycle terminal. Releasing a serialized invocation here
    // would let a late native item from A claim the newly-started B.
    if (this.awaitingCompactedNotices.length) {
      this.awaitingCompactedNotices.shift()
    }
    return null
  }

  failInvocation(stableId: string, error?: string): CompactionTransition | null {
    return this.finish(stableId, 'failed', error)
  }

  private allocate(): string {
    this.sequence += 1
    return `context-compaction-${this.threadId() || 'thread'}-${this.sequence}`
  }

  private resolve(nativeId?: string): string {
    if (nativeId) {
      const known = this.aliases.get(nativeId)
      if (known) return known

      const pending = this.pendingInvocationIds.shift()
      if (pending) {
        this.alias(nativeId, pending)
        return pending
      }

      const completed = this.awaitingNativeAliases.shift()
      if (completed) {
        this.alias(nativeId, completed)
        return completed
      }
    }

    const pending = this.pendingInvocationIds.shift()
    if (pending) return pending

    const id = this.allocate()
    this.alias(nativeId, id)
    return id
  }

  private finish(id: string, state: 'success' | 'failed', error?: string): CompactionTransition | null {
    if (this.completed.has(id)) return null
    this.completed.add(id)
    this.remove(this.pendingInvocationIds, id)
    return { id, state, error }
  }

  private remove(ids: string[], id: string): void {
    const index = ids.indexOf(id)
    if (index >= 0) ids.splice(index, 1)
  }
}
