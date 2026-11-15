import type { QoderByokInput, QoderByokSource } from '../shared/qoder'
import { qoderOperation } from './qoderSdk.ts'

export function projectQoderByok(values: any[]): QoderByokSource[] {
  return values.map(value => 'providerId' in value ? { id: value.providerId, name: value.displayName, baseUrl: value.baseUrl,
    protocol: value.protocol, kind: 'provider', models: value.models.map((model: { id: string }) => model.id) } : { id: value.key, name: value.displayName,
    baseUrl: value.baseUrl, kind: 'model', models: [value.model] })
}

export function validateQoderByok(input: QoderByokInput): void {
  if (!input || !/^[\w.-]{1,100}$/.test(input.id) || !input.name?.trim() || !['openai', 'openai-responses', 'anthropic'].includes(input.protocol) ||
    !Array.isArray(input.models) || !input.models.length || input.models.some(model => typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n\u0000]/.test(model))) throw new Error('Qoder 模型来源参数无效')
  try { const url = new URL(input.baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error() }
  catch { throw new Error('请填写有效的模型服务 URL') }
  if (!input.existing && !input.apiKey?.trim()) throw new Error('请在密码输入框填写 API Key')
}

export async function listQoderByok(bin: string): Promise<QoderByokSource[]> {
  return projectQoderByok(await qoderOperation(bin, 'byok.list'))
}

export async function saveQoderByok(bin: string, input: QoderByokInput): Promise<void> {
  validateQoderByok(input)
  const value = { providerId: input.id, displayName: input.name.trim(), baseUrl: input.baseUrl.trim(), protocol: input.protocol,
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}), models: input.models.map(model => ({ model: model.trim() })) }
  if (input.apiKey?.trim()) {
    const checked = await qoderOperation(bin, 'byok.check', value)
    if (checked?.success !== true) throw new Error('Qoder 原生模型校验失败，请检查服务、模型和 Key；原配置已保留')
  }
  await qoderOperation(bin, input.existing ? 'byok.update' : 'byok.create', value)
}

export async function deleteQoderByok(bin: string, source: Pick<QoderByokSource, 'id' | 'kind'>): Promise<void> {
  if (!source || !/^[\w.-]{1,200}$/.test(source.id) || !['provider', 'model'].includes(source.kind)) throw new Error('模型来源无效')
  await qoderOperation(bin, 'byok.delete', source.kind === 'provider' ? { providerId: source.id } : { key: source.id })
}
