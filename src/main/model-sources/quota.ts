import { createHash, createHmac } from 'node:crypto'
import { fetchQuotaRequest, quotaRequestFor, type QuotaRequest } from '../codexSourceQuota'
import { modelSourceQuotaProvider, validateQuotaQuery, type ModelSourceQuota, type QuotaProviderId, type QuotaQueryContext } from '../../shared/modelSourceQuota'
import type { CodexSourcePreset } from '../../shared/codexSources'

function signedArkRequest(preset: QuotaProviderId, context: QuotaQueryContext, now: Date): QuotaRequest {
  const { accessKeyId, secretAccessKey } = context.credentials ?? {}
  if (!accessKeyId || !secretAccessKey) throw new Error('额度查询需要独立 AK / SK')
  const host = 'open.volcengineapi.com', region = 'cn-beijing', contentType = 'application/json; charset=utf-8'
  const query = `Action=${preset === 'ark-agent-plan' ? 'GetAFPUsage' : 'GetCodingPlanUsage'}&Region=${region}&Version=2024-01-01`
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8)
  const hash = (input: string) => createHash('sha256').update(input).digest('hex')
  const hmac = (key: string | Buffer, input: string) => createHmac('sha256', key).update(input).digest()
  // Match the official Volcengine Node SDK: lowercase sorted names, excluding content-type.
  const bodyHash = hash(''), signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalHeaders = `host:${host}\nx-content-sha256:${bodyHash}\nx-date:${date}\n`
  const canonical = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
  const scope = `${day}/${region}/ark/request`
  const key = hmac(hmac(hmac(hmac(secretAccessKey, day), region), 'ark'), 'request')
  const signature = hmac(key, `HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex')
  return { url: `https://${host}/?${query}`, method: 'POST', authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: { Host: host, 'X-Date': date, 'X-Content-Sha256': bodyHash, 'Content-Type': contentType } }
}

/** Recheck the destination inside the worker; template labels never authorize cross-host forwarding. */
export function modelQuotaRequestFor(preset: QuotaProviderId, baseUrl: string, apiKey: string, context: QuotaQueryContext = {}, now = new Date()): QuotaRequest | null {
  const query = validateQuotaQuery(context.query)
  const provider = modelSourceQuotaProvider({ preset: 'custom', quotaQuery: query, endpoints: [{ id: 'quota', protocol: 'openai-chat', baseUrl, auth: 'bearer' }] })
  if (!provider || provider.preset !== preset) return null
  if (preset === 'ark-coding-plan' || preset === 'ark-agent-plan') return signedArkRequest(preset, context, now)
  if (preset === 'new-api') {
    if (!query?.userId || !context.credentials?.accessToken) throw new Error('额度查询需要访问令牌和用户 ID')
    return { url: baseUrl.replace(/\/+$/, '').replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '') + '/api/user/self', authorization: `Bearer ${context.credentials.accessToken}`, headers: { 'New-Api-User': query.userId } }
  }
  if (preset === 'sub2api') return { url: baseUrl.replace(/\/+$/, '').replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '') + '/v1/usage', authorization: `Bearer ${apiKey}` }
  const urls: Partial<Record<QuotaProviderId, string>> = {
    'kimi-code-global': 'https://api.kimi.ai/coding/v1/usages',
    minimax: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', 'minimax-cn': 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    siliconflow: 'https://api.siliconflow.com/v1/user/info', 'siliconflow-cn': 'https://api.siliconflow.cn/v1/user/info',
    openrouter: 'https://openrouter.ai/api/v1/credits', stepfun: 'https://api.stepfun.com/v1/accounts', novita: 'https://api.novita.ai/v3/user/balance'
  }
  return urls[preset] ? { url: urls[preset]!, authorization: `Bearer ${apiKey}` } : quotaRequestFor(preset as CodexSourcePreset, provider.baseUrl, apiKey)
}
export async function fetchModelSourceQuota(preset: QuotaProviderId, baseUrl: string, apiKey: string, context: QuotaQueryContext = {}): Promise<ModelSourceQuota> {
  const input = modelQuotaRequestFor(preset, baseUrl, apiKey, context)
  if (!input) return { status: 'unsupported', message: '当前地址不支持所选额度查询方式' }
  try { return await fetchQuotaRequest(preset, input, context.query) }
  catch (error) { throw new Error(error instanceof Error && /^(额度|密钥无额度|Kimi|DeepSeek|GLM|MiMo)/.test(error.message) ? error.message : '额度查询失败，请稍后重试') }
}
