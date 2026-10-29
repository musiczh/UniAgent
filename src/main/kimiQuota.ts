import { homedir } from 'node:os'
import type { CodexSourceQuota } from '../shared/codexSources'
import { kimiHome } from './kimiAuth'
import { acquireKimiWebService } from './kimiWebService.ts'
import { KimiWebError, type KimiWebTransport } from './kimiWebTransport'

async function readUsage(transport: KimiWebTransport): Promise<CodexSourceQuota | null> {
  // Official service owns OAuth refresh and regional account routing. No prompt or session is created.
  const result = await transport.request<any>('GET', '/api/v1/oauth/usage')
  if (result?.kind !== 'ok') throw new KimiWebError('quota_query')
  const windows = ([
    ['limit5h', '5 小时额度'], ['limit7d', '每周额度'],
    ['monthTotal', '月度共享额度']
  ] as const).flatMap(([key, label]) => {
    const entry = result.quota?.usages?.[key]
    const ratio = typeof entry?.usedRatio === 'number' ? entry.usedRatio
      : typeof entry?.usedRatio === 'string' && entry.usedRatio.trim() ? Number(entry.usedRatio) : NaN
    if (!Number.isFinite(ratio)) return []
    const reset = typeof entry.resetAt === 'string' ? Date.parse(entry.resetAt) : NaN
    return [{ label, usedPercent: Math.max(0, Math.min(100, ratio * 100)), ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) }]
  })
  return windows.length ? { status: 'ready', kind: 'windows', capturedAt: Date.now(), planType: '订阅套餐', windows } : null
}

export class KimiQuotaService {
  private flight?: Promise<CodexSourceQuota | null>
  private closed = false
  get(bin: string): Promise<CodexSourceQuota | null> {
    if (!this.flight) this.flight = this.query(bin).finally(() => { this.flight = undefined })
    return this.flight
  }
  private async query(bin: string): Promise<CodexSourceQuota | null> {
    if (this.closed) return null
    const lease = await acquireKimiWebService({ bin, cwd: homedir(), env: { KIMI_CODE_HOME: kimiHome() } })
    try { return this.closed ? null : await readUsage(lease.transport) }
    finally { await lease.release() }
  }
  async close(): Promise<void> { this.closed = true; await this.flight?.catch(() => {}) }
}
