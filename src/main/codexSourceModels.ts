import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isCodexSourceModelId } from '../shared/codexSources'

const MAX_RESPONSE = 1024 * 1024
export interface ModelRequest { url: string; authorization: string }

export function modelRequestFor(baseUrl: string, apiKey: string): ModelRequest {
  return { url: `${baseUrl.replace(/\/+$/, '')}/models`, authorization: `Bearer ${apiKey}` }
}

export function normalizeSourceModels(raw: any): string[] {
  const entries: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : []
  const models = [...new Set(entries.map((entry: any) => typeof entry === 'string' ? entry : entry?.id)
    .filter(isCodexSourceModelId))]
  if (!models.length) throw new Error('厂商未返回可用模型')
  if (models.length > 100) throw new Error('厂商返回超过 100 个模型，请手动保留需要的模型')
  return models
}

function httpError(status: number): Error {
  if (status === 401 || status === 403) return new Error('API Key 无法查询模型')
  if (status === 404) return new Error('接口不支持模型查询，请检查接口地址')
  if (status === 429) return new Error('模型查询过于频繁，请稍后重试')
  return new Error(`模型查询失败（HTTP ${status || 502}）`)
}

export async function fetchSourceModels(baseUrl: string, apiKey: string, timeoutMs = 8000): Promise<string[]> {
  const input = modelRequestFor(baseUrl, apiKey)
  const destination = new URL(input.url)
  const raw = await new Promise<unknown>((resolve, reject) => {
    const finish = (error?: Error, value?: unknown): void => {
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    const req = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, {
      method: 'GET', headers: { Authorization: input.authorization, Accept: 'application/json', 'User-Agent': 'UniAgent' }
    }, response => {
      if (response.statusCode !== 200) { response.destroy(); finish(httpError(response.statusCode || 0)); return }
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE) response.destroy(new Error('模型列表响应过大'))
        else chunks.push(chunk)
      })
      response.on('error', error => finish(error))
      response.on('end', () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { finish(new Error('模型接口返回无效数据')) }
      })
    })
    const timer = setTimeout(() => req.destroy(new Error('模型查询超时')), timeoutMs)
    req.once('error', error => finish(error))
    req.end()
  })
  return normalizeSourceModels(raw)
}
