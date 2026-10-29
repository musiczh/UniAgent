import { DEFAULT_ENABLED_AGENT_IDS, type AgentDef, type AppSettings } from '../shared/types.ts'
import type { AgentLifecycleService } from './agentLifecycleService.ts'

const IDLE_DELAY_MS = 5 * 60_000
const CHECK_INTERVAL_MS = 60 * 60_000

interface IdleAgentUpdaterOptions {
  lifecycle: Pick<AgentLifecycleService, 'snapshot' | 'checkUpdate' | 'updateOne'>
  settings: () => AppSettings
  isBusy: () => boolean
  onUpdated: (agents: AgentDef[]) => void
  now?: () => number
}

export class IdleAgentUpdater {
  private timer?: ReturnType<typeof setInterval>
  private idleSince?: number
  private lastCheckAt = -Infinity
  private generation = 0
  private flight?: Promise<void>
  private readonly now: () => number

  constructor(private readonly options: IdleAgentUpdaterOptions) {
    this.now = options.now || Date.now
  }

  start(): void {
    if (this.timer) return
    this.markActivity()
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 30_000)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.markActivity()
  }

  markActivity(): void {
    this.idleSince = undefined
    this.generation += 1
  }

  tick(): Promise<void> {
    if (!this.timer || !this.options.settings().autoUpdateAgentsWhenIdle || this.options.isBusy()) {
      this.markActivity()
      return Promise.resolve()
    }
    if (this.flight) return this.flight
    if (this.options.lifecycle.snapshot().some(agent => agent.lifecycle?.updateStatus === 'updating')) {
      this.markActivity()
      return Promise.resolve()
    }
    const now = this.now()
    this.idleSince ??= now
    if (now - this.idleSince < IDLE_DELAY_MS || now - this.lastCheckAt < CHECK_INTERVAL_MS) return Promise.resolve()
    this.lastCheckAt = now
    const generation = this.generation
    const flight = this.performUpdates(generation).finally(() => {
      if (this.flight === flight) this.flight = undefined
    })
    this.flight = flight
    return flight
  }

  private eligible(agent: AgentDef): boolean {
    const enabled: readonly string[] = this.options.settings().enabledAgentIds || DEFAULT_ENABLED_AGENT_IDS
    return enabled.includes(agent.id) && agent.lifecycle?.availability === 'available' && agent.lifecycle.selfUpdateSupported !== false
  }

  private canContinue(generation: number): boolean {
    return !!this.timer && generation === this.generation && !!this.options.settings().autoUpdateAgentsWhenIdle && !this.options.isBusy()
  }

  private async performUpdates(generation: number): Promise<void> {
    const { lifecycle } = this.options
    const ids = lifecycle.snapshot().filter(agent => this.eligible(agent)).map(agent => agent.id)
    try {
      await Promise.allSettled(ids.map(id => this.canContinue(generation) ? lifecycle.checkUpdate(id) : Promise.resolve()))
      for (const id of ids) {
        if (!this.canContinue(generation)) break
        const agent = lifecycle.snapshot().find(item => item.id === id)
        if (!agent || !this.eligible(agent) || agent.lifecycle?.updateStatus !== 'available') continue
        try {
          await lifecycle.updateOne(id, () => !this.canContinue(generation))
        } catch { /* The lifecycle service exposes per-Agent update failures. */ }
      }
    } finally {
      this.options.onUpdated(lifecycle.snapshot())
    }
  }
}
