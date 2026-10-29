import type { UAEvent } from '../shared/types'

const streamingTypes = new Set<UAEvent['type']>(['agent_message', 'reasoning', 'command_exec', 'diff_update', 'plan_update'])

/** Only the UI projection is coalesced; approvals and semantic consumers remain immediate. */
export class UIEventBatcher {
  private pending = new Map<string, { event: UAEvent; bytes: number }>()
  private bytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private batches = 0
  private sentEvents = 0
  constructor(private readonly send: (events: UAEvent[]) => void, private readonly intervalMs = 50) {}

  push(event: UAEvent): void {
    if (event.state !== 'running' || !event.payload?.id || !streamingTypes.has(event.type)) {
      this.flush()
      this.deliver([event])
      return
    }
    const key = JSON.stringify([event.sessionId, event.payload.turnId, event.type, event.payload.id])
    const previous = this.pending.get(key)
    const bytes = 512 + ['text', 'output', 'diff', 'delta'].reduce((total, field) =>
      total + (typeof event.payload[field] === 'string' ? event.payload[field].length * 2 : 0), 0)
    this.bytes += bytes - (previous?.bytes || 0)
    this.pending.set(key, { event, bytes })
    if (this.pending.size >= 64 || this.bytes >= 256 * 1024) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const events = [...this.pending.values()].map(item => item.event)
    this.pending.clear(); this.bytes = 0
    if (events.length) this.deliver(events)
  }

  stats(): Record<string, number> {
    return { uiPendingSnapshots: this.pending.size, uiPendingBytes: this.bytes, uiBatches: this.batches, uiSentEvents: this.sentEvents }
  }

  private deliver(events: UAEvent[]): void {
    this.batches++; this.sentEvents += events.length
    this.send(events)
  }
}
