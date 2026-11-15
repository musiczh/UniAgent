import { testedAgentVersion } from './agentCompatibility'

export const DEEPSEEK_PACKAGE = '@deepseek-ai/dsh'
/** Recommended installation version; other versions continue actual protocol checks. */
export const DEEPSEEK_VERIFIED_VERSION = testedAgentVersion('deepseek')!
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEEPSEEK_IPC = { get: 'deepseek:get', save: 'deepseek:save', check: 'deepseek:check', install: 'deepseek:install',
  cancelInstall: 'deepseek:cancel-install', signIn: 'deepseek:sign-in', cancelSignIn: 'deepseek:cancel-sign-in',
  reopen: 'deepseek:reopen', signOut: 'deepseek:sign-out', changed: 'deepseek:changed' } as const
export type DeepSeekInstallPhase = 'idle' | 'preparing' | 'downloading' | 'verifying' | 'activating' | 'completed' | 'cancelled' | 'failed'
export interface DeepSeekAccountSnapshot {
  supported: boolean
  signedIn: boolean
  phase?: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
}
export interface DeepSeekConnectionSnapshot {
  baseUrl: string
  hasKey: boolean
  source: 'harness' | 'none'
  installed: boolean
  version: string
  verified: boolean
  account?: DeepSeekAccountSnapshot
  installation?: { phase: DeepSeekInstallPhase; cancellable: boolean }
}
export interface DeepSeekConnectionInput { baseUrl: string; apiKey?: string }

export function deepseekBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址必须为不含凭据、查询参数的 HTTP(S) 地址')
  }
  const base = url.href.replace(/\/$/, '').replace(/\/(v1|anthropic)$/, '')
  return base + '/anthropic'
}
