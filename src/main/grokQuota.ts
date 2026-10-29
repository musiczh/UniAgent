import { ACPConnection, ACPRemoteError } from './acp/acpConnection'
import { diagnostics, runtimeDiagnosticSample } from './diagnostics'
import type { GrokQuota } from '../shared/types'

const CACHE_MS = 5 * 60_000

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cents(value: unknown): number | undefined {
  if (!record(value)) return undefined
  // Grok's Cent serializes a known zero as {}, matching the official parser.
  const amount = value.val === undefined ? 0 : value.val
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : undefined
}

function normalizeBilling(raw: unknown): GrokQuota {
  const billing = record(raw) && record(raw.result) ? raw.result : raw
  if (!record(billing) || !record(billing.config)) {
    return { status: 'unsupported', capturedAt: Date.now(), message: '当前 Grok 账号未提供额度数据' }
  }
  const config = billing.config
  const limit = cents(config.monthlyLimit)
  const used = cents(config.used)
  const period = record(config.currentPeriod) ? config.currentPeriod : undefined
  const end = period?.end ?? config.billingPeriodEnd
  const resetsAt = typeof end === 'string' ? Date.parse(end) : NaN
  // Proto3 omits zero usage after a reset; only a valid credits period supplies that default.
  const percent = config.creditUsagePercent
    ?? (limit != null && limit > 0 && used != null ? used / limit * 100 : undefined)
    ?? (['USAGE_PERIOD_TYPE_WEEKLY', 'USAGE_PERIOD_TYPE_MONTHLY'].includes(period?.type) && Number.isFinite(resetsAt) ? 0 : undefined)
  if (typeof percent !== 'number' || !Number.isFinite(percent)) throw new Error('invalid_grok_quota')
  const label = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '周限额'
    : period?.type === 'USAGE_PERIOD_TYPE_MONTHLY' || (config.creditUsagePercent == null && limit != null) ? '月限额' : '账号额度'
  return {
    status: 'ready', capturedAt: Date.now(),
    ...(typeof billing.subscription_tier === 'string' ? { planType: billing.subscription_tier } : {}),
    window: {
      label, usedPercent: Math.max(0, Math.min(100, percent)),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
    }
  }
}

export class GrokQuotaService {
  private cache?: { bin: string; quota: GrokQuota }
  private flight?: Promise<GrokQuota>
  private connection?: ACPConnection

  async get(bin?: string, force = false): Promise<GrokQuota | null> {
    if (!bin) { this.cache = undefined; return null }
    if (this.flight) return this.flight
    if (!force && this.cache?.bin === bin && Date.now() - this.cache.quota.capturedAt < CACHE_MS) return this.cache.quota
    this.flight = this.query(bin)
    try {
      const quota = await this.flight
      this.cache = { bin, quota }
      return quota
    } finally {
      this.flight = undefined
    }
  }

  async close(): Promise<void> {
    if (this.connection) await this.closeConnection(this.connection)
  }

  private async closeConnection(connection: ACPConnection): Promise<void> {
    try {
      await connection.closeAndWait()
    } catch (error) {
      try {
        diagnostics.record({
          category: 'app_runtime', level: 'warn', source: 'grok-quota', agentId: 'grok',
          code: 'transport_close_failed', message: 'Grok 额度查询连接关闭失败',
          sample: runtimeDiagnosticSample(error, { stage: 'close', stderr: connection.diagnosticTail })
        })
      } catch { /* Diagnostics must not replace the quota result. */ }
    } finally {
      if (this.connection === connection) this.connection = undefined
    }
  }

  private async query(bin: string): Promise<GrokQuota> {
    const connection = new ACPConnection({ bin, args: ['agent', '--no-leader', 'stdio'], providerLabel: 'Grok' })
    this.connection = connection
    try {
      await connection.initialize()
      return normalizeBilling(await connection.request('_x.ai/billing', {}))
    } catch (error) {
      // Only fixed messages cross IPC; provider errors may contain private data.
      const status = error instanceof ACPRemoteError && error.code === -32000 ? 'needs-auth'
        : error instanceof ACPRemoteError && error.code === -32601 ? 'unsupported' : 'error'
      const message = status === 'needs-auth' ? '请先登录 Grok 后刷新额度'
        : status === 'unsupported' ? '当前 Grok CLI 不支持额度查询，请更新后重试' : 'Grok 额度查询失败，请重试'
      return { status, message, capturedAt: Date.now() }
    } finally {
      await this.closeConnection(connection)
    }
  }
}
