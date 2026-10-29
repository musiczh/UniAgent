import { randomUUID } from 'node:crypto'
import { acquireKimiWebService } from './kimiWebService.ts'

/** Kimi 2.2 native Provider API serializes writes and preserves other providers. */
export async function configureKimiPlatformKey(bin: string, region: 'cn' | 'global', apiKey: string, signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch, acquire = acquireKimiWebService): Promise<void> {
  const baseUrl = region === 'cn' ? 'https://api.moonshot.cn/v1' : 'https://api.moonshot.ai/v1'
  let models: { model: string; max_context_size: number; display_name?: string; capabilities: string[] }[]
  try {
    const response = await request(baseUrl + '/models', { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('invalid') }
    const body = await response.json() as { data?: any[] }
    models = (Array.isArray(body.data) ? body.data : []).filter(item => typeof item.id === 'string' && item.id.startsWith('kimi-k')
      && Number.isSafeInteger(item.context_length) && item.context_length > 0).map(item => ({ model: item.id,
      max_context_size: item.context_length, ...(typeof item.display_name === 'string' ? { display_name: item.display_name } : {}),
      capabilities: [item.supports_tool_use !== false && 'tool_use', item.supports_reasoning && 'thinking',
        item.supports_image_in && 'image_in', item.supports_video_in && 'video_in'].filter(Boolean) as string[] }))
    if (!models.length) throw new Error('empty')
  } catch { throw new Error('Platform Key 或模型目录验证失败，请检查账号区域、Key 和网络；原配置已保留') }
  signal.throwIfAborted()
  const lease = await acquire({ bin, cwd: env.HOME || process.cwd(), env })
  try {
    const specification = await lease.transport.specification('/openapi.json')
    if (!specification.paths?.['/api/v1/providers']?.post || !specification.paths?.['/api/v1/models/{tail}']?.post) throw new Error('当前 Kimi 服务未提供所需的 Provider 配置接口，请更新官方 CLI')
    // New identity avoids overwriting any external provider or credential, even on retry.
    const id = `uniagent-platform-${region}-${randomUUID().slice(0, 8)}`
    signal.throwIfAborted()
    await lease.transport.request('POST', '/api/v1/providers', { id, type: 'kimi', api_key: apiKey,
      base_url: baseUrl, default_model: models[0].model, models })
    signal.throwIfAborted()
    await lease.transport.request('POST', `/api/v1/models/${encodeURIComponent(`${id}/${models[0].model}`)}:set_default`)
  } catch { throw new Error('Kimi 原生配置未完成，请重新检测后重试；已有 Provider 未被覆盖') }
  finally { await lease.release() }
}
