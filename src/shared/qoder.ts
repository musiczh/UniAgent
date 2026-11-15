export const QODER_IPC = { byokList: 'qoder:byok:list', byokSave: 'qoder:byok:save', byokDelete: 'qoder:byok:delete' } as const
export interface QoderByokSource {
  id: string
  name: string
  baseUrl?: string
  protocol?: 'openai' | 'openai-responses' | 'anthropic'
  kind: 'model' | 'provider'
  models: string[]
}
export interface QoderByokInput {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  protocol: 'openai' | 'openai-responses' | 'anthropic'
  models: string[]
  existing?: boolean
}
