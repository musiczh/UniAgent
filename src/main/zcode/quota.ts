import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ZCodeQuotaSnapshot } from '../../shared/zcode'
import { fetchQuotaRequest } from '../codexSourceQuota'
import { mergeZCodeConfig } from './catalog'
import { loadZCodeRuntimeConfig } from './runtime'

const CACHE_MS = 5 * 60_000

export class ZCodeQuotaService {
  private cache?: { identity: string; quota: ZCodeQuotaSnapshot }
  private flight?: { identity: string; promise: Promise<ZCodeQuotaSnapshot> }

  async get(providerId?: string, force = false): Promise<ZCodeQuotaSnapshot | null> {
    try {
      const runtime = await loadZCodeRuntimeConfig()
      if (!runtime?.personalProviderConfigPath) return null
      const personal = JSON.parse(await readFile(runtime.personalProviderConfigPath, 'utf8'))?.config
      const selected = providerId ?? personal?.defaultModelSelection?.providerId
      const unsupported = (message: string): ZCodeQuotaSnapshot => ({ status: 'unsupported', providerId: typeof selected === 'string' ? selected : undefined, capturedAt: Date.now(), message })
      if (typeof selected !== 'string') return unsupported('ZCode 尚未选择 Provider')
      const builtin = runtime.resourceRoot
        ? JSON.parse(await readFile(join(runtime.resourceRoot, 'provider', 'zcode-builtin.json'), 'utf8'))?.config : {}
      let provider: any
      for (const rule of [...(builtin?.providerConfigRules?.providerRules ?? []), ...(personal?.providerConfigRules?.providerRules ?? [])]) {
        if (rule.providerId === selected) provider = mergeZCodeConfig(provider, rule)
      }
      if (!provider || provider.enabled === false) return unsupported('ZCode 当前 Provider 已不可用')
      const template = builtin?.providerConfigRules?.templateRules?.find((item: any) => item.templateId === provider.templateId)
      const config = mergeZCodeConfig(template?.config, provider.config)
      if (config?.access?.type !== 'zhipu-coding-plan-api-key') return unsupported('当前 Provider 未使用 Coding Plan 凭据，暂不支持额度查询')
      const key = config.access.apiKey
      if (typeof key !== 'string' || !key.trim()) return unsupported('ZCode 当前 Provider 缺少额度查询凭据')
      let origin: string
      try { origin = new URL(config.api?.baseUrl).origin }
      catch { return unsupported('ZCode 当前 Provider 地址无效') }
      if (!['https://open.bigmodel.cn', 'https://api.z.ai'].includes(origin)) return unsupported('自定义 Provider 地址不查询额度')
      const url = origin + '/api/monitor/usage/quota/limit'
      // Credentials stay in the main process; only a fingerprint identifies cached requests.
      const identity = createHash('sha256').update(JSON.stringify([runtime.personalProviderConfigPath, selected, url, key])).digest('hex')
      if (this.flight?.identity === identity) return this.flight.promise
      if (!force && this.cache?.identity === identity && Date.now() - (this.cache.quota.capturedAt ?? 0) < CACHE_MS) return this.cache.quota
      const flight = { identity, promise: fetchQuotaRequest('glm', { url, authorization: key }).then(quota => ({
        ...quota, providerId: selected, planType: quota.planType ?? 'GLM Coding Plan'
      })).catch((): ZCodeQuotaSnapshot => ({ status: 'error', providerId: selected, capturedAt: Date.now(), message: 'ZCode 额度查询失败，请检查凭据或稍后刷新' })) }
      this.flight = flight
      try {
        const quota = await flight.promise
        if (this.flight === flight) this.cache = { identity, quota }
        return quota
      } finally { if (this.flight === flight) this.flight = undefined }
    } catch {
      return { status: 'error', providerId, capturedAt: Date.now(), message: 'ZCode 额度配置无法读取，请检查运行时与 Provider 配置' }
    }
  }
}
