import { request } from 'node:https'
import { CODEX_SOURCE_PRESETS, type CodexSourcePreset, type CodexSourceQuota } from '../shared/codexSources'

const MAX_RESPONSE = 1024 * 1024
export interface QuotaRequest { url: string; authorization: string }

function officialBase(preset: CodexSourcePreset, baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === CODEX_SOURCE_PRESETS[preset].baseUrl
}

export function quotaUnavailableReason(preset: CodexSourcePreset, baseUrl: string): string | undefined {
  if (!officialBase(preset, baseUrl)) return '自定义地址不查询额度'
  // MiMo 的余额/套餐额度接口依赖控制台登录态，API Key 无法查询。
  if (preset.startsWith('mimo')) return '小米 MiMo 暂不支持额度查询'
  return undefined
}

export function quotaRequestFor(preset: CodexSourcePreset, baseUrl: string, apiKey: string): QuotaRequest | null {
  if (quotaUnavailableReason(preset, baseUrl)) return null
  if (preset === 'kimi-code') return { url: 'https://api.kimi.com/coding/v1/usages', authorization: `Bearer ${apiKey}` }
  if (preset === 'kimi-api') return { url: 'https://api.moonshot.cn/v1/users/me/balance', authorization: `Bearer ${apiKey}` }
  if (preset === 'deepseek') return { url: 'https://api.deepseek.com/user/balance', authorization: `Bearer ${apiKey}` }
  if (preset === 'glm') return { url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', authorization: apiKey }
  return null
}

function finite(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(number)) throw new Error(`额度接口缺少 ${name}`)
  return number
}

function money(value: unknown, name: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`额度接口缺少 ${name}`)
  if (!Number.isFinite(Number(value))) throw new Error(`额度接口返回无效 ${name}`)
  return String(value)
}

export function normalizeQuotaResponse(preset: CodexSourcePreset, raw: any, capturedAt = Date.now()): CodexSourceQuota {
  if (preset === 'kimi-code') {
    const windows = ([
      ['limit_5h', '5 小时额度'], ['limit_7d', '每周额度'], ['limit_month_total', '每月额度']
    ] as const).flatMap(([key, label]) => {
      const entry = raw?.usages?.[key]
      if (!entry) return []
      const reset = typeof entry.reset_time === 'string' ? Date.parse(entry.reset_time) : NaN
      return [{
        label,
        usedPercent: Math.max(0, Math.min(100, finite(entry.used_ratio, '使用比例') * 100)),
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {})
      }]
    })
    if (!windows.length) throw new Error('Kimi Code 未返回套餐额度')
    return { status: 'ready', kind: 'windows', capturedAt, windows }
  }
  if (preset === 'kimi-api') {
    if (raw?.status !== true || !raw.data) throw new Error('Kimi API 余额响应无效')
    return {
      status: 'ready', kind: 'balance', capturedAt,
      balances: [{
        currency: 'CNY', total: money(raw.data.available_balance, '可用余额'),
        granted: money(raw.data.voucher_balance, '代金券余额'), toppedUp: money(raw.data.cash_balance, '现金余额')
      }]
    }
  }
  if (preset === 'deepseek') {
    if (!Array.isArray(raw?.balance_infos) || !raw.balance_infos.length) throw new Error('DeepSeek 余额响应无效')
    return {
      status: 'ready', kind: 'balance', capturedAt,
      balances: raw.balance_infos.map((balance: any) => ({
        currency: typeof balance.currency === 'string' ? balance.currency : 'CNY',
        total: money(balance.total_balance, '总余额'),
        granted: money(balance.granted_balance, '赠金余额'), toppedUp: money(balance.topped_up_balance, '充值余额')
      }))
    }
  }
  if (preset === 'glm') {
    if (raw?.success === false || raw?.code != null && ![0, 200].includes(Number(raw.code))) {
      if (/不存在\s*coding\s*plan|(?:no|not.*exist).*coding\s*plan|coding\s*plan.*(?:not.*exist|not found)/i.test(String(raw?.msg ?? raw?.message ?? ''))) {
        return { status: 'unsupported', capturedAt, message: '当前账号未开通 GLM Coding Plan' }
      }
      throw new Error('GLM 额度接口未返回成功结果')
    }
    if (!Array.isArray(raw?.data?.limits)) throw new Error('GLM 额度响应无效')
    const windows = raw.data.limits.flatMap((limit: any) => {
      const label = limit?.type === 'TIME_LIMIT' ? 'MCP 月额度'
        : limit?.type === 'TOKENS_LIMIT' && limit.unit === 3 && limit.number === 5 ? '5 小时额度'
          : limit?.type === 'TOKENS_LIMIT' && limit.unit === 6 ? '每周额度'
            : limit?.type === 'TOKENS_LIMIT' ? 'Token 额度' : undefined
      if (!label) return []
      const reset = limit.nextResetTime === undefined || limit.nextResetTime === null ? undefined : finite(limit.nextResetTime, '重置时间')
      return [{
        label,
        usedPercent: Math.max(0, Math.min(100, finite(limit.percentage, '使用比例'))),
        ...(reset === undefined ? {} : { resetsAt: reset < 1_000_000_000_000 ? reset * 1000 : reset })
      }]
    })
    if (!windows.length) throw new Error('GLM 未返回支持的额度窗口')
    const level = typeof raw.data.level === 'string' ? raw.data.level.trim() : ''
    return { status: 'ready', kind: 'windows', capturedAt, windows,
      ...(level ? { planType: `GLM Coding ${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}` } : {}) }
  }
  throw new Error('该接入方式不支持额度查询')
}

export function quotaErrorMessage(status?: number): string {
  if (status === 401 || status === 403) return '密钥无额度查询权限'
  if (status === 429) return '额度查询过于频繁'
  return '额度查询失败'
}

class QuotaHttpError extends Error { constructor(readonly status: number) { super(quotaErrorMessage(status)) } }

async function requestJson(input: QuotaRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(input.url, {
      method: 'GET', headers: { Authorization: input.authorization, Accept: 'application/json', 'User-Agent': 'UniAgent' }
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new QuotaHttpError(response.statusCode || 0)); return }
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE) response.destroy(new Error('额度响应过大'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('额度接口返回无效数据')) }
      })
    })
    req.setTimeout(8000, () => req.destroy(new Error('额度查询超时')))
    req.once('error', reject)
    req.end()
  })
}

export async function fetchSourceQuota(preset: CodexSourcePreset, baseUrl: string, apiKey: string): Promise<CodexSourceQuota> {
  const input = quotaRequestFor(preset, baseUrl, apiKey)
  if (!input) return { status: 'unsupported', message: quotaUnavailableReason(preset, baseUrl) || '不支持额度查询' }
  return fetchQuotaRequest(preset, input)
}

export async function fetchQuotaRequest(preset: CodexSourcePreset, input: QuotaRequest): Promise<CodexSourceQuota> {
  try { return normalizeQuotaResponse(preset, await requestJson(input)) }
  catch (error) {
    if (error instanceof QuotaHttpError) throw new Error(quotaErrorMessage(error.status))
    throw error
  }
}
