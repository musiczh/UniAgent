import { CODEX_SOURCE_PRESETS, type CodexSourcePreset } from './codexSources'
import type { ModelDef } from './types'

export const CLAUDE_SOURCE_PRESETS = {
  'kimi-code': { ...CODEX_SOURCE_PRESETS['kimi-code'], baseUrl: 'https://api.kimi.com/coding' },
  deepseek: { ...CODEX_SOURCE_PRESETS.deepseek, baseUrl: 'https://api.deepseek.com/anthropic' },
  // Xiaomi MiMo exposes the Anthropic-compatible endpoint under /anthropic (Claude Code appends /v1/messages).
  mimo: { ...CODEX_SOURCE_PRESETS.mimo, baseUrl: 'https://api.xiaomimimo.com/anthropic' },
  // Token Plan has its own host; the key (tp-/ttp-) works on both compatibility endpoints.
  'mimo-token-plan': { ...CODEX_SOURCE_PRESETS['mimo-token-plan'], baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic' }
} as const

export type ClaudeSourcePreset = keyof typeof CLAUDE_SOURCE_PRESETS

/** Kimi Code authenticates with x-api-key/ANTHROPIC_API_KEY; DeepSeek and MiMo accept a Bearer token. */
export function claudeSourceUsesAuthToken(preset: ClaudeSourcePreset): boolean {
  return preset !== 'kimi-code'
}

export function claudeSourceEffort(model: string, preset: ClaudeSourcePreset): Pick<ModelDef, 'efforts' | 'defaultEffort'> {
  // Vendor model contracts: Kimi HighSpeed has thinking, but no adjustable effort.
  // MiMo accepts a reasoning switch only ("off"/"high" = 关闭/开启): every level above
  // "none" behaves the same on the wire, so never invent low/medium strengths.
  if (preset === 'mimo' || preset === 'mimo-token-plan') return { efforts: ['off', 'high'], defaultEffort: 'high' }
  const supported = preset === 'kimi-code' ? ['k3', 'k3-256k', 'kimi-for-coding'].includes(model)
    : preset === 'deepseek' && CLAUDE_SOURCE_PRESETS.deepseek.models.includes(model)
  return supported ? { efforts: ['low', 'high', 'max'], defaultEffort: model === 'kimi-for-coding' ? 'max' : 'high' } : { efforts: [] }
}

export type ModelSourceClient = 'claude' | 'codex'
export interface ReusableCredential {
  id: string
  revision: string
  label: string
  preset: CodexSourcePreset
  models: string[]
}
export interface CredentialSelection { id: string; revision: string }
export const CLAUDE_SOURCE_IPC = {
  get: 'claudeSources:get', save: 'claudeSources:save', queryModels: 'claudeSources:queryModels',
  test: 'claudeSources:test', changed: 'claudeSources:changed'
} as const
export const MODEL_CREDENTIAL_IPC = { list: 'modelCredentials:list', import: 'modelCredentials:import' } as const
