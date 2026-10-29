import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'

export interface DeepSeekRemoteRequest {
  event: string
  eventId: string
  agentId: string
  request: Record<string, any>
}
interface Owner {
  request: (request: DeepSeekRemoteRequest) => boolean
  cancel: (id: string) => void
  failed: (error: Error) => void
}
const hubs = new WeakMap<DeepSeekHostClient, DeepSeekHostEvents>()

/** One waterfall consumer per Host connection, with exclusive session routing. */
export class DeepSeekHostEvents {
  private owners = new Map<string, Owner>()
  private pending = new Map<string, Owner>()
  private controller = new AbortController()
  private clientId?: string
  private failure?: Error
  private ready: Promise<void>

  static for(client: DeepSeekHostClient): DeepSeekHostEvents {
    let hub = hubs.get(client)
    if (!hub) { hub = new DeepSeekHostEvents(client); hubs.set(client, hub) }
    return hub
  }
  private constructor(private readonly client: DeepSeekHostClient) {
    let resolve!: () => void, reject!: (error: Error) => void
    this.ready = new Promise<void>((a, b) => { resolve = a; reject = b })
    // A failed connection may precede the first session attachment.
    void this.ready.catch(() => {})
    const timer = setTimeout(() => this.controller.abort(), 15_000)
    void (async () => {
      try {
        for await (const frame of client.stream<any>('$events', {}, this.controller.signal)) {
          if (!this.clientId) {
            if (frame?.type !== 'ready' || typeof frame.clientId !== 'string') throw new DeepSeekHostError('invalid-event-baseline')
            this.clientId = frame.clientId; clearTimeout(timer); resolve(); continue
          }
          if (frame.type === 'cancel') {
            const owner = this.pending.get(frame.eventId)
            this.pending.delete(frame.eventId); owner?.cancel(frame.eventId)
          } else if (frame.type === 'waterfall') {
            if (typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string' || !frame.request) throw new DeepSeekHostError('invalid-remote-request')
            const owner = this.owners.get(frame.agentId)
            if (owner) this.pending.set(frame.eventId, owner)
            if (!owner?.request(frame)) {
              this.pending.delete(frame.eventId)
              await client.call('$events/result', { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: 'next' } })
            }
          }
        }
        throw new DeepSeekHostError('events-ended')
      } catch (error) {
        this.failure = error instanceof Error ? error : new DeepSeekHostError('events-failed')
        reject(this.failure)
        for (const [id, owner] of this.pending) owner.cancel(id)
        this.pending.clear()
        for (const owner of this.owners.values()) owner.failed(this.failure)
      } finally { clearTimeout(timer) }
    })()
  }
  async attach(sessionId: string, owner: Owner, signal?: AbortSignal): Promise<() => void> {
    await this.ready
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    if (this.owners.has(sessionId)) throw new DeepSeekHostError('session/writer-held')
    this.owners.set(sessionId, owner)
    return () => {
      if (this.owners.get(sessionId) !== owner) return
      this.owners.delete(sessionId)
      for (const [id, pending] of this.pending) {
        if (pending !== owner) continue
        void this.answer(id, 'cancelled').catch(() => {})
        owner.cancel(id)
      }
    }
  }
  async answer(eventId: string, value: unknown): Promise<boolean> {
    if (this.failure || !this.clientId || !this.pending.has(eventId)) return false
    // Reserve the answer before awaiting: double-clicks cannot send it twice.
    const owner = this.pending.get(eventId)!
    this.pending.delete(eventId)
    try {
      await this.client.call('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'result', value } })
      return true
    } catch (error) {
      owner.cancel(eventId)
      owner.failed(error instanceof Error ? error : new DeepSeekHostError('event-answer-failed'))
      throw error // Never retry an uncertain approval delivery.
    }
  }
}
