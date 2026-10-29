import type { AgentDef, CodexRateLimits } from '../shared/types'
import type { CodexSourceQuota } from '../shared/codexSources'
import { accountQuota, hasQuotaData, type AgentQuotaSnapshot } from '../shared/agentQuota'
import { getCodexRateLimits, queryAppServerRateLimits, refreshCodexRateLimits } from './codexRateLimits'
import { getClaudeRateLimits } from './claudeRateLimits'
import { getDeepSeekQuota } from './deepseekService'
import type { GrokQuotaService } from './grokQuota'
import type { ZCodeQuotaService } from './zcode/quota'
import { KimiQuotaService } from './kimiQuota'

const CACHE_MS = 5 * 60_000

/** Dispatch from the available Agent list, keeping failed queries separate from real zero quota. */
export class AgentQuotaService {
  private readonly kimi = new KimiQuotaService()
  private readonly cache = new Map<string, { adapter: AgentDef['adapter']; checkedAt: number; quota: CodexSourceQuota | null }>()
  private readonly flights = new Map<string, Promise<CodexSourceQuota | null>>()

  constructor(private readonly grok: GrokQuotaService, private readonly zcode: ZCodeQuotaService) {}

  async get(agent: AgentDef, force = false, providerId?: string): Promise<AgentQuotaSnapshot | null> {
    const key = JSON.stringify([agent.adapter, agent.bin, agent.adapter === 'zcode' ? providerId : undefined])
    const cached = this.cache.get(key)
    let flight = this.flights.get(key)
    if (!flight && !force && agent.adapter !== 'zcode' && cached && Date.now() - cached.checkedAt < (cached.quota?.stale ? 60_000 : CACHE_MS)) {
      return cached.quota && { ...cached.quota, agentId: agent.id }
    }
    if (!flight) {
      flight = (async () => {
        let quota: CodexSourceQuota | null
        try {
          quota = await this.query(agent, force, providerId)
          if (quota?.status === 'error') throw new Error('quota_query_failed')
          if (!hasQuotaData(quota)) quota = null
        } catch {
          const previous = this.cache.get(key)?.quota ?? (agent.adapter === 'codex' ? accountQuota(await getCodexRateLimits().catch(() => null)) : null)
          quota = hasQuotaData(previous) ? { ...previous!, stale: true, status: 'error', message: '额度刷新失败，显示上次结果' } : null
        }
        const current = this.cache.get(key)?.quota
        if (current && quota && (current.capturedAt ?? 0) > (quota.capturedAt ?? 0)) quota = quota.stale ? { ...current, stale: true } : current
        this.cache.set(key, { adapter: agent.adapter, checkedAt: Date.now(), quota })
        return quota
      })()
      this.flights.set(key, flight)
      void flight.finally(() => { this.flights.delete(key) }).catch(() => {})
    }
    const quota = await flight
    return quota && { ...quota, agentId: agent.id }
  }

  remember(adapter: AgentDef['adapter'], limits: CodexRateLimits): void {
    const quota = accountQuota(limits)
    if (!quota) return
    for (const [key, entry] of this.cache) {
      if (entry.adapter === adapter) this.cache.set(key, { adapter, checkedAt: Date.now(), quota })
    }
  }

  private async query(agent: AgentDef, force: boolean, providerId?: string): Promise<CodexSourceQuota | null> {
    switch (agent.adapter) {
      case 'codex': return accountQuota(await refreshCodexRateLimits(agent.bin))
      case 'traex': return accountQuota(await queryAppServerRateLimits(agent.bin))
      case 'claude': return accountQuota(getClaudeRateLimits())
      case 'kimi': return this.kimi.get(agent.bin)
      case 'deepseek': return getDeepSeekQuota()
      case 'grok': {
        const quota = await this.grok.get(agent.bin, force)
        if (quota?.status === 'error' || quota?.status === 'needs-auth') throw new Error('grok_quota_failed')
        return quota?.status === 'ready' && quota.window ? { status: 'ready', kind: 'windows', capturedAt: quota.capturedAt, planType: quota.planType, windows: [quota.window] } : null
      }
      case 'zcode': return this.zcode.get(providerId, force)
      default: return null // No account quota contract is advertised by this adapter.
    }
  }

  close(): Promise<void> { return this.kimi.close() }
}
