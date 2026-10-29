export const CLI_SETUP_IDS = ['codex', 'traex', 'claude', 'grok'] as const
export type CliSetupId = typeof CLI_SETUP_IDS[number]
export interface CliSetupInput { method?: 'browser' | 'sso' | 'key'; apiKey?: string }
export interface CliSetupSnapshot {
  phase: 'idle' | 'checking' | 'installing' | 'login' | 'verifying' | 'failed' | 'cancelled'
  cancellable: boolean
  message?: string
  canReopen?: boolean
  deviceCode?: string
}
export function isCliSetupId(value: unknown): value is CliSetupId {
  return typeof value === 'string' && isDistributionAgent(value) && CLI_SETUP_IDS.includes(value as CliSetupId)
}
import { isDistributionAgent } from './distribution.ts'
